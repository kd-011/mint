// Tapping a budget lists the transactions behind it: GET /api/budgets/:categoryId/transactions
// by pay cycle (?cycle=YYYY-MM-DD) or calendar month (?month=YYYY-MM). The listed rows
// must add up to the budget's spent figure, so refunds and reimbursements are netted,
// linked transfer legs and business spend are left out, exactly as the budget maths does.
// The real handler over an in-memory book with invented data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payBook, refreshMoney, setCat } from './fixtures/pay.mjs';
import { createApi } from '../lib/api.mjs';
import { HttpError } from '../lib/errors.mjs';
import { setBudget } from '../lib/budgets.mjs';
import { zoneDate, addDays } from '../lib/dates.mjs';

const T = zoneDate();
const PAYDAYS = [-64, -50, -36, -22, -8].map((n) => addDays(T, n));
let srv, base, b, groc, fuel;

before(async () => {
  b = payBook({ paydays: PAYDAYS });
  groc = b.cat('Groceries');
  fuel = b.cat('Fuel');
  const spend = (acct, date, amount, name, cat) => setCat(b, b.add(acct, date, amount, name), cat);
  spend('acct_t_everyday', addDays(T, -12), -7000, 'TEST GROCER OLD', 'Groceries'); // last cycle
  spend('acct_t_everyday', addDays(T, -7), -8000, 'TEST GROCER ONE', 'Groceries');
  spend('acct_t_card', addDays(T, -5), -4000, 'TEST GROCER TWO', 'Groceries');
  spend('acct_t_card', addDays(T, -4), 1500, 'TEST GROCER REFUND', 'Groceries');
  spend('acct_t_everyday', T, -1234, 'TEST GROCER TODAY', 'Groceries');
  spend('acct_t_biz', addDays(T, -6), -9000, 'TEST BIZ GROCER', 'Groceries'); // business account
  spend('acct_t_everyday', addDays(T, -3), -2500, 'TEST SERVO', 'Fuel');
  const leg = b.add('acct_t_savings', addDays(T, -5), 30000, 'FROM EVERYDAY', { provider_category: 'TRANSFER_IN' });
  b.add('acct_t_everyday', addDays(T, -5), -30000, 'TO SAVINGS', { provider_category: 'TRANSFER_OUT' });
  const reimb = b.add('acct_t_everyday', addDays(T, -3), 2000, 'FRIEND PAYS BACK', { provider_category: 'INCOME' });
  refreshMoney(b, T);
  // A linked transfer leg a rule filed under Groceries still never counts.
  b.db.prepare("UPDATE transactions SET category_id = ?, category_source = 'rule' WHERE id = ?").run(groc, leg);
  b.db.prepare("UPDATE transactions SET income_kind = 'reimbursement', offset_category_id = ?, income_manual = 1 WHERE id = ?").run(groc, reimb);
  setBudget(b.db, groc, { cycle_target: 40000 });
  const api = createApi({ db: b.db, engine: { refresh() {}, runAi() {} }, ai: null, dataDir: mkdtempSync(join(tmpdir(), 'mint-bd-')), log() {} });
  srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!(await api(req, res, url))) { res.writeHead(404); res.end('{}'); }
    } catch (e) {
      res.writeHead(e instanceof HttpError ? e.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv?.close());

const get = (p) => fetch(base + p);
const json = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };
const sum = (items) => items.reduce((s, t) => s - t.amount, 0);
const names = (items) => items.map((t) => t.merchant);

test('a cycle: the listed rows add up to the budget spent figure', async () => {
  const cycles = (await json(await get('/api/cycles'))).items;
  const cur = cycles.at(-1);
  const d = await json(await get(`/api/budgets/${groc}/transactions?cycle=${cur.start}`));
  const list = (await json(await get(`/api/budgets?cycle=${cur.start}`))).items.find((i) => i.category_id === groc);
  assert.equal(d.basis, 'cycle');
  assert.equal(d.category.name, 'Groceries');
  assert.deepEqual([d.from, d.to], [cur.start, cur.end]);
  assert.equal(d.cycle.start, cur.start);
  // 80.00 + 40.00 + 12.34 spent, 15.00 refunded, 20.00 reimbursed.
  assert.equal(sum(d.items), 8000 + 4000 + 1234 - 1500 - 2000);
  assert.equal(d.net, sum(d.items));
  assert.equal(d.budget.spent, list.spent);
  assert.equal(d.spent, list.spent);
  assert.equal(sum(d.items), list.spent);
  assert.equal(d.count, d.items.length);
  assert.equal(d.truncated, false);
});

test('refunds and reimbursements are listed and netted; transfers, business and other cycles are not', async () => {
  const cur = (await json(await get('/api/cycles'))).items.at(-1);
  const d = await json(await get(`/api/budgets/${groc}/transactions?cycle=${cur.start}`));
  assert.deepEqual(names(d.items).sort(), ['Test Grocer One', 'Test Grocer Refund', 'Test Grocer Today', 'Test Grocer Two', 'Friend Pays Back'].sort());
  assert.ok(d.items.find((t) => t.merchant === 'Friend Pays Back').income_kind === 'reimbursement');
  assert.ok(!names(d.items).includes('Test Grocer Old'));
  assert.ok(!names(d.items).includes('Test Biz Grocer'));
  assert.ok(!d.items.some((t) => t.transfer));
});

test('newest first, and rows carry what the Transactions screen needs', async () => {
  const cur = (await json(await get('/api/cycles'))).items.at(-1);
  const d = await json(await get(`/api/budgets/${groc}/transactions?cycle=${cur.start}`));
  const dates = d.items.map((t) => t.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
  for (const k of ['id', 'account_id', 'account_name', 'date', 'amount', 'merchant', 'category', 'status', 'business', 'transfer', 'tax', 'receipts', 'logo']) assert.ok(k in d.items[0], k);
});

test('business spend joins when asked, as on the budget itself', async () => {
  const cur = (await json(await get('/api/cycles'))).items.at(-1);
  const d = await json(await get(`/api/budgets/${groc}/transactions?cycle=${cur.start}&include_business=1`));
  const list = (await json(await get(`/api/budgets?cycle=${cur.start}&include_business=1`))).items.find((i) => i.category_id === groc);
  assert.ok(names(d.items).includes('Test Biz Grocer'));
  assert.equal(sum(d.items), list.spent);
});

test('the previous cycle lists its own rows', async () => {
  const prev = (await json(await get('/api/cycles'))).items.at(-2);
  const d = await json(await get(`/api/budgets/${groc}/transactions?cycle=${prev.start}`));
  const list = (await json(await get(`/api/budgets?cycle=${prev.start}`))).items.find((i) => i.category_id === groc);
  assert.deepEqual(names(d.items), ['Test Grocer Old']);
  assert.equal(sum(d.items), list.spent);
});

test('the monthly roll-up lists the month and sums to its spent figure', async () => {
  const month = T.slice(0, 7);
  const d = await json(await get(`/api/budgets/${groc}/transactions?month=${month}`));
  const list = (await json(await get(`/api/budgets?month=${month}`))).items.find((i) => i.category_id === groc);
  assert.equal(d.basis, 'month');
  assert.equal(d.month, month);
  const last = String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0');
  assert.deepEqual([d.from, d.to], [`${month}-01`, `${month}-${last}`]);
  assert.ok(d.items.every((t) => t.date.startsWith(month)));
  assert.ok(names(d.items).includes('Test Grocer Today'));
  assert.equal(Math.max(0, sum(d.items)), list.spent);
  assert.equal(d.budget.spent, list.spent);
});

test('a category with no budget still lists its rows, with budget null', async () => {
  const cur = (await json(await get('/api/cycles'))).items.at(-1);
  const d = await json(await get(`/api/budgets/${fuel}/transactions?cycle=${cur.start}`));
  assert.equal(d.budget, null);
  assert.deepEqual(names(d.items), ['Test Servo']);
  assert.equal(d.spent, 2500);
});

test('a category with nothing in the period answers an empty list, not an error', async () => {
  const cur = (await json(await get('/api/cycles'))).items.at(-1);
  const d = await json(await get(`/api/budgets/${b.cat('Pets')}/transactions?cycle=${cur.start}`));
  assert.deepEqual(d.items, []);
  assert.equal(d.spent, 0);
  assert.equal(d.count, 0);
});

test('bad input is a 400 or 404, never a 500', async () => {
  const cur = (await json(await get('/api/cycles'))).items.at(-1);
  assert.equal((await get(`/api/budgets/99999/transactions?cycle=${cur.start}`)).status, 404);
  assert.equal((await get(`/api/budgets/${groc}/transactions?cycle=1999-01-01`)).status, 404);
  assert.equal((await get(`/api/budgets/${groc}/transactions?month=2026-13`)).status, 400);
  assert.equal((await get(`/api/budgets/${groc}/transactions?month=${T.slice(0, 7)}&cycle=${cur.start}`)).status, 400);
});

const put = (id, body) => fetch(`${base}/api/budgets/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('editing from the monthly view and saving unchanged leaves cycle_target exactly as it was', async () => {
  const month = T.slice(0, 7);
  const d = await json(await get(`/api/budgets/${groc}/transactions?month=${month}`));
  // The monthly item's own target is the monthly figure; the per-cycle one rides beside it.
  assert.equal(d.budget.target, Math.round((40000 * 26) / 12));
  assert.equal(d.budget.cycle_target, 40000);
  // What the editor sends when opened with cycle_target and saved untouched.
  await json(await put(groc, { cycle_target: d.budget.cycle_target, fixed: d.budget.fixed, rollover: d.budget.rollover }));
  const after = (await json(await get(`/api/budgets?cycle=${(await json(await get('/api/cycles'))).items.at(-1).start}`))).items.find((i) => i.category_id === groc);
  assert.equal(after.target, 40000);
});

test('a monthly edit converts to the per-cycle target with the roll-up factor', async () => {
  const r = await json(await put(groc, { monthly_target: 65000 }));
  assert.equal(r.cycle_target, 30000);
  assert.equal(r.monthly_target, 65000);
  await json(await put(groc, { cycle_target: 40000 })); // put it back for the other tests
});
