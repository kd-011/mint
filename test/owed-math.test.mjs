// The pure side of Owed to me (public/owed-math.js): grouping people by name,
// working out status, outstanding and overdue, and the tally. The same file
// runs in the page and in the server, so the offline screen and the API agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const m = createRequire(import.meta.url)(join(ROOT, 'public', 'owed-math.js'));
const TODAY = '2026-10-18';
const row = (o) => ({ id: 1, person: 'Liam', amount: 4000, repaid: 0, closed: null, archived: false, lent_on: '2026-10-01', due_on: null, ...o });

test('owedKey groups names case-insensitively, trimmed, with inner spaces collapsed', () => {
  assert.equal(m.owedKey('  Liam '), 'liam');
  assert.equal(m.owedKey('Anna   Lee'), 'anna lee');
  assert.equal(m.owedKey('ANNA LEE'), m.owedKey('anna lee'));
});

test('owedState: open until repaid covers it or it is closed by hand', () => {
  assert.deepEqual(m.owedState(row(), TODAY), { status: 'open', outstanding: 4000, overdue: false, written_off: 0 });
  assert.equal(m.owedState(row({ repaid: 1500 }), TODAY).outstanding, 2500);
  assert.deepEqual(m.owedState(row({ repaid: 4000 }), TODAY), { status: 'settled', outstanding: 0, overdue: false, written_off: 0 });
  assert.deepEqual(m.owedState(row({ repaid: 1000, closed: 'written_off' }), TODAY), { status: 'written_off', outstanding: 0, overdue: false, written_off: 3000 });
  assert.deepEqual(m.owedState(row({ repaid: 1000, closed: 'settled' }), TODAY), { status: 'settled', outstanding: 0, overdue: false, written_off: 0 });
});

test('owedState: overdue only when open and past the due date (the due day itself is not overdue)', () => {
  assert.equal(m.owedState(row({ due_on: '2026-10-17' }), TODAY).overdue, true);
  assert.equal(m.owedState(row({ due_on: '2026-10-18' }), TODAY).overdue, false);
  assert.equal(m.owedState(row({ due_on: '2026-10-17', repaid: 4000 }), TODAY).overdue, false);
  assert.equal(m.owedState(row({ due_on: '2026-10-01', closed: 'written_off' }), TODAY).overdue, false);
});

test('owedTally: per person and grand total, oldest open date, overdue, biggest first', () => {
  const t = m.owedTally([
    row({ id: 1, person: 'Liam', amount: 4000, repaid: 1000, lent_on: '2026-09-18', due_on: '2026-10-10' }),
    row({ id: 2, person: ' liam', amount: 2500, lent_on: '2026-10-15' }),
    row({ id: 3, person: 'Sam', amount: 10000, lent_on: '2026-10-10', due_on: '2026-11-01' }),
    row({ id: 4, person: 'Mia', amount: 1500, repaid: 1500, lent_on: '2026-10-14' }),
    row({ id: 5, person: 'Ned', amount: 900, closed: 'written_off', lent_on: '2026-09-01' }),
  ], TODAY);
  assert.equal(t.total_outstanding, 3000 + 2500 + 10000);
  assert.equal(t.overdue_total, 3000);
  assert.deepEqual(t.people.map((p) => [p.name, p.outstanding]), [['Sam', 10000], ['liam', 5500], ['Mia', 0], ['Ned', 0]]);
  const liam = t.people[1];
  assert.deepEqual([liam.key, liam.open_count, liam.debts, liam.oldest_open, liam.overdue_count, liam.overdue_amount], ['liam', 2, 2, '2026-09-18', 1, 3000]);
  assert.equal(t.people[2].oldest_open, null);
});

test('owedTally leaves archived debts out and is empty-safe', () => {
  assert.deepEqual(m.owedTally([], TODAY), { total_outstanding: 0, total_i_owe: 0, net: 0, overdue_total: 0, people: [] });
  const t = m.owedTally([row({ archived: true, repaid: 4000 }), row({ id: 2, person: 'Sam' })], TODAY);
  assert.deepEqual(t.people.map((p) => p.name), ['Sam']);
});

test('owedNames: every name used, most recent first, one spelling per person', () => {
  assert.deepEqual(m.owedNames([row({ id: 1, person: 'Liam' }), row({ id: 2, person: 'Sam' }), row({ id: 3, person: 'liam' })]), ['liam', 'Sam']);
  assert.deepEqual(m.owedNames([]), []);
});

test('owedWithPayment applies a repayment to a debt row the way the server would, for the offline screen', () => {
  const after = m.owedWithPayment(row({ amount: 4000, repaid: 1000, payments: [] }), { id: -1, date: '2026-10-18', amount: 3000, note: null, transaction_id: null });
  assert.equal(after.repaid, 4000);
  assert.equal(after.payments.length, 1);
  assert.equal(m.owedState(after, TODAY).status, 'settled');
});

test('owedTally keeps what the owner owes apart from what is owed to him, and nets each person', () => {
  const t = m.owedTally([
    row({ id: 1, person: 'Connor', amount: 9000 }),
    row({ id: 2, person: 'connor', amount: 4000, direction: 'i_owe', repaid: 1000 }),
    row({ id: 3, person: 'Trav', amount: 9600, direction: 'i_owe' }),
    row({ id: 4, person: 'Sam', amount: 2000, due_on: '2026-10-01' }),
    row({ id: 5, person: 'Trav', amount: 500, direction: 'i_owe', due_on: '2026-10-01' }),
  ], TODAY);
  const by = Object.fromEntries(t.people.map((p) => [p.key, p]));
  assert.deepEqual([by.connor.outstanding, by.connor.i_owe, by.connor.net, by.connor.open_count, by.connor.owe_open_count], [9000, 3000, 6000, 1, 1]);
  assert.deepEqual([by.trav.outstanding, by.trav.i_owe, by.trav.net], [0, 10100, -10100]);
  assert.deepEqual([t.total_outstanding, t.total_i_owe, t.net], [11000, 13100, -2100]);
  assert.equal(t.overdue_total, 2000, 'overdue counts only money owed to the owner');
  assert.equal(by.trav.overdue_count, 0);
  assert.deepEqual(t.people.map((p) => p.key), ['connor', 'sam', 'trav'], 'biggest net owed to the owner first, what he owes last');
});

test('a debt with no direction reads as owed to the owner', () => {
  assert.equal(m.owedDir(row()), 'owed_to_me');
  assert.equal(m.owedDir(row({ direction: 'i_owe' })), 'i_owe');
  assert.equal(m.owedTally([row()], TODAY).people[0].outstanding, 4000);
});
