// The Subscriptions list: what Mint detected (lib/recurring.mjs) merged with
// what the owner added by hand, and a state per subscription.
//
//   active      charging, or a manual one that is live. Feeds the bills calendar,
//               the forecast and the new-subscription alerts.
//   cancelled   the owner cancelled it (with the date). Drops out of all of those but
//               stays listed with what it saves a month.
//   dismissed   "not a subscription". Gone from the money maths; restorable.
//   stopped     detected, but the charges stopped on their own.
//   maybe       filed under Subscriptions, charged lately, no rhythm yet.
//
// A state on a detected subscription is a row keyed by merchant_key (origin
// 'detected'); a manual one is a row of its own (origin 'manual'), optionally
// linked to a merchant_key, in which case it stands in for the detected one.
import { bad, notFound } from './errors.mjs';
import { addDays, daysBetween, isIsoDate } from './dates.mjs';
import { CADENCES, detectRaw, maybeSubscriptions, perMonth, rollForward, addMonths } from './recurring.mjs';

export { recurringKeys } from './recurring.mjs';

const STALE_AFTER_DAYS = 400; // a detected series dead longer than this is history, not a "stopped" subscription
const CHARGED_AFTER_CANCEL_DAYS = 7; // the last bill often lands just after cancelling
const COLS = 'id, origin, merchant_key, name, amount, cadence, next_date, status, cancelled_on, category_id, note, created_at, updated_at';
const cadenceNames = CADENCES.map((c) => c.name);
const KEY = /^[a-z0-9]+(?: [a-z0-9]+)*$/;

const cleanName = (v) => {
  const n = typeof v === 'string' ? v.trim() : '';
  if (!n || n.length > 60) throw bad('name must be 1 to 60 characters');
  return n;
};
const cleanAmount = (v) => {
  if (!Number.isInteger(v) || v < 1 || v > 1e9) throw bad('amount must be whole cents, more than zero');
  return v;
};
const cleanCadence = (v) => {
  if (!cadenceNames.includes(v)) throw bad(`cadence must be ${cadenceNames.join(', ')}`);
  return v;
};
const cleanDate = (v, field) => {
  if (!isIsoDate(v)) throw bad(`${field} must be YYYY-MM-DD`);
  return v;
};
const cleanCancelledOn = (v, today) => {
  const d = cleanDate(v ?? today, 'cancelled_on');
  if (d > today) throw bad('cancelled_on cannot be in the future');
  return d;
};
const cleanKey = (v) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > 120 || !KEY.test(v)) throw bad('merchant_key must be a merchant grouping key');
  return v;
};
const cleanCategory = (db, v) => {
  if (v == null) return null;
  if (!Number.isInteger(v) || !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(v)) throw bad('no such category');
  return v;
};
const cleanNote = (v) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > 200) throw bad('note must be up to 200 characters');
  return v.trim();
};

const view = (r, today) => ({
  ...r,
  next_date: r.status === 'active' && r.next_date && r.cadence ? rollForward(r.cadence, r.next_date, today) : r.next_date,
});
const getRow = (db, id) => db.prepare(`SELECT ${COLS} FROM subscriptions WHERE id = ?`).get(id);

export function addSubscription(db, body, { today }) {
  const b = body && typeof body === 'object' ? body : {};
  const status = b.status ?? 'active';
  if (status !== 'active' && status !== 'cancelled') throw bad('status must be active or cancelled');
  const name = cleanName(b.name);
  const amount = cleanAmount(b.amount);
  const cadence = cleanCadence(b.cadence);
  const next = cleanDate(b.next_date, 'next_date');
  const cancelled = status === 'cancelled' ? cleanCancelledOn(b.cancelled_on, today) : null;
  const at = new Date().toISOString();
  const { lastInsertRowid } = db.prepare(`INSERT INTO subscriptions (origin, merchant_key, name, amount, cadence, next_date, status, cancelled_on, category_id, note, created_at, updated_at)
    VALUES ('manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(cleanKey(b.merchant_key), name, amount, cadence, next, status, cancelled, cleanCategory(db, b.category_id), cleanNote(b.note), at, at);
  return view(getRow(db, Number(lastInsertRowid)), today);
}

export function updateSubscription(db, id, body, { today }) {
  const row = getRow(db, id);
  if (!row || row.origin !== 'manual') throw notFound('no such subscription');
  const b = body && typeof body === 'object' ? body : {};
  const next = { ...row };
  if ('name' in b) next.name = cleanName(b.name);
  if ('amount' in b) next.amount = cleanAmount(b.amount);
  if ('cadence' in b) next.cadence = cleanCadence(b.cadence);
  if ('next_date' in b) next.next_date = cleanDate(b.next_date, 'next_date');
  if ('merchant_key' in b) next.merchant_key = cleanKey(b.merchant_key);
  if ('category_id' in b) next.category_id = cleanCategory(db, b.category_id);
  if ('note' in b) next.note = cleanNote(b.note);
  if ('status' in b) {
    if (b.status !== 'active' && b.status !== 'cancelled') throw bad('status must be active or cancelled');
    next.status = b.status;
  }
  if (next.status === 'cancelled') next.cancelled_on = cleanCancelledOn('cancelled_on' in b ? b.cancelled_on : row.cancelled_on, today);
  else next.cancelled_on = null;
  // A date left to go stale is brought forward before it is stored, so editing never moves it backwards.
  if (next.status === 'active' && next.next_date < today) next.next_date = rollForward(next.cadence, next.next_date, today);
  db.prepare(`UPDATE subscriptions SET name = ?, amount = ?, cadence = ?, next_date = ?, status = ?, cancelled_on = ?, merchant_key = ?, category_id = ?, note = ?, updated_at = ? WHERE id = ?`)
    .run(next.name, next.amount, next.cadence, next.next_date, next.status, next.cancelled_on, next.merchant_key, next.category_id, next.note, new Date().toISOString(), id);
  return view(getRow(db, id), today);
}

export function deleteSubscription(db, id) {
  if (!db.prepare("DELETE FROM subscriptions WHERE id = ? AND origin = 'manual'").run(id).changes) throw notFound('no such subscription');
  return { deleted: true };
}

// What a cancelled detected subscription cost, kept with the state so it still
// shows its saving once the charges stop. Several price points (a $3 and a $16
// plan from one merchant) are added up as a monthly figure.
function snapshot(entries) {
  const live = entries.filter((e) => e.active);
  const use = live.length ? live : [entries.sort((a, b) => (a.last_date < b.last_date ? 1 : -1))[0]];
  if (use.length === 1) return { name: use[0].merchant, amount: use[0].amount, cadence: use[0].cadence, category_id: use[0].category_id };
  return { name: use[0].merchant, amount: use.reduce((s, e) => s + perMonth(e.amount, e.cadence), 0), cadence: 'monthly', category_id: use[0].category_id };
}

export function setDetectedState(db, merchantKey, body, { today }) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.status !== 'cancelled' && b.status !== 'dismissed') throw bad('status must be cancelled or dismissed');
  const key = cleanKey(merchantKey);
  if (!key) throw bad('merchant_key is required');
  const cancelled = b.status === 'cancelled' ? cleanCancelledOn(b.cancelled_on, today) : null;
  const entries = detectRaw(db, today).filter((s) => s.member_keys.includes(key) && s.kind === 'subscription');
  const had = db.prepare("SELECT 1 FROM subscriptions WHERE origin = 'detected' AND merchant_key = ?").get(key);
  // A "maybe" (charged lately, no rhythm yet) can be set aside too; it is kept as a monthly guess.
  const maybe = entries.length || had ? null : maybeSubscriptions(db, today).find((m) => m.merchant_key === key);
  if (!entries.length && !had && !maybe) throw notFound('no detected subscription for that merchant');
  if (maybe) entries.push({ merchant: maybe.merchant, amount: maybe.amount, cadence: 'monthly', category_id: maybe.category_id, active: false, last_date: maybe.last_date });
  const at = new Date().toISOString();
  if (had) {
    // Keep the snapshot taken first unless the merchant is still detected and has something fresher.
    const snap = entries.length ? snapshot(entries) : null;
    db.prepare(`UPDATE subscriptions SET status = ?, cancelled_on = ?, updated_at = ?${snap ? ', name = ?, amount = ?, cadence = ?, category_id = ?' : ''} WHERE origin = 'detected' AND merchant_key = ?`)
      .run(b.status, cancelled, at, ...(snap ? [snap.name, snap.amount, snap.cadence, snap.category_id] : []), key);
  } else {
    const snap = snapshot(entries);
    db.prepare(`INSERT INTO subscriptions (origin, merchant_key, name, amount, cadence, status, cancelled_on, category_id, created_at, updated_at)
      VALUES ('detected', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(key, snap.name, snap.amount, snap.cadence, b.status, cancelled, snap.category_id, at, at);
  }
  return view(db.prepare(`SELECT ${COLS} FROM subscriptions WHERE origin = 'detected' AND merchant_key = ?`).get(key), today);
}

export function clearDetectedState(db, merchantKey) {
  if (!db.prepare("DELETE FROM subscriptions WHERE origin = 'detected' AND merchant_key = ?").run(merchantKey).changes) throw notFound('that subscription has no state to clear');
  return { deleted: true };
}

const item = (o) => ({
  id: null, key: null, origin: 'detected', merchant_key: null, name: '', amount: null, cadence: null, per_month: 0, next_date: null, last_date: null,
  status: 'active', cancelled_on: null, variable: false, variant: null, count: 0, still_charging: false, category_id: null, category: null, note: null, ...o,
});
const byNext = (a, b) => (a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : a.name.localeCompare(b.name));
const sum = (xs) => xs.reduce((s, i) => s + i.per_month, 0);

export function listSubscriptions(db, today) {
  const rows = db.prepare('SELECT s.*, c.name category FROM subscriptions s LEFT JOIN categories c ON c.id = s.category_id').all();
  const raw = detectRaw(db, today).filter((s) => s.kind === 'subscription');
  const states = new Map(rows.filter((r) => r.origin === 'detected').map((r) => [r.merchant_key, r]));
  const linked = new Set(rows.filter((r) => r.origin === 'manual' && r.merchant_key).map((r) => r.merchant_key));
  const seen = (key) => raw.filter((s) => s.member_keys.includes(key));
  const stated = (s) => s.member_keys.some((k) => states.has(k) || linked.has(k));
  const out = { active: [], cancelled: [], stopped: [], dismissed: [], maybe: [] };

  for (const s of raw) {
    if (stated(s)) continue;
    const base = item({
      key: `d:${s.merchant_key}${s.variant ? `:${s.variant}` : ''}`, merchant_key: s.merchant_key, name: s.merchant, amount: s.amount, cadence: s.cadence,
      per_month: perMonth(s.amount, s.cadence), next_date: s.next_date, last_date: s.last_date, variable: s.variable, variant: s.variant,
      count: s.count, category_id: s.category_id, category: s.category,
    });
    if (s.active) out.active.push({ ...base, status: 'active' });
    else if (daysBetween(s.last_date, today) <= STALE_AFTER_DAYS) out.stopped.push({ ...base, status: 'stopped' });
  }

  for (const r of rows) {
    const common = { id: r.id, key: r.origin === 'manual' ? `m:${r.id}` : `d:${r.merchant_key}`, origin: r.origin, merchant_key: r.merchant_key, name: r.name, amount: r.amount, cadence: r.cadence, category_id: r.category_id, category: r.category, note: r.note };
    const per_month = r.amount && r.cadence ? perMonth(r.amount, r.cadence) : 0;
    const last = seen(r.merchant_key ?? '').map((s) => s.last_date).sort().at(-1) ?? null;
    if (r.status === 'active') {
      if (r.origin === 'manual') out.active.push(item({ ...common, per_month, next_date: rollForward(r.cadence, r.next_date, today), last_date: last, status: 'active' }));
    } else if (r.status === 'cancelled') {
      out.cancelled.push(item({
        ...common, per_month, status: 'cancelled', cancelled_on: r.cancelled_on, last_date: last,
        next_date: r.next_date ?? '', still_charging: !!last && !!r.cancelled_on && daysBetween(addDays(r.cancelled_on, CHARGED_AFTER_CANCEL_DAYS), last) > 0,
      }));
    } else {
      out.dismissed.push(item({ ...common, per_month, status: 'dismissed', last_date: last, next_date: '' }));
    }
  }

  const taken = new Set([...states.keys(), ...linked, ...raw.flatMap((s) => s.member_keys)]);
  for (const m of maybeSubscriptions(db, today)) {
    if (taken.has(m.merchant_key)) continue;
    out.maybe.push(item({
      key: `s:${m.merchant_key}`, merchant_key: m.merchant_key, name: m.merchant, amount: m.amount, cadence: 'monthly', per_month: m.amount,
      next_date: rollForward('monthly', addMonths(m.last_date, 1), today), last_date: m.last_date, count: m.count, category_id: m.category_id, status: 'maybe',
    }));
  }

  out.active.sort(byNext);
  out.stopped.sort((a, b) => (a.last_date < b.last_date ? 1 : -1));
  out.cancelled.sort((a, b) => (a.cancelled_on < b.cancelled_on ? 1 : a.cancelled_on > b.cancelled_on ? -1 : a.name.localeCompare(b.name)));
  out.dismissed.sort((a, b) => a.name.localeCompare(b.name));
  return {
    as_of: today, ...out,
    totals: { active_per_month: sum(out.active), cancelled_saved_per_month: sum(out.cancelled) },
    note: 'Cents. per_month is the cost of one charge spread over a month (weekly x 52/12, fortnightly x 26/12, quarterly / 3, yearly / 12). A cancelled one stays listed with what it saves.',
  };
}
