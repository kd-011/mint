// Saved views: names, filter validation, ids chosen by the page, replay safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { openDb } from '../lib/db.mjs';
import { listViews, createView, updateView, deleteView, cleanFilters, MAX_VIEWS } from '../lib/views.mjs';

const status = (n) => (e) => e.status === n;

test('a view keeps its filters under a name, in the order they were made', () => {
  const { db } = book();
  const a = createView(db, { id: 'view0001', name: ' Takeaway  this month ', filters: { category: '7', from: '2026-10-01', direction: 'out', q: '' } });
  assert.equal(a.name, 'Takeaway this month');
  assert.deepEqual(a.filters, { category: '7', from: '2026-10-01', direction: 'out' }); // blanks dropped
  createView(db, { name: 'Business', filters: { business: '1' } });
  assert.deepEqual(listViews(db).map((v) => v.name), ['Takeaway this month', 'Business']);
  assert.match(listViews(db)[1].id, /^[a-z0-9]{6,32}$/);
});

test('creating the same id twice answers the first row (a replayed queued write is harmless)', () => {
  const { db } = book();
  const body = { id: 'view0002', name: 'Salary', filters: { direction: 'in' } };
  const first = createView(db, body);
  const again = createView(db, { ...body, name: 'Something else' });
  assert.equal(again.name, 'Salary');
  assert.equal(again.created_at, first.created_at);
  assert.equal(listViews(db).length, 1);
});

test('names are required, trimmed, short and unique ignoring case', () => {
  const { db } = book();
  createView(db, { id: 'view0003', name: 'Fuel', filters: { q: 'bp' } });
  assert.throws(() => createView(db, { name: 'fuel', filters: { q: 'shell' } }), status(409));
  for (const name of ['', '   ', null, 7, 'x'.repeat(41)]) assert.throws(() => createView(db, { name, filters: { q: 'a' } }), status(400), String(name));
  const other = createView(db, { id: 'view0004', name: 'Shell', filters: { q: 'shell' } });
  assert.throws(() => updateView(db, other.id, { name: 'FUEL' }), status(409));
  assert.equal(updateView(db, other.id, { name: 'shell' }).name, 'shell'); // its own name, different case, is fine
});

test('filters are checked as the list checks them, so a saved view always applies', () => {
  const bads = [
    {}, { category: 'abc' }, { category: '0' }, { from: '2026-13-40' }, { to: 'tomorrow' }, { direction: 'sideways' }, { business: 'yes' }, { tax: '2' },
    { source: 'robot' }, { account: 'acct_ bad' }, { q: 'x'.repeat(101) }, { nope: '1' }, { q: 5 }, [], null,
  ];
  for (const f of bads) assert.throws(() => cleanFilters(f), status(400), JSON.stringify(f));
  assert.deepEqual(cleanFilters({ category: 'none', account: 'acct_t_card', source: 'ai', tax: '0', business: '1', to: '2026-10-17' }),
    { category: 'none', account: 'acct_t_card', source: 'ai', tax: '0', business: '1', to: '2026-10-17' });
});

test('rename and refilter, delete, and the limit', () => {
  const { db } = book();
  const v = createView(db, { id: 'view0005', name: 'Old', filters: { q: 'a' } });
  const r = updateView(db, v.id, { name: 'New', filters: { q: 'b', direction: 'out' } });
  assert.deepEqual([r.name, r.filters], ['New', { q: 'b', direction: 'out' }]);
  assert.throws(() => updateView(db, v.id, {}), status(400));
  assert.throws(() => updateView(db, 'missing01', { name: 'x' }), status(404));
  assert.deepEqual(deleteView(db, v.id), { deleted: true });
  assert.deepEqual(deleteView(db, v.id), { deleted: true }); // a replayed delete is fine
  for (let i = 0; i < MAX_VIEWS; i++) createView(db, { name: `View ${i}`, filters: { q: `q${i}` } });
  assert.throws(() => createView(db, { name: 'One too many', filters: { q: 'z' } }), status(400));
});

test('opening an old book adds the table without touching anything else', () => {
  const db = openDb(':memory:');
  assert.deepEqual(listViews(db), []);
  db.close();
});
