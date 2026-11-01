// Market hours for the two exchanges holdings can sit on. Weekdays only; public
// holidays are not modelled (a holiday costs one wasted quote call, no more).
// Times are local to the exchange, so daylight saving moves them correctly.
import { addDays, MARKET_ZONES } from './dates.mjs';

const MARKETS = {
  ASX: { tz: MARKET_ZONES.ASX, open: 10 * 60, close: 16 * 60 + 10, currency: 'AUD' },
  US: { tz: MARKET_ZONES.US, open: 9 * 60 + 30, close: 16 * 60, currency: 'USD' },
};

export const EXCHANGES = Object.keys(MARKETS);
export const currencyOf = (exchange) => MARKETS[exchange]?.currency ?? 'AUD';

const fmts = new Map();
function zoned(date, tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    fmts.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), minutes: Number(p.hour) * 60 + Number(p.minute), weekend: p.weekday === 'Sat' || p.weekday === 'Sun' };
}

export function isOpen(exchange, now = new Date()) {
  const mk = MARKETS[exchange];
  if (!mk) return false;
  const z = zoned(now, mk.tz);
  return !z.weekend && z.minutes >= mk.open && z.minutes < mk.close;
}

// The instant the exchange's local wall clock read y-m-d minutes.
function instant(mk, y, m, d, minutes) {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const z = zoned(new Date(guess), mk.tz);
  const asLocal = Date.UTC(z.y, z.m - 1, z.d, 0, z.minutes);
  return new Date(guess - (asLocal - guess));
}

// The most recent session end at or before `now`.
export function lastClose(exchange, now = new Date()) {
  const mk = MARKETS[exchange];
  if (!mk) return null;
  // Step back by calendar day in the exchange's zone: 24 hours back would skip or repeat a date across a clock change.
  const z0 = zoned(now, mk.tz);
  let day = `${z0.y}-${String(z0.m).padStart(2, '0')}-${String(z0.d).padStart(2, '0')}`;
  for (let back = 0; back < 10; back++, day = addDays(day, -1)) {
    const [y, m, d] = day.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const close = instant(mk, y, m, d, mk.close);
    if (close <= now) return close;
  }
  return null;
}
