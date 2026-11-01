// A stand-in for the Frankfurter (ECB) API: /currencies, /latest and date
// ranges, AUD per unit of the base currency. Rates are invented. Weekdays only,
// like the ECB. `offline` makes every call fail as a network error would.
import { createServer } from 'node:http';

export const CURRENCIES = {
  AUD: 'Australian Dollar', EUR: 'Euro', GBP: 'British Pound', JPY: 'Japanese Yen', NZD: 'New Zealand Dollar',
  SGD: 'Singapore Dollar', THB: 'Thai Baht', USD: 'United States Dollar',
};
// AUD per unit, flat per currency unless a test sets a date.
const BASE_RATE = { USD: 1.5, EUR: 1.65, GBP: 1.9, JPY: 0.01, NZD: 0.9, SGD: 1.1, THB: 0.045 };
const FIRST = '2015-01-01';

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = (iso) => { const w = new Date(`${iso}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6; };

export function fakeFrankfurter({ latestDate = '2026-10-16' } = {}) {
  const state = { offline: false, calls: [], overrides: new Map(), latestDate };
  const rateOf = (cur, date) => state.overrides.get(`${cur}|${date}`) ?? BASE_RATE[cur];
  const lastWeekday = (iso) => { let d = iso; while (!weekday(d)) d = addDays(d, -1); return d; };

  function answer(path, query) {
    if (path === '/v1/currencies') return [200, CURRENCIES];
    const base = query.get('base');
    if (!base || !BASE_RATE[base] || query.get('symbols') !== 'AUD') return [404, { message: 'not found' }];
    if (path === '/v1/latest') return [200, { amount: 1, base, date: state.latestDate, rates: { AUD: rateOf(base, state.latestDate) } }];
    const m = /^\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})?$/.exec(path);
    if (m) {
      const to = m[2] && m[2] < state.latestDate ? m[2] : state.latestDate;
      const from = lastWeekday(m[1]);
      if (to < FIRST) return [404, { message: 'not found' }];
      const rates = {};
      for (let d = from < FIRST ? FIRST : from; d <= to; d = addDays(d, 1)) if (weekday(d)) rates[d] = { AUD: rateOf(base, d) };
      return [200, { amount: 1, base, start_date: from, end_date: to, rates }];
    }
    return [404, { message: 'not found' }];
  }

  const fetch = async (u) => {
    const url = new URL(String(u));
    state.calls.push(url.pathname + url.search);
    if (state.offline) throw new TypeError('fetch failed');
    const [status, body] = answer(url.pathname, url.searchParams);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };

  async function listen() {
    const server = createServer(async (req, res) => {
      try {
        const r = await fetch(`http://x${req.url}`);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(await r.text());
      } catch { req.socket.destroy(); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, base: `http://127.0.0.1:${server.address().port}/v1` };
  }

  return { state, fetch, listen, setRate: (cur, date, rate) => state.overrides.set(`${cur}|${date}`, rate) };
}
