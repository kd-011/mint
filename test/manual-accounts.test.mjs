// Manual accounts (lib/manual.mjs): accounts Redbark cannot see (Wise, an
// overseas bank, a travel card), in any currency Frankfurter knows, with a
// balance and transactions entered by hand. They survive every sync, never
// raise a sync alert, never feed safe to spend unless pinned, skip transfer
// matching when not AUD, and round-trip through a backup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.mjs';
import { createClient } from '../lib/redbark.mjs';
import { createIngest } from '../lib/ingest.mjs';
import { runAlerts } from '../lib/alerts.mjs';
import { matchTransfers } from '../lib/transfers.mjs';
import { spendableAccounts } from '../lib/safe.mjs';
import { applyRules } from '../lib/categorise.mjs';
import { seedMerchantRules } from '../lib/categories.mjs';
import { storeRates, rateOn } from '../lib/fx.mjs';
import { encryptFile, decryptFile } from '../lib/backupcrypt.mjs';
import {
  createManualAccount, updateManualAccount, deleteManualAccount, addManualTransaction, updateManualTransaction,
  deleteManualTransaction, setManualBalance, manualSummary,
} from '../lib/manual.mjs';
import { book } from './fixtures/book.mjs';
import { fakeRedbark, FAKE_KEY, addDays } from './fixtures/fake-redbark.mjs';
import { fakeFrankfurter } from './fixtures/fake-frankfurter.mjs';
import * as fx from './fixtures/data.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';

const TODAY = '2026-10-17';
const rates = (db) => storeRates(db, 'USD', [{ date: '2026-09-01', rate: 1.4 }, { date: '2026-10-01', rate: 1.5 }, { date: '2026-10-16', rate: 1.52 }], { source: 'test', fetchedAt: '2026-10-17T00:00:00Z' });
const wise = (db, extra = {}) => createManualAccount(db, { name: 'Wise USD', institution: 'Wise', type: 'transaction', currency: 'USD', opening_balance: 100_000, opening_date: '2026-10-01', ...extra }, { today: TODAY });

test('a manual account gets a man_ id, a native and an AUD balance, and is marked manual', () => {
  const b = book();
  rates(b.db);
  const a = wise(b.db);
  assert.match(a.id, /^man_[a-f0-9]{16}$/);
  const row = b.db.prepare('SELECT * FROM accounts WHERE id = ?').get(a.id);
  assert.equal(row.manual, 1);
  assert.equal(row.connection_id, null);
  assert.equal(row.currency, 'USD');
  assert.equal(row.balance_native, 100_000);
  assert.equal(row.balance_current, 152_000, 'latest rate 1.52');
  assert.equal(row.opening_balance, 100_000);
  assert.equal(row.opening_date, '2026-10-01');
  assert.ok(row.balance_observed_at);
});

test('validation: name, type, currency code, whole cents, a past opening date', () => {
  const b = book();
  rates(b.db);
  const base = { name: 'Wise USD', type: 'transaction', currency: 'USD', opening_balance: 0, opening_date: '2026-10-01' };
  assert.throws(() => createManualAccount(b.db, { ...base, name: ' ' }, { today: TODAY }), /name/);
  assert.throws(() => createManualAccount(b.db, { ...base, type: 'boat' }, { today: TODAY }), /type/);
  assert.throws(() => createManualAccount(b.db, { ...base, currency: 'usd!' }, { today: TODAY }), /currency/);
  assert.throws(() => createManualAccount(b.db, { ...base, opening_balance: 12.5 }, { today: TODAY }), /whole cents/);
  assert.throws(() => createManualAccount(b.db, { ...base, opening_date: '2026-12-01' }, { today: TODAY }), /future/);
  assert.throws(() => createManualAccount(b.db, { ...base, currency: 'GBP' }, { today: TODAY }), (e) => e.status === 422 && /No exchange rate for GBP/.test(e.message));
});

test('the balance is the opening balance plus transactions from the opening date on, in the native currency', () => {
  const b = book();
  rates(b.db);
  const a = wise(b.db);
  addManualTransaction(b.db, a.id, { date: '2026-10-05', amount: -5_000, description: 'TEST COFFEE NYC' }, { today: TODAY });
  addManualTransaction(b.db, a.id, { date: '2026-10-06', amount: 2_000, description: 'REFUND' }, { today: TODAY });
  addManualTransaction(b.db, a.id, { date: '2026-09-20', amount: -1_000, description: 'BEFORE OPENING' }, { today: TODAY });
  const row = b.db.prepare('SELECT balance_native, balance_current FROM accounts WHERE id = ?').get(a.id);
  assert.equal(row.balance_native, 97_000, 'the September row is history, already inside the opening balance');
  assert.equal(row.balance_current, Math.round(97_000 * 1.52));
  const snaps = b.db.prepare('SELECT date, current, native FROM balance_snapshots WHERE account_id = ? ORDER BY date').all(a.id);
  assert.deepEqual(snaps.map((s) => s.date), ['2026-10-01', '2026-10-05', '2026-10-06', TODAY]);
  assert.deepEqual(snaps.map((s) => s.native), [100_000, 95_000, 97_000, 97_000]);
  assert.equal(snaps[0].current, 150_000, 'each day at its own rate');
});

test('a manual transaction stores the native amount, the AUD amount and the rate it used, and goes through the rules', () => {
  const b = book();
  rates(b.db);
  const a = wise(b.db);
  const t = addManualTransaction(b.db, a.id, { date: '2026-09-15', amount: -10_000, description: 'WOOLWORTHS NYC', note: 'trip' }, { today: TODAY });
  assert.match(t.id, /^mtx_[a-f0-9]{16}$/);
  const r = b.row(t.id);
  assert.equal(r.amount_native, -10_000);
  assert.equal(r.amount, -14_000, 'AUD at the 1 Sep rate, the nearest earlier one');
  assert.equal(r.currency, 'USD');
  assert.equal(r.fx_rate, 1.4);
  assert.equal(r.fx_date, '2026-09-01');
  assert.equal(r.status, 'posted');
  assert.equal(r.direction, 'debit');
  seedMerchantRules(b.db);
  applyRules(b.db);
  assert.equal(b.row(t.id).category_id, b.cat('Groceries'), 'the seeded Woolworths rule files it like a synced row');
});

test('edit and delete work on manual rows only; provider rows stay read only', () => {
  const b = book();
  rates(b.db);
  const a = wise(b.db);
  const t = addManualTransaction(b.db, a.id, { date: '2026-10-05', amount: -5_000, description: 'TEST' }, { today: TODAY });
  updateManualTransaction(b.db, t.id, { amount: -6_000, date: '2026-10-02', description: 'TEST EDITED' }, { today: TODAY });
  const r = b.row(t.id);
  assert.equal(r.amount_native, -6_000);
  assert.equal(r.amount, -9_000);
  assert.equal(r.description, 'TEST EDITED');
  assert.equal(b.db.prepare('SELECT balance_native FROM accounts WHERE id = ?').get(a.id).balance_native, 94_000);
  const synced = b.add('acct_t_everyday', '2026-10-03', -1234, 'SYNCED ROW');
  assert.throws(() => updateManualTransaction(b.db, synced, { amount: 1 }, { today: TODAY }), /bank's rows are read only|not a manual transaction/i);
  assert.throws(() => deleteManualTransaction(b.db, synced), /not a manual transaction/i);
  assert.throws(() => addManualTransaction(b.db, 'acct_t_everyday', { date: '2026-10-03', amount: -1, description: 'X' }, { today: TODAY }), /not a manual account/i);
  deleteManualTransaction(b.db, t.id);
  assert.equal(b.row(t.id), undefined);
  assert.equal(b.db.prepare('SELECT balance_native FROM accounts WHERE id = ?').get(a.id).balance_native, 100_000);
});

test('set balance records a reconciling adjustment that never counts as spend or income', () => {
  const b = book();
  rates(b.db);
  const a = wise(b.db);
  const adj = setManualBalance(b.db, a.id, { balance: 123_456 }, { today: TODAY });
  assert.equal(adj.amount_native, 23_456);
  const r = b.row(adj.id);
  assert.equal(r.category_source, 'manual');
  assert.equal(b.db.prepare('SELECT kind FROM categories WHERE id = ?').get(r.category_id).kind, 'transfer');
  assert.equal(b.db.prepare('SELECT balance_native FROM accounts WHERE id = ?').get(a.id).balance_native, 123_456);
  assert.throws(() => setManualBalance(b.db, a.id, { balance: 123_456 }, { today: TODAY }), /already/);
});

test('edit, archive and delete a manual account; delete takes only its own rows and says how many', () => {
  const b = book();
  rates(b.db);
  const a = wise(b.db);
  const keep = b.add('acct_t_everyday', '2026-10-03', -1234, 'SYNCED ROW');
  addManualTransaction(b.db, a.id, { date: '2026-10-05', amount: -5_000, description: 'ONE' }, { today: TODAY });
  addManualTransaction(b.db, a.id, { date: '2026-10-06', amount: -5_000, description: 'TWO' }, { today: TODAY });
  updateManualAccount(b.db, a.id, { name: 'Wise dollars', institution: 'Wise Payments', opening_balance: 200_000 }, { today: TODAY });
  assert.equal(b.db.prepare('SELECT balance_native FROM accounts WHERE id = ?').get(a.id).balance_native, 190_000);
  assert.throws(() => updateManualAccount(b.db, a.id, { currency: 'EUR' }, { today: TODAY }), /currency/);
  assert.equal(manualSummary(b.db, a.id).transactions, 2);
  updateManualAccount(b.db, a.id, { archived: true }, { today: TODAY });
  assert.equal(b.db.prepare('SELECT status FROM accounts WHERE id = ?').get(a.id).status, 'gone');
  updateManualAccount(b.db, a.id, { archived: false }, { today: TODAY });
  assert.notEqual(b.db.prepare('SELECT status FROM accounts WHERE id = ?').get(a.id).status, 'gone');
  assert.throws(() => deleteManualAccount(b.db, 'acct_t_everyday'), /not a manual account/i);
  const r = deleteManualAccount(b.db, a.id);
  assert.deepEqual(r, { deleted: true, transactions: 2 });
  assert.equal(b.db.prepare('SELECT count(*) n FROM transactions WHERE account_id = ?').get(a.id).n, 0);
  assert.equal(b.db.prepare('SELECT count(*) n FROM balance_snapshots WHERE account_id = ?').get(a.id).n, 0);
  assert.ok(b.row(keep));
});

test('a page-chosen id makes a replayed create or add harmless', () => {
  const b = book();
  rates(b.db);
  const id = 'man_0123456789abcdef';
  const one = wise(b.db, { id });
  const two = wise(b.db, { id });
  assert.equal(one.id, id);
  assert.equal(two.id, id);
  assert.equal(b.db.prepare('SELECT count(*) n FROM accounts WHERE manual = 1').get().n, 1);
  const tx = { id: 'mtx_0123456789abcdef', date: '2026-10-05', amount: -5_000, description: 'ONE' };
  addManualTransaction(b.db, id, tx, { today: TODAY });
  addManualTransaction(b.db, id, tx, { today: TODAY });
  assert.equal(manualSummary(b.db, id).transactions, 1);
  assert.throws(() => wise(b.db, { id: 'acct_hijack' }), /id/);
});

test('ingest never marks a manual account gone, never asks Redbark about it, and leaves its rows alone', async () => {
  const live = [...fx.accounts];
  const fake = fakeRedbark({ ...fx, accounts: live, transactions: { acct_test_everyday: fx.history('acct_test_everyday', '2026-10-01', '2026-10-16', 2) } });
  const client = createClient({ key: FAKE_KEY, base: fake.state.base, fetchImpl: fake.fetch, sleep: async () => {} });
  const db = openDb(':memory:');
  rates(db);
  const ingest = createIngest({ db, client, now: () => new Date('2026-10-17T02:00:00Z'), log: () => {} });
  const a = wise(db);
  const t = addManualTransaction(db, a.id, { date: '2026-10-05', amount: -5_000, description: 'TEST' }, { today: TODAY });
  await ingest.poll();
  await ingest.reconcile();
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(a.id);
  assert.notEqual(row.status, 'gone');
  assert.equal(row.last_sync_error, null);
  assert.equal(row.balance_native, 95_000);
  assert.ok(db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(t.id));
  assert.equal(JSON.stringify(fake.calls).includes(a.id), false, 'no Redbark call names the manual account');
  // Synced accounts behave as before: all four are live and synced.
  const synced = db.prepare('SELECT id, status, last_synced_at FROM accounts WHERE manual = 0').all();
  assert.equal(synced.length, 4);
  assert.ok(synced.every((s) => s.status !== 'gone' && s.last_synced_at));
  // A manual account and a synced one gone from Redbark: only the synced one is gone.
  live.shift();
  await ingest.syncMeta();
  assert.equal(db.prepare("SELECT status FROM accounts WHERE id = 'acct_test_everyday'").get().status, 'gone');
  assert.notEqual(db.prepare('SELECT status FROM accounts WHERE id = ?').get(a.id).status, 'gone');
});

test('no sync or staleness alert for a manual account', () => {
  const b = book();
  rates(b.db);
  wise(b.db);
  const out = runAlerts(b.db, { now: new Date('2026-10-30T02:00:00Z'), staleHours: 24 });
  assert.equal(out.filter((x) => x.kind === 'sync' && /Wise/.test(x.title)).length, 0);
});

test('safe to spend leaves a manual account out until it is pinned spendable', () => {
  const b = book();
  rates(b.db);
  const a = wise(b.db);
  assert.equal(spendableAccounts(b.db).some((x) => x.id === a.id), false);
  b.db.prepare('UPDATE accounts SET spendable = 1 WHERE id = ?').run(a.id);
  const pinned = spendableAccounts(b.db).find((x) => x.id === a.id);
  assert.equal(pinned.balance, 152_000, 'in AUD');
});

test('transfer matching skips a foreign-currency account but still pairs an AUD manual one', () => {
  const b = book();
  rates(b.db);
  const usd = wise(b.db);
  const aud = createManualAccount(b.db, { name: 'Cash tin', type: 'transaction', currency: 'AUD', opening_balance: 0, opening_date: '2026-10-01' }, { today: TODAY });
  b.add('acct_t_everyday', '2026-10-05', -15_000, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_OUT' });
  addManualTransaction(b.db, usd.id, { date: '2026-10-05', amount: 10_000, description: 'ONLINE Linked Acc Trns' }, { today: TODAY });
  assert.equal(b.db.prepare('SELECT amount FROM transactions WHERE account_id = ?').get(usd.id).amount, 15_000, 'same AUD amount as the debit');
  matchTransfers(b.db);
  assert.equal(b.db.prepare('SELECT count(*) n FROM transfers').get().n, 0);
  b.add('acct_t_everyday', '2026-10-07', -7_000, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_OUT' });
  addManualTransaction(b.db, aud.id, { date: '2026-10-07', amount: 7_000, description: 'ONLINE Linked Acc Trns' }, { today: TODAY });
  matchTransfers(b.db);
  assert.equal(b.db.prepare('SELECT count(*) n FROM transfers').get().n, 1);
});

test('a backup round-trips manual accounts, their rows and the exchange rates', { skip: !spawnSync('sh', ['-c', 'command -v age-keygen']).stdout.length }, () => {
  const work = mkdtempSync(join(tmpdir(), 'mint-manual-backup-'));
  const b = book();
  rates(b.db);
  const a = wise(b.db);
  addManualTransaction(b.db, a.id, { date: '2026-10-05', amount: -5_000, description: 'ONE' }, { today: TODAY });
  const snap = join(work, 'mint.db');
  b.db.exec(`VACUUM INTO '${snap}'`);
  const key = join(work, 'k.txt');
  const r = spawnSync('age-keygen', ['-o', key], { encoding: 'utf8' });
  const recipient = /Public key: (age1\S+)/.exec(r.stderr)[1];
  encryptFile(snap, `${snap}.age`, recipient);
  decryptFile(`${snap}.age`, join(work, 'restored.db'), key);
  assert.ok(existsSync(join(work, 'restored.db')));
  const back = openDb(join(work, 'restored.db'));
  const acct = back.prepare('SELECT * FROM accounts WHERE id = ?').get(a.id);
  assert.equal(acct.manual, 1);
  assert.equal(acct.currency, 'USD');
  assert.equal(acct.balance_native, 95_000);
  assert.equal(back.prepare('SELECT count(*) n FROM transactions WHERE account_id = ?').get(a.id).n, 1);
  assert.deepEqual(rateOn(back, 'USD', '2026-10-05'), rateOn(b.db, 'USD', '2026-10-05'));
  assert.equal(back.prepare("SELECT count(*) n FROM fx_rates WHERE currency = 'USD'").get().n, 3);
});

// through the HTTP API, on a real server

const T = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth' }).format(new Date());
let proc, base, fakeSrv, fxSrv;
const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const get = (path) => fetch(base + path, { headers: H });
const send = (method, path, body) => fetch(base + path, { method, headers: { ...H, 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
const json = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };

function start(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ p, url: `http://127.0.0.1:${m[1]}` });
    });
    p.stderr.on('data', (d) => { out += d; });
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
}

before(async () => {
  const fake = fakeRedbark({ ...fx, today: T, transactions: { acct_test_everyday: [fx.tx('acct_test_everyday', addDays(T, -2), -4410, 'TEST GROCER', { id: 'txn_man_synced' })] } });
  const l = await fake.listen();
  fakeSrv = l.server;
  const ff = fakeFrankfurter({ latestDate: T });
  const f = await ff.listen();
  fxSrv = f.server;
  const s = await start({
    MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-manual-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner',
    REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: l.base, MINT_FX_BASE: f.base,
  });
  proc = s.p;
  base = s.url;
  await send('POST', '/api/sync', {});
  for (let i = 0; i < 200; i++) {
    const st = await (await get('/api/sync')).json();
    if (!st.running && st.finishedAt) break;
    await new Promise((r) => setTimeout(r, 50));
  }
});
after(() => { proc?.kill('SIGTERM'); fakeSrv?.close(); fxSrv?.close(); });

test('API: currency list, add a Wise USD account, see it with native and AUD balances, edit it like a synced one', async () => {
  const cur = await json(await get('/api/fx/currencies'));
  assert.ok(cur.items.some((c) => c.code === 'USD'));
  const bad = await send('POST', '/api/manual/accounts', { name: 'Nope', type: 'transaction', currency: 'XYZ', opening_balance: 0, opening_date: T });
  assert.equal(bad.status, 400);
  const a = await json(await send('POST', '/api/manual/accounts', { name: 'Wise USD', institution: 'Wise', type: 'transaction', currency: 'USD', opening_balance: 100_000, opening_date: addDays(T, -10) }), 201);
  assert.match(a.id, /^man_/);
  const list = await json(await get('/api/accounts'));
  const mine = list.accounts.find((x) => x.id === a.id);
  assert.equal(mine.manual, true);
  assert.equal(mine.currency, 'USD');
  assert.equal(mine.balance_native, 100_000);
  assert.equal(mine.balance_current, 150_000);
  assert.equal(mine.fx.rate, 1.5);
  assert.equal(typeof mine.fx.stale, 'boolean');
  const p = await json(await send('PATCH', `/api/accounts/${a.id}`, { nickname: 'Travel money', is_business: false }));
  assert.equal(p.nickname, 'Travel money');
  const txs = await json(await get(`/api/transactions?account=${a.id}`));
  assert.deepEqual(txs.items, []);
});

test('API: add, edit and delete a manual transaction; a bank row cannot be edited that way', async () => {
  const a = await json(await send('POST', '/api/manual/accounts', { name: 'Wise EUR', type: 'transaction', currency: 'EUR', opening_balance: 0, opening_date: addDays(T, -20) }), 201);
  const t = await json(await send('POST', `/api/manual/accounts/${a.id}/transactions`, { date: addDays(T, -3), amount: -2_000, description: 'TEST PARIS CAFE' }), 201);
  assert.equal(t.amount_native, -2_000);
  assert.equal(t.amount, -3_300);
  assert.equal(t.currency, 'EUR');
  const e = await json(await send('PATCH', `/api/manual/transactions/${t.id}`, { amount: -4_000 }));
  assert.equal(e.amount, -6_600);
  const one = await json(await get(`/api/transactions/${t.id}`));
  assert.equal(one.transaction.amount_native, -4_000);
  assert.equal((await send('PATCH', '/api/manual/transactions/txn_man_synced', { amount: 1 })).status, 400);
  await json(await send('DELETE', `/api/manual/transactions/${t.id}`));
  assert.equal((await get(`/api/transactions/${t.id}`)).status, 404);
  const gone = await json(await send('DELETE', `/api/manual/accounts/${a.id}`));
  assert.deepEqual(gone, { deleted: true, transactions: 0 });
});

test('API: CSV import previews, imports once, re-imports nothing and undoes as one', async () => {
  const a = await json(await send('POST', '/api/manual/accounts', { name: 'Wise GBP', type: 'transaction', currency: 'GBP', opening_balance: 0, opening_date: addDays(T, -60) }), 201);
  const d = (n) => { const x = addDays(T, -n); return `${x.slice(8, 10)}/${x.slice(5, 7)}/${x.slice(0, 4)}`; };
  const text = `Date,Description,Amount\n${d(5)},TEST LONDON PUB,-12.50\n${d(4)},"TEST, WITH COMMA",-3.00\n${d(3)},TOPUP,100.00\n`;
  const prev = await json(await send('POST', `/api/manual/accounts/${a.id}/import`, { text, file_name: 'wise.csv', dry_run: true }));
  assert.deepEqual(prev.counts, { total: 3, import: 3, duplicate: 0, failed: 0 });
  assert.equal(prev.mapping.date, 0);
  assert.equal((await json(await get(`/api/transactions?account=${a.id}`))).items.length, 0, 'a preview writes nothing');
  const r = await json(await send('POST', `/api/manual/accounts/${a.id}/import`, { text, file_name: 'wise.csv', mapping: prev.mapping, date_format: prev.date_format }));
  assert.equal(r.imported, 3);
  const again = await json(await send('POST', `/api/manual/accounts/${a.id}/import`, { text, file_name: 'wise.csv', mapping: prev.mapping, date_format: prev.date_format }));
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 3);
  const accts = await json(await get('/api/accounts'));
  assert.equal(accts.accounts.find((x) => x.id === a.id).balance_native, 8_450);
  await json(await send('DELETE', `/api/manual/imports/${r.import_id}`));
  assert.equal((await json(await get(`/api/transactions?account=${a.id}`))).items.length, 0);
  assert.equal((await json(await get('/api/accounts'))).accounts.find((x) => x.id === a.id).balance_native, 0);
});

// through the assistant chat door

test('chat door: add a manual account and a transaction on it, each with an undo that puts the book back', async () => {
  const { createServer } = await import('node:http');
  const { createAssistantApi } = await import('../lib/assistant.mjs');
  const { createFx, createFrankfurter } = await import('../lib/fx.mjs');
  const { HttpError } = await import('../lib/errors.mjs');
  const b = book();
  const ff = fakeFrankfurter({ latestDate: '2026-10-16' });
  const fxs = createFx({ db: b.db, client: createFrankfurter({ fetch: ff.fetch, base: 'http://fx.test/v1' }), now: () => new Date('2026-10-17T02:00:00Z'), log() {} });
  const api = createAssistantApi({ db: b.db, engine: { refresh() {} }, fx: fxs, quotes: { status: () => ({ cap: 25 }) }, now: () => new Date('2026-10-17T02:00:00Z'), log() {} });
  const srv = createServer(async (req, res) => {
    try {
      if (!(await api(req, res, new URL(req.url, 'http://localhost')))) { res.writeHead(404); res.end('{}'); }
    } catch (e) { res.writeHead(e instanceof HttpError ? e.status : 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/assistant`;
  const post = async (p, body, status = 200) => { const r = await fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }); assert.equal(r.status, status, await r.clone().text()); return r.json(); };
  try {
    const bad = await fetch(`${url}/manual-accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', currency: 'XYZ' }) });
    assert.equal(bad.status, 400);
    const a = await post('/manual-accounts', { name: 'Wise USD', institution: 'Wise', currency: 'usd', opening_balance: 100_000, opening_date: '2026-10-01' }, 201);
    assert.equal(a.applied, true);
    assert.match(a.summary, /Wise USD in USD, opening balance USD 1,000\.00 \(\$1,500\.00\)/);
    assert.ok(a.undo.token);
    const id = a.result.id;
    const t = await post('/manual-accounts/Wise USD/transactions', { amount: -2_500, description: 'TEST NYC DINER', date: '2026-10-10', category: 'Eating out' }, 201);
    assert.equal(t.result.amount_aud, -3_750);
    assert.equal(b.db.prepare('SELECT balance_native FROM accounts WHERE id = ?').get(id).balance_native, 97_500);
    assert.equal(b.row(t.result.id).category_id, b.cat('Eating out'));
    await post(`/undo/${t.undo.token}`);
    assert.equal(b.row(t.result.id), undefined);
    assert.equal(b.db.prepare('SELECT balance_native FROM accounts WHERE id = ?').get(id).balance_native, 100_000);
    await post(`/undo/${a.undo.token}`);
    assert.equal(b.db.prepare('SELECT count(*) n FROM accounts WHERE id = ?').get(id).n, 0);
    assert.equal(b.db.prepare('SELECT count(*) n FROM balance_snapshots WHERE account_id = ?').get(id).n, 0);
  } finally { srv.close(); }
});
