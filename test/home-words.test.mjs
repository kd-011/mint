// Plain-English Home: the sentence builders for the pay-cycle
// card, the over-budget bar scaling, and the account balances grouping. All pure,
// in public/ux-model.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UxModel: M } = require('../public/ux-model.js');

const m0 = (c) => `$${Math.round(c / 100).toLocaleString('en-US')}`;
const m = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso) => ({ '2026-10-20': 'Tue 20 Oct', '2026-10-21': 'Wed 21 Oct', '2026-10-19': 'Mon 19 Oct' }[iso] ?? iso);
const fmt = { money: m, money0: m0, day, today: '2026-10-19' };

// ---------- the pay-cycle card ----------

const cyc = { open: true, day: 13, days: 14, days_left: 1 };

test('cycle summary reads as a sentence', () => {
  const s = M.cycleSummary({ spent: 176699, target: 252000, cycle: cyc }, fmt);
  assert.equal(s.line, '$1,767 of $2,520 spent, $753 left, 1 day to go');
  assert.equal(s.pace, '$577 less than an even daily spend');
  assert.equal(s.tone, '');
  assert.equal(s.status, 'under');
  assert.equal(s.below, 57661);
  assert.equal(M.cycleSummary({ spent: 100000, target: 252000, cycle: { ...cyc, day: 4, days_left: 10 } }, fmt).line, '$1,000 of $2,520 spent, $1,520 left, 10 days to go');
});

test('cycle summary: over budget, ahead of an even spend, and a closed cycle', () => {
  const over = M.cycleSummary({ spent: 260000, target: 252000, cycle: cyc }, fmt);
  assert.equal(over.line, '$2,600 of $2,520 spent, $80 over budget, 1 day to go');
  assert.equal(over.tone, 'bad');
  assert.equal(over.pace, '');
  const ahead = M.cycleSummary({ spent: 200000, target: 252000, cycle: { ...cyc, day: 4, days_left: 10 } }, fmt);
  assert.match(ahead.pace, /more than an even daily spend$/);
  const closed = M.cycleSummary({ spent: 200000, target: 252000, cycle: { ...cyc, open: false, days_left: 0 } }, fmt);
  assert.equal(closed.line, '$2,000 of $2,520 spent, $520 left');
});

const item = (id, name, spent, available) => ({ category_id: id, name, spent, available, pct: Math.round((spent / available) * 100), fixed: 0 });

test('category rows: over budget rows are named, sized by how far over, and the pace tick is dropped', () => {
  const r = M.categoryRows([
    item(1, 'Eating out', 22500, 10000), item(2, 'Fuel', 18600, 10000), item(3, 'Groceries', 14900, 10000), item(4, 'Fun', 14100, 10000),
    item(5, 'Coffee', 2000, 10000),
  ], { money0: m0 });
  assert.equal(r.heading, 'Over budget');
  assert.deepEqual(r.rows.map((x) => x.name), ['Eating out', 'Fuel', 'Groceries', 'Fun']);
  assert.ok(r.rows.every((x) => x.over && x.tick === false));
  assert.equal(r.rows[0].label, '$125 over');
  assert.equal(r.rows[3].label, '$41 over');
  // The track is scaled to the worst row (225%), so 225% and 141% no longer look the same.
  assert.equal(r.rows[0].markAt, 44);
  assert.equal(r.rows[0].overW, 56);
  assert.ok(r.rows[3].overW < r.rows[0].overW && r.rows[3].overW > 0);
  assert.ok(r.rows.every((x) => x.markAt === 44));
  assert.ok(r.rows.every((x) => x.markAt + x.overW <= 100));
});

test('category rows: nothing over lists the closest to budget as spent of budget', () => {
  const r = M.categoryRows([item(1, 'A', 5000, 10000), item(2, 'B', 9000, 10000), item(3, 'C', 100, 10000)], { money0: m0 });
  assert.equal(r.heading, 'Closest to budget');
  assert.deepEqual(r.rows.map((x) => x.name), ['B', 'A', 'C']);
  assert.equal(r.rows[0].label, '$90 of $100');
  assert.ok(r.rows.every((x) => !x.over && x.tick === true));
});

test('category rows: more over than shown, a zero budget and empties', () => {
  const many = Array.from({ length: 6 }, (_, i) => item(i, `C${i}`, 20000 - i * 100, 10000));
  const r = M.categoryRows(many, { money0: m0 });
  assert.equal(r.rows.length, 4);
  assert.equal(r.more, 2);
  assert.deepEqual(M.categoryRows([], { money0: m0 }).rows, []);
  const z = M.categoryRows([item(1, 'Z', 500, 0)], { money0: m0 });
  assert.equal(z.rows[0].over, true);
});

// ---------- balance tiles ----------

test('balance tiles: the totals under net worth, in order, zero ones left out, each with a link', () => {
  const t = M.balanceTiles({ cash: 3400000, cards: -50000, loans: -40000000, investments: 900000, other_assets: 0, other_liabilities: -20000 });
  assert.deepEqual(t.map((x) => [x.label, x.value, x.href]), [
    ['Cash', 3400000, '/accounts'], ['Cards', -50000, '/accounts'], ['Loans', -40000000, '/plan?s=debt'],
    ['Investments', 900000, '/save'], ['Debts', -20000, '/accounts?s=assets'],
  ]);
  assert.ok(!M.balanceTiles({ other_assets: 5 }).length, 'there is no Other assets tile any more');
  assert.deepEqual(M.balanceTiles({ cash: 0, investments: 5 }).map((x) => x.id), ['investments']);
  assert.deepEqual(M.balanceTiles({}), []);
  assert.deepEqual(M.balanceTiles(), []);
});

test('category rows: the "more over budget" count is over budget rows only', () => {
  const none = M.categoryRows(Array.from({ length: 7 }, (_, i) => item(i, `N${i}`, 1000 + i, 10000)), { money0: m0 });
  assert.equal(none.overCount, 0);
  assert.equal(none.rows.length, 4);
  assert.equal(none.more, 0, 'nothing is over budget, so no row');
  const three = M.categoryRows([item(1, 'A', 30000, 10000), item(2, 'B', 25000, 10000), item(3, 'C', 15000, 10000), item(4, 'Fine', 1000, 10000), item(5, 'Fine2', 2000, 10000)], { money0: m0, max: 2 });
  assert.deepEqual(three.rows.map((r) => r.name), ['A', 'B']);
  assert.equal(three.more, 1, 'one over budget row left off, the two under budget ones do not count');
});
