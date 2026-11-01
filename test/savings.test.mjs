// Save and Invest, section one: savings and offset accounts, interest credited
// (credits categorised Interest on those accounts, not the offset's benefit),
// and the savings rate (net saved over income, transfers excluded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, transfer, setCat, PAY_ACCOUNT } from './fixtures/pay.mjs';
import { savingsOverview, savingsAccounts } from '../lib/savings.mjs';

const TODAY = '2026-10-17';

function savingsBook() {
  const b = payBook();
  // Spend, a month at a time (invented).
  b.add(PAY_ACCOUNT, '2026-07-20', -40000, 'TEST GROCER TESTVILLE');
  b.add(PAY_ACCOUNT, '2026-08-20', -60000, 'TEST GROCER TESTVILLE');
  b.add(PAY_ACCOUNT, '2026-09-20', -100000, 'TEST GROCER TESTVILLE');
  b.add(PAY_ACCOUNT, '2026-10-10', -50000, 'TEST GROCER TESTVILLE');
  // Money moved to savings is not spend.
  transfer(b, PAY_ACCOUNT, 'acct_t_savings', '2026-09-24', 30000);
  // Interest: this month, last month, last financial year, wrong account, wrong category, a debit.
  setCat(b, b.add('acct_t_savings', '2026-10-01', 1234, 'INTEREST PAID', { provider_category: 'INTEREST' }), 'Interest');
  setCat(b, b.add('acct_t_savings', '2026-09-30', 1000, 'INTEREST PAID', { provider_category: 'INTEREST' }), 'Interest');
  setCat(b, b.add('acct_t_savings', '2026-06-30', 999, 'INTEREST PAID', { provider_category: 'INTEREST' }), 'Interest');
  setCat(b, b.add('acct_t_offset', '2026-10-02', 50, 'INTEREST PAID', { provider_category: 'INTEREST' }), 'Interest');
  setCat(b, b.add(PAY_ACCOUNT, '2026-10-03', 777, 'INTEREST PAID', { provider_category: 'INTEREST' }), 'Interest');
  setCat(b, b.add('acct_t_savings', '2026-10-04', 5000, 'GIFT FROM NAN', { provider_category: 'INCOME' }), 'Other income');
  setCat(b, b.add('acct_t_savings', '2026-06-15', -300, 'ACCOUNT FEE', { provider_category: 'BANK_FEES' }), 'Interest charged');
  refreshMoney(b, TODAY);
  return b;
}

test('savings accounts are the savings and offset accounts: not spending, cards, loans or business', () => {
  const b = savingsBook();
  const a = savingsAccounts(b.db);
  assert.deepEqual(a.map((x) => x.id), ['acct_t_savings', 'acct_t_offset']);
  assert.deepEqual(a.map((x) => x.role), ['savings', 'offset']);
  assert.deepEqual(a.map((x) => x.balance), [500000, 2500000]);
});

test('an account the owner marked spendable is not a savings account, one marked not spendable is', () => {
  const b = savingsBook();
  b.db.prepare("UPDATE accounts SET spendable = 1 WHERE id = 'acct_t_savings'").run();
  b.db.prepare("UPDATE accounts SET spendable = 0 WHERE id = 'acct_t_everyday'").run();
  const ids = savingsAccounts(b.db).map((x) => x.id);
  assert.ok(!ids.includes('acct_t_savings'));
  assert.ok(ids.includes('acct_t_everyday'));
});

test('hidden and gone accounts are left out', () => {
  const b = savingsBook();
  b.db.prepare("UPDATE accounts SET hidden = 1 WHERE id = 'acct_t_savings'").run();
  b.db.prepare("UPDATE accounts SET status = 'gone' WHERE id = 'acct_t_offset'").run();
  assert.deepEqual(savingsAccounts(b.db), []);
});

test('interest this month and this financial year: Interest credits on those accounts only', () => {
  const b = savingsBook();
  const s = savingsOverview(b.db, { today: TODAY });
  const by = Object.fromEntries(s.accounts.map((a) => [a.id, a]));
  assert.deepEqual(by.acct_t_savings.interest, { month: 1234, fy: 2234 });
  assert.deepEqual(by.acct_t_offset.interest, { month: 50, fy: 50 });
  assert.deepEqual(s.interest, { month: 1284, fy: 2284, fy_label: 'FY2027', fy_from: '2026-07-01' });
  assert.equal(s.total_balance, 3000000);
});

test('the financial year turns over on 1 July', () => {
  const b = savingsBook();
  const s = savingsOverview(b.db, { today: '2026-06-30' });
  assert.equal(s.interest.fy_label, 'FY2026');
  assert.equal(s.interest.fy, 999);
});

test('savings rate: this month so far and the three complete months before it, transfers excluded', () => {
  const b = savingsBook();
  const r = savingsOverview(b.db, { today: TODAY }).savings_rate;
  assert.equal(r.this_month.month, '2026-10');
  assert.deepEqual([r.this_month.income, r.this_month.spent, r.this_month.net], [226000, 50000, 176000]);
  assert.equal(r.this_month.rate, 0.7788);
  assert.deepEqual([r.trailing_3.from, r.trailing_3.to], ['2026-07', '2026-09']);
  assert.deepEqual([r.trailing_3.income, r.trailing_3.spent, r.trailing_3.net], [1425000, 200000, 1225000]);
  assert.equal(r.trailing_3.rate, 0.8596);
  assert.equal(r.months.length, 4);
});

test('savings rate is null with no income, and negative when spending beat income', () => {
  const b = payBook({ paydays: ['2026-09-09'], amounts: [100000] });
  b.add(PAY_ACCOUNT, '2026-09-12', -150000, 'TEST GROCER TESTVILLE');
  refreshMoney(b, TODAY);
  const r = savingsOverview(b.db, { today: TODAY }).savings_rate;
  assert.equal(r.this_month.rate, null);
  assert.equal(r.this_month.net, 0);
  assert.equal(r.trailing_3.rate, -0.5);
});

test('balance history sums the savings accounts, each carried forward from its last snapshot', () => {
  const b = savingsBook();
  const ins = b.db.prepare('INSERT INTO balance_snapshots (account_id, date, current) VALUES (?, ?, ?)');
  ins.run('acct_t_savings', '2026-10-01', 400000);
  ins.run('acct_t_offset', '2026-10-03', 2000000);
  ins.run('acct_t_savings', '2026-10-10', 500000);
  ins.run(PAY_ACCOUNT, '2026-10-10', 99999);
  const h = savingsOverview(b.db, { today: TODAY }).history;
  assert.deepEqual(h, [['2026-10-01', 400000], ['2026-10-03', 2400000], ['2026-10-10', 2500000]]);
});
