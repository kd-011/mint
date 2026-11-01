// v2 step 4: budgets run per pay cycle. Old monthly rows convert x 12/26,
// rollover carries per cycle, and starter budgets come from the median spend
// of the last six complete cycles, skipping one-offs and tiny categories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { payBook, refreshMoney, setCat, PAYDAYS } from './fixtures/pay.mjs';
import { monthsBack } from './fixtures/book.mjs';
import { setBudget, cycleBudgetProgress, budgetProgress, generateStarterBudgets } from '../lib/budgets.mjs';
import { currentCycle, listCycles } from '../lib/cycles.mjs';
import { createEngine } from '../lib/engine.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TODAY = '2026-10-17';
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('migration keeps monthly budgets and adds cycle_target = monthly x 12 / 26', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mint-mig-'));
  const path = join(dir, 'mint.db');
  // A v1 book: budgets table without the cycle columns.
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, grp TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'expense', color TEXT, sort INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE budgets (id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL UNIQUE REFERENCES categories(id) ON DELETE CASCADE,
      monthly_target INTEGER NOT NULL CHECK (typeof(monthly_target) = 'integer' AND monthly_target >= 0), rollover INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO categories (id, name) VALUES (1, 'Groceries'), (2, 'Fuel');
    INSERT INTO budgets (category_id, monthly_target, rollover, created_at, updated_at) VALUES (1, 65000, 1, 'x', 'x'), (2, 13000, 0, 'x', 'x');`);
  old.close();
  const db = openDb(path);
  const rows = db.prepare('SELECT category_id, monthly_target, cycle_target, rollover FROM budgets ORDER BY category_id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { category_id: 1, monthly_target: 65000, cycle_target: 30000, rollover: 1 },
    { category_id: 2, monthly_target: 13000, cycle_target: 6000, rollover: 0 },
  ]);
  db.close();
  const again = openDb(path); // idempotent
  assert.equal(again.prepare('SELECT cycle_target FROM budgets WHERE category_id = 1').get().cycle_target, 30000);
  again.close();
});

test('cycle budget: spent within the pay cycle, rollover per cycle, monthly roll-up kept', () => {
  const b = payBook();
  const groc = b.cat('Groceries');
  const spend = (date, amount) => setCat(b, b.add('acct_t_everyday', date, -amount, 'TEST GROCER'), 'Groceries');
  spend('2026-09-23', 20000);
  spend('2026-10-06', 5000); // last cycle
  spend('2026-10-07', 12000); // this cycle
  spend('2026-10-15', 3000);
  refreshMoney(b);
  setBudget(b.db, groc, { cycle_target: 30000, rollover: true });
  b.db.prepare("UPDATE budgets SET created_at = '2026-09-24T00:00:00.000Z'").run();
  const cycle = currentCycle(b.db, { today: TODAY });
  const p = cycleBudgetProgress(b.db, cycle, { today: TODAY });
  assert.equal(p.basis, 'cycle');
  assert.deepEqual([p.cycle.start, p.cycle.end], ['2026-10-07', '2026-10-20']);
  const [row] = p.items;
  assert.equal(row.target, 30000);
  assert.equal(row.spent, 15000);
  assert.equal(row.carried, 30000 - 25000);
  assert.equal(row.available, 35000);
  assert.equal(row.remaining, 20000);
  assert.equal(row.monthly_target, Math.round(30000 * 26 / 12));
  // The monthly roll-up for Reports still answers.
  const m = budgetProgress(b.db, '2026-10');
  assert.equal(m.items[0].target, Math.round(30000 * 26 / 12));
  // Setting a monthly target still works and converts.
  const r = setBudget(b.db, groc, { monthly_target: 65000 });
  assert.equal(r.cycle_target, 30000);
  assert.throws(() => setBudget(b.db, groc, {}), (e) => e.status === 400);
  assert.throws(() => setBudget(b.db, groc, { cycle_target: -5 }), (e) => e.status === 400);
});

function starterBook() {
  const b = payBook();
  const add = (start, offset, amount, desc, cat) => setCat(b, b.add('acct_t_card', addDays(start, offset), -amount, desc), cat);
  const groceries = [30000, 32000, 28000, 31000, 29500, 30500];
  const eating = [8000, 0, 12000, 9000, 0, 10000];
  PAYDAYS.slice(0, 6).forEach((start, i) => {
    add(start, 2, groceries[i], 'TEST GROCER', 'Groceries');
    if (eating[i]) add(start, 3, eating[i], 'TEST BISTRO', 'Eating out');
    add(start, 4, 300, 'TEST BANK FEE', 'Bank fees'); // tiny
    add(start, 5, 5000, 'TEST HARDWARE', 'Home and garden');
  });
  // The home build: huge one-off spends in three of the six cycles.
  add(PAYDAYS[1], 6, 1100000, 'TEST BUILDER PROGRESS CLAIM', 'Home and garden');
  add(PAYDAYS[2], 6, 1200000, 'TEST BUILDER PROGRESS CLAIM', 'Home and garden');
  add(PAYDAYS[3], 6, 1300000, 'TEST BUILDER PROGRESS CLAIM', 'Home and garden');
  // A one-off holiday.
  add(PAYDAYS[4], 1, 809274, 'TEST STAYS BOOKING', 'Travel');
  // A monthly subscription: a fixed category.
  for (let n = 4; n >= 0; n--) setCat(b, b.add('acct_t_card', monthsBack('2026-10-02', n), -1599, 'TESTFLIX'), 'Subscriptions');
  // Business spend never makes a budget.
  PAYDAYS.slice(0, 6).forEach((start) => b.add('acct_t_biz', addDays(start, 1), -90000, 'TEST SUPPLIER'));
  refreshMoney(b);
  return b;
}

test('starter budgets: median of the last six complete cycles, rounded up, one-offs and tiny spend skipped', () => {
  const b = starterBook();
  setBudget(b.db, b.cat('Fuel'), { cycle_target: 12345 }); // the owner's own budget is never touched
  const r = generateStarterBudgets(b.db, { today: TODAY });
  assert.equal(r.cycles_used, 6);
  const by = Object.fromEntries(r.created.map((c) => [c.name, c]));
  assert.equal(by.Groceries.cycle_target, 31000); // median 302.50, up to the next $10
  assert.equal(by['Eating out'].cycle_target, 9000); // median 85
  assert.equal(by['Home and garden'].cycle_target, 5000); // the build claims are skipped
  assert.equal(by.Groceries.fixed, false);
  assert.ok(by.Subscriptions, 'subscriptions budgeted');
  assert.equal(by.Subscriptions.fixed, true);
  assert.ok(!by.Travel, 'one-off holiday skipped');
  assert.ok(!by['Bank fees'], 'tiny spend skipped');
  assert.ok(!by.Fuel);
  assert.equal(b.db.prepare('SELECT cycle_target FROM budgets WHERE category_id = ?').get(b.cat('Fuel')).cycle_target, 12345);
  assert.equal(r.total_per_cycle, r.created.reduce((s, c) => s + c.cycle_target, 0));
  const row = b.db.prepare("SELECT source, fixed FROM budgets WHERE category_id = ?").get(b.cat('Groceries'));
  assert.deepEqual({ ...row }, { source: 'starter', fixed: 0 });
  // Run again: every category already has a budget, nothing is made.
  assert.equal(generateStarterBudgets(b.db, { today: TODAY, dryRun: true }).created.length, 0);
});

test('starter budgets run once from the engine when the budgets table is empty', () => {
  const b = starterBook();
  const engine = createEngine({ db: b.db, now: () => new Date('2026-10-17T02:00:00Z'), log: () => {} });
  engine.refresh();
  const n = b.db.prepare('SELECT count(*) n FROM budgets').get().n;
  assert.ok(n >= 4);
  b.db.prepare('DELETE FROM budgets WHERE category_id = ?').run(b.cat('Groceries'));
  engine.refresh();
  assert.equal(b.db.prepare('SELECT count(*) n FROM budgets').get().n, n - 1);
  assert.ok(listCycles(b.db, { today: TODAY }).length >= 7);
});

test('starter budgets wait for two complete cycles', () => {
  const b = payBook({ paydays: ['2026-10-07'] });
  refreshMoney(b);
  const r = generateStarterBudgets(b.db, { today: TODAY });
  assert.equal(r.created.length, 0);
  assert.match(r.reason, /cycles/);
});
