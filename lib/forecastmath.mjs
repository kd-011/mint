// Cashflow forecast maths, pure (no database): WA public holidays, where a
// payday lands, the baseline daily spend and its spread, and the day by day
// projection with a range band, the lowest point and the floor check.
// Cents everywhere. The band is an estimate: one standard deviation of daily
// spend, widening with the square root of the days of spending, so it covers
// about two outcomes in three and says nothing about one-off surprises.
import { addDays } from './dates.mjs';

const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const ymd = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const weekend = (iso) => dow(iso) === 0 || dow(iso) === 6;

// Anonymous Gregorian algorithm.
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

const nthMonday = (year, month, n) => {
  const first = ymd(year, month, 1);
  return addDays(first, ((8 - dow(first)) % 7) + 7 * (n - 1));
};
const lastMonday = (year, month) => {
  const last = addDays(ymd(year, month + 1, 1), -1);
  return addDays(last, -((dow(last) + 6) % 7));
};

const HOLIDAYS = new Map();

// Public holidays in Western Australia (Perth), as ISO dates. A fixed-date
// holiday on a weekend moves to the next free weekday (Anzac Day only when it
// is a Sunday, as WA does). The King's Birthday is the last Monday in
// September; WA's Governor sometimes proclaims another day, so that one can
// be a few days out.
export function waHolidays(year) {
  const cached = HOLIDAYS.get(year);
  if (cached) return cached;
  const taken = new Set();
  const easter = easterSunday(year);
  for (const d of [addDays(easter, -2), easter, addDays(easter, 1), nthMonday(year, 3, 1), nthMonday(year, 6, 1), lastMonday(year, 9)]) taken.add(d);
  const place = (d, substituteSat = true) => {
    if (!weekend(d) && !taken.has(d)) { taken.add(d); return; }
    if (dow(d) === 6 && !substituteSat) return;
    let n = addDays(d, 1);
    while (weekend(n) || taken.has(n)) n = addDays(n, 1);
    taken.add(n);
  };
  place(ymd(year, 1, 1));
  place(ymd(year, 1, 26));
  place(ymd(year, 4, 25), false);
  place(ymd(year, 12, 25));
  place(ymd(year, 12, 26));
  HOLIDAYS.set(year, taken);
  return taken;
}

export const isBusinessDay = (iso) => !weekend(iso) && !waHolidays(Number(iso.slice(0, 4))).has(iso);

export function prevBusinessDay(iso) {
  let d = iso;
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

// Paydays after the last one seen. A salary due on a weekend or public holiday
// is paid the business day before. One that should have landed already is late
// and counted for today (once); the ones after it stay on the cadence.
export function upcomingPaydays({ last, cadence, today, until }) {
  const out = [];
  let late = false;
  for (let k = 1; k < 400; k++) {
    const nominal = addDays(last, k * cadence);
    if (nominal > addDays(until, 7)) break;
    const date = prevBusinessDay(nominal);
    if (date < today) {
      if (late) continue;
      late = true;
      out.push({ nominal, date: today, shifted: false, late: true });
      continue;
    }
    if (date <= until) out.push({ nominal, date, shifted: date !== nominal, late: false });
  }
  return out;
}

// Mean and spread of daily spend. A one-off (a car repair, a flight) would
// swamp both, so days above the 95th percentile count as that percentile.
export function baselineFromDaily(values) {
  const n = values.length;
  if (!n) return { daily: 0, sd: 0, days: 0, cap: 0, capped: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const cap = sorted[Math.max(0, Math.ceil(0.95 * n) - 1)];
  const v = values.map((x) => Math.min(x, cap));
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
  return { daily: Math.round(mean), sd: Math.round(sd), days: n, cap, capped: values.filter((x) => x > cap).length };
}

// Project the balance from today for `days` more days. events: [{ date,
// amount (cents, plus in, minus out), ...anything else is passed through }].
// Each day's baseline spend comes off too (today only for what is left of it).
export function projectCashflow({ today, balance, days, floor = 0, events, baseline, spentToday = 0, next_payday = null }) {
  const end = addDays(today, days);
  const byDate = new Map();
  for (const e of events) {
    const date = e.date < today ? today : e.date;
    if (date > end) continue;
    (byDate.get(date) ?? byDate.set(date, []).get(date)).push({ ...e, date });
  }
  const { daily = 0, sd = 0 } = baseline ?? {};
  const out = [];
  const items = [];
  let running = balance;
  let n = 0;
  for (let i = 0; i <= days; i++) {
    const date = addDays(today, i);
    const spend = i === 0 ? Math.max(0, daily - spentToday) : daily;
    n += i === 0 ? (daily > 0 ? spend / daily : 1) : 1;
    const evs = (byDate.get(date) ?? []).sort((a, b) => b.amount - a.amount);
    running += evs.reduce((s, e) => s + e.amount, 0) - spend;
    const band = Math.round(sd * Math.sqrt(n));
    out.push({ date, balance: running, low: running - band, high: running + band });
    for (const e of evs) items.push({ ...e, balance_after: running });
  }
  const lowest = (rows) => rows.reduce((m, d) => (d.balance < m.balance ? d : m), rows[0]);
  const low = lowest(out);
  const pre = next_payday ? out.filter((d) => d.date < next_payday) : [];
  const breach = out.find((d) => d.balance < floor);
  const maybe = out.find((d) => d.low < floor);
  return {
    days: out,
    items,
    lowest: { ...low, before_payday: next_payday ? low.date < next_payday : null },
    lowest_before_payday: pre.length ? lowest(pre) : null,
    status: breach ? 'breach' : maybe ? 'possible' : 'ok',
    first_breach: breach?.date ?? null,
    first_possible: maybe?.date ?? null,
  };
}
