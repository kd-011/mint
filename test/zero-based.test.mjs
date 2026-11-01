// Zero-based budgeting: every dollar of the pay cycle's income is given a job.
// Ready to assign = income - set aside (saving and debt lines of the pay split)
// - assigned (category targets) - last cycle's uncovered overspend. It reads
// zero when every dollar has a job. Nothing is stored for it: it is worked out
// from the budgets, the income and the pay split that are already there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, setCat, PAYDAYS } from './fixtures/pay.mjs';
import { setBudget, cycleBudgetProgress, zeroBased } from '../lib/budgets.mjs';
import { currentCycle, listCycles } from '../lib/cycles.mjs';
import { setPlan } from '../lib/plan.mjs';

const TODAY = '2026-10-17';
const item = (o = {}) => { const i = { category_id: 1, name: 'Groceries', target: 0, available: 0, spent: 0, fixed: false, rollover: false, source: 'manual', created_at: '2026-01-01T00:00:00.000Z', ...o }; return { ...i, over: i.spent > i.available }; };

test('zeroBased: ready is income minus set aside minus assigned, signed, with a state', () => {
  const items = [item({ target: 100000 }), item({ category_id: 2, name: 'Fuel', target: 50000 })];
  const z = zeroBased({ income: 226000, setAside: 40000, items, carried: [] });
  assert.equal(z.assigned, 150000);
  assert.equal(z.ready, 36000);
  assert.equal(z.state, 'unassigned');
  const zero = zeroBased({ income: 226000, setAside: 40000, items: [...items, item({ category_id: 3, name: 'Fun', target: 36000 })], carried: [] });
  assert.equal(zero.ready, 0);
  assert.equal(zero.state, 'zero');
  const over = zeroBased({ income: 226000, setAside: 40000, items: [...items, item({ category_id: 3, name: 'Fun', target: 40000 })], carried: [] });
  assert.equal(over.ready, -4000);
  assert.equal(over.state, 'over_assigned');
});

test('zeroBased: last cycle\'s uncovered overspend comes out of ready to assign', () => {
  const carried = [{ category_id: 1, name: 'Groceries', amount: 8000 }, { category_id: 2, name: 'Fuel', amount: 2500 }];
  const z = zeroBased({ income: 100000, setAside: 0, items: [item({ target: 90000 })], carried });
  assert.equal(z.carried_overspend.total, 10500);
  assert.equal(z.ready, 100000 - 90000 - 10500);
  assert.equal(z.state, 'over_assigned');
});

test('zeroBased: overspent lists flexible categories only, biggest first', () => {
  const items = [
    item({ target: 10000, available: 10000, spent: 12500 }),
    item({ category_id: 2, name: 'Fuel', target: 5000, available: 5000, spent: 9000 }),
    item({ category_id: 3, name: 'Rent', target: 5000, available: 5000, spent: 70000, fixed: true }),
    item({ category_id: 4, name: 'Fun', target: 5000, available: 5000, spent: 5000 }),
  ];
  const z = zeroBased({ income: 0, setAside: 0, items, carried: [] });
  assert.deepEqual(z.overspent.items.map((i) => [i.name, i.amount]), [['Fuel', 4000], ['Groceries', 2500]]);
  assert.equal(z.overspent.total, 6500);
  assert.equal(z.overspent.count, 2);
});

test('cycle budgets carry a zero_based block: assigning the whole pay takes ready to zero', () => {
  const b = payBook();
  refreshMoney(b);
  const cycle = currentCycle(b.db, { today: TODAY });
  const before = cycleBudgetProgress(b.db, cycle, { today: TODAY });
  assert.equal(before.items.length, 0);
  assert.equal(before.zero_based.assigned, 0);
  assert.equal(before.zero_based.income, 226000); // the salary that opened the cycle
  assert.equal(before.zero_based.ready, 226000);
  assert.equal(before.zero_based.state, 'unassigned');

  setBudget(b.db, b.cat('Groceries'), { cycle_target: 90000 });
  setBudget(b.db, b.cat('Rent'), { cycle_target: 100000, fixed: true });
  const half = cycleBudgetProgress(b.db, cycle, { today: TODAY }).zero_based;
  assert.equal(half.assigned, 190000);
  assert.equal(half.ready, 36000);

  setBudget(b.db, b.cat('Fuel'), { cycle_target: 36000 });
  const done = cycleBudgetProgress(b.db, cycle, { today: TODAY }).zero_based;
  assert.equal(done.ready, 0);
  assert.equal(done.state, 'zero');
});

test('the pay split\'s saving and debt lines are set aside before categories are assigned', () => {
  const b = payBook();
  refreshMoney(b);
  setPlan(b.db, { lines: [
    { account_id: 'acct_t_savings', kind: 'saving', amount: 30000 },
    { account_id: 'acct_t_offset', kind: 'spending', amount: 100000 }, // spending is the categories' own money, not set aside
  ] });
  const cycle = currentCycle(b.db, { today: TODAY });
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 96000 });
  const z = cycleBudgetProgress(b.db, cycle, { today: TODAY }).zero_based;
  assert.equal(z.set_aside, 30000);
  assert.equal(z.ready, 226000 - 30000 - 96000);
});

test('last cycle\'s overspend lowers this cycle\'s ready to assign; rollover and fixed budgets do not double count', () => {
  const b = payBook();
  const groc = b.cat('Groceries');
  setCat(b, b.add('acct_t_card', '2026-09-30', -50000, 'TEST GROCER'), 'Groceries'); // prior cycle 09-23..10-06, budget 40000
  setCat(b, b.add('acct_t_card', '2026-10-01', -30000, 'TEST FUEL'), 'Fuel'); // rollover: carried in available already
  setCat(b, b.add('acct_t_card', '2026-10-02', -90000, 'TEST LANDLORD'), 'Rent'); // fixed: the instalment cycle reads over, not overspend
  refreshMoney(b);
  setBudget(b.db, groc, { cycle_target: 40000 });
  setBudget(b.db, b.cat('Fuel'), { cycle_target: 10000, rollover: true });
  setBudget(b.db, b.cat('Rent'), { cycle_target: 40000, fixed: true });
  b.db.prepare("UPDATE budgets SET created_at = '2026-09-01T00:00:00.000Z'").run();
  const cycles = listCycles(b.db, { today: TODAY });
  const cycle = cycles.at(-1);
  const z = cycleBudgetProgress(b.db, cycle, { today: TODAY }).zero_based;
  assert.deepEqual(z.carried_overspend.items.map((i) => [i.name, i.amount]), [['Groceries', 10000]]);
  assert.equal(z.carried_overspend.total, 10000);
  assert.equal(z.ready, 226000 - 90000 - 10000);
  // The first cycle has nothing before it.
  assert.equal(cycleBudgetProgress(b.db, cycles[0], { today: TODAY }).zero_based.carried_overspend.total, 0);
});

test('a starter budget made during last cycle does not charge that cycle\'s overspend', () => {
  const b = payBook();
  setCat(b, b.add('acct_t_card', '2026-09-30', -50000, 'TEST GROCER'), 'Groceries');
  refreshMoney(b);
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 40000 }, { source: 'starter' });
  b.db.prepare("UPDATE budgets SET created_at = '2026-09-28T00:00:00.000Z'").run();
  const z = cycleBudgetProgress(b.db, currentCycle(b.db, { today: TODAY }), { today: TODAY }).zero_based;
  assert.equal(z.carried_overspend.total, 0);
});

test('existing totals and items are unchanged by the zero-based block', () => {
  const b = payBook();
  refreshMoney(b);
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 30000 });
  const p = cycleBudgetProgress(b.db, currentCycle(b.db, { today: TODAY }), { today: TODAY });
  assert.equal(p.totals.target, 30000);
  assert.equal(p.items[0].target, 30000);
  assert.ok(PAYDAYS.length);
});

test('a budget set after last cycle ended does not charge last cycle\'s spending, whatever its source', () => {
  const b = payBook();
  setCat(b, b.add('acct_t_card', '2026-09-30', -50000, 'TEST GROCER'), 'Groceries');
  refreshMoney(b);
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 40000 }); // manual, made today, after the 09-23..10-06 cycle closed
  b.db.prepare("UPDATE budgets SET created_at = '2026-10-10T00:00:00.000Z'").run();
  const z = cycleBudgetProgress(b.db, currentCycle(b.db, { today: TODAY }), { today: TODAY }).zero_based;
  assert.equal(z.carried_overspend.total, 0);
  assert.equal(z.ready, 226000 - 40000);
});

test('a loan budget and a pay-split debt line to the same loan are one job, not two', () => {
  const b = payBook();
  refreshMoney(b);
  setPlan(b.db, { lines: [{ account_id: 'acct_t_loan', kind: 'debt', amount: 188200 }] });
  const cycle = currentCycle(b.db, { today: TODAY });
  const run = () => cycleBudgetProgress(b.db, cycle, { today: TODAY }).zero_based;
  assert.equal(run().ready, 226000 - 188200); // the split line alone
  setBudget(b.db, b.cat('Home loan'), { cycle_target: 188200, fixed: true });
  const z = run();
  assert.equal(z.ready, 226000 - 188200); // not 226000 - 376400
  assert.equal(z.assigned, 188200);
  assert.equal(z.set_aside, 0);
  assert.equal(z.split_in_budgets, 188200);
  // The larger of the two counts: a budget above the split line adds only itself, a split line above the budget adds the difference.
  setBudget(b.db, b.cat('Home loan'), { cycle_target: 200000, fixed: true });
  assert.equal(run().ready, 226000 - 200000);
  setBudget(b.db, b.cat('Home loan'), { cycle_target: 150000, fixed: true });
  assert.equal(run().ready, 226000 - 188200);
  // A split line to a card is not a loan budget: it still comes off on its own.
  setPlan(b.db, { lines: [{ account_id: 'acct_t_card', kind: 'debt', amount: 30000 }] });
  assert.equal(run().ready, 226000 - 30000 - 150000);
});
