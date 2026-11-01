// Home loan repayments count as spend. The owner pays the loan from his own account,
// so both legs are Transfers and used to drop out of every budget. A repayment
// now lands in its own "Home loan" budget line, once. The loan's drawdown and
// its interest debit never do, credit card repayments stay transfers, and net
// worth, the forecast and safe to spend read as before. Invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, setCat } from './fixtures/pay.mjs';
import { setBudget, cycleBudgetProgress, budgetProgress, categoryTransactions, toCycle } from '../lib/budgets.mjs';
import { currentCycle, listCycles } from '../lib/cycles.mjs';
import { seedCategories, SEED_CATEGORIES } from '../lib/categories.mjs';
import { seedHomeLoanBudget } from '../lib/loanbudget.mjs';
import { spendReport, budgets as assistantBudgets, cycleSummary } from '../lib/assistant.mjs';
import { monthlyReport } from '../lib/reports.mjs';
import { netWorth } from '../lib/networth.mjs';
import { forecast } from '../lib/forecast.mjs';
import { safeToSpend } from '../lib/safe.mjs';
import { transferOf } from '../lib/transfers.mjs';

const TODAY = '2026-10-17';
const REPAID_SEP = 217920; // 2026-09-23, $2,179.20
const REPAID_OCT = 188216; // 2026-10-14, $1,882.16
const AFTERPAY = 6500;
const EVERYDAY = 'acct_t_everyday';
const LOAN = 'acct_t_loan';

// A salary book with a loan: drawdown, interest debits, two repayments paid
// from the everyday account, a card repayment, and an Afterpay instalment.
function loanBook({ withRepayments = true } = {}) {
  const b = payBook();
  setCat(b, b.add(LOAN, '2026-07-28', -35099895, 'LOAN DRAWDOWN', { provider_category: null }), 'Loan drawdown');
  b.add(LOAN, '2026-09-30', -188216, 'INTEREST', { provider_category: null });
  b.add(LOAN, '2026-10-01', -3100, 'INTEREST', { provider_category: null });
  if (withRepayments) {
    b.add(EVERYDAY, '2026-09-23', -REPAID_SEP, 'Anz M-Banking', { provider_category: 'TRANSFER_OUT' });
    b.add(LOAN, '2026-09-23', REPAID_SEP, 'Anz M-Banking', { provider_category: 'TRANSFER_IN' });
    b.add(EVERYDAY, '2026-10-14', -REPAID_OCT, 'Anz M-Banking', { provider_category: 'TRANSFER_OUT' });
    b.add(LOAN, '2026-10-14', REPAID_OCT, 'Anz M-Banking', { provider_category: 'TRANSFER_IN' });
  }
  // Card repayment: a transfer, the purchases on the card are the spend.
  b.add(EVERYDAY, '2026-10-10', -30000, 'ONLINE Card Payment', { provider_category: 'TRANSFER_OUT' });
  b.add('acct_t_card', '2026-10-10', 30000, 'ONLINE Card Payment', { provider_category: 'TRANSFER_IN' });
  setCat(b, b.add('acct_t_card', '2026-10-12', -AFTERPAY, 'AFTERPAY INSTALMENT'), 'Debt repayments');
  refreshMoney(b, TODAY);
  return b;
}

const cycleNow = (b) => currentCycle(b.db, { today: TODAY });
const row = (p, name) => p.items.find((i) => i.name === name);

function budgeted(b) {
  setBudget(b.db, b.cat('Debt repayments'), { cycle_target: 19000 });
  setBudget(b.db, b.cat('Home loan'), { cycle_target: toCycle(REPAID_OCT), fixed: true });
}

test('Home loan is a fixed-style expense category in the Home group', () => {
  const [grp, name, kind] = SEED_CATEGORIES.find(([, n]) => n === 'Home loan') ?? [];
  assert.deepEqual([grp, name, kind], ['Home', 'Home loan', 'expense']);
  const b = payBook();
  seedCategories(b.db); // an existing book picks it up on the next start
  assert.ok(b.cat('Home loan'));
});

test('the repayment leg is linked as a loan repayment, and stays a transfer for matching', () => {
  const b = loanBook();
  const t = b.db.prepare("SELECT kind, status FROM transfers WHERE kind = 'loan_repayment'").all();
  assert.equal(t.length, 2);
  assert.ok(t.every((x) => x.status === 'auto'));
  assert.equal(b.db.prepare("SELECT count(*) n FROM transfers WHERE kind = 'card_repayment'").get().n, 1);
  assert.ok(transferOf(b.db, b.db.prepare('SELECT id FROM transactions WHERE amount = ? AND account_id = ?').get(-REPAID_OCT, EVERYDAY).id));
});

test('current cycle: the repayment shows once in Home loan, Debt repayments still holds only Afterpay', () => {
  const b = loanBook();
  budgeted(b);
  const p = cycleBudgetProgress(b.db, cycleNow(b), { today: TODAY });
  assert.deepEqual([p.cycle.start, p.cycle.end], ['2026-10-07', '2026-10-20']);
  const loan = row(p, 'Home loan');
  assert.equal(loan.spent, REPAID_OCT, 'counted once, not once per leg');
  assert.equal(loan.fixed, true);
  assert.equal(row(p, 'Debt repayments').spent, AFTERPAY);
  assert.equal(p.totals.fixed.spent, REPAID_OCT);
  assert.equal(p.totals.flexible.spent, AFTERPAY);
});

test('the previous cycle holds the September repayment, and a cycle with no instalment is clean', () => {
  const b = loanBook();
  budgeted(b);
  const cycles = listCycles(b.db, { today: TODAY });
  const prev = cycles.find((c) => c.start === '2026-09-23');
  assert.equal(row(cycleBudgetProgress(b.db, prev, { today: TODAY }), 'Home loan').spent, REPAID_SEP);
  const quiet = cycles.find((c) => c.start === '2026-09-09');
  const q = row(cycleBudgetProgress(b.db, quiet, { today: TODAY }), 'Home loan');
  assert.equal(q.spent, 0);
  assert.equal(q.over, false);
});

test('the drawdown and the interest debit never count as Home loan', () => {
  const b = loanBook();
  budgeted(b);
  const all = listCycles(b.db, { today: TODAY });
  const total = all.reduce((s, c) => s + row(cycleBudgetProgress(b.db, c, { today: TODAY }), 'Home loan').spent, 0);
  assert.equal(total, REPAID_SEP + REPAID_OCT);
  const sep = row(cycleBudgetProgress(b.db, all.find((c) => c.start === '2026-09-23'), { today: TODAY }), 'Home loan');
  assert.equal(sep.spent, REPAID_SEP, 'the 188216 interest debit on 30 Sep is not added');
  // The interest debit is exactly where it was: Interest charged, not Home loan.
  const interest = b.db.prepare("SELECT c.name FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.description = 'INTEREST'").all();
  assert.ok(interest.every((r) => r.name === 'Interest charged'));
});

test('credit card repayments stay transfers: nothing in any budget or spend total', () => {
  const b = loanBook();
  budgeted(b);
  const p = cycleBudgetProgress(b.db, cycleNow(b), { today: TODAY });
  assert.equal(p.totals.spent, REPAID_OCT + AFTERPAY);
  const r = spendReport(b.db, { from: '2026-10-07', to: TODAY }, TODAY);
  assert.equal(r.totals.spent, REPAID_OCT + AFTERPAY);
});

test('a credit into a loan with no matched outgoing leg counts once; a matched pair counts the outgoing leg only', () => {
  const b = loanBook({ withRepayments: false });
  budgeted(b);
  // Paid from outside Mint (another bank): only the loan-account credit is seen.
  b.add(LOAN, '2026-10-15', 100000, 'BPAY Loan Payment', { provider_category: null });
  refreshMoney(b, TODAY);
  const p = cycleBudgetProgress(b.db, cycleNow(b), { today: TODAY });
  assert.equal(row(p, 'Home loan').spent, 100000);
  // Now the outgoing leg turns up and pairs with it: still 100000, not 200000.
  b.add(EVERYDAY, '2026-10-15', -100000, 'Anz M-Banking', { provider_category: 'TRANSFER_OUT' });
  refreshMoney(b, TODAY);
  assert.equal(b.db.prepare("SELECT count(*) n FROM transfers WHERE kind = 'loan_repayment'").get().n, 1);
  assert.equal(row(cycleBudgetProgress(b.db, cycleNow(b), { today: TODAY }), 'Home loan').spent, 100000);
});

test('a doubtful pair waiting for review is not counted twice', () => {
  const b = loanBook({ withRepayments: false });
  budgeted(b);
  const o = b.add(EVERYDAY, '2026-10-15', -50000, 'Loan Instalment', { provider_category: 'LOAN_PAYMENTS' });
  b.add(LOAN, '2026-10-15', 50000, 'Loan Instalment', { provider_category: null });
  refreshMoney(b, TODAY);
  b.db.prepare("UPDATE transfers SET status = 'review'").run();
  setCat(b, o, 'Debt repayments');
  const p = cycleBudgetProgress(b.db, cycleNow(b), { today: TODAY });
  assert.equal(row(p, 'Home loan').spent, 0);
  assert.equal(row(p, 'Debt repayments').spent, 50000 + AFTERPAY);
});

test('the monthly roll-up and the transactions behind the line agree', () => {
  const b = loanBook();
  budgeted(b);
  const m = budgetProgress(b.db, '2026-10');
  assert.equal(row(m, 'Home loan').spent, REPAID_OCT);
  const detail = categoryTransactions(b.db, b.cat('Home loan'), { cycle: cycleNow(b), today: TODAY });
  assert.equal(detail.spent, REPAID_OCT);
  assert.equal(detail.count, 1);
  assert.equal(detail.ids.length, 1);
  assert.equal(b.db.prepare('SELECT amount FROM transactions WHERE id = ?').get(detail.ids[0]).amount, -REPAID_OCT);
});

test('Reports sees the same category line', () => {
  const b = loanBook();
  const r = monthlyReport(b.db, { from: '2026-10', to: '2026-10' });
  const line = r.categories.find((c) => c.name === 'Home loan');
  assert.equal(line?.spent, REPAID_OCT);
});

test('the assistant door picks it up: mint_budgets, mint_spend and the cycle read', () => {
  const b = loanBook();
  budgeted(b);
  const bud = assistantBudgets(b.db, {}, TODAY);
  assert.equal(row(bud, 'Home loan').spent, REPAID_OCT);
  const spend = spendReport(b.db, { from: '2026-10-07', to: TODAY, group: 'category' }, TODAY);
  assert.deepEqual(spend.groups.find((g) => g.name === 'Home loan'), { key: 'Home loan', name: 'Home loan', spent: REPAID_OCT, count: 1 });
  assert.equal(spend.groups.find((g) => g.name === 'Debt repayments').spent, AFTERPAY);
  const cyc = cycleSummary(b.db, TODAY);
  assert.equal(cyc.budgets.items.find((i) => i.name === 'Home loan').spent, REPAID_OCT);
  assert.equal(cyc.budgets.fixed.spent, REPAID_OCT);
});

test('net worth, the forecast and safe to spend read the same with or without the repayments counting', () => {
  // Same book, repayments paid from outside (so no loan-repayment leg counts as spend) vs paid from the everyday account.
  const a = loanBook();
  const sa = safeToSpend(a.db, { today: TODAY });
  const fa = forecast(a.db, { today: TODAY });
  assert.equal(sa.flexible_spent, AFTERPAY, 'safe to spend does not see the repayment as flexible spend');
  assert.equal(sa.breakdown.find((x) => x.key === 'flexible').amount, -AFTERPAY);
  const loans = netWorth(a.db).loans;
  assert.equal(loans.length, 1);
  // The forecast baseline is everyday spend only: no repayment in it.
  const b2 = loanBook({ withRepayments: false });
  const fb = forecast(b2.db, { today: TODAY });
  assert.equal(fa.baseline.daily, fb.baseline.daily);
  assert.equal(fa.baseline.sd, fb.baseline.sd);
});

test('Home loan budget default: the repayment Mint knows, scaled to the cycle, fixed, no rollover, made once', () => {
  const b = loanBook();
  assert.equal(b.db.prepare('SELECT count(*) n FROM budgets').get().n, 0);
  assert.equal(seedHomeLoanBudget(b.db), 1);
  const made = b.db.prepare('SELECT * FROM budgets WHERE category_id = ?').get(b.cat('Home loan'));
  assert.equal(made.fixed, 1);
  assert.equal(made.rollover, 0);
  assert.equal(made.source, 'starter');
  assert.equal(made.monthly_target, REPAID_OCT, 'the latest repayment, with fewer than three seen');
  assert.equal(made.cycle_target, toCycle(REPAID_OCT));
  // Once: a second run changes nothing, and a budget the owner deletes stays deleted.
  assert.equal(seedHomeLoanBudget(b.db), 0);
  b.db.prepare('DELETE FROM budgets WHERE category_id = ?').run(b.cat('Home loan'));
  assert.equal(seedHomeLoanBudget(b.db), 0);
  assert.equal(b.db.prepare('SELECT count(*) n FROM budgets').get().n, 0);
});

test('no known repayment, no Home loan budget; and one the owner already set is left alone', () => {
  const none = payBook();
  assert.equal(seedHomeLoanBudget(none.db), 0);
  const b = loanBook();
  setBudget(b.db, b.cat('Home loan'), { cycle_target: 123400 }, { source: 'manual' });
  assert.equal(seedHomeLoanBudget(b.db), 0);
  assert.equal(b.db.prepare('SELECT cycle_target, source FROM budgets WHERE category_id = ?').get(b.cat('Home loan')).cycle_target, 123400);
});

test('the settlement week is not a repayment: own funds into the loan around its start never count', () => {
  const b = loanBook({ withRepayments: false });
  budgeted(b);
  // The bank's start date is 7 Oct: funds in that week are settlement, the same rule loanFacts uses.
  b.db.prepare('UPDATE accounts SET details_json = ? WHERE id = ?').run(JSON.stringify({ loan_details: { original_start_date: '2026-10-07' } }), LOAN);
  b.add(EVERYDAY, '2026-10-09', -2370296, 'Anz M-Banking', { provider_category: 'TRANSFER_OUT' });
  b.add(LOAN, '2026-10-09', 2370296, 'Anz M-Banking', { provider_category: 'TRANSFER_IN' });
  b.add(EVERYDAY, '2026-10-15', -188216, 'Anz M-Banking', { provider_category: 'TRANSFER_OUT' });
  b.add(LOAN, '2026-10-15', 188216, 'Anz M-Banking', { provider_category: 'TRANSFER_IN' });
  refreshMoney(b, TODAY);
  assert.equal(row(cycleBudgetProgress(b.db, cycleNow(b), { today: TODAY }), 'Home loan').spent, 188216);
});
