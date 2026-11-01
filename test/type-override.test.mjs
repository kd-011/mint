// The owner's override of an account's type: a bank that reports the wrong one (savings arriving as a credit card)
// is corrected in one place, the sync leaves the correction alone, and clearing it hands the bank's type back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createClient } from '../lib/redbark.mjs';
import { createIngest } from '../lib/ingest.mjs';
import { updateAccount, accountView } from '../lib/accounts.mjs';
import { netWorth } from '../lib/networth.mjs';
import { fakeRedbark, FAKE_KEY } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';

const CARD = 'acct_test_card';
const NOW = new Date('2026-10-17T02:00:00Z');

function setup() {
  const accounts = fx.accounts.map((a) => ({ ...a })); // copies, so a test can change what the bank says
  const fake = fakeRedbark({ ...fx, accounts, transactions: {} });
  const client = createClient({ key: FAKE_KEY, base: fake.state.base, fetchImpl: fake.fetch, sleep: async () => {} });
  const db = openDb(':memory:');
  const ingest = createIngest({ db, client, now: () => NOW, log: () => {} });
  return { fake, db, ingest, accounts };
}
const row = (db, id = CARD) => db.prepare('SELECT type, type_override, feed_type FROM accounts WHERE id = ?').get(id);

test('a sync does not clobber an override, and keeps the bank type on the side', async () => {
  const { db, ingest } = setup();
  await ingest.syncMeta();
  assert.deepEqual({ ...row(db) }, { type: 'credit-card', type_override: null, feed_type: 'credit-card' });
  updateAccount(db, CARD, { type_override: 'savings' });
  assert.deepEqual({ ...row(db) }, { type: 'savings', type_override: 'savings', feed_type: 'credit-card' });
  await ingest.syncMeta();
  await ingest.syncMeta();
  assert.deepEqual({ ...row(db) }, { type: 'savings', type_override: 'savings', feed_type: 'credit-card' });
  // a name change from the bank still lands; only the type is pinned
  assert.equal(accountView(db.prepare('SELECT * FROM accounts WHERE id = ?').get(CARD)).type, 'savings');
});

test('clearing the override hands the bank type back at once, and later syncs follow the bank again', async () => {
  const { db, ingest, accounts } = setup();
  await ingest.syncMeta();
  updateAccount(db, CARD, { type_override: 'savings' });
  updateAccount(db, CARD, { type_override: null });
  assert.deepEqual({ ...row(db) }, { type: 'credit-card', type_override: null, feed_type: 'credit-card' });
  accounts.find((a) => a.id === CARD).type = 'savings';
  await ingest.syncMeta();
  assert.equal(row(db).type, 'savings');
});

test('the bank changing its type while an override is set is remembered, not applied', async () => {
  const { db, ingest, accounts } = setup();
  await ingest.syncMeta();
  updateAccount(db, CARD, { type_override: 'transaction' });
  accounts.find((a) => a.id === CARD).type = 'savings';
  await ingest.syncMeta();
  assert.deepEqual({ ...row(db) }, { type: 'transaction', type_override: 'transaction', feed_type: 'savings' });
  updateAccount(db, CARD, { type_override: null });
  assert.equal(row(db).type, 'savings');
});

test('only the four account types, or null, are accepted; manual accounts are refused', async () => {
  const { db, ingest } = setup();
  await ingest.syncMeta();
  assert.throws(() => updateAccount(db, CARD, { type_override: 'other' }), /type_override must be one of/);
  assert.throws(() => updateAccount(db, CARD, { type_override: 7 }), /type_override must be one of/);
  assert.throws(() => updateAccount(db, 'acct_nope', { type_override: 'loan' }), /no such account/);
  db.prepare("UPDATE accounts SET manual = 1 WHERE id = ?").run(CARD);
  assert.throws(() => updateAccount(db, CARD, { type_override: 'loan' }), /manual account/);
  assert.equal(row(db).type_override, null);
});

test('an overridden card counts as cash on Home, not as a card', async () => {
  const { db, ingest } = setup();
  await ingest.syncMeta();
  db.prepare('UPDATE accounts SET balance_current = 250000 WHERE id = ?').run(CARD);
  const before = netWorth(db).accounts.find((a) => a.id === CARD);
  assert.equal(before.group, 'cards');
  updateAccount(db, CARD, { type_override: 'savings' });
  const after = netWorth(db).accounts.find((a) => a.id === CARD);
  assert.equal(after.group, 'cash');
});
