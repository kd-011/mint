// The pay split. A plan says where each salary should go: a fixed amount or a
// percentage of the pay to each of the owner's accounts (spending, saving, a debt
// paydown, business). Mint never moves money; after each payday it checks
// the transfers out of the pay account against the plan: done, partial or
// not yet per destination. The first plan is suggested from what was moved
// out of the pay account in the three days after each of the last four
// paydays.
import { tx, getSetting, setSetting } from './db.mjs';
import { bad } from './errors.mjs';
import { addDays } from './dates.mjs';
import { anchorSource, paydays, listCycles } from './cycles.mjs';
import { LIVE } from './live.mjs';

export const PLAN_KINDS = ['spending', 'saving', 'debt', 'business'];
export const SPLIT_DAYS = 3;
const SUGGEST_PAYDAYS = 4;
const MAX_LINES = 20;

const label = (a) => a.nickname || a.name;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Where the salary lands: the stream's account if it names one, else the
// account of the latest salary deposit.
export function payAccount(db) {
  const s = anchorSource(db);
  if (!s) return null;
  const id = s.account_id ?? db.prepare("SELECT account_id FROM transactions WHERE income_source_id = ? AND income_kind = 'salary' AND " + LIVE('transactions') + " ORDER BY date DESC, id DESC LIMIT 1").get(s.id)?.account_id;
  return id ? db.prepare('SELECT id, name, nickname, type, is_business FROM accounts WHERE id = ?').get(id) ?? null : null;
}

export function defaultKind(a) {
  if (a.type === 'credit-card' || a.type === 'loan') return 'debt';
  if (a.is_business) return 'business';
  if (/emergency|saving|offset|invest/i.test(`${a.name} ${a.nickname ?? ''}`)) return 'saving';
  return 'spending';
}

const LINKED_OUT = `SELECT o.id, o.date, -o.amount amount, i.account_id, i.date in_date FROM transfers x
    JOIN transactions o ON o.id = x.out_tx JOIN transactions i ON i.id = x.in_tx
  WHERE x.status IN ('auto', 'confirmed') AND o.account_id = ? AND ${LIVE('o')} AND ${LIVE('i')} AND o.date >= ? AND o.date <= ? ORDER BY o.date, o.id`;

// Linked transfers out of the pay account, with the account the money ended
// up in. A hop into an account that sends money on within FORWARD_DAYS (pay
// to an everyday account, straight on to the card) is followed to where it
// went: only what was sent on moves, the rest stays with the account in the
// middle, and each onward transfer carries no more than it was sent. An
// account already on the path (a circle, or back to the pay account) ends it.
export const FORWARD_DAYS = 2;
const MAX_HOPS = 4;

function movesOut(db, payId, from, to) {
  const onward = db.prepare(LINKED_OUT);
  const left = new Map();
  const out = [];
  const follow = (m, path) => {
    let rest = m.amount;
    if (path.length <= MAX_HOPS) {
      const next = onward.all(m.account_id, m.in_date, addDays(m.in_date, FORWARD_DAYS))
        .filter((f) => !path.includes(f.account_id))
        .sort((a, b) => (b.amount === rest) - (a.amount === rest));
      for (const f of next) {
        if (rest <= 0) break;
        const take = Math.min(left.get(f.id) ?? f.amount, rest);
        if (take <= 0) continue;
        left.set(f.id, (left.get(f.id) ?? f.amount) - take);
        rest -= take;
        follow({ date: m.date, amount: take, account_id: f.account_id, in_date: f.in_date }, [...path, f.account_id]);
      }
    }
    if (rest > 0) out.push({ date: m.date, amount: rest, account_id: m.account_id });
  };
  for (const m of onward.all(payId, from, to)) follow(m, [payId, m.account_id]);
  return out;
}

const accountRow = (db, id) => db.prepare("SELECT id, name, nickname, type, is_business FROM accounts WHERE id = ? AND status IS NOT 'gone'").get(id);

export function suggestPlan(db, { today }) {
  const pay = payAccount(db);
  if (!pay) return { pay_account: null, paydays: [], window_days: SPLIT_DAYS, lines: [], reason: 'no salary stream yet' };
  const days = paydays(db).filter((p) => p.date <= today).slice(-SUGGEST_PAYDAYS);
  const per = new Map();
  for (const p of days) {
    const sums = new Map();
    for (const m of movesOut(db, pay.id, p.date, addDays(p.date, SPLIT_DAYS))) sums.set(m.account_id, (sums.get(m.account_id) ?? 0) + m.amount);
    for (const [k, v] of sums) (per.get(k) ?? per.set(k, []).get(k)).push(v);
  }
  const lines = [];
  for (const [id, amounts] of per) {
    const a = accountRow(db, id);
    if (!a) continue;
    lines.push({ account_id: id, account: label(a), kind: defaultKind(a), amount: Math.round(median(amounts) / 100) * 100, percent: null, seen: amounts.length });
  }
  lines.sort((x, y) => y.amount - x.amount);
  return { pay_account: { id: pay.id, name: label(pay) }, paydays: days.map((d) => d.date), window_days: SPLIT_DAYS, lines };
}

function checkLines(db, lines) {
  if (!Array.isArray(lines) || lines.length > MAX_LINES) throw bad(`lines must be a list of up to ${MAX_LINES} destinations`);
  const pay = payAccount(db);
  const seen = new Set();
  return lines.map((l, i) => {
    if (!l || typeof l !== 'object') throw bad('each line must be an object');
    const a = typeof l.account_id === 'string' ? accountRow(db, l.account_id) : null;
    if (!a) throw bad(`line ${i + 1}: no such account`);
    if (pay && a.id === pay.id) throw bad(`line ${i + 1}: that is the pay account itself`);
    if (seen.has(a.id)) throw bad(`line ${i + 1}: ${label(a)} is in the plan twice`);
    seen.add(a.id);
    const kind = l.kind ?? defaultKind(a);
    if (!PLAN_KINDS.includes(kind)) throw bad(`line ${i + 1}: kind must be one of ${PLAN_KINDS.join(', ')}`);
    const hasAmount = l.amount != null;
    const hasPct = l.percent != null;
    if (hasAmount === hasPct) throw bad(`line ${i + 1}: give an amount in cents or a percent, not both`);
    if (hasAmount && (!Number.isInteger(l.amount) || l.amount < 0 || l.amount > 1e11)) throw bad(`line ${i + 1}: amount must be whole cents, zero or more`);
    if (hasPct && (typeof l.percent !== 'number' || !(l.percent >= 0 && l.percent <= 100))) throw bad(`line ${i + 1}: percent must be 0 to 100`);
    return { account_id: a.id, kind, amount: hasAmount ? l.amount : null, percent_bp: hasPct ? Math.round(l.percent * 100) : null };
  });
}

function writeLines(db, lines, source) {
  const at = new Date().toISOString();
  const ins = db.prepare('INSERT INTO pay_plan (account_id, kind, amount, percent_bp, sort, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  tx(db, () => {
    db.prepare('DELETE FROM pay_plan').run();
    lines.forEach((l, i) => ins.run(l.account_id, l.kind, l.amount, l.percent_bp, i, source, at, at));
  });
}

// Replaces the whole plan; an empty list clears it.
export function setPlan(db, { lines } = {}) {
  writeLines(db, checkLines(db, lines), 'manual');
  setSetting(db, 'plan_seeded', 'manual');
  return getPlan(db, {});
}

const planned = (line, payAmount) => (line.amount != null ? line.amount : Math.round(((payAmount ?? 0) * line.percent_bp) / 10000));

// What the pay split puts aside from a cycle's pay before any spending: its
// saving, debt and business lines (everything but the spending line), planned
// against that cycle's payday. `loan` is the part of that going into a loan
// account: a repayment into the loan files under the Home loan budget category
// (see lib/spend.mjs), so zero-based budgets count it once, not as a split line
// and again as that budget's target.
export function setAsideFor(db, cycle) {
  const lines = db.prepare('SELECT p.kind, p.amount, p.percent_bp, a.type FROM pay_plan p JOIN accounts a ON a.id = p.account_id').all().filter((l) => l.kind !== 'spending');
  const amount = (l) => planned(l, cycle.payday?.amount);
  return { total: lines.reduce((s, l) => s + amount(l), 0), loan: lines.filter((l) => l.type === 'loan').reduce((s, l) => s + amount(l), 0) };
}

export function getPlan(db, { today = null } = {}) {
  const pay = payAccount(db);
  const last = paydays(db).filter((p) => !today || p.date <= today).at(-1) ?? null;
  const lines = db.prepare(`SELECT p.id, p.account_id, COALESCE(a.nickname, a.name) account, p.kind, p.amount, p.percent_bp, p.source
    FROM pay_plan p JOIN accounts a ON a.id = p.account_id ORDER BY p.sort, p.id`).all()
    .map((l) => ({ ...l, percent: l.percent_bp == null ? null : l.percent_bp / 100, planned: planned(l, last?.amount) }));
  const total = lines.reduce((s, l) => s + l.planned, 0);
  return {
    pay_account: pay ? { id: pay.id, name: label(pay) } : null,
    payday: last ? { date: last.date, amount: last.amount } : null,
    lines: lines.map(({ percent_bp, ...l }) => l),
    totals: { planned: total, saving: lines.filter((l) => l.kind !== 'spending').reduce((s, l) => s + l.planned, 0), left_in_pay_account: last ? last.amount - total : null },
    suggested: lines.length > 0 && lines.every((l) => l.source === 'suggested'),
  };
}

// Save the suggestion once, the first time there is history to suggest from.
export function seedPlan(db, { today }) {
  if (getSetting(db, 'plan_seeded')) return false;
  if (db.prepare('SELECT count(*) n FROM pay_plan').get().n) { setSetting(db, 'plan_seeded', 'had a plan'); return false; }
  const s = suggestPlan(db, { today });
  if (!s.pay_account || (!s.lines.length && s.paydays.length < SUGGEST_PAYDAYS)) return false;
  writeLines(db, s.lines.map((l) => ({ account_id: l.account_id, kind: l.kind, amount: l.amount, percent_bp: null })), 'suggested');
  setSetting(db, 'plan_seeded', new Date().toISOString());
  return true;
}

// Planned against moved for one cycle, using the plan as it stands now.
function statusFor(db, cycle, lines, pay, today) {
  const to = cycle.end < today ? cycle.end : today;
  const moves = movesOut(db, pay.id, cycle.start, to);
  const moved = new Map();
  for (const m of moves) moved.set(m.account_id, (moved.get(m.account_id) ?? 0) + m.amount);
  const out = lines.map((l) => {
    const p = planned(l, cycle.payday.amount);
    const m = moved.get(l.account_id) ?? 0;
    return { account_id: l.account_id, account: l.account, kind: l.kind, planned: p, moved: m, short: Math.max(0, p - m), status: p <= 0 || m >= p ? 'done' : m > 0 ? 'partial' : 'not_yet' };
  });
  const inPlan = new Set(lines.map((l) => l.account_id));
  const other = [...moved].filter(([k]) => !inPlan.has(k)).map(([k, v]) => ({ account_id: k, account: label(accountRow(db, k) ?? { name: k }), amount: v }));
  const status = !out.length ? 'no_plan' : out.every((l) => l.status === 'done') ? 'done' : out.every((l) => l.status === 'not_yet') ? 'not_yet' : 'partial';
  return { lines: out, other_moves: other, status };
}

export function splitStatus(db, { today }) {
  const pay = payAccount(db);
  const cycles = listCycles(db, { today }).filter((c) => c.start <= today);
  const cur = cycles.at(-1);
  if (!pay || !cur) return { pay_account: null, payday: null, lines: [], other_moves: [], status: 'no_plan', history: [], reason: 'no salary stream yet' };
  const lines = db.prepare(`SELECT p.account_id, COALESCE(a.nickname, a.name) account, p.kind, p.amount, p.percent_bp
    FROM pay_plan p JOIN accounts a ON a.id = p.account_id ORDER BY p.sort, p.id`).all();
  const now = statusFor(db, cur, lines, pay, today);
  return {
    pay_account: { id: pay.id, name: label(pay) },
    payday: cur.payday,
    cycle: { start: cur.start, end: cur.end },
    ...now,
    history: cycles.slice(-4).map((c) => ({ start: c.start, payday: c.payday, ...statusFor(db, c, lines, pay, today) })),
  };
}
