// Shares and ETFs JSON API: /api/holdings (list with totals, allocation,
// history and the quote status), create, edit, delete with a restore for Undo,
// lots, manual price, Refresh now, and the one-time shares prompt. The real
// handler over an in-memory book with a fake quote service.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { book } from './fixtures/book.mjs';
import { createApi } from '../lib/api.mjs';
import { createAsset, addSnapshot } from '../lib/networth.mjs';
import { HttpError } from '../lib/errors.mjs';
import { recordQuote } from '../lib/quotes.mjs';

let srv, base, b, refreshed;
const quotes = {
  async refresh(opts) { refreshed.push(opts); recordQuote(b.db, { ticker: 'BHP', exchange: 'ASX', price: 50, prevClose: 49, currency: 'AUD', source: 'Fake Quotes', fetchedAt: new Date().toISOString() }); return { fetched: 1, failed: 0, capped: false }; },
  status: () => ({ source: 'Fake Quotes', configured: true, calls_today: 1, cap: 25, last_error: null, note: null }),
};

before(async () => {
  b = book();
  refreshed = [];
  const api = createApi({ db: b.db, engine: { refresh() {}, runAi() {} }, ai: null, quotes, dataDir: mkdtempSync(join(tmpdir(), 'mint-hold-')), log() {} });
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
const send = (method, p, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const json = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };

test('empty list: designed zero state, quote status still reported', async () => {
  const d = await json(await get('/api/holdings'));
  assert.deepEqual(d.holdings, []);
  assert.equal(d.totals.value, 0);
  assert.equal(d.totals.count, 0);
  assert.equal(d.prices.source, 'Fake Quotes');
  assert.equal(d.prices.configured, true);
  assert.deepEqual(d.history, []);
  assert.deepEqual(d.prompts, []);
  assert.match(d.footer, /information only/i);
});

test('create, refresh now, then list with value, gain, allocation and a history point', async () => {
  const c = await json(await send('POST', '/api/holdings', { ticker: 'bhp', exchange: 'ASX', units: 100, avg_cost: 40 }), 201);
  assert.equal(c.ticker, 'BHP');
  const r = await json(await send('POST', '/api/holdings/refresh', {}));
  assert.equal(r.fetched, 1);
  assert.deepEqual(refreshed.at(-1), { force: true });
  const d = await json(await get('/api/holdings'));
  assert.equal(d.holdings.length, 1);
  assert.equal(d.holdings[0].value, 500000);
  assert.equal(d.holdings[0].gain, 100000);
  assert.equal(d.totals.value, 500000);
  assert.equal(d.allocation.by_holding[0].ticker, 'BHP');
  assert.ok(d.allocation.by_class.some((x) => x.class === 'au_shares' && x.value === 500000));
  assert.equal(d.history.length, 1, 'a daily snapshot is stored when the portfolio changes');
  assert.equal(d.history[0].value, 500000);
});

test('edit, manual price, and validation errors come back as 400 with the real text', async () => {
  const d = await json(await get('/api/holdings'));
  const id = d.holdings[0].id;
  const p = await json(await send('PATCH', `/api/holdings/${id}`, { units: 120, manual_price: 55 }));
  assert.equal(p.units, 120);
  assert.equal(p.manual_price, 55);
  const after = (await json(await get('/api/holdings'))).holdings[0];
  assert.equal(after.value, 660000);
  assert.equal(after.price.source, 'manual');
  const cleared = await json(await send('PATCH', `/api/holdings/${id}`, { manual_price: null }));
  assert.equal(cleared.manual_price, null);
  const e = await json(await send('POST', '/api/holdings', { ticker: 'BHP', exchange: 'ASX', units: 1, avg_cost: 1 }), 400);
  assert.match(e.error, /already/i);
  assert.match((await json(await send('POST', '/api/holdings', { ticker: 'X', exchange: 'LSE', units: 1, avg_cost: 1 }), 400)).error, /exchange/i);
  assert.equal((await send('PATCH', '/api/holdings/99999', { units: 1 })).status, 404);
});

test('lots: add, edit, delete through the API; the cost base follows', async () => {
  const c = await json(await send('POST', '/api/holdings', { ticker: 'VGS', exchange: 'ASX', asset_class: 'etf', lots: [{ date: '2025-01-10', units: 10, price: 100, brokerage: 995 }] }), 201);
  const lot = await json(await send('POST', `/api/holdings/${c.id}/lots`, { date: '2025-06-10', units: 30, price: 110 }), 201);
  let h = (await json(await get('/api/holdings'))).holdings.find((x) => x.id === c.id);
  assert.equal(h.units, 40);
  assert.equal(h.cost, 100000 + 330000 + 995);
  await json(await send('PATCH', `/api/holdings/${c.id}/lots/${lot.id}`, { units: 10 }));
  await json(await send('DELETE', `/api/holdings/${c.id}/lots/${lot.id}`));
  h = (await json(await get('/api/holdings'))).holdings.find((x) => x.id === c.id);
  assert.equal(h.units, 10);
  assert.equal(h.lots.length, 1);
});

test('delete returns the record; posting it back to /restore undoes the delete', async () => {
  const before = (await json(await get('/api/holdings'))).holdings.find((x) => x.ticker === 'VGS');
  const del = await json(await send('DELETE', `/api/holdings/${before.id}`));
  assert.equal(del.deleted, true);
  assert.equal(del.record.ticker, 'VGS');
  assert.equal((await json(await get('/api/holdings'))).holdings.some((x) => x.ticker === 'VGS'), false);
  const back = await json(await send('POST', '/api/holdings/restore', { record: del.record }), 201);
  assert.equal(back.ticker, 'VGS');
  const after = (await json(await get('/api/holdings'))).holdings.find((x) => x.ticker === 'VGS');
  assert.equal(after.lots.length, 1);
  assert.equal(after.units, 10);
});

test('the one-time shares prompt: listed, decided once, then gone', async () => {
  const manual = createAsset(b.db, { name: 'Old manual shares', kind: 'shares' });
  addSnapshot(b.db, manual.id, { date: '2026-10-01', value: 3000000 });
  let d = await json(await get('/api/holdings'));
  assert.equal(d.prompts.length, 1);
  assert.equal(d.prompts[0].asset_id, manual.id);
  assert.equal(d.prompts[0].value, 3000000);
  assert.match((await json(await send('POST', `/api/assets/${manual.id}/shares-decision`, { decision: 'later' }), 400)).error, /keep or convert/i);
  const r = await json(await send('POST', `/api/assets/${manual.id}/shares-decision`, { decision: 'convert' }));
  assert.equal(r.decision, 'convert');
  d = await json(await get('/api/holdings'));
  assert.deepEqual(d.prompts, []);
  const nw = await json(await get('/api/networth'));
  assert.equal(nw.holdings.count, d.holdings.length);
  assert.equal(nw.groups.investments, d.totals.value);
});
