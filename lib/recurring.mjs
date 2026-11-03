// Subscriptions and regular bills: the same merchant charging a steady amount
// on a steady cadence. Walks back from each merchant's latest charge while
// the gaps fit one cadence, then checks the amounts hold still (bar a price
// rise on the latest charge). Conservative by design: varied amounts or
// irregular gaps are not a subscription.
//
// One exception, because the owner has already told Mint what it is: a merchant
// whose rows are mostly filed under Subscriptions (by him or a rule) gets a
// looser second look when the strict test finds nothing. Each price point is
// its own series (a $3 plan on the 9th and a $16 plan on the 18th), amounts may
// drift about 35% around their norm (usage-priced services), two charges are
// enough for a monthly or longer cadence, and a stray top-up after the last
// regular charge is ignored. Play Store names cut short at different lengths
// ("Google Soundclo", "Google Soundcloud The") count as one service. Nothing
// outside Subscriptions gets this.
//
// Not subscriptions at all: transfers and person-to-person payments, and
// everyday spend (eating out, fuel, parking) that merely repeats. A bill by
// category (insurance, utilities, rego) is kept even when paid by online transfer.
//
// detectRaw is what the book looks like; detectRecurring is what the money
// maths uses: the owner's states applied (cancelled and dismissed ones removed,
// see lib/subscriptions.mjs) and the ones he typed in added.
import { merchantKey, isInstalment } from './merchant.mjs';
import { addDays, daysBetween } from './dates.mjs';
import { COUNTS, FROM, BUSINESS } from './spend.mjs';

export const CADENCES = [
  { name: 'weekly', days: 7, min: 6, max: 8, grace: 3 },
  { name: 'fortnightly', days: 14, min: 12, max: 16, grace: 4 },
  { name: 'monthly', days: 30, min: 26, max: 35, grace: 7, months: 1 },
  { name: 'quarterly', days: 91, min: 83, max: 99, grace: 14, months: 3 },
  { name: 'yearly', days: 365, min: 353, max: 377, grace: 30, months: 12 },
];
const TWO_CHARGE_MIN = 1000; // a two-charge series must be at least $10 and identical
const NEW_WITHIN_DAYS = 75;
const BILL_GROUPS = new Set(['Home']);
const BILL_NAMES = new Set(['Rego', 'Government and fees', 'Insurance', 'Utilities', 'Phone and internet']);
const SUBS = 'Subscriptions';
const TOLERANCE = 0.35; // a candidate's amounts stay within this of their median
const CLUSTER_RATIO = 1.4; // sorted amounts closer than this belong to one price point
const TOLERANT_MIN = 200; // a candidate series under $2 is noise
const EVERYDAY = new Set(['Eating out', 'Takeaway and delivery', 'Groceries', 'Alcohol', 'Fuel', 'Parking and tolls', 'Public transport', 'Rideshare and taxis', 'Travel', 'Cash', 'Debt repayments']);
const TRANSFERISH = /\b(linked acc(ount)?|internet transfer|online transfer|funds transfer|transfer (to|from)|trns|tfr|loan (instalment|repayment|payment)|to a\/c|osko|payid|pay anyone|bpay)\b/i;
// "ONLINE X1234567890 Lunch SURNAME AB": an online payment to a person (or one of the owner's own accounts) with a memo.
const PERSON_PAYMENT = /^ONLINE\s+[A-Z]?\d{6,}\s+.+\s[A-Z]{2,}\s[A-Z]{1,3}$/;

// Cost per month of a charge on each cadence, in whole cents.
export const PER_MONTH = { weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
export const perMonth = (amount, cadence) => Math.round(amount * (PER_MONTH[cadence] ?? 0));

export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const cadenceFor = (gap) => CADENCES.find((c) => gap >= c.min && gap <= c.max) ?? null;
const nextDate = (c, last) => (c.months ? addMonths(last, c.months) : addDays(last, c.days));
export const stepBy = (cadence, iso, k) => {
  const c = CADENCES.find((x) => x.name === cadence);
  return c.months ? addMonths(iso, c.months * k) : addDays(iso, c.days * k);
};
// The first date of a cadence anchored at `iso` that is today or later.
export function rollForward(cadence, iso, today) {
  let k = 0;
  while (stepBy(cadence, iso, k) < today && k < 4000) k += 1;
  return stepBy(cadence, iso, k);
}

// One charge per day: two on a day are summed.
function perDay(charges) {
  const days = [];
  for (const ch of charges) {
    const prev = days.at(-1);
    if (prev && prev.date === ch.date) prev.amount += ch.amount;
    else days.push({ ...ch });
  }
  return days;
}

function result(c, run, history, today, { amount, typical, price_rise = null, variable = false, variant = null }) {
  const last = run.at(-1);
  const next = nextDate(c, last.date);
  return {
    cadence: c.name, interval_days: c.days, amount, typical, count: run.length,
    first_date: run[0].date, last_date: last.date, next_date: next,
    active: daysBetween(today, next) >= -c.grace,
    is_new: daysBetween(run[0].date, today) <= NEW_WITHIN_DAYS && history === 0,
    price_rise, variable, variant,
    recent: run.slice(-6).map((r) => ({ date: r.date, amount: r.amount })),
  };
}

function series(charges, today) {
  const days = perDay(charges);
  if (days.length < 2) return null;
  const last = days.at(-1);
  const c = cadenceFor(daysBetween(days.at(-2).date, last.date));
  if (!c) return null;
  let start = days.length - 2;
  while (start > 0 && Math.max(0, days.length - 13) < start) {
    const g = daysBetween(days[start - 1].date, days[start].date);
    if (g < c.min || g > c.max) break;
    start -= 1;
  }
  const run = days.slice(start);
  const amounts = run.map((r) => r.amount);
  if (run.length === 2) {
    if (amounts[0] !== amounts[1] || amounts[0] < TWO_CHARGE_MIN || !c.months || c.name === 'quarterly') return null;
    // Nothing else from this merchant around the pair.
    if (days.length > 2 && daysBetween(days.at(-3).date, run[0].date) <= c.max + c.grace) return null;
  }
  const base = amounts.slice(0, -1).slice(-4);
  const typical = median(base);
  if ((Math.max(...base) - Math.min(...base)) > typical * 0.1) return null;
  const lastAmount = amounts.at(-1);
  let priceRise = null;
  if (Math.abs(lastAmount - typical) > typical * 0.1) {
    const prev = amounts.at(-2);
    if (!(lastAmount > prev && lastAmount <= prev * 1.5)) return null;
  }
  if (lastAmount > amounts.at(-2) && lastAmount - amounts.at(-2) >= 50 && lastAmount >= amounts.at(-2) * 1.03) {
    priceRise = { from: amounts.at(-2), to: lastAmount, date: last.date };
  }
  return result(c, run, days.slice(0, start).length, today, { amount: lastAmount, typical, price_rise: priceRise });
}

// the looser test for merchants the owner filed under Subscriptions

const withinNorm = (amounts) => {
  const m = median(amounts);
  return amounts.every((a) => Math.abs(a - m) <= m * TOLERANCE);
};

// Charges grouped into price points: sorted amounts side by side within
// CLUSTER_RATIO of each other are one, and a group whose amounts stray more
// than TOLERANCE from its median is dropped rather than guessed at.
function pricePoints(charges) {
  const sorted = [...charges].sort((a, b) => a.amount - b.amount);
  const groups = [];
  for (const ch of sorted) {
    const cur = groups.at(-1);
    if (cur && ch.amount <= cur.at(-1).amount * CLUSTER_RATIO) cur.push(ch);
    else groups.push([ch]);
  }
  return groups.filter((g) => withinNorm(g.map((r) => r.amount))).map((g) => g.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)));
}

// The regular run ending at one of the last three charges (so a stray top-up
// after it does not hide the rhythm) and its cadence.
function tolerantRun(days, today, historyBefore) {
  for (let a = days.length - 1; a >= Math.max(1, days.length - 3); a--) {
    const c = cadenceFor(daysBetween(days[a - 1].date, days[a].date));
    if (!c) continue;
    let start = a - 1;
    while (start > 0 && a - start < 12) {
      const g = daysBetween(days[start - 1].date, days[start].date);
      if (g < c.min || g > c.max) break;
      start -= 1;
    }
    const run = days.slice(start, a + 1);
    if (run.length < 3 && !c.months) continue; // weekly and fortnightly need three
    const amounts = run.map((r) => r.amount);
    const typical = median(amounts.slice(-4));
    if (typical < TOLERANT_MIN) continue;
    const variable = Math.max(...amounts) - Math.min(...amounts) > typical * 0.1;
    const lastAmount = amounts.at(-1);
    const prev = amounts.at(-2);
    const rise = !variable && lastAmount > prev && lastAmount - prev >= 50 && lastAmount >= prev * 1.03;
    return result(c, run, historyBefore(run[0].date), today, {
      amount: variable ? typical : lastAmount, typical, variable,
      price_rise: rise ? { from: prev, to: lastAmount, date: run.at(-1).date } : null,
    });
  }
  return null;
}

function tolerantSeries(charges, today, historyBefore) {
  const found = [];
  for (const point of pricePoints(charges)) {
    const days = perDay(point);
    if (days.length < 2) continue;
    const s = tolerantRun(days, today, historyBefore);
    if (s) found.push(s);
  }
  if (found.length > 1) for (const s of found) s.variant = s.typical;
  return found;
}

// "google soundclo" and "google soundcloud the" are one Play Store service cut
// short at different lengths; "google youtube" and "youtube" are one service
// billed two ways. Two different full names ("microsoft", "microsoft xbox") stay apart.
const family = (k) => k.replace(/^google /, '').split(' ');
function sameService(a, b) {
  const [x, y] = family(a).length <= family(b).length ? [family(a), family(b)] : [family(b), family(a)];
  for (let i = 0; i < x.length - 1; i++) if (x[i] !== y[i]) return false;
  const last = x.length - 1;
  if (x.length === y.length) return x[last] === y[last] || (x[last].length >= 4 && y[last].startsWith(x[last]));
  return x[last].length >= 4 && y[last].startsWith(x[last]) && x[last] !== y[last];
}

function mergeServices(groups, candidate) {
  const keys = [...groups.keys()].filter((k) => candidate(groups.get(k)));
  const parent = new Map(keys.map((k) => [k, k]));
  const root = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) if (sameService(keys[i], keys[j])) parent.set(root(keys[i]), root(keys[j]));
  const out = new Map([...groups].filter(([k]) => !parent.has(k)));
  const families = new Map();
  for (const k of keys) (families.get(root(k)) ?? families.set(root(k), []).get(root(k))).push(...groups.get(k));
  for (const rows of families.values()) {
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    // Keyed by the earliest charge's name: new charges arrive under newer cuts, and the owner's states hang off this key.
    out.set(merchantKey(rows[0].merchant), rows);
  }
  return out;
}

const isCandidate = (rows) => rows.filter((r) => r.category === SUBS).length * 2 >= rows.length;
const transferLike = (rows) => rows.filter((r) => TRANSFERISH.test(r.description) || PERSON_PAYMENT.test(r.description)
  || /^(TRANSFER_|LOAN_PAYMENTS)/.test(r.pc ?? '')).length * 2 >= rows.length;

const order = (a, b) => Number(b.active) - Number(a.active) || (a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : 0);

const BOOK_ROWS = `SELECT t.id, t.date, -t.amount amount, t.account_id, COALESCE(t.merchant_override, t.merchant) merchant, t.description, t.provider_category pc,
    t.category_id, c.name category, c.grp, ${BUSINESS} biz
  FROM ${FROM} WHERE t.amount < 0 AND t.status = 'posted' AND t.date <= ? AND ${COUNTS} ORDER BY t.date, t.id`;

// Posted spend grouped by merchant, with Play Store names cut short merged.
function bookGroups(db, today) {
  const byKey = new Map();
  for (const r of db.prepare(BOOK_ROWS).all(today)) {
    const k = merchantKey(r.merchant);
    if (!k || isInstalment(r.description)) continue;
    (byKey.get(k) ?? byKey.set(k, []).get(k)).push(r);
  }
  return mergeServices(byKey, isCandidate);
}

// One merchant: its series (none when it is not recurring or not a subscription at all).
function seriesFor(key, charges, today) {
  const candidate = isCandidate(charges);
  const mine = candidate ? charges.filter((r) => r.category === SUBS) : charges;
  const ref = mine.at(-1);
  const kind = BILL_GROUPS.has(ref.grp) || BILL_NAMES.has(ref.category) ? 'bill' : 'subscription';
  const skip = kind === 'subscription' && (transferLike(charges) || (!candidate && EVERYDAY.has(ref.category)));
  const strict = skip ? null : series(charges, today);
  const found = skip ? [] : strict ? [strict] : candidate ? tolerantSeries(mine, today, (date) => charges.filter((r) => r.date < date).length) : [];
  return { candidate, mine, ref, kind, skip, found };
}

// What the book shows, before any of the owner's states.
export function detectRaw(db, today) {
  const out = [];
  for (const [key, charges] of bookGroups(db, today)) {
    const { ref, kind, found } = seriesFor(key, charges, today);
    for (const s of found) {
      out.push({
        merchant: ref.merchant, merchant_key: key, member_keys: [...new Set(charges.map((r) => merchantKey(r.merchant)))], ...s, account_id: ref.account_id,
        category_id: ref.category_id, category: ref.category, kind,
      });
    }
  }
  return out.sort(order);
}

// Merchants the owner filed under Subscriptions that charged in the last few weeks
// but show no rhythm yet (one charge, or two with no cadence between them):
// worth a tap to add by hand. Personal accounts only.
export const MAYBE_WITHIN_DAYS = 45;
export function maybeSubscriptions(db, today) {
  const out = [];
  for (const [key, charges] of bookGroups(db, today)) {
    const { candidate, mine, ref, kind, skip, found } = seriesFor(key, charges, today);
    if (!candidate || skip || kind !== 'subscription' || found.length || ref.biz) continue;
    if (daysBetween(ref.date, today) > MAYBE_WITHIN_DAYS) continue;
    out.push({ merchant: ref.merchant, merchant_key: key, amount: ref.amount, last_date: ref.date, count: mine.length, account_id: ref.account_id, category_id: ref.category_id });
  }
  return out.sort((a, b) => (a.last_date < b.last_date ? 1 : -1));
}

// A manual subscription as the bills calendar, forecast and alerts see a detected one.
function manualEntry(row, today, seen) {
  const next = rollForward(row.cadence, row.next_date, today);
  const c = CADENCES.find((x) => x.name === row.cadence);
  return {
    merchant: row.name, merchant_key: row.merchant_key ?? `manual:${row.id}`, cadence: c.name, interval_days: c.days,
    amount: row.amount, typical: row.amount, count: seen?.count ?? 0, first_date: seen?.first_date ?? null,
    last_date: stepBy(c.name, next, -1), next_date: next, anchor_date: next, active: true, is_new: false,
    price_rise: null, variable: false, variant: null, recent: seen?.recent ?? [], account_id: seen?.account_id ?? null,
    category_id: row.category_id ?? seen?.category_id ?? null, category: row.category ?? seen?.category ?? null,
    kind: 'subscription', manual_id: row.id,
  };
}

const stateRows = (db) => db.prepare(`SELECT s.*, c.name category FROM subscriptions s LEFT JOIN categories c ON c.id = s.category_id`).all();
// A merchant is taken out of the detected list by a cancel or dismiss on it, or by a manual entry linked to it.
const hides = (r) => !!r.merchant_key && (r.origin === 'manual' || r.status !== 'active');

// What the money maths uses: the book less cancelled and dismissed subscriptions, plus manual active ones.
export function detectRecurring(db, today) {
  const rows = stateRows(db);
  const hidden = new Set(rows.filter(hides).map((r) => r.merchant_key));
  // A state on any name the service has billed under applies to all of them.
  const isHidden = (s) => s.member_keys.some((k) => hidden.has(k));
  const raw = detectRaw(db, today);
  const manual = rows.filter((r) => r.origin === 'manual' && r.status === 'active')
    .map((r) => manualEntry(r, today, r.merchant_key ? raw.find((s) => s.member_keys.includes(r.merchant_key)) : null));
  return [...raw.filter((s) => !isHidden(s)), ...manual].sort(order);
}

// Merchants whose charges are not everyday spend: live and lapsed subscriptions
// and bills, plus cancelled ones (a cancelled charge in the last weeks must not
// read as baseline spending). A dismissed merchant is ordinary spending again.
export function recurringKeys(db, today) {
  const rows = stateRows(db);
  const keys = new Set(detectRecurring(db, today).map((s) => s.merchant_key));
  for (const r of rows) if (r.merchant_key && r.status === 'cancelled') keys.add(r.merchant_key);
  for (const s of detectRaw(db, today)) if (s.member_keys.some((k) => keys.has(k))) for (const k of s.member_keys) keys.add(k);
  return keys;
}
