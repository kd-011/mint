// Save and Invest, savings and offset accounts: the balance of each, interest
// credited this month and this financial year (credit transactions categorised
// Interest on those accounts; the offset's benefit is a saving on the loan, not
// a credit, and is on the home loan card), and the savings rate.
//
// Savings rate = net saved over income. Income is salary and regular payers
// (see spend.mjs), spend is personal spend net of refunds, and linked
// transfers are left out of both, so moving money to savings is not spending.
// "This month" is the calendar month so far; "trailing 3" is the three
// complete months before it.
import { addMonths } from './recurring.mjs';
import { monthlyReport } from './reports.mjs';
import { fyOf, fyRange } from './tax.mjs';
import { LIVE } from './live.mjs';

const SAVINGS_TYPE = /^(savings?|term[-_ ]?deposit)$/i;
const SAVINGS_NAME = /offset|emergency|saving/i;
const OFFSET_NAME = /offset/i;
const round4 = (x) => Math.round(x * 10000) / 10000;

// An account the owner marked as one he spends from is never a savings account, one
// marked not-spendable always is; with no mark, the type or the name decides.
export function savingsAccounts(db) {
  return db.prepare("SELECT id, name, nickname, type, institution, spendable, balance_current, balance_observed_at FROM accounts WHERE status IS NOT 'gone' AND hidden = 0 AND is_business = 0 AND type NOT IN ('loan', 'credit-card') ORDER BY sort, name").all()
    .filter((a) => (a.spendable == null ? SAVINGS_TYPE.test(a.type) || SAVINGS_NAME.test(`${a.name} ${a.nickname ?? ''}`) : a.spendable === 0))
    .map((a) => ({
      id: a.id, name: a.nickname || a.name, institution: a.institution, role: OFFSET_NAME.test(`${a.name} ${a.nickname ?? ''}`) ? 'offset' : 'savings',
      balance: a.balance_current ?? 0, as_of: a.balance_observed_at ?? null,
    }));
}

const rateOf = (income, spent) => (income > 0 ? round4((income - spent) / income) : null);

function savingsRate(db, today) {
  const thisMonth = today.slice(0, 7);
  const from = addMonths(`${thisMonth}-01`, -3).slice(0, 7);
  const rep = monthlyReport(db, { from, to: thisMonth });
  const months = rep.months.map((m) => ({ month: m.month, income: m.income, spent: m.spent, net: m.income - m.spent, rate: rateOf(m.income, m.spent) }));
  const cur = months.at(-1);
  const prior = months.slice(0, -1);
  const income = prior.reduce((s, m) => s + m.income, 0);
  const spent = prior.reduce((s, m) => s + m.spent, 0);
  return {
    this_month: cur,
    trailing_3: { from: prior[0].month, to: prior.at(-1).month, income, spent, net: income - spent, rate: rateOf(income, spent) },
    months,
  };
}

// The total balance of the savings accounts on each day a snapshot was taken,
// each account carried forward from its last known balance.
function history(db, ids) {
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT account_id, date, current FROM balance_snapshots WHERE current IS NOT NULL AND account_id IN (${ids.map(() => '?').join(',')}) ORDER BY date`).all(...ids);
  const state = new Map();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    state.set(rows[i].account_id, rows[i].current);
    if (i + 1 < rows.length && rows[i + 1].date === rows[i].date) continue;
    out.push([rows[i].date, [...state.values()].reduce((s, v) => s + v, 0)]);
  }
  return out;
}

export function savingsOverview(db, { today }) {
  const accts = savingsAccounts(db);
  const fy = fyOf(today);
  const { from: fyFrom } = fyRange(fy);
  const monthFrom = `${today.slice(0, 7)}-01`;
  const interest = new Map();
  if (accts.length) {
    for (const r of db.prepare(`SELECT t.account_id id, COALESCE(SUM(CASE WHEN t.date >= ? THEN t.amount END), 0) month, SUM(t.amount) fy
        FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE c.name = 'Interest' AND t.amount > 0 AND ${LIVE()} AND t.date >= ? AND t.date <= ? AND t.account_id IN (${accts.map(() => '?').join(',')})
        GROUP BY t.account_id`).all(monthFrom, fyFrom, today, ...accts.map((a) => a.id))) interest.set(r.id, { month: r.month, fy: r.fy });
  }
  const accounts = accts.map((a) => ({ ...a, interest: interest.get(a.id) ?? { month: 0, fy: 0 } }));
  return {
    as_of: today,
    accounts,
    total_balance: accounts.reduce((s, a) => s + a.balance, 0),
    interest: { month: accounts.reduce((s, a) => s + a.interest.month, 0), fy: accounts.reduce((s, a) => s + a.interest.fy, 0), fy_label: `FY${fy}`, fy_from: fyFrom },
    savings_rate: savingsRate(db, today),
    history: history(db, accts.map((a) => a.id)),
  };
}
