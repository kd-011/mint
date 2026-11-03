// The goal editor's calculator, with no DOM in it. Three linked quantities:
// the target, a finish date and an amount per period. Whichever of the date and
// the amount the person touched last is the driver; the other is worked out.
// Money is whole cents, dates are YYYY-MM-DD. Plain script in the page and a
// CommonJS module in tests, like ux-model.js. One global, GoalCalc.
//
// A fortnight is the pay cycle (lib/cycles.mjs CYCLE_DAYS, and lib/goals.mjs
// per_cycle_needed = ceil(remaining / ceil(days / 14))), so Fortnightly here
// gives the same figure as the server for the same date. Weekly is days / 7,
// Monthly counts calendar months. The calendar helpers are UxModel's.
'use strict';

const GoalCalc = (() => {
  const UX = typeof UxModel !== 'undefined' ? UxModel : require('./ux-model.js').UxModel;
  const MS_DAY = 864e5;
  const CAP_MONTHS = 120;
  const FREQS = {
    weekly: { label: 'Weekly', per: 'a week', days: 7 },
    fortnightly: { label: 'Fortnightly', per: 'a fortnight', days: 14 },
    monthly: { label: 'Monthly', per: 'a month', months: 1 },
  };
  const FREQ_KEYS = Object.keys(FREQS);

  const utc = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / MS_DAY);
  const addDays = (iso, n) => new Date(utc(iso) + n * MS_DAY).toISOString().slice(0, 10);
  const maxDate = (today) => UX.addMonthsIso(today, CAP_MONTHS);

  // What is still to save. Already-saved money counts toward the target.
  const remainingOf = (target, saved) => Math.max(0, target - Math.max(0, saved ?? 0));

  // Payments between today and a date: the smallest n whose n-th period lands on
  // or after the date. At least 1 for any future date.
  function periodsTo(freq, today, date) {
    const days = daysBetween(today, date);
    if (days <= 0) return 0;
    const f = FREQS[freq];
    if (f.days) return Math.ceil(days / f.days);
    let n = Math.max(1, (Number(date.slice(0, 4)) - Number(today.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(today.slice(5, 7)) - 1);
    while (UX.addMonthsIso(today, n) < date) n += 1;
    return n;
  }
  // The date the n-th payment lands on.
  const dateAfter = (freq, today, n) => (FREQS[freq].days ? addDays(today, n * FREQS[freq].days) : UX.addMonthsIso(today, n));

  // The one entry point. driver is 'date', 'amount' or '' (neither touched yet).
  //  status: none (no usable target) | met | prompt | past | ok | beyond
  // ok carries date, amount and periods; beyond means the amount needs more than 10 years.
  function solve({ freq, today, target, saved = 0, driver = '', date = '', amount = null }) {
    if (!(target > 0)) return { status: 'none', freq };
    const remaining = remainingOf(target, saved);
    const base = { freq, remaining, saved: Math.max(0, saved ?? 0), target };
    if (remaining === 0) return { ...base, status: 'met' };
    if (driver === 'date' && date) {
      if (date <= today) return { ...base, status: 'past', date };
      const periods = periodsTo(freq, today, date);
      return { ...base, status: 'ok', date, periods, amount: Math.ceil(remaining / periods) };
    }
    if (driver === 'amount' && amount > 0) {
      const periods = Math.ceil(remaining / amount);
      const finish = dateAfter(freq, today, periods);
      if (finish > maxDate(today)) return { ...base, status: 'beyond', amount, periods };
      return { ...base, status: 'ok', date: finish, amount, periods };
    }
    return { ...base, status: 'prompt' };
  }

  // The same money per day in another unit. A month is the calendar month from today.
  const periodDays = (freq, today) => FREQS[freq].days ?? daysBetween(today, UX.addMonthsIso(today, 1));
  const convertAmount = (cents, from, to, today) => Math.round((cents * periodDays(to, today)) / periodDays(from, today));

  // What the editor holds after a frequency switch. A plan that works pins its date and
  // the amount follows; otherwise an amount the person typed is converted, so $50 a
  // fortnight does not turn into $50 a week.
  function switchFreq({ freq, to, today, target, saved = 0, driver = '', date = '', amount = null }) {
    if (driver !== 'amount' || !(amount > 0)) return { driver, amount };
    if (solve({ freq, today, target, saved, driver, date, amount }).status === 'ok') return { driver: 'date', amount };
    return { driver, amount: convertAmount(amount, freq, to, today) };
  }

  // With the amount driving, the date to show: the computed finish, '' when no finish exists
  // (over 10 years), or null to leave whatever is there. A date the person set survives a
  // cleared or met target.
  const dateFromAmount = (r) => (r.status === 'ok' ? r.date : r.status === 'beyond' ? '' : null);

  // the date slider: whole days from tomorrow to 10 years out
  const dateSlider = (today) => ({ min: 1, max: daysBetween(today, maxDate(today)) });
  const dateAtDay = (today, day) => addDays(today, day);
  const dayOfDate = (today, date, bounds = dateSlider(today)) => Math.max(bounds.min, Math.min(bounds.max, daysBetween(today, date)));

  // "in 9 days", "in 6 weeks", "in 14 months", "in 2 years 3 months"
  function untilWords(today, date) {
    const days = daysBetween(today, date);
    if (days <= 0) return '';
    if (days < 14) return `in ${days} ${days === 1 ? 'day' : 'days'}`;
    if (days < 70) return `in ${Math.round(days / 7)} weeks`;
    let m = (Number(date.slice(0, 4)) - Number(today.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(today.slice(5, 7));
    if (UX.addMonthsIso(today, m) > date) m -= 1;
    if (m < 24) return `in ${m} months`;
    return `in ${UX.monthsWords(m)}`;
  }

  // the amount slider: a ladder of tidy amounts, so every arrow key press moves one rung
  // Steps are 1, 2 or 5 times a power of ten, about 2% of the amount, never under $1.
  function niceStep(cents) {
    const raw = Math.max(100, cents / 50);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const r = raw / mag;
    return (r <= 1 ? 1 : r <= 2 ? 2 : 5) * mag;
  }
  // From the amount that would take 10 years to the whole remainder in one payment.
  function amountLadder(freq, today, remaining) {
    if (!(remaining > 0)) return [];
    const periods = Math.max(1, periodsTo(freq, today, maxDate(today)));
    const lo = Math.max(100, Math.floor(remaining / periods / 100) * 100);
    const hi = Math.max(lo * 2, remaining);
    const out = [];
    for (let v = lo; v < hi && out.length < 4000; v = (Math.floor(v / niceStep(v)) + 1) * niceStep(v)) out.push(v);
    out.push(hi);
    return out;
  }
  // The rung nearest an amount.
  function rungOf(ladder, cents) {
    if (!ladder.length) return 0;
    let best = 0;
    for (let i = 1; i < ladder.length; i += 1) if (Math.abs(ladder[i] - cents) < Math.abs(ladder[best] - cents)) best = i;
    return best;
  }

  // the result line, as [{ t, b }] segments (b = emphasised)
  function resultWords(r, fmt) {
    const per = FREQS[r.freq]?.per ?? '';
    if (r.status === 'met') return [{ t: 'Target already met, ' }, { t: fmt(r.saved), b: true }, { t: ' saved.' }];
    if (r.status === 'prompt') return [{ t: 'Pick a date or an amount and the other follows.' }];
    if (r.status === 'beyond') return [{ t: 'More than 10 years', b: true }, { t: ` at ${fmt(r.amount)} ${per}.` }];
    if (r.status === 'ok') return [{ t: fmt(r.amount), b: true }, { t: ` ${per} gets you there by ` }, { t: UX.dateWords(r.date).replace(/ /g, '\u00a0'), b: true }, { t: `, ${r.periods.toLocaleString('en-AU')} ${r.periods === 1 ? 'payment' : 'payments'}.` }];
    return [];
  }
  const plainWords = (segs) => segs.map((s) => s.t).join('');

  return { FREQS, FREQ_KEYS, CAP_MONTHS, daysBetween, addDays, maxDate, remainingOf, periodsTo, dateAfter, solve, convertAmount, switchFreq, dateFromAmount, dateSlider, dateAtDay, dayOfDate, untilWords, niceStep, amountLadder, rungOf, resultWords, plainWords };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { GoalCalc };
