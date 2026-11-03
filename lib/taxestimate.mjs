// Tax return estimate for a financial year: roughly what the individual return
// will come out as, with the working. The bank feed only shows NET pay, so
// salary is either what the owner entered (a payslip or the income statement:
// year to date gross and tax withheld, as at a date) or estimated by taking
// each detected pay, reversing the ATO Schedule 1 withholding scale for the
// pay cycle, and projecting to 30 June at the current pace. Interest, business
// net and tagged D-item deductions come from the feed. Maths in
// lib/taxcalc.mjs, rate tables in lib/taxrates.mjs. the owner is not GST
// registered, so there is no GST. An estimate, not tax advice.
import { addDays, daysBetween, fmtDMY } from './dates.mjs';
import { addMonths } from './recurring.mjs';
import { paydays, anchorSource, DEFAULT_CADENCE } from './cycles.mjs';
import { salaryStats } from './income.mjs';
import { LINKED, BUSINESS } from './spend.mjs';
import { ATO_CATEGORIES, fyRange, fySummary, getTaxInputs, TAX_INPUTS } from './tax.mjs';
import { TAX_YEARS, SUPPORTED_YEARS } from './taxrates.mjs';
import { hasRates, grossFromNet, withholding, computeReturn } from './taxcalc.mjs';

const NOTE = 'An estimate and general information, not tax advice. Check it with the ATO or a registered tax agent. It assumes a single Australian resident for the whole year and applies the ATO tables for the year.';
const STALE_DAYS = 45;
const LABEL = new Map(ATO_CATEGORIES.map((c, i) => [c.code, { label: c.label, sort: i }]));
const dollars = (c) => `$${(Math.abs(c) / 100).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

// Pay cycle in days to a Schedule 1 pay period. 30 is the monthly snap.
const periodOf = (cadence) => (cadence <= 9 ? 'weekly' : cadence <= 20 ? 'fortnightly' : cadence >= 27 && cadence <= 32 ? 'monthly' : cadence);
const nextPay = (date, period, cadence) => (period === 'monthly' ? addMonths(date, 1) : addDays(date, cadence));

function interestPaid(db, from, to) {
  return db.prepare(`SELECT COALESCE(SUM(t.amount), 0) n FROM transactions t JOIN accounts a ON a.id = t.account_id AND a.merged_into IS NULL JOIN categories c ON c.id = t.category_id
    WHERE c.name = 'Interest' AND t.amount > 0 AND NOT ${LINKED} AND ${BUSINESS} = 0 AND a.type NOT IN ('loan', 'credit-card') AND t.date >= ? AND t.date <= ?`).get(from, to).n;
}

// Individual (D item) deductions only: BUS_ labels are business expenses already
// inside business net, and a business-flagged row is too, so neither counts twice.
function taggedDeductions(db, from, to) {
  return db.prepare(`SELECT g.ato_category code, SUM(g.deductible_amount) amount FROM tax_tags g JOIN transactions t ON t.id = g.transaction_id JOIN accounts a ON a.id = t.account_id AND a.merged_into IS NULL
    WHERE g.ato_category LIKE 'D%' AND ${BUSINESS} = 0 AND t.date >= ? AND t.date <= ? GROUP BY 1`).all(from, to)
    .map((r) => ({ code: r.code, label: LABEL.get(r.code)?.label ?? r.code, amount: r.amount }))
    .sort((x, y) => (LABEL.get(x.code)?.sort ?? 99) - (LABEL.get(y.code)?.sort ?? 99));
}

function ratesView(fy) {
  const y = TAX_YEARS[fy];
  return {
    fy, label: y.label,
    income_tax: { source: y.income_tax.source, second_bracket_rate: y.income_tax.brackets[1].bp / 10000, brackets: y.income_tax.brackets },
    medicare: { source: y.medicare.source, lower: y.medicare.lower, upper: y.medicare.upper },
    lito: { source: y.lito.source },
    mls: { source: y.mls.source, tiers: y.mls.tiers.map((x) => ({ up_to: Number.isFinite(x.upTo) ? x.upTo : null, bp: x.bp })) },
    help: { source: y.help.source },
    withholding: { source: y.withholding.source },
  };
}

// The salary side: year to date and full year gross and tax withheld, each marked
// entered or estimated, and how the projection to 30 June was made.
function salaryPart(db, fy, inputs, today) {
  const { from, to } = fyRange(fy);
  const final = today > to;
  const upTo = final ? to : today;
  const asAt = inputs.as_at && inputs.as_at <= upTo ? inputs.as_at : upTo;
  const fyDays = daysBetween(from, to) + 1;
  const elapsed = (d) => Math.max(1, daysBetween(from, d) + 1);

  const anchor = anchorSource(db);
  const cadence = anchor?.cadence_days || DEFAULT_CADENCE;
  const period = periodOf(cadence);
  const all = paydays(db);
  const inYear = all.filter((p) => p.date >= from && p.date <= to && p.date <= upTo);
  const last = all.filter((p) => p.date <= upTo).at(-1) ?? null;

  // Pays still to come this year, from the last pay at the pace of the cycle. A salary that has stopped is not projected.
  let remaining = 0;
  let stopped = false;
  if (!final && last) {
    stopped = daysBetween(last.date, today) > 2 * cadence + 3;
    if (!stopped) for (let d = nextPay(last.date, period, cadence); d <= to; d = nextPay(d, period, cadence)) remaining += 1;
  }
  const total = inYear.length + remaining;
  const soFar = (d) => inYear.filter((p) => p.date <= d).length;

  // Scale a year-to-date figure as at `d` up to the whole year: by pay count when there are pays, else by days.
  const method = (d) => (d >= to ? 'none' : soFar(d) > 0 && total > 0 ? 'pays' : 'days');
  const factor = (d) => { const m = method(d); return m === 'none' ? 1 : m === 'pays' ? total / soFar(d) : fyDays / elapsed(d); };

  const median = salaryStats(db).median;
  const medianGross = median ? grossFromNet(fy, median, period) : 0;
  const perPay = inYear.map((p) => ({ net: p.amount, gross: grossFromNet(fy, p.amount, period) }));
  const estYtdGross = perPay.reduce((s, p) => s + p.gross, 0);
  const estYtdWithheld = perPay.reduce((s, p) => s + p.gross - p.net, 0);

  let ytdGross; let grossAmount; let grossSource;
  if (inputs.gross_salary != null) {
    ytdGross = inputs.gross_salary; grossAmount = Math.round(ytdGross * factor(asAt)); grossSource = 'entered';
  } else {
    ytdGross = estYtdGross; grossAmount = estYtdGross + remaining * medianGross; grossSource = 'estimated';
  }
  let ytdWithheld; let withheldAmount; let withheldSource;
  if (inputs.tax_withheld != null) {
    ytdWithheld = inputs.tax_withheld; withheldAmount = Math.round(ytdWithheld * factor(asAt)); withheldSource = 'entered';
  } else if (inputs.gross_salary != null) {
    // Gross is known, withheld is not: run the gross through the scale, pay by pay when there are pays.
    const n = soFar(asAt);
    if (n > 0) ytdWithheld = n * withholding(fy, Math.round(inputs.gross_salary / n), period);
    else { const weeks = elapsed(asAt) / 7; ytdWithheld = Math.round(weeks * withholding(fy, Math.round(inputs.gross_salary / weeks), 'weekly')); }
    withheldAmount = Math.round(ytdWithheld * factor(asAt)); withheldSource = 'estimated';
  } else {
    ytdWithheld = estYtdWithheld; withheldAmount = estYtdWithheld + remaining * (medianGross - (median ?? 0)); withheldSource = 'estimated';
  }
  const entered = inputs.gross_salary != null || inputs.tax_withheld != null;
  return {
    gross: { amount: grossAmount, source: grossSource },
    withheld: { amount: withheldAmount, source: withheldSource },
    ytd: { gross: ytdGross, withheld: ytdWithheld, pays: inYear.length },
    as_at: entered ? asAt : upTo,
    projection: {
      method: method(entered ? asAt : upTo), period: typeof period === 'number' ? `${period} days` : period, pays_so_far: soFar(entered ? asAt : upTo),
      pays_remaining: remaining, pays_total: total, stopped, last_pay: last?.date ?? null, final,
    },
    elapsed_days: elapsed(upTo), fy_days: fyDays, up_to: upTo, final,
  };
}

export function taxReturnEstimate(db, { fy, today }) {
  const empty = { fy, as_of: today, lines: [], inputs: null, input_fields: Object.keys(TAX_INPUTS), result: null, headline: null, note: NOTE };
  if (!hasRates(fy)) {
    return { ...empty, status: 'unsupported', message: `No verified ATO rate tables for FY${fy}. The estimate covers ${SUPPORTED_YEARS.map((y) => `FY${y} (${TAX_YEARS[y].label})`).join(' and ')}.` };
  }
  const { from, to } = fyRange(fy);
  const inputs = getTaxInputs(db, fy);
  const sal = salaryPart(db, fy, inputs, today);
  const upTo = sal.up_to;

  // Interest paid in, projected over the year on the days gone; business net and deductions are to date.
  const interestYtd = interestPaid(db, from, upTo);
  const projectInterest = !sal.final && sal.elapsed_days < sal.fy_days;
  const interest = { ytd: interestYtd, amount: projectInterest ? Math.round((interestYtd * sal.fy_days) / sal.elapsed_days) : interestYtd, source: projectInterest ? 'estimated' : 'feed' };
  const biz = fySummary(db, fy).business;
  const business = { net: biz.net, amount: Math.max(0, biz.net), source: 'feed' };
  const other = { amount: inputs.other_income ?? 0, source: 'entered' };
  const tagged = taggedDeductions(db, from, to);
  const taggedTotal = tagged.reduce((s, d) => s + d.amount, 0);
  const extra = inputs.extra_deductions ?? 0;
  const dTotal = taggedTotal + extra;
  const d12 = tagged.find((d) => d.code === 'D12')?.amount ?? 0;

  const hasHelp = inputs.has_help ?? (inputs.help_debt == null ? null : inputs.help_debt > 0);
  const r = computeReturn(fy, {
    salary: sal.gross.amount, interest: interest.amount, business: business.amount, other: other.amount, deductions: dTotal, d12,
    withheld: sal.withheld.amount, private_health: inputs.private_health, has_help: hasHelp, help_balance: hasHelp ? inputs.help_debt : null,
  });
  const incomeTotal = sal.gross.amount + interest.amount + business.amount + other.amount;
  const noData = sal.gross.amount === 0 && incomeTotal === 0;

  const assumptions = [
    { key: 'resident', text: 'Single Australian resident for the whole year, claiming the tax-free threshold, no dependants.' },
    { key: 'offsets', text: 'Only the low income tax offset is applied. No spouse, family, seniors or other offsets.' },
    { key: 'deductions', text: 'Deductions are the D items you have tagged so far, plus any extra you entered. They are not projected, and untagged spend is not counted.' },
    { key: 'super', text: 'Employer super is not income here. Salary sacrifice and reportable fringe benefits are not counted towards the surcharge or HELP income.' },
  ];
  if (business.net !== 0) assumptions.push({ key: 'business', text: 'Business income is net to date (income less expenses on business accounts and flags), not projected. A business loss is not set against salary.' });
  const mlsSwing = r.swings.find((s) => s.key === 'private_health');
  const helpSwing = r.swings.find((s) => s.key === 'has_help');
  if (mlsSwing) assumptions.push({ key: 'private_health', text: `Private hospital cover for the whole year is not set, so it is assumed. Without it the Medicare levy surcharge would add ${dollars(mlsSwing.amount)}.` });
  if (helpSwing) assumptions.push({ key: 'has_help', text: `Whether you have a HELP or study loan is not set, so none is assumed. With one, the compulsory repayment would add ${dollars(helpSwing.amount)}.` });
  if (hasHelp) assumptions.push({ key: 'help_withheld', text: 'Study loan amounts your employer withheld are credited against the repayment on assessment. Add them to tax withheld to net them off.' });

  const reasons = [];
  if (sal.gross.source === 'estimated') reasons.push('Salary is estimated from your net pay by reversing the ATO withholding scale. Salary sacrifice, HELP withholding, union fees and other pay deductions make it read low.');
  if (sal.withheld.source === 'estimated' && sal.gross.source === 'entered') reasons.push('Tax withheld is estimated by running your gross through the ATO withholding scale. Enter it from a payslip to firm it up.');
  if (sal.gross.source === 'estimated' && sal.withheld.source === 'estimated') reasons.push('Tax withheld is the difference between the estimated gross and your net pay.');
  if (sal.gross.source === 'entered' && sal.withheld.source === 'entered') reasons.push('Salary and tax withheld are the figures you entered.');
  if (inputs.gross_salary != null || inputs.tax_withheld != null) {
    if (!sal.final && sal.up_to !== sal.as_at && daysBetween(sal.as_at, sal.up_to) > STALE_DAYS) reasons.push(`Your figures run to ${fmtDMY(sal.as_at)}, so the rest of the year is a projection from then.`);
  }
  if (sal.projection.stopped) reasons.push(`No pay has landed since ${fmtDMY(sal.projection.last_pay)} (last pay), so nothing more is projected.`);
  if (!sal.final && sal.projection.method === 'days') reasons.push('No pays found this year, so the projection is by days elapsed and is rough.');
  if (!sal.final && sal.elapsed_days < 60) reasons.push('Early in the year, so the projection is rough.');
  const stale = inputs.gross_salary != null && inputs.tax_withheld != null && !sal.final && daysBetween(sal.as_at, sal.up_to) > STALE_DAYS;
  const level = noData ? 'low' : sal.gross.source === 'entered' && sal.withheld.source === 'entered' ? (stale ? 'medium' : 'high') : sal.gross.source === 'entered' || sal.withheld.source === 'entered' ? 'medium' : 'low';

  const projNote = sal.projection.method === 'none' ? '' : sal.projection.method === 'pays'
    ? ` Projected from ${sal.projection.pays_so_far} ${sal.projection.pays_so_far === 1 ? 'pay' : 'pays'} to ${sal.projection.pays_total} this year.` : ' Projected by days elapsed.';
  const lines = [
    { key: 'salary', label: 'Salary (gross)', amount: sal.gross.amount, source: sal.gross.source, note: `${dollars(sal.ytd.gross)} to ${fmtDMY(sal.as_at)}.${projNote}`.trim() },
    { key: 'interest', label: 'Interest', amount: interest.amount, source: interest.source, note: projectInterest ? `${dollars(interest.ytd)} paid in so far, projected over the year. An offset's benefit is not income.` : 'Paid in, on your accounts.' },
    { key: 'business', label: 'Business net income', amount: business.amount, source: 'feed', note: business.net < 0 ? `A ${dollars(business.net)} loss is not set against other income.` : 'Income less expenses on business accounts, to date.' },
    { key: 'other', label: 'Other income', amount: other.amount, source: 'entered', note: 'Only what you entered.' },
    { key: 'income_total', label: 'Total income', amount: incomeTotal, source: 'calculated' },
    { key: 'deductions', label: 'Deductions', amount: dTotal, source: extra ? 'entered' : 'feed', note: `${dollars(taggedTotal)} tagged${extra ? `, ${dollars(extra)} entered` : ''}. Not projected.` },
    { key: 'taxable_income', label: 'Taxable income', amount: r.taxable, source: 'calculated' },
    { key: 'income_tax', label: `Tax on taxable income (${TAX_YEARS[fy].label} rates)`, amount: r.income_tax, source: 'calculated' },
    { key: 'lito', label: 'Low income tax offset', amount: r.lito, source: 'calculated', note: r.lito ? '' : 'Not available at this income.' },
    { key: 'medicare', label: 'Medicare levy', amount: r.medicare, source: 'calculated' },
    { key: 'mls', label: 'Medicare levy surcharge', amount: r.mls, source: 'calculated', note: inputs.private_health === false ? 'No private hospital cover.' : '' },
    { key: 'help', label: 'HELP repayment', amount: r.help, source: 'calculated', note: hasHelp ? 'Compulsory repayment on your repayment income.' : '' },
    { key: 'tax_payable', label: 'Tax payable', amount: r.tax_payable, source: 'calculated' },
    { key: 'withheld', label: 'Tax withheld', amount: sal.withheld.amount, source: sal.withheld.source, note: `${dollars(sal.ytd.withheld)} to ${fmtDMY(sal.as_at)}.` },
    { key: 'result', label: r.result >= 0 ? 'Estimated refund' : 'Estimated amount owing', amount: Math.abs(r.result), source: 'calculated' },
  ];

  return {
    fy, label: TAX_YEARS[fy].label, as_of: today, status: noData ? 'no_data' : 'ok', final: sal.final,
    message: noData ? `No salary found for FY${fy} and nothing entered. Enter your gross salary and tax withheld from a payslip, or wait for the next pay to land.` : null,
    result: noData ? null : r.result,
    headline: noData ? null : { kind: r.result > 0 ? 'refund' : r.result < 0 ? 'owing' : 'even', amount: Math.abs(r.result) },
    salary: { gross: sal.gross, withheld: sal.withheld, ytd: sal.ytd, as_at: sal.as_at, projection: sal.projection },
    income: { salary: sal.gross, interest, business, other, total: incomeTotal },
    deductions: { tagged: taggedTotal, extra, total: dTotal, by_code: tagged, source: extra ? 'entered' : 'feed' },
    taxable_income: r.taxable,
    tax: { income_tax: r.income_tax, lito: r.lito, lito_offered: r.lito_offered, medicare: r.medicare, mls: r.mls, help: r.help, tax_payable: r.tax_payable, result: r.result },
    withheld: sal.withheld,
    swings: r.swings,
    assumptions,
    confidence: { level, reasons },
    lines,
    inputs,
    input_fields: Object.keys(TAX_INPUTS),
    rates: ratesView(fy),
    note: NOTE,
  };
}

// The estimate as the accountant pack prints it: label, source and a signed
// amount (deductions, the offset and tax withheld come off). Nothing when
// there is no estimate to show.
const NEGATIVE = new Set(['deductions', 'lito', 'withheld']);
export function packEstimate(est) {
  if (est?.status !== 'ok') return null;
  const keep = est.lines.filter((l) => l.amount || ['salary', 'taxable_income', 'income_tax', 'result'].includes(l.key));
  return {
    title: `Tax return estimate, ${est.label}`,
    lines: keep.map((l) => ({ label: `${l.label} (${l.source})`, amount: NEGATIVE.has(l.key) ? -l.amount : l.amount })),
    note: `${est.confidence.level} confidence. ${est.confidence.reasons[0] ?? ''} ${est.note}`.replace(/\s+/g, ' ').trim(),
  };
}
