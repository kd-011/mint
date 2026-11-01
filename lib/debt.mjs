// Debt and offset. The home loan: balance, rate, repayment, offset, interest
// per cycle and per year with and without the offset, payoff at the current
// repayment and what an extra amount per cycle does. Cards: balance, limit,
// paydown per cycle to clear by a date, payoff at an amount per cycle. Rates
// come only from Redbark's product details; a card without a purchase rate
// says "rate unknown" and its maths leaves interest out.
import { bad } from './errors.mjs';
import { addDays, daysBetween, isIsoDate } from './dates.mjs';
import { addMonths } from './recurring.mjs';
import { netWorth } from './networth.mjs';
import { amortise, levelPayment } from './loanmath.mjs';
import { LIVE } from './live.mjs';

export { amortise, levelPayment };

const CYCLE_DAYS = 14;
const FREQ = { P1M: { name: 'monthly', perYear: 12 }, P2W: { name: 'fortnightly', perYear: 26 }, P14D: { name: 'fortnightly', perYear: 26 }, P1W: { name: 'weekly', perYear: 52 }, P7D: { name: 'weekly', perYear: 52 } };

const ENTERED_FREQ = { monthly: FREQ.P1M, fortnightly: FREQ.P2W, weekly: FREQ.P1W };

const parse = (j) => { try { return JSON.parse(j ?? 'null'); } catch { return null; } };
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
export const centsParam = (v, name) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1e10) throw bad(`${name} must be whole cents, zero or more`);
  return n;
};

function loanRate(d) {
  const direct = num(d?.lending_rate);
  if (direct != null) return direct;
  const first = (d?.lending_rates ?? []).find((x) => num(x.rate) != null && x.rate_type !== 'INTRODUCTORY');
  return first ? num(first.rate) : null;
}

// Repayments seen going into the loan, newest first, leaving out the week
// around the loan's start (the borrower's own funds at settlement are not a
// repayment).
const REPAID = `SELECT i.date, i.amount FROM transfers x JOIN transactions i ON i.id = x.in_tx
  WHERE x.status IN ('auto', 'confirmed') AND i.account_id = ? AND ${LIVE('i')} AND i.amount > 0 AND i.date > ? AND i.date <= ? ORDER BY i.date DESC, i.id DESC`;
const afterStart = (startDate) => (startDate ? addDays(startDate, 7) : '0000-00-00');

function lastInterestCharge(db, loanId) {
  return db.prepare("SELECT -amount amount FROM transactions WHERE account_id = ? AND amount < 0 AND upper(trim(description)) = 'INTEREST' ORDER BY date DESC LIMIT 1").get(loanId)?.amount ?? null;
}

// What the owner actually pays, always an amount he really paid: the middle of the
// last three repayments (one extra payment does not move it), or with fewer
// than three the latest (two different repayments averaged is a figure he
// never paid). For an interest-only loan with none yet, the last interest charge.
function repaymentOf(db, loanId, interestOnly, recent) {
  if (recent.length) return { amount: recent.length >= 3 ? median(recent.map((r) => r.amount)) : recent[0].amount, basis: 'recent_repayments', count: recent.length };
  if (interestOnly) {
    const last = lastInterestCharge(db, loanId);
    if (last != null) return { amount: last, basis: 'last_interest_charge', count: 1 };
  }
  return { amount: null, basis: null, count: 0 };
}

// The bank's own figure: its minimum instalment when it sends one, else for an
// interest-only loan the interest it charged last.
function scheduledOf(db, loanId, ld, interestOnly) {
  const min = num(ld.min_instalment_amount);
  if (min != null && min > 0) return { amount: Math.round(min * 100), basis: 'bank' };
  const charge = interestOnly ? lastInterestCharge(db, loanId) : null;
  return charge != null ? { amount: charge, basis: 'last_interest_charge' } : { amount: null, basis: null };
}

// Loan details the owner entered where Redbark gives none (see lib/homeloan.mjs).
// The bank's value always wins; these only fill a gap.
export function loanInputsOf(db, accountId) {
  const r = db.prepare('SELECT rate, repayment, frequency, end_date FROM loan_inputs WHERE account_id = ?').get(accountId);
  return r ? { ...r } : { rate: null, repayment: null, frequency: null, end_date: null };
}

export function loanFacts(db, a) {
  const d = parse(a.details_json);
  const ld = d?.loan_details ?? {};
  const inp = loanInputsOf(db, a.id);
  const interestOnly = /INTEREST_ONLY/i.test(ld.repayment_type ?? '');
  const bankRate = loanRate(d);
  let freq = FREQ[ld.repayment_frequency] ?? FREQ.P1M;
  const recent = db.prepare(REPAID).all(a.id, afterStart(ld.original_start_date), '9999-12-31').slice(0, 3).map(({ date, amount }) => ({ date, amount }));
  let repayment = repaymentOf(db, a.id, interestOnly, recent);
  let repaymentSource = repayment.basis === 'recent_repayments' ? 'repayments' : repayment.amount == null ? null : 'bank';
  if (repayment.amount == null && inp.repayment != null) {
    repayment = { amount: inp.repayment, basis: 'entered', count: 0 };
    repaymentSource = 'you';
    freq = ENTERED_FREQ[inp.frequency ?? 'monthly'];
  }
  const endDate = ld.loan_end_date || inp.end_date || null;
  return {
    rate: bankRate ?? inp.rate, freq, interestOnly, details: { ...ld, loan_end_date: endDate }, repayment, recent,
    scheduled: scheduledOf(db, a.id, ld, interestOnly),
    sources: { rate: bankRate != null ? 'bank' : inp.rate != null ? 'you' : null, repayment: repaymentSource, end_date: ld.loan_end_date ? 'bank' : inp.end_date ? 'you' : null },
  };
}

// The next instalment the bank has on its books and whether it is paid: a
// repayment landing after the instalment before it, up to its date, pays it
// (paid_on is the latest, amount what went in). Null without a date from the bank.
export function instalmentOf(db, a, f) {
  const due = f.details.next_instalment_date;
  if (!due) return null;
  const prev = f.freq.perYear === 12 ? addMonths(due, -1) : addDays(due, f.freq.perYear === 26 ? -14 : -7);
  const start = afterStart(f.details.original_start_date);
  const paid = db.prepare(REPAID).all(a.id, prev > start ? prev : start, due);
  return paid.length
    ? { due_date: due, status: 'paid', paid_on: paid[0].date, amount: paid.reduce((s, p) => s + p.amount, 0) }
    : { due_date: due, status: 'due', paid_on: null, amount: f.repayment.amount };
}

// The repayment as every loan surface shows it: what the owner pays, when he last
// paid, the last few, and the bank's figure beside it.
export const repaymentFacts = (f) => ({ last_paid: f.recent[0] ?? null, recent: f.recent, scheduled: f.scheduled });

export function loanView(db, { today, extra = null } = {}) {
  const extraCents = centsParam(extra, 'extra');
  const nw = netWorth(db);
  const rows = db.prepare("SELECT * FROM accounts WHERE type = 'loan' AND status IS NOT 'gone' AND hidden = 0 ORDER BY sort, name").all();
  return rows.map((a) => {
    const f = loanFacts(db, a);
    const balance = Math.max(0, -(a.balance_current ?? 0));
    const off = nw.loans.find((l) => l.id === a.id);
    const offset = off?.offset_total ?? 0;
    const rate = f.rate;
    const perYear = (b) => (rate == null ? null : Math.round(b * rate));
    const yWithout = perYear(balance);
    const yWith = perYear(Math.max(0, balance - offset));
    const cyc = (y) => (y == null ? null : Math.round((y * CYCLE_DAYS) / 365));
    const monthly = f.repayment.amount == null ? null : Math.round((f.repayment.amount * f.freq.perYear) / 12);
    const out = {
      id: a.id, name: a.nickname || a.name, institution: a.institution, balance, rate, rate_known: rate != null,
      repayment: { amount: f.repayment.amount, frequency: f.freq.name, per_month: monthly, basis: f.repayment.basis, source: f.sources.repayment, type: f.details.repayment_type ?? null, next_instalment_date: f.details.next_instalment_date ?? null, ...repaymentFacts(f) },
      instalment: instalmentOf(db, a, f),
      offset: { enabled: f.details.offset_account_enabled ?? null, balance: offset, accounts: off?.offsets ?? [] },
      interest: {
        per_year: { without_offset: yWithout, with_offset: yWith, saved_by_offset: yWithout == null ? null : yWithout - yWith },
        per_cycle: { without_offset: cyc(yWithout), with_offset: cyc(yWith), saved_by_offset: yWithout == null ? null : cyc(yWithout) - cyc(yWith) },
      },
      loan_end_date: f.details.loan_end_date ?? null,
      payoff: null,
      extra: null,
    };
    if (rate == null) {
      out.payoff = { amortising: null, date: null, months: null, interest: null, reason: 'no rate in the loan details' };
      if (extraCents) out.extra = { per_cycle: extraCents, per_month: Math.round((extraCents * 26) / 12), reason: 'no rate in the loan details' };
      return out;
    }
    const base = monthly == null ? { amortising: null, months: null, interest: null } : amortise({ balance, offset, rate, payment: monthly });
    out.payoff = { ...base, date: base.amortising ? addMonths(today, base.months) : null, basis: 'current_repayment' };
    if (out.payoff.date && f.details.loan_end_date) out.payoff.beyond_term = out.payoff.date > f.details.loan_end_date;
    let reference = base;
    let referencePayment = monthly;
    if (!base.amortising) {
      // Interest only (or paying under the interest): compare against the
      // principal and interest repayment that clears it by the loan's end date.
      const months = f.details.loan_end_date ? Math.max(1, Math.round(daysBetween(today, f.details.loan_end_date) / 30.4375)) : 360;
      referencePayment = levelPayment(balance, rate / 12, months);
      reference = amortise({ balance, offset, rate, payment: referencePayment });
      out.payoff.reason = monthly == null ? 'no repayment seen yet' : f.interestOnly ? 'interest only: the balance does not fall at this repayment' : 'the repayment does not cover the interest';
      out.payoff.principal_and_interest = { repayment_per_month: referencePayment, months: reference.months, date: reference.amortising ? addMonths(today, reference.months) : null, interest: reference.interest };
    }
    if (extraCents) {
      const perMonth = Math.round((extraCents * 26) / 12);
      const e = amortise({ balance, offset, rate, payment: referencePayment + perMonth });
      out.extra = {
        per_cycle: extraCents, per_month: perMonth, compared_with: base.amortising ? 'current_repayment' : 'principal_and_interest_to_term',
        months: e.months, payoff_date: e.amortising ? addMonths(today, e.months) : null, interest: e.interest,
        months_sooner: e.amortising && reference.amortising ? reference.months - e.months : null,
        interest_saved: e.amortising && reference.amortising ? reference.interest - e.interest : null,
      };
    }
    return out;
  });
}

function cardRate(d) {
  const purchase = (d?.lending_rates ?? []).find((x) => x.rate_type === 'PURCHASE' && num(x.rate) != null);
  return purchase ? num(purchase.rate) : null;
}

export function cardView(db, { today, by = null, perCycle = null } = {}) {
  if (by != null && by !== '' && !isIsoDate(by)) throw bad('by must be a date as YYYY-MM-DD');
  const per = centsParam(perCycle, 'per_cycle');
  if (by && by <= today) throw bad('by must be after today');
  const planned = new Map(db.prepare("SELECT account_id, amount FROM pay_plan WHERE amount IS NOT NULL").all().map((p) => [p.account_id, p.amount]));
  return db.prepare("SELECT * FROM accounts WHERE type = 'credit-card' AND status IS NOT 'gone' AND hidden = 0 ORDER BY sort, name").all().map((a) => {
    const d = parse(a.details_json);
    const rate = cardRate(d);
    const intro = (d?.lending_rates ?? []).filter((x) => x.rate_type === 'INTRODUCTORY').map((x) => ({ rate: num(x.rate), term: x.additional_value ?? null, info: x.additional_info ?? null }));
    const balance = Math.max(0, -(a.balance_current ?? 0));
    const r = rate == null ? 0 : rate / 26;
    const out = {
      id: a.id, name: a.nickname || a.name, institution: a.institution, balance, available: a.balance_available ?? null,
      limit: a.balance_available == null ? null : a.balance_available - (a.balance_current ?? 0),
      rate, rate_known: rate != null, introductory: intro,
      rate_note: rate != null
        ? 'Purchase rate from the bank product details; the maths assumes it applies to the whole balance.'
        : 'Rate unknown: the bank gives no purchase rate for this card, so the paydown maths leaves interest out.',
      statement: null, statement_note: 'This card has no statement balance or due date on file, so Mint does not guess one.',
      clear_by: null, at_amount: null,
    };
    if (by) {
      const cycles = Math.max(1, Math.floor(daysBetween(today, by) / CYCLE_DAYS));
      out.clear_by = { date: by, cycles, per_cycle: levelPayment(balance, r, cycles) };
    }
    const amount = per ?? planned.get(a.id) ?? null;
    if (amount) {
      const s = amortise({ balance, rate: rate ?? 0, payment: amount, periodsPerYear: 26 });
      out.at_amount = { per_cycle: amount, from_plan: per == null, cycles: s.months, date: s.amortising ? addDays(today, s.months * CYCLE_DAYS) : null, interest: s.interest, clears: s.amortising };
    }
    return out;
  });
}

export function debtReport(db, { today, extra = null, by = null, perCycle = null } = {}) {
  return {
    as_of: today,
    loans: loanView(db, { today, extra }),
    cards: cardView(db, { today, by, perCycle }),
    note: 'Cents. Rates are annual (0.0656 is 6.56%). Payoff maths compounds monthly for loans and per pay cycle for cards; an extra amount per cycle is counted as x 26 / 12 a month.',
  };
}
