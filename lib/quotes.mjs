// Share prices. Mint has no brokerage feed, so a quote source is polled for the
// tickers the owner holds and the answers are cached in the `quotes` table with a
// fetched_at. If a fetch fails the last price stays and the error is recorded
// beside it; the screen shows both. Nothing here ever blocks a read: the
// portfolio is always built from the cache.
//
// Sources, routed per exchange (createPriceRouter): US tickers use Alpha Vantage
// GLOBAL_QUOTE, a free key (ALPHAVANTAGE_API_KEY), terms allow personal
// non-commercial use, 25 calls a day. ASX tickers use Yahoo Finance's chart
// endpoint, keyless and unofficial (Alpha Vantage's free tier carries no .AX
// symbols), so it is personal use only, parsed defensively, and kept off the
// Alpha Vantage budget. AUD per USD comes from Frankfurter (ECB rates, keyless).
// See the Mint dossier for why the ASX site and Stooq were ruled out (their
// terms or bot checks forbid scripted access).
import { setSetting, getSetting } from './db.mjs';
import { isOpen, lastClose, currencyOf, EXCHANGES } from './market.mjs';

export const GAP_MS = 15 * 60 * 1000; // never fetch a ticker more often than this while its market is open
const SESSION_MINUTES = 360; // about one ASX session, the window a day's budget has to cover
const RETRY_CLOSED_MS = 60 * 60 * 1000; // after a failure with the market shut

// The gap between fetches of one ticker while its market is open: 15 minutes,
// or wider when this many tickers cannot all fit a session inside the day's budget.
export const fetchGapMs = (tickers, cap) => Math.max(GAP_MS, Math.ceil((tickers * SESSION_MINUTES) / Math.max(1, cap)) * 60_000);

export function recordQuote(db, { ticker, exchange, price, prevClose = null, currency = null, source = null, fetchedAt }) {
  db.prepare(`INSERT INTO quotes (ticker, exchange, price, prev_close, currency, source, fetched_at, error, error_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(ticker, exchange) DO UPDATE SET price = excluded.price, prev_close = excluded.prev_close, currency = excluded.currency,
      source = excluded.source, fetched_at = excluded.fetched_at, error = NULL, error_at = NULL`)
    .run(ticker, exchange, price, prevClose, currency, source, fetchedAt);
}

// A failed attempt keeps whatever price is already cached.
export function recordQuoteError(db, ticker, exchange, error, at) {
  db.prepare(`INSERT INTO quotes (ticker, exchange, error, error_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(ticker, exchange) DO UPDATE SET error = excluded.error, error_at = excluded.error_at`)
    .run(ticker, exchange, String(error).slice(0, 300), at);
}

const num = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export function createAlphaVantage({ key = '', fetch = globalThis.fetch, base = 'https://www.alphavantage.co/query' } = {}) {
  const k = String(key ?? '').trim();
  const clean = (msg) => (k ? String(msg).replaceAll(k, '***') : String(msg));
  const fail = (msg) => { throw new Error(clean(msg)); };
  return {
    name: 'Alpha Vantage',
    configured: !!k,
    async quote(ticker, exchange) {
      const symbol = exchange === 'ASX' ? `${ticker}.AX` : ticker;
      const url = `${base}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(k)}`;
      let res;
      try { res = await fetch(url, { signal: AbortSignal.timeout(15_000) }); } catch (e) { fail(`Alpha Vantage unreachable: ${e?.message ?? e}`); }
      if (!res.ok) fail(`Alpha Vantage returned HTTP ${res.status}`);
      const body = await res.json().catch(() => null);
      if (!body) fail('Alpha Vantage sent something that is not JSON');
      const note = body.Note ?? body.Information ?? body['Error Message'];
      if (note) fail(`Alpha Vantage: ${String(note).slice(0, 160)}`);
      const g = body['Global Quote'] ?? {};
      const price = num(g['05. price']);
      if (price == null || price <= 0) fail(`no quote for ${ticker} (Alpha Vantage may not carry ${exchange === 'ASX' ? 'this ASX ticker' : 'this ticker'})`);
      return { price, prevClose: num(g['08. previous close']), currency: currencyOf(exchange), asOf: g['07. latest trading day'] ?? null };
    },
    // AUD per one unit of `from`; set by the wiring so the service has one source object.
    fx: null,
  };
}

// Yahoo Finance chart endpoint: unofficial, keyless, can change or block without
// notice. Every failure is a short readable error so refresh() records it and
// keeps the last price. Checked by hand: bare 'Mozilla/5.0' gets a quote
// while a full Chrome string or curl's own agent gets 429, so do not dress it up.
// budgeted:false keeps it off the Alpha Vantage call cap.
export function createYahoo({ fetch = globalThis.fetch, base = 'https://query1.finance.yahoo.com/v8/finance/chart' } = {}) {
  const fail = (msg) => { throw new Error(msg); };
  return {
    name: 'Yahoo Finance',
    configured: true,
    budgeted: false,
    async quote(ticker, exchange) {
      const symbol = exchange === 'ASX' ? `${ticker}.AX` : ticker;
      const url = `${base}/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
      let res;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      } catch (e) { fail(`Yahoo Finance unreachable: ${e?.message ?? e}`); }
      if (res.status === 429) fail('Yahoo Finance is rate limiting, will retry later');
      if (res.status === 403) fail('Yahoo Finance refused the request (HTTP 403)');
      if (!res.ok) fail(`Yahoo Finance returned HTTP ${res.status}`);
      const body = await res.json().catch(() => null);
      if (!body || typeof body !== 'object') fail('Yahoo Finance sent something that is not JSON');
      const r = body.chart?.result?.[0];
      const price = typeof r?.meta?.regularMarketPrice === 'number' && Number.isFinite(r.meta.regularMarketPrice) ? r.meta.regularMarketPrice : null;
      if (price == null || price <= 0) fail(`no quote for ${ticker} (Yahoo had no price${body.chart?.error?.description ? `: ${String(body.chart.error.description).slice(0, 80)}` : ''})`);
      // Previous close: the daily bar before the latest one. meta.chartPreviousClose is the
      // close from before the whole 5 day range, so using it would overstate the day change.
      const closes = (r.indicators?.quote?.[0]?.close ?? []).filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
      const meta = r.meta.previousClose;
      const prevClose = closes.length >= 2 ? Math.round(closes[closes.length - 2] * 1e6) / 1e6 : typeof meta === 'number' && Number.isFinite(meta) && meta > 0 ? meta : null;
      const t = Number(r.meta.regularMarketTime);
      return { price, prevClose, currency: currencyOf(exchange), asOf: Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : null };
    },
  };
}

// The Frankfurter client lives in lib/fx.mjs, shared with the manual foreign-currency accounts.
export { createFrankfurter } from './fx.mjs';

// One source object for the service: `byExchange` maps an exchange to the source
// that prices it (an exchange with no entry has none). fx hangs off the router.
export function createPriceRouter(byExchange, { fx = null } = {}) {
  const sources = [...new Set(Object.values(byExchange).filter(Boolean))];
  return {
    name: sources.map((x) => x.name).join(' and '),
    get configured() { return sources.some((x) => x.configured); },
    for: (exchange) => byExchange[exchange] ?? null,
    quote: (ticker, exchange) => byExchange[exchange].quote(ticker, exchange),
    fx,
  };
}

const NOT_CONFIGURED = 'No price source is set up. Add ALPHAVANTAGE_API_KEY to .env (a free key from alphavantage.co) or enter prices by hand.';

// source: { name, configured, quote(ticker, exchange), fx?() }, or a router
// whose for(exchange) picks one per exchange. A source with budgeted:false (Yahoo)
// is polled on the plain 15 minute gap and never spends the daily call budget.
// today() is the local date the daily call budget rolls over on.
export function createQuotes({ db, source, log = () => {}, now = () => new Date(), dailyCap = 25, today }) {
  let running = false;

  const srcOf = (exchange) => (source?.for ? source.for(exchange) : source);
  const usable = (exchange) => !!srcOf(exchange)?.configured;
  const budgeted = (exchange) => srcOf(exchange)?.budgeted !== false;

  const calls = () => (getSetting(db, 'quote_calls_date') === today() ? Number(getSetting(db, 'quote_calls_n') ?? 0) : 0);
  const spend = () => {
    const n = calls() + 1;
    setSetting(db, 'quote_calls_date', today());
    setSetting(db, 'quote_calls_n', n);
  };

  async function refresh({ force = false } = {}) {
    const out = { fetched: 0, failed: 0, capped: false, skipped: null };
    if (running) return { ...out, skipped: 'busy' };
    running = true;
    try {
      // The exchange rate is keyless, so a US holding on a hand-entered price still converts.
      if (!source?.configured) { await refreshFx(force); return { ...out, skipped: 'not configured' }; }
      const at = now();
      const held = db.prepare('SELECT ticker, exchange, max(manual_price IS NULL) fetchable FROM holdings GROUP BY ticker, exchange').all();
      const wanted = held.filter((h) => h.fetchable);
      const todo = wanted.filter((h) => usable(h.exchange));
      if (wanted.length && !todo.length) out.skipped = 'not configured';
      const gapOf = (exchange) => (budgeted(exchange) ? fetchGapMs(todo.filter((h) => budgeted(h.exchange)).length, dailyCap) : GAP_MS);
      const cached = db.prepare('SELECT price, fetched_at, error_at FROM quotes WHERE ticker = ? AND exchange = ?');
      const due = [];
      for (const h of todo) {
        const q = cached.get(h.ticker, h.exchange);
        const lastTry = Math.max(Date.parse(q?.fetched_at ?? '') || 0, Date.parse(q?.error_at ?? '') || 0);
        let yes;
        if (force) yes = true;
        else if (isOpen(h.exchange, at)) yes = !lastTry || at - lastTry >= gapOf(h.exchange);
        else {
          const fetchedAt = Date.parse(q?.fetched_at ?? '') || 0;
          const errAt = Date.parse(q?.error_at ?? '') || 0;
          const close = lastClose(h.exchange, at);
          yes = (!fetchedAt || (close && fetchedAt < close.getTime())) && (!errAt || at - errAt >= RETRY_CLOSED_MS);
        }
        if (yes) due.push({ ...h, lastTry });
      }
      due.sort((a, b) => a.lastTry - b.lastTry); // stalest first, so a short budget goes where it is needed
      for (const h of due) {
        const src = srcOf(h.exchange);
        if (budgeted(h.exchange)) {
          if (calls() >= dailyCap) { out.capped = true; continue; }
          spend();
        }
        try {
          const q = await src.quote(h.ticker, h.exchange);
          recordQuote(db, { ticker: h.ticker, exchange: h.exchange, price: q.price, prevClose: q.prevClose, currency: q.currency, source: src.name, fetchedAt: now().toISOString() });
          out.fetched += 1;
        } catch (e) {
          recordQuoteError(db, h.ticker, h.exchange, e?.message ?? e, now().toISOString());
          out.failed += 1;
          log(`quote ${h.ticker}.${h.exchange} failed: ${e?.message ?? e}`);
        }
      }
      await refreshFx(force);
      return out;
    } finally { running = false; }
  }

  // AUD per USD, only while a US holding exists; ECB moves it once a day so every 6 hours is plenty.
  async function refreshFx(force) {
    if (!source?.fx || !db.prepare("SELECT 1 FROM holdings WHERE exchange = 'US' LIMIT 1").get()) return;
    const q = db.prepare("SELECT fetched_at, error_at FROM quotes WHERE ticker = 'USD' AND exchange = 'FX'").get();
    const lastTry = Math.max(Date.parse(q?.fetched_at ?? '') || 0, Date.parse(q?.error_at ?? '') || 0);
    if (!force && lastTry && now() - lastTry < 6 * 3600_000) return;
    try {
      const rate = await source.fx('USD');
      recordQuote(db, { ticker: 'USD', exchange: 'FX', price: rate, currency: 'AUD', source: 'Frankfurter (ECB)', fetchedAt: now().toISOString() });
    } catch (e) {
      recordQuoteError(db, 'USD', 'FX', e?.message ?? e, now().toISOString());
      log(`exchange rate failed: ${e?.message ?? e}`);
    }
  }

  function status() {
    const bad = db.prepare(`SELECT ticker, error FROM quotes WHERE error_at IS NOT NULL AND (fetched_at IS NULL OR error_at > fetched_at)
      AND (exchange = 'FX' OR EXISTS (SELECT 1 FROM holdings h WHERE h.ticker = quotes.ticker AND h.exchange = quotes.exchange))
      ORDER BY error_at DESC LIMIT 1`).get();
    const ok = db.prepare('SELECT max(fetched_at) t FROM quotes').get().t;
    // Only a held exchange with no source needs the setup note; with no holdings it falls back to whether any source exists.
    const held = db.prepare('SELECT DISTINCT exchange FROM holdings WHERE manual_price IS NULL').all().map((h) => h.exchange);
    const missing = held.length ? held.some((x) => !usable(x)) : !source?.configured;
    return {
      source: source?.name ?? null, configured: !!source?.configured, calls_today: calls(), cap: dailyCap,
      budgeted_exchanges: EXCHANGES.filter(budgeted),
      last_ok_at: ok ?? null, last_error: bad ? bad.error : null,
      note: missing ? NOT_CONFIGURED : null,
    };
  }

  return { refresh, status };
}
