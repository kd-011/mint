// v2 screens: the small pure helpers the cockpit leans on (labels, pace,
// pay split totals), kept out of the DOM so they can be tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const m = createRequire(import.meta.url)(join(ROOT, 'public', 'cycle-math.js'));

test('cycleLabel reads like Wed 8 Oct to Tue 21 Oct, with the year only when it differs', () => {
  assert.equal(m.cycleLabel({ start: '2026-10-07', end: '2026-10-20' }), 'Wed 7 Oct to Tue 20 Oct');
  assert.equal(m.cycleLabel({ start: '2026-12-23', end: '2027-01-05' }), 'Wed 23 Dec to Tue 5 Jan 2027');
});

test('paceMarker is how far through the cycle today is, as a percent', () => {
  assert.equal(m.paceMarker({ open: true, day: 11, days: 14 }), 79);
  assert.equal(m.paceMarker({ open: true, day: 1, days: 14 }), 7);
  assert.equal(m.paceMarker({ open: false, day: 14, days: 14 }), 100);
  assert.equal(m.paceMarker({ open: true, day: 20, days: 14 }), 100, 'a late payday does not run past the end');
});

test('paceStatus compares spend against the marker', () => {
  const cyc = { open: true, day: 7, days: 14 }; // marker 50
  assert.equal(m.paceStatus({ spent: 20000, target: 100000, cycle: cyc }), 'under');
  assert.equal(m.paceStatus({ spent: 52000, target: 100000, cycle: cyc }), 'on');
  assert.equal(m.paceStatus({ spent: 70000, target: 100000, cycle: cyc }), 'ahead');
  assert.equal(m.paceStatus({ spent: 130000, target: 100000, cycle: cyc }), 'over');
  assert.equal(m.paceStatus({ spent: 0, target: 0, cycle: cyc }), 'none');
});

test('splitTotals: amounts and percents against the pay, what is left, and whether it overspends', () => {
  const pay = 225000;
  const t = m.splitTotals([{ amount: 175000 }, { amount: 50000 }], pay);
  assert.deepEqual(t, { planned: 225000, left: 0, over: false, percent: 100 });
  const o = m.splitTotals([{ amount: 175000 }, { percent: 30 }], pay);
  assert.equal(o.planned, 175000 + 67500);
  assert.equal(o.over, true);
  assert.equal(o.left, 225000 - 242500);
});

test('toPercent and fromPercent round the way the server does', () => {
  assert.equal(m.fromPercent(30, 225416), Math.round(225416 * 0.3));
  assert.equal(m.toPercent(67625, 225416), 30);
  assert.equal(m.toPercent(1, 0), 0);
});

test('weekday day labels for the bills calendar', () => {
  assert.equal(m.shortDay('2026-10-21'), 'Wed 21 Oct');
});

test('savingsRate is the share of income kept over the cycles given', () => {
  assert.equal(m.savingsRate([{ income: 400000, spent: 300000 }, { income: 400000, spent: 380000 }]), 15);
  assert.equal(m.savingsRate([{ income: 100000, spent: 130000 }]), -30);
  assert.equal(m.savingsRate([]), null);
});

test('a paid instalment is grouped where it was paid, not where it fell due', () => {
  const cycle = { start: '2026-10-07', end: '2026-10-20' };
  const items = [
    { date: '2026-10-19', status: 'due', merchant: 'A' },
    { date: '2026-10-29', status: 'paid', paid_on: '2026-10-12', merchant: 'Loan' },
    { date: '2026-11-05', status: 'due', merchant: 'B' },
  ];
  const g = m.groupByCycle(items, cycle);
  assert.deepEqual(g[0].items.map((i) => i.merchant), ['Loan', 'A'].sort((a, b) => items.findIndex((i) => i.merchant === a) - items.findIndex((i) => i.merchant === b)));
  assert.equal(g[0].current, true);
  assert.equal(g[1].start, '2026-10-21');
  assert.deepEqual(g[1].items.map((i) => i.merchant), []);
  assert.deepEqual(g[2].items.map((i) => i.merchant), ['B']);
});

test('loanPaidRows: the paid instalment with its date and amount, the bank figure beside the repayment', () => {
  const fmt = (c) => `$${(c / 100).toFixed(2)}`;
  const paid = m.loanPaidRows({
    repayment: { amount: 188216, last_paid: { date: '2026-10-14', amount: 188216 }, scheduled: { amount: 188638, basis: 'last_interest_charge' } },
    instalment: { due_date: '2026-10-29', status: 'paid', paid_on: '2026-10-14', amount: 188216 },
  }, fmt);
  assert.deepEqual(paid, [
    { label: 'Instalment 29 Oct', value: 'Paid 14 Oct, $1882.16', tone: 'pos' },
    { label: 'Interest last charged', value: '$1886.38', tone: '' },
  ]);
  const due = m.loanPaidRows({
    repayment: { amount: 250000, last_paid: { date: '2026-09-29', amount: 250000 }, scheduled: { amount: 250000, basis: 'bank' } },
    instalment: { due_date: '2026-10-29', status: 'due', paid_on: null, amount: 250000 },
  }, fmt);
  assert.deepEqual(due.map((r) => r.value), ['Not paid yet, $2500.00', '$2500.00, 29 Sep']);
  assert.deepEqual(m.loanPaidRows({ repayment: {}, instalment: null }, fmt), []);
});

test('asSentence capitalises a server reason and ends it', () => {
  assert.equal(m.asSentence('interest only: the balance does not fall at this repayment'), 'Interest only: the balance does not fall at this repayment.');
  assert.equal(m.asSentence('Already one.'), 'Already one.');
  assert.equal(m.asSentence(null), '');
});

test('the budget editor gets the per-cycle target, also from the monthly roll-up', () => {
  const month = { target: 65000, cycle_target: 30000, monthly_target: undefined, carried: 0, spent: 10000, available: 65000 };
  assert.equal(m.budgetForEditor(month, 'month').target, 30000);
  const cycle = { target: 30000, monthly_target: 65000, carried: 0 };
  assert.equal(m.budgetForEditor(cycle, 'cycle').target, 30000);
  assert.equal(m.budgetForEditor(null, 'month'), null);
  // Saving the shown figure unchanged sends the same cycle target.
  assert.equal(m.budgetForEditor(month, 'month').target, month.cycle_target);
});

test('an offline edit reads back in the units of the view it was made in', () => {
  const month = { target: 65000, cycle_target: 30000, carried: 0, spent: 10000, available: 65000, rollover: false, fixed: false };
  const after = m.budgetAfterEdit(month, 'month', { cycle_target: 40000, fixed: true, rollover: false });
  assert.equal(after.cycle_target, 40000);
  assert.equal(after.target, 86667); // 40000 x 26 / 12, the roll-up's monthly figure
  assert.equal(after.available, 86667);
  const cyc = m.budgetAfterEdit({ target: 30000, carried: 5000, spent: 10000 }, 'cycle', { cycle_target: 40000, fixed: false, rollover: true });
  assert.deepEqual([cyc.target, cyc.available, cyc.remaining], [40000, 45000, 35000]);
});

test('zeroAfterEdit moves ready to assign the other way from the target, to zero when the pay is all assigned', () => {
  const z = { income: 226000, set_aside: 30000, assigned: 150000, carried_overspend: { total: 0, items: [] }, ready: 46000, state: 'unassigned' };
  assert.deepEqual(m.zeroAfterEdit(z, 10000, 56000).ready, 0);
  assert.equal(m.zeroAfterEdit(z, 10000, 56000).state, 'zero');
  assert.equal(m.zeroAfterEdit(z, null, 50000).state, 'over_assigned');
  assert.equal(m.zeroAfterEdit(z, 10000, null).ready, 56000); // a deleted budget frees its money
  assert.equal(m.zeroAfterEdit(null, 1, 2), null);
});
