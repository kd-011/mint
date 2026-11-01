// A fixed budget (the Home loan line, rent) is a monthly bill scaled to a
// 14-day cycle, so the cycle that holds the one instalment always reads over.
// That is scaling noise, not overspend: fixed budgets raise no over, 90 percent
// or pace alert on the cycle basis. Flexible categories alert exactly as before.
// A credit on a loan account only counts as a repayment when it looks like one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, setCat } from './fixtures/pay.mjs';
import { setBudget, toCycle, cycleBudgetEvents, cycleBudgetProgress } from '../lib/budgets.mjs';
import { currentCycle } from '../lib/cycles.mjs';
import { runAlerts, weeklySummary } from '../lib/alerts.mjs';

const TODAY = '2026-10-17';
const REPAID_OCT = 188216; // $1,882.16, lands once a month
const EVERYDAY = 'acct_t_everyday';
const LOAN = 'acct_t_loan';
const at = (d) => new Date(`${d}T02:00:00Z`);

function book() {
  const b = payBook();
  b.db.prepare("UPDATE accounts SET last_synced_at = '2026-11-30T00:00:00.000Z'").run();
  setCat(b, b.add(LOAN, '2026-07-28', -35099895, 'LOAN DRAWDOWN', { provider_category: null }), 'Loan drawdown');
  b.add(EVERYDAY, '2026-10-14', -REPAID_OCT, 'Anz M-Banking', { provider_category: 'TRANSFER_OUT' });
  b.add(LOAN, '2026-10-14', REPAID_OCT, 'Anz M-Banking', { provider_category: 'TRANSFER_IN' });
  setBudget(b.db, b.cat('Home loan'), { cycle_target: toCycle(REPAID_OCT), fixed: true });
  refreshMoney(b, TODAY);
  return b;
}
const cycleNow = (b) => currentCycle(b.db, { today: TODAY });
const budgetAlerts = (b) => runAlerts(b.db, { now: at(TODAY) }).filter((a) => a.kind === 'budget');

test('the loan really is over its cycle target (the noise this guards against)', () => {
  const b = book();
  const loan = cycleBudgetProgress(b.db, cycleNow(b), { today: TODAY }).items.find((i) => i.name === 'Home loan');
  assert.equal(loan.spent, REPAID_OCT);
  assert.equal(loan.over, true);
});

test('a fixed loan budget with one instalment raises no over-budget event or alert', () => {
  const b = book();
  assert.deepEqual(cycleBudgetEvents(b.db, cycleNow(b), { today: TODAY }), []);
  assert.deepEqual(budgetAlerts(b), []);
});

test('a flexible category over its target still alerts, beside a quiet fixed loan', () => {
  const b = book();
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 20000 });
  setCat(b, b.add('acct_t_card', '2026-10-10', -25000, 'TEST GROCER'), 'Groceries');
  refreshMoney(b, TODAY);
  const ev = cycleBudgetEvents(b.db, cycleNow(b), { today: TODAY });
  assert.deepEqual(ev.map((e) => [e.name, e.level]).sort(), [['Groceries', 100], ['Groceries', 90]]);
  const a = budgetAlerts(b);
  assert.deepEqual(a.map((x) => x.type).sort(), ['90', 'over']);
  assert.ok(a.every((x) => /Groceries/.test(x.title)));
});

test('the weekly summary does not list a fixed budget as over, but lists a flexible one', () => {
  const b = book();
  assert.doesNotMatch(weeklySummary(b.db, TODAY), /Over budget/);
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 20000 });
  setCat(b, b.add('acct_t_card', '2026-10-10', -25000, 'TEST GROCER'), 'Groceries');
  refreshMoney(b, TODAY);
  const line = weeklySummary(b.db, TODAY);
  assert.match(line, /Over budget this pay cycle: Groceries\./);
  assert.doesNotMatch(line, /Home loan/);
});

test('a credit on the loan that is a reversal or refund is not a repayment', () => {
  const b = book();
  b.add(LOAN, '2026-10-15', 3100, 'INTEREST REVERSAL', { provider_category: null });
  b.add(LOAN, '2026-10-16', 2000, 'Account fee refund', { provider_category: null });
  refreshMoney(b, TODAY);
  const loan = cycleBudgetProgress(b.db, cycleNow(b), { today: TODAY }).items.find((i) => i.name === 'Home loan');
  assert.equal(loan.spent, REPAID_OCT);
});
