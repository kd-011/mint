// Shares and ETFs: hand-entered holdings, purchase lots, cached quotes with a
// stale flag and a manual override, the portfolio totals and allocation, the
// daily snapshots, and how the holdings join net worth in place of a manual
// 'shares' asset without counting it twice. No network: quotes are written
// straight into the cache the way the quote service does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { createAsset, addSnapshot, netWorth, netWorthHistory, listAssets } from '../lib/networth.mjs';
import { createHolding, updateHolding, deleteHolding, restoreHolding, addLot, updateLot, deleteLot, portfolio, snapshotPortfolio, portfolioHistory, decideShares } from '../lib/holdings.mjs';
import { recordQuote, recordQuoteError } from '../lib/quotes.mjs';

// Wed 14 Oct 2026, 14:00 in Sydney (ASX open), 23:00 the night before in New York (US closed).
const NOW = new Date('2026-10-14T03:00:00Z');
const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();
const quote = (db, ticker, price, prev, { exchange = 'ASX', min = 5, currency = exchange === 'US' ? 'USD' : 'AUD' } = {}) =>
  recordQuote(db, { ticker, exchange, price, prevClose: prev, currency, source: 'fake', fetchedAt: ago(min) });
const fx = (db, rate, min = 5) => recordQuote(db, { ticker: 'USD', exchange: 'FX', price: rate, prevClose: null, currency: 'AUD', source: 'fake', fetchedAt: ago(min) });
const view = (db, id) => portfolio(db, { now: NOW }).holdings.find((h) => h.id === id);

test('a holding without a price yet is valued at cost and says so', () => {
  const { db } = book();
  const h = createHolding(db, { ticker: 'vas', exchange: 'ASX', units: 100, avg_cost: 90 });
  assert.equal(h.ticker, 'VAS');
  assert.equal(h.asset_class, 'au_shares');
  const v = view(db, h.id);
  assert.equal(v.cost, 900000);
  assert.equal(v.value, 900000);
  assert.equal(v.priced, false);
  assert.equal(v.gain, 0);
  assert.equal(v.price.source, null);
});

test('value, day change and gain against cost come from the cached quote', () => {
  const { db } = book();
  const h = createHolding(db, { ticker: 'VAS', exchange: 'ASX', units: 100, avg_cost: 90, asset_class: 'etf' });
  quote(db, 'VAS', 108.86, 107.78);
  const v = view(db, h.id);
  assert.equal(v.value, 1088600);
  assert.equal(v.day_change, 10800);
  assert.equal(v.gain, 188600);
  assert.equal(v.gain_pct, 0.2096);
  assert.equal(v.price.value, 108.86);
  assert.equal(v.price.source, 'fake');
  assert.equal(v.price.stale, false);
  assert.equal(v.priced, true);
});

test('purchase lots set units and the cost base, brokerage included', () => {
  const { db } = book();
  const h = createHolding(db, { ticker: 'VGS', exchange: 'ASX', asset_class: 'etf', lots: [
    { date: '2025-01-10', units: 10, price: 100, brokerage: 995 },
    { date: '2025-06-10', units: 30, price: 110, brokerage: 995 },
  ] });
  let v = view(db, h.id);
  assert.equal(v.units, 40);
  assert.equal(v.cost, 10 * 10000 + 30 * 11000 + 1990); // 1000 + 3300 + 19.90
  assert.equal(v.avg_cost, 107.9975); // (1000 + 3300 + 19.90) / 40
  assert.equal(v.lots.length, 2);
  const lot = v.lots.find((l) => l.date === '2025-06-10');
  updateLot(db, h.id, lot.id, { units: 20 });
  v = view(db, h.id);
  assert.equal(v.units, 30);
  assert.equal(v.cost, 10 * 10000 + 20 * 11000 + 1990);
  deleteLot(db, h.id, lot.id);
  v = view(db, h.id);
  assert.equal(v.units, 10);
  addLot(db, h.id, { date: '2026-01-01', units: 5, price: 120 });
  assert.equal(view(db, h.id).units, 15);
});

test('units and average cost cannot be edited by hand once lots define them', () => {
  const { db } = book();
  const h = createHolding(db, { ticker: 'VGS', exchange: 'ASX', lots: [{ date: '2025-01-10', units: 10, price: 100 }] });
  assert.throws(() => updateHolding(db, h.id, { units: 99 }), /lots/);
  const plain = createHolding(db, { ticker: 'NDQ', exchange: 'ASX', units: 5, avg_cost: 40 });
  assert.equal(updateHolding(db, plain.id, { units: 8, avg_cost: 41.5 }).units, 8);
  addLot(db, plain.id, { date: '2026-02-02', units: 2, price: 50 });
  assert.equal(view(db, plain.id).units, 2); // the lot ledger replaces the typed totals
});

test('a manual price beats the quote and clearing it hands back to the quote', () => {
  const { db } = book();
  const h = createHolding(db, { ticker: 'BHP', exchange: 'ASX', units: 10, avg_cost: 40 });
  quote(db, 'BHP', 45, 44);
  updateHolding(db, h.id, { manual_price: 50 });
  let v = view(db, h.id);
  assert.equal(v.value, 50000);
  assert.equal(v.price.source, 'manual');
  assert.equal(v.price.stale, false);
  assert.equal(v.day_change, null);
  updateHolding(db, h.id, { manual_price: null });
  v = view(db, h.id);
  assert.equal(v.value, 45000);
  assert.equal(v.price.source, 'fake');
});

test('stale: old while the market is open, or the last fetch failed, with the last price kept', () => {
  const { db } = book();
  const h = createHolding(db, { ticker: 'CBA', exchange: 'ASX', units: 10, avg_cost: 100 });
  quote(db, 'CBA', 150, 149, { min: 120 });
  let v = view(db, h.id);
  assert.equal(v.price.stale, true);
  assert.equal(v.value, 150000);
  assert.match(v.price.note, /2 hours ago|120 minutes|2h/i);
  quote(db, 'CBA', 150, 149, { min: 5 });
  assert.equal(view(db, h.id).price.stale, false);
  recordQuoteError(db, 'CBA', 'ASX', 'Alpha Vantage: rate limit reached', ago(1));
  v = view(db, h.id);
  assert.equal(v.price.stale, true);
  assert.equal(v.price.value, 150);
  assert.match(v.price.note, /rate limit reached/);
  assert.match(v.price.note, /last price/i);
});

test('a closed market is not stale just because time has passed overnight', () => {
  const { db } = book();
  const h = createHolding(db, { ticker: 'AAPL', exchange: 'US', units: 2, avg_cost: 150 });
  quote(db, 'AAPL', 200, 198, { exchange: 'US', min: 600 });
  fx(db, 1.5, 600);
  assert.equal(view(db, h.id).price.stale, false);
});

test('US holdings convert to AUD at the cached rate; no rate means they are flagged, not guessed', () => {
  const { db } = book();
  const h = createHolding(db, { ticker: 'AAPL', exchange: 'US', units: 10, avg_cost: 100 });
  assert.equal(h.asset_class, 'international');
  quote(db, 'AAPL', 200, 190, { exchange: 'US', min: 30 });
  let v = view(db, h.id);
  assert.equal(v.fx_missing, true);
  assert.equal(portfolio(db, { now: NOW }).totals.value, 0);
  fx(db, 1.5);
  v = view(db, h.id);
  assert.equal(v.fx_missing, false);
  assert.equal(v.currency, 'USD');
  assert.equal(v.value, 300000); // 10 x 200 USD x 1.5
  assert.equal(v.cost, 150000);
  assert.equal(v.gain, 150000);
  assert.equal(v.day_change, 15000);
});

test('totals and allocation by holding and by asset class, with cash and super from the book', () => {
  const { db } = book();
  const a = createHolding(db, { ticker: 'BHP', exchange: 'ASX', units: 100, avg_cost: 40 });
  const b = createHolding(db, { ticker: 'VAS', exchange: 'ASX', units: 100, avg_cost: 90, asset_class: 'etf' });
  const c = createHolding(db, { ticker: 'AAPL', exchange: 'US', units: 10, avg_cost: 100 });
  quote(db, 'BHP', 50, 49); quote(db, 'VAS', 100, 99);
  quote(db, 'AAPL', 200, 190, { exchange: 'US', min: 30 }); fx(db, 1.5);
  const sup = createAsset(db, { name: 'Test Super', kind: 'super' });
  addSnapshot(db, sup.id, { date: '2026-10-01', value: 5000000 });
  const p = portfolio(db, { now: NOW });
  assert.equal(p.totals.value, 500000 + 1000000 + 300000);
  assert.equal(p.totals.cost, 400000 + 900000 + 150000);
  assert.equal(p.totals.gain, p.totals.value - p.totals.cost);
  assert.equal(p.totals.day_change, 10000 + 10000 + 15000);
  assert.equal(p.totals.count, 3);
  const byH = p.allocation.by_holding;
  assert.deepEqual(byH.map((x) => x.ticker), ['AAPL', 'BHP', 'VAS'].sort((x, y) => byH.find((i) => i.ticker === y).value - byH.find((i) => i.ticker === x).value));
  assert.ok(Math.abs(byH.reduce((s, x) => s + x.pct, 0) - 1) < 1e-3);
  const cls = Object.fromEntries(p.allocation.by_class.map((x) => [x.class, x.value]));
  assert.equal(cls.au_shares, 500000);
  assert.equal(cls.etf, 1000000);
  assert.equal(cls.international, 300000);
  assert.equal(cls.super, 5000000);
  assert.equal(cls.cash, 100000 + 500000 + 2500000 + 300000); // every cash account in the fixture book
  assert.ok(Math.abs(p.allocation.by_class.reduce((s, x) => s + x.pct, 0) - 1) < 1e-3);
  void a; void b; void c;
});

test('daily snapshots: one row a day, upserted, and gone-quiet days are not invented', () => {
  const { db } = book();
  const h = createHolding(db, { ticker: 'BHP', exchange: 'ASX', units: 10, avg_cost: 40 });
  quote(db, 'BHP', 50, 49);
  snapshotPortfolio(db, { today: '2026-10-13', now: NOW });
  quote(db, 'BHP', 52, 50);
  snapshotPortfolio(db, { today: '2026-10-14', now: NOW });
  snapshotPortfolio(db, { today: '2026-10-14', now: NOW });
  const hist = portfolioHistory(db);
  assert.deepEqual(hist.map((r) => r.date), ['2026-10-13', '2026-10-14']);
  assert.deepEqual(hist.map((r) => r.value), [50000, 52000]);
  assert.equal(hist[1].cost, 40000);
  deleteHolding(db, h.id);
  snapshotPortfolio(db, { today: '2026-10-14', now: NOW });
  assert.deepEqual(portfolioHistory(db).map((r) => r.date), ['2026-10-13']);
});

test('delete returns a record that restores the holding with its lots', () => {
  const { db } = book();
  const h = createHolding(db, { ticker: 'VGS', exchange: 'ASX', asset_class: 'etf', lots: [{ date: '2025-01-10', units: 10, price: 100, brokerage: 500 }] });
  updateHolding(db, h.id, { manual_price: 120 });
  const { record } = deleteHolding(db, h.id);
  assert.equal(portfolio(db, { now: NOW }).holdings.length, 0);
  const back = restoreHolding(db, record);
  const v = view(db, back.id);
  assert.equal(v.ticker, 'VGS');
  assert.equal(v.units, 10);
  assert.equal(v.lots.length, 1);
  assert.equal(v.price.source, 'manual');
  assert.equal(v.cost, 100500);
  assert.throws(() => restoreHolding(db, record), /already/i);
});

test('validation: ticker, exchange, units, cost, lots and duplicates are refused', () => {
  const { db } = book();
  const bad = (body, re) => assert.throws(() => createHolding(db, body), re);
  bad({ ticker: '', exchange: 'ASX', units: 1, avg_cost: 1 }, /ticker/i);
  bad({ ticker: 'A B', exchange: 'ASX', units: 1, avg_cost: 1 }, /ticker/i);
  bad({ ticker: 'VAS', exchange: 'LSE', units: 1, avg_cost: 1 }, /exchange/i);
  bad({ ticker: 'VAS', exchange: 'ASX', units: 0, avg_cost: 1 }, /units/i);
  bad({ ticker: 'VAS', exchange: 'ASX', units: 1, avg_cost: -1 }, /cost/i);
  bad({ ticker: 'VAS', exchange: 'ASX', units: 1, avg_cost: 1, asset_class: 'bonds' }, /asset_class/i);
  bad({ ticker: 'VAS', exchange: 'ASX', lots: [{ date: 'nope', units: 1, price: 1 }] }, /date/i);
  bad({ ticker: 'VAS', exchange: 'ASX', lots: [{ date: '2025-01-01', units: 0, price: 1 }] }, /units/i);
  createHolding(db, { ticker: 'VAS', exchange: 'ASX', units: 1, avg_cost: 1 });
  bad({ ticker: 'vas', exchange: 'ASX', units: 2, avg_cost: 1 }, /already/i);
  createHolding(db, { ticker: 'VAS', exchange: 'US', units: 2, avg_cost: 1 }); // same ticker on another exchange is a different holding
});

// net worth

function nwBook() {
  const b = book();
  const shares = createAsset(b.db, { name: 'Old manual shares', kind: 'shares' });
  addSnapshot(b.db, shares.id, { date: '2026-09-01', value: 2000000 });
  addSnapshot(b.db, shares.id, { date: '2026-10-01', value: 3000000 });
  return { ...b, shares };
}

test('net worth counts holdings; the old manual shares asset keeps counting until there are holdings', () => {
  const { db, shares } = nwBook();
  const before = netWorth(db);
  assert.equal(before.groups.investments, 3000000);
  const h = createHolding(db, { ticker: 'BHP', exchange: 'ASX', units: 100, avg_cost: 40 });
  quote(db, 'BHP', 50, 49);
  const nw = netWorth(db);
  assert.equal(nw.holdings.value, 500000);
  assert.equal(nw.groups.investments, 500000, 'the undecided manual asset is not counted on top of the holdings');
  assert.equal(nw.assets, before.assets - 3000000 + 500000);
  const m = nw.manual.find((x) => x.id === shares.id);
  assert.equal(m.counted, false);
  assert.equal(m.superseded, true);
  void h;
});

test('the one-time prompt: keep counts the manual asset again, convert archives it', () => {
  const { db, shares } = nwBook();
  createHolding(db, { ticker: 'BHP', exchange: 'ASX', units: 100, avg_cost: 40 });
  quote(db, 'BHP', 50, 49);
  assert.equal(portfolio(db, { now: NOW }).prompts.length, 1);
  assert.equal(portfolio(db, { now: NOW }).prompts[0].asset_id, shares.id);
  assert.equal(listAssets(db).find((a) => a.id === shares.id).due, false, 'a replaced asset is not nudged for a monthly value');
  decideShares(db, shares.id, 'keep');
  assert.equal(netWorth(db).groups.investments, 3500000);
  assert.equal(portfolio(db, { now: NOW }).prompts.length, 0);
  decideShares(db, shares.id, 'convert');
  assert.equal(netWorth(db).groups.investments, 500000);
  assert.equal(listAssets(db).some((a) => a.id === shares.id), false);
  assert.equal(listAssets(db, { includeArchived: true }).find((a) => a.id === shares.id).value, 3000000, 'its history is kept');
  assert.throws(() => decideShares(db, shares.id, 'maybe'), /keep or convert/i);
  const other = createAsset(db, { name: 'A boat', kind: 'other' });
  assert.throws(() => decideShares(db, other.id, 'keep'), /shares/i);
});

test('net worth history keeps the manual shares values before holdings began, and no double count after', () => {
  const { db, shares } = nwBook();
  createHolding(db, { ticker: 'BHP', exchange: 'ASX', units: 100, avg_cost: 40 });
  quote(db, 'BHP', 50, 49);
  db.prepare("INSERT INTO balance_snapshots (account_id, date, current) VALUES ('acct_t_everyday', '2026-09-01', 100000), ('acct_t_everyday', '2026-10-13', 100000), ('acct_t_everyday', '2026-10-14', 100000)").run();
  snapshotPortfolio(db, { today: '2026-10-13', now: NOW });
  snapshotPortfolio(db, { today: '2026-10-14', now: NOW });
  decideShares(db, shares.id, 'convert');
  const h = Object.fromEntries(netWorthHistory(db).map((r) => [r.date, r.assets]));
  assert.equal(h['2026-09-01'], 100000 + 2000000, 'before holdings: the manual value');
  assert.equal(h['2026-10-01'], 100000 + 3000000);
  assert.equal(h['2026-10-13'], 100000 + 500000, 'from the first snapshot: the holdings, not the manual value as well');
  assert.equal(h['2026-10-14'], 100000 + 500000);
});
