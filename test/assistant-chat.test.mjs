// The assistant door for chat: safe writes apply at once and hand back an undo
// token (24 hours, single use) that restores the exact prior state; bigger
// writes (more than 5 transactions, deleting a rule, budget, goal or holding,
// anything on an account) never apply on the first call and return a confirm
// token (10 minutes, single use) bound to that one operation. Plus the reads
// chat needs for Save and Invest, the forecast, the pack and the tax estimate.
// The real handler over an in-memory book with a fake clock. Invented data only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { book } from './fixtures/book.mjs';
import { createAssistantApi } from '../lib/assistant.mjs';
import { HttpError } from '../lib/errors.mjs';
import { setBudget } from '../lib/budgets.mjs';
import { createGoal, addContribution } from '../lib/goals.mjs';
import { createHolding } from '../lib/holdings.mjs';
import { createAsset, addSnapshot } from '../lib/networth.mjs';
import { createRule } from '../lib/categorise.mjs';

const T0 = Date.parse('2026-10-17T02:00:00Z');
let srv, base, b, clock;

const quotes = { status: () => ({ source: null, configured: false, calls_today: 0, cap: 25, last_ok_at: null, last_error: null, note: null }) };

beforeEach(async () => {
  b = book();
  clock = T0;
  const api = createAssistantApi({ db: b.db, engine: { refresh() {} }, quotes, origin: 'https://finance.example.test', now: () => new Date(clock), log() {} });
  srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!(await api(req, res, url))) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"no such endpoint"}'); }
    } catch (e) {
      res.writeHead(e instanceof HttpError ? e.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}/api/assistant`;
});
afterEach(() => srv?.close());

const get = (p) => fetch(base + p);
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const json = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };

// Everything a chat write could touch, read straight from the tables, so
// "exact prior state" means every column of every row.
const TABLES = ['transactions', 'rules', 'budgets', 'goals', 'goal_contributions', 'holdings', 'holding_lots', 'manual_assets', 'manual_snapshots', 'loan_inputs', 'tax_tags', 'accounts', 'settings'];
function state() {
  const out = {};
  for (const t of TABLES) {
    const rows = b.db.prepare(`SELECT * FROM ${t}`).all();
    if (t === 'rules') rows.forEach((r) => delete r.hits);
    // Bookkeeping a sync rewrites anyway: undo puts back what the owner can see and change.
    if (t === 'transactions') rows.forEach((r) => { delete r.updated_at; delete r.income_kind; delete r.income_source_id; });
    if (t === 'accounts') rows.forEach((r) => delete r.updated_at);
    if (t === 'settings') out[t] = rows.filter((r) => r.key.startsWith('tax_estimate_inputs'));
    else out[t] = rows.sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1);
  }
  return out;
}

const shop = (n, desc = 'TEST HARDWARE BARN', amount = -2500) => Array.from({ length: n }, (_, i) => b.add('acct_t_everyday', `2026-09-${String(i + 1).padStart(2, '0')}`, amount - i, desc));

// ---------- safe writes ----------

test('recategorise one transaction: applies now, undo puts every column back, token is single use', async () => {
  const [id] = shop(1);
  const before = state();
  const r = await json(await post(`/transactions/${id}/category`, { category: 'Groceries' }));
  assert.equal(r.applied, true);
  assert.equal(r.op, 'recategorise');
  assert.match(r.summary, /Groceries/);
  assert.match(r.undo.token, /^u_[A-Za-z0-9_-]{20,}$/);
  assert.equal(r.undo.expires_at, new Date(T0 + 24 * 3600_000).toISOString());
  assert.equal(b.row(id).category_id, b.cat('Groceries'));
  assert.equal(b.row(id).category_source, 'manual');
  const u = await json(await post(`/undo/${r.undo.token}`));
  assert.equal(u.undone, true);
  assert.deepEqual(state(), before);
  assert.equal((await post(`/undo/${r.undo.token}`)).status, 410);
});

test('recategorise with always: the rule and the few rows it moves are undone exactly', async () => {
  const ids = shop(3);
  const before = state();
  const r = await json(await post(`/transactions/${ids[0]}/category`, { category: 'Groceries', always: true }));
  assert.equal(r.applied, true);
  assert.ok(r.result.rule, 'a correction rule was made');
  assert.ok(ids.every((id) => b.row(id).category_id === b.cat('Groceries')));
  await json(await post(`/undo/${r.undo.token}`));
  assert.deepEqual(state(), before);
  assert.equal(b.db.prepare("SELECT count(*) n FROM rules WHERE source = 'correction'").get().n, 0);
});

test('budget target: set over an existing one and a new one, undo restores both exactly', async () => {
  setBudget(b.db, b.cat('Fuel'), { cycle_target: 20000, rollover: true });
  const before = state();
  const r1 = await json(await post('/budgets', { category: 'Fuel', cycle_target: 25000 }));
  const r2 = await json(await post('/budgets', { category: 'Groceries', monthly_target: 80000 }));
  assert.equal(b.db.prepare('SELECT cycle_target FROM budgets WHERE category_id = ?').get(b.cat('Fuel')).cycle_target, 25000);
  await json(await post(`/undo/${r2.undo.token}`));
  await json(await post(`/undo/${r1.undo.token}`));
  assert.deepEqual(state(), before);
});

test('goal add and edit, by name, each undone exactly', async () => {
  const before = state();
  const add = await json(await post('/goals', { name: 'Test Holiday', target_amount: 300000, target_date: '2027-06-30' }), 201);
  assert.equal(add.result.name, 'Test Holiday');
  const mid = state();
  const edit = await json(await post('/goals/test%20holiday', { target_amount: 450000, account: 'Savings Test' }));
  assert.equal(edit.result.target_amount, 450000);
  assert.equal(edit.result.account_id, 'acct_t_savings');
  await json(await post(`/undo/${edit.undo.token}`));
  assert.deepEqual(state(), mid);
  await json(await post(`/undo/${add.undo.token}`));
  assert.deepEqual(state(), before);
});

test('share holding, a lot on it by ticker, and an edit: each undone exactly', async () => {
  const before = state();
  const h = await json(await post('/holdings', { ticker: 'vas', exchange: 'ASX', units: 10, avg_cost: 95.5 }), 201);
  assert.equal(h.result.ticker, 'VAS');
  const s1 = state();
  const lot = await json(await post('/holdings/VAS/lots', { date: '2026-10-01', units: 5, price: 98, brokerage: 995 }), 201);
  assert.ok(lot.result.id);
  const s2 = state();
  const holding2 = createHolding(b.db, { ticker: 'IVV', exchange: 'ASX', units: 3, avg_cost: 60 });
  const s3 = state();
  const ed = await json(await post(`/holdings/${holding2.id}`, { manual_price: 61.25, name: 'Test S&P 500' }));
  assert.equal(ed.result.manual_price, 61.25);
  await json(await post(`/undo/${ed.undo.token}`));
  assert.deepEqual(state(), s3);
  b.db.prepare('DELETE FROM holdings WHERE id = ?').run(holding2.id);
  assert.deepEqual(state(), s2);
  await json(await post(`/undo/${lot.undo.token}`));
  assert.deepEqual(state(), s1);
  await json(await post(`/undo/${h.undo.token}`));
  assert.deepEqual(state(), before);
});

test('super snapshot: log one, update one on the same date, add an asset; undo restores each', async () => {
  const sup = createAsset(b.db, { name: 'Test Super Fund', kind: 'super' });
  addSnapshot(b.db, sup.id, { date: '2026-09-30', value: 8000000, contribution: 90000 });
  const before = state();
  const upd = await json(await post('/assets/test%20super%20fund/snapshots', { date: '2026-09-30', value: 8100000, contribution: 95000, note: 'statement' }));
  assert.equal(upd.result.value, 8100000);
  const mid = state();
  const add = await json(await post(`/assets/${sup.id}/snapshots`, { value: 8200000 }));
  assert.equal(add.result.date, '2026-10-17');
  await json(await post(`/undo/${add.undo.token}`));
  assert.deepEqual(state(), mid);
  await json(await post(`/undo/${upd.undo.token}`));
  assert.deepEqual(state(), before);
  const asset = await json(await post('/assets', { name: 'Test Car', kind: 'vehicle' }), 201);
  await json(await post(`/undo/${asset.undo.token}`));
  assert.deepEqual(state(), before);
});

test('loan detail: set on the only loan, change it, undo each back exactly', async () => {
  const before = state();
  const r1 = await json(await post('/loan', { rate: 0.0612, repayment: 310000, frequency: 'monthly' }));
  assert.equal(r1.result.account_id, 'acct_t_loan');
  const mid = state();
  const r2 = await json(await post('/loan', { account: 'Test Home Loan', rate: 0.0599 }));
  assert.equal(r2.result.rate, 0.0599);
  await json(await post(`/undo/${r2.undo.token}`));
  assert.deepEqual(state(), mid);
  await json(await post(`/undo/${r1.undo.token}`));
  assert.deepEqual(state(), before);
});

test('tax estimate inputs and a deductible tag: set, replace, clear, each undone exactly', async () => {
  const [id] = shop(1, 'TEST OFFICE SUPPLIES');
  const before = state();
  const inp = await json(await post('/tax/estimate/inputs', { fy: 2027, tax_withheld: 2100000, private_health: true }));
  assert.equal(inp.result.inputs.tax_withheld, 2100000);
  const est = await json(await get('/tax/estimate?fy=2027'));
  assert.equal(est.inputs.tax_withheld, 2100000);
  assert.equal(est.inputs.private_health, true);
  const tag = await json(await post(`/transactions/${id}/tax`, { ato_category: 'D5' }));
  assert.equal(tag.ato_category, 'D5', 'the old response shape still holds');
  assert.ok(tag.undo.token);
  const mid = state();
  const re = await json(await post(`/transactions/${id}/tax`, { ato_category: 'D5', deductible_amount: 1000 }));
  const clr = await json(await post(`/transactions/${id}/tax`, { ato_category: null }));
  assert.equal(b.db.prepare('SELECT count(*) n FROM tax_tags').get().n, 0);
  await json(await post(`/undo/${clr.undo.token}`));
  await json(await post(`/undo/${re.undo.token}`));
  assert.deepEqual(state(), mid);
  await json(await post(`/undo/${tag.undo.token}`));
  await json(await post(`/undo/${inp.undo.token}`));
  assert.deepEqual(state(), before);
});

test('a write that changes nothing has nothing to undo', async () => {
  const r = await json(await post('/rules', { pattern: 'nothing matches this', category: 'Groceries' }), 201);
  const again = await json(await post('/rules', { pattern: 'nothing matches this', category: 'Groceries' }));
  assert.equal(again.created, false);
  assert.equal(again.undo, null);
  assert.ok(r.undo.token, 'the new rule itself can be undone');
});

// ---------- confirm-required writes ----------

test('bulk edit: up to 5 transactions applies with undo, 6 needs a confirm and changes nothing until then', async () => {
  const five = shop(5);
  const small = await json(await post('/transactions/bulk', { ids: five, set_category: 'Groceries' }));
  assert.equal(small.applied, true);
  assert.equal(small.changes.transactions, 5);
  await json(await post(`/undo/${small.undo.token}`));

  shop(1, 'TEST HARDWARE BARN', -9999);
  const before = state();
  const big = await json(await post('/transactions/bulk', { match: { merchant: 'hardware barn' }, set_category: 'Groceries' }), 202);
  assert.equal(big.needs_confirm, true);
  assert.equal(big.op, 'bulk_edit');
  assert.match(big.token, /^c_[A-Za-z0-9_-]{20,}$/);
  assert.equal(big.changes.transactions, 6);
  assert.match(big.summary, /6 transactions/);
  assert.match(big.summary, /Groceries/);
  assert.equal(big.sample.length, 5);
  assert.equal(big.expires_at, new Date(T0 + 10 * 60_000).toISOString());
  assert.deepEqual(state(), before, 'nothing applied on the first call');

  const ok = await json(await post(`/confirm/${big.token}`, { op: 'bulk_edit' }));
  assert.equal(ok.applied, true);
  assert.equal(ok.confirmed, true);
  assert.equal(ok.changes.transactions, 6);
  assert.equal(b.db.prepare("SELECT count(*) n FROM transactions WHERE category_id = ?").get(b.cat('Groceries')).n, 6);
  assert.equal((await post(`/confirm/${big.token}`)).status, 410, 'single use');
  await json(await post(`/undo/${ok.undo.token}`));
  assert.deepEqual(state(), before, 'a confirmed write can be undone too');
});

test('an always-rule or a new rule that moves more than 5 transactions needs a confirm', async () => {
  const ids = shop(7);
  const before = state();
  const one = await json(await post(`/transactions/${ids[0]}/category`, { category: 'Groceries', always: true }), 202);
  assert.equal(one.needs_confirm, true);
  assert.equal(one.changes.transactions, 7);
  assert.deepEqual(state(), before);
  const rule = await json(await post('/rules', { pattern: 'HARDWARE BARN', category: 'Groceries' }), 202);
  assert.equal(rule.needs_confirm, true);
  assert.match(rule.summary, /7 transactions/);
  assert.deepEqual(state(), before);
  await json(await post(`/confirm/${rule.token}`));
  assert.ok(ids.every((id) => b.row(id).category_id === b.cat('Groceries')));
});

test('deleting a rule, budget, goal or holding always needs a confirm; undo brings it all back', async () => {
  const rule = createRule(b.db, { field: 'description', match: 'contains', pattern: 'TEST HARDWARE', category_id: b.cat('Groceries') }).rule;
  shop(2);
  b.db.prepare("UPDATE transactions SET category_id = ?, category_source = 'rule', rule_id = ?").run(b.cat('Groceries'), rule.id);
  setBudget(b.db, b.cat('Fuel'), { cycle_target: 20000 });
  const goal = createGoal(b.db, { name: 'Test Deposit', target_amount: 5000000 });
  addContribution(b.db, goal.id, { date: '2026-10-01', amount: 100000 });
  addContribution(b.db, goal.id, { date: '2026-10-08', amount: 50000 });
  const h = createHolding(b.db, { ticker: 'BHP', exchange: 'ASX', lots: [{ date: '2026-01-02', units: 10, price: 40, brokerage: 500 }] });
  const before = state();

  const previews = [
    await json(await post(`/rules/${rule.id}/delete`), 202),
    await json(await post('/budgets/fuel/delete'), 202),
    await json(await post('/goals/test%20deposit/delete'), 202),
    await json(await post('/holdings/BHP.ASX/delete'), 202),
  ];
  assert.deepEqual(previews.map((p) => p.op), ['rule_delete', 'budget_delete', 'goal_delete', 'holding_delete']);
  assert.ok(previews.every((p) => p.needs_confirm && p.token && p.summary));
  assert.match(previews[2].summary, /2 contributions/);
  assert.deepEqual(state(), before, 'no delete applies on the first call');

  const undos = [];
  for (const p of previews) undos.push((await json(await post(`/confirm/${p.token}`))).undo.token);
  assert.equal(b.db.prepare('SELECT count(*) n FROM rules WHERE id = ?').get(rule.id).n, 0);
  assert.equal(b.db.prepare('SELECT count(*) n FROM goals').get().n, 0);
  assert.equal(b.db.prepare('SELECT count(*) n FROM goal_contributions').get().n, 0);
  assert.equal(b.db.prepare('SELECT count(*) n FROM holding_lots WHERE holding_id = ?').get(h.id).n, 0);
  for (const t of undos.reverse()) await json(await post(`/undo/${t}`));
  assert.deepEqual(state(), before);
});

test('anything on an account needs a confirm', async () => {
  const before = state();
  const p = await json(await post('/accounts/everyday%20test', { nickname: 'Daily', hidden: false }), 202);
  assert.equal(p.op, 'account_edit');
  assert.deepEqual(state(), before);
  const ok = await json(await post(`/confirm/${p.token}`));
  assert.equal(b.db.prepare('SELECT nickname FROM accounts WHERE id = ?').get('acct_t_everyday').nickname, 'Daily');
  await json(await post(`/undo/${ok.undo.token}`));
  assert.deepEqual(state(), before);
});

test('an account type override is preview then confirm, undoable, and refuses a type that does not exist', async () => {
  const typeOf = () => b.db.prepare('SELECT type, type_override FROM accounts WHERE id = ?').get('acct_t_everyday');
  const was = { ...typeOf() };
  await json(await post('/accounts/everyday%20test', { type_override: 'bogus' }), 400);
  const p = await json(await post('/accounts/everyday%20test', { type_override: 'savings' }), 202);
  assert.match(p.summary, /type set to savings/);
  assert.deepEqual({ ...typeOf() }, was);
  const ok = await json(await post(`/confirm/${p.token}`));
  assert.deepEqual({ ...typeOf() }, { type: 'savings', type_override: 'savings' });
  await json(await post(`/undo/${ok.undo.token}`));
  assert.deepEqual({ ...typeOf() }, was);
});

// ---------- tokens ----------

test('undo tokens last 24 hours, confirm tokens 10 minutes', async () => {
  const [id] = shop(1);
  const r = await json(await post(`/transactions/${id}/category`, { category: 'Fuel' }));
  const goal = createGoal(b.db, { name: 'Test Bike' });
  const c = await json(await post(`/goals/${goal.id}/delete`), 202);
  clock = T0 + 10 * 60_000 + 1000;
  assert.equal((await post(`/confirm/${c.token}`)).status, 410);
  assert.equal(b.db.prepare('SELECT count(*) n FROM goals').get().n, 1);
  clock = T0 + 24 * 3600_000 - 1000;
  const fresh = await json(await post(`/transactions/${id}/category`, { category: 'Groceries' }));
  clock = T0 + 24 * 3600_000 + 1000;
  assert.equal((await post(`/undo/${r.undo.token}`)).status, 410);
  await json(await post(`/undo/${fresh.undo.token}`));
  assert.equal(b.row(id).category_id, b.cat('Fuel'));
});

test('confirm tokens cannot be forged or carried across operations', async () => {
  const a = createGoal(b.db, { name: 'Test Goal A' });
  const g = createGoal(b.db, { name: 'Test Goal B' });
  const h = createHolding(b.db, { ticker: 'VGS', exchange: 'ASX', units: 1, avg_cost: 100 });
  const pa = await json(await post(`/goals/${a.id}/delete`), 202);
  const pb = await json(await post(`/goals/${g.id}/delete`), 202);
  const ph = await json(await post(`/holdings/${h.id}/delete`), 202);
  assert.notEqual(pa.token, pb.token);

  // Claimed for another operation: refused and burnt, nothing deleted.
  assert.equal((await post(`/confirm/${ph.token}`, { op: 'goal_delete' })).status, 409);
  assert.equal((await post(`/confirm/${ph.token}`, { op: 'holding_delete' })).status, 410);
  assert.equal(b.db.prepare('SELECT count(*) n FROM holdings').get().n, 1);
  // Body params cannot redirect a token: it deletes what it was issued for.
  await json(await post(`/confirm/${pa.token}`, { op: 'goal_delete', id: g.id, ref: String(g.id) }));
  assert.deepEqual(b.db.prepare('SELECT name FROM goals').all().map((r) => r.name), ['Test Goal B']);
  // Tampered, swapped between kinds, or made up: unknown.
  const tampered = pb.token.slice(0, -2) + (pb.token.endsWith('AA') ? 'BB' : 'AA');
  assert.equal((await post(`/confirm/${tampered}`)).status, 404);
  assert.equal((await post(`/undo/${pb.token}`)).status, 404, 'a confirm token is not an undo token');
  const [id] = shop(1);
  const u = await json(await post(`/transactions/${id}/category`, { category: 'Fuel' }));
  assert.equal((await post(`/confirm/${u.undo.token}`)).status, 404, 'an undo token is not a confirm token');
  assert.equal((await post('/confirm/c_madeupmadeupmadeupmadeupmadeup')).status, 404);
  assert.equal(b.db.prepare('SELECT count(*) n FROM goals').get().n, 1);
});

test('undo refuses when the row was changed since, and leaves both alone', async () => {
  const [id] = shop(1);
  const r = await json(await post(`/transactions/${id}/category`, { category: 'Fuel' }));
  b.db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?').run(b.cat('Groceries'), id);
  const res = await post(`/undo/${r.undo.token}`);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /changed since/);
  assert.equal(b.row(id).category_id, b.cat('Groceries'));
  const goal = await json(await post('/goals', { name: 'Test Car Fund' }), 201);
  addContribution(b.db, goal.result.id, { amount: 1000 });
  assert.equal((await post(`/undo/${goal.undo.token}`)).status, 409, 'undoing the add would take a later contribution with it');
  assert.equal(b.db.prepare('SELECT count(*) n FROM goal_contributions').get().n, 1);
});

test('a confirm whose effect has grown since the preview is refused with a fresh preview', async () => {
  shop(6);
  const p = await json(await post('/transactions/bulk', { match: { merchant: 'hardware barn' }, set_category: 'Groceries' }), 202);
  shop(1, 'TEST HARDWARE BARN', -8888);
  const before = state();
  const r = await json(await post(`/confirm/${p.token}`), 409);
  assert.equal(r.needs_confirm, true);
  assert.equal(r.changes.transactions, 7);
  assert.notEqual(r.token, p.token);
  assert.deepEqual(state(), before);
  await json(await post(`/confirm/${r.token}`));
});

test('nothing deletes a transaction, touches a connection or moves money', async () => {
  const [id] = shop(1);
  for (const p of [`/transactions/${id}/delete`, '/connections', '/connections/conn_t_alpha', '/transfers', '/payments', '/sync', `/accounts/acct_t_everyday/delete`]) {
    assert.equal((await post(p, {})).status, 404, p);
  }
  assert.ok(b.row(id));
});

// ---------- reads ----------

test('reads for chat: save and invest, holdings, loan, forecast, goals, pack link, tax estimate, rules, assets', async () => {
  createHolding(b.db, { ticker: 'VAS', exchange: 'ASX', units: 10, avg_cost: 90, manual_price: 100 });
  const sup = createAsset(b.db, { name: 'Test Super Fund', kind: 'super' });
  addSnapshot(b.db, sup.id, { date: '2026-09-30', value: 8000000 });
  const save = await json(await get('/save'));
  for (const k of ['savings', 'super', 'shares', 'home_loan', 'goals']) assert.ok(k in save, k);
  assert.equal(save.super.total, 8000000);
  assert.equal(save.shares.totals.value, 100000);
  const hold = await json(await get('/holdings'));
  assert.equal(hold.holdings[0].ticker, 'VAS');
  assert.match(hold.footer, /information only/i);
  const loan = await json(await get('/loan'));
  assert.equal(loan.items[0].id, 'acct_t_loan');
  const fc = await json(await get('/forecast'));
  assert.ok('available' in fc);
  await json(await get('/goals'));
  const pack = await json(await get('/pack?fy=2026'));
  assert.equal(pack.fy, 2026);
  assert.equal(pack.download_url, 'https://finance.example.test/api/tax/pack?fy=2026');
  assert.equal(pack.file_name, 'mint-fy2026-accountant-pack.zip');
  assert.ok('deductions' in pack && 'missing_receipts' in pack);
  const est = await json(await get('/tax/estimate'));
  assert.equal(est.fy, 2027);
  assert.ok('inputs' in est && 'deductions' in est && 'estimate' in est);
  assert.ok(Array.isArray((await json(await get('/rules'))).items));
  assert.equal((await json(await get('/assets'))).items[0].name, 'Test Super Fund');
  assert.equal((await get('/pack?fy=26')).status, 400);
});

test('bad input is a 400 with the reason and writes nothing', async () => {
  const before = state();
  assert.match((await json(await post('/budgets', { category: 'Nope', cycle_target: 100 }), 400)).error, /Groceries/);
  assert.equal((await post('/goals', { name: '' })).status, 400);
  assert.equal((await post('/holdings', { ticker: '!!', units: 1, avg_cost: 1 })).status, 400);
  assert.equal((await post('/tax/estimate/inputs', { tax_withheld: -5 })).status, 400);
  assert.equal((await post('/tax/estimate/inputs', { gst: 5 })).status, 400);
  assert.equal((await post('/transactions/bulk', { ids: [], set_category: 'Fuel' })).status, 400);
  assert.equal((await post('/goals/9999/delete')).status, 404);
  assert.deepEqual(state(), before);
});

test('a confirm is pinned to the rows it previewed, not to the name used', async () => {
  const car = createGoal(b.db, { name: 'Test Car' });
  const p = await json(await post('/goals/car/delete'), 202);
  b.db.prepare('UPDATE goals SET name = ? WHERE id = ?').run('Test Ute', car.id);
  const other = createGoal(b.db, { name: 'Test Car Seats' });
  await json(await post(`/confirm/${p.token}`));
  assert.deepEqual(b.db.prepare('SELECT id FROM goals').all().map((r) => r.id), [other.id]);
  const ids = shop(6);
  const bulk = await json(await post('/transactions/bulk', { match: { merchant: 'hardware barn' }, set_category: 'Fuel' }), 202);
  b.db.prepare('UPDATE transactions SET description = ?, merchant = ? WHERE id = ?').run('TEST OTHER SHOP', 'Test Other Shop', ids[0]);
  shop(1, 'TEST HARDWARE BARN', -7777);
  const before = state();
  const again = await json(await post(`/confirm/${bulk.token}`), 409);
  assert.equal(again.needs_confirm, true, 'same count, different rows: a fresh preview, not an apply');
  assert.deepEqual(state(), before);
});
