// v2 step 3: pay cycles. A cycle runs from a salary deposit to the day before
// the next; the open one ends the day before the predicted payday, stretches
// when pay is late, and flags it from two days late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, PAY_ACCOUNT, SALARY } from './fixtures/pay.mjs';
import { listCycles, currentCycle, cycleAt } from '../lib/cycles.mjs';

test('cycles from history: start on payday, end the day before the next', () => {
  const b = payBook();
  refreshMoney(b);
  const list = listCycles(b.db, { today: '2026-10-17' });
  assert.equal(list.length, 7);
  assert.deepEqual(
    { start: list[0].start, end: list[0].end, days: list[0].days, open: list[0].open, payday: list[0].payday },
    { start: '2026-07-15', end: '2026-07-28', days: 14, open: false, payday: { date: '2026-07-15', amount: 249000 } },
  );
  const cur = currentCycle(b.db, { today: '2026-10-17' });
  assert.equal(cur.start, '2026-10-07');
  assert.equal(cur.end, '2026-10-20');
  assert.equal(cur.open, true);
  assert.equal(cur.next_payday, '2026-10-21');
  assert.equal(cur.day, 11);
  assert.equal(cur.days_left, 4);
  assert.equal(cur.late, false);
  assert.equal(cycleAt(b.db, '2026-09-15', { today: '2026-10-17' }).start, '2026-09-09');
  assert.equal(cycleAt(b.db, '2026-09-22', { today: '2026-10-17' }).end, '2026-09-22');
  assert.equal(cycleAt(b.db, '2026-07-01', { today: '2026-10-17' }), null);
});

test('a late pay stretches the open cycle and is flagged after two days', () => {
  const b = payBook();
  refreshMoney(b);
  const oneDay = currentCycle(b.db, { today: '2026-10-22' });
  assert.equal(oneDay.start, '2026-10-07');
  assert.equal(oneDay.end, '2026-10-22');
  assert.equal(oneDay.late, false);
  assert.equal(oneDay.days_late, 1);
  const three = currentCycle(b.db, { today: '2026-10-24' });
  assert.equal(three.end, '2026-10-24');
  assert.equal(three.late, true);
  assert.equal(three.days_late, 3);
  // Then it lands: the old cycle closes the day before, a new one opens.
  b.add(PAY_ACCOUNT, '2026-10-25', 226500, SALARY, { provider_category: 'INCOME' });
  refreshMoney(b, '2026-10-25');
  const list = listCycles(b.db, { today: '2026-10-25' });
  const closed = list.at(-2);
  assert.deepEqual([closed.start, closed.end, closed.days, closed.late, closed.days_late], ['2026-10-07', '2026-10-24', 18, true, 4]);
  const now = list.at(-1);
  assert.deepEqual([now.start, now.end, now.next_payday, now.open], ['2026-10-25', '2026-11-07', '2026-11-08', true]);
});

test('an early pay shortens the cycle, a top-up within three days is the same payday, a missed one is one long cycle', () => {
  const b = payBook({ paydays: ['2026-08-12', '2026-08-26', '2026-09-07', '2026-10-05'], amounts: [250000] });
  b.add(PAY_ACCOUNT, '2026-09-08', 15000, SALARY, { provider_category: 'INCOME' }); // back pay the next day
  refreshMoney(b);
  const list = listCycles(b.db, { today: '2026-10-10' });
  assert.deepEqual(list.map((c) => [c.start, c.days]), [['2026-08-12', 14], ['2026-08-26', 12], ['2026-09-07', 28], ['2026-10-05', 14]]);
  assert.equal(list[2].payday.amount, 265000);
  assert.equal(list[2].late, true); // the 21/09 pay never came
});

test('no salary yet: no cycles', () => {
  const b = payBook({ paydays: [] });
  refreshMoney(b);
  assert.deepEqual(listCycles(b.db, { today: '2026-10-17' }), []);
  assert.equal(currentCycle(b.db, { today: '2026-10-17' }), null);
});
