// Save and Invest, section two: super. Manual snapshots of a manual asset of
// kind super, change since the last snapshot, an optional contribution logged
// with a snapshot so growth separates from contributions, and the 35 day nudge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { createAsset, addSnapshot, listSnapshots } from '../lib/networth.mjs';
import { superOverview } from '../lib/superfund.mjs';

function superBook() {
  const b = book();
  const s = createAsset(b.db, { name: 'Test Super', kind: 'super' });
  addSnapshot(b.db, s.id, { date: '2026-08-10', value: 4000000 });
  addSnapshot(b.db, s.id, { date: '2026-09-12', value: 4250000, contribution: 100000 });
  addSnapshot(b.db, s.id, { date: '2026-10-15', value: 4504300, contribution: 150000, note: 'statement' });
  createAsset(b.db, { name: 'Test Shares', kind: 'shares' });
  return { b, s };
}

test('super lists only super assets, with the latest balance and total', () => {
  const { b, s } = superBook();
  const o = superOverview(b.db, { today: '2026-10-17' });
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].id, s.id);
  assert.equal(o.items[0].value, 4504300);
  assert.equal(o.items[0].as_of, '2026-10-15');
  assert.equal(o.total, 4504300);
  assert.equal(o.nudge_days, 35);
});

test('change since the last snapshot splits into contribution and growth', () => {
  const { b } = superBook();
  const c = superOverview(b.db, { today: '2026-10-17' }).items[0].change;
  assert.deepEqual(c, { since: '2026-09-12', amount: 254300, pct: 0.0598, contribution: 150000, growth: 104300 });
});

test('with no contribution logged the whole change is growth, and says so', () => {
  const { b, s } = superBook();
  addSnapshot(b.db, s.id, { date: '2026-10-16', value: 4600000 });
  const c = superOverview(b.db, { today: '2026-10-17' }).items[0].change;
  assert.equal(c.amount, 95700);
  assert.equal(c.contribution, null);
  assert.equal(c.growth, 95700);
});

test('history is oldest first and carries each contribution', () => {
  const { b } = superBook();
  const h = superOverview(b.db, { today: '2026-10-17' }).items[0].history;
  assert.deepEqual(h.map((x) => [x.date, x.value, x.contribution]), [['2026-08-10', 4000000, null], ['2026-09-12', 4250000, 100000], ['2026-10-15', 4504300, 150000]]);
});

test('a single snapshot has no change yet', () => {
  const b = book();
  const s = createAsset(b.db, { name: 'New Super', kind: 'super' });
  addSnapshot(b.db, s.id, { date: '2026-10-15', value: 100000 });
  assert.equal(superOverview(b.db, { today: '2026-10-17' }).items[0].change, null);
});

test('the nudge fires after 35 days and not on day 35', () => {
  const { b } = superBook();
  const at = (today) => superOverview(b.db, { today }).items[0];
  assert.equal(at('2026-11-19').due, false);
  assert.equal(at('2026-11-19').days_since, 35);
  assert.equal(at('2026-11-20').due, true);
  assert.equal(at('2026-10-17').days_since, 2);
});

test('an asset with no snapshot yet is due and has no balance', () => {
  const b = book();
  createAsset(b.db, { name: 'Fresh Super', kind: 'super' });
  const i = superOverview(b.db, { today: '2026-10-17' }).items[0];
  assert.equal(i.value, null);
  assert.equal(i.due, true);
  assert.deepEqual(i.history, []);
});

test('archived super is left out', () => {
  const { b, s } = superBook();
  b.db.prepare('UPDATE manual_assets SET archived = 1 WHERE id = ?').run(s.id);
  assert.deepEqual(superOverview(b.db, { today: '2026-10-17' }).items, []);
});

test('snapshots validate the contribution: whole cents, zero or more', () => {
  const { b, s } = superBook();
  assert.throws(() => addSnapshot(b.db, s.id, { date: '2026-10-16', value: 1, contribution: -5 }), /contribution/);
  assert.throws(() => addSnapshot(b.db, s.id, { date: '2026-10-16', value: 1, contribution: 1.5 }), /contribution/);
  addSnapshot(b.db, s.id, { date: '2026-10-16', value: 4600000, contribution: 0 });
  assert.equal(listSnapshots(b.db, s.id)[0].contribution, 0);
});

test('re-saving a snapshot on the same date replaces its contribution too', () => {
  const { b, s } = superBook();
  addSnapshot(b.db, s.id, { date: '2026-10-15', value: 4504300 });
  assert.equal(listSnapshots(b.db, s.id).find((x) => x.date === '2026-10-15').contribution, null);
});
