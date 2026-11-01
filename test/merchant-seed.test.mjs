// Seed rules for common AU merchants. The category seed runs once per book,
// so these arrive as a versioned migration: idempotent, below the owner's own
// rules, never overwriting them, and never re-made once deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { createEngine } from '../lib/engine.mjs';
import { seedMerchantRules } from '../lib/categories.mjs';
import { createRule } from '../lib/categorise.mjs';

const NOW = () => new Date('2026-10-17T02:00:00Z');
const catOf = (b, id) => b.db.prepare('SELECT c.name FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?').get(id)?.name ?? null;
const refresh = (b) => createEngine({ db: b.db, now: NOW, log: () => {} }).refresh();
const spend = (b, description, extra = {}) => b.add('acct_t_everyday', '2026-10-10', extra.amount ?? -5000, description, { provider_category: extra.pc ?? 'TRANSPORTATION' });

test('fuel brands land in Fuel, which sits under the Transport group', () => {
  const b = book();
  const brands = ['BP SPEARWOOD', 'SHELL REDDY EXPRESS BEELIAR', 'REDDY EXPRESS KEWDALE', 'AMPOL FOODARY COCKBURN', 'CALTEX BYFORD', '7-ELEVEN COCKBURN CENTRAL',
    'UNITED PETROLEUM SOUTH LAKE', 'PUMA ENERGY COMO', 'LIBERTY OIL OCONNOR', 'VIBE PETROLEUM MORLEY', 'EG GROUP SOUTH LAKE', 'SHELL COLES EXPRESS TESTVILLE'];
  const ids = brands.map((d) => spend(b, d));
  refresh(b);
  ids.forEach((id, i) => assert.equal(catOf(b, id), 'Fuel', brands[i]));
  assert.equal(b.db.prepare("SELECT grp FROM categories WHERE name = 'Fuel'").get().grp, 'Transport');
});

test('look-alikes are left alone', () => {
  const b = book();
  const keep = ['BPAY TESTER', 'SHELLEY BEACH CAFE', 'PUMA SPORTS CARNIVAL', 'LIBERTY FINANCIAL', 'UNITED AIRLINES', 'OPTUS STADIUM'];
  const ids = keep.map((d) => spend(b, d, { pc: 'MERCHANDISE' }));
  refresh(b);
  ids.forEach((id, i) => assert.equal(catOf(b, id), 'Shopping', keep[i]));
});

test('supermarkets file under Groceries, and a Coles Express petrol stop is not groceries', () => {
  const b = book();
  const shop = ['WOOLWORTHS BULL CREEK', 'COLES COCKBURN GATEWAY', 'IGA YANGEBUP', 'ATWELL FRESH IGA'].map((d) => spend(b, d, { pc: 'FOOD_AND_DRINK' }));
  const express = spend(b, 'COLES EXPRESS TESTVILLE', { pc: 'FOOD_AND_DRINK' });
  refresh(b);
  for (const id of shop) assert.equal(catOf(b, id), 'Groceries');
  assert.notEqual(catOf(b, express), 'Groceries');
});

test('telcos file under Phone and internet', () => {
  const b = book();
  const ids = ['TELSTRA SERVICES MELBOURNE', 'EXETEL PTY LTD NORTH SYDN'].map((d) => spend(b, d, { pc: 'RENT_AND_UTILITIES' }));
  refresh(b);
  for (const id of ids) assert.equal(catOf(b, id), 'Phone and internet');
});

test('Uber rides are rideshare, Uber Eats stays food', () => {
  const b = book();
  const ride = spend(b, 'EFTPOS 15/03 21:11PAYPAL *UBER AU Sydney');
  const eats = spend(b, 'UBER *EATS HELP.UBER.C   Sydney       AU', { pc: 'FOOD_AND_DRINK' });
  const eats2 = spend(b, 'EFTPOS 11/06 14:34PAYPAL *UBEREATS AU Sydney', { pc: 'FOOD_AND_DRINK' });
  refresh(b);
  assert.equal(catOf(b, ride), 'Rideshare and taxis');
  assert.equal(catOf(b, eats), 'Eating out');
  assert.equal(catOf(b, eats2), 'Eating out');
});

test('only money out is filed: a credit from a person with the brand in the memo is not', () => {
  const b = book();
  const credit = b.add('acct_t_everyday', '2026-10-10', 6000, 'ONLINE X1 BUNNINGS WOOLWORTHS BP', { provider_category: 'TRANSFER_IN' });
  refresh(b);
  assert.equal(catOf(b, credit), 'Transfers');
});

test('seed rules sit below the owner\'s own rules and never overwrite them', () => {
  const b = book();
  const mine = createRule(b.db, { field: 'merchant', match: 'starts', pattern: 'Woolworths Bull', category_id: b.cat('Shopping') }).rule;
  const id = spend(b, 'WOOLWORTHS BULL CREEK', { pc: 'FOOD_AND_DRINK' });
  const picked = spend(b, 'BP SPEARWOOD');
  b.db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(b.cat('Car maintenance'), picked);
  refresh(b);
  assert.equal(catOf(b, id), 'Shopping');
  assert.equal(catOf(b, picked), 'Car maintenance');
  const seeded = b.db.prepare("SELECT priority, source FROM rules WHERE source = 'seed' AND pattern LIKE '%oolworths%'").get();
  assert.equal(seeded.source, 'seed');
  assert.ok(seeded.priority > mine.priority, 'seed priority number is above (after) a manual rule');
});

test('a seed rule is skipped when the owner already has a rule with the same pattern', () => {
  const b = book();
  createRule(b.db, { field: 'merchant', match: 'starts', pattern: 'Telstra', category_id: b.cat('Utilities') });
  const id = spend(b, 'TELSTRA SERVICES MELBOURNE', { pc: 'RENT_AND_UTILITIES' });
  refresh(b);
  assert.equal(catOf(b, id), 'Utilities');
  assert.equal(b.db.prepare("SELECT count(*) n FROM rules WHERE source = 'seed' AND lower(pattern) = 'telstra'").get().n, 0);
});

test('migration is idempotent and a deleted seed rule stays deleted', () => {
  const b = book();
  const first = seedMerchantRules(b.db);
  assert.ok(first > 10, `made ${first} rules`);
  assert.equal(seedMerchantRules(b.db), 0);
  refresh(b);
  refresh(b);
  const n = b.db.prepare("SELECT count(*) n FROM rules WHERE source = 'seed'").get().n;
  const bp = b.db.prepare("SELECT id FROM rules WHERE source = 'seed' AND pattern LIKE '%bp%' AND category_id = ?").get(b.cat('Fuel'));
  assert.ok(bp);
  b.db.prepare('DELETE FROM rules WHERE id = ?').run(bp.id);
  refresh(b);
  assert.equal(b.db.prepare("SELECT count(*) n FROM rules WHERE source = 'seed'").get().n, n - 1);
});

test('Fuel is created under Transport when missing', () => {
  const b = book();
  b.db.prepare("DELETE FROM categories WHERE name = 'Fuel'").run();
  seedMerchantRules(b.db);
  assert.deepEqual({ ...b.db.prepare("SELECT grp, kind FROM categories WHERE name = 'Fuel'").get() }, { grp: 'Transport', kind: 'expense' });
});
