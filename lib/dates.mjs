// Calendar helpers. Mint keeps one IANA timezone, set by MINT_TZ (default
// Australia/Perth, which is what the app was built in). Dates are stored as
// YYYY-MM-DD in that zone and shown as DD/MM/YYYY; timestamps are UTC ISO.
// This is the only module that names a zone: everything else asks it for a
// date, a time of day or the bounds of a day, so daylight saving needs no
// special case anywhere else (test/tz-guard.test.mjs enforces that).
//
// Changing MINT_TZ later does not rewrite history. Stored dates stay as they
// were; only days bucketed from then on use the new zone.
export const DEFAULT_ZONE = 'Australia/Perth';

// Exchange hours are a property of the exchange, not of where the user lives.
export const MARKET_ZONES = { ASX: 'Australia/Sydney', US: 'America/New_York' };

const checked = new Map(); // raw MINT_TZ -> canonical zone name

// Validate a MINT_TZ value and return the canonical IANA name. Blank means the
// default. Throws an Error that names the variable, for startup to print.
export function assertZone(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return DEFAULT_ZONE;
  const hit = checked.get(v);
  if (hit) return hit;
  let name = null;
  // Region/City names only: Intl would also take "+08:00", which is a fixed offset with no daylight saving.
  if (/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(v)) {
    try { name = new Intl.DateTimeFormat('en-CA', { timeZone: v }).resolvedOptions().timeZone; } catch { name = null; }
  }
  if (name && /^Etc\/GMT[+-]/.test(name)) name = null; // a fixed offset in disguise
  if (!name) {
    throw new Error(`MINT_TZ "${v}" is not an IANA timezone name (for example Australia/Perth or Australia/Sydney)`);
  }
  checked.set(v, name);
  return name;
}

export const zoneName = () => assertZone(process.env.MINT_TZ);

const fmts = new Map();
function fmt(kind, zone) {
  const key = `${kind}|${zone}`;
  let f = fmts.get(key);
  if (!f) {
    const base = { timeZone: zone, hourCycle: 'h23' };
    f = kind === 'date' ? new Intl.DateTimeFormat('en-CA', { ...base, year: 'numeric', month: '2-digit', day: '2-digit' })
      : kind === 'time' ? new Intl.DateTimeFormat('en-GB', { ...base, hour: '2-digit', minute: '2-digit' })
        : new Intl.DateTimeFormat('en-GB', { ...base, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmts.set(key, f);
  }
  return f;
}

// The local calendar date (YYYY-MM-DD) of an instant.
export const zoneDate = (d = new Date()) => fmt('date', zoneName()).format(d);

// Minutes since local midnight, for the scheduler.
export function zoneMinutes(d = new Date()) {
  const [h, m] = fmt('time', zoneName()).format(d).split(':').map(Number);
  return h * 60 + m;
}

// Wall-clock parts of an instant in the configured zone, for file timestamps.
export function zoneParts(d = new Date()) {
  const g = Object.fromEntries(fmt('full', zoneName()).formatToParts(d).map((x) => [x.type, Number(x.value)]));
  return { year: g.year, month: g.month, day: g.day, hour: g.hour, minute: g.minute, second: g.second };
}

// Offset of the zone from UTC at an instant, in ms (local wall clock read as UTC, minus the instant).
function offsetAt(ms) {
  const f = fmt('full', zoneName());
  const g = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute, g.second) - Math.floor(ms / 1000) * 1000;
}

// The instant a local day starts (its first 00:00:00.000). Asks the zone for its offset on both
// sides of the guess, so it holds on 23 and 25 hour days. A midnight that repeats takes the first
// pass; one skipped by a clock change starts the day when the clock jumps past it.
export function zoneDayStart(iso) {
  const wall = Date.parse(`${iso}T00:00:00.000Z`);
  const a = wall - offsetAt(wall);
  const b = wall - offsetAt(a);
  const ok = [a, b].filter((t) => wall - offsetAt(t) === t);
  if (ok.length) return new Date(Math.min(...ok));
  return new Date(Math.max(a, b));
}

// Last millisecond of a local day: one before the next day starts, whatever the day's length.
export const zoneDayEnd = (iso) => new Date(zoneDayStart(addDays(iso, 1)).getTime() - 1);

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Redbark answers from_too_old for anything past about seven years, so the
// backfill starts seven years back plus a week of margin.
export function oldestAllowedFrom(today) {
  const [y, m, d] = today.split('-').map(Number);
  const back = new Date(Date.UTC(y - 7, m - 1, d));
  if (back.getUTCMonth() !== m - 1) back.setUTCDate(0); // 29 Feb to 28 Feb
  return addDays(back.toISOString().slice(0, 10), 7);
}

export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
export const fmtDMY = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
// Strict: 2027-02-30 is not a date (Date.parse would roll it to 2 March).
export const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
