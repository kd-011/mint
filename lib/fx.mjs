// Exchange rates, AUD per one unit of a currency, from Frankfurter (ECB rates,
// keyless). One client for the whole app: the share prices' USD rate
// (lib/quotes.mjs) and the manual foreign-currency accounts (lib/manual.mjs).
//
// Rates are kept per currency per ECB date in fx_rates. A date takes the
// nearest earlier rate (the ECB skips weekends and holidays). When a write
// needs dates the cache does not cover, one open-ended range call fetches them
// all, so a CSV import of any size costs one request. Offline, the last known
// rate stands in and status() says how old it is. With no rate at all the
// caller refuses to save: Mint never invents a rate. The currency list comes
// from Frankfurter too (cached a week), never a typed list.
import { HttpError, bad } from './errors.mjs';
import { getSetting, setSetting } from './db.mjs';
import { zoneDate, addDays, daysBetween } from './dates.mjs';

export const FX_SOURCE = 'Frankfurter (ECB)';
export const FX_BASE = 'https://api.frankfurter.dev/v1';
const COVER_DAYS = 7; // a rate this close before a date covers it (weekends, Easter)
export const STALE_DAYS = 4; // older than this and the screen says which date the rate is from
const REFRESH_MS = 6 * 3600_000;
const LIST_MS = 7 * 24 * 3600_000;

const num = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function createFrankfurter({ fetch = globalThis.fetch, base = FX_BASE } = {}) {
  async function getJson(path, { missingOk = false } = {}) {
    let res;
    try { res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) }); } catch (e) { throw new Error(`Frankfurter unreachable: ${e?.message ?? e}`); }
    if (res.status === 404 && missingOk) return null;
    if (!res.ok) throw new Error(`Frankfurter returned HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new Error('Frankfurter sent something that is not JSON');
    return body;
  }
  return {
    // AUD per one `from` today (the share prices' wiring).
    async rate(from = 'USD') {
      const r = num((await getJson(`/latest?base=${encodeURIComponent(from)}&symbols=AUD`))?.rates?.AUD);
      if (r == null) throw new Error('Frankfurter sent no AUD rate');
      return r;
    },
    async latest(cur) {
      const b = await getJson(`/latest?base=${encodeURIComponent(cur)}&symbols=AUD`);
      const rate = num(b?.rates?.AUD);
      if (rate == null || !/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '')) throw new Error(`Frankfurter sent no AUD rate for ${cur}`);
      return { date: b.date, rate };
    },
    // Every ECB day from `from` (or the working day before it) to the latest. [] when it has none.
    async range(cur, from) {
      const b = await getJson(`/${from}..?base=${encodeURIComponent(cur)}&symbols=AUD`, { missingOk: true });
      if (!b) return [];
      return Object.entries(b.rates ?? {}).map(([date, r]) => ({ date, rate: num(r?.AUD) })).filter((r) => r.rate != null && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
    },
    async currencies() {
      const b = await getJson('/currencies');
      const out = Object.entries(b).filter(([code, name]) => /^[A-Z]{3}$/.test(code) && typeof name === 'string');
      if (!out.length) throw new Error('Frankfurter sent an empty currency list');
      return Object.fromEntries(out);
    },
  };
}

export function storeRates(db, currency, rows, { source = FX_SOURCE, fetchedAt = new Date().toISOString() } = {}) {
  const up = db.prepare(`INSERT INTO fx_rates (currency, date, rate, source, fetched_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(currency, date) DO UPDATE SET rate = excluded.rate, source = excluded.source, fetched_at = excluded.fetched_at`);
  for (const r of rows) up.run(currency, r.date, r.rate, source, fetchedAt);
  return rows.length;
}

// The rate a date converts at: the nearest one on or before it. AUD is 1.
export function rateOn(db, currency, date) {
  if (currency === 'AUD') return { rate: 1, date };
  const r = db.prepare('SELECT date, rate FROM fx_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1').get(currency, date);
  return r ? { rate: r.rate, date: r.date } : null;
}

// Native hundredths to AUD cents, half away from zero so a refund mirrors its charge.
export const toAud = (native, rate) => Math.sign(native) * Math.round(Math.abs(native) * rate);

const covered = (db, currency, date) => currency === 'AUD'
  || !!db.prepare('SELECT 1 FROM fx_rates WHERE currency = ? AND date BETWEEN ? AND ? LIMIT 1').get(currency, addDays(date, -COVER_DAYS), date);

// onRates runs after new rates land (lib/manual.mjs re-converts rows that were
// saved on an older stand-in rate). A failure there is logged, never thrown.
export function createFx({ db, client = createFrankfurter(), now = () => new Date(), log = console.log, onRates = null }) {
  const today = () => zoneDate(now());
  const errKey = (cur) => `fx_error:${cur}`;
  const landed = (cur, rows) => {
    if (!rows.length) return;
    storeRates(db, cur, rows, { fetchedAt: now().toISOString() });
    setSetting(db, errKey(cur), null);
    try { onRates?.(cur); } catch (e) { log(`fx: re-converting after new ${cur} rates failed: ${e?.stack ?? e}`); }
  };
  const failed = (cur, e) => {
    const message = String(e?.message ?? e).slice(0, 200);
    setSetting(db, errKey(cur), JSON.stringify({ at: now().toISOString(), message }));
    log(`fx ${cur}: ${message}`);
    return message;
  };

  async function currencies() {
    let cache = null;
    try { cache = JSON.parse(getSetting(db, 'fx_currencies') ?? 'null'); } catch {}
    const fresh = cache && now() - Date.parse(cache.at) < LIST_MS;
    if (!fresh) {
      try {
        const list = await client.currencies();
        list.AUD ??= 'Australian Dollar';
        cache = { at: now().toISOString(), list };
        setSetting(db, 'fx_currencies', JSON.stringify(cache));
      } catch (e) {
        if (!cache) throw new HttpError(503, `Couldn't load the currency list from Frankfurter: ${e?.message ?? e}`);
        log(`fx: currency list refresh failed, using the copy from ${cache.at}: ${e?.message ?? e}`);
      }
    }
    const items = Object.entries(cache.list).map(([code, name]) => ({ code, name })).sort((a, b) => a.code.localeCompare(b.code));
    return { items, fetched_at: cache.at, stale: !fresh && now() - Date.parse(cache.at) >= LIST_MS };
  }

  async function checkCurrency(code) {
    const s = String(code ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(s)) throw bad('currency must be a three letter code like USD');
    const { items } = await currencies();
    if (!items.some((c) => c.code === s)) throw bad(`${s} is not a currency Frankfurter (ECB) publishes rates for`);
    return s;
  }

  // Makes sure every date has a rate within a week before it, in one call.
  // Never throws: { error } says why it could not fetch, and the write then
  // uses the last known rate or refuses.
  async function ensure(currency, dates) {
    const missing = [...new Set(dates)].filter((d) => !covered(db, currency, d));
    if (!missing.length) return { fetched: false, error: null };
    const from = addDays(missing.sort()[0], -COVER_DAYS);
    try {
      landed(currency, await client.range(currency, from));
      setSetting(db, `fx_try:${currency}`, now().toISOString());
      return { fetched: true, error: null };
    } catch (e) { return { fetched: false, error: failed(currency, e) }; }
  }

  // The latest rate for every currency a live manual account uses, every 6 hours.
  async function refreshLatest({ force = false } = {}) {
    const list = db.prepare("SELECT DISTINCT currency FROM accounts WHERE manual = 1 AND currency != 'AUD' AND status IS NOT 'gone' ORDER BY currency").all().map((r) => r.currency);
    const out = { currencies: list, fetched: 0, failed: 0 };
    for (const cur of list) {
      const last = Date.parse(getSetting(db, `fx_try:${cur}`) ?? '') || 0;
      if (!force && now() - last < REFRESH_MS) continue;
      setSetting(db, `fx_try:${cur}`, now().toISOString());
      try {
        const r = await client.latest(cur);
        landed(cur, [r]);
        out.fetched += 1;
      } catch (e) { failed(cur, e); out.failed += 1; }
    }
    return out;
  }

  // What a screen says about a currency's rate: the rate, its date, whether it is
  // old, and the last error when the latest attempt failed.
  function status(currency) {
    const r = rateOn(db, currency, today());
    let err = null;
    try { err = JSON.parse(getSetting(db, errKey(currency)) ?? 'null'); } catch {}
    return {
      currency, rate: r?.rate ?? null, date: r?.date ?? null,
      stale: currency !== 'AUD' && (!r || daysBetween(r.date, today()) > STALE_DAYS),
      error: err?.message ?? null, source: FX_SOURCE,
    };
  }

  return { currencies, checkCurrency, ensure, refreshLatest, status };
}
