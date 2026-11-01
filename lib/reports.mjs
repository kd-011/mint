// Read models for the Reports and Home screens: income and spend per month,
// spend per category per month, top merchants, and the review counts. Spend is
// net of refunds and leaves out linked transfers (see spend.mjs; a repayment
// into the home loan is the one transfer that counts) and, unless
// asked, business spend (business has its own place on the Tax screen).
import { bad } from './errors.mjs';
import { isIsoDate } from './dates.mjs';
import { COUNTS, BUSINESS, FROM, KIND, INCOME, OTHER_IN, REIMBURSED, SPEND_FROM, SPEND_COUNTS, SPEND_AMT } from './spend.mjs';
import { listAssets } from './networth.mjs';
import { LIVE } from './live.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_MONTHS = 120;

const nextMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};

export function monthlyReport(db, { from, to, includeBusiness = false } = {}) {
  if (typeof from !== 'string' || !MONTH.test(from) || typeof to !== 'string' || !MONTH.test(to)) throw bad('from and to must be YYYY-MM');
  if (from > to) throw bad('from must not be after to');
  const months = [];
  for (let m = from; m <= to; m = nextMonth(m)) {
    months.push({ month: m, income: 0, spent: 0, other_in: 0, reimbursed: 0 });
    if (months.length > MAX_MONTHS) throw bad(`ask for at most ${MAX_MONTHS} months`);
  }
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const biz = includeBusiness ? '' : `AND ${BUSINESS} = 0`;
  const range = [`${from}-01`, `${nextMonth(to)}-01`];
  for (const r of db.prepare(`SELECT substr(t.date, 1, 7) m,
        COALESCE(SUM(CASE WHEN ${INCOME} THEN t.amount END), 0) income,
        COALESCE(SUM(CASE WHEN ${OTHER_IN} THEN t.amount END), 0) other_in,
        COALESCE(-SUM(CASE WHEN ${KIND} = 'expense' THEN ${SPEND_AMT} END), 0) spent,
        COALESCE(SUM(CASE WHEN ${REIMBURSED} THEN t.amount END), 0) reimbursed
      FROM ${SPEND_FROM} WHERE ${SPEND_COUNTS} ${biz} AND t.date >= ? AND t.date < ? GROUP BY 1`).all(...range)) {
    Object.assign(byMonth.get(r.m), { income: r.income, other_in: r.other_in, spent: r.spent, reimbursed: r.reimbursed });
  }
  const categories = db.prepare(`SELECT substr(t.date, 1, 7) month, c.id category_id, COALESCE(c.name, 'Uncategorised') name, COALESCE(c.grp, '') grp, -SUM(${SPEND_AMT}) spent
    FROM ${SPEND_FROM} WHERE ${SPEND_COUNTS} ${biz} AND ${KIND} = 'expense' AND t.date >= ? AND t.date < ?
    GROUP BY 1, 2, 3, 4 HAVING spent != 0 ORDER BY 1, spent DESC`).all(...range);
  return { from, to, include_business: includeBusiness, months: months.map((m) => ({ ...m, net: m.income - m.spent })), categories };
}

export function topMerchants(db, { from = null, to = null, limit = 10, includeBusiness = false } = {}) {
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) throw bad('from and to must be YYYY-MM-DD');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('limit must be 1 to 100');
  const where = [COUNTS, `${KIND} = 'expense'`];
  const args = [];
  if (!includeBusiness) where.push(`${BUSINESS} = 0`);
  if (from) { where.push('t.date >= ?'); args.push(from); }
  if (to) { where.push('t.date <= ?'); args.push(to); }
  const items = db.prepare(`SELECT MAX(COALESCE(t.merchant_override, t.merchant)) merchant, -SUM(t.amount) spent, count(*) count, MAX(t.date) last_date
    FROM ${FROM} WHERE ${where.join(' AND ')} AND COALESCE(t.merchant_override, t.merchant) != ''
    GROUP BY lower(COALESCE(t.merchant_override, t.merchant)) HAVING spent > 0 ORDER BY spent DESC, merchant LIMIT ?`).all(...args, limit);
  return { from, to, items };
}

// What needs a look, for the Home card and the Accounts review tab.
export function reviewCounts(db, { today }) {
  const n = (sql) => db.prepare(sql).get().n;
  return {
    transfers: n("SELECT count(*) n FROM transfers WHERE status = 'review'"),
    uncategorised: n(`SELECT count(*) n FROM transactions WHERE category_id IS NULL AND ${LIVE('transactions')}`),
    guessed: n(`SELECT count(*) n FROM transactions WHERE category_source = 'ai' AND ${LIVE('transactions')}`),
    alerts: n('SELECT count(*) n FROM alerts WHERE dismissed_at IS NULL'),
    assets_due: listAssets(db, { today }).filter((a) => a.due).length,
  };
}
