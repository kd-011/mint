// The quote layer: market hours, the refresh policy (at most every 15 minutes
// while a market is open, within a daily call budget), fallback to the last
// price when the source fails, and the two real adapters against a stubbed
// fetch. Nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { isOpen, lastClose } from '../lib/market.mjs';
import { createQuotes, createAlphaVantage, createYahoo, createPriceRouter, createFrankfurter, recordQuote } from '../lib/quotes.mjs';
import { createHolding, updateHolding, portfolio } from '../lib/holdings.mjs';

const at = (iso) => new Date(iso);

test('market hours: ASX 10:00 to 16:10 Sydney, US 09:30 to 16:00 New York, weekdays only', () => {
  assert.equal(isOpen('ASX', at('2026-10-14T03:00:00Z')), true); // Wed 14:00 AEDT
  assert.equal(isOpen('ASX', at('2026-10-13T22:59:00Z')), false); // 09:59 AEDT
  assert.equal(isOpen('ASX', at('2026-10-13T23:00:00Z')), true); // 10:00 AEDT
  assert.equal(isOpen('ASX', at('2026-10-14T05:11:00Z')), false); // 16:11 AEDT
  assert.equal(isOpen('ASX', at('2026-10-17T03:00:00Z')), false); // Saturday
  assert.equal(isOpen('US', at('2026-10-14T14:00:00Z')), true); // 10:00 EDT
  assert.equal(isOpen('US', at('2026-10-14T13:29:00Z')), false);
  assert.equal(isOpen('US', at('2026-10-14T20:00:00Z')), false); // 16:00 EDT, closed
  assert.equal(isOpen('US', at('2026-10-18T15:00:00Z')), false); // Sunday
  assert.equal(isOpen('FX', at('2026-10-14T03:00:00Z')), false);
});

test('lastClose finds the most recent session end, skipping weekends', () => {
  const sat = lastClose('ASX', at('2026-10-17T03:00:00Z')); // Saturday -> Friday 16:10 AEDT = 05:10Z
  assert.equal(sat.toISOString(), '2026-10-16T05:10:00.000Z');
  const wedMorning = lastClose('ASX', at('2026-10-13T22:00:00Z')); // Wed 09:00 AEDT -> Tue close
  assert.equal(wedMorning.toISOString(), '2026-10-13T05:10:00.000Z');
});

function fakeSource({ failFor = new Set(), configured = true } = {}) {
  const calls = [];
  return {
    name: 'Fake Quotes', configured, calls,
    async quote(ticker, exchange) {
      calls.push(`${ticker}.${exchange}`);
      if (failFor.has(ticker)) throw new Error(`no data for ${ticker}`);
      return { price: 10 + calls.length, prevClose: 10, currency: exchange === 'US' ? 'USD' : 'AUD', asOf: null };
    },
    async fx() { calls.push('fx'); return 1.5; },
  };
}
const svc = (db, source, opts = {}) => {
  const clock = { now: at('2026-10-14T03:00:00Z') };
  const q = createQuotes({ db, source, log() {}, now: () => clock.now, dailyCap: opts.cap ?? 100, today: () => '2026-10-14' });
  return { q, clock };
};

test('refresh fetches each held ticker once and caches price, previous close and fetched_at', async () => {
  const { db } = book();
  createHolding(db, { ticker: 'VAS', exchange: 'ASX', units: 1, avg_cost: 1 });
  createHolding(db, { ticker: 'BHP', exchange: 'ASX', units: 1, avg_cost: 1 });
  const src = fakeSource();
  const { q, clock } = svc(db, src);
  const r = await q.refresh();
  assert.deepEqual(src.calls.sort(), ['BHP.ASX', 'VAS.ASX']);
  assert.equal(r.fetched, 2);
  const p = portfolio(db, { now: clock.now });
  assert.ok(p.holdings.every((h) => h.price.source === 'Fake Quotes' && h.price.stale === false));
  assert.ok(p.holdings.every((h) => h.price.fetched_at === clock.now.toISOString()));
});

test('while open, nothing is fetched again inside 15 minutes; after 15 it is', async () => {
  const { db } = book();
  createHolding(db, { ticker: 'VAS', exchange: 'ASX', units: 1, avg_cost: 1 });
  const src = fakeSource();
  const { q, clock } = svc(db, src);
  await q.refresh();
  clock.now = at('2026-10-14T03:10:00Z');
  assert.equal((await q.refresh()).fetched, 0);
  clock.now = at('2026-10-14T03:16:00Z');
  assert.equal((await q.refresh()).fetched, 1);
  assert.equal(src.calls.length, 2);
});

test('a forced refresh (Refresh now) ignores the 15 minute gap but not the daily budget', async () => {
  const { db } = book();
  createHolding(db, { ticker: 'VAS', exchange: 'ASX', units: 1, avg_cost: 1 });
  const src = fakeSource();
  const { q } = svc(db, src, { cap: 2 });
  await q.refresh();
  assert.equal((await q.refresh({ force: true })).fetched, 1);
  const third = await q.refresh({ force: true });
  assert.equal(third.fetched, 0);
  assert.equal(third.capped, true);
  assert.equal(q.status().calls_today, 2);
  assert.equal(q.status().cap, 2);
});

test('closed market: one fetch after the close, none overnight or on the weekend', async () => {
  const { db } = book();
  createHolding(db, { ticker: 'VAS', exchange: 'ASX', units: 1, avg_cost: 1 });
  const src = fakeSource();
  const { q, clock } = svc(db, src);
  clock.now = at('2026-10-14T05:00:00Z'); // 16:00 open
  await q.refresh();
  clock.now = at('2026-10-14T05:30:00Z'); // closed at 16:10, last fetch was before the close
  assert.equal((await q.refresh()).fetched, 1);
  clock.now = at('2026-10-14T12:00:00Z');
  assert.equal((await q.refresh()).fetched, 0);
  clock.now = at('2026-10-17T03:00:00Z'); // Saturday; Friday's close was never fetched
  assert.equal((await q.refresh()).fetched, 1);
  clock.now = at('2026-10-18T03:00:00Z');
  assert.equal((await q.refresh()).fetched, 0);
});

test('a failing source keeps the last price, flags it stale and carries the error text', async () => {
  const { db } = book();
  const h = createHolding(db, { ticker: 'VAS', exchange: 'ASX', units: 10, avg_cost: 1 });
  recordQuote(db, { ticker: 'VAS', exchange: 'ASX', price: 100, prevClose: 99, currency: 'AUD', source: 'Fake Quotes', fetchedAt: '2026-10-14T02:00:00.000Z' });
  const { q, clock } = svc(db, fakeSource({ failFor: new Set(['VAS']) }));
  const r = await q.refresh();
  assert.equal(r.failed, 1);
  const v = portfolio(db, { now: clock.now }).holdings.find((x) => x.id === h.id);
  assert.equal(v.value, 100000);
  assert.equal(v.price.value, 100);
  assert.equal(v.price.stale, true);
  assert.match(v.price.note, /no data for VAS/);
  assert.match(q.status().last_error, /no data for VAS/);
});

test('a manual price skips the fetch; no source configured makes no calls and says why', async () => {
  const { db } = book();
  const a = createHolding(db, { ticker: 'VAS', exchange: 'ASX', units: 1, avg_cost: 1 });
  updateHolding(db, a.id, { manual_price: 100 });
  const src = fakeSource();
  const { q } = svc(db, src);
  assert.equal((await q.refresh()).fetched, 0);
  createHolding(db, { ticker: 'BHP', exchange: 'ASX', units: 1, avg_cost: 1 });
  const none = fakeSource({ configured: false });
  const { q: q2 } = svc(db, none);
  const r = await q2.refresh();
  assert.equal(r.fetched, 0);
  assert.equal(none.calls.length, 0);
  assert.equal(q2.status().configured, false);
  assert.match(q2.status().note, /ALPHAVANTAGE_API_KEY|enter prices/i);
});

test('US holdings also fetch the exchange rate, once, and only while a US holding exists', async () => {
  const { db } = book();
  const src0 = fakeSource();
  const { q: q0 } = svc(db, src0);
  await q0.refresh({ force: true });
  assert.equal(src0.calls.includes('fx'), false);
  createHolding(db, { ticker: 'AAPL', exchange: 'US', units: 1, avg_cost: 1 });
  const src = fakeSource();
  const { q, clock } = svc(db, src);
  clock.now = at('2026-10-14T15:00:00Z'); // US open
  await q.refresh();
  assert.equal(src.calls.filter((c) => c === 'fx').length, 1);
  assert.equal(portfolio(db, { now: clock.now }).holdings[0].fx_missing, false);
});

test('the call budget spreads over the day: more tickers than the cap allows widens the gap', async () => {
  const { db } = book();
  for (const t of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH']) createHolding(db, { ticker: t, exchange: 'ASX', units: 1, avg_cost: 1 });
  const src = fakeSource();
  const { q, clock } = svc(db, src, { cap: 25 });
  await q.refresh();
  assert.equal(src.calls.length, 8);
  clock.now = at('2026-10-14T03:20:00Z'); // 20 minutes on: past 15, but 8 tickers on 25 calls cannot go that fast
  assert.equal((await q.refresh()).fetched, 0);
  clock.now = at('2026-10-14T05:00:00Z'); // 2h later
  assert.equal((await q.refresh()).fetched, 8);
});

// ---------- adapters ----------

const jsonRes = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('Alpha Vantage: GLOBAL_QUOTE mapped to price and previous close, ASX as .AX, key never logged in errors', async () => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(String(url));
    return jsonRes({ 'Global Quote': { '01. symbol': 'VAS.AX', '05. price': '108.8600', '08. previous close': '107.7800', '07. latest trading day': '2026-10-14' } });
  };
  const av = createAlphaVantage({ key: 'SECRETKEY123', fetch });
  assert.equal(av.configured, true);
  const q = await av.quote('VAS', 'ASX');
  assert.equal(q.price, 108.86);
  assert.equal(q.prevClose, 107.78);
  assert.equal(q.currency, 'AUD');
  assert.match(seen[0], /function=GLOBAL_QUOTE/);
  assert.match(seen[0], /symbol=VAS\.AX/);
  const us = await av.quote('AAPL', 'US');
  assert.equal(us.currency, 'USD');
  assert.match(seen[1], /symbol=AAPL(&|$)/);
});

test('Alpha Vantage: rate-limit notes, empty quotes and HTTP errors become readable errors without the key', async () => {
  const mk = (body, status) => createAlphaVantage({ key: 'SECRETKEY123', fetch: async () => jsonRes(body, status) });
  await assert.rejects(mk({ Information: 'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.' }).quote('VAS', 'ASX'), /rate limit/i);
  await assert.rejects(mk({ 'Global Quote': {} }).quote('NOPE', 'ASX'), /no quote for NOPE/i);
  await assert.rejects(mk({}, 503).quote('VAS', 'ASX'), /503/);
  const e = await mk({ 'Error Message': 'Invalid API call for SECRETKEY123' }).quote('VAS', 'ASX').catch((x) => x);
  assert.doesNotMatch(e.message, /SECRETKEY123/);
  assert.equal(createAlphaVantage({ key: '', fetch: async () => jsonRes({}) }).configured, false);
});

test('Frankfurter: AUD per USD', async () => {
  const seen = [];
  const fx = createFrankfurter({ fetch: async (u) => { seen.push(String(u)); return jsonRes({ amount: 1, base: 'USD', date: '2026-10-16', rates: { AUD: 1.437 } }); } });
  assert.equal(await fx.rate('USD'), 1.437);
  assert.match(seen[0], /base=USD/);
  assert.match(seen[0], /symbols=AUD/);
  await assert.rejects(createFrankfurter({ fetch: async () => jsonRes({ rates: {} }) }).rate('USD'), /rate/i);
});

// ---------- Yahoo Finance and per-exchange routing ----------

const yahooBody = (meta, closes) => ({ chart: { result: [{ meta, indicators: { quote: [{ close: closes ?? [] }] } }], error: null } });

test('Yahoo: chart meta mapped to price, previous close and time, ASX as .AX, sub-dollar precision kept', async () => {
  const seen = [];
  const fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: opts?.headers });
    return jsonRes(yahooBody({ regularMarketPrice: 0.048, chartPreviousClose: 0.049, regularMarketTime: 1_792_000_000, currency: 'AUD' }, [0.049, 0.05000000074505806, 0.04699999839067459, 0.048]));
  };
  const y = createYahoo({ fetch });
  assert.equal(y.configured, true);
  assert.equal(y.name, 'Yahoo Finance');
  const q = await y.quote('TKM', 'ASX');
  assert.equal(q.price, 0.048);
  assert.equal(q.prevClose, 0.047); // yesterday's bar, not chartPreviousClose (the close before the whole range)
  assert.equal(q.currency, 'AUD');
  assert.equal(q.asOf, new Date(1_792_000_000_000).toISOString());
  assert.match(seen[0].url, /\/chart\/TKM\.AX\?range=5d&interval=1d$/);
  assert.match(seen[0].headers['User-Agent'], /^Mozilla\/5\.0$/);
  const us = await y.quote('AAPL', 'US');
  assert.equal(us.currency, 'USD');
  assert.match(seen[1].url, /\/chart\/AAPL\?/);
});

test('Yahoo: previous close skips null bars, uses meta.previousClose when there is one bar, else null (never chartPreviousClose)', async () => {
  const y = createYahoo({ fetch: async () => jsonRes(yahooBody({ regularMarketPrice: 0.048 }, [0.04, null, 0.046, 0.048])) });
  assert.equal((await y.quote('TKM', 'ASX')).prevClose, 0.046);
  const one = createYahoo({ fetch: async () => jsonRes(yahooBody({ regularMarketPrice: 0.048, previousClose: 0.044, chartPreviousClose: 0.09 }, [0.048])) });
  assert.equal((await one.quote('TKM', 'ASX')).prevClose, 0.044);
  const none = createYahoo({ fetch: async () => jsonRes(yahooBody({ regularMarketPrice: 0.048, chartPreviousClose: 0.09 })) });
  assert.equal((await none.quote('TKM', 'ASX')).prevClose, null);
});

test('Yahoo: empty, malformed, non-positive, 429, 403 and network failures become short errors, never a bad price', async () => {
  const mk = (body, status) => createYahoo({ fetch: async () => jsonRes(body, status) });
  await assert.rejects(mk({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }).quote('NOPE', 'ASX'), /no quote for NOPE \(Yahoo had no price: No data found/);
  await assert.rejects(mk({}).quote('TKM', 'ASX'), /Yahoo had no price/);
  await assert.rejects(mk(yahooBody({ regularMarketPrice: 0 })).quote('TKM', 'ASX'), /Yahoo had no price/);
  await assert.rejects(mk(yahooBody({ regularMarketPrice: -1 })).quote('TKM', 'ASX'), /Yahoo had no price/);
  await assert.rejects(mk(yahooBody({ regularMarketPrice: '0.048' })).quote('TKM', 'ASX'), /Yahoo had no price/);
  await assert.rejects(mk(yahooBody({ regularMarketPrice: Number.NaN })).quote('TKM', 'ASX'), /Yahoo had no price/);
  await assert.rejects(mk({}, 429).quote('TKM', 'ASX'), /rate limiting/);
  await assert.rejects(mk({}, 403).quote('TKM', 'ASX'), /403/);
  await assert.rejects(mk({}, 500).quote('TKM', 'ASX'), /HTTP 500/);
  const html = createYahoo({ fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }) });
  await assert.rejects(html.quote('TKM', 'ASX'), /not JSON/);
  const down = createYahoo({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  await assert.rejects(down.quote('TKM', 'ASX'), /Yahoo Finance unreachable: getaddrinfo/);
});

function routed({ av = true, yahooFetch } = {}) {
  const avCalls = [];
  const yCalls = [];
  const avSrc = createAlphaVantage({ key: av ? 'KEY' : '', fetch: async (u) => { avCalls.push(String(u)); return jsonRes({ 'Global Quote': { '05. price': '200.00', '08. previous close': '198.00' } }); } });
  const ySrc = createYahoo({ fetch: yahooFetch ?? (async (u) => { yCalls.push(String(u)); return jsonRes(yahooBody({ regularMarketPrice: 0.048 }, [0.046, 0.045, 0.048])); }) });
  const source = createPriceRouter({ US: avSrc, ASX: ySrc }, { fx: async () => 1.5 });
  return { source, avCalls, yCalls };
}

test('routing: ASX goes to Yahoo, US stays on Alpha Vantage, and each row records its own source name', async () => {
  const { db } = book();
  createHolding(db, { ticker: 'TKM', exchange: 'ASX', units: 1000, avg_cost: 0.04 });
  createHolding(db, { ticker: 'AAPL', exchange: 'US', units: 1, avg_cost: 1 });
  const { source, avCalls, yCalls } = routed();
  const { q, clock } = svc(db, source);
  clock.now = at('2026-10-14T15:00:00Z'); // both markets open? ASX is shut, so force
  const r = await q.refresh({ force: true });
  assert.equal(r.fetched, 2);
  assert.equal(yCalls.length, 1);
  assert.match(yCalls[0], /TKM\.AX/);
  assert.equal(avCalls.length, 1);
  assert.match(avCalls[0], /symbol=AAPL/);
  const p = portfolio(db, { now: clock.now });
  const tkm = p.holdings.find((h) => h.ticker === 'TKM');
  assert.equal(tkm.price.source, 'Yahoo Finance');
  assert.equal(tkm.price.value, 0.048);
  assert.equal(tkm.value, 4800); // 1000 units at $0.048, in cents, not rounded to $0.05
  assert.equal(tkm.day_change, 300); // 1000 x (0.048 - 0.045)
  assert.equal(p.holdings.find((h) => h.ticker === 'AAPL').price.source, 'Alpha Vantage');
  assert.equal(q.status().source, 'Alpha Vantage and Yahoo Finance');
});

test('Yahoo quotes do not spend the Alpha Vantage daily budget, and a spent budget still lets ASX price', async () => {
  const { db } = book();
  createHolding(db, { ticker: 'TKM', exchange: 'ASX', units: 1, avg_cost: 1 });
  createHolding(db, { ticker: 'AAPL', exchange: 'US', units: 1, avg_cost: 1 });
  const { source, avCalls, yCalls } = routed();
  const { q } = svc(db, source, { cap: 1 });
  await q.refresh({ force: true });
  assert.equal(q.status().calls_today, 1); // only AAPL
  const second = await q.refresh({ force: true });
  assert.equal(second.capped, true);
  assert.equal(second.fetched, 1); // TKM went through the shut Alpha Vantage budget
  assert.equal(avCalls.length, 1);
  assert.equal(yCalls.length, 2);
  assert.equal(q.status().calls_today, 1);
});

test('Yahoo polls on the plain 15 minute gap even when the Alpha Vantage budget widens its own', async () => {
  const { db } = book();
  for (const t of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH']) createHolding(db, { ticker: t, exchange: 'ASX', units: 1, avg_cost: 1 });
  const { source, yCalls } = routed();
  const { q, clock } = svc(db, source, { cap: 25 });
  await q.refresh();
  assert.equal(yCalls.length, 8);
  clock.now = at('2026-10-14T03:16:00Z');
  assert.equal((await q.refresh()).fetched, 8);
});

test('ASX prices with no Alpha Vantage key, and the setup note only applies to exchanges that lack a source', async () => {
  const { db } = book();
  createHolding(db, { ticker: 'TKM', exchange: 'ASX', units: 1000, avg_cost: 0.04 });
  const { source, avCalls } = routed({ av: false });
  const { q, clock } = svc(db, source);
  const r = await q.refresh();
  assert.equal(r.fetched, 1);
  assert.equal(r.skipped, null);
  assert.equal(avCalls.length, 0);
  assert.equal(q.status().configured, true);
  assert.equal(q.status().note, null);
  assert.equal(portfolio(db, { now: clock.now }).holdings[0].priced, true);

  createHolding(db, { ticker: 'AAPL', exchange: 'US', units: 1, avg_cost: 1 });
  assert.match(q.status().note, /ALPHAVANTAGE_API_KEY/);
  clock.now = at('2026-10-14T03:30:00Z');
  const r2 = await q.refresh({ force: true });
  assert.equal(r2.fetched, 1); // TKM again, AAPL skipped for want of a source
  assert.equal(r2.failed, 0);
  assert.equal(avCalls.length, 0);
});

test('a US-only book with no Alpha Vantage key says not configured and makes no calls', async () => {
  const { db } = book();
  createHolding(db, { ticker: 'AAPL', exchange: 'US', units: 1, avg_cost: 1 });
  const { source, avCalls, yCalls } = routed({ av: false });
  const { q } = svc(db, source);
  const r = await q.refresh({ force: true });
  assert.equal(r.skipped, 'not configured');
  assert.equal(r.fetched, 0);
  assert.equal(avCalls.length + yCalls.length, 0);
  assert.match(q.status().note, /ALPHAVANTAGE_API_KEY/);
});

test('a Yahoo 429 is recorded as a quote error and refresh() resolves, keeping the last price', async () => {
  const { db } = book();
  createHolding(db, { ticker: 'TKM', exchange: 'ASX', units: 1000, avg_cost: 0.04 });
  recordQuote(db, { ticker: 'TKM', exchange: 'ASX', price: 0.047, prevClose: 0.045, currency: 'AUD', source: 'Yahoo Finance', fetchedAt: '2026-10-14T02:00:00.000Z' });
  const { source } = routed({ yahooFetch: async () => jsonRes({}, 429) });
  const { q, clock } = svc(db, source);
  const r = await q.refresh({ force: true });
  assert.equal(r.failed, 1);
  const h = portfolio(db, { now: clock.now }).holdings[0];
  assert.equal(h.price.value, 0.047);
  assert.equal(h.price.stale, true);
  assert.match(q.status().last_error, /rate limiting/);
});
