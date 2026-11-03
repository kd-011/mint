// The assistant door (step 4): a bearer-keyed, loopback-only JSON API under
// /api/assistant/ that the assistant's chat tools read and write through. Reads: summary,
// spend, transactions, budgets, tax, balances, alerts. Writes: add a
// categorisation rule, tag a transaction deductible, mark alerts pushed. No
// route moves money or deletes anything. Invented data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { book } from './fixtures/book.mjs';
import { fakeRedbark, FAKE_KEY } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';
import {
  spendReport, searchTransactions, summary, addRule, tagDeductible, markPushed, pendingAlerts, weeklyBrief, taxReport, resolveCategory,
} from '../lib/assistant.mjs';
import { setBudget } from '../lib/budgets.mjs';
import { createRule } from '../lib/categorise.mjs';
import { matchTransfers } from '../lib/transfers.mjs';
import { runAlerts } from '../lib/alerts.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';
import { INVENTED_NOAS } from './fixtures/noa.mjs';

const TODAY = '2026-10-17';

function fuelBook() {
  const b = book();
  const fuel = b.cat('Fuel');
  const groc = b.cat('Groceries');
  const set = (id, cat, source = 'manual') => b.db.prepare('UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?').run(cat, source, id);
  set(b.add('acct_t_everyday', '2026-09-03', -8120, 'TEST FUEL STOP PERTH'), fuel);
  set(b.add('acct_t_card', '2026-09-19', -6400, 'TEST FUEL STOP PERTH'), fuel);
  set(b.add('acct_t_card', '2026-09-22', 1000, 'TEST FUEL STOP REFUND'), fuel); // refund nets off
  set(b.add('acct_t_everyday', '2026-08-30', -5000, 'TEST FUEL STOP PERTH'), fuel); // August
  set(b.add('acct_t_everyday', '2026-10-02', -7000, 'TEST FUEL STOP PERTH'), fuel); // October
  set(b.add('acct_t_biz', '2026-09-10', -9000, 'TEST DEPOT DIESEL'), fuel); // business account
  set(b.add('acct_t_everyday', '2026-09-05', -15000, 'TEST GROCER WEST'), groc);
  set(b.add('acct_t_everyday', '2026-09-06', 400000, 'SALARY TEST PERSON', { provider_category: 'INCOME' }), b.cat('Salary'));
  // A linked transfer pair: never spend or income.
  b.add('acct_t_everyday', '2026-09-08', -30000, 'TO SAVINGS', { provider_category: 'TRANSFER_OUT' });
  b.add('acct_t_savings', '2026-09-08', 30000, 'FROM EVERYDAY', { provider_category: 'TRANSFER_IN' });
  matchTransfers(b.db);
  return b;
}

test('spend: fuel in September, net of refunds, transfers out, business split', () => {
  const b = fuelBook();
  const r = spendReport(b.db, { category: 'fuel', from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r.totals.spent, 8120 + 6400 - 1000 + 9000);
  assert.equal(r.totals.business_spent, 9000);
  assert.equal(r.totals.personal_spent, 8120 + 6400 - 1000);
  assert.equal(r.totals.count, 4);
  assert.deepEqual(r.range, { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(r.categories_matched, ['Fuel']);
});

test('spend: scope personal leaves the business account out', () => {
  const b = fuelBook();
  const r = spendReport(b.db, { category: 'Fuel', from: '2026-09-01', to: '2026-09-30', scope: 'personal' });
  assert.equal(r.totals.spent, 13520);
  const biz = spendReport(b.db, { category: 'Fuel', from: '2026-09-01', to: '2026-09-30', scope: 'business' });
  assert.equal(biz.totals.spent, 9000);
});

test('spend: grouped by category excludes the transfer pair and reports income apart', () => {
  const b = fuelBook();
  const r = spendReport(b.db, { from: '2026-09-01', to: '2026-09-30', group: 'category' });
  assert.deepEqual(r.groups.map((g) => g.name), ['Fuel', 'Groceries']);
  assert.equal(r.groups[1].spent, 15000);
  assert.equal(r.totals.income, 400000);
  assert.equal(r.totals.spent, 15000 + 22520);
  assert.ok(!r.groups.some((g) => /transfer/i.test(g.name)));
});

test('spend: grouped by merchant, month and account; merchant and text filters', () => {
  const b = fuelBook();
  const byMerchant = spendReport(b.db, { category: 'Fuel', from: '2026-08-01', to: '2026-10-31', group: 'merchant' });
  assert.equal(byMerchant.groups[0].name, 'Test Fuel Stop Perth');
  const byMonth = spendReport(b.db, { category: 'Fuel', from: '2026-08-01', to: '2026-10-31', group: 'month' });
  assert.deepEqual(byMonth.groups.map((g) => [g.key, g.spent]), [['2026-08', 5000], ['2026-09', 22520], ['2026-10', 7000]]);
  const byAcct = spendReport(b.db, { category: 'Fuel', from: '2026-09-01', to: '2026-09-30', group: 'account' });
  assert.ok(byAcct.groups.some((g) => g.name === 'Business Test' && g.spent === 9000));
  const m = spendReport(b.db, { merchant: 'grocer', from: '2026-09-01', to: '2026-09-30' });
  assert.equal(m.totals.spent, 15000);
});

test('spend: defaults to this month, refuses a bad range or an unknown category with the valid names', () => {
  const b = fuelBook();
  const r = spendReport(b.db, {}, TODAY);
  assert.deepEqual(r.range, { from: '2026-10-01', to: TODAY });
  assert.equal(r.totals.spent, 7000);
  assert.throws(() => spendReport(b.db, { from: '2026-09-30', to: '2026-09-01' }), /from is after to/);
  assert.throws(() => spendReport(b.db, { from: 'last tuesday' }), /YYYY-MM-DD/);
  assert.throws(() => spendReport(b.db, { category: 'Fuels and gas' }), (e) => e.status === 400 && /Fuel/.test(e.message));
  assert.throws(() => spendReport(b.db, { group: 'colour' }), /group must be/);
});

test('category names resolve by name or group, case-insensitively', () => {
  const b = fuelBook();
  assert.deepEqual(resolveCategory(b.db, 'FUEL').map((c) => c.name), ['Fuel']);
  const transport = resolveCategory(b.db, 'transport').map((c) => c.name);
  assert.ok(transport.includes('Fuel') && transport.length > 1);
});

test('transactions: search by text, dates and amount, transfers hidden unless asked, cursor pages', () => {
  const b = fuelBook();
  const r = searchTransactions(b.db, { q: 'fuel stop', from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r.items.length, 3);
  assert.ok(r.items.every((t) => t.id && t.date && 'amount' in t && t.account && t.category));
  assert.equal(searchTransactions(b.db, { q: 'TO SAVINGS' }).items.length, 0);
  assert.equal(searchTransactions(b.db, { q: 'TO SAVINGS', include_transfers: true }).items.length, 1);
  const big = searchTransactions(b.db, { category: 'Fuel', min_amount: 7000, from: '2026-08-01', to: '2026-10-31' });
  assert.deepEqual(big.items.map((t) => t.amount).sort((a, c) => a - c), [-9000, -8120, -7000]);
  const p1 = searchTransactions(b.db, { category: 'Fuel', limit: 2, from: '2026-08-01', to: '2026-10-31' });
  assert.equal(p1.items.length, 2);
  assert.ok(p1.next);
  const p2 = searchTransactions(b.db, { category: 'Fuel', limit: 2, cursor: p1.next, from: '2026-08-01', to: '2026-10-31' });
  const ids = new Set([...p1.items, ...p2.items].map((t) => t.id));
  assert.equal(ids.size, p1.items.length + p2.items.length);
  assert.throws(() => searchTransactions(b.db, { limit: 5000 }), /limit/);
  assert.throws(() => searchTransactions(b.db, { cursor: 'garbage' }), /cursor/);
});

test('summary: net worth and this month against budget', () => {
  const b = fuelBook();
  setBudget(b.db, b.cat('Fuel'), { monthly_target: 10000 });
  setBudget(b.db, b.cat('Groceries'), { monthly_target: 80000 });
  const s = summary(b.db, TODAY);
  assert.equal(s.net_worth.net_worth, 100000 + 500000 - 50000 - 40000000 + 2500000 + 300000);
  assert.equal(s.month.month, '2026-10');
  assert.equal(s.month.spent, 7000);
  assert.deepEqual(s.month.budget.totals, { target: 90000, spent: 7000 });
  assert.equal(s.month.budget.items.find((i) => i.name === 'Fuel').pct, 70);
  assert.ok(Array.isArray(s.month.budget.over));
  assert.ok('open_alerts' in s && 'pending_push' in s);
});

test('rule: add by category name, retro-applies, idempotent, refuses unknowns', () => {
  const b = book();
  b.add('acct_t_everyday', '2026-09-05', -4200, 'WOOLWORTHS 1234 PERTH');
  b.add('acct_t_everyday', '2026-09-12', -6100, 'WOOLWORTHS 1234 PERTH');
  const r = addRule(b.db, { pattern: 'Woolworths', category: 'groceries' });
  assert.equal(r.created, true);
  assert.equal(r.rule.category, 'Groceries');
  assert.equal(r.rule.field, 'description');
  assert.equal(r.applied, 2);
  const again = addRule(b.db, { pattern: 'WOOLWORTHS', category: 'Groceries' });
  assert.equal(again.created, false);
  assert.equal(b.db.prepare('SELECT count(*) n FROM rules WHERE lower(pattern) = ?').get('woolworths').n, 1);
  assert.throws(() => addRule(b.db, { pattern: 'x', category: 'Nonsense' }), (e) => e.status === 400 && /Groceries/.test(e.message));
  assert.throws(() => addRule(b.db, { category: 'Groceries' }), /pattern/);
  assert.throws(() => addRule(b.db, { pattern: 'x', category: 'Groceries', match: 'contains', field: 'nope' }), /field/);
  assert.throws(() => addRule(b.db, { pattern: '(a|aa)+$', category: 'Groceries', match: 'regex' }), /regex rules are made by hand/);
});

test('rule: beats a seeded rule for the same merchant', () => {
  const b = book();
  const id = b.add('acct_t_everyday', '2026-09-05', -4200, 'TESTMART 99 PERTH');
  createRule(b.db, { pattern: 'testmart', category_id: b.cat('Shopping') }, { source: 'seed' });
  addRule(b.db, { pattern: 'testmart', category: 'Groceries' });
  assert.equal(b.row(id).category_id, b.cat('Groceries'));
});

test('tax: tag a transaction deductible, then it shows in the FY report', () => {
  const b = fuelBook();
  const id = b.add('acct_t_everyday', '2026-09-14', -12000, 'TEST OFFICE SUPPLIES');
  const r = tagDeductible(b.db, id, { ato_category: 'D5', deductible_amount: 8000, note: 'monitor stand' });
  assert.equal(r.deductible_amount, 8000);
  const t = taxReport(b.db, { fy: 2027 });
  assert.equal(t.summary.deductions.total, 8000);
  assert.equal(t.items.length, 1);
  assert.equal(t.items[0].id, id);
  assert.equal(t.items[0].ato_category, 'D5');
  assert.throws(() => tagDeductible(b.db, 'txn_missing', { ato_category: 'D5' }), (e) => e.status === 404);
  const inc = b.add('acct_t_everyday', '2026-09-15', 5000, 'TEST REFUND IN');
  assert.throws(() => tagDeductible(b.db, inc, { ato_category: 'D5' }), /money out/);
  assert.throws(() => tagDeductible(b.db, id, { ato_category: 'ZZ' }), /ATO/);
});

test('alerts: pending are the unpushed open ones, mark pushed once, never deleted', () => {
  const b = book();
  b.add('acct_t_card', '2026-10-15', -45000, 'TEST LUXURY GOODS');
  runAlerts(b.db, { now: new Date('2026-10-17T02:00:00Z') });
  const before = pendingAlerts(b.db);
  assert.equal(before.length, 1);
  assert.equal(before[0].kind, 'unusual');
  assert.equal(markPushed(b.db, [before[0].id, 99999]).marked, 1);
  assert.equal(markPushed(b.db, [before[0].id]).marked, 0);
  assert.equal(pendingAlerts(b.db).length, 0);
  assert.equal(b.db.prepare('SELECT count(*) n FROM alerts').get().n, 1);
  assert.throws(() => markPushed(b.db, 'all'), /ids/);
  assert.throws(() => markPushed(b.db, new Array(201).fill(1)), /ids/);
});

test('weekly brief: the summary line plus anything odd', () => {
  const b = book();
  b.add('acct_t_card', '2026-10-15', -45000, 'TEST LUXURY GOODS');
  runAlerts(b.db, { now: new Date('2026-10-17T02:00:00Z') });
  const w = weeklyBrief(b.db, TODAY);
  assert.match(w.line, /^Last week/);
  assert.ok(w.odd.some((t) => /Test Luxury Goods/.test(t)));
});

// HTTP: key auth, loopback only, narrow surface

const KEY = 'mint_test_key_0123456789abcdef0123456789abcdef';
let proc, base, fakeSrv;

function start(env) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(root, 'server.mjs')], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ p, url: `http://127.0.0.1:${m[1]}`, out: () => out });
    });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ p, code, out: () => out }));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
}

before(async () => {
  const fake = fakeRedbark({ ...fx, transactions: { acct_test_everyday: fx.history('acct_test_everyday', '2026-09-01', '2026-10-16', 2) } });
  const l = await fake.listen();
  fakeSrv = l.server;
  const s = await start({
    MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-assistant-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner',
    REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: l.base, MINT_API_KEY: KEY,
  });
  assert.ok(s.url, s.out());
  proc = s.p;
  base = s.url;
});
after(() => { proc?.kill('SIGTERM'); fakeSrv?.close(); });

const bearer = (k = KEY, extra = {}) => ({ authorization: `Bearer ${k}`, ...extra });

test('http: the key opens /api/assistant/ and nothing else', async () => {
  const ok = await fetch(`${base}/api/assistant/summary`, { headers: bearer() });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.ok((await ok.json()).net_worth);
  for (const p of ['/api/transactions', '/api/accounts', '/api/rules', '/api/sync', '/accounts', '/api/receipts/1']) {
    assert.equal((await fetch(base + p, { headers: bearer() })).status, 403, p);
  }
  const post = await fetch(`${base}/api/sync`, { method: 'POST', headers: bearer() });
  assert.equal(post.status, 403);
});

test('http: a wrong, missing or proxied key is refused, and the gate identity still works', async () => {
  assert.equal((await fetch(`${base}/api/assistant/summary`, { headers: bearer('wrong-key-wrong-key-wrong-key-wrong') })).status, 401);
  assert.equal((await fetch(`${base}/api/assistant/summary`)).status, 401);
  // Anything that came through the tunnel carries proxy headers: the key does not work there.
  for (const h of [{ 'x-forwarded-for': '203.0.113.9' }, { 'cf-connecting-ip': '203.0.113.9' }, { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY }]) {
    assert.equal((await fetch(`${base}/api/assistant/summary`, { headers: bearer(KEY, h) })).status, 401, JSON.stringify(h));
  }
  assert.equal((await fetch(`${base}/api/assistant/summary`, { headers: { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY } })).status, 200);
});

test('http: reads and the three writes work; nothing deletes', async () => {
  for (const p of ['/api/assistant/spend?group=category', '/api/assistant/transactions?limit=5', '/api/assistant/budgets', '/api/assistant/tax',
    '/api/assistant/balances', '/api/assistant/alerts', '/api/assistant/summary/weekly', '/api/assistant/categories']) {
    const r = await fetch(base + p, { headers: bearer() });
    assert.equal(r.status, 200, `${p} ${await r.clone().text()}`);
  }
  const json = { ...bearer(), 'content-type': 'application/json' };
  const rule = await fetch(`${base}/api/assistant/rules`, { method: 'POST', headers: json, body: JSON.stringify({ pattern: 'testmart', category: 'Groceries' }) });
  assert.equal(rule.status, 201, await rule.clone().text());
  const rule2 = await fetch(`${base}/api/assistant/rules`, { method: 'POST', headers: json, body: JSON.stringify({ pattern: 'testmart', category: 'Groceries' }) });
  assert.equal(rule2.status, 200);
  const pushed = await fetch(`${base}/api/assistant/alerts/pushed`, { method: 'POST', headers: json, body: JSON.stringify({ ids: [1] }) });
  assert.equal(pushed.status, 200);
  const tag = await fetch(`${base}/api/assistant/transactions/txn_nope/tax`, { method: 'POST', headers: json, body: JSON.stringify({ ato_category: 'D5' }) });
  assert.equal(tag.status, 404);
  const bad = await fetch(`${base}/api/assistant/spend?category=Nonsense`, { headers: bearer() });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Groceries/);
  for (const m of ['DELETE', 'PUT', 'PATCH']) {
    const r = await fetch(`${base}/api/assistant/rules`, { method: m, headers: json, body: '{}' });
    assert.ok([404, 405].includes(r.status), `${m} ${r.status}`);
  }
  assert.equal((await fetch(`${base}/api/assistant/rules/1`, { method: 'DELETE', headers: bearer() })).status, 404);
});

test('http: the v2 pay-cycle reads answer, and they write nothing', async () => {
  for (const p of ['/api/assistant/cycle', '/api/assistant/income', '/api/assistant/bills', '/api/assistant/goals', '/api/assistant/subscriptions', '/api/assistant/debt', '/api/assistant/debt?extra=10000']) {
    const r = await fetch(base + p, { headers: bearer() });
    assert.equal(r.status, 200, `${p} ${await r.clone().text()}`);
  }
  const s = await (await fetch(`${base}/api/assistant/summary`, { headers: bearer() })).json();
  assert.ok('cycle' in s);
  const json = { ...bearer(), 'content-type': 'application/json' };
  // POST /api/assistant/goals is the chat door's goal add since the chat-door step
  // (test/assistant-chat.test.mjs), so only PUT and DELETE stay refused there.
  for (const p of ['/api/assistant/cycle', '/api/assistant/goals', '/api/assistant/plan', '/api/assistant/budgets/starter', '/api/assistant/subscriptions']) {
    for (const m of p === '/api/assistant/goals' ? ['PUT', 'DELETE'] : ['POST', 'PUT', 'DELETE']) {
      const r = await fetch(base + p, { method: m, headers: json, body: '{}' });
      assert.ok([404, 405].includes(r.status), `${m} ${p} ${r.status}`);
    }
  }
  assert.equal((await fetch(`${base}/api/assistant/debt?extra=-5`, { headers: bearer() })).status, 400);
});

test('http: the chat writes, undo and confirm sit behind the same key, loopback only', async () => {
  const json = { ...bearer(), 'content-type': 'application/json' };
  const goal = await fetch(`${base}/api/assistant/goals`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Test Over The Wire' }) });
  assert.equal(goal.status, 201, await goal.clone().text());
  const { undo } = await goal.json();
  for (const h of [{ 'x-forwarded-for': '203.0.113.9' }, { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY }]) {
    for (const p of [`/api/assistant/undo/${undo.token}`, '/api/assistant/confirm/c_madeupmadeupmadeupmadeup', '/api/assistant/budgets']) {
      assert.equal((await fetch(base + p, { method: 'POST', headers: { ...json, ...h }, body: '{}' })).status, 401, `${p} ${JSON.stringify(h)}`);
    }
  }
  const del = await fetch(`${base}/api/assistant/goals/test%20over%20the%20wire/delete`, { method: 'POST', headers: json, body: '{}' });
  assert.equal(del.status, 202);
  assert.equal((await del.json()).needs_confirm, true);
  const u = await fetch(`${base}/api/assistant/undo/${undo.token}`, { method: 'POST', headers: json, body: '{}' });
  assert.equal(u.status, 200, await u.clone().text());
  assert.equal((await fetch(`${base}/api/assistant/undo/${undo.token}`, { method: 'POST', headers: json, body: '{}' })).status, 410);
});

test('http: the key cannot confirm a held change; only the signed-in page can', async () => {
  const json = { ...bearer(), 'content-type': 'application/json' };
  const goals = async () => (await (await fetch(`${base}/api/assistant/goals`, { headers: bearer() })).json()).items.map((g) => g.name);
  assert.equal((await fetch(`${base}/api/assistant/goals`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Test Held Delete' }) })).status, 201);
  const del = await fetch(`${base}/api/assistant/goals/test%20held%20delete/delete`, { method: 'POST', headers: json, body: '{}' });
  assert.equal(del.status, 202);
  const held = await del.json();
  const self = await fetch(`${base}/api/assistant/confirm/${held.token}`, { method: 'POST', headers: json, body: JSON.stringify({ op: held.op }) });
  assert.equal(self.status, 403);
  assert.equal((await self.json()).code, 'confirm-needs-owner');
  assert.ok((await goals()).includes('Test Held Delete'), 'the refused confirm changed nothing');
  // The refusal does not spend the token: the owner's tap on the card still applies it.
  const tap = await fetch(`${base}/api/chat/confirm/${held.token}`, { method: 'POST', headers: { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ op: held.op }) });
  assert.equal(tap.status, 200, await tap.clone().text());
  assert.equal((await tap.json()).confirmed, true);
  assert.ok(!(await goals()).includes('Test Held Delete'));
});

test('http: a chat write of an NoA answers with an undo token that puts the earlier figure back', async () => {
  const json = { ...bearer(), 'content-type': 'application/json' };
  const fyRow = async (fy) => (await (await fetch(`${base}/api/assistant/income/fy`, { headers: bearer() })).json()).years.find((y) => y.fy === fy);
  const { fy: fy23, ...noa23 } = INVENTED_NOAS.find((n) => n.fy === 2023);
  const put = await fetch(`${base}/api/income/assessments/2023`, { method: 'PUT', headers: { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY, 'content-type': 'application/json' }, body: JSON.stringify(noa23) });
  assert.equal(put.status, 200, await put.clone().text());
  const was = (await fyRow(2023)).noa;
  assert.equal(was.taxable_income, 5000000);
  const w = await fetch(`${base}/api/assistant/income/assessments/2023`, { method: 'POST', headers: json, body: JSON.stringify({ taxable_income: 5900000 }) });
  assert.equal(w.status, 200, await w.clone().text());
  const body = await w.json();
  assert.ok(body.undo?.token, 'a safe write answers with an undo token');
  assert.equal((await fyRow(2023)).noa.taxable_income, 5900000);
  const u = await fetch(`${base}/api/assistant/undo/${body.undo.token}`, { method: 'POST', headers: json, body: '{}' });
  assert.equal(u.status, 200, await u.clone().text());
  const back = (await fyRow(2023)).noa;
  assert.equal(back.taxable_income, 5000000);
  assert.equal(back.tax_withheld_payg, was.tax_withheld_payg);
  assert.equal(back.refund, was.refund);
  // Undoing a write that added a year removes it again.
  const add = await (await fetch(`${base}/api/assistant/income/assessments/2025`, { method: 'POST', headers: json, body: JSON.stringify({ taxable_income: 6100000, tax_withheld_payg: 2200000 }) })).json();
  assert.ok(add.undo?.token);
  assert.equal((await fyRow(2025)).noa.taxable_income, 6100000);
  assert.equal((await fetch(`${base}/api/assistant/undo/${add.undo.token}`, { method: 'POST', headers: json, body: '{}' })).status, 200);
  assert.equal((await fyRow(2025)).noa, null);
});

test('http: the server refuses a short key at startup', async () => {
  const s = await start({
    MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-assistant-short-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off',
    REDBARK_API_KEY: FAKE_KEY, MINT_API_KEY: 'short',
  });
  assert.ok(s.code !== undefined && s.code !== 0, s.out());
  assert.match(s.out(), /MINT_API_KEY/);
});

test('http: MINT_API_ALIAS reaches the same door under the same rules', async () => {
  const s = await start({ MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-assistant-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner', MINT_API_KEY: KEY, MINT_API_ALIAS: '/api/old-door' });
  assert.ok(s.url, s.out());
  try {
    assert.equal((await fetch(`${s.url}/api/old-door/summary`, { headers: bearer() })).status, 200);
    assert.equal((await fetch(`${s.url}/api/old-door/summary`)).status, 401);
    assert.equal((await fetch(`${s.url}/api/old-door/summary`, { headers: bearer('wrong-key-wrong-key-wrong-key-wrong') })).status, 401);
    assert.equal((await fetch(`${s.url}/api/old-door/confirm/abcdefghijkl`, { method: 'POST', headers: bearer() })).status, 403);
    assert.equal((await fetch(`${s.url}/api/old-doorway/summary`, { headers: bearer() })).status, 403, 'a longer path is not the alias');
  } finally { s.p.kill('SIGTERM'); }
});

test('http: a MINT_API_ALIAS that is not /api/name stops the server', async () => {
  const s = await start({ MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-assistant-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner', MINT_API_KEY: KEY, MINT_API_ALIAS: '/' });
  assert.ok(!s.url);
  assert.match(s.out(), /MINT_API_ALIAS must look like/);
  s.p.kill('SIGTERM');
});
