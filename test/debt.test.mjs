// v2 step 8: debt and offset. Loan maths checked against hand-worked examples
// (closed form n = -ln(1 - rP/A) / ln(1 + r)), the offset's effect on
// interest, what an extra amount per cycle does, and the card paydown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { transfer } from './fixtures/pay.mjs';
import { amortise, loanView, cardView, debtReport } from '../lib/debt.mjs';
import { applyRules } from '../lib/categorise.mjs';
import { matchTransfers } from '../lib/transfers.mjs';

const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} ${actual} vs ${expected}`);

test('amortise: $100,000 at 6% paying $1,000 a month clears in 139 months with about $38,976 interest', () => {
  const r = amortise({ balance: 10000000, rate: 0.06, payment: 100000 });
  assert.equal(r.months, 139);
  near(r.interest, 3897572, 300, 'interest');
  assert.equal(r.amortising, true);
});

test('amortise: a $20,000 offset clears it in 123 months with about $22,420 interest', () => {
  const r = amortise({ balance: 10000000, offset: 2000000, rate: 0.06, payment: 100000 });
  assert.equal(r.months, 123);
  near(r.interest, 2242033, 300, 'interest');
});

test('amortise: an extra $600 a cycle ($1,300 a month) clears it in 98 months with about $26,547 interest', () => {
  const r = amortise({ balance: 10000000, rate: 0.06, payment: 130000 });
  assert.equal(r.months, 98);
  near(r.interest, 2654735, 300, 'interest');
});

test('amortise: a repayment at or under the interest never clears', () => {
  const r = amortise({ balance: 10000000, rate: 0.06, payment: 50000 });
  assert.equal(r.amortising, false);
  assert.equal(r.months, null);
});

function loanBook() {
  const b = book();
  b.db.prepare("UPDATE accounts SET details_json = ? WHERE id = 'acct_t_loan'").run(JSON.stringify({
    lending_rate: '0.0599',
    loan_details: { repayment_type: 'PRINCIPAL_AND_INTEREST', repayment_frequency: 'P1M', next_instalment_date: '2026-10-29', loan_end_date: '2056-07-29', offset_account_enabled: true },
  }));
  for (const d of ['2026-07-29', '2026-08-29', '2026-09-29']) transfer(b, 'acct_t_everyday', 'acct_t_loan', d, 250000);
  applyRules(b.db);
  matchTransfers(b.db);
  return b;
}

test('loan view: balance, rate, repayment, offset, interest per cycle and year with and without the offset', () => {
  const b = loanBook();
  const [l] = loanView(b.db, { today: '2026-10-17' });
  assert.equal(l.balance, 40000000);
  assert.equal(l.rate, 0.0599);
  assert.equal(l.repayment.amount, 250000);
  assert.equal(l.repayment.frequency, 'monthly');
  assert.equal(l.offset.balance, 2500000);
  assert.deepEqual(l.interest.per_year, { without_offset: 2396000, with_offset: 2246250, saved_by_offset: 149750 });
  assert.deepEqual(l.interest.per_cycle, { without_offset: 91901, with_offset: 86158, saved_by_offset: 5743 });
  assert.equal(l.payoff.amortising, true);
  assert.match(l.payoff.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('loan view: an extra amount per cycle brings payoff forward and saves interest', () => {
  const b = loanBook();
  const [base] = loanView(b.db, { today: '2026-10-17' });
  const [more] = loanView(b.db, { today: '2026-10-17', extra: 60000 });
  assert.equal(more.extra.per_cycle, 60000);
  assert.equal(more.extra.per_month, 130000);
  assert.ok(more.extra.payoff_date < base.payoff.date);
  assert.ok(more.extra.months_sooner > 0);
  assert.equal(more.extra.interest_saved, base.payoff.interest - more.extra.interest);
  assert.ok(more.extra.interest_saved > 0);
  assert.throws(() => loanView(b.db, { today: '2026-10-17', extra: -1 }), (e) => e.status === 400);
});

test('card: rate from the details when given, else rate unknown; paydown by date and payoff at an amount', () => {
  const b = book();
  b.db.prepare("UPDATE accounts SET balance_current = -500000, balance_available = 500000 WHERE id = 'acct_t_card'").run();
  const unknown = cardView(b.db, { today: '2026-10-17', by: '2027-03-06', perCycle: 50000 })[0];
  assert.equal(unknown.rate, null);
  assert.equal(unknown.rate_known, false);
  assert.match(unknown.rate_note, /rate unknown/i);
  assert.equal(unknown.balance, 500000);
  assert.equal(unknown.limit, 1000000);
  assert.equal(unknown.clear_by.cycles, 10);
  assert.equal(unknown.clear_by.per_cycle, 50000);
  assert.equal(unknown.at_amount.cycles, 10);
  b.db.prepare("UPDATE accounts SET details_json = ? WHERE id = 'acct_t_card'").run(JSON.stringify({
    lending_rate: null, lending_rates: [{ rate_type: 'INTRODUCTORY', rate: '0', additional_value: 'P3M' }, { rate_type: 'PURCHASE', rate: '0.1899' }],
  }));
  const known = cardView(b.db, { today: '2026-10-17', by: '2027-03-06', perCycle: 50000 })[0];
  assert.equal(known.rate, 0.1899);
  assert.equal(known.rate_known, true);
  near(known.clear_by.per_cycle, 52031, 3, 'per cycle');
  assert.ok(known.at_amount.cycles === 11);
  const all = debtReport(b.db, { today: '2026-10-17' });
  assert.ok(Array.isArray(all.loans) && Array.isArray(all.cards));
});
