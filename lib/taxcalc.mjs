// The tax return maths for a single resident individual, no database. Rate
// tables live in lib/taxrates.mjs. Amounts are cents; rates are basis points,
// so everything is integer arithmetic until the final rounding to a cent.
import { TAX_YEARS } from './taxrates.mjs';

export const hasRates = (fy) => Object.hasOwn(TAX_YEARS, fy);
const t = (fy) => {
  if (!hasRates(fy)) throw new Error(`no verified rate tables for FY${fy}`);
  return TAX_YEARS[fy];
};
const bpOf = (cents, bp) => Math.round((cents * bp) / 10000);
// Taxable income and the incomes derived from it are assessed in whole dollars.
const wholeDollars = (cents) => Math.max(0, Math.floor(cents / 100)) * 100;

// Tax on taxable income, before offsets and the Medicare levy.
export function incomeTax(fy, taxableCents) {
  const ti = wholeDollars(taxableCents);
  const b = [...t(fy).income_tax.brackets].reverse().find((x) => ti > x.over * 100);
  return b ? b.base * 100 + bpOf(ti - b.over * 100, b.bp) : 0;
}

// 2% of taxable income, shaded in at 10c over the lower threshold for low incomes.
export function medicareLevy(fy, taxableCents) {
  const m = t(fy).medicare;
  const ti = wholeDollars(taxableCents);
  if (ti <= m.lower * 100) return 0;
  return Math.min(bpOf(ti - m.lower * 100, m.phase_bp), bpOf(ti, m.bp));
}

// The low income tax offset before it is capped by the tax it can reduce.
export function lito(fy, taxableCents) {
  const o = t(fy).lito;
  const ti = wholeDollars(taxableCents);
  if (ti <= o.first * 100) return o.max * 100;
  if (ti <= o.second * 100) return o.max * 100 - bpOf(ti - o.first * 100, o.first_bp);
  return Math.max(0, o.mid * 100 - bpOf(ti - o.second * 100, o.second_bp));
}

// The surcharge for a single with no appropriate private hospital cover: the
// tier rate applied to the whole income for MLS purposes.
export function medicareLevySurcharge(fy, mlsIncomeCents) {
  const tier = t(fy).mls.tiers.find((x) => mlsIncomeCents <= x.upTo * 100);
  return bpOf(Math.max(0, mlsIncomeCents), tier.bp);
}

// Compulsory repayment on repayment income, marginal from 2025-26.
export function helpRepayment(fy, repaymentIncomeCents) {
  const h = t(fy).help;
  const ri = wholeDollars(repaymentIncomeCents);
  if (ri > h.whole_over * 100) return bpOf(ri, h.whole_bp);
  const b = [...h.bands].reverse().find((x) => ri > x.over * 100);
  return b ? b.base * 100 + bpOf(ri - b.over * 100, b.bp) : 0;
}

// ---------- PAYG withholding (Schedule 1, scale 2: tax-free threshold claimed) ----------
// Method per the instrument: earnings to a weekly equivalent (fortnightly
// halved, monthly x 3 / 13, cents ignored), x = that plus 99c, y = a x - b
// rounded to the dollar, then back to the pay period (x2, or x 13 / 3 rounded).
// A number for a period is a pay every that many days, treated like weekly pay
// scaled by 7 / days; the ATO has no scale for it, so it is only a fallback.

const PERIODS = {
  weekly: { weekly: (g) => g, back: (w) => w },
  fortnightly: { weekly: (g) => g / 2, back: (w) => w * 2 },
  monthly: { weekly: (g) => ((g + 1) * 3) / 13, back: (w) => Math.round((w * 13) / 3) },
};
const periodFns = (period) => PERIODS[period] ?? (Number.isFinite(period) && period > 0
  ? { weekly: (g) => (g * 7) / period, back: (w) => Math.round((w * period) / 7) } : null);

export function withholding(fy, grossCents, period) {
  const p = periodFns(period);
  if (!p) throw new Error(`unknown pay period ${period}`);
  const x = Math.floor(p.weekly(grossCents) / 100) + 0.99;
  const row = t(fy).withholding.scale2.find(([lt]) => x < lt);
  const [, a, b] = row;
  const weekly = Math.max(0, Math.round(a * x - b));
  return p.back(weekly) * 100;
}

// The gross pay that leaves this net pay after withholding. Rounding to whole
// dollars means a net pay can fit two gross pays a dollar or so apart (and
// withholding steps up at each weekly dollar), so this takes the lowest gross
// that nets exactly this much, or the nearest if none does.
export function grossFromNet(fy, netCents, period) {
  if (!(netCents > 0)) return 0;
  const cents = netCents % 100;
  let best = netCents;
  let bestDiff = Infinity;
  const stop = Math.ceil(netCents / 100 / 0.5) + 2;
  for (let d = Math.floor(netCents / 100); d <= stop; d++) {
    const gross = d * 100 + cents;
    const net = gross - withholding(fy, gross, period);
    const diff = Math.abs(net - netCents);
    if (diff < bestDiff) { best = gross; bestDiff = diff; }
    if (diff === 0 || net > netCents + 1000) break;
  }
  return best;
}

// ---------- the return ----------

// salary, interest, business (a loss is ignored: non-commercial loss rules can
// defer it), other: assessable income. deductions: everything deducted, of
// which d12 is personal super (it also counts towards MLS and HELP income).
// withheld: PAYG tax withheld. private_health, has_help: true, false or null
// (unknown: assumed cover and no debt, with what the other answer would cost).
// help_balance caps the repayment when known.
export function computeReturn(fy, { salary = 0, interest = 0, business = 0, other = 0, deductions = 0, d12 = 0, withheld = 0, private_health = null, has_help = null, help_balance = null }) {
  const assessable = salary + interest + Math.max(0, business) + other;
  const taxable = wholeDollars(assessable - deductions);
  const reportable = taxable + Math.max(0, d12);
  const income_tax = incomeTax(fy, taxable);
  const lito_offered = lito(fy, taxable);
  const lito_applied = Math.min(lito_offered, income_tax);
  const medicare = medicareLevy(fy, taxable);
  const mlsIfNoCover = medicareLevySurcharge(fy, reportable);
  const helpIfDebt = Math.min(helpRepayment(fy, reportable), help_balance ?? Infinity);
  const mls = private_health === false ? mlsIfNoCover : 0;
  const help = has_help === true ? helpIfDebt : 0;
  const tax_payable = income_tax - lito_applied + medicare + mls + help;
  const swings = [];
  if (private_health == null && mlsIfNoCover > 0) swings.push({ key: 'private_health', label: 'If you had no private hospital cover (Medicare levy surcharge)', amount: mlsIfNoCover });
  if (has_help == null && helpIfDebt > 0) swings.push({ key: 'has_help', label: 'If you have a HELP or other study loan debt (compulsory repayment)', amount: helpIfDebt });
  return {
    assessable, taxable, income_tax, lito_offered, lito: lito_applied, medicare, mls, help, tax_payable,
    result: withheld - tax_payable, swings, mls_income: reportable,
  };
}
