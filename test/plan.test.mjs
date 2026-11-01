// v2 step 7: the pay split and goals. The suggested split comes from what was
// moved out of the pay account in the three days after each of the last four
// paydays; after each payday the split is checked against the transfers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, transfer, PAY_ACCOUNT } from './fixtures/pay.mjs';
import { suggestPlan, setPlan, getPlan, splitStatus, seedPlan } from '../lib/plan.mjs';
import { listGoals, createGoal, updateGoal, addContribution, seedGoals } from '../lib/goals.mjs';

function splitBook() {
  const b = payBook();
  for (const d of ['2026-08-27', '2026-09-10', '2026-09-24', '2026-10-08']) transfer(b, PAY_ACCOUNT, 'acct_t_savings', d, 50000);
  transfer(b, PAY_ACCOUNT, 'acct_t_offset', '2026-09-24', 30000);
  transfer(b, PAY_ACCOUNT, 'acct_t_card', '2026-09-25', 20000);
  transfer(b, PAY_ACCOUNT, 'acct_t_savings', '2026-09-15', 12345); // six days after payday: not part of the split
  transfer(b, PAY_ACCOUNT, 'acct_t_offset', '2026-10-11', 10000); // after the three-day window, still this cycle
  transfer(b, PAY_ACCOUNT, 'acct_t_biz', '2026-10-11', 5000);
  refreshMoney(b, '2026-10-12');
  return b;
}

test('suggested split from the last four paydays', () => {
  const b = splitBook();
  const s = suggestPlan(b.db, { today: '2026-10-12' });
  assert.equal(s.pay_account.id, PAY_ACCOUNT);
  assert.deepEqual(s.paydays, ['2026-08-26', '2026-09-09', '2026-09-23', '2026-10-07']);
  const by = Object.fromEntries(s.lines.map((l) => [l.account_id, l]));
  assert.deepEqual([by.acct_t_savings.amount, by.acct_t_savings.kind, by.acct_t_savings.seen], [50000, 'saving', 4]);
  assert.deepEqual([by.acct_t_offset.amount, by.acct_t_offset.kind], [30000, 'saving']);
  assert.deepEqual([by.acct_t_card.amount, by.acct_t_card.kind], [20000, 'debt']);
  assert.equal(Object.keys(by).length, 3);
  // Seeding saves it once, marked suggested.
  seedPlan(b.db, { today: '2026-10-12' });
  seedPlan(b.db, { today: '2026-10-12' });
  const plan = getPlan(b.db, { today: '2026-10-12' });
  assert.equal(plan.lines.length, 3);
  assert.ok(plan.lines.every((l) => l.source === 'suggested'));
});

test('split status after payday: done, partial, not yet, and moves outside the plan', () => {
  const b = splitBook();
  setPlan(b.db, { lines: [
    { account_id: 'acct_t_savings', amount: 50000 },
    { account_id: 'acct_t_offset', percent: 10 },
    { account_id: 'acct_t_card', kind: 'debt', amount: 20000 },
  ] });
  const st = splitStatus(b.db, { today: '2026-10-12' });
  assert.equal(st.payday.date, '2026-10-07');
  assert.equal(st.payday.amount, 226000);
  const by = Object.fromEntries(st.lines.map((l) => [l.account_id, l]));
  assert.deepEqual([by.acct_t_savings.planned, by.acct_t_savings.moved, by.acct_t_savings.status], [50000, 50000, 'done']);
  assert.deepEqual([by.acct_t_offset.planned, by.acct_t_offset.moved, by.acct_t_offset.status], [22600, 10000, 'partial']);
  assert.deepEqual([by.acct_t_card.planned, by.acct_t_card.moved, by.acct_t_card.status], [20000, 0, 'not_yet']);
  assert.deepEqual(st.other_moves.map((m) => [m.account_id, m.amount]), [['acct_t_biz', 5000]]);
  assert.equal(st.status, 'partial');
  assert.ok(Array.isArray(st.history) && st.history.length >= 1);
});

test('plan validation', () => {
  const b = splitBook();
  const bad = (lines) => assert.throws(() => setPlan(b.db, { lines }), (e) => e.status === 400);
  bad([{ account_id: 'acct_nope', amount: 100 }]);
  bad([{ account_id: PAY_ACCOUNT, amount: 100 }]);
  bad([{ account_id: 'acct_t_savings', amount: 100, percent: 5 }]);
  bad([{ account_id: 'acct_t_savings', percent: 120 }]);
  bad([{ account_id: 'acct_t_savings', amount: -1 }]);
  bad([{ account_id: 'acct_t_savings', amount: 100, kind: 'yacht' }]);
  setPlan(b.db, { lines: [] });
  assert.equal(getPlan(b.db, { today: '2026-10-12' }).lines.length, 0);
});

test('goals: emergency fund seeded from its account, dated goals need a per-cycle contribution', () => {
  const b = splitBook();
  b.db.prepare("UPDATE accounts SET name = 'Emergency Test' WHERE id = 'acct_t_savings'").run();
  seedGoals(b.db);
  seedGoals(b.db);
  const [ef] = listGoals(b.db, { today: '2026-10-17' });
  assert.equal(ef.name, 'Emergency Fund');
  assert.equal(ef.account_id, 'acct_t_savings');
  assert.equal(ef.target_amount, null);
  assert.equal(ef.progress, 500000);
  assert.equal(ef.per_cycle_needed, null);
  const trip = createGoal(b.db, { name: 'Test trip', target_amount: 600000, target_date: '2027-01-27' });
  addContribution(b.db, trip.id, { date: '2026-10-10', amount: 100000 });
  const t = listGoals(b.db, { today: '2026-10-17' }).find((g) => g.id === trip.id);
  assert.equal(t.progress, 100000);
  assert.equal(t.remaining, 500000);
  assert.equal(t.cycles_left, 8); // 102 days
  assert.equal(t.per_cycle_needed, 62500);
  assert.equal(t.pct, 17);
  updateGoal(b.db, ef.id, { target_amount: 1500000 });
  assert.equal(listGoals(b.db, { today: '2026-10-17' }).find((g) => g.id === ef.id).remaining, 1000000);
  assert.throws(() => createGoal(b.db, { name: '' }), (e) => e.status === 400);
  assert.throws(() => createGoal(b.db, { name: 'x', target_date: '2027-02-30' }), (e) => e.status === 400);
  assert.throws(() => addContribution(b.db, 999, { amount: 1 }), (e) => e.status === 404);
});
