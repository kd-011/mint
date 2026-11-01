// Save and Invest, section three: home loan and offset. Built from what Mint
// holds (the loan's rate, balance and terms, the offset account, repayments
// seen); anything missing is reported as missing and can be entered, never
// guessed. Bank values win; entered values only fill gaps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { transfer } from './fixtures/pay.mjs';
import { applyRules } from '../lib/categorise.mjs';
import { matchTransfers } from '../lib/transfers.mjs';
import { homeLoan, setLoanInputs } from '../lib/homeloan.mjs';
import { loanView } from '../lib/debt.mjs';

const TODAY = '2026-10-17';
const LOAN = 'acct_t_loan';

function loanBook({ details = {}, repayments = true, rate = '0.0599' } = {}) {
  const b = book();
  b.db.prepare('UPDATE accounts SET details_json = ? WHERE id = ?').run(JSON.stringify({
    ...(rate == null ? {} : { lending_rate: rate }),
    loan_details: { repayment_type: 'PRINCIPAL_AND_INTEREST', repayment_frequency: 'P1M', next_instalment_date: '2026-10-29', loan_end_date: '2056-07-29', offset_account_enabled: true, ...details },
  }), LOAN);
  if (repayments) for (const d of ['2026-07-29', '2026-08-29', '2026-09-29']) transfer(b, 'acct_t_everyday', LOAN, d, 250000);
  applyRules(b.db);
  matchTransfers(b.db);
  return b;
}

test('everything held: effective balance, interest a month and a year, what the offset saves, payoff date', () => {
  const b = loanBook();
  const [l] = homeLoan(b.db, { today: TODAY }).items;
  assert.equal(l.id, LOAN);
  assert.equal(l.balance, 40000000);
  assert.equal(l.offset.balance, 2500000);
  assert.equal(l.effective_balance, 37500000);
  assert.deepEqual(l.missing, []);
  assert.equal(l.rate.value, 0.0599);
  assert.equal(l.rate.source, 'bank');
  assert.equal(l.repayment.per_month, 250000);
  assert.equal(l.interest.per_year, 2246250);
  assert.equal(l.interest.per_month, 187188);
  assert.equal(l.interest.without_offset_per_year, 2396000);
  assert.equal(l.interest.saved_by_offset_per_year, 149750);
  assert.equal(l.interest.saved_by_offset_per_month, 12479);
  assert.equal(l.payoff.amortising, true);
  assert.ok(l.payoff.date > TODAY && l.payoff.date < '2056-12-31');
  assert.equal(l.extra, null);
  assert.ok(l.chart.current.length > 2);
});

test('the extra repayment what-if is per month and shows the new payoff date and interest saved', () => {
  const b = loanBook();
  const base = homeLoan(b.db, { today: TODAY }).items[0];
  const [l] = homeLoan(b.db, { today: TODAY, extraMonth: 50000 }).items;
  assert.equal(l.extra.extra_per_month, 50000);
  assert.ok(l.extra.months < base.payoff.months);
  assert.equal(l.extra.months_sooner, base.payoff.months - l.extra.months);
  assert.ok(l.extra.payoff_date < base.payoff.date);
  assert.ok(l.extra.interest_saved > 0);
  assert.ok(l.chart.with_extra.length > 2);
});

test('a missing rate is a prompt, not a guess: no interest, no payoff, the rate listed as missing', () => {
  const b = loanBook({ rate: null });
  const [l] = homeLoan(b.db, { today: TODAY, extraMonth: 50000 }).items;
  assert.deepEqual(l.missing, ['rate']);
  assert.equal(l.rate.value, null);
  assert.equal(l.interest, null);
  assert.equal(l.payoff, null);
  assert.equal(l.extra, null);
  assert.equal(l.balance, 40000000);
  assert.equal(l.effective_balance, 37500000);
});

test('a missing repayment: interest figures stand, payoff is not worked out, repayment listed as missing', () => {
  const b = loanBook({ repayments: false });
  const [l] = homeLoan(b.db, { today: TODAY }).items;
  assert.deepEqual(l.missing, ['repayment']);
  assert.equal(l.repayment.per_month, null);
  assert.equal(l.interest.per_year, 2246250);
  assert.equal(l.payoff, null);
});

test('entered values fill the gaps: rate, repayment with its frequency, and the loan end date', () => {
  const b = loanBook({ rate: null, repayments: false, details: { loan_end_date: null } });
  const before = homeLoan(b.db, { today: TODAY }).items[0];
  assert.deepEqual(before.missing, ['rate', 'repayment']);
  setLoanInputs(b.db, LOAN, { rate: 0.0625, repayment: 120000, frequency: 'fortnightly', end_date: '2056-07-29' });
  const [l] = homeLoan(b.db, { today: TODAY }).items;
  assert.deepEqual(l.missing, []);
  assert.deepEqual([l.rate.value, l.rate.source], [0.0625, 'you']);
  assert.equal(l.repayment.source, 'you');
  assert.equal(l.repayment.frequency, 'fortnightly');
  assert.equal(l.repayment.per_month, 260000, '120,000 x 26 / 12');
  assert.equal(l.end_date.value, '2056-07-29');
  assert.equal(l.end_date.source, 'you');
  assert.equal(l.payoff.amortising, true);
  assert.deepEqual(l.inputs, { rate: 0.0625, repayment: 120000, frequency: 'fortnightly', end_date: '2056-07-29' });
});

test('what the bank gives wins over what was entered', () => {
  const b = loanBook();
  setLoanInputs(b.db, LOAN, { rate: 0.09 });
  const [l] = homeLoan(b.db, { today: TODAY }).items;
  assert.deepEqual([l.rate.value, l.rate.source], [0.0599, 'bank']);
  assert.equal(l.inputs.rate, 0.09, 'kept in case the bank value goes away');
});

test('the debt screen and the assistant read the same entered rate', () => {
  const b = loanBook({ rate: null });
  setLoanInputs(b.db, LOAN, { rate: 0.0625 });
  const [d] = loanView(b.db, { today: TODAY });
  assert.equal(d.rate, 0.0625);
  assert.equal(d.rate_known, true);
});

test('entering nothing clears; bad input is refused with a reason', () => {
  const b = loanBook({ rate: null });
  setLoanInputs(b.db, LOAN, { rate: 0.0625 });
  setLoanInputs(b.db, LOAN, { rate: null });
  assert.deepEqual(homeLoan(b.db, { today: TODAY }).items[0].missing, ['rate']);
  assert.throws(() => setLoanInputs(b.db, LOAN, { rate: 6.25 }), /rate/);
  assert.throws(() => setLoanInputs(b.db, LOAN, { rate: -0.01 }), /rate/);
  assert.throws(() => setLoanInputs(b.db, LOAN, { repayment: 12.5 }), /repayment/);
  assert.throws(() => setLoanInputs(b.db, LOAN, { repayment: -1 }), /repayment/);
  assert.throws(() => setLoanInputs(b.db, LOAN, { frequency: 'daily' }), /frequency/);
  assert.throws(() => setLoanInputs(b.db, LOAN, { end_date: '2056-02-30' }), /end_date/);
  assert.throws(() => setLoanInputs(b.db, LOAN, { end_date: '2026-01-01' }), /end_date/);
  assert.throws(() => setLoanInputs(b.db, 'acct_t_savings', { rate: 0.05 }), /loan/);
  assert.throws(() => setLoanInputs(b.db, 'acct_nope', { rate: 0.05 }), /no such/);
  assert.throws(() => setLoanInputs(b.db, LOAN, {}), /nothing/);
});

test('an offset bigger than the loan: zero interest and the offset saves all of it', () => {
  const b = loanBook();
  b.db.prepare("UPDATE accounts SET balance_current = 45000000 WHERE id = 'acct_t_offset'").run();
  const [l] = homeLoan(b.db, { today: TODAY }).items;
  assert.equal(l.effective_balance, 0);
  assert.equal(l.interest.per_year, 0);
  assert.equal(l.interest.saved_by_offset_per_year, 2396000);
});

test('interest only at the bank: payoff is not worked out at that repayment, the P&I to term is offered, the term is needed', () => {
  const b = loanBook({ repayments: false, details: { repayment_type: 'INTEREST_ONLY' } });
  b.add(LOAN, '2026-09-29', -180000, 'INTEREST');
  const [l] = homeLoan(b.db, { today: TODAY, extraMonth: 50000 }).items;
  assert.equal(l.repayment.type, 'INTEREST_ONLY');
  assert.equal(l.repayment.basis, 'last_interest_charge');
  assert.equal(l.payoff.amortising, false);
  assert.ok(l.payoff.principal_and_interest.repayment_per_month > 180000);
  assert.equal(l.extra.compared_with, 'principal_and_interest_to_term');
  const noEnd = loanBook({ repayments: false, details: { repayment_type: 'INTEREST_ONLY', loan_end_date: null } });
  noEnd.add(LOAN, '2026-09-29', -180000, 'INTEREST');
  assert.deepEqual(homeLoan(noEnd.db, { today: TODAY }).items[0].missing, ['end_date']);
});

test('no loan account: an empty list, not an error', () => {
  const b = book({ accounts: [{ id: 'acct_t_everyday', name: 'Everyday Test', type: 'transaction', conn: 'conn_t_alpha', balance: 100000 }] });
  assert.deepEqual(homeLoan(b.db, { today: TODAY }).items, []);
});

test('extra is validated: whole cents, zero or more', () => {
  const b = loanBook();
  assert.throws(() => homeLoan(b.db, { today: TODAY, extraMonth: -1 }), /extra/);
  assert.throws(() => homeLoan(b.db, { today: TODAY, extraMonth: 'abc' }), /extra/);
});
