// Loan maths, no database. Pay a balance down month by month with the offset
// netted off the interest, and answer the questions the Save and Invest screen
// asks: what is the interest a month and a year, what the offset saves, when
// does it clear, and what an extra amount a month does to both. Money is whole
// cents, rates are annual decimals (0.0656 is 6.56%).
//
// Assumptions, stated so nobody mistakes them for facts: the rate stays where
// it is, and the offset balance stays where it is. Interest each period is on
// the balance less the offset, at rate / periods, rounded to the cent.
import { bad } from './errors.mjs';
import { addMonths } from './recurring.mjs';

const MAX_PERIODS = 1200;

// Pay a balance down period by period. Returns the periods to clear it
// (called months, the usual case) and the interest paid, or amortising false
// when the payment never gets ahead of the interest. onPeriod(n, balance) sees
// the balance after each period, for drawing a schedule.
export function amortise({ balance, offset = 0, rate, payment, periodsPerYear = 12, onPeriod = null }) {
  const r = (rate ?? 0) / periodsPerYear;
  let bal = balance;
  let interest = 0;
  let n = 0;
  if (bal <= 0) return { amortising: true, months: 0, interest: 0 };
  if (!(payment > 0) || payment <= Math.round(Math.max(0, bal - offset) * r)) return { amortising: false, months: null, interest: null };
  while (bal > 0 && n < MAX_PERIODS) {
    const i = Math.round(Math.max(0, bal - offset) * r);
    interest += i;
    bal += i - Math.min(payment, bal + i);
    n += 1;
    onPeriod?.(n, bal);
  }
  return bal > 0 ? { amortising: false, months: null, interest: null } : { amortising: true, months: n, interest };
}

// The level payment that clears `balance` in n periods at rate r per period.
export function levelPayment(balance, r, n) {
  if (n <= 0) return balance;
  if (!r) return Math.ceil(balance / n);
  return Math.ceil((balance * r) / (1 - (1 + r) ** -n));
}

const money = (v, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad(`${name} must be zero or more`);
  return v;
};

function dated(today, a) {
  return { ...a, date: a.amortising ? addMonths(today, a.months) : null };
}

// Everything the home loan card shows, from numbers the caller already holds.
// payment is the repayment per month (null when unknown); extra is the
// what-if, more per month on top; termMonths is the months left to the loan's
// end, used only when the current repayment never clears the balance (an
// interest-only loan, say), to compare against principal and interest to term.
export function projectLoan({ today, balance, offset = 0, rate, payment = null, extra = 0, termMonths = null }) {
  money(balance, 'balance');
  money(offset, 'offset');
  if (rate == null) throw bad('rate is needed');
  money(rate, 'rate');
  money(extra, 'extra');
  const effective = Math.max(0, balance - offset);
  const covered = Math.min(balance, offset);
  const interest = {
    per_year: Math.round(effective * rate),
    per_month: Math.round((effective * rate) / 12),
    without_offset_per_year: Math.round(balance * rate),
    saved_by_offset_per_year: Math.round(balance * rate) - Math.round(effective * rate),
    saved_by_offset_per_month: Math.round((covered * rate) / 12),
  };
  const out = { effective_balance: effective, interest, payoff: null, extra: null };
  if (payment == null) {
    out.payoff = { amortising: null, months: null, interest: null, date: null, reason: 'no repayment known' };
    return out;
  }
  const base = amortise({ balance, offset, rate, payment });
  out.payoff = { ...dated(today, base), basis: 'current_repayment' };
  let reference = base;
  let referencePayment = payment;
  let comparedWith = base.amortising ? 'current_repayment' : null;
  if (!base.amortising) {
    out.payoff.reason = 'the repayment does not cover the interest, so the balance is not coming down';
    if (termMonths != null) {
      referencePayment = levelPayment(balance, rate / 12, termMonths);
      reference = amortise({ balance, offset, rate, payment: referencePayment });
      comparedWith = 'principal_and_interest_to_term';
      out.payoff.principal_and_interest = { repayment_per_month: referencePayment, months: reference.months, date: reference.amortising ? addMonths(today, reference.months) : null, interest: reference.interest };
    }
  }
  if (extra > 0) {
    const e = amortise({ balance, offset, rate, payment: referencePayment + extra });
    const both = e.amortising && reference.amortising;
    out.extra = {
      extra_per_month: extra, compared_with: comparedWith, amortising: e.amortising,
      months: e.months, payoff_date: e.amortising ? addMonths(today, e.months) : null, interest: e.interest,
      months_sooner: both ? reference.months - e.months : null,
      interest_saved: both ? reference.interest - e.interest : null,
    };
  }
  return out;
}

// [date, balance] points for a chart, month 0 first and the payoff last,
// thinned to about maxPoints (or every `every` months, so two schedules line up
// for a table). Empty when the payment does not clear the loan.
export function balanceSchedule({ today, balance, offset = 0, rate, payment, maxPoints = 60, every = null }) {
  const all = [[0, balance]];
  const r = amortise({ balance, offset, rate, payment, onPeriod: (n, bal) => all.push([n, bal]) });
  if (!r.amortising) return [];
  const step = every ?? Math.max(1, Math.ceil(r.months / maxPoints));
  const keep = all.filter(([n]) => n % step === 0 || n === r.months);
  return keep.map(([n, bal]) => [addMonths(today, n), bal]);
}
