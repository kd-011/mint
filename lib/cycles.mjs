// Pay cycles. A cycle runs from the day a salary deposit lands (the anchor
// income stream, see lib/income.mjs) to the day before the next one. The
// open cycle ends the day before the predicted payday (last pay plus the
// stream's cadence); when pay is late it stretches until the next salary
// lands and is flagged late from two days past the predicted date. Deposits
// within three days of each other (a top-up, back pay) are one payday.
import { addDays, daysBetween, isIsoDate } from './dates.mjs';
import { bad } from './errors.mjs';
import { LIVE } from './live.mjs';

export const MERGE_DAYS = 3;
export const LATE_AFTER_DAYS = 2;
export const DEFAULT_CADENCE = 14;

export function anchorSource(db) {
  return db.prepare("SELECT * FROM income_sources WHERE kind = 'salary' ORDER BY anchor DESC, priority, id LIMIT 1").get() ?? null;
}

export function paydays(db) {
  const src = anchorSource(db);
  if (!src) return [];
  const rows = db.prepare("SELECT id, date, amount FROM transactions WHERE income_source_id = ? AND income_kind = 'salary' AND " + LIVE('transactions') + " ORDER BY date, id").all(src.id);
  const out = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last && daysBetween(last.date, r.date) <= MERGE_DAYS) { last.amount += r.amount; last.ids.push(r.id); continue; }
    out.push({ date: r.date, amount: r.amount, ids: [r.id] });
  }
  return out;
}

export function listCycles(db, { today }) {
  const src = anchorSource(db);
  const pays = paydays(db);
  if (!src || !pays.length) return [];
  const cadence = src.cadence_days || DEFAULT_CADENCE;
  return pays.map((p, i) => {
    const next = pays[i + 1];
    const predicted = addDays(p.date, cadence);
    const c = { start: p.date, end: null, days: 0, open: !next, payday: { date: p.date, amount: p.amount }, expected_end: addDays(predicted, -1), late: false, days_late: 0 };
    if (next) {
      c.end = addDays(next.date, -1);
      c.days_late = Math.max(0, daysBetween(predicted, next.date));
    } else {
      const expectedEnd = addDays(predicted, -1);
      c.end = today > expectedEnd ? today : expectedEnd;
      c.days_late = Math.max(0, daysBetween(predicted, today));
      c.next_payday = predicted;
      c.day = Math.max(1, daysBetween(p.date, today) + 1);
      c.days_left = Math.max(0, daysBetween(today, c.end) + 1);
    }
    c.late = c.days_late >= LATE_AFTER_DAYS;
    c.days = daysBetween(c.start, c.end) + 1;
    return c;
  });
}

export function currentCycle(db, { today }) {
  const c = listCycles(db, { today }).at(-1);
  return c && c.start <= today ? c : null;
}

export function cycleAt(db, date, { today }) {
  if (!isIsoDate(date)) throw bad('date must be YYYY-MM-DD');
  return listCycles(db, { today }).find((c) => c.start <= date && date <= c.end) ?? null;
}

// The last n cycles that have closed, oldest first.
export function completeCycles(db, { today, n = 6 }) {
  return listCycles(db, { today }).filter((c) => !c.open).slice(-n);
}
