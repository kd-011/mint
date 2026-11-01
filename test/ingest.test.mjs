import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createClient } from '../lib/redbark.mjs';
import { createIngest } from '../lib/ingest.mjs';
import { fakeRedbark, FAKE_KEY, addDays } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';

const NOW = new Date('2026-10-17T02:00:00Z'); // 10:00 in Perth

function setup(transactions = {}, fakeOpts = {}) {
  const fake = fakeRedbark({ ...fx, accounts: [...fx.accounts], transactions, ...fakeOpts });
  const client = createClient({ key: FAKE_KEY, base: fake.state.base, fetchImpl: fake.fetch, sleep: async () => {} });
  const db = openDb(':memory:');
  const ingest = createIngest({ db, client, now: () => NOW, log: () => {} });
  return { fake, db, ingest };
}
const txCalls = (fake, account) => fake.calls.filter((c) => c.path === '/transactions' && c.query.account === account && !c.query.page);

test('syncMeta stores connections with consent expiry and the accounts', async () => {
  const { db, ingest } = setup();
  await ingest.syncMeta();
  const conns = db.prepare('SELECT * FROM connections ORDER BY id').all();
  assert.equal(conns.length, 2);
  assert.equal(conns.find((c) => c.id === 'conn_test_beta').consent_expires_at, '2026-10-27T00:00:00.000Z');
  const accts = db.prepare('SELECT * FROM accounts').all();
  assert.equal(accts.length, 4);
  const card = accts.find((a) => a.id === 'acct_test_card');
  assert.equal(card.type, 'credit-card');
  assert.equal(card.institution, 'Alpha Bank');
  assert.equal(card.number_masked, 'xxxx2222');
  assert.equal(card.currency, 'AUD');
});

test('personal/business flag survives a re-sync; accounts named Business default to business', async () => {
  const { db, ingest, fake } = setup();
  await ingest.syncMeta();
  db.prepare("UPDATE accounts SET is_business = 1 WHERE id = 'acct_test_offset'").run();
  fake.state.transactions = {};
  const extra = { ...fx.accounts[0], id: 'acct_test_biz', name: 'Business 9999' };
  fx.accounts.push(extra);
  try {
    const f2 = setup();
    await f2.ingest.syncMeta();
    assert.equal(f2.db.prepare("SELECT is_business FROM accounts WHERE id='acct_test_biz'").get().is_business, 1);
    assert.equal(f2.db.prepare("SELECT is_business FROM accounts WHERE id='acct_test_everyday'").get().is_business, 0);
  } finally { fx.accounts.pop(); }
  await ingest.syncMeta();
  assert.equal(db.prepare("SELECT is_business FROM accounts WHERE id='acct_test_offset'").get().is_business, 1);
});

test('backfill walks from seven years back and records the earliest date held', async () => {
  const rows = fx.history('acct_test_everyday', '2023-06-01', '2026-10-16', 2);
  const { db, ingest, fake } = setup({ acct_test_everyday: rows }, { ceiling: 300 });
  await ingest.syncMeta();
  const r = await ingest.backfillAccount('acct_test_everyday');
  assert.equal(r.count, rows.length);
  assert.equal(txCalls(fake, 'acct_test_everyday')[0].query.from, '2019-10-24');
  assert.equal(db.prepare("SELECT count(*) n FROM transactions WHERE account_id='acct_test_everyday'").get().n, rows.length);
  const a = db.prepare("SELECT * FROM accounts WHERE id='acct_test_everyday'").get();
  assert.equal(a.earliest_date, '2023-06-01');
  assert.ok(a.backfill_done_at);
  assert.ok(a.last_synced_at);
});

test('upserts are idempotent and never clobber user fields', async () => {
  const rows = fx.history('acct_test_everyday', '2026-08-01', '2026-10-16', 2);
  const { db, ingest } = setup({ acct_test_everyday: rows });
  await ingest.syncMeta();
  await ingest.backfillAccount('acct_test_everyday');
  const id = rows[3].id;
  db.prepare("UPDATE transactions SET note = 'mine', is_business = 1 WHERE id = ?").run(id);
  const again = await ingest.syncAccount('acct_test_everyday', { from: '2026-08-01' });
  assert.equal(again.inserted, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM transactions').get().n, rows.length);
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  assert.equal(t.note, 'mine');
  assert.equal(t.is_business, 1);
  assert.equal(t.amount, rows[3].amount.amount);
  assert.equal(t.currency, 'AUD');
});

test('provider changes to an existing row are applied', async () => {
  const rows = [fx.tx('acct_test_everyday', '2026-10-10', -1000, 'TEST SHOP', { id: 'txn_change' })];
  const { db, ingest, fake } = setup({ acct_test_everyday: rows });
  await ingest.syncMeta();
  await ingest.syncAccount('acct_test_everyday', { from: '2026-10-01' });
  fake.state.transactions.acct_test_everyday = [{ ...rows[0], description: 'TEST SHOP RENAMED', amount: { amount: -1200, currency: 'aud' } }];
  const r = await ingest.syncAccount('acct_test_everyday', { from: '2026-10-01' });
  assert.equal(r.updated, 1);
  const t = db.prepare("SELECT * FROM transactions WHERE id='txn_change'").get();
  assert.equal(t.amount, -1200);
  assert.equal(t.description, 'TEST SHOP RENAMED');
});

test('pending rows that settle under a new id are replaced and keep what the owner set', async () => {
  const pending = fx.tx('acct_test_everyday', '2026-10-15', -4550, 'AUTHORISATION ONLY - TEST GROCER', { id: 'txn_pend_1', status: 'pending' });
  const other = fx.tx('acct_test_everyday', '2026-10-14', -900, 'TEST BAKERY', { id: 'txn_other' });
  const { db, ingest, fake } = setup({ acct_test_everyday: [pending, other] });
  await ingest.syncMeta();
  await ingest.syncAccount('acct_test_everyday', { from: '2026-10-01' });
  assert.equal(db.prepare("SELECT status FROM transactions WHERE id='txn_pend_1'").get().status, 'pending');
  db.prepare("UPDATE transactions SET note = 'groceries for camp', is_business = 1 WHERE id = 'txn_pend_1'").run();
  const posted = fx.tx('acct_test_everyday', '2026-10-16', -4550, 'TEST GROCER', { id: 'txn_post_1' });
  fake.state.transactions.acct_test_everyday = [posted, other];
  const r = await ingest.syncAccount('acct_test_everyday', { from: '2026-10-01' });
  assert.equal(r.removed, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM transactions WHERE id='txn_pend_1'").get().n, 0);
  const t = db.prepare("SELECT * FROM transactions WHERE id='txn_post_1'").get();
  assert.equal(t.status, 'posted');
  assert.equal(t.note, 'groceries for camp');
  assert.equal(t.is_business, 1);
});

test('pending rows outside the fetched window are left alone', async () => {
  const pending = fx.tx('acct_test_everyday', '2026-09-01', -100, 'OLD PENDING', { id: 'txn_old_pend', status: 'pending' });
  const { db, ingest, fake } = setup({ acct_test_everyday: [pending] });
  await ingest.syncMeta();
  await ingest.syncAccount('acct_test_everyday', { from: '2026-08-20' });
  fake.state.transactions.acct_test_everyday = [];
  await ingest.syncAccount('acct_test_everyday', { from: '2026-10-01' });
  assert.equal(db.prepare("SELECT count(*) n FROM transactions WHERE id='txn_old_pend'").get().n, 1);
});

test('balances update the account and write one snapshot per day', async () => {
  const { db, ingest } = setup();
  await ingest.syncMeta();
  await ingest.syncBalances();
  await ingest.syncBalances();
  const card = db.prepare("SELECT * FROM accounts WHERE id='acct_test_card'").get();
  assert.equal(card.balance_current, -50000);
  assert.equal(card.balance_available, 950000);
  assert.equal(card.balance_freshness, 'fresh');
  const snaps = db.prepare("SELECT * FROM balance_snapshots WHERE account_id='acct_test_card'").all();
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].date, '2026-10-17');
});

test('daily snapshot stores loan details alongside the balance', async () => {
  const { db, ingest } = setup();
  await ingest.syncMeta();
  await ingest.snapshotDaily();
  const s = db.prepare("SELECT * FROM balance_snapshots WHERE account_id='acct_test_loan'").get();
  assert.equal(s.current, -40000000);
  assert.equal(JSON.parse(s.details_json).lending_rate, '0.0599');
  assert.equal(JSON.parse(db.prepare("SELECT details_json FROM accounts WHERE id='acct_test_loan'").get().details_json).loan_details.offset_account_enabled, true);
});

test('poll backfills new accounts, then only fetches a short recent window', async () => {
  const { ingest, fake } = setup({ acct_test_everyday: fx.history('acct_test_everyday', '2025-01-01', '2026-10-16', 4) });
  await ingest.poll();
  assert.equal(txCalls(fake, 'acct_test_everyday')[0].query.from, '2019-10-24');
  fake.calls.length = 0;
  await ingest.poll();
  const calls = txCalls(fake, 'acct_test_everyday');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].query.from >= addDays(fx.TODAY, -21));
  assert.equal(calls[0].query.include_pending, 'true');
});

test('one unavailable account does not stop the others and its error is kept', async () => {
  const { db, ingest } = setup({ acct_test_everyday: [fx.tx('acct_test_everyday', '2026-10-10', -100, 'TEST')] }, { unavailable: ['acct_test_card'] });
  const r = await ingest.poll();
  assert.ok(r.errors >= 1);
  const card = db.prepare("SELECT * FROM accounts WHERE id='acct_test_card'").get();
  assert.match(card.last_sync_error, /account_unavailable/);
  assert.equal(db.prepare("SELECT count(*) n FROM transactions WHERE account_id='acct_test_everyday'").get().n, 1);
  assert.equal(db.prepare("SELECT last_sync_error FROM accounts WHERE id='acct_test_everyday'").get().last_sync_error, null);
  assert.ok(db.prepare("SELECT count(*) n FROM sync_log WHERE kind='poll'").get().n >= 1);
});

test('health exposes consent expiry in days and flags it inside 30 days', async () => {
  const { ingest } = setup();
  await ingest.syncMeta();
  const h = ingest.health();
  const beta = h.connections.find((c) => c.id === 'conn_test_beta');
  assert.equal(beta.consent_days, 10);
  assert.equal(beta.consent_warning, true);
  assert.equal(h.connections.find((c) => c.id === 'conn_test_alpha').consent_warning, false);
});

test('only one sync runs at a time and progress is reported', async () => {
  const { ingest } = setup({ acct_test_everyday: fx.history('acct_test_everyday', '2026-01-01', '2026-10-16', 2) });
  const a = ingest.runSync('poll');
  const b = ingest.runSync('poll');
  assert.equal((await b).already, true);
  assert.equal(ingest.state().running, true);
  await a;
  const s = ingest.state();
  assert.equal(s.running, false);
  assert.ok(s.finishedAt);
  assert.equal(s.lastError, null);
});

test('reconcile re-walks a long recent window for every account', async () => {
  const { ingest, fake } = setup({ acct_test_everyday: [] });
  await ingest.poll();
  fake.calls.length = 0;
  await ingest.reconcile();
  const calls = txCalls(fake, 'acct_test_everyday');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].query.from <= addDays(fx.TODAY, -90));
});

test('rows with a non-date date or non-string fields are skipped or coerced, never fatal', async () => {
  const good = fx.tx('acct_test_everyday', '2026-10-10', -100, 'OK ROW', { id: 'txn_ok' });
  const badDate = { ...fx.tx('acct_test_everyday', '2026-10-10', -100, 'BAD', { id: 'txn_bad' }), date: '2026-10-05T' };
  const oddDesc = { ...fx.tx('acct_test_everyday', '2026-10-09', -100, 'X', { id: 'txn_odd' }), description: { nested: true } };
  const { db, ingest, fake } = setup({ acct_test_everyday: [good, oddDesc] });
  fake.state.transactions.acct_test_everyday.push(badDate);
  await ingest.syncMeta();
  await ingest.syncAccount('acct_test_everyday', { from: '2026-10-01' }).catch(() => {});
  const ids = db.prepare('SELECT id, description FROM transactions ORDER BY id').all();
  assert.deepEqual(ids.map((r) => r.id).sort(), ['txn_odd', 'txn_ok']);
  assert.equal(typeof ids.find((r) => r.id === 'txn_odd').description, 'string');
});

test('a repayment linked to a pending deposit follows it when the deposit posts under a new id', async () => {
  const pending = fx.tx('acct_test_everyday', '2026-10-15', 3000, 'TRANSFER FROM TEST FRIEND', { id: 'txn_pend_in', status: 'pending' });
  const { db, ingest, fake } = setup({ acct_test_everyday: [pending] });
  await ingest.syncMeta();
  await ingest.syncAccount('acct_test_everyday', { from: '2026-10-01' });
  const at = '2026-10-16T00:00:00.000Z';
  const { lastInsertRowid: id } = db.prepare("INSERT INTO owed (person, amount, lent_on, created_at, updated_at) VALUES ('Test Friend', 3000, '2026-10-01', ?, ?)").run(at, at);
  db.prepare("INSERT INTO owed_payments (owed_id, date, amount, transaction_id, created_at) VALUES (?, '2026-10-15', 3000, 'txn_pend_in', ?)").run(id, at);
  fake.state.transactions.acct_test_everyday = [fx.tx('acct_test_everyday', '2026-10-16', 3000, 'TRANSFER FROM TEST FRIEND', { id: 'txn_post_in' })];
  const r = await ingest.syncAccount('acct_test_everyday', { from: '2026-10-01' });
  assert.equal(r.removed, 1);
  assert.equal(db.prepare('SELECT transaction_id FROM owed_payments').get().transaction_id, 'txn_post_in');
});
