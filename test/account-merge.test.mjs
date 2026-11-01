import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createClient } from '../lib/redbark.mjs';
import { createIngest } from '../lib/ingest.mjs';
import { findDuplicates, mergeDuplicateAccounts, undoMerge } from '../lib/accountmerge.mjs';
import { FROM, COUNTS, KIND } from '../lib/spend.mjs';
import { matchTransfers } from '../lib/transfers.mjs';
import { monthlyReport, reviewCounts } from '../lib/reports.mjs';
import { fakeRedbark, FAKE_KEY } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';

// A clock the test can move, so a row first seen later sorts as the newer one.
function setup(transactions = {}, fakeOpts = {}) {
  const accounts = [...fx.accounts];
  const connections = [...fx.connections];
  const fake = fakeRedbark({ ...fx, accounts, connections, transactions, ...fakeOpts });
  const client = createClient({ key: FAKE_KEY, base: fake.state.base, fetchImpl: fake.fetch, sleep: async () => {} });
  const db = openDb(':memory:');
  const clock = { at: new Date('2026-10-17T02:00:00Z') };
  const logs = [];
  const ingest = createIngest({ db, client, now: () => clock.at, log: (m) => logs.push(m) });
  const later = () => { clock.at = new Date(clock.at.getTime() + 3600_000); };
  return { fake, db, ingest, accounts, connections, later, logs };
}
const txCalls = (fake, account) => fake.calls.filter((c) => c.path === '/transactions' && c.query.account === account && !c.query.page);
const accountRows = (db) => db.prepare("SELECT * FROM accounts WHERE manual = 0 ORDER BY id").all();
const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;

// The same real account as acct_test_everyday, as a second connection would list it: new ids, a new name.
function relink(s, { rename = 'Everyday Renamed' } = {}) {
  s.connections.push({ ...fx.connections[0], id: 'conn_test_alpha2', consent: { ...fx.connections[0].consent, id: 'cons_alpha2' } });
  const old = s.accounts.find((a) => a.id === 'acct_test_everyday');
  s.accounts.push({ ...old, id: 'acct_test_everyday2', connection: 'conn_test_alpha2', name: rename });
}

test('a new account appearing at the bank is added and backfilled on the next sync', async () => {
  const s = setup({});
  await s.ingest.poll();
  assert.equal(accountRows(s.db).length, 4);
  s.later();
  s.accounts.push({ ...s.accounts[0], id: 'acct_test_newsaver', name: 'Fresh Saver', type: 'savings', account_number: 'xxxx7777' });
  s.fake.state.transactions.acct_test_newsaver = [fx.tx('acct_test_newsaver', '2026-10-01', 5000, 'TEST INTEREST')];
  s.fake.calls.length = 0;
  const r = await s.ingest.poll();
  assert.equal(r.errors, 0);
  const rows = accountRows(s.db);
  assert.equal(rows.length, 5);
  const added = rows.find((a) => a.id === 'acct_test_newsaver');
  assert.equal(added.name, 'Fresh Saver');
  assert.equal(added.sort, Math.max(...rows.map((a) => a.sort)), 'goes to the end of the owner\'s order');
  assert.ok(added.backfill_done_at, 'walked back to the oldest date the bank allows');
  assert.equal(txCalls(s.fake, 'acct_test_newsaver')[0].query.from, '2019-10-24');
  assert.equal(count(s.db, "SELECT count(*) n FROM transactions WHERE account_id = 'acct_test_newsaver'"), 1);
});

test('a webhook-scoped sync still adds a new account the payload does not name', async () => {
  const s = setup({});
  await s.ingest.poll();
  s.accounts.push({ ...s.accounts[0], id: 'acct_test_other', name: 'Other', account_number: 'xxxx8888' });
  await s.ingest.poll({ accounts: ['acct_test_everyday'] });
  assert.ok(s.db.prepare("SELECT 1 FROM accounts WHERE id = 'acct_test_other'").get());
});

test('one account the bank describes badly does not stop the others being added', async () => {
  const s = setup({});
  s.accounts.push({ ...s.accounts[0], id: 'acct_test_nameless', name: null, type: null, account_number: 'xxxx0001' });
  s.accounts.push({ ...s.accounts[0], id: 'acct_test_fine', name: 'Fine', account_number: 'xxxx0002' });
  await s.ingest.syncMeta();
  assert.equal(s.db.prepare("SELECT name FROM accounts WHERE id = 'acct_test_fine'").get().name, 'Fine');
  assert.equal(s.db.prepare("SELECT name, type FROM accounts WHERE id = 'acct_test_nameless'").get().name, 'Unnamed account');
});

test('a renamed account updates its row in place: no second row, history and settings kept', async () => {
  const s = setup({ acct_test_everyday: [fx.tx('acct_test_everyday', '2026-10-10', -100, 'TEST CAFE')] });
  await s.ingest.poll();
  s.db.prepare("UPDATE accounts SET nickname = 'Daily', hidden = 0, sort = 7 WHERE id = 'acct_test_everyday'").run();
  s.later();
  s.accounts.find((a) => a.id === 'acct_test_everyday').name = 'Everyday Renamed';
  await s.ingest.poll();
  const rows = accountRows(s.db);
  assert.equal(rows.length, 4);
  const a = rows.find((x) => x.id === 'acct_test_everyday');
  assert.equal(a.name, 'Everyday Renamed');
  assert.equal(a.nickname, 'Daily');
  assert.equal(a.sort, 7);
  assert.equal(count(s.db, "SELECT count(*) n FROM transactions WHERE account_id = 'acct_test_everyday'"), 1);
  assert.equal(count(s.db, 'SELECT count(*) n FROM account_merges'), 0);
});

test('a re-linked account (new id, new name) is reported by the sync and folded in only when applied', async () => {
  const hist = fx.history('acct_test_everyday', '2026-08-01', '2026-10-10', 5);
  const s = setup({ acct_test_everyday: hist });
  await s.ingest.poll();
  s.db.prepare("UPDATE accounts SET nickname = 'Daily', is_business = 1, sort = 1 WHERE id = 'acct_test_everyday'").run();
  s.db.prepare("INSERT INTO rules (field, match, pattern, account_id, category_id, priority, created_at) VALUES ('description', 'contains', 'CAFE', 'acct_test_everyday', NULL, 5, 'x')").run();
  s.db.prepare("INSERT INTO balance_snapshots (account_id, date, current) VALUES ('acct_test_everyday', '2026-09-01', 111)").run();
  const before = count(s.db, "SELECT count(*) n FROM transactions WHERE account_id = 'acct_test_everyday'");
  assert.ok(before > 5);

  // The new link brings only the newer half of the history, under different transaction ids.
  s.later();
  relink(s);
  s.fake.state.transactions.acct_test_everyday2 = hist.slice(-6).map((t) => fx.tx('acct_test_everyday2', t.date, t.amount.amount, t.description));
  await s.ingest.poll();

  // The sync reports the pair and changes nothing.
  assert.equal(count(s.db, 'SELECT count(*) n FROM account_merges'), 0);
  assert.ok(s.logs.some((l) => /second Redbark id/.test(l)));
  assert.equal(count(s.db, "SELECT count(*) n FROM transactions WHERE account_id = 'acct_test_everyday'"), before);
  assert.equal(mergeDuplicateAccounts(s.db, { dryRun: true }).merges.length, 1);
  mergeDuplicateAccounts(s.db);

  const live = accountRows(s.db).filter((a) => a.status !== 'gone');
  assert.equal(live.filter((a) => a.number_masked === 'xxxx1111').length, 1, 'one live row for the real account');
  const keep = live.find((a) => a.number_masked === 'xxxx1111');
  assert.equal(keep.id, 'acct_test_everyday2');
  assert.equal(keep.name, 'Everyday Renamed');
  assert.equal(keep.nickname, 'Daily');
  assert.equal(keep.is_business, 1);
  assert.equal(keep.sort, 1);
  const old = s.db.prepare("SELECT * FROM accounts WHERE id = 'acct_test_everyday'").get();
  assert.equal(old.status, 'gone');
  assert.equal(old.merged_into, 'acct_test_everyday2');
  // Nothing was deleted: every old entry moved, or stayed on the retired row as a duplicate of one the survivor holds.
  const m = JSON.parse(s.db.prepare('SELECT summary FROM account_merges').get().summary);
  assert.equal(m.moved + m.duplicates_left, before);
  assert.equal(m.duplicates_left, 6);
  assert.equal(count(s.db, "SELECT count(*) n FROM transactions WHERE account_id = 'acct_test_everyday'"), 6);
  assert.equal(count(s.db, 'SELECT count(*) n FROM transactions'), before + 6);
  assert.equal(s.db.prepare("SELECT account_id FROM rules").get().account_id, 'acct_test_everyday2');
  assert.equal(s.db.prepare("SELECT account_id FROM balance_snapshots WHERE date = '2026-09-01'").get().account_id, 'acct_test_everyday2');

  // Idempotent, and the retired id is never walked again.
  s.later();
  s.fake.calls.length = 0;
  await s.ingest.poll();
  assert.equal(count(s.db, 'SELECT count(*) n FROM account_merges'), 1);
  assert.equal(txCalls(s.fake, 'acct_test_everyday').length, 0);
  assert.equal(s.db.prepare("SELECT status FROM accounts WHERE id = 'acct_test_everyday'").get().status, 'gone');
  assert.equal(findDuplicates(s.db).pairs.length, 0);
});

test('a duplicate entry is never deleted: it stays on the retired row, out of the totals, and undo restores the pair', async () => {
  const s = setup({});
  await s.ingest.syncMeta();
  relink(s);
  s.later();
  await s.ingest.syncMeta();
  const ins = s.db.prepare(`INSERT INTO transactions (id, account_id, status, date, description, amount, currency, merchant, first_seen_at, updated_at)
    VALUES (?, ?, 'posted', '2026-10-01', 'TEST CAFE', -450, 'AUD', 'cafe', 'x', 'x')`);
  ins.run('t_old', 'acct_test_everyday');
  ins.run('t_new', 'acct_test_everyday2');
  s.db.prepare("INSERT INTO tax_tags (transaction_id, ato_category, created_at) VALUES ('t_old', 'Other', 'x')").run();
  s.db.prepare("UPDATE accounts SET nickname = 'Daily' WHERE id = 'acct_test_everyday'").run();
  const counted = (id) => count(s.db, `SELECT count(*) n FROM ${FROM} WHERE t.id = ?`, id);
  assert.equal(counted('t_old'), 1);

  const r = mergeDuplicateAccounts(s.db);
  assert.equal(r.merges.length, 1);
  assert.equal(r.merges[0].duplicates_left, 1);
  assert.equal(s.db.prepare("SELECT account_id FROM transactions WHERE id = 't_old'").get().account_id, 'acct_test_everyday');
  assert.equal(s.db.prepare('SELECT transaction_id FROM tax_tags').get().transaction_id, 't_new', 'the tag follows to the copy that counts');
  assert.equal(counted('t_old'), 0, 'the retired copy no longer counts');
  assert.equal(counted('t_new'), 1);
  assert.equal(s.db.prepare("SELECT nickname FROM accounts WHERE id = 'acct_test_everyday2'").get().nickname, 'Daily');

  undoMerge(s.db, s.db.prepare('SELECT id FROM account_merges').get().id);
  assert.equal(s.db.prepare('SELECT transaction_id FROM tax_tags').get().transaction_id, 't_old');
  assert.equal(counted('t_old'), 1);
  assert.equal(s.db.prepare("SELECT merged_into FROM accounts WHERE id = 'acct_test_everyday'").get().merged_into, null);
  assert.equal(s.db.prepare("SELECT nickname FROM accounts WHERE id = 'acct_test_everyday2'").get().nickname, null);
  assert.equal(mergeDuplicateAccounts(s.db).merges.length, 0, 'an undone pair is not merged again');
  assert.throws(() => undoMerge(s.db, 1), /already undone/);
});

test('an annotated duplicate hands its category, note, business flag, tag and transfer pair to the surviving copy, and undo takes them back', async () => {
  const s = setup({});
  await s.ingest.syncMeta();
  relink(s);
  s.later();
  await s.ingest.syncMeta();
  const cat = s.db.prepare("INSERT INTO categories (name) VALUES ('Coffee') RETURNING id").get().id;
  const guess = s.db.prepare("INSERT INTO categories (name) VALUES ('Guess') RETURNING id").get().id;
  const ins = s.db.prepare(`INSERT INTO transactions (id, account_id, status, date, description, amount, currency, merchant, first_seen_at, updated_at)
    VALUES (?, ?, 'posted', ?, ?, ?, 'AUD', 'm', 'x', 'x')`);
  ins.run('t_old', 'acct_test_everyday', '2026-10-01', 'TEST CAFE', -450);
  ins.run('t_new', 'acct_test_everyday2', '2026-10-01', 'TEST CAFE', -450);
  ins.run('t_old2', 'acct_test_everyday', '2026-10-02', 'TEST SHOP', -900);
  ins.run('t_new2', 'acct_test_everyday2', '2026-10-02', 'TEST SHOP', -900);
  ins.run('t_partner', 'acct_test_card', '2026-10-01', 'TEST TRANSFER', 450);
  s.db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual', note = 'flat white', is_business = 1 WHERE id = 't_old'").run(cat);
  // The survivor's own manual category must not be overwritten; its empty note and flag are filled.
  s.db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = 't_new2'").run(guess);
  s.db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual', note = 'shop' WHERE id = 't_old2'").run(cat);
  s.db.prepare("INSERT INTO tax_tags (transaction_id, ato_category, created_at) VALUES ('t_old', 'Other', 'x')").run();
  s.db.prepare("INSERT INTO receipts (file, transaction_id, mime, bytes, created_at) VALUES ('r1.jpg', 't_old', 'image/jpeg', 1, 'x')").run();
  s.db.prepare("INSERT INTO transfers (out_tx, in_tx, created_at) VALUES ('t_old', 't_partner', 'x')").run();
  const state = () => JSON.stringify(['transactions', 'tax_tags', 'receipts', 'transfers'].map((t) => s.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  const before = state();

  const r = mergeDuplicateAccounts(s.db);
  assert.equal(r.merges[0].duplicates_left, 2);
  assert.equal(r.merges[0].links_repointed, 3);
  assert.equal(r.merges[0].links_blocked, 0);
  const n = s.db.prepare("SELECT category_id, category_source, note, is_business FROM transactions WHERE id = 't_new'").get();
  assert.deepEqual({ ...n }, { category_id: cat, category_source: 'manual', note: 'flat white', is_business: 1 });
  const n2 = s.db.prepare("SELECT category_id, note FROM transactions WHERE id = 't_new2'").get();
  assert.deepEqual({ ...n2 }, { category_id: guess, note: 'shop' }, 'a manual value already on the survivor wins');
  assert.equal(s.db.prepare('SELECT transaction_id FROM tax_tags').get().transaction_id, 't_new');
  assert.equal(s.db.prepare('SELECT transaction_id FROM receipts').get().transaction_id, 't_new');
  assert.deepEqual({ ...s.db.prepare('SELECT out_tx, in_tx FROM transfers').get() }, { out_tx: 't_new', in_tx: 't_partner' });
  assert.equal(count(s.db, 'SELECT count(*) n FROM transactions'), 5, 'nothing deleted');

  undoMerge(s.db, s.db.prepare('SELECT id FROM account_merges').get().id);
  assert.equal(state(), before, 'undo restores every row exactly');
});

test('after a merge the retired duplicates are out of transfer matching and out of every total', async () => {
  const s = setup({});
  await s.ingest.syncMeta();
  relink(s);
  s.later();
  await s.ingest.syncMeta();
  const ins = s.db.prepare(`INSERT INTO transactions (id, account_id, status, date, description, amount, currency, merchant, first_seen_at, updated_at)
    VALUES (?, ?, 'posted', ?, ?, ?, 'AUD', ?, 'x', 'x')`);
  // Two entries held twice (old id and new id), one only on the survivor, and a credit on the card for the transfer.
  ins.run('o1', 'acct_test_everyday', '2026-10-01', 'TEST CAFE', -450, 'cafe');
  ins.run('n1', 'acct_test_everyday2', '2026-10-01', 'TEST CAFE', -450, 'cafe');
  ins.run('o2', 'acct_test_everyday', '2026-10-02', 'TEST SHOP', -900, 'shop');
  ins.run('n2', 'acct_test_everyday2', '2026-10-02', 'TEST SHOP', -900, 'shop');
  ins.run('n3', 'acct_test_everyday2', '2026-10-03', 'TEST LUNCH', -100, 'lunch');
  ins.run('o4', 'acct_test_everyday', '2026-10-04', 'TRANSFER TO CARD', -5000, 'transfer');
  ins.run('n4', 'acct_test_everyday2', '2026-10-04', 'TRANSFER TO CARD', -5000, 'transfer');
  ins.run('c4', 'acct_test_card', '2026-10-04', 'PAYMENT THANK YOU', 5000, 'payment');
  ins.run('c5', 'acct_test_loan', '2026-10-04', 'PAYMENT RECEIVED', 5000, 'payment');
  const spent = () => monthlyReport(s.db, { from: '2026-10', to: '2026-10', includeBusiness: true }).months[0].spent;
  const sum = () => s.db.prepare(`SELECT COALESCE(-SUM(t.amount), 0) n FROM ${FROM} WHERE ${COUNTS} AND ${KIND} = 'expense'`).get().n;
  const uncategorised = () => reviewCounts(s.db, { today: '2026-10-17' }).uncategorised;
  const pre = { spent: spent(), sum: sum(), unc: uncategorised() };
  assert.equal(pre.sum, 450 * 2 + 900 * 2 + 100 + 5000 * 2);

  mergeDuplicateAccounts(s.db);
  const dupes = 450 + 900 + 5000;
  assert.equal(spent(), pre.spent - dupes);
  assert.equal(sum(), pre.sum - dupes);
  assert.equal(uncategorised(), pre.unc - 3);

  matchTransfers(s.db);
  const linked = s.db.prepare('SELECT out_tx, in_tx FROM transfers').all();
  assert.equal(linked.length, 1, 'one transfer for one real payment');
  assert.ok(!linked.some((x) => ['o1', 'o2', 'o4'].includes(x.out_tx) || ['o1', 'o2', 'o4'].includes(x.in_tx)), 'a retired copy never pairs');
  assert.equal(linked[0].out_tx, 'n4');
});

test('a dry run writes nothing and reports what an apply then does', async () => {
  const s = setup({ acct_test_everyday: fx.history('acct_test_everyday', '2026-09-01', '2026-10-10', 7) });
  await s.ingest.poll();
  relink(s);
  s.later();
  await s.ingest.syncMeta();
  const snap = () => JSON.stringify([accountRows(s.db), s.db.prepare('SELECT id, account_id FROM transactions ORDER BY id').all(), s.db.prepare('SELECT * FROM account_merges').all()]);
  const before = snap();
  const dry = mergeDuplicateAccounts(s.db, { dryRun: true });
  assert.equal(snap(), before);
  assert.equal(dry.merges.length, 1);
  const real = mergeDuplicateAccounts(s.db);
  assert.deepEqual(real.merges, dry.merges);
});

test('accounts are matched on institution, number and connection, never on the name', async () => {
  const s = setup({});
  await s.ingest.syncMeta();
  // Same name, different number: two accounts.
  s.accounts.push({ ...s.accounts[0], id: 'acct_test_samename', connection: 'conn_test_alpha', account_number: 'xxxx9999' });
  // Same number on the same connection: two accounts, not a re-link.
  s.accounts.push({ ...s.accounts[0], id: 'acct_test_sameconn', name: 'Different name', account_number: 'xxxx1111' });
  // A manual account is never a candidate.
  s.db.prepare("INSERT INTO accounts (id, name, type, institution, number_masked, currency, status, manual, sort, created_at, updated_at) VALUES ('man_0000000000000001', 'Everyday Test', 'transaction', 'Alpha Bank', 'xxxx1111', 'AUD', 'available', 1, 99, 'x', 'x')").run();
  await s.ingest.syncMeta();
  const r = mergeDuplicateAccounts(s.db);
  assert.equal(r.merges.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(s.db.prepare("SELECT count(*) n FROM accounts WHERE status = 'available'").get().n >= 6, true);
});

test('CSV and manual accounts are left alone by the sync', async () => {
  const s = setup({});
  await s.ingest.syncMeta();
  s.db.prepare("INSERT INTO accounts (id, name, type, institution, number_masked, currency, status, manual, sort, created_at, updated_at) VALUES ('man_0000000000000002', 'Cash', 'transaction', 'Alpha Bank', 'xxxx1111', 'AUD', 'available', 1, 98, 'x', 'x')").run();
  await s.ingest.poll();
  const man = s.db.prepare("SELECT status, merged_into FROM accounts WHERE id = 'man_0000000000000002'").get();
  assert.equal(man.status, 'available');
  assert.equal(man.merged_into, null);
});
