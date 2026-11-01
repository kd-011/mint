// Save and Invest JSON API: /api/savings, /api/super, /api/homeloan (read and
// enter missing details), and the contribution on a super snapshot. The real
// handler over an in-memory book, behind a bare http server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { book } from './fixtures/book.mjs';
import { transfer } from './fixtures/pay.mjs';
import { applyRules } from '../lib/categorise.mjs';
import { matchTransfers } from '../lib/transfers.mjs';
import { createApi } from '../lib/api.mjs';
import { HttpError } from '../lib/errors.mjs';
import { perthDate, addDays } from '../lib/dates.mjs';

const T = perthDate();
let srv, base, b;

before(async () => {
  b = book();
  b.db.prepare("UPDATE accounts SET details_json = ? WHERE id = 'acct_t_loan'").run(JSON.stringify({
    lending_rate: '0.0599',
    loan_details: { repayment_type: 'PRINCIPAL_AND_INTEREST', repayment_frequency: 'P1M', loan_end_date: '2056-07-29', offset_account_enabled: true },
  }));
  for (const d of [addDays(T, -70), addDays(T, -40), addDays(T, -10)]) transfer(b, 'acct_t_everyday', 'acct_t_loan', d, 250000);
  b.db.prepare("UPDATE accounts SET details_json = ? WHERE id = 'acct_t_savings'").run('{}');
  const interest = b.add('acct_t_savings', T, 4321, 'INTEREST PAID', { provider_category: 'INTEREST' });
  b.db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(b.cat('Interest'), interest);
  applyRules(b.db);
  matchTransfers(b.db);
  const api = createApi({ db: b.db, engine: { refresh() {}, runAi() {} }, ai: null, dataDir: mkdtempSync(join(tmpdir(), 'mint-save-')), log() {} });
  srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!(await api(req, res, url))) { res.writeHead(404); res.end('{}'); }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv?.close());

const get = (p) => fetch(base + p);
const send = (method, p, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const json = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };

test('GET /api/savings: accounts, interest, savings rate, history', async () => {
  const s = await json(await get('/api/savings'));
  assert.deepEqual(s.accounts.map((a) => a.id), ['acct_t_savings', 'acct_t_offset']);
  assert.equal(s.accounts[0].interest.month, 4321);
  assert.equal(s.interest.month, 4321);
  assert.match(s.interest.fy_label, /^FY20\d\d$/);
  for (const k of ['this_month', 'trailing_3', 'months']) assert.ok(k in s.savings_rate, k);
  assert.ok(Array.isArray(s.history));
  assert.equal(s.total_balance, 3000000);
});

test('super: create, snapshot with a contribution, read back with growth split out', async () => {
  const a = await json(await send('POST', '/api/assets', { name: 'Test Super', kind: 'super' }), 201);
  await json(await send('POST', `/api/assets/${a.id}/snapshots`, { date: addDays(T, -30), value: 4000000 }));
  await json(await send('POST', `/api/assets/${a.id}/snapshots`, { date: addDays(T, -2), value: 4300000, contribution: 100000 }));
  const s = await json(await get('/api/super'));
  const it = s.items.find((x) => x.id === a.id);
  assert.equal(it.value, 4300000);
  assert.deepEqual([it.change.amount, it.change.contribution, it.change.growth], [300000, 100000, 200000]);
  assert.equal(it.due, false);
  assert.equal(it.history.length, 2);
  const snaps = await json(await get(`/api/assets/${a.id}/snapshots`));
  assert.equal(snaps.items[0].contribution, 100000);
  assert.equal((await send('POST', `/api/assets/${a.id}/snapshots`, { value: 1, contribution: -1 })).status, 400);
  assert.equal((await send('POST', `/api/assets/${a.id}/snapshots`, { value: 1, contribution: 'x' })).status, 400);
});

test('GET /api/homeloan reads the loan, and ?extra_month= runs the what-if', async () => {
  const h = await json(await get('/api/homeloan'));
  assert.equal(h.items.length, 1);
  assert.equal(h.items[0].effective_balance, 37500000);
  assert.deepEqual(h.items[0].missing, []);
  assert.equal(h.items[0].extra, null);
  const e = await json(await get('/api/homeloan?extra_month=50000'));
  assert.ok(e.items[0].extra.interest_saved > 0);
  assert.equal(e.items[0].extra.extra_per_month, 50000);
  assert.equal((await get('/api/homeloan?extra_month=abc')).status, 400);
  assert.equal((await get('/api/homeloan?extra_month=-5')).status, 400);
});

test('PUT /api/homeloan/:id/inputs fills a gap, refuses nonsense, and clears with nulls', async () => {
  b.db.prepare("UPDATE accounts SET details_json = json_remove(details_json, '$.lending_rate') WHERE id = 'acct_t_loan'").run();
  assert.deepEqual((await json(await get('/api/homeloan'))).items[0].missing, ['rate']);
  const r = await json(await send('PUT', '/api/homeloan/acct_t_loan/inputs', { rate: 0.0625 }));
  assert.equal(r.rate, 0.0625);
  const h = (await json(await get('/api/homeloan'))).items[0];
  assert.deepEqual(h.missing, []);
  assert.equal(h.rate.source, 'you');
  assert.equal((await send('PUT', '/api/homeloan/acct_t_loan/inputs', { rate: 6.25 })).status, 400);
  assert.equal((await send('PUT', '/api/homeloan/acct_t_savings/inputs', { rate: 0.05 })).status, 400);
  assert.equal((await send('PUT', '/api/homeloan/acct_nope/inputs', { rate: 0.05 })).status, 404);
  await json(await send('PUT', '/api/homeloan/acct_t_loan/inputs', { rate: null }));
  assert.deepEqual((await json(await get('/api/homeloan'))).items[0].missing, ['rate']);
});

test('nothing under /api/assistant yet: the assistant door is a later step', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../lib/assistant.mjs', import.meta.url), 'utf8');
  assert.ok(!/\/api\/assistant\/(savings|super|homeloan)/.test(src));
});
