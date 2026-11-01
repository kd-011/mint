// The alert pipeline. Five kinds push to the owner through the assistant (rows with
// pushed_at empty until the assistant marks them delivered): an unusual charge, a
// new subscription or price rise, a sync or consent problem, a budget at 90
// percent or over, and the spending pace (from the pay cycle's midpoint,
// flexible spend projected more than 10% over the flexible budget). The
// payday alert (the salary landed, here is the planned split) is in-app only
// and never queued for push. The UNIQUE (kind, key, period) row is the dedupe:
// budget and pace alerts once per pay cycle (per calendar month while there
// is no pay cycle yet), a sync failure once per incident, a payday once per
// salary deposit. The weekly summary is a line for the morning brief.
import { getSetting } from './db.mjs';
import { detectUnusual } from './unusual.mjs';
import { detectRecurring } from './recurring.mjs';
import { budgetEvents, budgetProgress, cycleBudgetEvents, cycleBudgetProgress, freshStarter } from './budgets.mjs';
import { currentCycle } from './cycles.mjs';
import { getPlan } from './plan.mjs';
import { safeToSpend } from './safe.mjs';
import { zoneDate, addDays, daysBetween, fmtDMY } from './dates.mjs';
import { notFound } from './errors.mjs';
import { COUNTS, FROM, KIND, INCOME } from './spend.mjs';

export const PUSH_KINDS = new Set(['unusual', 'subscription', 'sync', 'budget', 'pace']);
const PACE_OVER = 1.1;
const PAYDAY_RECENT_DAYS = 3;
const CONSENT_WARN_DAYS = 30;
const PRICE_RISE_RECENT_DAYS = 40;
const OK_CONNECTION = new Set(['active', 'expiring']);

export const money = (cents) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dm = (iso) => fmtDMY(iso).slice(0, 5);

// wise: Wise sync is switched on (WISE_API_TOKEN set). Its accounts are manual, so they alert like
// bank accounts only then; with it off they never do.
function candidates(db, { now, staleHours, wise = false }) {
  const today = zoneDate(now);
  const out = [];

  for (const u of detectUnusual(db, today)) {
    const acct = db.prepare('SELECT COALESCE(a.nickname, a.name) n FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?').get(u.transaction_id)?.n ?? '';
    out.push({
      kind: 'unusual', type: u.reason, key: u.transaction_id, period: '',
      title: `Unusual charge: ${u.merchant}`,
      body: u.reason === 'new_merchant'
        ? `${money(u.amount)} on ${fmtDMY(u.date)} on ${acct}, a merchant not seen before`
        : `${money(u.amount)} on ${fmtDMY(u.date)} on ${acct}, usually about ${money(u.norm)}`,
      transaction_id: u.transaction_id, amount: u.amount,
    });
  }

  for (const s of detectRecurring(db, today)) {
    if (!s.active) continue;
    if (s.is_new) {
      out.push({
        kind: 'subscription', type: 'new', key: `new:${s.merchant_key}`, period: '',
        title: `New ${s.kind === 'bill' ? 'regular bill' : 'subscription'}: ${s.merchant}`,
        body: `${money(s.amount)} ${s.cadence}, next expected ${fmtDMY(s.next_date)}`,
        merchant_key: s.merchant_key, amount: s.amount,
      });
    }
    if (s.price_rise && daysBetween(s.price_rise.date, today) <= PRICE_RISE_RECENT_DAYS) {
      out.push({
        kind: 'subscription', type: 'price_rise', key: `rise:${s.merchant_key}:${s.price_rise.to}`, period: '',
        title: `Price rise: ${s.merchant}`,
        body: `${money(s.price_rise.from)} to ${money(s.price_rise.to)} (${s.cadence}) from ${fmtDMY(s.price_rise.date)}`,
        merchant_key: s.merchant_key, amount: s.price_rise.to,
      });
    }
  }

  for (const a of db.prepare(`SELECT id, name, nickname, last_sync_error, last_synced_at, created_at FROM accounts
      WHERE status IS NOT 'gone' AND (manual = 0 OR (? = 1 AND wise_balance_id IS NOT NULL))`).all(wise ? 1 : 0)) {
    const name = a.nickname || a.name;
    const period = a.last_synced_at ? zoneDate(new Date(a.last_synced_at)) : 'never';
    if (a.last_sync_error) {
      out.push({ kind: 'sync', type: 'account_error', key: `account:${a.id}`, period, title: `Sync failing: ${name}`, body: String(a.last_sync_error).slice(0, 200), account_id: a.id });
    } else if (staleHours) {
      const since = Date.parse(a.last_synced_at ?? a.created_at);
      if (now - since > staleHours * 3600_000) {
        out.push({ kind: 'sync', type: 'stale', key: `account:${a.id}`, period, title: `No fresh data: ${name}`, body: a.last_synced_at ? `Last synced ${fmtDMY(period)}` : 'Never synced', account_id: a.id });
      }
    }
  }

  const wiseError = wise ? getSetting(db, 'wise_error') : null;
  if (wiseError) {
    const okAt = getSetting(db, 'wise_ok_at');
    out.push({ kind: 'sync', type: 'wise', key: 'wise', period: okAt ? zoneDate(new Date(okAt)) : 'never', title: 'Wise sync failing', body: String(wiseError).slice(0, 200) });
  }

  for (const c of db.prepare('SELECT id, institution, status, consent_expires_at FROM connections').all()) {
    if (!OK_CONNECTION.has(c.status)) {
      out.push({ kind: 'sync', type: 'connection', key: `connection:${c.id}`, period: `${c.status}:${c.consent_expires_at ?? ''}`, title: `Bank connection ${c.status}: ${c.institution}`, body: 'Reconnect it in Redbark to keep this bank syncing', connection_id: c.id });
      continue;
    }
    if (!c.consent_expires_at) continue;
    const exp = zoneDate(new Date(c.consent_expires_at));
    const days = daysBetween(today, exp);
    if (days <= CONSENT_WARN_DAYS) {
      out.push({
        kind: 'sync', type: 'consent_expiring', key: `consent:${c.id}`, period: exp,
        title: `Bank consent ${days < 0 ? 'expired' : 'expiring'}: ${c.institution}`,
        body: days < 0 ? `Expired ${fmtDMY(exp)}, renew it in Redbark` : `Expires ${fmtDMY(exp)} (${days} day${days === 1 ? '' : 's'}), renew it in Redbark`,
        connection_id: c.id,
      });
    }
  }

  const cycle = currentCycle(db, { today });
  if (!cycle) {
    const month = today.slice(0, 7);
    for (const e of budgetEvents(db, month)) {
      const type = e.level === 100 ? 'over' : '90';
      out.push({
        kind: 'budget', type, key: `${e.category_id}:${type}`, period: month,
        title: type === 'over' ? `${e.name} budget is over` : `${e.name} budget at ${e.pct}%`,
        body: `${money(e.spent)} of ${money(e.available)} spent this month`,
        category_id: e.category_id,
      });
    }
    return out;
  }
  out.push(...cycleCandidates(db, cycle, today));
  return out;
}

function cycleCandidates(db, cycle, today) {
  const out = [];
  const span = `${dm(cycle.start)} to ${dm(cycle.end)}`;
  for (const e of cycleBudgetEvents(db, cycle, { today })) {
    const type = e.level === 100 ? 'over' : '90';
    out.push({
      kind: 'budget', type, key: `${e.category_id}:${type}`, period: cycle.start,
      title: type === 'over' ? `${e.name} budget is over` : `${e.name} budget at ${e.pct}%`,
      body: `${money(e.spent)} of ${money(e.available)} spent this pay cycle (${span})`,
      category_id: e.category_id,
    });
  }
  if (cycle.open && cycle.day * 2 >= cycle.days) {
    const items = cycleBudgetProgress(db, cycle, { today, zero: false }).items.filter((i) => !i.fixed && !freshStarter(i, cycle));
    const flex = { spent: items.reduce((s, i) => s + i.spent, 0), available: items.reduce((s, i) => s + i.available, 0) };
    const projected = Math.round((flex.spent / cycle.day) * cycle.days);
    if (flex.available > 0 && projected > flex.available * PACE_OVER) {
      out.push({
        kind: 'pace', type: 'flexible', key: 'flexible', period: cycle.start,
        title: `Spending pace: on track for ${money(projected)} this pay cycle`,
        body: `${money(flex.spent)} of the ${money(flex.available)} flexible budget spent by day ${cycle.day} of ${cycle.days}. At this pace it is ${money(projected)} by payday ${dm(cycle.next_payday)}.`,
        spent: flex.spent, budget: flex.available, projected,
      });
    }
  }
  if (daysBetween(cycle.payday.date, today) <= PAYDAY_RECENT_DAYS) {
    const plan = getPlan(db, { today });
    const split = plan.lines.map((l) => `${l.account} ${money(l.planned)}`).join(', ');
    out.push({
      kind: 'payday', type: 'salary', key: cycle.payday.date, period: cycle.start,
      title: `Payday: ${money(cycle.payday.amount)} landed`,
      body: split ? `Planned split: ${split}.` : 'No pay split set yet.',
      amount: cycle.payday.amount, lines: plan.lines.map(({ account_id, account, kind, planned }) => ({ account_id, account, kind, planned })),
    });
  }
  return out;
}

const view = (r) => {
  let p = {};
  try { p = JSON.parse(r.payload ?? '{}'); } catch {}
  return { ...p, id: r.id, kind: r.kind, key: r.key, period: r.period, created_at: r.created_at, pushed_at: r.pushed_at, dismissed_at: r.dismissed_at };
};

// Evaluate every alert condition now; returns only the alerts that are new.
export function runAlerts(db, { now = new Date(), staleHours = 24, wise = false } = {}) {
  const at = now.toISOString();
  const ins = db.prepare('INSERT INTO alerts (kind, key, period, payload, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, key, period) DO NOTHING');
  const fresh = [];
  for (const { kind, key, period, ...payload } of candidates(db, { now, staleHours, wise })) {
    const r = ins.run(kind, key, period, JSON.stringify(payload), at);
    if (r.changes) fresh.push(view(db.prepare('SELECT * FROM alerts WHERE id = ?').get(r.lastInsertRowid)));
  }
  return fresh;
}

export function listAlerts(db, { includeDismissed = false, limit = 100 } = {}) {
  return db.prepare(`SELECT * FROM alerts ${includeDismissed ? '' : 'WHERE dismissed_at IS NULL'} ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit).map(view);
}

export function dismissAlert(db, id) {
  if (!Number.isInteger(id) || !db.prepare('UPDATE alerts SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL').run(new Date().toISOString(), id).changes) {
    if (!(Number.isInteger(id) && db.prepare('SELECT 1 FROM alerts WHERE id = ?').get(id))) throw notFound('no such alert');
  }
  return view(db.prepare('SELECT * FROM alerts WHERE id = ?').get(id));
}

// One line on last Monday to Sunday for the 6:30 brief.
export function weeklySummary(db, today) {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const thisMonday = addDays(today, -((dow + 6) % 7));
  const from = addDays(thisMonday, -7);
  const to = addDays(thisMonday, -1);
  const week = (f, t) => db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN ${INCOME} THEN t.amount END), 0) income,
      COALESCE(-SUM(CASE WHEN ${KIND} = 'expense' THEN t.amount END), 0) spent
    FROM ${FROM} WHERE ${COUNTS} AND t.date BETWEEN ? AND ?`).get(f, t);
  const w = week(from, to);
  const prior = week(addDays(from, -28), addDays(from, -1));
  const top = db.prepare(`SELECT c.name, -SUM(t.amount) spent FROM ${FROM}
    WHERE ${COUNTS} AND c.kind = 'expense' AND t.date BETWEEN ? AND ? GROUP BY c.id HAVING spent > 0 ORDER BY spent DESC LIMIT 3`).all(from, to);
  const cycle = currentCycle(db, { today });
  let line = '';
  if (cycle) {
    const s = safeToSpend(db, { today });
    line = `This pay cycle ${dm(cycle.start)} to ${dm(cycle.end)}, day ${cycle.day} of ${cycle.days}: safe to spend ${money(s.safe)} until payday ${dm(cycle.next_payday)} (${money(s.per_day)} a day).`;
    if (cycle.late) line += ` Pay is ${cycle.days_late} days late.`;
    if (s.cash.short) line += ` Spendable cash is ${money(-s.cash.after_bills)} short of the bills still due.`;
    line += ' ';
  }
  const over = (cycle ? cycleBudgetProgress(db, cycle, { today, zero: false }) : budgetProgress(db, today.slice(0, 7))).items.filter((i) => i.over && !(cycle && i.fixed)).map((i) => i.name);
  line += `Last week (${dm(from)} to ${dm(to)}): spent ${money(w.spent)} (prior 4 weeks averaged ${money(Math.round(prior.spent / 4))}), income ${money(w.income)}.`;
  if (top.length) line += ` Top: ${top.map((r) => `${r.name} ${money(r.spent)}`).join(', ')}.`;
  if (over.length) line += ` Over budget this ${cycle ? 'pay cycle' : 'month'}: ${over.join(', ')}.`;
  return line;
}
