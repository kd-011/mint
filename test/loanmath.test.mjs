// Save and Invest: the home loan maths in its own module. Hand-worked figures
// (closed form n = -ln(1 - rP/A) / ln(1 + r)) and the edge cases that break
// naive amortisation: zero rate, an offset bigger than the loan, a repayment
// that does not cover the interest, interest-only loans, a repayment bigger
// than the balance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amortise, levelPayment, projectLoan, balanceSchedule } from '../lib/loanmath.mjs';
import * as debt from '../lib/debt.mjs';

const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} ${actual} vs ${expected}`);
const TODAY = '2026-10-17';

test('debt.mjs still exports the same amortise and levelPayment', () => {
  assert.equal(debt.amortise, amortise);
  assert.equal(debt.levelPayment, levelPayment);
});

test('$100,000 at 6% paying $1,000 a month: 139 months, about $38,976 interest, $500 a month at first', () => {
  const p = projectLoan({ today: TODAY, balance: 10000000, rate: 0.06, payment: 100000 });
  assert.equal(p.payoff.amortising, true);
  assert.equal(p.payoff.months, 139);
  assert.equal(p.payoff.date, '2038-05-17');
  near(p.payoff.interest, 3897572, 300, 'interest');
  assert.equal(p.interest.per_month, 50000);
  assert.equal(p.interest.per_year, 600000);
  assert.equal(p.effective_balance, 10000000);
  assert.equal(p.interest.saved_by_offset_per_year, 0);
  assert.equal(p.extra, null);
});

test('an offset lowers the effective balance, the interest and the payoff, and says what it saves a year', () => {
  const p = projectLoan({ today: TODAY, balance: 10000000, offset: 2000000, rate: 0.06, payment: 100000 });
  assert.equal(p.effective_balance, 8000000);
  assert.equal(p.interest.per_year, 480000);
  assert.equal(p.interest.per_month, 40000);
  assert.equal(p.interest.without_offset_per_year, 600000);
  assert.equal(p.interest.saved_by_offset_per_year, 120000);
  assert.equal(p.payoff.months, 123);
  near(p.payoff.interest, 2242033, 300, 'interest');
});

test('extra a month: $300 on top of $1,000 clears in 98 months, 41 sooner, and saves the difference in interest', () => {
  const base = amortise({ balance: 10000000, rate: 0.06, payment: 100000 });
  const p = projectLoan({ today: TODAY, balance: 10000000, rate: 0.06, payment: 100000, extra: 30000 });
  assert.equal(p.extra.extra_per_month, 30000);
  assert.equal(p.extra.amortising, true);
  assert.equal(p.extra.months, 98);
  assert.equal(p.extra.months_sooner, 41);
  assert.equal(p.extra.payoff_date, '2034-12-17');
  assert.equal(p.extra.interest_saved, base.interest - p.extra.interest);
  assert.ok(p.extra.interest_saved > 1000000);
  assert.equal(p.extra.compared_with, 'current_repayment');
});

test('zero rate: no interest at all, payoff is the balance over the repayment rounded up', () => {
  const a = projectLoan({ today: TODAY, balance: 1200000, rate: 0, payment: 100000 });
  assert.equal(a.payoff.months, 12);
  assert.equal(a.payoff.interest, 0);
  assert.equal(a.interest.per_month, 0);
  assert.equal(a.interest.per_year, 0);
  const b = projectLoan({ today: TODAY, balance: 1250000, rate: 0, payment: 100000, extra: 50000 });
  assert.equal(b.payoff.months, 13);
  assert.equal(b.extra.months, 9);
  assert.equal(b.extra.months_sooner, 4);
  assert.equal(b.extra.interest_saved, 0);
});

test('offset larger than the balance: zero interest, the offset saves all of it, payoff is just the repayment', () => {
  const p = projectLoan({ today: TODAY, balance: 10000000, offset: 15000000, rate: 0.06, payment: 100000 });
  assert.equal(p.effective_balance, 0);
  assert.equal(p.interest.per_year, 0);
  assert.equal(p.interest.per_month, 0);
  assert.equal(p.interest.saved_by_offset_per_year, 600000, 'saving is capped at interest on the whole loan');
  assert.equal(p.payoff.amortising, true);
  assert.equal(p.payoff.months, 100);
  assert.equal(p.payoff.interest, 0);
});

test('repayment below the interest never clears: no date, a reason, and an extra that tips it over has nothing to compare with', () => {
  const p = projectLoan({ today: TODAY, balance: 10000000, rate: 0.06, payment: 40000, extra: 20000 });
  assert.equal(p.payoff.amortising, false);
  assert.equal(p.payoff.months, null);
  assert.equal(p.payoff.date, null);
  assert.match(p.payoff.reason, /interest/i);
  assert.equal(p.extra.amortising, true);
  assert.equal(p.extra.months_sooner, null);
  assert.equal(p.extra.interest_saved, null);
  assert.ok(p.extra.payoff_date);
  // Interest and balance figures still stand.
  assert.equal(p.interest.per_month, 50000);
});

test('repayment exactly equal to the interest is not progress either', () => {
  const p = projectLoan({ today: TODAY, balance: 10000000, rate: 0.06, payment: 50000 });
  assert.equal(p.payoff.amortising, false);
});

test('interest only: the balance never falls, so the extra is compared with principal and interest to the loan end', () => {
  const interestOnly = Math.round((35120718 * 0.0656) / 12);
  const p = projectLoan({ today: TODAY, balance: 35120718, rate: 0.0656, payment: interestOnly, termMonths: 357, extra: 50000 });
  assert.equal(p.payoff.amortising, false);
  const ref = levelPayment(35120718, 0.0656 / 12, 357);
  assert.equal(p.payoff.principal_and_interest.repayment_per_month, ref);
  assert.ok(p.payoff.principal_and_interest.months <= 357);
  assert.equal(p.extra.compared_with, 'principal_and_interest_to_term');
  assert.equal(p.extra.months_sooner, p.payoff.principal_and_interest.months - p.extra.months);
  assert.ok(p.extra.months_sooner > 0);
  assert.ok(p.extra.interest_saved > 0);
});

test('a repayment bigger than the balance clears in one month for one month of interest', () => {
  const p = projectLoan({ today: TODAY, balance: 50000, rate: 0.06, payment: 100000 });
  assert.equal(p.payoff.months, 1);
  assert.equal(p.payoff.interest, 250);
  assert.equal(p.payoff.date, '2026-11-17');
});

test('a paid-off loan has nothing to project', () => {
  const p = projectLoan({ today: TODAY, balance: 0, rate: 0.06, payment: 100000, extra: 10000 });
  assert.equal(p.payoff.months, 0);
  assert.equal(p.payoff.date, TODAY);
  assert.equal(p.interest.per_year, 0);
});

test('no repayment given: interest figures stand, payoff is unknown rather than guessed', () => {
  const p = projectLoan({ today: TODAY, balance: 10000000, rate: 0.06, payment: null });
  assert.equal(p.interest.per_year, 600000);
  assert.equal(p.payoff.amortising, null);
  assert.equal(p.payoff.date, null);
  assert.match(p.payoff.reason, /repayment/i);
});

test('bad input is refused, not coerced', () => {
  assert.throws(() => projectLoan({ today: TODAY, balance: -1, rate: 0.06, payment: 1 }), /balance/);
  assert.throws(() => projectLoan({ today: TODAY, balance: 100, rate: -0.01, payment: 1 }), /rate/);
  assert.throws(() => projectLoan({ today: TODAY, balance: 100, rate: 0.06, payment: 1, extra: -5 }), /extra/);
  assert.throws(() => projectLoan({ today: TODAY, balance: 100, rate: null, payment: 1 }), /rate/);
});

test('balanceSchedule: month 0 is today, falls to zero at the payoff month, samples to a sensible size', () => {
  const s = balanceSchedule({ today: TODAY, balance: 10000000, rate: 0.06, payment: 100000, maxPoints: 40 });
  assert.deepEqual(s[0], [TODAY, 10000000]);
  assert.equal(s.at(-1)[1], 0);
  assert.equal(s.at(-1)[0], '2038-05-17');
  assert.ok(s.length <= 41);
  assert.ok(s.every((p, i) => i === 0 || p[1] < s[i - 1][1]));
  const flat = balanceSchedule({ today: TODAY, balance: 10000000, rate: 0.06, payment: 40000 });
  assert.deepEqual(flat, [], 'no schedule when the repayment does not clear it');
});
