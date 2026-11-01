// v2 steps 5 and 6: the bills calendar and safe to spend. Safe to spend =
// expected cycle income - planned savings split - fixed bills due this cycle
// (paid or not) - flexible spend so far; per day = safe / days left. Plus a
// cash check: spendable balances less bills still due before payday.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, transfer, setCat, PAY_ACCOUNT } from './fixtures/pay.mjs';
import { monthsBack } from './fixtures/book.mjs';
import { billsCalendar } from '../lib/bills.mjs';
import { safeToSpend } from '../lib/safe.mjs';
import { setPlan } from '../lib/plan.mjs';

const TODAY = '2026-10-08';
const loanDetails = (next) => JSON.stringify({
  lending_rate: '0.0599',
  loan_details: { repayment_type: 'PRINCIPAL_AND_INTEREST', repayment_frequency: 'P1M', next_instalment_date: next, loan_end_date: '2056-07-29', offset_account_enabled: true },
});

function safeBook() {
  const b = payBook();
  for (const d of ['2026-09-11', '2026-09-25']) b.add('acct_t_offset', d, 188216, 'PAYMENT FROM TEST PARENT & CO', { provider_category: 'INCOME' });
  for (let n = 5; n >= 0; n--) b.add('acct_t_card', monthsBack('2026-09-15', n), -1599, 'TESTFLIX');
  for (let n = 5; n >= 0; n--) setCat(b, b.add(PAY_ACCOUNT, monthsBack('2026-10-07', n), -6500, 'TEST TELCO DD'), 'Phone and internet');
  for (let n = 5; n >= 1; n--) b.add('acct_t_card', monthsBack('2026-10-03', n), -1599, 'TESTMUSIC');
  b.add('acct_t_card', '2026-10-03', -1799, 'TESTMUSIC');
  transfer(b, PAY_ACCOUNT, 'acct_t_loan', '2026-08-29', 230000);
  transfer(b, PAY_ACCOUNT, 'acct_t_loan', '2026-09-29', 230000);
  b.db.prepare("UPDATE accounts SET details_json = ? WHERE id = 'acct_t_loan'").run(loanDetails('2026-10-29'));
  setCat(b, b.add('acct_t_card', '2026-10-07', -15000, 'TEST GROCER'), 'Groceries');
  setCat(b, b.add('acct_t_card', '2026-10-08', -5000, 'TEST BISTRO'), 'Eating out');
  b.add(PAY_ACCOUNT, '2026-10-08', 2000, 'ALEX SAMPLEPERSON lunch', { provider_category: 'INCOME' });
  b.add('acct_t_biz', '2026-10-08', -9000, 'TEST SUPPLIER');
  transfer(b, PAY_ACCOUNT, 'acct_t_savings', '2026-10-08', 50000);
  b.db.prepare("UPDATE accounts SET balance_current = 300000, balance_available = 300000 WHERE id = ?").run(PAY_ACCOUNT);
  refreshMoney(b, TODAY);
  setPlan(b.db, { lines: [
    { account_id: 'acct_t_savings', kind: 'saving', amount: 50000 },
    { account_id: 'acct_t_offset', kind: 'saving', percent: 10 },
  ] });
  return b;
}

const find = (items, merchant, date) => items.find((i) => i.merchant.toLowerCase().startsWith(merchant) && i.date === date);

test('bills calendar: six weeks of expected bills, paid vs to come this cycle, the loan instalment, price changes', () => {
  const b = safeBook();
  const cal = billsCalendar(b.db, { today: TODAY });
  assert.deepEqual([cal.from, cal.to], [TODAY, '2026-11-18']);
  assert.deepEqual([cal.cycle.start, cal.cycle.end], ['2026-10-07', '2026-10-20']);
  const flix = find(cal.items, 'testflix', '2026-10-15');
  assert.deepEqual([flix.status, flix.in_cycle, flix.amount], ['due', true, 1599]);
  const telco = find(cal.items, 'test telco', '2026-10-07');
  assert.deepEqual([telco.status, telco.in_cycle, telco.amount], ['paid', true, 6500]);
  assert.equal(find(cal.items, 'test telco', '2026-11-07').in_cycle, false);
  assert.ok(find(cal.items, 'testflix', '2026-11-15'));
  const loan = cal.items.find((i) => i.kind === 'loan');
  assert.deepEqual([loan.date, loan.amount, loan.status, loan.in_cycle], ['2026-10-29', 230000, 'due', false]);
  const music = find(cal.items, 'testmusic', '2026-11-03');
  assert.deepEqual(music.price_change, { from: 1599, to: 1799, date: '2026-10-03' });
  assert.deepEqual(cal.totals.in_cycle, { paid: 6500, due: 1599 });
  assert.equal(cal.card_statement, null);
  assert.ok(cal.items.every((i, k) => k === 0 || cal.items[k - 1].date <= i.date));
});

test('safe to spend: the arithmetic and the working', () => {
  const b = safeBook();
  const s = safeToSpend(b.db, { today: TODAY });
  assert.deepEqual([s.cycle.start, s.cycle.end, s.days_left], ['2026-10-07', '2026-10-20', 13]);
  assert.deepEqual(s.income, { salary: 226000, regular_received: 0, regular_expected: 188216, total: 414216 });
  assert.equal(s.savings_planned, 50000 + 22600);
  assert.equal(s.bills, 6500 + 1599);
  assert.equal(s.flexible_spent, 15000 + 5000 - 2000);
  assert.equal(s.safe, 414216 - 72600 - 8099 - 18000);
  assert.equal(s.per_day, Math.floor(315517 / 13));
  assert.ok(Array.isArray(s.breakdown) && s.breakdown.length >= 4);
  // A loan instalment inside the cycle is a fixed bill too.
  b.db.prepare("UPDATE accounts SET details_json = ? WHERE id = 'acct_t_loan'").run(loanDetails('2026-10-15'));
  assert.equal(safeToSpend(b.db, { today: TODAY }).safe, 315517 - 230000);
});

test('cash check: spendable balances less bills still due before payday', () => {
  const b = safeBook();
  const c = safeToSpend(b.db, { today: TODAY }).cash;
  assert.deepEqual(c.accounts.map((a) => a.id), [PAY_ACCOUNT]);
  assert.equal(c.spendable, 300000);
  assert.equal(c.bills_due, 1599);
  assert.equal(c.after_bills, 300000 - 1599);
  assert.equal(c.short, false);
  b.db.prepare("UPDATE accounts SET balance_available = 1000 WHERE id = ?").run(PAY_ACCOUNT);
  const low = safeToSpend(b.db, { today: TODAY }).cash;
  assert.equal(low.after_bills, -599);
  assert.equal(low.short, true);
  b.db.prepare("UPDATE accounts SET spendable = 1 WHERE id = 'acct_t_savings'").run();
  b.db.prepare("UPDATE accounts SET spendable = 0 WHERE id = ?").run(PAY_ACCOUNT);
  assert.deepEqual(safeToSpend(b.db, { today: TODAY }).cash.accounts.map((a) => a.id), ['acct_t_savings']);
});

test('no pay cycle yet: safe to spend says so instead of guessing', () => {
  const b = payBook({ paydays: [] });
  refreshMoney(b, TODAY);
  const s = safeToSpend(b.db, { today: TODAY });
  assert.equal(s.cycle, null);
  assert.equal(s.safe, null);
  assert.match(s.reason, /salary/i);
});

test('business recurring charges are not personal bills', () => {
  const b = safeBook();
  for (let n = 5; n >= 0; n--) b.add('acct_t_biz', monthsBack('2026-09-12', n), -9900, 'TEST BIZ SAAS');
  refreshMoney(b, TODAY);
  const cal = billsCalendar(b.db, { today: TODAY });
  assert.ok(!cal.items.some((i) => /biz saas/i.test(i.merchant)));
  assert.equal(safeToSpend(b.db, { today: TODAY }).safe, 315517);
});
