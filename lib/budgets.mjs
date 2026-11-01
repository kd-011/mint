// Budgets per expense category. v2: the target is per pay cycle (see
// lib/cycles.mjs); monthly_target is kept as the monthly roll-up (cycle x
// 26 / 12) for Reports and the v1 screens. Spent is net of refunds and
// reimbursements (never below zero for a category in a cycle or month, so a
// refund cannot add room), leaves out transfers and, unless asked, business spend.
// Rollover carries each past cycle's leftover (or overspend) since the budget
// was set up. Fixed budgets (bills, subscriptions) sit apart from flexible
// ones, which is what the pace alert and safe to spend look at.
import { bad, notFound } from './errors.mjs';
import { BUSINESS, KIND, SPEND_FROM as FROM, SPEND_COUNTS as COUNTS, SPEND_AMT, HOME_LOAN } from './spend.mjs';
import { listCycles, completeCycles } from './cycles.mjs';
import { cycleIncome } from './income.mjs';
import { setAsideFor } from './plan.mjs';
import { detectRecurring } from './recurring.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const toMonthly = (cycle) => Math.round((cycle * 26) / 12);
export const toCycle = (monthly) => Math.round((monthly * 12) / 26);
// Bills by nature: fixed even before a recurring charge is seen. Spend here
// includes a repayment into the home loan (see SPEND_FROM in lib/spend.mjs).
export const FIXED_NAMES = new Set(['Rent', 'Utilities', 'Phone and internet', 'Insurance', 'Rego', 'Subscriptions', 'Home loan']);
export const ONE_OFF = 200000; // one charge of $2,000 or more is a one-off for starter budgets (the home build, a holiday)
const STARTER_MIN = 2000; // flexible spend under $20 a cycle gets no starter budget
const STARTER_MIN_FIXED = 500;
const STARTER_SKIP = new Set(['Reimbursements']);
const BUDGET_COLS = 'category_id, monthly_target, cycle_target, rollover, fixed, source, created_at, updated_at';

export function checkMonth(month) {
  if (typeof month !== 'string' || !MONTH.test(month)) throw bad('month must be YYYY-MM');
  return month;
}

const nextMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};
const cents = (v) => Number.isInteger(v) && v >= 0 && v <= 1e11;

// Either target may be given; the other follows. A cycle target wins when both are.
export function setBudget(db, categoryId, { cycle_target, monthly_target, rollover, fixed } = {}, { source = 'manual' } = {}) {
  const cat = Number.isInteger(categoryId) ? db.prepare('SELECT id, kind FROM categories WHERE id = ?').get(categoryId) : null;
  if (!cat) throw notFound('no such category');
  if (cat.kind !== 'expense') throw bad('budgets are for spending categories only');
  if (cycle_target != null && !cents(cycle_target)) throw bad('cycle_target must be whole cents, zero or more');
  if (monthly_target != null && !cents(monthly_target)) throw bad('monthly_target must be whole cents, zero or more');
  if (cycle_target == null && monthly_target == null) throw bad('give a cycle_target (per pay cycle) or a monthly_target, in whole cents');
  if (rollover != null && typeof rollover !== 'boolean') throw bad('rollover must be true or false');
  if (fixed != null && typeof fixed !== 'boolean') throw bad('fixed must be true or false');
  const cycle = cycle_target ?? toCycle(monthly_target);
  const monthly = cycle_target != null ? toMonthly(cycle_target) : monthly_target;
  const at = new Date().toISOString();
  const b = (v) => (v == null ? null : v ? 1 : 0);
  db.prepare(`INSERT INTO budgets (category_id, monthly_target, cycle_target, rollover, fixed, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(category_id) DO UPDATE SET monthly_target = excluded.monthly_target, cycle_target = excluded.cycle_target,
      rollover = COALESCE(?, rollover), fixed = COALESCE(?, fixed), source = excluded.source, updated_at = excluded.updated_at`)
    .run(categoryId, monthly, cycle, b(rollover) ?? 0, b(fixed) ?? 0, source, at, at, b(rollover), b(fixed));
  return db.prepare(`SELECT ${BUDGET_COLS} FROM budgets WHERE category_id = ?`).get(categoryId);
}

export function deleteBudget(db, categoryId) {
  if (!db.prepare('DELETE FROM budgets WHERE category_id = ?').run(categoryId).changes) throw notFound('no budget for that category');
  return { deleted: true };
}

const loadBudgets = (db) => db.prepare(`SELECT b.category_id, b.monthly_target, COALESCE(b.cycle_target, CAST(round(b.monthly_target * 12.0 / 26) AS INTEGER)) cycle_target,
    b.rollover, b.fixed, b.source, b.created_at, c.name, c.grp
  FROM budgets b JOIN categories c ON c.id = b.category_id ORDER BY c.sort, c.name`).all();

const pctOf = (spent, available) => (available > 0 ? Math.round((spent / available) * 100) : spent > 0 ? 100 : 0);

// The monthly roll-up (Reports, the v1 Budgets and Home screens).
export function budgetProgress(db, month, { includeBusiness = false } = {}) {
  checkMonth(month);
  const budgets = loadBudgets(db);
  if (!budgets.length) return { basis: 'month', month, items: [], totals: { target: 0, spent: 0 } };
  const earliest = budgets.reduce((m, b) => (b.rollover && b.created_at.slice(0, 7) < m ? b.created_at.slice(0, 7) : m), month);
  const spentRows = db.prepare(`SELECT c.id category_id, substr(t.date, 1, 7) m, -SUM(${SPEND_AMT}) spent FROM ${FROM}
    WHERE ${COUNTS} ${includeBusiness ? '' : `AND ${BUSINESS} = 0`} AND t.date >= ? AND t.date < ?
      AND c.id IN (SELECT category_id FROM budgets)
    GROUP BY 1, 2`).all(`${earliest}-01`, `${nextMonth(month)}-01`);
  // A month's net spend in a budget never goes below zero: a refund offsets spend, it does not add room.
  const spent = new Map(spentRows.map((r) => [`${r.category_id}|${r.m}`, Math.max(0, r.spent)]));
  const items = budgets.map((b) => {
    let carried = 0;
    if (b.rollover) {
      for (let m = b.created_at.slice(0, 7); m < month; m = nextMonth(m)) carried += b.monthly_target - (spent.get(`${b.category_id}|${m}`) ?? 0);
    }
    const s = spent.get(`${b.category_id}|${month}`) ?? 0;
    const available = b.monthly_target + carried;
    return {
      category_id: b.category_id, name: b.name, group: b.grp, target: b.monthly_target, cycle_target: b.cycle_target, fixed: !!b.fixed, rollover: !!b.rollover,
      carried, available, spent: s, remaining: available - s, pct: pctOf(s, available), over: s > available,
    };
  });
  return { basis: 'month', month, items, totals: { target: items.reduce((a, i) => a + i.target, 0), spent: items.reduce((a, i) => a + i.spent, 0) } };
}

export const cycleView = (c) => (c ? {
  start: c.start, end: c.end, days: c.days, open: c.open, day: c.day ?? c.days, days_left: c.days_left ?? 0,
  next_payday: c.next_payday ?? null, late: c.late, days_late: c.days_late, payday: c.payday,
} : null);

// Spend per budgeted category per cycle, from the first cycle needed to `cycle`.
function cycleSpend(db, cycles, { includeBusiness }) {
  if (!cycles.length) return new Map();
  const rows = db.prepare(`SELECT c.id category_id, t.date, -SUM(${SPEND_AMT}) spent FROM ${FROM}
    WHERE ${COUNTS} ${includeBusiness ? '' : `AND ${BUSINESS} = 0`} AND t.date >= ? AND t.date <= ?
      AND c.id IN (SELECT category_id FROM budgets) GROUP BY 1, 2`).all(cycles[0].start, cycles.at(-1).end);
  const out = new Map();
  for (const r of rows) {
    const i = cycles.findIndex((c) => c.start <= r.date && r.date <= c.end);
    if (i < 0) continue;
    const key = `${r.category_id}|${i}`;
    out.set(key, (out.get(key) ?? 0) + r.spent);
  }
  // Same rule per cycle, after the days are added up: net spend never goes below zero.
  for (const [key, v] of out) if (v < 0) out.set(key, 0);
  return out;
}

// Zero-based budgeting: every dollar of the cycle's income has a job. Ready to
// assign is what is left once the pay split's saving and debt lines (setAside),
// the category targets (assigned) and last cycle's uncovered overspend
// (carried) have all taken their share; it reads zero when every dollar is
// assigned, above zero while some is not, below zero when more is assigned than
// the cycle brings in. Nothing is stored: it is worked out from the budgets,
// the income and the pay split already there, so older budgets just work.
// Overspend is the flexible categories only, the same call the alerts make: a
// fixed bill is a monthly amount scaled to the cycle, so the cycle holding the
// instalment reads over without any overspend.
const overspend = (items) => items.filter((i) => i.over && !i.fixed).map((i) => ({ category_id: i.category_id, name: i.name, amount: i.spent - i.available })).sort((a, b) => b.amount - a.amount);
export function zeroBased({ income, setAside = 0, inBudgets = 0, items, carried = [] }) {
  const assigned = items.reduce((s, i) => s + i.target, 0);
  const carriedTotal = carried.reduce((s, c) => s + c.amount, 0);
  const ready = income - setAside - assigned - carriedTotal;
  const over = overspend(items);
  return {
    income, set_aside: setAside, split_in_budgets: inBudgets, assigned,
    carried_overspend: { total: carriedTotal, items: carried },
    ready, state: ready === 0 ? 'zero' : ready > 0 ? 'unassigned' : 'over_assigned',
    overspent: { total: over.reduce((s, o) => s + o.amount, 0), count: over.length, items: over },
  };
}

export function cycleBudgetProgress(db, cycle, { includeBusiness = false, today, zero = true } = {}) {
  const p = cycleProgress(db, cycle, { includeBusiness, today });
  if (!zero) return p;
  // Last cycle's overspend: rollover budgets already carry it in their available, fixed ones are not overspend, and a budget made after that cycle ended (any source) or a starter made during it was not there when the money went out.
  const all = listCycles(db, { today });
  const idx = all.findIndex((c) => c.start === p.cycle.start);
  const prev = idx > 0 ? all[idx - 1] : null;
  const carried = prev ? overspend(cycleProgress(db, prev, { includeBusiness, today }).items.filter((i) => !i.rollover && i.created_at.slice(0, 10) <= prev.end && !freshStarter(i, prev))) : [];
  const cyc = idx >= 0 ? all[idx] : cycle;
  const income = cycleIncome(db, cyc, { today }).expected.total;
  // A pay split line into the loan and the Home loan budget are the same money: count the larger once.
  const split = setAsideFor(db, cyc);
  const inBudgets = Math.min(split.loan, p.items.find((i) => i.name === HOME_LOAN)?.target ?? 0);
  return { ...p, zero_based: zeroBased({ income, setAside: split.total - inBudgets, inBudgets, items: p.items, carried }) };
}

function cycleProgress(db, cycle, { includeBusiness = false, today } = {}) {
  const all = listCycles(db, { today });
  const idx = all.findIndex((c) => c.start === cycle.start);
  const cyc = idx >= 0 ? all[idx] : cycle;
  const budgets = loadBudgets(db);
  const empty = { target: 0, spent: 0, fixed: { target: 0, spent: 0 }, flexible: { target: 0, available: 0, spent: 0, projected: 0 } };
  // Spending in this cycle under categories with no budget, biggest first, for the "no budget yet" list.
  const unbudgeted = db.prepare(`SELECT c.id category_id, c.name, c.grp "group", -SUM(${SPEND_AMT}) spent FROM ${FROM}
    WHERE ${COUNTS} ${includeBusiness ? '' : `AND ${BUSINESS} = 0`} AND ${KIND} = 'expense' AND t.date >= ? AND t.date <= ?
      AND c.id IS NOT NULL AND c.id NOT IN (SELECT category_id FROM budgets) GROUP BY 1, 2, 3 HAVING spent > 0 ORDER BY spent DESC LIMIT 8`).all(cyc.start, cyc.end).map((r) => ({ ...r }));
  if (!budgets.length) return { basis: 'cycle', cycle: cycleView(cyc), items: [], unbudgeted, totals: empty };
  // Only the cycles a rollover needs, back to the oldest rollover budget's first cycle.
  const known = idx >= 0 ? all.slice(0, idx + 1) : [cyc];
  const oldest = budgets.filter((b) => b.rollover).reduce((m, b) => (b.created_at.slice(0, 10) < m ? b.created_at.slice(0, 10) : m), cyc.start);
  const first = Math.max(0, known.findIndex((c) => c.end >= oldest));
  const upto = known.slice(first);
  const spent = cycleSpend(db, upto, { includeBusiness });
  const here = upto.length - 1;
  const day = cyc.open ? Math.min(cyc.day, cyc.days) : cyc.days;
  const items = budgets.map((b) => {
    let carried = 0;
    if (b.rollover) {
      const made = b.created_at.slice(0, 10);
      let from = upto.findIndex((c) => c.start <= made && made <= c.end);
      if (from < 0) from = made < upto[0].start ? 0 : here;
      for (let i = from; i < here; i++) carried += b.cycle_target - (spent.get(`${b.category_id}|${i}`) ?? 0);
    }
    const s = spent.get(`${b.category_id}|${here}`) ?? 0;
    const available = b.cycle_target + carried;
    return {
      category_id: b.category_id, name: b.name, group: b.grp, target: b.cycle_target, monthly_target: b.monthly_target,
      fixed: !!b.fixed, rollover: !!b.rollover, source: b.source, created_at: b.created_at, carried, available, spent: s, remaining: available - s,
      pct: pctOf(s, available), over: s > available, projected: cyc.open && day > 0 ? Math.round((s / day) * cyc.days) : s,
    };
  });
  const sum = (xs, k) => xs.reduce((a, i) => a + i[k], 0);
  const fixed = items.filter((i) => i.fixed);
  const flex = items.filter((i) => !i.fixed);
  return {
    basis: 'cycle', cycle: cycleView(cyc), items, unbudgeted,
    totals: {
      target: sum(items, 'target'), spent: sum(items, 'spent'),
      fixed: { target: sum(fixed, 'target'), spent: sum(fixed, 'spent') },
      flexible: { target: sum(flex, 'target'), available: sum(flex, 'available'), spent: sum(flex, 'spent'), projected: sum(flex, 'projected') },
    },
  };
}

const LIST_CAP = 500;
const monthEnd = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
};

// The transactions behind one category's spent figure for a pay cycle
// ({ cycle }) or a calendar month ({ month }): the same rows, filtered the same
// way, as cycleSpend and budgetProgress above (refunds and reimbursements net
// off, linked transfer legs and, unless asked, business spend are out), so they
// add up to it. Newest first. The ids are capped; the count and net are not.
export function categoryTransactions(db, categoryId, { cycle = null, month = null, includeBusiness = false, today } = {}) {
  const category = Number.isInteger(categoryId) ? db.prepare('SELECT id, name, grp "group", kind FROM categories WHERE id = ?').get(categoryId) : null;
  if (!category) throw notFound('no such category');
  if (cycle && month) throw bad('give a cycle or a month, not both');
  if (month) checkMonth(month);
  const from = cycle ? cycle.start : `${month}-01`;
  const to = cycle ? cycle.end : monthEnd(month);
  const where = `${COUNTS} ${includeBusiness ? '' : `AND ${BUSINESS} = 0`} AND c.id = ? AND t.date >= ? AND t.date <= ?`;
  const total = db.prepare(`SELECT COUNT(*) n, -COALESCE(SUM(${SPEND_AMT}), 0) net FROM ${FROM} WHERE ${where}`).get(categoryId, from, to);
  const ids = db.prepare(`SELECT t.id FROM ${FROM} WHERE ${where} ORDER BY t.date DESC, t.id DESC LIMIT ?`).all(categoryId, from, to, LIST_CAP).map((r) => r.id);
  const progress = cycle ? cycleBudgetProgress(db, cycle, { includeBusiness, today, zero: false }) : budgetProgress(db, month, { includeBusiness });
  const budget = progress.items.find((i) => i.category_id === categoryId) ?? null;
  return {
    category: { id: category.id, name: category.name, group: category.group }, basis: cycle ? 'cycle' : 'month',
    cycle: cycle ? progress.cycle : null, month: month ?? null, from, to, budget,
    // Net of refunds, and never below zero, as the budget counts it.
    net: total.net, spent: budget ? budget.spent : Math.max(0, total.net), count: total.n, truncated: total.n > ids.length, ids,
  };
}

const events = (items) => {
  const out = [];
  for (const i of items) {
    if (i.pct >= 90 && (i.available > 0 || i.spent > 0)) out.push({ ...i, level: 90 });
    if (i.over) out.push({ ...i, level: 100 });
  }
  return out;
};

// Budgets at or past 90 percent, and over, for the alert pipeline.
export const budgetEvents = (db, month, opts = {}) => events(budgetProgress(db, month, opts).items);
// A fixed budget is a monthly bill scaled to the cycle (toCycle), so the cycle
// that holds the one instalment reads over without any overspend: fixed budgets
// raise no budget alert on the cycle basis, same as the pace alert.
export const cycleBudgetEvents = (db, cycle, opts = {}) => events(cycleBudgetProgress(db, cycle, { ...opts, zero: false }).items.filter((i) => !i.fixed && !freshStarter(i, cycle)));
// A starter budget made during this cycle was not there when the money went
// out, so it does not alert (budget or pace) until the next cycle.
export const freshStarter = (i, cycle) => i.source === 'starter' && i.created_at.slice(0, 10) >= cycle.start;

const roundUp = (v) => (v < 50000 ? Math.ceil(v / 1000) * 1000 : Math.ceil(v / 5000) * 5000);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Starter budgets: one per spending category from the last six complete
// cycles. Flexible categories take the median per-cycle spend (a category
// spent in only one or two cycles has a median of nothing), fixed ones the
// mean (a monthly bill lands in about half the cycles). One charge of $2,000
// or more is left out unless the category is a bill by nature. Rounded up to
// the next $10 (or $50 from $500). Never touches a category that has a budget,
// unless replace is 'starter' and that budget is one Mint made itself.
export function generateStarterBudgets(db, { today, dryRun = false, n = 6, replace = null } = {}) {
  if (replace != null && replace !== 'starter') throw bad("replace must be 'starter' or left out");
  const cycles = completeCycles(db, { today, n });
  const base = { created: [], skipped: [], cycles_used: cycles.length, from: cycles[0]?.start ?? null, to: cycles.at(-1)?.end ?? null, total_per_cycle: 0 };
  if (cycles.length < 2) return { ...base, reason: 'needs at least two complete pay cycles of history' };
  // 'starter' also re-runs the maths over budgets Mint made itself; one the owner set by hand is never touched.
  const existing = new Map(db.prepare('SELECT category_id, cycle_target, monthly_target, fixed, rollover, source FROM budgets').all().map((r) => [r.category_id, r]));
  const have = new Set([...existing].filter(([, r]) => !(replace === 'starter' && r.source === 'starter')).map(([id]) => id));
  const rows = db.prepare(`SELECT c.id category_id, c.name, c.grp, t.date, ${SPEND_AMT} amount FROM ${FROM}
    WHERE ${COUNTS} AND ${BUSINESS} = 0 AND ${KIND} = 'expense' AND c.kind = 'expense' AND t.date >= ? AND t.date <= ?
    ORDER BY t.date`).all(base.from, base.to);
  const recurring = detectRecurring(db, today).filter((s) => s.active);
  const cats = new Map();
  for (const r of rows) {
    const c = cats.get(r.category_id) ?? cats.set(r.category_id, { category_id: r.category_id, name: r.name, group: r.grp, per: cycles.map(() => 0), one_offs: 0 }).get(r.category_id);
    if (r.amount <= -ONE_OFF && !FIXED_NAMES.has(r.name)) { c.one_offs += 1; continue; }
    const i = cycles.findIndex((x) => x.start <= r.date && r.date <= x.end);
    if (i >= 0) c.per[i] -= r.amount;
  }
  const out = { ...base };
  for (const c of cats.values()) {
    const per = c.per.map((v) => Math.max(0, v));
    if (have.has(c.category_id)) { out.skipped.push({ category_id: c.category_id, name: c.name, reason: replace === 'starter' ? 'set by hand, left alone' : 'already has a budget' }); continue; }
    if (STARTER_SKIP.has(c.name)) continue;
    const mean = per.reduce((s, v) => s + v, 0) / per.length;
    const regular = recurring.filter((s) => s.category_id === c.category_id).reduce((s, x) => s + (x.amount * 14) / x.interval_days, 0);
    const fixed = FIXED_NAMES.has(c.name) || (mean > 0 && regular >= mean * 0.6);
    const typical = fixed ? mean : median(per);
    if (typical < (fixed ? STARTER_MIN_FIXED : STARTER_MIN)) {
      out.skipped.push({ category_id: c.category_id, name: c.name, reason: c.one_offs && typical === 0 ? 'one-off spend only' : 'tiny or one-off spend' });
      continue;
    }
    const was = existing.get(c.category_id);
    // before is what undo puts back: null means there was no budget, so undo deletes it.
    const before = was ? { cycle_target: was.cycle_target ?? toCycle(was.monthly_target), fixed: !!was.fixed, rollover: !!was.rollover, source: was.source } : null;
    out.created.push({ category_id: c.category_id, name: c.name, group: c.group, cycle_target: roundUp(typical), fixed, basis: fixed ? 'mean' : 'median', per_cycle: per, one_offs_skipped: c.one_offs, before });
  }
  out.created.sort((a, b) => b.cycle_target - a.cycle_target);
  out.total_per_cycle = out.created.reduce((s, c) => s + c.cycle_target, 0);
  if (!dryRun) for (const c of out.created) setBudget(db, c.category_id, { cycle_target: c.cycle_target, fixed: c.fixed }, { source: 'starter' });
  return out;
}
