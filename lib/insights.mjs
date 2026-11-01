// What changed this pay cycle: the categories whose spend moved most against
// the last cycle, and the merchants that showed up for the first time. Read
// only, over the same spend rules as budgets and reports (linked transfers out,
// refunds and reimbursements netted, business spend left out).
//
// The comparison is like for like. The open cycle is only part-way through, so
// it is held against the same number of days from the start of the cycle
// before it, not that cycle's full total.
import { addDays, daysBetween } from './dates.mjs';
import { listCycles } from './cycles.mjs';
import { COUNTS, BUSINESS, FROM, KIND } from './spend.mjs';
import { LIVE } from './live.mjs';

export const MIN_MOVE = 1000; // cents: a move under $10 is noise
const NEW_MIN_HISTORY_DAYS = 28; // a book younger than this has nothing "new" to say yet

const spendByCategory = (db, from, to) => new Map(db.prepare(`SELECT c.id id, COALESCE(c.name, 'Uncategorised') name, -SUM(t.amount) spent
    FROM ${FROM} WHERE ${COUNTS} AND ${BUSINESS} = 0 AND ${KIND} = 'expense' AND t.date BETWEEN ? AND ?
    GROUP BY 1, 2 HAVING spent != 0`).all(from, to).map((r) => [r.id ?? null, r]));

export function cycleInsights(db, { today }) {
  const cycles = listCycles(db, { today });
  const cur = cycles.at(-1)?.start <= today ? cycles.at(-1) : null;
  const prev = cur ? cycles.at(-2) : null;
  if (!cur || !prev) {
    return { available: false, reason: cur ? 'Needs one finished pay cycle to compare against.' : 'Starts with your first pay cycle.', movers: [], new_merchants: null };
  }
  const to = today < cur.end ? today : cur.end;
  const days = daysBetween(cur.start, to) + 1;
  const prevTo = addDays(prev.start, days - 1) < prev.end ? addDays(prev.start, days - 1) : prev.end;

  const now = spendByCategory(db, cur.start, to);
  const before = spendByCategory(db, prev.start, prevTo);
  const movers = [...new Set([...now.keys(), ...before.keys()])].map((id) => {
    const a = now.get(id)?.spent ?? 0;
    const b = before.get(id)?.spent ?? 0;
    return {
      category_id: id, name: (now.get(id) ?? before.get(id)).name, now: a, before: b, change: a - b,
      percent: b > 0 ? Math.round(((a - b) / b) * 100) : null,
    };
  }).filter((m) => Math.abs(m.change) >= MIN_MOVE)
    .sort((x, y) => Math.abs(y.change) - Math.abs(x.change) || x.name.localeCompare(y.name))
    .slice(0, 3);

  return {
    available: true,
    cycle: { start: cur.start, to, days },
    compared_with: { start: prev.start, to: prevTo },
    totals: {
      now: [...now.values()].reduce((s, r) => s + r.spent, 0),
      before: [...before.values()].reduce((s, r) => s + r.spent, 0),
    },
    movers,
    new_merchants: newMerchants(db, cur.start, to),
  };
}

// Merchants charged in the window whose first ever charge is inside it. Null when the book
// does not reach back far enough before the window for "new" to mean anything.
function newMerchants(db, from, to) {
  const first = db.prepare('SELECT min(date) d FROM transactions WHERE ' + LIVE('transactions')).get().d;
  if (!first || daysBetween(first, from) < NEW_MIN_HISTORY_DAYS) return null;
  const name = 'COALESCE(t.merchant_override, t.merchant)';
  const rows = db.prepare(`SELECT MAX(${name}) merchant, lower(${name}) k, -SUM(t.amount) spent, count(*) count, MIN(t.date) first_date
    FROM ${FROM} WHERE ${COUNTS} AND ${BUSINESS} = 0 AND ${KIND} = 'expense' AND ${name} != ''
      AND lower(${name}) NOT IN (SELECT lower(COALESCE(merchant_override, merchant)) FROM transactions WHERE date < ? AND COALESCE(merchant_override, merchant) != '' AND ${LIVE('transactions')})
      AND t.date BETWEEN ? AND ?
    GROUP BY k HAVING spent > 0 ORDER BY spent DESC, merchant`).all(from, from, to);
  return { count: rows.length, total: rows.reduce((s, r) => s + r.spent, 0), items: rows.slice(0, 5).map(({ k, ...r }) => r) };
}
