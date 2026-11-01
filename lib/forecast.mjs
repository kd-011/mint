// Cashflow forecast: the spendable balance day by day from today to the next
// payday and out to 30 days. Built from what Mint already knows:
//   start       the spendable accounts' balances now (lib/safe.mjs)
//   pay         the detected salary cycle, shifted off weekends and WA public
//               holidays, plus regular payers that land in a spendable account
//   bills       bills and subscriptions still due, at their next expected dates
//               (lib/bills.mjs), when they come out of a spending account or
//               the loan; ones charged to a card reach the account through
//               the card repayment
//   pay split   the planned savings and paydowns off each payday. A card
//               repayment follows the pay split and never exceeds what the
//               card would owe by then (owed now plus its spending since).
//               Redbark gives no statement date, so none is guessed. A card
//               with no pay split line has its spending counted as it happens.
//   baseline    daily variable spend on the spending accounts over the
//               trailing eight weeks, leaving out recurring charges and
//               transfers (loan interest and card spend never touch the balance)
// The range around the line is an estimate of the baseline's variability.
import { getSetting, setSetting } from './db.mjs';
import { bad } from './errors.mjs';
import { addDays, daysBetween } from './dates.mjs';
import { COUNTS, BUSINESS, FROM, KIND } from './spend.mjs';
import { anchorSource, currentCycle, paydays, DEFAULT_CADENCE } from './cycles.mjs';
import { salaryStats, REGULAR_GRACE_DAYS } from './income.mjs';
import { getPlan, splitStatus, SPLIT_DAYS as PLAN_SPLIT_DAYS } from './plan.mjs';
import { billsCalendar } from './bills.mjs';
import { recurringKeys } from './recurring.mjs';
import { merchantKey } from './merchant.mjs';
import { spendableAccounts } from './safe.mjs';
import { upcomingPaydays, baselineFromDaily, projectCashflow } from './forecastmath.mjs';
import { LIVE } from './live.mjs';

export const HORIZON_DAYS = 30;
export const BASELINE_DAYS = 56;
const SPLIT_DAYS = PLAN_SPLIT_DAYS;
const FLOOR_KEY = 'forecast_floor';
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (iso) => WD[new Date(`${iso}T00:00:00Z`).getUTCDay()];

export const getFloor = (db) => {
  const n = Number(getSetting(db, FLOOR_KEY));
  return Number.isInteger(n) && n >= 0 ? n : 0;
};
export function setFloor(db, cents) {
  if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0 || cents > 1e10) throw bad('floor must be whole cents, zero or more');
  setSetting(db, FLOOR_KEY, cents);
  return cents;
}

const money0 = (c) => `$${Math.round(c / 100).toLocaleString('en-AU')}`;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const unavailable = (db, today, why, reason) => ({ as_of: today, available: false, why, reason, floor: getFloor(db) });

// Daily personal spend before `today`, recurring charges and transfers left
// out: on the spending accounts (the cash baseline) and per credit card.
function baselineSpend(db, today, spendable) {
  const recurring = recurringKeys(db, today);
  const rows = db.prepare(`SELECT t.date, -t.amount amount, a.id account_id, a.type, COALESCE(t.merchant_override, t.merchant) merchant FROM ${FROM}
    WHERE ${COUNTS} AND ${BUSINESS} = 0 AND ${KIND} = 'expense' AND t.date >= ? AND t.date <= ?`).all(addDays(today, -BASELINE_DAYS), today)
    .filter((r) => !recurring.has(merchantKey(r.merchant)));
  const first = db.prepare('SELECT MIN(date) d FROM transactions WHERE ' + LIVE('transactions')).get().d;
  const from = first && first > addDays(today, -BASELINE_DAYS) ? first : addDays(today, -BASELINE_DAYS);
  const to = addDays(today, -1);
  const lines = new Map();
  const bucket = (key) => lines.get(key) ?? lines.set(key, new Map()).get(key);
  let spentToday = 0;
  for (const r of rows) {
    const key = spendable.has(r.account_id) ? 'direct' : r.type === 'credit-card' ? r.account_id : null;
    if (!key) continue;
    if (r.date === today) { if (key === 'direct') spentToday += r.amount; continue; }
    const by = bucket(key);
    by.set(r.date, (by.get(r.date) ?? 0) + r.amount);
  }
  const series = (by) => {
    const values = [];
    for (let d = from; d <= to; d = addDays(d, 1)) values.push(Math.max(0, by?.get(d) ?? 0));
    return baselineFromDaily(values);
  };
  const cards = new Map([...lines].filter(([k]) => k !== 'direct').map(([k, by]) => [k, series(by)]));
  return { direct: { ...series(lines.get('direct')), from, to }, cards, spent_today: Math.max(0, spentToday) };
}

// Regular payers (a fortnightly family payment, say) still to come that land
// in a spendable account. A payment past the grace period is missed, not counted.
function regularEvents(db, today, end, spendable) {
  const out = [];
  for (const s of db.prepare("SELECT id, name, cadence_days FROM income_sources WHERE kind = 'regular' ORDER BY priority, id").all()) {
    const rows = db.prepare("SELECT date, amount, account_id FROM transactions WHERE income_source_id = ? AND income_kind = 'regular' AND " + LIVE('transactions') + " ORDER BY date, id").all(s.id);
    if (!rows.length || !spendable.has(rows.at(-1).account_id)) continue;
    const cad = s.cadence_days || DEFAULT_CADENCE;
    const amount = median(rows.slice(-4).map((r) => r.amount));
    for (let next = addDays(rows.at(-1).date, cad); next <= end; next = addDays(next, cad)) {
      const overdue = daysBetween(next, today);
      if (overdue > REGULAR_GRACE_DAYS) continue;
      out.push({ date: overdue > 0 ? today : next, amount, label: s.name, kind: 'income', sub: 'regular', note: overdue > 0 ? 'Late, counted for today' : null });
    }
  }
  return out;
}

// The pay split as outflows: what is still to move this cycle (only in the few
// days after payday that Mint's own check allows, else it is treated as
// skipped), and the full plan off each coming payday. A card repayment stops
// at what the card would owe by that date. cards: Map id -> { owed, daily,
// bills: [{ date, amount }] }.
function splitEvents(db, today, pay, paydayDates, lines, cards, cycleStart) {
  if (!lines.length) return [];
  const short = new Map(splitStatus(db, { today }).lines.map((l) => [l.account_id, l.short]));
  const fresh = daysBetween(cycleStart, today) <= SPLIT_DAYS;
  const wanted = [];
  for (const l of lines) {
    if (fresh && short.get(l.account_id) > 0) wanted.push({ date: today, line: l, amount: short.get(l.account_id), note: 'Not moved yet this cycle' });
    for (const date of paydayDates) wanted.push({ date, line: l, amount: l.amount ?? Math.round((pay * (l.percent ?? 0)) / 100), note: null });
  }
  wanted.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const repaid = new Map();
  const out = [];
  for (const w of wanted) {
    const c = cards.get(w.line.account_id);
    let amount = w.amount;
    if (c) {
      const owed = c.owed + c.daily * (daysBetween(today, w.date) + 1) + c.bills.filter((b) => b.date <= w.date).reduce((s, b) => s + b.amount, 0) - (repaid.get(w.line.account_id) ?? 0);
      amount = Math.min(amount, Math.max(0, Math.round(owed)));
      repaid.set(w.line.account_id, (repaid.get(w.line.account_id) ?? 0) + amount);
    }
    if (amount <= 0) continue;
    out.push({ date: w.date, amount: -amount, label: c ? `Card repayment: ${w.line.account}` : `Pay split: ${w.line.account}`, kind: c ? 'card' : 'split', sub: w.line.kind, note: w.note });
  }
  return out;
}

export function forecast(db, { today, days = HORIZON_DAYS } = {}) {
  const src = anchorSource(db);
  const cycle = src ? currentCycle(db, { today }) : null;
  if (!src || !cycle) return unavailable(db, today, 'no_salary', 'No salary seen yet, so there is no payday to forecast to. Once a salary lands, Mint plots your balance up to the next one.');
  const accounts = spendableAccounts(db);
  if (!accounts.length) return unavailable(db, today, 'no_account', 'No spending account is set, so there is no balance to forecast. Mark one as spendable in Accounts.');
  const spendable = new Set(accounts.map((a) => a.id));
  const startBalance = accounts.reduce((s, a) => s + a.balance, 0);

  const lastPay = paydays(db).at(-1)?.date ?? cycle.start;
  const cadence = src.cadence_days || DEFAULT_CADENCE;
  const pay = salaryStats(db).median ?? paydays(db).at(-1)?.amount ?? 0;
  const first = upcomingPaydays({ last: lastPay, cadence, today, until: addDays(today, 60) })[0];
  const horizon = Math.max(days, first ? daysBetween(today, first.date) : 0);
  const end = addDays(today, horizon);
  const coming = upcomingPaydays({ last: lastPay, cadence, today, until: end });

  const events = [];
  for (const p of coming) {
    events.push({ date: p.date, amount: pay, label: 'Salary', kind: 'income', sub: 'salary', late: p.late, note: p.late ? 'Overdue, counted for today' : p.shifted ? `Due ${weekday(p.nominal)} ${p.nominal.slice(8)}/${p.nominal.slice(5, 7)}, paid the business day before` : null });
  }
  events.push(...regularEvents(db, today, end, spendable));
  const base = baselineSpend(db, today, spendable);
  const types = new Map(db.prepare("SELECT id, type, COALESCE(nickname, name) name, balance_current FROM accounts WHERE is_business = 0 AND status IS NOT 'gone'").all().map((a) => [a.id, a]));
  const lines = getPlan(db, { today }).lines.filter((l) => l.kind !== 'spending');
  const planned = new Set(lines.map((l) => l.account_id));
  // Cards on the pay split are repaid from the account; the rest are counted as they spend.
  const cards = new Map();
  const asYouGo = [];
  for (const [id, a] of types) {
    if (a.type !== 'credit-card') continue;
    const daily = base.cards.get(id) ?? { daily: 0, sd: 0 };
    if (planned.has(id)) cards.set(id, { owed: Math.max(0, -(a.balance_current ?? 0)), daily: daily.daily, bills: [] });
    else if (daily.daily > 0) asYouGo.push({ id, name: a.name, ...daily });
  }

  const cal = billsCalendar(db, { today, days: Math.min(120, Math.max(7, horizon + 1)) });
  const onCard = [];
  for (const b of cal.items) {
    if (b.status !== 'due') continue;
    const date = b.date < today ? today : b.date;
    const note = b.date < today ? 'Overdue, counted for today' : b.price_change ? 'Price rise on the last charge' : null;
    const card = cards.get(b.account_id);
    if (card) {
      card.bills.push({ date, amount: b.amount });
      onCard.push({ date, amount: 0, charge: -b.amount, label: b.merchant, kind: 'bill', sub: b.kind, on_card: true, note: `On ${types.get(b.account_id).name}, paid with the card repayment` });
    } else if (b.kind === 'loan' || spendable.has(b.account_id) || types.get(b.account_id)?.type === 'credit-card') {
      events.push({ date, amount: -b.amount, label: b.merchant, kind: 'bill', sub: b.kind, note });
    }
  }
  events.push(...onCard);
  // A loan the bills calendar already carries (its instalment dates are known) is
  // counted there once; its pay split line would take the same repayment off again.
  const loansInBills = new Set(cal.items.filter((b) => b.kind === 'loan').map((b) => b.account_id));
  const splitLines = lines.filter((l) => !loansInBills.has(l.account_id));
  events.push(...splitEvents(db, today, pay, coming.map((p) => p.date), splitLines, cards, cycle.start));

  // Spending on cards that are not on the pay split comes off as it happens.
  const sd = Math.round(Math.sqrt([base.direct, ...asYouGo].reduce((s, b) => s + b.sd ** 2, 0)));
  const baseline = { daily: base.direct.daily + asYouGo.reduce((s, b) => s + b.daily, 0), sd };
  const floor = getFloor(db);
  const next = coming[0] ?? null;
  const p = projectCashflow({ today, balance: startBalance, days: horizon, floor, events, baseline, spentToday: base.spent_today, next_payday: next?.date ?? null });
  return {
    as_of: today,
    available: true,
    start_balance: startBalance,
    floor,
    horizon_days: horizon,
    next_payday: next ? { date: next.date, nominal: next.nominal, shifted: next.shifted, late: next.late, amount: pay } : null,
    days: p.days,
    lowest: p.lowest,
    lowest_before_payday: p.lowest_before_payday,
    status: p.status,
    first_breach: p.first_breach,
    first_possible: p.first_possible,
    items: p.items.map(({ date, label, kind, sub, amount, balance_after, note, on_card, charge }) => ({ date, label, kind, sub, amount, balance_after, note: note ?? null, ...(on_card ? { on_card: true, charge } : {}) })),
    baseline: { daily: baseline.daily, sd: baseline.sd, days: base.direct.days, from: base.direct.from, to: base.direct.to, capped: base.direct.capped },
    accounts: accounts.map(({ id, name, balance }) => ({ id, name, balance })),
    note: 'An estimate. The line is your spendable balance; the shaded range is how far usual day to day spending could swing it, about two outcomes in three. It cannot see one-off costs.',
    assumptions: [
      'Pay lands on the detected cycle; a payday on a weekend or WA public holiday is paid the business day before.',
      `Everyday spending is your average on your spending accounts over the last ${base.direct.days} days, leaving out bills, subscriptions and transfers.`,
      'Bills and subscriptions repeat at their usual dates and amounts. A home loan repayment is counted once, from its instalment dates, even when it is also on your pay split.',
      'Card purchases reach your account through the card repayment. Repayments follow your pay split and stop at what the card would owe by then; Mint has no statement date to go on.',
      `A pay split line not moved within ${SPLIT_DAYS} days of payday is treated as skipped this cycle.`,
      ...asYouGo.map((c) => `${c.name} is not on your pay split, so its spending (${money0(c.daily)} a day) is counted as it happens.`),
    ],
  };
}
