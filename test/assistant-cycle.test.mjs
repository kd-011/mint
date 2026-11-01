// v2 step 9: the assistant door reads the pay cycle: current cycle summary,
// income, bills, goals and debt, and the summary carries the cycle headline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, setCat } from './fixtures/pay.mjs';
import { cycleSummary, summary } from '../lib/assistant.mjs';
import { setBudget } from '../lib/budgets.mjs';
import { setPlan } from '../lib/plan.mjs';

const TODAY = '2026-10-12';

function book() {
  const b = payBook();
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 20000 });
  setCat(b, b.add('acct_t_card', '2026-10-08', -19000, 'TEST GROCER'), 'Groceries');
  refreshMoney(b, TODAY);
  setPlan(b.db, { lines: [{ account_id: 'acct_t_savings', amount: 50000 }] });
  return b;
}

test('cycle summary: dates, income, safe to spend, budgets, bills, split, next payday', () => {
  const b = book();
  const c = cycleSummary(b.db, TODAY);
  assert.equal(c.as_of, TODAY);
  assert.deepEqual([c.cycle.start, c.cycle.end, c.cycle.day, c.cycle.days, c.cycle.days_left], ['2026-10-07', '2026-10-20', 6, 14, 9]);
  assert.deepEqual(c.next_payday, { date: '2026-10-21', expected_amount: 225500, late: false, days_late: 0 });
  assert.equal(c.income.received, 226000);
  assert.equal(c.income.expected, 226000);
  assert.equal(c.safe_to_spend.amount, 226000 - 50000 - 19000);
  assert.equal(c.safe_to_spend.per_day, Math.floor((226000 - 50000 - 19000) / 9));
  assert.deepEqual(c.budgets.near, ['Groceries']);
  assert.ok(Array.isArray(c.bills_due));
  assert.deepEqual(c.split.lines.map((l) => [l.account, l.status]), [['Savings Test', 'not_yet']]);
  assert.match(c.note, /cents/i);
});

test('summary carries the cycle headline', () => {
  const b = book();
  const s = summary(b.db, TODAY);
  assert.deepEqual([s.cycle.start, s.cycle.end, s.cycle.next_payday], ['2026-10-07', '2026-10-20', '2026-10-21']);
  assert.equal(s.cycle.safe_to_spend, 226000 - 50000 - 19000);
  assert.ok('per_day' in s.cycle && 'income_received' in s.cycle && 'income_expected' in s.cycle);
  assert.ok(s.month, 'month block kept');
});

test('no cycle yet: the summary says so plainly', () => {
  const b = payBook({ paydays: [] });
  refreshMoney(b, TODAY);
  assert.equal(summary(b.db, TODAY).cycle, null);
  assert.equal(cycleSummary(b.db, TODAY).cycle, null);
});
