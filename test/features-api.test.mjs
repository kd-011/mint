// The everyday-features routes over a real server and a fake Redbark: search,
// the transactions CSV export, saved views and the cycle insights read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeRedbark, FAKE_KEY, addDays } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth' }).format(new Date());
let proc, base, fakeSrv;

function start(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ p, url: `http://127.0.0.1:${m[1]}` });
    });
    p.stderr.on('data', (d) => { out += d; });
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
}

const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const get = (path, headers = H) => fetch(base + path, { headers });
const send = (method, path, body, headers = {}) => fetch(base + path, { method, headers: { ...H, 'content-type': 'application/json', ...headers }, body: body == null ? undefined : JSON.stringify(body) });
const json = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };

before(async () => {
  const e = 'acct_test_everyday';
  const transactions = {
    [e]: [
      fx.tx(e, addDays(T, -1), -4250, 'TEST NOODLE BAR', { id: 'txn_f_noodle', provider_category: 'FOOD_AND_DRINK' }),
      fx.tx(e, addDays(T, -2), -8123, 'TEST GROCER         TESTVILLE    WA', { id: 'txn_f_groc', provider_category: 'FOOD_AND_DRINK' }),
      fx.tx(e, addDays(T, -3), -9900, 'TEST "HARDWARE", SHED', { id: 'txn_f_hw', provider_category: 'MERCHANDISE' }),
      fx.tx(e, addDays(T, -4), -1500, '=HYPERLINK("http://x")', { id: 'txn_f_formula', provider_category: 'MERCHANDISE' }),
      fx.tx(e, addDays(T, -50), -7700, 'TEST GROCER         TESTVILLE    WA', { id: 'txn_f_old', provider_category: 'FOOD_AND_DRINK' }),
    ],
  };
  const fake = fakeRedbark({ ...fx, today: T, transactions });
  const l = await fake.listen();
  fakeSrv = l.server;
  const s = await start({
    MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-features-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner',
    REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: l.base,
  });
  proc = s.p;
  base = s.url;
  await send('POST', '/api/sync', {});
  for (let i = 0; i < 200; i++) {
    const st = await (await get('/api/sync')).json();
    if (!st.running && st.finishedAt) break;
    await new Promise((r) => setTimeout(r, 50));
  }
});

after(() => { proc?.kill('SIGTERM'); fakeSrv?.close(); });

test('the new routes need the gate identity', async () => {
  for (const p of ['/api/search?q=a', '/api/transactions/export.csv', '/api/views', '/api/insights/cycle']) assert.equal((await get(p, {})).status, 401, p);
  assert.equal((await fetch(`${base}/api/views`, { method: 'POST', body: '{}' })).status, 401);
});

test('search answers transactions with their detail, plus the other kinds', async () => {
  const r = await json(await get('/api/search?q=noodle'));
  assert.equal(r.q, 'noodle');
  assert.deepEqual(r.transactions.items.map((t) => t.id), ['txn_f_noodle']);
  assert.equal(r.transactions.total, 1);
  assert.ok('account_name' in r.transactions.items[0] && 'amount' in r.transactions.items[0] && 'category' in r.transactions.items[0]);
  const amount = await json(await get('/api/search?q=%2481.23'));
  assert.deepEqual(amount.transactions.items.map((t) => t.id), ['txn_f_groc']);
  const acc = await json(await get('/api/search?q=Platinum'));
  assert.deepEqual(acc.accounts.map((a) => a.id), ['acct_test_card']);
  const cat = await json(await get('/api/search?q=grocer'));
  assert.ok(cat.transactions.total >= 2 && Array.isArray(cat.categories) && Array.isArray(cat.budgets));
  assert.equal((await get('/api/search')).status, 400);
  assert.equal((await get('/api/search?q=%20')).status, 400);
  assert.equal((await get(`/api/search?q=${'x'.repeat(101)}`)).status, 400);
});

test('the list filter reads an amount the same way search does', async () => {
  const ids = (await json(await get('/api/transactions?q=42.50'))).items.map((t) => t.id);
  assert.deepEqual(ids, ['txn_f_noodle']);
});

test('export gives a CSV of exactly what the filters match', async () => {
  const res = await get('/api/transactions/export.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="mint-transactions-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(res.headers.get('x-export-truncated'), '0');
  const text = await res.text();
  const lines = text.trimEnd().split('\r\n');
  assert.equal(lines[0], 'Date,Description,Merchant,Account,Category,Amount,Status,Counts as,Transfer,ATO category,Deductible,Note');
  assert.equal(lines.length - 1, Number(res.headers.get('x-export-rows')));
  assert.ok(lines.length - 1 >= 5);
  // Filters narrow it; amounts are signed dollars; DD/MM/YYYY dates.
  const some = await (await get(`/api/transactions/export.csv?q=noodle&from=${addDays(T, -10)}`)).text();
  const rows = some.trimEnd().split('\r\n');
  assert.equal(rows.length, 2);
  assert.match(rows[1], /^\d{2}\/\d{2}\/\d{4},TEST NOODLE BAR,.*,-42\.50,posted,/);
  // Quoting, and a formula-looking cell is defused.
  assert.ok(text.includes('"TEST ""HARDWARE"", SHED"'));
  assert.ok(text.includes("'=HYPERLINK"), 'formula cell is prefixed');
  assert.ok(!/(^|,)=HYPERLINK/m.test(text));
  assert.equal((await get('/api/transactions/export.csv?from=nope')).status, 400);
  assert.equal((await get('/api/transactions/export.csv?direction=sideways')).status, 400);
});

test('saved views: create, list, rename, refilter, delete', async () => {
  assert.deepEqual((await json(await get('/api/views'))).items, []);
  const v = await json(await send('POST', '/api/views', { id: 'viewabc123', name: 'Big spends', filters: { direction: 'out', from: addDays(T, -30) } }), 201);
  assert.equal(v.id, 'viewabc123');
  assert.equal((await json(await send('POST', '/api/views', { id: 'viewabc123', name: 'Big spends', filters: { direction: 'out' } }), 201)).filters.from, addDays(T, -30));
  assert.equal((await send('POST', '/api/views', { name: 'big SPENDS', filters: { q: 'a' } })).status, 409);
  assert.equal((await send('POST', '/api/views', { name: 'Bad', filters: { direction: 'sideways' } })).status, 400);
  assert.equal((await send('POST', '/api/views', { name: 'Empty', filters: {} })).status, 400);
  const r = await json(await send('PATCH', '/api/views/viewabc123', { name: 'Spends' }));
  assert.equal(r.name, 'Spends');
  assert.equal((await send('PATCH', '/api/views/nothere01', { name: 'x' })).status, 404);
  assert.deepEqual((await json(await get('/api/views'))).items.map((x) => x.name), ['Spends']);
  // A saved view's filters go straight back into the list.
  const f = new URLSearchParams(r.filters);
  assert.equal((await get(`/api/transactions?${f}`)).status, 200);
  assert.deepEqual(await json(await send('DELETE', '/api/views/viewabc123')), { deleted: true });
  assert.deepEqual((await json(await get('/api/views'))).items, []);
});

test('view writes refuse a cross-origin request', async () => {
  const r = await send('POST', '/api/views', { name: 'Evil', filters: { q: 'a' } }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  assert.equal(r.status, 403);
});

test('cycle insights answers a shape the page can draw before any pay cycle exists', async () => {
  const r = await json(await get('/api/insights/cycle'));
  assert.equal(typeof r.available, 'boolean');
  assert.ok(Array.isArray(r.movers));
  if (!r.available) assert.equal(typeof r.reason, 'string');
});
