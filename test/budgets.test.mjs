// (e) Budgets: monthly target per category, spent-to-date excluding transfers
// and (by default) business spend, rollover, the 90 percent and over events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { setBudget, deleteBudget, budgetProgress, budgetEvents, cycleBudgetProgress } from '../lib/budgets.mjs';
import { applyRules, setCategory, createRule } from '../lib/categorise.mjs';
import { matchTransfers } from '../lib/transfers.mjs';
import { currentCycle } from '../lib/cycles.mjs';
import { payBook, refreshMoney, setCat } from './fixtures/pay.mjs';

function groceries(b) {
  createRule(b.db, { field: 'description', match: 'contains', pattern: 'TEST GROCER', category_id: b.cat('Groceries') });
  return b.cat('Groceries');
}

test('spent is net of refunds and skips transfers, other months and business spend', () => {
  const b = book();
  const g = groceries(b);
  b.add('acct_t_everyday', '2026-10-02', -20000, 'TEST GROCER');
  b.add('acct_t_card', '2026-10-09', -15000, 'TEST GROCER');
  b.add('acct_t_card', '2026-10-10', 2500, 'TEST GROCER REFUND');
  b.add('acct_t_card', '2026-09-30', -99999, 'TEST GROCER'); // last month
  b.add('acct_t_biz', '2026-10-05', -40000, 'TEST GROCER'); // business account
  const personalOverride = b.add('acct_t_biz', '2026-10-06', -1000, 'TEST GROCER');
  const bizOverride = b.add('acct_t_everyday', '2026-10-07', -3000, 'TEST GROCER');
  b.db.prepare('UPDATE transactions SET is_business = 0 WHERE id = ?').run(personalOverride);
  b.db.prepare('UPDATE transactions SET is_business = 1 WHERE id = ?').run(bizOverride);
  // A transfer recategorised by hand into Groceries still does not count.
  const o = b.add('acct_t_everyday', '2026-10-11', -50000, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_OUT' });
  b.add('acct_t_savings', '2026-10-11', 50000, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_IN' });
  applyRules(b.db);
  matchTransfers(b.db);
  setCategory(b.db, o, { category_id: g });
  setBudget(b.db, g, { monthly_target: 50000 });
  const [row] = budgetProgress(b.db, '2026-10').items;
  assert.equal(row.category_id, g);
  assert.equal(row.name, 'Groceries');
  assert.equal(row.spent, 20000 + 15000 - 2500 + 1000);
  assert.equal(row.target, 50000);
  assert.equal(row.available, 50000);
  assert.equal(row.remaining, 50000 - 33500);
  assert.equal(row.pct, 67);
  const withBiz = budgetProgress(b.db, '2026-10', { includeBusiness: true }).items[0];
  assert.equal(withBiz.spent, 33500 + 40000 + 3000 - 1000 + 1000);
});

test('rollover carries last month\'s leftover (or overspend)', () => {
  const b = book();
  const g = groceries(b);
  setBudget(b.db, g, { monthly_target: 50000, rollover: true });
  b.db.prepare("UPDATE budgets SET created_at = '2026-08-03T00:00:00.000Z'").run();
  b.add('acct_t_everyday', '2026-08-10', -60000, 'TEST GROCER'); // over by 100
  b.add('acct_t_everyday', '2026-09-10', -30000, 'TEST GROCER'); // under by 200
  b.add('acct_t_everyday', '2026-10-10', -10000, 'TEST GROCER');
  applyRules(b.db);
  const [row] = budgetProgress(b.db, '2026-10').items;
  assert.equal(row.carried, -10000 + 20000);
  assert.equal(row.available, 60000);
  assert.equal(row.remaining, 50000);
  setBudget(b.db, g, { monthly_target: 50000, rollover: false });
  assert.equal(budgetProgress(b.db, '2026-10').items[0].carried, 0);
});

test('90 percent and over events per category per month', () => {
  const b = book();
  const g = groceries(b);
  setBudget(b.db, g, { monthly_target: 10000 });
  setBudget(b.db, b.cat('Fuel'), { monthly_target: 10000 });
  b.add('acct_t_everyday', '2026-10-02', -9200, 'TEST GROCER');
  applyRules(b.db);
  assert.deepEqual(budgetEvents(b.db, '2026-10').map((e) => [e.category_id, e.level]), [[g, 90]]);
  b.add('acct_t_everyday', '2026-10-03', -1000, 'TEST GROCER');
  applyRules(b.db);
  assert.deepEqual(budgetEvents(b.db, '2026-10').map((e) => e.level).sort(), [100, 90]);
  assert.deepEqual(budgetEvents(b.db, '2026-11'), []);
});

test('validation and delete', () => {
  const b = book();
  const g = b.cat('Groceries');
  assert.throws(() => setBudget(b.db, g, { monthly_target: -1 }), (e) => e.status === 400);
  assert.throws(() => setBudget(b.db, g, { monthly_target: 12.5 }), (e) => e.status === 400);
  assert.throws(() => setBudget(b.db, 99999, { monthly_target: 100 }), (e) => e.status === 404);
  assert.throws(() => setBudget(b.db, b.cat('Transfers'), { monthly_target: 100 }), (e) => e.status === 400);
  setBudget(b.db, g, { monthly_target: 100 });
  assert.equal(budgetProgress(b.db, '2026-10').items.length, 1);
  deleteBudget(b.db, g);
  assert.equal(budgetProgress(b.db, '2026-10').items.length, 0);
  assert.throws(() => deleteBudget(b.db, g), (e) => e.status === 404);
  assert.throws(() => budgetProgress(b.db, '2026-13'), (e) => e.status === 400);
});

// A refund (or a friend paying back a dinner) can offset spend in the same
// cycle, but a cycle's net spend never goes below zero for budget purposes.
const TODAY = '2026-10-17'; // current cycle 2026-10-07..2026-10-20, the one before 2026-09-23..2026-10-06

test('cycle: a category whose net spend is negative reads $0 spent and never more left than the budget', () => {
  const b = payBook();
  setCat(b, b.add('acct_t_card', '2026-10-09', 5700, 'TEST BISTRO PAYBACK', { provider_category: 'INCOME' }), 'Eating out');
  setCat(b, b.add('acct_t_card', '2026-10-10', -4000, 'TEST GROCER'), 'Groceries');
  refreshMoney(b);
  setBudget(b.db, b.cat('Eating out'), { cycle_target: 90000 });
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 30000 });
  const p = cycleBudgetProgress(b.db, currentCycle(b.db, { today: TODAY }), { today: TODAY });
  const eat = p.items.find((i) => i.name === 'Eating out');
  assert.equal(eat.spent, 0);
  assert.equal(eat.available, 90000);
  assert.equal(eat.remaining, 90000);
  assert.equal(eat.pct, 0);
  assert.equal(eat.over, false);
  assert.equal(eat.projected, 0);
  // Totals follow the clamped items, and the refund does not eat into other categories' spend.
  assert.equal(p.totals.spent, 4000);
  assert.equal(p.totals.flexible.spent, 4000);
  assert.equal(p.totals.flexible.projected, p.items.reduce((a, i) => a + i.projected, 0));
});

test('cycle: a refund still offsets spend inside the same cycle', () => {
  const b = payBook();
  setCat(b, b.add('acct_t_card', '2026-10-09', -8000, 'TEST BISTRO'), 'Eating out');
  setCat(b, b.add('acct_t_card', '2026-10-12', 3000, 'TEST BISTRO REFUND', { provider_category: 'INCOME' }), 'Eating out');
  refreshMoney(b);
  setBudget(b.db, b.cat('Eating out'), { cycle_target: 20000 });
  const [row] = cycleBudgetProgress(b.db, currentCycle(b.db, { today: TODAY }), { today: TODAY }).items;
  assert.equal(row.spent, 5000);
  assert.equal(row.remaining, 15000);
});

test('cycle rollover: a refund-heavy past cycle carries the whole target, not more', () => {
  const b = payBook();
  setCat(b, b.add('acct_t_card', '2026-09-25', 25000, 'TEST BIG REFUND', { provider_category: 'INCOME' }), 'Shopping');
  setCat(b, b.add('acct_t_card', '2026-10-09', -4000, 'TEST SHOP'), 'Shopping');
  refreshMoney(b);
  setBudget(b.db, b.cat('Shopping'), { cycle_target: 20000, rollover: true });
  b.db.prepare("UPDATE budgets SET created_at = '2026-09-24T00:00:00.000Z'").run();
  const [row] = cycleBudgetProgress(b.db, currentCycle(b.db, { today: TODAY }), { today: TODAY }).items;
  assert.equal(row.carried, 20000); // the previous cycle netted -$250, which counts as $0 spent
  assert.equal(row.available, 40000);
  assert.equal(row.spent, 4000);
  assert.equal(row.remaining, 36000);
  assert.ok(row.remaining <= row.available);
});

test('month roll-up: negative net spend clamps to zero, and so does a past month in the rollover', () => {
  const b = book();
  const g = groceries(b);
  setBudget(b.db, g, { monthly_target: 50000, rollover: true });
  b.db.prepare("UPDATE budgets SET created_at = '2026-09-03T00:00:00.000Z'").run();
  b.add('acct_t_everyday', '2026-09-10', 30000, 'TEST GROCER REFUND', { provider_category: 'INCOME' }); // September nets -$300
  b.add('acct_t_everyday', '2026-10-10', -10000, 'TEST GROCER');
  b.add('acct_t_everyday', '2026-11-05', 7000, 'TEST GROCER REFUND', { provider_category: 'INCOME' });
  applyRules(b.db);
  const oct = budgetProgress(b.db, '2026-10').items[0];
  assert.equal(oct.carried, 50000);
  assert.equal(oct.spent, 10000);
  const nov = budgetProgress(b.db, '2026-11').items[0];
  assert.equal(nov.spent, 0);
  assert.equal(nov.carried, 50000 + 40000);
  assert.equal(nov.remaining, nov.available);
  assert.equal(budgetProgress(b.db, '2026-11').totals.spent, 0);
});
