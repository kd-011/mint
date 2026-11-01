// Shares and ETFs, entered by hand. A holding is a ticker on an exchange with
// units and an average cost, or with purchase lots (date, units, price,
// brokerage) from which both are derived. Prices come from the quote cache
// (lib/quotes.mjs) or a manual override; this file never goes to the network.
//
// Units are not cents: unit prices are dollars (REAL, they can be sub-cent) and
// brokerage is whole cents. Everything Mint adds up (value, cost, gain, day
// change) is whole AUD cents. US holdings are priced in USD and converted at
// the cached AUD per USD rate; cost is converted at that same rate (Mint holds
// no rate history), so a US gain includes currency movement only from today.
import { bad, notFound } from './errors.mjs';
import { tx } from './db.mjs';
import { isIsoDate, zoneDate } from './dates.mjs';
import { isOpen, EXCHANGES, currencyOf } from './market.mjs';
import { fetchGapMs, GAP_MS } from './quotes.mjs';

export const ASSET_CLASSES = { au_shares: 'AU shares', international: 'International', etf: 'ETFs', cash: 'Cash', super: 'Super' };
const HOLDING_CLASSES = ['au_shares', 'international', 'etf'];
const STALE_CLOSED_MS = 4 * 24 * 3600_000; // Friday close to a long-weekend Tuesday
const r4 = (x) => Math.round(x * 10000) / 10000;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

const defaultClass = (exchange) => (exchange === 'US' ? 'international' : 'au_shares');

function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return m === 1 ? '1 minute' : `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? '1 hour' : `${h} hours`;
  const d = Math.round(h / 24);
  return `${d} days`;
}

// ---------- reading rows ----------

function lotsOf(db, id) {
  return db.prepare('SELECT id, date, units, price, brokerage FROM holding_lots WHERE holding_id = ? ORDER BY date, id').all(id);
}

function getRow(db, id) {
  const h = Number.isInteger(id) ? db.prepare('SELECT * FROM holdings WHERE id = ?').get(id) : null;
  if (!h) throw notFound('no such holding');
  return { ...h, lots: lotsOf(db, id) };
}

// ---------- validation ----------

function checkTicker(v) {
  const t = typeof v === 'string' ? v.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(t)) throw bad('ticker must be 1 to 10 letters or digits, like VAS or BRK.B');
  return t;
}
function checkExchange(v) {
  if (!EXCHANGES.includes(v)) throw bad(`exchange must be one of ${EXCHANGES.join(', ')}`);
  return v;
}
function checkClass(v) {
  if (!HOLDING_CLASSES.includes(v)) throw bad(`asset_class must be one of ${HOLDING_CLASSES.join(', ')}`);
  return v;
}
function checkUnits(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1e9) throw bad('units must be a number above zero');
  return r6(v);
}
function checkCost(v, what = 'avg_cost') {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e7) throw bad(`${what} must be a price in dollars, zero or more`);
  return r6(v);
}
function checkName(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.trim().length > 60) throw bad('name must be up to 60 characters');
  return v.trim();
}
function checkPrice(v) {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1e7) throw bad('manual_price must be a price in dollars above zero, or null to use the live price');
  return r6(v);
}
function checkLot(b = {}) {
  if (!isIsoDate(b.date)) throw bad('lot date must be YYYY-MM-DD');
  const brokerage = b.brokerage ?? 0;
  if (!Number.isInteger(brokerage) || brokerage < 0 || brokerage > 1e9) throw bad('brokerage must be whole cents, zero or more');
  return { date: b.date, units: checkUnits(b.units), price: checkCost(b.price, 'lot price'), brokerage };
}

// ---------- writes ----------

// With lots, units and the average cost (brokerage included) are theirs to say.
function syncFromLots(db, id) {
  const lots = lotsOf(db, id);
  if (!lots.length) return;
  const units = lots.reduce((s, l) => s + l.units, 0);
  const cost = lots.reduce((s, l) => s + l.units * l.price + l.brokerage / 100, 0);
  db.prepare('UPDATE holdings SET units = ?, avg_cost = ? WHERE id = ?').run(r6(units), r4(cost / units), id);
}

export function createHolding(db, body = {}, keep = {}) {
  const ticker = checkTicker(body.ticker);
  const exchange = checkExchange(body.exchange ?? 'ASX');
  const asset_class = body.asset_class == null ? defaultClass(exchange) : checkClass(body.asset_class);
  const name = checkName(body.name);
  const lots = body.lots == null ? [] : Array.isArray(body.lots) ? body.lots.slice(0, 500).map(checkLot) : (() => { throw bad('lots must be a list'); })();
  const units = lots.length ? 1 : checkUnits(body.units);
  const avg = lots.length ? 0 : checkCost(body.avg_cost);
  const manual = body.manual_price == null ? null : checkPrice(body.manual_price);
  if (db.prepare('SELECT 1 FROM holdings WHERE ticker = ? AND exchange = ?').get(ticker, exchange)) throw bad(`${ticker} on ${exchange} is already held, add a lot to it instead`);
  const id = keep.id && !db.prepare('SELECT 1 FROM holdings WHERE id = ?').get(keep.id) ? keep.id : null;
  return tx(db, () => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO holdings (id, ticker, exchange, name, asset_class, units, avg_cost, manual_price, manual_price_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ticker, exchange, name, asset_class, units, avg, manual, manual == null ? null : (keep.manual_price_at ?? new Date().toISOString()), keep.created_at ?? new Date().toISOString());
    const hid = Number(lastInsertRowid);
    const ins = db.prepare('INSERT INTO holding_lots (holding_id, date, units, price, brokerage) VALUES (?, ?, ?, ?, ?)');
    for (const l of lots) ins.run(hid, l.date, l.units, l.price, l.brokerage);
    syncFromLots(db, hid);
    return getRow(db, hid);
  });
}

export function updateHolding(db, id, body = {}) {
  const cur = getRow(db, id);
  const set = {};
  if ('name' in body) set.name = checkName(body.name);
  if ('asset_class' in body) set.asset_class = checkClass(body.asset_class);
  if ('units' in body || 'avg_cost' in body) {
    if (cur.lots.length) throw bad('this holding is built from its lots, so edit the lots instead of the units and average cost');
    if ('units' in body) set.units = checkUnits(body.units);
    if ('avg_cost' in body) set.avg_cost = checkCost(body.avg_cost);
  }
  if ('manual_price' in body) {
    set.manual_price = checkPrice(body.manual_price);
    set.manual_price_at = set.manual_price == null ? null : new Date().toISOString();
  }
  const keys = Object.keys(set);
  if (!keys.length) throw bad('nothing to change');
  db.prepare(`UPDATE holdings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), id);
  return getRow(db, id);
}

// The record is what Undo posts back to restoreHolding.
export function deleteHolding(db, id) {
  const record = getRow(db, id);
  db.prepare('DELETE FROM holdings WHERE id = ?').run(id);
  return { deleted: true, record };
}

export function restoreHolding(db, record = {}) {
  if (!record || typeof record !== 'object') throw bad('record is required');
  return createHolding(db, {
    ticker: record.ticker, exchange: record.exchange, name: record.name, asset_class: record.asset_class,
    units: record.units, avg_cost: record.avg_cost, manual_price: record.manual_price ?? null,
    lots: Array.isArray(record.lots) && record.lots.length ? record.lots : null,
  }, { id: Number.isInteger(record.id) ? record.id : null, created_at: typeof record.created_at === 'string' ? record.created_at : null, manual_price_at: typeof record.manual_price_at === 'string' ? record.manual_price_at : null });
}

export function addLot(db, holdingId, body = {}) {
  getRow(db, holdingId);
  const l = checkLot(body);
  const { lastInsertRowid } = db.prepare('INSERT INTO holding_lots (holding_id, date, units, price, brokerage) VALUES (?, ?, ?, ?, ?)').run(holdingId, l.date, l.units, l.price, l.brokerage);
  syncFromLots(db, holdingId);
  return { id: Number(lastInsertRowid), ...l };
}

function getLot(db, holdingId, lotId) {
  getRow(db, holdingId);
  const l = Number.isInteger(lotId) ? db.prepare('SELECT id, date, units, price, brokerage FROM holding_lots WHERE id = ? AND holding_id = ?').get(lotId, holdingId) : null;
  if (!l) throw notFound('no such lot');
  return l;
}

export function updateLot(db, holdingId, lotId, body = {}) {
  const cur = getLot(db, holdingId, lotId);
  const next = checkLot({ ...cur, ...body });
  db.prepare('UPDATE holding_lots SET date = ?, units = ?, price = ?, brokerage = ? WHERE id = ?').run(next.date, next.units, next.price, next.brokerage, lotId);
  syncFromLots(db, holdingId);
  return { id: lotId, ...next };
}

export function deleteLot(db, holdingId, lotId) {
  getLot(db, holdingId, lotId);
  db.prepare('DELETE FROM holding_lots WHERE id = ?').run(lotId);
  syncFromLots(db, holdingId); // with none left the last units and average cost stand
  return { deleted: true };
}

// ---------- valuation ----------

function priceOf(h, q, { at, staleAfterMs }) {
  if (h.manual_price != null) {
    return { value: h.manual_price, source: 'manual', fetched_at: h.manual_price_at, stale: false, error: null, note: `Price entered by hand${h.manual_price_at ? ` on ${h.manual_price_at.slice(0, 10)}` : ''}` };
  }
  if (!q || q.price == null) {
    return { value: null, source: null, fetched_at: null, stale: false, error: q?.error ?? null, note: q?.error ? `No price yet: ${q.error}` : 'No price yet, so it is valued at cost until one arrives or you enter one.' };
  }
  const age = at - Date.parse(q.fetched_at);
  const failed = !!q.error_at && q.error_at > q.fetched_at;
  const stale = failed || (isOpen(h.exchange, at) ? age > staleAfterMs : age > STALE_CLOSED_MS);
  let note = null;
  if (failed) note = `Last price from ${ago(age)} ago. ${q.error}`;
  else if (stale) note = `Last price from ${ago(age)} ago; it has not refreshed.`;
  return { value: q.price, source: q.source, fetched_at: q.fetched_at, stale, error: failed ? q.error : null, note };
}

function valueHolding(h, q, fxRate, ctx) {
  const usd = currencyOf(h.exchange) !== 'AUD';
  const rate = usd ? fxRate : 1;
  const fxMissing = usd && rate == null;
  const price = priceOf(h, q, ctx);
  const nativeCost = h.lots.length
    ? h.lots.reduce((s, l) => s + Math.round(l.units * l.price * 100) + l.brokerage, 0)
    : Math.round(h.units * h.avg_cost * 100);
  const cost = fxMissing ? null : Math.round(nativeCost * rate);
  const priced = price.value != null;
  let value = null;
  let dayChange = null;
  if (!fxMissing) {
    value = priced ? Math.round(h.units * price.value * 100 * rate) : cost;
    if (priced && h.manual_price == null && q?.prev_close != null) dayChange = Math.round(h.units * (price.value - q.prev_close) * 100 * rate);
  }
  const gain = value == null ? null : value - cost;
  return {
    id: h.id, ticker: h.ticker, exchange: h.exchange, currency: currencyOf(h.exchange), name: h.name, asset_class: h.asset_class,
    units: h.units, avg_cost: h.avg_cost, lots: h.lots, manual_price: h.manual_price,
    price, priced, fx_missing: fxMissing, fx_rate: usd ? rate : null,
    value, cost, gain, gain_pct: gain != null && cost > 0 ? r4(gain / cost) : null,
    day_change: dayChange,
    day_change_pct: dayChange != null && value - dayChange > 0 ? r4(dayChange / (value - dayChange)) : null,
  };
}

function cashAndSuper(db) {
  const cash = db.prepare(`SELECT COALESCE(SUM(balance_current), 0) v FROM accounts
    WHERE status IS NOT 'gone' AND hidden = 0 AND type NOT IN ('loan', 'credit-card') AND balance_current > 0`).get().v;
  const sup = db.prepare(`SELECT COALESCE(SUM((SELECT value FROM manual_snapshots s WHERE s.asset_id = m.id ORDER BY date DESC LIMIT 1)), 0) v
    FROM manual_assets m WHERE m.kind = 'super' AND m.archived = 0 AND m.is_liability = 0`).get().v;
  return { cash, super: sup };
}

// Old manual 'shares' assets that were never decided on, once holdings exist.
function shareAssets(db, { undecidedOnly }) {
  return db.prepare(`SELECT m.id asset_id, m.name, m.holdings_decision decision,
      (SELECT value FROM manual_snapshots s WHERE s.asset_id = m.id ORDER BY date DESC LIMIT 1) value,
      (SELECT max(date) FROM manual_snapshots s WHERE s.asset_id = m.id) as_of
    FROM manual_assets m WHERE m.kind = 'shares' AND m.is_liability = 0 AND m.archived = 0 ${undecidedOnly ? 'AND m.holdings_decision IS NULL' : ''} ORDER BY m.id`).all();
}

export const holdingsCount = (db) => db.prepare('SELECT count(*) n FROM holdings').get().n;

// cap is the daily quote budget: a thin budget widens the fetch gap, so the
// price is not called stale for being exactly as old as the schedule makes it.
// Only the exchanges in `budgeted` spend it; the rest poll on the plain gap.
export function portfolio(db, { now = new Date(), cap = 25, budgeted = null } = {}) {
  const rows = db.prepare('SELECT * FROM holdings ORDER BY ticker, exchange').all().map((h) => ({ ...h, lots: lotsOf(db, h.id) }));
  const quotes = new Map(db.prepare('SELECT * FROM quotes').all().map((q) => [`${q.ticker}.${q.exchange}`, q]));
  const fx = quotes.get('USD.FX')?.price ?? null;
  const spends = (h) => !budgeted || budgeted.includes(h.exchange);
  const fetchable = new Set(rows.filter((h) => h.manual_price == null && spends(h)).map((h) => `${h.ticker}.${h.exchange}`)).size;
  const budgetGap = fetchGapMs(fetchable, cap);
  const holdings = rows.map((h) => valueHolding(h, quotes.get(`${h.ticker}.${h.exchange}`), fx, { at: now.getTime(), staleAfterMs: (spends(h) ? budgetGap : GAP_MS) + 30 * 60_000 }));
  const counted = holdings.filter((h) => h.value != null);
  const sum = (k) => counted.reduce((s, h) => s + (h[k] ?? 0), 0);
  const value = sum('value');
  const cost = sum('cost');
  const dayChange = counted.reduce((s, h) => s + (h.day_change ?? 0), 0);
  const totals = {
    count: holdings.length, value, cost, gain: value - cost, gain_pct: cost > 0 ? r4((value - cost) / cost) : null,
    day_change: dayChange, day_change_pct: value - dayChange > 0 ? r4(dayChange / (value - dayChange)) : null,
    stale_count: holdings.filter((h) => h.price.stale).length,
    unpriced_count: holdings.filter((h) => !h.priced && !h.fx_missing).length,
    fx_missing_count: holdings.filter((h) => h.fx_missing).length,
  };
  const pctOf = (v, total) => (total > 0 ? r4(v / total) : 0);
  const by_holding = counted.map((h) => ({ id: h.id, ticker: h.ticker, exchange: h.exchange, name: h.name, value: h.value, pct: pctOf(h.value, value) })).sort((a, b) => b.value - a.value);
  const other = cashAndSuper(db);
  const classValue = { au_shares: 0, international: 0, etf: 0, cash: other.cash, super: other.super };
  for (const h of counted) classValue[h.asset_class] += h.value;
  const allTotal = Object.values(classValue).reduce((s, v) => s + v, 0);
  const by_class = Object.entries(classValue).map(([klass, v]) => ({ class: klass, label: ASSET_CLASSES[klass], value: v, pct: pctOf(v, allTotal) }));
  const prompts = holdings.length ? shareAssets(db, { undecidedOnly: true }).filter((a) => a.value != null).map(({ asset_id, name, value: v, as_of }) => ({ asset_id, name, value: v, as_of })) : [];
  return { holdings, totals, allocation: { by_holding, by_class }, prompts };
}

// ---------- history ----------

// One row a day, upserted whenever the portfolio is looked at or changes. With
// no holdings today's row is removed (a day with nothing held is not a zero).
export function snapshotPortfolio(db, { today = zoneDate(), now = new Date(), cap = 25 } = {}) {
  const { totals } = portfolio(db, { now, cap });
  if (!totals.count) { db.prepare('DELETE FROM portfolio_snapshots WHERE date = ?').run(today); return null; }
  db.prepare(`INSERT INTO portfolio_snapshots (date, value, cost, count) VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET value = excluded.value, cost = excluded.cost, count = excluded.count`).run(today, totals.value, totals.cost, totals.count);
  return { date: today, value: totals.value, cost: totals.cost };
}

export const portfolioHistory = (db) => db.prepare('SELECT date, value, cost FROM portfolio_snapshots ORDER BY date').all();

// ---------- the old manual shares asset ----------

// 'keep' counts it alongside the holdings (it covers shares not entered here);
// 'convert' archives it, history and all, so the holdings stand in its place.
export function decideShares(db, assetId, decision) {
  if (decision !== 'keep' && decision !== 'convert') throw bad('decision must be keep or convert');
  const a = Number.isInteger(assetId) ? db.prepare('SELECT id, kind, is_liability FROM manual_assets WHERE id = ?').get(assetId) : null;
  if (!a) throw notFound('no such asset');
  if (a.kind !== 'shares' || a.is_liability) throw bad('only a shares asset can be kept or converted to holdings');
  db.prepare('UPDATE manual_assets SET holdings_decision = ?, archived = ? WHERE id = ?').run(decision, decision === 'convert' ? 1 : 0, assetId);
  return { asset_id: assetId, decision };
}
