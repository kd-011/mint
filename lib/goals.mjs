// Savings goals. Progress is a linked account's balance, or the sum of manual
// contributions when no account is linked. A dated goal says how much each
// pay cycle needs to go in to make it, and whether the pay split covers that.
import { getSetting, setSetting } from './db.mjs';
import { bad, notFound } from './errors.mjs';
import { daysBetween, isIsoDate, perthDate } from './dates.mjs';
import { paydays } from './cycles.mjs';

const CYCLE_DAYS = 14;
const GOAL_COLS = 'id, name, target_amount, target_date, account_id, archived, sort, created_at, updated_at';

const getGoal = (db, id) => {
  const g = Number.isInteger(id) ? db.prepare(`SELECT ${GOAL_COLS} FROM goals WHERE id = ?`).get(id) : null;
  if (!g) throw notFound('no such goal');
  return g;
};

function check(db, body, partial) {
  if (!body || typeof body !== 'object') throw bad('goal must be an object');
  const out = {};
  if (!partial || 'name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 60) throw bad('name must be 1 to 60 characters');
    out.name = body.name.trim();
  }
  if ('target_amount' in body) {
    const v = body.target_amount;
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > 1e12)) throw bad('target_amount must be whole cents or null');
    out.target_amount = v;
  }
  if ('target_date' in body) {
    if (body.target_date !== null && !isIsoDate(body.target_date)) throw bad('target_date must be a real date as YYYY-MM-DD, or null');
    out.target_date = body.target_date;
  }
  if ('account_id' in body) {
    if (body.account_id !== null && (typeof body.account_id !== 'string' || !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(body.account_id))) throw bad('no such account');
    out.account_id = body.account_id;
  }
  if ('archived' in body) {
    if (typeof body.archived !== 'boolean') throw bad('archived must be true or false');
    out.archived = body.archived ? 1 : 0;
  }
  return out;
}

export function createGoal(db, body = {}) {
  const g = check(db, body, false);
  const at = new Date().toISOString();
  const { lastInsertRowid } = db.prepare(`INSERT INTO goals (name, target_amount, target_date, account_id, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, (SELECT COALESCE(max(sort), 0) + 1 FROM goals), ?, ?)`).run(g.name, g.target_amount ?? null, g.target_date ?? null, g.account_id ?? null, at, at);
  return getGoal(db, Number(lastInsertRowid));
}

export function updateGoal(db, id, body = {}) {
  getGoal(db, id);
  const g = check(db, body, true);
  const keys = Object.keys(g);
  if (!keys.length) throw bad('nothing to change');
  db.prepare(`UPDATE goals SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => g[k]), new Date().toISOString(), id);
  return getGoal(db, id);
}

export function deleteGoal(db, id) {
  getGoal(db, id);
  db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  return { deleted: true };
}

export function addContribution(db, goalId, { date = perthDate(), amount, note = null } = {}) {
  getGoal(db, goalId);
  if (!isIsoDate(date)) throw bad('date must be YYYY-MM-DD');
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1e12) throw bad('amount must be whole cents, not zero (negative takes money back out)');
  if (note != null && (typeof note !== 'string' || note.length > 200)) throw bad('note must be up to 200 characters');
  const { lastInsertRowid } = db.prepare('INSERT INTO goal_contributions (goal_id, date, amount, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(goalId, date, amount, note?.trim() || null, new Date().toISOString());
  return db.prepare('SELECT id, goal_id, date, amount, note FROM goal_contributions WHERE id = ?').get(Number(lastInsertRowid));
}

export function deleteContribution(db, goalId, contributionId) {
  getGoal(db, goalId);
  if (!db.prepare('DELETE FROM goal_contributions WHERE id = ? AND goal_id = ?').run(contributionId, goalId).changes) throw notFound('no such contribution');
  return { deleted: true };
}

export function listGoals(db, { today = perthDate(), includeArchived = false } = {}) {
  const pay = paydays(db).at(-1)?.amount ?? null;
  const plan = new Map(db.prepare('SELECT account_id, amount, percent_bp FROM pay_plan').all()
    .map((l) => [l.account_id, l.amount ?? (pay == null ? null : Math.round((pay * l.percent_bp) / 10000))]));
  return db.prepare(`SELECT g.*, COALESCE(a.nickname, a.name) account, a.balance_current,
      (SELECT COALESCE(SUM(amount), 0) FROM goal_contributions c WHERE c.goal_id = g.id) contributed,
      (SELECT count(*) FROM goal_contributions c WHERE c.goal_id = g.id) contributions
    FROM goals g LEFT JOIN accounts a ON a.id = g.account_id ${includeArchived ? '' : 'WHERE g.archived = 0'} ORDER BY g.archived, g.sort, g.id`).all()
    .map((g) => {
      const progress = g.account_id ? Math.max(0, g.balance_current ?? 0) : g.contributed;
      const target = g.target_amount;
      const remaining = target == null ? null : Math.max(0, target - progress);
      let cyclesLeft = null;
      let perCycle = null;
      if (target != null && g.target_date) {
        const days = daysBetween(today, g.target_date);
        cyclesLeft = days > 0 ? Math.ceil(days / CYCLE_DAYS) : 0;
        perCycle = remaining === 0 ? 0 : Math.ceil(remaining / Math.max(1, cyclesLeft));
      }
      const plannedPerCycle = g.account_id ? plan.get(g.account_id) ?? null : null;
      return {
        id: g.id, name: g.name, target_amount: target, target_date: g.target_date, account_id: g.account_id, account: g.account ?? null,
        account_balance: g.account_id ? g.balance_current ?? null : null,
        archived: !!g.archived, progress_basis: g.account_id ? 'account_balance' : 'contributions', contributions: g.contributions,
        progress, remaining, pct: target ? Math.min(100, Math.round((progress / target) * 100)) : null,
        cycles_left: cyclesLeft, per_cycle_needed: perCycle, planned_per_cycle: plannedPerCycle,
        on_track: perCycle == null || plannedPerCycle == null ? null : plannedPerCycle >= perCycle,
        done: target != null && progress >= target,
      };
    });
}

export function listContributions(db, goalId) {
  getGoal(db, goalId);
  return db.prepare('SELECT id, goal_id, date, amount, note FROM goal_contributions WHERE goal_id = ? ORDER BY date DESC, id DESC').all(goalId);
}

// An Emergency Fund goal on the emergency account, no target (the owner sets it). Once.
export function seedGoals(db) {
  if (getSetting(db, 'goals_seeded')) return false;
  if (db.prepare('SELECT count(*) n FROM goals').get().n) { setSetting(db, 'goals_seeded', 'had goals'); return false; }
  const a = db.prepare("SELECT id FROM accounts WHERE status IS NOT 'gone' AND type != 'loan' AND type != 'credit-card' AND (name LIKE '%emergency%' OR nickname LIKE '%emergency%') ORDER BY sort LIMIT 1").get();
  if (!a) return false;
  createGoal(db, { name: 'Emergency Fund', account_id: a.id });
  setSetting(db, 'goals_seeded', new Date().toISOString());
  return true;
}
