// The engine's JSON API end to end: a real server against a fake Redbark and a
// fake OpenRouter, invented data only. Dates are relative to today in Perth
// because the server reads the real clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeRedbark, FAKE_KEY, addDays } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';
import { monthsBack } from './fixtures/book.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth' }).format(new Date());
const FY = Number(T.slice(0, 4)) + (Number(T.slice(5, 7)) >= 7 ? 1 : 0);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
let proc, base, fakeSrv, aiSrv;
const aiBodies = [];

function start(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const e = 'acct_test_everyday';
  const transactions = {
    [e]: [
      ...[0, 7, 14, 21, 28].map((d, i) => fx.tx(e, addDays(T, -d - 1), -[8123, 4410, 12999, 6650, 9020][i], 'TEST GROCER         TESTVILLE    WA', { provider_category: 'FOOD_AND_DRINK' })),
      ...[6, 5, 4, 3, 2, 1].map((n) => fx.tx(e, monthsBack(addDays(T, -2), n), -1599, 'TESTFLIX.COM', { provider_category: 'ENTERTAINMENT' })),
      fx.tx(e, addDays(T, -2), -1599, 'TESTFLIX.COM', { provider_category: 'ENTERTAINMENT' }),
      fx.tx(e, addDays(T, -9), 400000, 'SALARY/WAGES TEST PERSON', { provider_category: 'INCOME' }),
      fx.tx(e, addDays(T, -3), -50000, 'ONLINE X1 Linked Acc Trns', { id: 'txn_api_xfer_out', provider_category: 'TRANSFER_OUT' }),
      fx.tx(e, addDays(T, -5), -12000, 'PAYMENT TO TEST CARD', { id: 'txn_api_card_out', provider_category: 'TRANSFER_OUT' }),
      fx.tx(e, addDays(T, -4), -2300, 'TEST NOODLE BAR', { id: 'txn_api_noodle', provider_category: 'FOOD_AND_DRINK' }),
      fx.tx(e, addDays(T, -1), -45000, 'TEST LUXURY GOODS', { id: 'txn_api_luxury', provider_category: 'MERCHANDISE' }),
      fx.tx(e, addDays(T, -6), -9900, 'TEST HARDWARE TO A/C 12345678', { id: 'txn_api_hw', provider_category: 'MERCHANDISE' }),
    ],
    acct_test_offset: [fx.tx('acct_test_offset', addDays(T, -3), 50000, 'ONLINE X1 Linked Acc Trns', { provider_category: 'TRANSFER_IN' })],
    acct_test_card: [fx.tx('acct_test_card', addDays(T, -4), 12000, 'PAYMENT RECEIVED', { provider_category: 'TRANSFER_IN' })],
  };
  const fake = fakeRedbark({ ...fx, today: T, transactions });
  const l = await fake.listen();
  fakeSrv = l.server;

  aiSrv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      aiBodies.push(raw);
      const body = JSON.parse(raw);
      const prompt = body.messages.at(-1).content;
      const items = JSON.parse(prompt.slice(prompt.indexOf('[')));
      const results = items.map((x) => ({ i: x.i, category: /noodle/i.test(x.merchant) ? 'Takeaway and delivery' : 'Shopping' }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
    });
  });
  await new Promise((r) => aiSrv.listen(0, '127.0.0.1', r));

  const s = await start({
    MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-api-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner',
    REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: l.base,
    OPENROUTER_API_KEY: 'sk-or-test-invented', MINT_AI_BASE: `http://127.0.0.1:${aiSrv.address().port}/api/v1`,
  });
  assert.ok(s.url, s.out());
  proc = s.p;
  base = s.url;
  await send('POST', '/api/sync', {});
  for (let i = 0; i < 200; i++) {
    const st = await (await get('/api/sync')).json();
    const ai = await (await get('/api/categorise/status')).json();
    if (!st.running && st.finishedAt && !ai.running && ai.pending === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
});

after(() => { proc?.kill('SIGTERM'); fakeSrv?.close(); aiSrv?.close(); });

const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const get = (path, headers = H) => fetch(base + path, { headers });
const send = (method, path, body, headers = {}) => fetch(base + path, {
  method, headers: { ...H, 'content-type': 'application/json', ...headers }, body: body == null ? undefined : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)),
});
const json = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };
const catId = async (name) => (await json(await get('/api/categories'))).items.find((c) => c.name === name).id;
const txById = async (id) => (await json(await get('/api/transactions?limit=200'))).items.find((t) => t.id === id);

test('every engine endpoint needs the gate identity', async () => {
  for (const p of ['/api/categories', '/api/rules', '/api/transfers', '/api/recurring', '/api/budgets', '/api/alerts', '/api/summary/weekly',
    '/api/tax/categories', `/api/tax/summary?fy=${FY}`, `/api/tax/export.csv?fy=${FY}`, '/api/networth', '/api/networth/history', '/api/assets',
    '/api/categorise/status', '/api/receipts/1']) {
    assert.equal((await get(p, {})).status, 401, p);
  }
  assert.equal((await fetch(`${base}/api/rules`, { method: 'POST', body: '{}' })).status, 401);
});

test('sync categorises: provider fallback, seed rules and the AI pass', async () => {
  const items = (await json(await get('/api/transactions?limit=200'))).items;
  const sal = items.find((t) => /SALARY/.test(t.description));
  assert.equal(sal.category, 'Salary');
  assert.equal(sal.category_source, 'rule');
  const noodle = items.find((t) => t.id === 'txn_api_noodle');
  assert.equal(noodle.category, 'Takeaway and delivery');
  assert.equal(noodle.category_source, 'ai');
  assert.ok(aiBodies.length >= 1);
  for (const b of aiBodies) assert.doesNotMatch(b, /12345678|xxxx\d{4}|acct_test|Linked Acc|"amount"|balance/i);
  const st = await json(await get('/api/categorise/status'));
  assert.equal(st.enabled, true);
  assert.ok(st.today.merchants >= 1);
  assert.ok(st.today.prompt_tokens >= 50);
});

test('transfers matched on sync, legs carry the link, card repayment typed', async () => {
  const list = (await json(await get('/api/transfers?status=auto'))).items;
  const kinds = list.map((t) => t.kind).sort();
  assert.deepEqual(kinds, ['card_repayment', 'transfer']);
  const leg = await txById('txn_api_xfer_out');
  assert.equal(leg.transfer.kind, 'transfer');
  assert.equal(leg.transfer.status, 'auto');
  const t = list.find((x) => x.kind === 'transfer');
  assert.equal((await json(await send('POST', `/api/transfers/${t.id}/confirm`))).status, 'confirmed');
  assert.equal((await send('POST', '/api/transfers/99999/confirm')).status, 404);
  assert.ok(Array.isArray((await json(await get('/api/transfers?status=review'))).items));
  assert.equal((await get('/api/transfers?status=bogus')).status, 400);
});

test('rules: create applies retroactively, edit, delete', async () => {
  const groceries = await catId('Groceries');
  const r = await json(await send('POST', '/api/rules', { field: 'merchant', match: 'contains', pattern: 'test grocer', category_id: groceries }), 201);
  assert.equal(r.applied, 5);
  assert.ok((await json(await get('/api/rules'))).items.some((x) => x.id === r.rule.id && x.category === 'Groceries'));
  const pv = await json(await send('POST', '/api/rules/preview', { field: 'merchant', match: 'contains', pattern: 'test grocer' }));
  assert.equal(pv.count, 5);
  assert.equal((await json(await send('PATCH', `/api/rules/${r.rule.id}`, { priority: 20 }))).rule.priority, 20);
  assert.equal((await send('POST', '/api/rules', { field: 'description', match: 'regex', pattern: '(', category_id: groceries })).status, 400);
  assert.equal((await send('DELETE', `/api/rules/${r.rule.id}`)).status, 200);
  assert.equal((await send('DELETE', `/api/rules/${r.rule.id}`)).status, 404);
});

test('recategorise with always makes a rule; business and note per transaction', async () => {
  const shopping = await catId('Home and garden');
  const r = await json(await send('PATCH', '/api/transactions/txn_api_hw', { category_id: shopping, always: true }));
  assert.equal(r.transaction.category, 'Home and garden');
  assert.equal(r.transaction.category_source, 'manual');
  assert.equal(r.rule.source, 'correction');
  const b = await json(await send('PATCH', '/api/transactions/txn_api_hw', { is_business: true, note: 'test note' }));
  assert.equal(b.transaction.business, true);
  assert.equal(b.transaction.note, 'test note');
  assert.equal((await send('PATCH', '/api/transactions/txn_api_hw', { category_id: 'x' })).status, 400);
  assert.equal((await send('PATCH', '/api/transactions/txn_nope', { note: 'x' })).status, 404);
});

test('recurring lists the monthly subscription with its next date', async () => {
  const list = (await json(await get('/api/recurring'))).items;
  const s = list.find((x) => x.merchant_key === 'testflix com');
  assert.equal(s.cadence, 'monthly');
  assert.equal(s.amount, 1599);
  assert.ok(s.next_date > T);
});

test('budgets: set, progress, delete', async () => {
  const groceries = await catId('Groceries');
  await json(await send('PUT', `/api/budgets/${groceries}`, { monthly_target: 100000, rollover: true }));
  const p = await json(await get(`/api/budgets?month=${T.slice(0, 7)}`));
  const row = p.items.find((x) => x.category_id === groceries);
  assert.equal(row.target, 100000);
  assert.equal(row.rollover, true);
  assert.ok(row.spent >= 0);
  assert.equal((await send('PUT', `/api/budgets/${groceries}`, { monthly_target: -5 })).status, 400);
  assert.equal((await send('DELETE', `/api/budgets/${groceries}`)).status, 200);
});

test('alerts: unusual charge produced on sync, dismissable; weekly line', async () => {
  const list = (await json(await get('/api/alerts'))).items;
  const a = list.find((x) => x.kind === 'unusual');
  assert.ok(a, JSON.stringify(list));
  assert.equal(a.transaction_id, 'txn_api_luxury');
  assert.ok(list.some((x) => x.kind === 'sync' && x.type === 'consent_expiring'));
  await json(await send('POST', `/api/alerts/${a.id}/dismiss`));
  assert.ok(!(await json(await get('/api/alerts'))).items.some((x) => x.id === a.id));
  const w = await json(await get('/api/summary/weekly'));
  assert.equal(typeof w.line, 'string');
  assert.ok(w.line.length > 10);
});

test('tax estimate: read, save the inputs, reject bad ones, decline an unsupported year', async () => {
  assert.equal((await get('/api/tax/estimate?fy=2027', {})).status, 401);
  const e = await json(await get('/api/tax/estimate?fy=2027'));
  assert.equal(e.fy, 2027);
  assert.ok(['ok', 'no_data'].includes(e.status));
  assert.ok(Array.isArray(e.lines) && 'inputs' in e && 'confidence' in e);
  const put = await json(await send('PUT', '/api/tax/estimate/inputs', { fy: 2027, gross_salary: 9000000, tax_withheld: 2000000, as_at: '2026-10-10', private_health: true }));
  assert.equal(put.inputs.gross_salary, 9000000);
  assert.equal(put.estimate.salary.gross.source, 'entered');
  assert.equal((await json(await get('/api/tax/estimate?fy=2027'))).inputs.tax_withheld, 2000000);
  assert.equal((await send('PUT', '/api/tax/estimate/inputs', { fy: 2027, tax_withheld: -1 })).status, 400);
  assert.equal((await send('PUT', '/api/tax/estimate/inputs', { fy: 2027, gst: 1 })).status, 400);
  assert.equal((await send('PUT', '/api/tax/estimate/inputs', { tax_withheld: 1 }, { 'remote-user': '' })).status, 401);
  assert.equal((await json(await get('/api/tax/estimate?fy=2019'))).status, 'unsupported');
  assert.equal((await get('/api/tax/estimate?fy=abc')).status, 400);
  const clear = await json(await send('PUT', '/api/tax/estimate/inputs', { fy: 2027, gross_salary: null, tax_withheld: null, as_at: null, private_health: null }));
  assert.equal(clear.inputs.gross_salary, null);
});

test('tax: tag, receipt upload and fetch, FY summary and CSV', async () => {
  const codes = (await json(await get('/api/tax/categories'))).items.map((c) => c.code);
  assert.ok(codes.includes('D5'));
  const tag = await json(await send('PUT', '/api/transactions/txn_api_hw/tax', { ato_category: 'D5' }));
  assert.equal(tag.deductible_amount, 9900);
  assert.equal((await send('PUT', '/api/transactions/txn_api_hw/tax', { ato_category: 'NOPE' })).status, 400);
  const up = await json(await send('POST', '/api/transactions/txn_api_hw/receipts', PNG, { 'content-type': 'image/png' }), 201);
  const f = await get(`/api/receipts/${up.id}`);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'image/png');
  assert.equal(f.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.compare(Buffer.from(await f.arrayBuffer()), PNG), 0);
  assert.equal((await send('POST', '/api/transactions/txn_api_hw/receipts', '<html><script>1</script>', { 'content-type': 'image/png' })).status, 415);
  const s = await json(await get(`/api/tax/summary?fy=${FY}`));
  assert.equal(s.deductions.total, 9900);
  assert.equal(s.receipts.missing, 0);
  const csv = await get(`/api/tax/export.csv?fy=${FY}`);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="mint-fy\d{4}\.csv"/);
  assert.match(await csv.text(), /TEST HARDWARE/);
  assert.equal((await get('/api/tax/summary?fy=abc')).status, 400);
  assert.equal((await send('DELETE', `/api/receipts/${up.id}`)).status, 200);
  assert.equal((await get(`/api/receipts/${up.id}`)).status, 404);
});

test('net worth with manual assets and history', async () => {
  const a = await json(await send('POST', '/api/assets', { name: 'Test Shares', kind: 'shares' }), 201);
  await json(await send('POST', `/api/assets/${a.id}/snapshots`, { date: T, value: 1000000 }));
  const nw = await json(await get('/api/networth'));
  assert.equal(nw.manual.find((m) => m.id === a.id).value, 1000000);
  assert.equal(nw.loans[0].offsets[0].id, 'acct_test_offset');
  assert.equal(nw.net_worth, 123456 + 2500000 - 50000 - 40000000 + 1000000);
  const h = await json(await get('/api/networth/history'));
  assert.ok(h.items.some((p) => p.date === T));
  assert.ok((await json(await get('/api/assets'))).items.some((x) => x.id === a.id));
  assert.equal((await send('POST', '/api/assets', { name: 'X', kind: 'nope' })).status, 400);
});
