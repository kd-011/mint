// Safe to spend, the headline number. For the current pay cycle:
//   expected cycle income (the salary that opened it, plus regular payers
//   received or still expected in the cycle)
//   - the planned savings split (every pay plan line that is not spending)
//   - fixed bills in the cycle, paid or still due (bills calendar)
//   - flexible spend so far (all personal spend in the cycle, net of refunds
//     and reimbursements, less the bills already counted above)
//   = safe to spend until payday, and per day over the days left.
// Plus a cash check: what sits in the spendable accounts less the bills still
// due before payday, with a warning when it goes short.
import { COUNTS, BUSINESS, FROM, KIND } from './spend.mjs';
import { currentCycle } from './cycles.mjs';
import { cycleIncome } from './income.mjs';
import { getPlan } from './plan.mjs';
import { billsCalendar } from './bills.mjs';
import { cycleBudgetProgress, cycleView } from './budgets.mjs';

const NOT_SPENDABLE = /offset|emergency|saving|invest|business|super|loan/i;

// A manual account (lib/manual.mjs) is never Mint's guess: it counts only when the owner pins it spendable.
export function spendableAccounts(db) {
  return db.prepare("SELECT id, name, nickname, type, is_business, hidden, spendable, manual, balance_current, balance_available FROM accounts WHERE status IS NOT 'gone' ORDER BY sort, name").all()
    .filter((a) => (a.spendable == null ? !a.manual && a.type === 'transaction' && !a.is_business && !a.hidden && !NOT_SPENDABLE.test(`${a.name} ${a.nickname ?? ''}`) : a.spendable === 1))
    .map((a) => ({ id: a.id, name: a.nickname || a.name, balance: a.balance_available ?? a.balance_current ?? 0, chosen: a.spendable != null }));
}

function cashCheck(db, dueItems) {
  const accounts = spendableAccounts(db);
  const spendable = accounts.reduce((s, a) => s + a.balance, 0);
  const due = dueItems.reduce((s, i) => s + (i.amount ?? 0), 0);
  return { accounts, spendable, bills_due: due, after_bills: spendable - due, short: spendable - due < 0 };
}

export function safeToSpend(db, { today }) {
  const cycle = currentCycle(db, { today });
  if (!cycle) {
    return { as_of: today, cycle: null, safe: null, per_day: null, reason: 'No salary seen yet, so there is no pay cycle to plan around.', cash: cashCheck(db, []) };
  }
  const inc = cycleIncome(db, cycle, { today });
  const plan = getPlan(db, { today });
  const saving = plan.lines.filter((l) => l.kind !== 'spending');
  const savings = saving.reduce((s, l) => s + l.planned, 0);
  const cal = billsCalendar(db, { today });
  const bills = cal.items.filter((i) => i.in_cycle);
  const billTotal = bills.reduce((s, i) => s + (i.amount ?? 0), 0);
  const spent = db.prepare(`SELECT COALESCE(-SUM(t.amount), 0) n FROM ${FROM}
    WHERE ${COUNTS} AND ${BUSINESS} = 0 AND ${KIND} = 'expense' AND t.date >= ? AND t.date <= ?`).get(cycle.start, today).n;
  // Paid bills are spend already in `spent` (loan repayments are transfers, so they are not).
  const paidBillSpend = bills.filter((i) => i.status === 'paid' && i.kind !== 'loan').reduce((s, i) => s + i.amount, 0);
  const flexible = spent - paidBillSpend;
  const income = { salary: inc.expected.salary, regular_received: inc.received.regular, regular_expected: inc.regular_expected, total: inc.expected.total };
  const safe = income.total - savings - billTotal - flexible;
  const daysLeft = cycle.days_left;
  const budgets = cycleBudgetProgress(db, cycle, { today, zero: false }).totals.flexible;
  return {
    as_of: today,
    cycle: cycleView(cycle),
    days_left: daysLeft,
    income,
    savings_planned: savings,
    bills: billTotal,
    flexible_spent: flexible,
    safe,
    per_day: daysLeft > 0 ? Math.floor(safe / daysLeft) : safe,
    breakdown: [
      { key: 'income', label: 'Expected income this cycle', amount: income.total },
      { key: 'savings', label: 'Planned savings and paydowns', amount: -savings, lines: saving.map(({ account_id, account, kind, planned }) => ({ account_id, account, kind, amount: planned })) },
      { key: 'bills', label: 'Fixed bills this cycle, paid or due', amount: -billTotal, lines: bills.map(({ date, merchant, amount, status, kind, paid_on }) => ({ date: paid_on ?? date, merchant, amount, status, kind })) },
      { key: 'flexible', label: 'Flexible spend so far', amount: -flexible },
      { key: 'safe', label: 'Safe to spend until payday', amount: safe },
    ],
    regular: inc.regular,
    flexible_budget: budgets,
    cash: cashCheck(db, bills.filter((i) => i.status === 'due')),
    note: 'Cents. Per day is safe to spend over the days left including today.',
  };
}
