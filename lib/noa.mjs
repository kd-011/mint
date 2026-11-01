// Income by financial year (1 July to 30 June) against the ATO Notices of
// Assessment. The bank only shows net pay and a NoA is gross, so the honest
// comparison is Mint's net salary plus the PAYG the NoA says was withheld
// (an estimated gross) against the NoA's taxable income. The difference is
// shown as a reconciliation gap, never smoothed over: deductions, salary
// sacrifice and income Mint cannot see all land in it. Amounts are cents.
import { bad, notFound } from './errors.mjs';
import { incomeRows } from './income.mjs';
import { fyOf, fyRange } from './tax.mjs';
import { addDays, isIsoDate } from './dates.mjs';

const FIRST_FY = 2020;
// A year whose first pay lands more than this many days after 1 July is a year
// the bank history only covers part of.
const PARTIAL_AFTER_DAYS = 20;
const COLS = 'fy, taxable_income, tax_withheld_payg, assessed_tax, medicare, vet_repayment, refund, capital_gains, source_file, created_at, updated_at';
const REQUIRED = ['taxable_income', 'tax_withheld_payg'];
const OPTIONAL = ['assessed_tax', 'medicare', 'vet_repayment', 'capital_gains'];
const round1 = (x) => Math.round(x * 10) / 10 + 0;

export function listAssessments(db) {
  return db.prepare(`SELECT ${COLS} FROM tax_assessments ORDER BY fy`).all().map((r) => ({ ...r }));
}

const getAssessment = (db, fy) => db.prepare(`SELECT ${COLS} FROM tax_assessments WHERE fy = ?`).get(fy);

const cents = (k, v, { signed = false } = {}) => {
  if (!Number.isInteger(v) || Math.abs(v) > 1e12 || (!signed && v < 0)) throw bad(`${k} must be whole cents${signed ? ' (negative when tax is owing)' : ', zero or more'}`);
  return v;
};

// Add or change one year's NoA. Fields left out keep their saved value, null
// clears an optional one, so a chat write can fix a single figure.
export function setAssessment(db, fy, body) {
  fyRange(fy);
  if (!body || typeof body !== 'object') throw bad('NoA must be an object');
  const cur = getAssessment(db, fy);
  const v = { ...(cur ?? {}) };
  for (const k of REQUIRED) {
    if (k in body) v[k] = cents(k, body[k]);
    else if (v[k] == null) throw bad(`${k} is required: whole cents from the Notice of Assessment`);
  }
  for (const k of OPTIONAL) if (k in body) v[k] = body[k] === null ? null : cents(k, body[k]);
  if ('refund' in body) v.refund = body.refund === null ? null : cents('refund', body.refund, { signed: true });
  if ('source_file' in body) {
    if (body.source_file !== null && (typeof body.source_file !== 'string' || body.source_file.length > 200)) throw bad('source_file must be up to 200 characters');
    v.source_file = body.source_file?.trim() || null;
  }
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO tax_assessments (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fy) DO UPDATE SET taxable_income = excluded.taxable_income, tax_withheld_payg = excluded.tax_withheld_payg, assessed_tax = excluded.assessed_tax,
      medicare = excluded.medicare, vet_repayment = excluded.vet_repayment, refund = excluded.refund, capital_gains = excluded.capital_gains, source_file = excluded.source_file, updated_at = excluded.updated_at`)
    .run(fy, v.taxable_income, v.tax_withheld_payg, v.assessed_tax ?? null, v.medicare ?? null, v.vet_repayment ?? null, v.refund ?? null, v.capital_gains ?? null, v.source_file ?? null, cur?.created_at ?? at, at);
  return { ...getAssessment(db, fy) };
}

export function deleteAssessment(db, fy) {
  fyRange(fy);
  if (!getAssessment(db, fy)) throw notFound(`no NoA saved for FY${fy}`);
  db.prepare('DELETE FROM tax_assessments WHERE fy = ?').run(fy);
  return { deleted: true };
}

// Net salary + PAYG withheld = estimated gross, against taxable income.
// gap = estimated gross - taxable: positive means Mint's figures are the higher.
export function reconcile({ salary, payg, taxable }) {
  if (payg == null || taxable == null) return { est_gross: null, gap: null, gap_pct: null };
  const est_gross = salary + payg;
  const gap = est_gross - taxable;
  return { est_gross, gap, gap_pct: taxable > 0 ? round1((gap / taxable) * 100) : null };
}

export function incomeByFy(db, { today }) {
  if (!isIsoDate(today)) throw bad('today must be YYYY-MM-DD');
  const assessments = new Map(listAssessments(db).map((a) => [a.fy, a]));
  const current = fyOf(today);
  const first = Math.min(FIRST_FY, ...assessments.keys());
  const rows = incomeRows(db, fyRange(first).from, today);
  const sums = new Map();
  let firstPay = null;
  for (const r of rows) {
    if (r.kind !== 'salary' && r.kind !== 'regular') continue;
    const s = sums.get(fyOf(r.date)) ?? { salary: 0, regular: 0 };
    s[r.kind] += r.amount;
    sums.set(fyOf(r.date), s);
    if (r.kind === 'salary' && (firstPay == null || r.date < firstPay)) firstPay = r.date;
  }
  const years = [];
  for (let fy = first; fy <= current; fy++) {
    const { from, to } = fyRange(fy);
    const s = sums.get(fy) ?? { salary: 0, regular: 0 };
    const noa = assessments.get(fy) ?? null;
    years.push({
      fy, from, to, current: fy === current,
      // Bank history that starts after the year does, or well into it, says little about that year.
      partial_bank: firstPay == null || firstPay > addDays(from, PARTIAL_AFTER_DAYS),
      salary: s.salary, regular: s.regular, income: s.salary + s.regular,
      noa,
      ...reconcile({ salary: s.salary, payg: noa?.tax_withheld_payg, taxable: noa?.taxable_income }),
    });
  }
  return {
    as_of: today, current_fy: current, years,
    note: 'Cents. Salary and regular are what landed in the bank, after tax. est_gross is salary plus the PAYG withheld on the NoA; gap is est_gross less the NoA taxable income. The current year is year to date.',
  };
}
