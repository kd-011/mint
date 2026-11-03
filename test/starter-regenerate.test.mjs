// v2 screens: "regenerate from history" on Budgets. It re-runs the starter
// maths over budgets Mint made itself (source 'starter'), never over one the owner
// set by hand, and hands back what it replaced so the screen can offer undo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payBook, refreshMoney, setCat, PAYDAYS } from './fixtures/pay.mjs';
import { setBudget, generateStarterBudgets } from '../lib/budgets.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';

const TODAY = '2026-10-17';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function book() {
  const b = payBook();
  const add = (start, offset, amount, desc, cat) => setCat(b, b.add('acct_t_card', addDays(start, offset), -amount, desc), cat);
  PAYDAYS.slice(0, 6).forEach((start) => {
    add(start, 2, 30000, 'TEST GROCER', 'Groceries');
    add(start, 3, 9000, 'TEST BISTRO', 'Eating out');
    add(start, 5, 5000, 'TEST HARDWARE', 'Home and garden');
  });
  refreshMoney(b);
  return b;
}
const row = (b, name) => ({ ...b.db.prepare('SELECT cycle_target, fixed, rollover, source FROM budgets WHERE category_id = ?').get(b.cat(name)) });

test('regenerate replaces starter budgets with the fresh maths and reports what each one was', () => {
  const b = book();
  generateStarterBudgets(b.db, { today: TODAY });
  // The owner nudges one starter number; it is still source starter until the screen says otherwise.
  b.db.prepare('UPDATE budgets SET cycle_target = 99000, rollover = 1 WHERE category_id = ?').run(b.cat('Groceries'));
  const r = generateStarterBudgets(b.db, { today: TODAY, replace: 'starter' });
  const by = Object.fromEntries(r.created.map((c) => [c.name, c]));
  assert.equal(by.Groceries.cycle_target, 30000);
  assert.deepEqual(by.Groceries.before, { cycle_target: 99000, fixed: false, rollover: true, source: 'starter' });
  assert.equal(row(b, 'Groceries').cycle_target, 30000);
  assert.equal(row(b, 'Groceries').rollover, 1, 'rollover is the owner\'s choice and survives');
});

test('regenerate never touches a budget the owner set by hand, and says so', () => {
  const b = book();
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 12345 }); // manual
  const r = generateStarterBudgets(b.db, { today: TODAY, replace: 'starter' });
  assert.equal(row(b, 'Groceries').cycle_target, 12345);
  assert.equal(row(b, 'Groceries').source, 'manual');
  assert.ok(!r.created.some((c) => c.name === 'Groceries'));
  assert.ok(r.skipped.some((c) => c.name === 'Groceries' && /hand|already/.test(c.reason)));
});

test('a category with no budget yet is created with before null, so undo deletes it', () => {
  const b = book();
  const r = generateStarterBudgets(b.db, { today: TODAY, replace: 'starter' });
  assert.ok(r.created.length >= 3);
  assert.ok(r.created.every((c) => c.before === null));
});

test('dry run with replace writes nothing', () => {
  const b = book();
  generateStarterBudgets(b.db, { today: TODAY });
  b.db.prepare('UPDATE budgets SET cycle_target = 77000 WHERE category_id = ?').run(b.cat('Groceries'));
  const r = generateStarterBudgets(b.db, { today: TODAY, replace: 'starter', dryRun: true });
  assert.equal(r.created.find((c) => c.name === 'Groceries').cycle_target, 30000);
  assert.equal(row(b, 'Groceries').cycle_target, 77000);
});

test('without replace the old rule holds: a category with a budget is skipped', () => {
  const b = book();
  generateStarterBudgets(b.db, { today: TODAY });
  const r = generateStarterBudgets(b.db, { today: TODAY });
  assert.equal(r.created.length, 0);
});

// over HTTP: regenerate and the undo restore both go through the API

let proc, base, home;
before(async () => {
  home = mkdtempSync(join(tmpdir(), 'mint-regen-'));
  const b = book();
  b.db.exec(`VACUUM INTO '${join(home, 'seed.db').replace(/'/g, "''")}'`);
  b.db.close();
  const { mkdirSync, renameSync } = await import('node:fs');
  mkdirSync(join(home, 'data'), { recursive: true });
  renameSync(join(home, 'seed.db'), join(home, 'data', 'mint.db'));
  proc = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
      env: { PATH: process.env.PATH, MINT_HOME: home, MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner', REDBARK_API_KEY: 'k', REDBARK_API_BASE: 'http://127.0.0.1:1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) { base = `http://127.0.0.1:${m[1]}`; resolve(p); } });
    p.stderr.on('data', (d) => { out += d; });
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
});
after(() => proc?.kill('SIGTERM'));

const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY, 'content-type': 'application/json' };
const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: H, body: body == null ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

test('POST /api/budgets/starter {replace} then PUT {source} puts a budget back exactly', async () => {
  const cats = (await call('GET', '/api/categories')).body.items;
  const groc = cats.find((c) => c.name === 'Groceries').id;
  // The engine made starter budgets on boot (the book has history and no budgets).
  const before = (await call('GET', '/api/budgets')).body.items.find((i) => i.category_id === groc);
  assert.equal(before.source, 'starter');
  await call('PUT', `/api/budgets/${groc}`, { cycle_target: 88000, source: 'starter' });
  const preview = await call('POST', '/api/budgets/starter', { dry_run: true, replace: 'starter' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.created.find((c) => c.name === 'Groceries').before.cycle_target, 88000);
  const done = await call('POST', '/api/budgets/starter', { replace: 'starter' });
  const g = done.body.created.find((c) => c.name === 'Groceries');
  assert.equal(g.cycle_target, 30000);
  // Undo: PUT the old values back, source included.
  const undo = await call('PUT', `/api/budgets/${groc}`, { cycle_target: g.before.cycle_target, fixed: g.before.fixed, rollover: g.before.rollover, source: g.before.source });
  assert.equal(undo.body.cycle_target, 88000);
  assert.equal(undo.body.source, 'starter');
  assert.equal((await call('PUT', `/api/budgets/${groc}`, { cycle_target: 1, source: 'nonsense' })).status, 400);
});

// cycle budgets list the spending that has no budget yet

test('cycle budgets carry unbudgeted spending, biggest first, for the "no budget yet" list', async () => {
  const { cycleBudgetProgress } = await import('../lib/budgets.mjs');
  const { currentCycle } = await import('../lib/cycles.mjs');
  const b = book();
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 30000 });
  setCat(b, b.add('acct_t_card', '2026-10-09', -4200, 'TEST HARDWARE'), 'Home and garden');
  setCat(b, b.add('acct_t_card', '2026-10-10', -9100, 'TEST BISTRO'), 'Eating out');
  refreshMoney(b);
  const p = cycleBudgetProgress(b.db, currentCycle(b.db, { today: TODAY }), { today: TODAY });
  assert.deepEqual(p.unbudgeted.map((u) => u.name), ['Eating out', 'Home and garden']);
  assert.equal(p.unbudgeted[0].spent, 9100);
  assert.ok(!p.unbudgeted.some((u) => u.name === 'Groceries'));
});
