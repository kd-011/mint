// The assistant door. A narrow JSON API under /api/assistant/ for the assistant's chat tools:
// reads (summary, spend, transactions, budgets, tax, balances, alerts, the v2
// pay cycle: cycle, income, bills, goals, debt, and Save and Invest, holdings,
// loan, forecast, the accountant pack link, the tax estimate), mark alerts
// pushed, and the chat writes in lib/chatwrites.mjs: safe ones apply with an
// undo token, bigger ones wait for a confirm token. Nothing here moves money,
// deletes a transaction or touches a connection. Server.mjs only lets the
// bearer key reach this prefix, on loopback; the gate identity can use it too.
// Spend means what the rest of Mint means by it: transfers (linked legs and
// transfer-kind categories) never count, refunds net off.
import { bad } from './errors.mjs';
import { send, readJson } from './http.mjs';
import { isIsoDate, perthDate, addDays, monthStart } from './dates.mjs';
import { listCategories } from './categories.mjs';
import { createRule, getRule, listRules } from './categorise.mjs';
import { budgetProgress, checkMonth } from './budgets.mjs';
import { ATO_CATEGORIES, setTaxTag, fySummary, fyOf, fyRange, getTaxInputs, TAX_INPUTS } from './tax.mjs';
import { taxReturnEstimate } from './taxestimate.mjs';
import { netWorth, listAssets } from './networth.mjs';
import { listAlerts, weeklySummary, PUSH_KINDS } from './alerts.mjs';
import { currentCycle } from './cycles.mjs';
import { cycleBudgetProgress } from './budgets.mjs';
import { incomeReport, cycleIncome, salaryStats } from './income.mjs';
import { incomeByFy } from './noa.mjs';
import { safeToSpend } from './safe.mjs';
import { billsCalendar } from './bills.mjs';
import { listSubscriptions } from './subscriptions.mjs';
import { splitStatus } from './plan.mjs';
import { listGoals } from './goals.mjs';
import { listOwed } from './owed.mjs';
import { debtReport } from './debt.mjs';
import { COUNTS, BUSINESS, FROM, KIND, INCOME, SPEND_FROM, SPEND_COUNTS, SPEND_AMT } from './spend.mjs';
import { savingsOverview } from './savings.mjs';
import { superOverview } from './superfund.mjs';
import { portfolio, portfolioHistory } from './holdings.mjs';
import { homeLoan } from './homeloan.mjs';
import { forecast } from './forecast.mjs';
import { packFileName } from './pack.mjs';
import { createChatWrites } from './chatwrites.mjs';

const GROUPS = ['category', 'merchant', 'account', 'month', 'day', 'none'];
const SCOPES = ['all', 'personal', 'business'];
const MERCHANT = 'COALESCE(t.merchant_override, t.merchant)';
const ACCOUNT = 'COALESCE(a.nickname, a.name)';
const MAX_ROWS = 100;
const PUSHED_BATCH = 200;
const ODD_KINDS = new Set(['unusual', 'subscription', 'sync']);

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';
const text = (v, name, max = 100) => {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || v.trim().length > max) throw bad(`${name} must be text up to ${max} characters`);
  return v.trim();
};
const like = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const isoDate = (v, name) => {
  if (v == null || v === '') return null;
  if (!isIsoDate(v)) throw bad(`${name} must be a date as YYYY-MM-DD`);
  return v;
};
const centsParam = (v, name) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1e12) throw bad(`${name} must be whole cents, zero or more`);
  return n;
};

// Categories by name or by group ("transport" is Fuel, Parking and so on). On a
// miss the error lists the valid names, so the caller can retry with one.
export function resolveCategory(db, term, { activeOnly = false } = {}) {
  const t = String(term ?? '').trim().toLowerCase();
  const rows = db.prepare(`SELECT id, name, grp, kind, archived FROM categories ${activeOnly ? 'WHERE archived = 0' : ''} ORDER BY sort, name`).all();
  // A rule needs the one category; a filter takes the name and everything in a group of that name.
  const found = rows.filter((c) => c.name.toLowerCase() === t || (!activeOnly && c.grp.toLowerCase() === t));
  if (!found.length) {
    const names = rows.filter((c) => !c.archived).map((c) => c.name).join(', ');
    throw bad(`no category called "${String(term).trim().slice(0, 40)}". Categories: ${names}`);
  }
  return found;
}

function accountIds(db, term) {
  const t = term.toLowerCase();
  const rows = db.prepare("SELECT id, name, nickname FROM accounts WHERE status IS NOT 'gone'").all();
  const hit = rows.filter((a) => a.id === term || a.name.toLowerCase().includes(t) || (a.nickname ?? '').toLowerCase().includes(t));
  if (!hit.length) throw bad(`no account matches "${term.slice(0, 40)}". Accounts: ${rows.map((a) => a.nickname || a.name).join(', ')}`);
  return hit.map((a) => a.id);
}

// One WHERE builder for spend and search. Aliases: t, a, c.
function filters(db, p, { transfers = false, counts = COUNTS } = {}) {
  const where = [];
  const args = [];
  const from = isoDate(p.from, 'from');
  const to = isoDate(p.to, 'to');
  if (from && to && from > to) throw bad('from is after to');
  if (from) { where.push('t.date >= ?'); args.push(from); }
  if (to) { where.push('t.date <= ?'); args.push(to); }
  const cat = text(p.category, 'category');
  let matched = null;
  if (cat) {
    if (/^(none|uncategori[sz]ed)$/i.test(cat)) { where.push('c.id IS NULL'); matched = ['Uncategorised']; }
    else {
      const cats = resolveCategory(db, cat);
      where.push(`c.id IN (${cats.map(() => '?').join(',')})`);
      args.push(...cats.map((c) => c.id));
      matched = cats.map((c) => c.name);
    }
  }
  const merchant = text(p.merchant, 'merchant');
  if (merchant) { where.push(`${MERCHANT} LIKE ? ESCAPE '\\'`); args.push(like(merchant)); }
  const q = text(p.q, 'q');
  if (q) {
    where.push(`(t.description LIKE ? ESCAPE '\\' OR ${MERCHANT} LIKE ? ESCAPE '\\')`);
    args.push(like(q), like(q));
  }
  const acct = text(p.account, 'account');
  if (acct) {
    const ids = accountIds(db, acct);
    where.push(`t.account_id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  const scope = p.scope ? String(p.scope) : 'all';
  if (!SCOPES.includes(scope)) throw bad(`scope must be one of ${SCOPES.join(', ')}`);
  if (scope !== 'all') where.push(`${BUSINESS} = ${scope === 'business' ? 1 : 0}`);
  const min = centsParam(p.min_amount, 'min_amount');
  const max = centsParam(p.max_amount, 'max_amount');
  if (min != null) { where.push('abs(t.amount) >= ?'); args.push(min); }
  if (max != null) { where.push('abs(t.amount) <= ?'); args.push(max); }
  if (!transfers) where.push(counts);
  return { where, args, from, to, matched, scope };
}

export function spendReport(db, p = {}, today = perthDate()) {
  const group = p.group ? String(p.group) : 'none';
  if (!GROUPS.includes(group)) throw bad(`group must be one of ${GROUPS.join(', ')}`);
  const f = filters(db, { ...p, to: p.to ?? today, from: p.from ?? monthStart(p.to ?? today) }, { counts: SPEND_COUNTS });
  const clause = `WHERE ${f.where.join(' AND ')}`;
  const t = db.prepare(`SELECT
      -COALESCE(SUM(CASE WHEN ${KIND} = 'expense' THEN ${SPEND_AMT} END), 0) spent,
      COALESCE(SUM(CASE WHEN ${INCOME} THEN t.amount END), 0) income,
      -COALESCE(SUM(CASE WHEN ${KIND} = 'expense' AND ${BUSINESS} = 1 THEN ${SPEND_AMT} END), 0) business_spent,
      count(*) n, COALESCE(SUM(t.status = 'pending'), 0) pending
    FROM ${SPEND_FROM} ${clause}`).get(...f.args);
  const out = {
    range: { from: f.from, to: f.to },
    scope: f.scope,
    ...(f.matched ? { categories_matched: f.matched } : {}),
    totals: { spent: t.spent, personal_spent: t.spent - t.business_spent, business_spent: t.business_spent, income: t.income, count: t.n, pending: t.pending },
    note: 'Cents. Spend is net of refunds; transfers between own accounts are left out, except a repayment into the home loan, which counts as spend under Home loan.',
  };
  if (group !== 'none') {
    const key = { category: "COALESCE(c.name, 'Uncategorised')", merchant: MERCHANT, account: ACCOUNT, month: 'substr(t.date, 1, 7)', day: 't.date' }[group];
    const rows = db.prepare(`SELECT ${key} k, -SUM(${SPEND_AMT}) spent, count(*) n FROM ${SPEND_FROM} ${clause} AND ${KIND} = 'expense'
      GROUP BY 1 HAVING spent != 0 ORDER BY ${group === 'month' || group === 'day' ? 'k ASC' : 'spent DESC, k ASC'} LIMIT 101`).all(...f.args);
    out.group_by = group;
    out.groups = rows.slice(0, 100).map((r) => ({ key: r.k, name: r.k, spent: r.spent, count: r.n }));
    if (rows.length > 100) out.truncated = true;
  }
  return out;
}

const TX_SELECT = `SELECT t.id, t.date, t.status, ${MERCHANT} merchant, t.description, t.amount, ${ACCOUNT} account,
    COALESCE(c.name, 'Uncategorised') category, ${BUSINESS} business, t.note, g.ato_category, g.deductible_amount,
    (SELECT count(*) FROM receipts r WHERE r.transaction_id = t.id) receipts
  FROM ${FROM} LEFT JOIN tax_tags g ON g.transaction_id = t.id`;

export function searchTransactions(db, p = {}) {
  const limit = p.limit == null || p.limit === '' ? 25 : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) throw bad(`limit must be 1 to ${MAX_ROWS}`);
  const f = filters(db, p, { transfers: truthy(p.include_transfers) });
  if (p.kind != null && p.kind !== '' && p.kind !== 'all') {
    if (!['spend', 'income'].includes(p.kind)) throw bad('kind must be spend, income or all');
    f.where.push(`t.amount ${p.kind === 'spend' ? '<' : '>'} 0`);
  }
  if (p.cursor) {
    let date;
    let id;
    try { [date, id] = JSON.parse(Buffer.from(String(p.cursor), 'base64url').toString()); } catch {}
    if (!isIsoDate(date) || typeof id !== 'string') throw bad('bad cursor');
    f.where.push('(t.date < ? OR (t.date = ? AND t.id < ?))');
    f.args.push(date, date, id);
  }
  const clause = f.where.length ? `WHERE ${f.where.join(' AND ')}` : '';
  const rows = db.prepare(`${TX_SELECT} ${clause} ORDER BY t.date DESC, t.id DESC LIMIT ?`).all(...f.args, limit + 1);
  const items = rows.slice(0, limit).map(({ ato_category, deductible_amount, business, ...r }) => ({
    ...r, business: !!business, tax: ato_category ? { ato_category, deductible_amount } : null,
  }));
  const last = items.at(-1);
  return { items, next: rows.length > limit && last ? Buffer.from(JSON.stringify([last.date, last.id])).toString('base64url') : null };
}

// The ids a chat bulk edit means: the same filters as search (transfers left
// out), newest first, at most `max`, and an error rather than a silent cut.
const MATCH_KEYS = ['from', 'to', 'category', 'merchant', 'q', 'account', 'scope', 'min_amount', 'max_amount', 'kind'];
export function matchTransactionIds(db, p = {}, max = 500) {
  if (!MATCH_KEYS.some((k) => p[k] != null && p[k] !== '')) throw bad(`match needs at least one of ${MATCH_KEYS.join(', ')}`);
  const f = filters(db, p);
  if (p.kind != null && p.kind !== '' && p.kind !== 'all') {
    if (!['spend', 'income'].includes(p.kind)) throw bad('kind must be spend, income or all');
    f.where.push(`t.amount ${p.kind === 'spend' ? '<' : '>'} 0`);
  }
  const rows = db.prepare(`SELECT t.id FROM ${FROM} WHERE ${f.where.join(' AND ')} ORDER BY t.date DESC, t.id DESC LIMIT ?`).all(...f.args, max + 1);
  if (rows.length > max) throw bad(`that matches more than ${max} transactions; narrow it with dates, an account or an amount`);
  if (!rows.length) throw bad('no transactions match');
  return rows.map((r) => r.id);
}

// The current pay cycle in one read: dates, income in and still due, safe to
// spend and per day with the working, budgets, bills still due, the split.
export function cycleSummary(db, today = perthDate()) {
  const note = 'Cents. A pay cycle runs from one salary to the day before the next. Safe to spend = expected cycle income - planned savings - fixed bills this cycle - flexible spend so far.';
  const cycle = currentCycle(db, { today });
  if (!cycle) return { as_of: today, cycle: null, reason: 'No salary seen yet, so there is no pay cycle.', note };
  const s = safeToSpend(db, { today });
  const inc = cycleIncome(db, cycle, { today });
  const stats = salaryStats(db);
  const progress = cycleBudgetProgress(db, cycle, { today, zero: false });
  const names = (pred) => progress.items.filter(pred).map((i) => i.name);
  const bills = billsCalendar(db, { today });
  const split = splitStatus(db, { today });
  return {
    as_of: today,
    cycle: { start: cycle.start, end: cycle.end, day: cycle.day, days: cycle.days, days_left: cycle.days_left, late: cycle.late, days_late: cycle.days_late },
    next_payday: { date: cycle.next_payday, expected_amount: stats.median, late: cycle.late, days_late: cycle.days_late },
    income: { received: inc.received.total, expected: inc.expected.total, salary: inc.received.salary, regular_received: inc.received.regular, regular_still_expected: inc.regular_expected, reimbursed: inc.reimbursed, other_in: inc.other_in },
    safe_to_spend: { amount: s.safe, per_day: s.per_day, breakdown: s.breakdown.map(({ key, label, amount }) => ({ key, label, amount })) },
    cash: s.cash,
    budgets: {
      flexible: progress.totals.flexible, fixed: progress.totals.fixed,
      over: names((i) => i.over), near: names((i) => !i.over && i.pct >= 90),
      items: progress.items.map(({ name, target, available, spent, remaining, pct, over, fixed, projected }) => ({ name, target, available, spent, remaining, pct, over, fixed, projected })),
    },
    bills_due: bills.items.filter((i) => i.in_cycle && i.status === 'due').map(({ date, merchant, amount, kind }) => ({ date, merchant, amount, kind })),
    split: { status: split.status, lines: split.lines.map(({ account, kind, planned, moved, status }) => ({ account, kind, planned, moved, status })), other_moves: split.other_moves },
    note,
  };
}

export function summary(db, today = perthDate()) {
  const month = today.slice(0, 7);
  const spend = spendReport(db, { from: monthStart(today), to: today }, today);
  const prevEnd = addDays(monthStart(today), -1);
  const prev = spendReport(db, { from: monthStart(prevEnd), to: prevEnd }, today);
  const progress = budgetProgress(db, month);
  const names = (pred) => progress.items.filter(pred).map((i) => i.name);
  const open = db.prepare('SELECT count(*) n, COALESCE(SUM(pushed_at IS NULL), 0) p FROM alerts WHERE dismissed_at IS NULL').get();
  const accounts = db.prepare("SELECT COALESCE(nickname, name) n, last_synced_at, last_sync_error FROM accounts WHERE status IS NOT 'gone' AND hidden = 0 AND manual = 0").all();
  const synced = accounts.map((a) => a.last_synced_at).filter(Boolean).sort();
  const cyc = cycleSummary(db, today);
  return {
    as_of: today,
    cycle: cyc.cycle ? {
      start: cyc.cycle.start, end: cyc.cycle.end, day: cyc.cycle.day, days_left: cyc.cycle.days_left, late: cyc.cycle.late,
      next_payday: cyc.next_payday.date, safe_to_spend: cyc.safe_to_spend.amount, per_day: cyc.safe_to_spend.per_day,
      income_received: cyc.income.received, income_expected: cyc.income.expected, over_budget: cyc.budgets.over,
    } : null,
    net_worth: netWorth(db),
    month: {
      month,
      spent: spend.totals.personal_spent,
      business_spent: spend.totals.business_spent,
      income: spend.totals.income,
      last_month_spent: prev.totals.personal_spent,
      budget: {
        items: progress.items.map(({ name, target, available, spent, remaining, pct, over }) => ({ name, target, available, spent, remaining, pct, over })),
        totals: progress.totals,
        over: names((i) => i.over),
        near: names((i) => !i.over && i.pct >= 90),
      },
    },
    open_alerts: open.n,
    pending_push: open.p,
    sync: { last_synced_at: synced.at(0) ?? null, problems: accounts.filter((a) => a.last_sync_error).map((a) => a.n) },
  };
}

// The current pay cycle's budgets; ?month=YYYY-MM for the monthly roll-up.
export function budgets(db, p = {}, today = perthDate()) {
  const opts = { includeBusiness: truthy(p.include_business), today };
  const cycle = p.month ? null : currentCycle(db, { today });
  if (cycle) return cycleBudgetProgress(db, cycle, opts);
  const month = p.month ? checkMonth(String(p.month)) : today.slice(0, 7);
  return budgetProgress(db, month, opts);
}

export function taxReport(db, p = {}, today = perthDate()) {
  const fy = p.fy == null || p.fy === '' ? fyOf(today) : Number(p.fy);
  const s = fySummary(db, fy);
  const items = db.prepare(`SELECT t.id, t.date, ${MERCHANT} merchant, t.amount, g.deductible_amount, g.ato_category, g.note,
      (SELECT count(*) FROM receipts r WHERE r.transaction_id = t.id) receipts
    FROM tax_tags g JOIN transactions t ON t.id = g.transaction_id JOIN accounts a ON a.id = t.account_id AND a.merged_into IS NULL
    WHERE t.date BETWEEN ? AND ? ORDER BY t.date DESC, t.id DESC LIMIT ${MAX_ROWS + 1}`).all(s.from, s.to);
  return {
    summary: s,
    items: items.slice(0, MAX_ROWS),
    ...(items.length > MAX_ROWS ? { truncated: true } : {}),
    ato_categories: ATO_CATEGORIES.map(({ code, label }) => ({ code, label })),
    estimate: taxReturnEstimate(db, { fy, today }),
  };
}

export function balances(db) {
  return netWorth(db);
}

// What the assistant should push: payday alerts are in-app only.
export function pendingAlerts(db) {
  return listAlerts(db, { limit: 500 }).filter((a) => !a.pushed_at && PUSH_KINDS.has(a.kind)).reverse();
}

export function markPushed(db, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > PUSHED_BATCH || !ids.every((i) => Number.isInteger(i) && i > 0)) {
    throw bad(`ids must be a list of 1 to ${PUSHED_BATCH} alert ids`);
  }
  const at = new Date().toISOString();
  const upd = db.prepare('UPDATE alerts SET pushed_at = ? WHERE id = ? AND pushed_at IS NULL');
  let marked = 0;
  for (const id of ids) marked += Number(upd.run(at, id).changes);
  return { marked };
}

export function weeklyBrief(db, today = perthDate()) {
  const since = addDays(today, -7);
  const odd = listAlerts(db, { limit: 200 })
    .filter((a) => ODD_KINDS.has(a.kind) && a.created_at.slice(0, 10) >= since)
    .map((a) => a.title);
  return { line: weeklySummary(db, today), odd: odd.slice(0, 5), more: Math.max(0, odd.length - 5) };
}

// "Woolworths is Groceries": a description rule by default, ahead of the seeded
// ones (priority 50 like the owner's corrections), applied across all history. The
// same rule asked for twice is one rule.
export function addRule(db, body = {}) {
  const pattern = typeof body.pattern === 'string' ? body.pattern.trim() : '';
  if (!pattern) throw bad('pattern is required: the text to match, like Woolworths');
  const category = resolveCategory(db, body.category ?? '', { activeOnly: true })[0];
  const field = body.field ?? 'description';
  const match = body.match ?? 'contains';
  // A regex comes from the model here, and the model reads bank text anyone can
  // write; a pattern like (a|aa)+ gets past the nested-repeat check and would
  // hang every match over every transaction. Regex rules are made by hand.
  if (match === 'regex') throw bad('regex rules are made by hand in Mint, not through chat: use contains, starts or exact');
  const existing = db.prepare(`SELECT id FROM rules WHERE field = ? AND match = ? AND lower(pattern) = lower(?) AND category_id = ?
    AND account_id IS NULL AND amount_min IS NULL AND amount_max IS NULL`).get(field, match, pattern, category.id);
  if (existing) {
    const applied = db.prepare('SELECT count(*) n FROM transactions WHERE rule_id = ?').get(existing.id).n;
    return { created: false, rule: getRule(db, existing.id), applied };
  }
  const r = createRule(db, { field, match, pattern, category_id: category.id, priority: body.priority ?? 50 });
  return { created: true, ...r };
}

export function tagDeductible(db, id, body = {}) {
  return setTaxTag(db, id, { ato_category: body.ato_category, deductible_amount: body.deductible_amount ?? null, note: body.note ?? null });
}

// ---------- Save and Invest, the forecast, the pack, the tax estimate ----------

const SHARES_FOOTER = 'Information only. Prices can be late or wrong, and nothing here is financial advice or a recommendation to buy or sell.';
const fyParam = (v, today) => {
  const fy = v == null || v === '' ? fyOf(today) : Number(v);
  fyRange(fy);
  return fy;
};
// The loan without its chart series: chat wants the figures.
const loanView = (db, today, extraMonth = null) => {
  const l = homeLoan(db, { today, extraMonth });
  return { ...l, items: l.items.map(({ chart, ...i }) => i) };
};

export function holdingsReport(db, quotes) {
  const prices = quotes?.status() ?? { source: null, configured: false, cap: 25 };
  const p = portfolio(db, { cap: prices.cap, budgeted: prices.budgeted_exchanges });
  return { ...p, history: portfolioHistory(db).slice(-30), prices, footer: SHARES_FOOTER };
}

// Savings, super, shares, home loan and goals in one read.
export function saveSummary(db, { today, quotes = null }) {
  const sav = savingsOverview(db, { today });
  const sup = superOverview(db, { today });
  const shares = holdingsReport(db, quotes);
  return {
    as_of: today,
    savings: { total_balance: sav.total_balance, interest: sav.interest, savings_rate: sav.savings_rate, accounts: sav.accounts.map(({ id, name, balance, interest }) => ({ id, name, balance, interest })) },
    super: { total: sup.total, nudge_days: sup.nudge_days, items: sup.items.map(({ history, ...i }) => i) },
    shares: { totals: shares.totals, by_class: shares.allocation.by_class, holdings: shares.holdings.map((h) => ({ id: h.id, ticker: h.ticker, exchange: h.exchange, units: h.units, value: h.value, gain: h.gain })), footer: SHARES_FOOTER },
    home_loan: loanView(db, today).items.map(({ id, name, balance, offset, effective_balance, rate, repayment, instalment, interest, payoff, missing }) => ({
      id, name, balance, offset: offset.balance, effective_balance, rate: rate.value, repayment_per_month: repayment.per_month,
      repayment: repayment.amount, repayment_frequency: repayment.frequency, last_paid: repayment.last_paid, bank_figure: repayment.scheduled, instalment, interest, payoff, missing,
    })),
    goals: listGoals(db, { today }).map(({ id, name, target_amount, target_date, progress, remaining, pct, per_cycle_needed, on_track, done }) => ({ id, name, target_amount, target_date, progress, remaining, pct, per_cycle_needed, on_track, done })),
    note: 'Cents, except share units. Rates are annual decimals. Nothing here is financial advice.',
  };
}

// Where the accountant pack is and what it will hold. The link opens in the
// browser behind the login gateway; chat never carries the file.
export function packLink(db, { fy, origin }) {
  const s = fySummary(db, fy);
  return {
    fy, from: s.from, to: s.to, file_name: packFileName(fy),
    download_url: `${origin}/api/tax/pack?fy=${fy}`, page_url: `${origin}/tax`,
    deductions: s.deductions.count, deductible_total: s.deductions.total,
    receipts_attached: s.receipts.attached, missing_receipts: s.receipts.missing,
    business: { income: s.business.income, expenses: s.business.expenses },
    note: 'A zip of the year summary, deductions.csv, business.csv and the receipts by ATO category. Not tax advice.',
  };
}

// The refund-or-owing estimate for the year with its working, and the inputs it
// reads (set with POST /api/assistant/tax/estimate/inputs). lib/taxestimate.mjs.
export function taxEstimate(db, { fy, today }) {
  const s = fySummary(db, fy);
  const estimate = taxReturnEstimate(db, { fy, today });
  return {
    fy,
    estimate,
    inputs: getTaxInputs(db, fy),
    input_fields: Object.keys(TAX_INPUTS),
    deductions: s.deductions,
    note: 'Cents. result is positive for a refund and negative for tax owing. Each line says whether it was entered, estimated or from the feed. An estimate, not tax advice.',
  };
}

export function createAssistantApi({ db, engine = null, quotes = null, fx = null, turns = null, origin = 'http://localhost:8970', now = () => new Date(), log = console.log }) {
  const params = (url) => Object.fromEntries(url.searchParams);
  const today = () => perthDate(now());
  const writes = createChatWrites({ db, engine, quotes, fx, turns, log, now, resolveCategory, matchIds: matchTransactionIds, addRule });
  return async function handle(req, res, url) {
    const path = url.pathname.slice('/api/assistant'.length);
    const method = req.method;
    let m;
    if (method === 'GET') {
      if (path === '/summary') return send(res, 200, summary(db)), true;
      if (path === '/summary/weekly') return send(res, 200, weeklyBrief(db)), true;
      if (path === '/spend') return send(res, 200, spendReport(db, params(url))), true;
      if (path === '/transactions') return send(res, 200, searchTransactions(db, params(url))), true;
      if (path === '/budgets') return send(res, 200, budgets(db, params(url))), true;
      if (path === '/tax') return send(res, 200, taxReport(db, params(url))), true;
      if (path === '/balances') return send(res, 200, balances(db)), true;
      if (path === '/cycle') return send(res, 200, cycleSummary(db)), true;
      if (path === '/income') return send(res, 200, incomeReport(db, { today: perthDate() })), true;
      if (path === '/income/fy') return send(res, 200, incomeByFy(db, { today: perthDate() })), true;
      if (path === '/bills') return send(res, 200, billsCalendar(db, { today: perthDate() })), true;
      if (path === '/goals') return send(res, 200, { as_of: perthDate(), items: listGoals(db, { today: perthDate() }) }), true;
      if (path === '/owed') return send(res, 200, listOwed(db, { today: today() })), true;
      if (path === '/subscriptions') return send(res, 200, listSubscriptions(db, perthDate())), true;
      if (path === '/debt') {
        const p = url.searchParams;
        return send(res, 200, debtReport(db, { today: perthDate(), extra: p.get('extra'), by: p.get('card_by'), perCycle: p.get('card_per_cycle') })), true;
      }
      if (path === '/save') return send(res, 200, saveSummary(db, { today: today(), quotes })), true;
      if (path === '/holdings') return send(res, 200, holdingsReport(db, quotes)), true;
      if (path === '/loan') return send(res, 200, loanView(db, today(), url.searchParams.get('extra_month'))), true;
      if (path === '/forecast') return send(res, 200, forecast(db, { today: today() })), true;
      if (path === '/pack') return send(res, 200, packLink(db, { fy: fyParam(url.searchParams.get('fy'), today()), origin })), true;
      if (path === '/tax/estimate') return send(res, 200, taxEstimate(db, { fy: fyParam(url.searchParams.get('fy'), today()), today: today() })), true;
      if (path === '/rules') {
        return send(res, 200, { items: listRules(db).map(({ id, field, match, pattern, category, account_name, priority, source, hits }) => ({ id, field, match, pattern, category, account: account_name, priority, source, hits })) }), true;
      }
      if (path === '/assets') return send(res, 200, { items: listAssets(db, { today: today() }).map(({ id, name, kind, is_liability, archived, value, as_of, due }) => ({ id, name, kind, is_liability: !!is_liability, archived: !!archived, value, as_of, due })) }), true;
      if (path === '/categories') return send(res, 200, { items: listCategories(db).map(({ id, name, grp, kind }) => ({ id, name, group: grp, kind })) }), true;
      if (path === '/alerts') {
        const state = url.searchParams.get('state') ?? 'open';
        if (!['open', 'pending', 'all'].includes(state)) throw bad('state must be open, pending or all');
        if (state === 'pending') return send(res, 200, { items: pendingAlerts(db) }), true;
        return send(res, 200, { items: listAlerts(db, { includeDismissed: state === 'all', limit: 100 }) }), true;
      }
      return false;
    }
    if (method !== 'POST') return false;
    if (path === '/alerts/pushed') {
      const b = await readJson(req);
      return send(res, 200, markPushed(db, b.ids)), true;
    }
    return writes(req, res, path);
  };
}
