// The firm invariant for manual foreign-currency accounts: a THB account's
// native figures never reach an AUD aggregate. An opening balance of 100,000
// THB is not spend, income, tax or safe to spend, and counts in net worth at
// its AUD value only. A THB spend counts at its converted AUD value, never at
// its native number. Every figure for the AUD accounts stays identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, setCat } from './fixtures/pay.mjs';
import { spendReport, cycleSummary, summary } from '../lib/assistant.mjs';
import { budgetProgress, cycleBudgetProgress, setBudget } from '../lib/budgets.mjs';
import { currentCycle } from '../lib/cycles.mjs';
import { monthlyReport, topMerchants } from '../lib/reports.mjs';
import { incomeReport } from '../lib/income.mjs';
import { safeToSpend } from '../lib/safe.mjs';
import { netWorth, netWorthHistory } from '../lib/networth.mjs';
import { fySummary } from '../lib/tax.mjs';
import { savingsOverview } from '../lib/savings.mjs';
import { taxReturnEstimate } from '../lib/taxestimate.mjs';
import { forecast } from '../lib/forecast.mjs';
import { cycleInsights } from '../lib/insights.mjs';
import { storeRates } from '../lib/fx.mjs';
import { createManualAccount, addManualTransaction } from '../lib/manual.mjs';

const TODAY = '2026-10-17';
const THB = 0.045; // AUD per baht, invented

function base() {
  const b = payBook();
  for (const [d, amt, desc, cat] of [
    ['2026-10-08', -8000, 'TEST GROCER', 'Groceries'], ['2026-10-10', -4500, 'TEST CAFE', 'Eating out'],
    ['2026-10-12', -12000, 'TEST FUEL', 'Fuel'], ['2026-09-15', -9900, 'TEST GROCER', 'Groceries'],
  ]) setCat(b, b.add('acct_t_everyday', d, amt, desc), cat);
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 40000 });
  setBudget(b.db, b.cat('Eating out'), { cycle_target: 20000 });
  storeRates(b.db, 'THB', [{ date: '2026-09-01', rate: THB }, { date: '2026-10-16', rate: THB }], { source: 'test', fetchedAt: '2026-10-17T00:00:00Z' });
  refreshMoney(b, TODAY);
  return b;
}

// Every AUD aggregate a screen or the assistant reads, as plain data.
function aggregates(db) {
  const cycle = currentCycle(db, { today: TODAY });
  const strip = (o) => JSON.parse(JSON.stringify(o));
  return strip({
    spend: spendReport(db, { from: '2026-10-01', to: TODAY }, TODAY).totals,
    spendSep: spendReport(db, { from: '2026-09-01', to: '2026-09-30' }, TODAY).totals,
    budgetsCycle: cycleBudgetProgress(db, cycle, { today: TODAY }).totals,
    budgetsMonth: budgetProgress(db, '2026-10', { today: TODAY }).totals,
    monthly: monthlyReport(db, { from: '2026-08', to: '2026-10' }).months,
    merchants: topMerchants(db, { from: '2026-08-01', to: TODAY }),
    income: incomeReport(db, { today: TODAY }).by_cycle,
    safe: (({ safe, per_day, income, bills, flexible_spent, cash }) => ({ safe, per_day, income, bills, flexible_spent, spendable: cash.spendable }))(safeToSpend(db, { today: TODAY })),
    tax: fySummary(db, 2027),
    taxEstimate: taxReturnEstimate(db, { fy: 2027, today: TODAY }).estimate,
    cycleSummary: (({ income, safe_to_spend, budgets }) => ({ income, safe_to_spend, budgets }))(cycleSummary(db, TODAY)),
    forecastStart: forecast(db, { today: TODAY }).start_balance ?? null,
    insights: cycleInsights(db, { today: TODAY }).totals ?? null,
    savingsRate: savingsOverview(db, { today: TODAY }).savings_rate,
  });
}

test('a 100,000 THB opening balance changes no AUD aggregate, and counts in net worth at its AUD value', () => {
  const b = base();
  const before = aggregates(b.db);
  const nw0 = netWorth(b.db);
  const a = createManualAccount(b.db, { name: 'Bangkok Bank', institution: 'Bangkok Bank', type: 'transaction', currency: 'THB', opening_balance: 10_000_000, opening_date: '2026-09-01' }, { today: TODAY });
  refreshMoney(b, TODAY);
  assert.deepEqual(aggregates(b.db), before);
  const nw = netWorth(b.db);
  assert.equal(nw.net_worth - nw0.net_worth, 450_000, '100,000 THB at 0.045 is $4,500.00');
  assert.notEqual(nw.net_worth - nw0.net_worth, 10_000_000);
  const row = nw.accounts.find((x) => x.id === a.id);
  assert.equal(row.balance, 450_000);
  assert.equal(row.balance_native, 10_000_000);
  assert.equal(row.currency, 'THB');
  // The history carries it in AUD from its opening date.
  const hist = netWorthHistory(b.db, { from: '2026-09-01' });
  const h0 = netWorthHistory(base().db, { from: '2026-09-01' });
  const last = (h) => h.at(-1)?.net_worth ?? 0; // the fixture book has no snapshots of its own
  assert.equal(last(hist) - last(h0), 450_000);
});

test('THB money in and out reach the aggregates only at their AUD value', () => {
  const b = base();
  const a = createManualAccount(b.db, { name: 'Bangkok Bank', institution: 'Bangkok Bank', type: 'transaction', currency: 'THB', opening_balance: 10_000_000, opening_date: '2026-09-01' }, { today: TODAY });
  refreshMoney(b, TODAY);
  const before = aggregates(b.db);
  // 1,000 baht at a Bangkok cafe, filed under Eating out; a 50,000 baht top-up in.
  addManualTransaction(b.db, a.id, { date: '2026-10-11', amount: -100_000, description: 'TEST BANGKOK CAFE', category_id: b.cat('Eating out') }, { today: TODAY });
  addManualTransaction(b.db, a.id, { date: '2026-10-11', amount: 5_000_000, description: 'TOPUP FROM AUD BALANCE', category_id: b.cat('Transfers') }, { today: TODAY });
  refreshMoney(b, TODAY);
  const after = aggregates(b.db);
  assert.equal(after.spend.personal_spent - before.spend.personal_spent, 4_500, 'spend grows by $45, not 1,000 baht');
  assert.equal(after.budgetsCycle.spent - before.budgetsCycle.spent, 4_500);
  const income = (rows) => rows.map(({ spent, ...r }) => r);
  assert.deepEqual(income(after.income), income(before.income), 'the top-up is a transfer, never income');
  assert.equal(after.income.at(-1).spent - before.income.at(-1).spent, 4_500);
  assert.deepEqual(after.spendSep, before.spendSep);
  assert.deepEqual(after.tax, before.tax);
  assert.equal(after.safe.spendable, before.safe.spendable, 'a manual account is not spendable cash unless pinned');
  const nw = netWorth(b.db).accounts.find((x) => x.id === a.id);
  assert.equal(nw.balance_native, 10_000_000 - 100_000 + 5_000_000);
  assert.equal(nw.balance, Math.round(14_900_000 * THB));
});

test('AUD accounts read exactly as they did: summary and net worth for a book with no manual account are unchanged by the migration', () => {
  const b = base();
  const s = summary(b.db);
  assert.equal(s.net_worth.net_worth, netWorth(b.db).net_worth);
  for (const a of netWorth(b.db).accounts) {
    assert.equal(a.currency, 'AUD');
    assert.equal(a.manual, false);
  }
});
