// Save and Invest, super. Super is a manual asset of kind super with a value
// snapshot now and then. This reads them back: the balance, change since the
// previous snapshot (split into the contribution logged with it and growth),
// the history, and the nudge when the last value is over 35 days old.
import { daysBetween } from './dates.mjs';
import { NUDGE_DAYS } from './networth.mjs';

const round4 = (x) => Math.round(x * 10000) / 10000;

export function superOverview(db, { today }) {
  const assets = db.prepare("SELECT id, name FROM manual_assets WHERE kind = 'super' AND archived = 0 AND is_liability = 0 ORDER BY name, id").all();
  const snaps = db.prepare('SELECT date, value, note, contribution FROM manual_snapshots WHERE asset_id = ? ORDER BY date');
  const items = assets.map((a) => {
    const history = snaps.all(a.id).map((s) => ({ date: s.date, value: s.value, contribution: s.contribution ?? null, note: s.note ?? null }));
    const last = history.at(-1) ?? null;
    const prev = history.length > 1 ? history.at(-2) : null;
    const days = last ? daysBetween(last.date, today) : null;
    let change = null;
    if (last && prev) {
      const amount = last.value - prev.value;
      change = { since: prev.date, amount, pct: prev.value > 0 ? round4(amount / prev.value) : null, contribution: last.contribution, growth: amount - (last.contribution ?? 0) };
    }
    return { id: a.id, name: a.name, value: last?.value ?? null, as_of: last?.date ?? null, days_since: days, due: days == null || days > NUDGE_DAYS, snapshots: history.length, change, history };
  });
  return { as_of: today, nudge_days: NUDGE_DAYS, total: items.reduce((s, i) => s + (i.value ?? 0), 0), items };
}
