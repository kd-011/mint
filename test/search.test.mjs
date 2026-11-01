// Global search: what a term matches across transactions, categories, accounts
// and budgets, and how a typed amount reads. Invented book.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { payBook, setCat } from './fixtures/pay.mjs';
import { amountRange, searchAll } from '../lib/search.mjs';
import { setBudget } from '../lib/budgets.mjs';

test('a typed amount reads as the cents it covers', () => {
  assert.deepEqual(amountRange('42'), [4200, 4299]);
  assert.deepEqual(amountRange('$42.50'), [4250, 4250]);
  assert.deepEqual(amountRange('42.5'), [4250, 4250]);
  assert.deepEqual(amountRange('1,200'), [120000, 120099]);
  assert.deepEqual(amountRange(' $ 7.05 '), [705, 705]);
  for (const t of ['', 'abc', '4a', '42.555', '-42', '1,20', '99999999999']) assert.equal(amountRange(t), null, t);
});

test('transactions match on description, merchant and amount, newest first', () => {
  const b = book();
  b.add('acct_t_everyday', '2026-10-10', -4250, 'TEST NOODLE BAR');
  b.add('acct_t_everyday', '2026-10-12', -4299, 'TEST HARDWARE');
  b.add('acct_t_everyday', '2026-10-13', -4300, 'TEST GROCER');
  b.add('acct_t_card', '2026-10-14', -1000, 'TEST NOODLE BAR');
  b.db.prepare("UPDATE transactions SET merchant_override = 'Ramen House' WHERE description = 'TEST NOODLE BAR' AND amount = -1000").run();
  const dates = (q) => searchAll(b.db, q).tx_ids.map((id) => b.row(id).date);
  assert.deepEqual(dates('noodle'), ['2026-10-14', '2026-10-10']);
  assert.deepEqual(dates('ramen'), ['2026-10-14']);
  assert.deepEqual(dates('42'), ['2026-10-12', '2026-10-10']); // $42.xx, not $43
  assert.deepEqual(dates('$42.50'), ['2026-10-10']);
  assert.equal(searchAll(b.db, 'noodle').tx_total, 2);
  // Percent and underscore are text, not wildcards.
  assert.deepEqual(searchAll(b.db, '%').tx_ids, []);
  assert.deepEqual(searchAll(b.db, 'TEST_G').tx_ids, []);
});

test('the transaction hits are capped but the total is not', () => {
  const b = book();
  for (let i = 1; i <= 12; i++) b.add('acct_t_everyday', `2026-10-${String(i).padStart(2, '0')}`, -100 * i, 'TEST CAFE');
  const r = searchAll(b.db, 'cafe');
  assert.equal(r.tx_ids.length, 8);
  assert.equal(r.tx_total, 12);
});

test('categories, accounts and budgets match by name', () => {
  const b = payBook();
  setBudget(b.db, b.cat('Groceries'), { cycle_target: 30000 });
  const r = searchAll(b.db, 'groc');
  assert.deepEqual(r.categories.map((c) => c.name), ['Groceries']);
  assert.deepEqual(r.budgets.map((x) => [x.name, x.cycle_target]), [['Groceries', 30000]]);
  assert.deepEqual(searchAll(b.db, 'food').categories.map((c) => c.name).sort(), ['Alcohol', 'Eating out', 'Groceries', 'Takeaway and delivery']);
  assert.deepEqual(searchAll(b.db, 'food').budgets.map((x) => x.name), ['Groceries']); // by group too
  const acc = searchAll(b.db, 'beta').accounts.map((a) => a.id);
  assert.deepEqual(acc.sort(), ['acct_t_loan', 'acct_t_offset']); // by institution
  b.db.prepare("UPDATE accounts SET nickname = 'Rainy day' WHERE id = 'acct_t_savings'").run();
  assert.deepEqual(searchAll(b.db, 'rainy').accounts.map((a) => [a.id, a.name]), [['acct_t_savings', 'Rainy day']]);
  b.db.prepare("UPDATE accounts SET status = 'gone' WHERE id = 'acct_t_savings'").run();
  assert.deepEqual(searchAll(b.db, 'rainy').accounts, []);
});

test('an empty or over-long term is a 400', () => {
  const b = book();
  for (const t of ['', '   ', null, 'x'.repeat(101)]) assert.throws(() => searchAll(b.db, t), (e) => e.status === 400, String(t));
});
