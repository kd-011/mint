// v2 alerts: budget alerts per pay cycle, the new pace alert (from the cycle
// midpoint, flexible spend projected more than 10% over the flexible budget,
// once per cycle) and the payday alert (in app only, never pushed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, setCat, PAY_ACCOUNT, SALARY } from './fixtures/pay.mjs';
import { runAlerts, weeklySummary } from '../lib/alerts.mjs';
import { setBudget } from '../lib/budgets.mjs';
import { setPlan } from '../lib/plan.mjs';
import { pendingAlerts } from '../lib/assistant.mjs';

const at = (d) => new Date(`${d}T02:00:00Z`);
const kinds = (list) => list.map((a) => `${a.kind}:${a.type}`).sort();
const quiet = (b) => b.db.prepare("UPDATE accounts SET last_synced_at = '2026-11-30T00:00:00.000Z'").run();

function paceBook() {
  const b = payBook();
  quiet(b);
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 20000 });
  setBudget(b.db, b.cat('Eating out'), { cycle_target: 10000 });
  setBudget(b.db, b.cat('Rent'), { cycle_target: 100000, fixed: true });
  setCat(b, b.add('acct_t_card', '2026-10-08', -16000, 'TEST GROCER'), 'Groceries');
  setCat(b, b.add('acct_t_card', '2026-10-09', -4000, 'TEST BISTRO'), 'Eating out');
  refreshMoney(b, '2026-10-14');
  return b;
}

test('pace: from the midpoint, projected flexible spend over 110% of the flexible budget, once per cycle', () => {
  const b = paceBook();
  // Day 4 of 14: too early to call it.
  assert.deepEqual(kinds(runAlerts(b.db, { now: at('2026-10-10') })).filter((k) => k.startsWith('pace')), []);
  // Day 8: 200 spent in 8 days projects 350 against 300 flexible.
  const a = runAlerts(b.db, { now: at('2026-10-14') });
  assert.deepEqual(kinds(a), ['pace:flexible']);
  assert.match(a[0].title, /pace/i);
  assert.match(a[0].body, /\$350\.00/);
  assert.equal(a[0].period, '2026-10-07');
  assert.deepEqual(runAlerts(b.db, { now: at('2026-10-15') }), []);
  // A new cycle can warn again.
  b.add(PAY_ACCOUNT, '2026-10-21', 226000, SALARY, { provider_category: 'INCOME' });
  setCat(b, b.add('acct_t_card', '2026-10-22', -25000, 'TEST GROCER'), 'Groceries');
  refreshMoney(b, '2026-10-29');
  const next = runAlerts(b.db, { now: at('2026-10-29') });
  assert.ok(kinds(next).includes('pace:flexible'));
  assert.ok(pendingAlerts(b.db).some((x) => x.kind === 'pace'));
});

test('budget alerts are per category per pay cycle', () => {
  const b = paceBook();
  setCat(b, b.add('acct_t_card', '2026-10-10', -2500, 'TEST GROCER'), 'Groceries'); // 185 of 200 = 92%
  refreshMoney(b, '2026-10-10');
  const a = runAlerts(b.db, { now: at('2026-10-10') });
  const budget = a.filter((x) => x.kind === 'budget');
  assert.deepEqual(budget.map((x) => [x.type, x.period]), [['90', '2026-10-07']]);
  assert.match(budget[0].body, /this pay cycle/);
  assert.deepEqual(runAlerts(b.db, { now: at('2026-10-11') }).filter((x) => x.kind === 'budget'), []);
  b.add(PAY_ACCOUNT, '2026-10-21', 226000, SALARY, { provider_category: 'INCOME' });
  setCat(b, b.add('acct_t_card', '2026-10-22', -19000, 'TEST GROCER'), 'Groceries');
  refreshMoney(b, '2026-10-22');
  const next = runAlerts(b.db, { now: at('2026-10-22') }).filter((x) => x.kind === 'budget');
  assert.deepEqual(next.map((x) => [x.type, x.period]), [['90', '2026-10-21']]);
});

test('payday: one in-app alert per salary deposit listing the planned split, never queued for push', () => {
  const b = payBook();
  quiet(b);
  refreshMoney(b, '2026-10-08');
  setPlan(b.db, { lines: [{ account_id: 'acct_t_savings', amount: 50000 }, { account_id: 'acct_t_offset', percent: 10 }] });
  const a = runAlerts(b.db, { now: at('2026-10-08') }).filter((x) => x.kind === 'payday');
  assert.equal(a.length, 1);
  assert.match(a[0].title, /\$2,260\.00/);
  assert.match(a[0].body, /Savings Test \$500\.00/);
  assert.match(a[0].body, /Test Offset \$226\.00/);
  assert.equal(a[0].period, '2026-10-07');
  assert.deepEqual(runAlerts(b.db, { now: at('2026-10-09') }).filter((x) => x.kind === 'payday'), []);
  assert.ok(!pendingAlerts(b.db).some((x) => x.kind === 'payday'));
  // Old paydays from history do not each raise one.
  assert.equal(b.db.prepare("SELECT count(*) n FROM alerts WHERE kind = 'payday'").get().n, 1);
});

test('weekly summary leads with the pay cycle once there is one', () => {
  const b = paceBook();
  const line = weeklySummary(b.db, '2026-10-14');
  assert.doesNotMatch(line, /\n/);
  assert.match(line, /pay cycle 07\/10 to 20\/10/i);
  assert.match(line, /safe to spend/i);
  assert.match(line, /21\/10/);
  assert.match(line, /Last week/);
});

test('a starter budget made mid-cycle stays quiet until the next cycle', () => {
  const b = payBook();
  quiet(b);
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 10000 }, { source: 'starter' });
  b.db.prepare("UPDATE budgets SET created_at = '2026-10-14T01:00:00.000Z'").run();
  setCat(b, b.add('acct_t_card', '2026-10-08', -16000, 'TEST GROCER'), 'Groceries');
  refreshMoney(b, '2026-10-14');
  assert.deepEqual(runAlerts(b.db, { now: at('2026-10-14') }).filter((x) => x.kind === 'budget' || x.kind === 'pace'), []);
  b.add(PAY_ACCOUNT, '2026-10-21', 226000, SALARY, { provider_category: 'INCOME' });
  setCat(b, b.add('acct_t_card', '2026-10-22', -9500, 'TEST GROCER'), 'Groceries');
  refreshMoney(b, '2026-10-22');
  assert.deepEqual(runAlerts(b.db, { now: at('2026-10-22') }).filter((x) => x.kind === 'budget').map((x) => x.type), ['90']);
});
