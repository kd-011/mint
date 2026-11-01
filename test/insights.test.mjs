// What changed this pay cycle: top category movers against the same days of the
// last cycle, and merchants seen for the first time. Invented book, today fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, setCat, transfer } from './fixtures/pay.mjs';
import { book } from './fixtures/book.mjs';
import { cycleInsights } from '../lib/insights.mjs';

const TODAY = '2026-10-17'; // day 11 of the cycle that began 2026-10-07; the last one ran 2026-09-23 to 2026-10-06

function seeded() {
  const b = payBook();
  const spend = (date, amount, desc, cat) => setCat(b, b.add('acct_t_everyday', date, -amount, desc), cat);
  // Groceries: $200 in the same days last cycle, $450 so far this one.
  spend('2026-09-25', 20000, 'TEST GROCER', 'Groceries');
  spend('2026-10-09', 30000, 'TEST GROCER', 'Groceries');
  spend('2026-10-14', 15000, 'TEST GROCER', 'Groceries');
  // Eating out: $120 then $30, so it fell.
  spend('2026-09-28', 12000, 'TEST NOODLE BAR', 'Eating out');
  spend('2026-10-10', 3000, 'TEST NOODLE BAR', 'Eating out');
  // Fuel only this cycle, so it has no percent.
  spend('2026-10-12', 9000, 'TEST SERVO', 'Fuel');
  // Spend after the like-for-like cut-off last cycle must not count against this one.
  spend('2026-10-05', 99900, 'TEST FURNITURE', 'Shopping');
  // A tiny move is noise.
  spend('2026-10-11', 500, 'TEST KIOSK', 'Eating out');
  refreshMoney(b, TODAY);
  return b;
}

test('movers compare the open cycle with the same days of the one before, biggest first', () => {
  const b = seeded();
  const r = cycleInsights(b.db, { today: TODAY });
  assert.equal(r.available, true);
  assert.deepEqual(r.cycle, { start: '2026-10-07', to: TODAY, days: 11 });
  assert.deepEqual(r.compared_with, { start: '2026-09-23', to: '2026-10-03' });
  assert.deepEqual(r.movers.map((m) => m.name), ['Groceries', 'Fuel', 'Eating out']);
  const [groc, fuel, eat] = r.movers;
  assert.deepEqual([groc.now, groc.before, groc.change, groc.percent], [45000, 20000, 25000, 125]);
  assert.deepEqual([fuel.now, fuel.before, fuel.change, fuel.percent], [9000, 0, 9000, null]);
  assert.deepEqual([eat.now, eat.before, eat.change, eat.percent], [3500, 12000, -8500, -71]);
  assert.equal(groc.category_id, b.cat('Groceries'));
  assert.ok(!r.movers.some((m) => m.name === 'Shopping'), 'last cycle spend after the cut-off is out of the comparison');
  assert.equal(r.totals.now, 45000 + 9000 + 3500);
});

test('linked transfers and business spend are not spend', () => {
  const b = seeded();
  transfer(b, 'acct_t_everyday', 'acct_t_savings', '2026-10-13', 500000);
  b.add('acct_t_biz', '2026-10-13', -70000, 'TEST SUPPLIER', { provider_category: 'MERCHANDISE' });
  refreshMoney(b, TODAY);
  const r = cycleInsights(b.db, { today: TODAY });
  assert.equal(r.totals.now, 45000 + 9000 + 3500);
});

test('new merchants are those first charged inside the cycle', () => {
  const b = seeded();
  const r = cycleInsights(b.db, { today: TODAY });
  const names = r.new_merchants.items.map((m) => m.merchant);
  // Grocer and noodle bar were charged last cycle; servo and the kiosk are first seen now.
  assert.ok(names.some((n) => /servo/i.test(n)) && names.some((n) => /kiosk/i.test(n)), names.join(','));
  assert.ok(!names.some((n) => /grocer|noodle/i.test(n)));
  assert.equal(r.new_merchants.count, r.new_merchants.items.length);
  assert.equal(r.new_merchants.total, r.new_merchants.items.reduce((s, m) => s + m.spent, 0));
  assert.deepEqual(r.new_merchants.items.map((m) => m.spent), [...r.new_merchants.items.map((m) => m.spent)].sort((a, c) => c - a));
});

test('a book too young to know what is new says nothing about new merchants', () => {
  const b = payBook({ paydays: ['2026-09-23', '2026-10-07'] });
  setCat(b, b.add('acct_t_everyday', '2026-10-12', -9000, 'TEST SERVO'), 'Fuel');
  setCat(b, b.add('acct_t_everyday', '2026-09-26', -4000, 'TEST SERVO'), 'Fuel');
  refreshMoney(b, TODAY);
  const r = cycleInsights(b.db, { today: TODAY });
  assert.equal(r.available, true);
  assert.equal(r.new_merchants, null);
});

test('unavailable before there are two pay cycles, with the reason', () => {
  const none = cycleInsights(book().db, { today: TODAY });
  assert.deepEqual([none.available, none.movers], [false, []]);
  assert.match(none.reason, /first pay cycle/);
  const one = payBook({ paydays: ['2026-10-07'] });
  refreshMoney(one, TODAY);
  const r = cycleInsights(one.db, { today: TODAY });
  assert.equal(r.available, false);
  assert.match(r.reason, /one finished pay cycle/);
});
