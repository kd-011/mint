// Read-only Wise sync (lib/wise.mjs client, lib/wisesync.mjs service): the
// personal profile is picked, each currency balance becomes one manual
// account (never duplicated), statement rows import once through the manual
// insert path at the rate for their date, the balance is set to Wise's own
// figure, SCA refusals fall back to balances only, 429 and 5xx back off, and
// the token never reaches an error, a log row or a setting. Invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createFx, createFrankfurter, storeRates, toAud } from '../lib/fx.mjs';
import { createClient as createRedbark } from '../lib/redbark.mjs';
import { createIngest } from '../lib/ingest.mjs';
import { runAlerts } from '../lib/alerts.mjs';
import { createClient, WiseError, normalizeToken, statementWindows, API_BASE } from '../lib/wise.mjs';
import { createWiseSync } from '../lib/wisesync.mjs';
import { seedCategories } from '../lib/categories.mjs';
import { fakeWise, FAKE_TOKEN, PERSONAL_ID } from './fixtures/fake-wise.mjs';
import { fakeFrankfurter } from './fixtures/fake-frankfurter.mjs';
import { fakeRedbark, FAKE_KEY } from './fixtures/fake-redbark.mjs';
import * as fixtures from './fixtures/data.mjs';

const NOW = new Date('2026-10-17T02:00:00Z'); // Saturday 10:00 in Perth
const TODAY = '2026-10-17';
const WINDOW_START = '2025-10-17'; // twelve months back

function setup({ wiseOpts = {}, syncOpts = {} } = {}) {
  const wise = fakeWise(wiseOpts);
  const ff = fakeFrankfurter();
  const db = openDb(':memory:');
  seedCategories(db);
  const sleeps = [];
  const client = createClient({ token: wise.token, fetchImpl: wise.fetch, sleep: async (ms) => { sleeps.push(ms); }, now: () => NOW });
  const fx = createFx({ db, client: createFrankfurter({ fetch: ff.fetch, base: 'http://fx.test/v1' }), now: () => NOW, log: () => {} });
  const sync = createWiseSync({ db, client, fx, now: () => NOW, log: () => {}, ...syncOpts });
  return { wise, ff, db, client, fx, sync, sleeps };
}
const accountOf = (db, currency) => db.prepare('SELECT * FROM accounts WHERE wise_balance_id IS NOT NULL AND currency = ?').get(currency);
const rowsOf = (db, id) => db.prepare('SELECT * FROM transactions WHERE account_id = ? ORDER BY date, id').all(id);
const everything = (db) => JSON.stringify({
  log: db.prepare('SELECT * FROM sync_log').all(), accounts: db.prepare('SELECT * FROM accounts').all(),
  settings: db.prepare('SELECT * FROM settings').all(), alerts: db.prepare('SELECT * FROM alerts').all(),
});

// ---------- client ----------

test('the client sends GET only, to api.wise.com, with the bearer token and no redirects', async () => {
  const { wise, client } = setup();
  assert.equal(API_BASE, 'https://api.wise.com');
  const profile = await client.personalProfile();
  await client.balances(profile.id);
  await client.statement(profile.id, 7001, { currency: 'AUD', from: '2026-10-01', to: TODAY });
  assert.ok(wise.state.calls.length >= 3);
  for (const c of wise.state.calls) {
    assert.equal(c.method, 'GET');
    assert.equal(c.origin, 'https://api.wise.com');
    assert.equal(c.auth, `Bearer ${FAKE_TOKEN}`);
    assert.equal(c.redirect, 'error');
  }
  assert.equal(typeof client.post, 'undefined');
  assert.equal(typeof client.request, 'undefined', 'no generic request escape hatch on the public client');
});

test('profile pick: the personal profile, never the business one', async () => {
  const { wise, client } = setup();
  const p = await client.personalProfile();
  assert.equal(p.id, PERSONAL_ID);
  await client.balances(p.id);
  assert.ok(wise.state.calls.some((c) => c.path === `/v4/profiles/${PERSONAL_ID}/balances` && c.query.types === 'STANDARD'));
  assert.ok(!wise.state.calls.some((c) => c.path.includes('41002')), 'the business profile is never queried');
  wise.state.profiles = wise.state.profiles.filter((x) => x.type !== 'PERSONAL');
  await assert.rejects(client.personalProfile(), /no personal profile/i);
});

test('a token stored with quotes in .env is normalised, and a malformed one is refused without echoing it', () => {
  assert.equal(normalizeToken(`"${FAKE_TOKEN}"`), FAKE_TOKEN);
  assert.equal(normalizeToken(`  '${FAKE_TOKEN}'  `), FAKE_TOKEN);
  assert.equal(normalizeToken(FAKE_TOKEN), FAKE_TOKEN);
  assert.equal(normalizeToken(''), '');
  assert.equal(normalizeToken(undefined), '');
  assert.throws(() => normalizeToken('has a space'), (e) => /malformed/i.test(e.message) && !e.message.includes('has a space'));
  assert.throws(() => normalizeToken('line\nbreak'), /malformed/i);
});

test('statement windows never exceed the 469 day cap and cover the range without gaps', () => {
  const w = statementWindows('2024-01-01', '2026-10-17');
  assert.ok(w.length >= 3);
  assert.equal(w[0].from, '2024-01-01');
  assert.equal(w.at(-1).to, '2026-10-17');
  for (let i = 0; i < w.length; i++) {
    const days = (Date.parse(`${w[i].to}T00:00:00Z`) - Date.parse(`${w[i].from}T00:00:00Z`)) / 86_400_000;
    assert.ok(days <= 460, `window ${i} is ${days} days`);
    if (i) assert.equal(Date.parse(`${w[i].from}T00:00:00Z`) - Date.parse(`${w[i - 1].to}T00:00:00Z`), 86_400_000, 'next window starts the day after');
  }
  assert.deepEqual(statementWindows('2026-10-01', '2026-10-17'), [{ from: '2026-10-01', to: '2026-10-17' }]);
});

test('a window longer than one statement is walked in pieces and the opening balance comes from the first', async () => {
  const { client, wise } = setup();
  const p = await client.personalProfile();
  const r = await client.walkStatement(p.id, 7001, { currency: 'AUD', from: '2024-01-01', to: TODAY });
  assert.ok(wise.state.calls.filter((c) => c.path.endsWith('statement.json')).length >= 2);
  assert.equal(r.openingCents, 60_000, 'balance before the oldest row');
  assert.equal(r.rows.length, 4);
  assert.equal(r.closingCents, 154_724);
  assert.deepEqual(r.rows.map((x) => x.amount), [-777, -1999, -2500, 100_000], 'oldest first, cents');
  assert.equal(r.rows.find((x) => x.ref === 'TRANSFER-0000001003').date, '2026-10-10', 'the Perth date, not the UTC one');
});

test('429 with Retry-After waits that long and retries; 5xx backs off exponentially; both end in success', async () => {
  const { wise, client, sleeps } = setup();
  wise.fail(/profiles$/, 429, { headers: { 'retry-after': '3' } });
  assert.equal((await client.personalProfile()).id, PERSONAL_ID);
  assert.deepEqual(sleeps, [3000]);
  sleeps.length = 0;
  wise.fail(/balances$/, 503, {}, 2);
  await client.balances(PERSONAL_ID);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('a Retry-After beyond two minutes, or too many 429s, fails the call with the real status', async () => {
  const { wise, client, sleeps } = setup();
  wise.fail(/profiles$/, 429, { headers: { 'retry-after': '600' } });
  await assert.rejects(client.personalProfile(), (e) => e instanceof WiseError && e.status === 429);
  assert.deepEqual(sleeps, []);
  wise.fail(/balances$/, 429, {}, 99);
  await assert.rejects(client.balances(PERSONAL_ID), (e) => e instanceof WiseError && e.status === 429);
  assert.equal(sleeps.length, 4, 'four retries, then give up');
});

test('an SCA refusal is recognised as one, with the status and a plain message', async () => {
  const { wise, client } = setup();
  wise.state.sca.statements = true;
  await assert.rejects(client.statement(PERSONAL_ID, 7001, { currency: 'AUD', from: '2026-10-01', to: TODAY }),
    (e) => e instanceof WiseError && e.status === 403 && e.sca === true && /strong customer authentication/i.test(e.message));
});

// ---------- sync: accounts ----------

test('first sync: one manual Wise account per currency that has money or history, keyed by the Wise balance id', async () => {
  const { db, sync, wise } = setup();
  const r = await sync.sync({ kind: 'poll' });
  assert.equal(r.ok, true, r.error);
  const accts = db.prepare('SELECT * FROM accounts WHERE wise_balance_id IS NOT NULL ORDER BY currency').all();
  assert.deepEqual(accts.map((a) => a.currency), ['AUD', 'USD'], 'THB is empty and zero: no clutter account');
  assert.deepEqual(accts.map((a) => a.wise_balance_id), ['7001', '7002']);
  for (const a of accts) {
    assert.equal(a.manual, 1);
    assert.equal(a.institution, 'Wise');
    assert.equal(a.type, 'transaction');
    assert.equal(a.name, `Wise ${a.currency}`);
    assert.match(a.id, /^man_[a-f0-9]{16}$/);
    assert.equal(a.connection_id, null);
    assert.equal(a.wise_statements, 'ok');
    assert.ok(a.last_synced_at);
    assert.equal(a.last_sync_error, null);
  }
  assert.equal(wise.state.calls.filter((c) => c.path.endsWith('statement.json')).length, 3, 'one statement per balance, THB included to see if it ever had rows');
});

test('re-sync never duplicates an account or a row', async () => {
  const { db, sync } = setup();
  await sync.sync({ kind: 'poll' });
  const ids = db.prepare('SELECT id FROM accounts ORDER BY id').all().map((a) => a.id);
  const n = db.prepare('SELECT count(*) n FROM transactions').get().n;
  const r2 = await sync.sync({ kind: 'poll' });
  const r3 = await sync.sync({ kind: 'reconcile' });
  assert.equal(r2.inserted, 0);
  assert.equal(r3.inserted, 0);
  assert.deepEqual(db.prepare('SELECT id FROM accounts ORDER BY id').all().map((a) => a.id), ids);
  assert.equal(db.prepare('SELECT count(*) n FROM transactions').get().n, n);
  assert.equal(db.prepare('SELECT count(*) n FROM accounts WHERE wise_balance_id IS NOT NULL').get().n, 2);
});

test('the Wise balance id is unique on accounts', () => {
  const { db } = setup();
  const ins = () => db.prepare(`INSERT INTO accounts (id, name, type, institution, currency, manual, wise_balance_id, created_at, updated_at) VALUES (?, 'x', 'transaction', 'Wise', 'AUD', 1, '9', 'now', 'now')`);
  ins().run('man_aaaaaaaaaaaaaaaa');
  assert.throws(() => ins().run('man_bbbbbbbbbbbbbbbb'), /UNIQUE/);
});

test('a currency that is empty today gets its account the day it holds money', async () => {
  const { db, sync, wise } = setup();
  await sync.sync({ kind: 'poll' });
  assert.equal(accountOf(db, 'THB'), undefined);
  wise.balance('THB').rows.push({ ref: 'MONEY_ADDED-0000003001', at: '2026-10-16T05:00:00.000Z', cents: 250_000, desc: 'Added money from TEST BANK', kind: 'MONEY_ADDED' });
  await sync.sync({ kind: 'poll', force: true });
  const thb = accountOf(db, 'THB');
  assert.ok(thb);
  assert.equal(thb.balance_native, 250_000);
});

test('an archived Wise account stays archived and is not synced into', async () => {
  const { db, sync, wise } = setup();
  await sync.sync({ kind: 'poll' });
  const usd = accountOf(db, 'USD');
  db.prepare("UPDATE accounts SET status = 'gone' WHERE id = ?").run(usd.id);
  const n = rowsOf(db, usd.id).length;
  wise.balance('USD').rows.push({ ref: 'CARD-0000002003', at: '2026-10-16T05:00:00.000Z', cents: -100, desc: 'Card transaction of 1.00 USD issued by TEST KIOSK' });
  await sync.sync({ kind: 'poll' });
  assert.equal(rowsOf(db, usd.id).length, n);
  assert.equal(db.prepare('SELECT status FROM accounts WHERE id = ?').get(usd.id).status, 'gone');
});

// ---------- sync: rows ----------

test('statement rows import with Perth dates, cents, descriptions, merchants and the opening balance from Wise, and the balance matches with no adjustment', async () => {
  const { db, sync } = setup();
  await sync.sync({ kind: 'poll' });
  const aud = accountOf(db, 'AUD');
  assert.equal(aud.opening_date, WINDOW_START);
  assert.equal(aud.opening_balance, 59_223, 'Wise says 592.23 at the start of the window: the old 7.77 row is history inside it');
  const rows = rowsOf(db, aud.id);
  assert.equal(rows.length, 3, 'the row before the window is not imported');
  assert.deepEqual(rows.map((r) => [r.date, r.amount, r.amount_native]), [
    ['2026-09-20', -1999, -1999], ['2026-10-01', -2500, -2500], ['2026-10-10', 100_000, 100_000],
  ]);
  assert.ok(rows.every((r) => /^mtx_[a-f0-9]{16}$/.test(r.id) && r.import_hash && r.import_id && r.status === 'posted' && r.merchant));
  assert.equal(rows[0].description, 'Card transaction of 19.99 AUD issued by TEST STREAMING');
  assert.equal(rows[2].direction, 'credit');
  assert.equal(aud.balance_native, 154_724);
  assert.equal(aud.balance_current, 154_724);
  assert.equal(db.prepare("SELECT count(*) n FROM transactions WHERE description = 'Balance adjustment'").get().n, 0);
  const imp = db.prepare('SELECT * FROM manual_imports WHERE account_id = ?').all(aud.id);
  assert.equal(imp.length, 1, 'the backfill is one import, so it undoes as one');
  assert.equal(imp[0].rows, 3);
});

test('the same statement again, or an overlapping one, adds nothing; a new row adds one', async () => {
  const { db, sync, wise } = setup();
  await sync.sync({ kind: 'poll' });
  const aud = accountOf(db, 'AUD');
  assert.equal((await sync.sync({ kind: 'reconcile' })).inserted, 0);
  wise.balance('AUD').rows.push({ ref: 'CARD-0000001004', at: '2026-10-16T06:00:00.000Z', cents: -1234, desc: 'Card transaction of 12.34 AUD issued by TEST BAKERY' });
  const r = await sync.sync({ kind: 'poll' });
  assert.equal(r.inserted, 1);
  assert.equal(rowsOf(db, aud.id).length, 4);
  assert.equal(accountOf(db, 'AUD').balance_native, 154_724 - 1234);
  assert.equal(db.prepare("SELECT count(*) n FROM transactions WHERE description = 'Balance adjustment'").get().n, 0, 'still no adjustment: the rows explain the balance');
});

test('a row the owner recategorised is not overwritten by the next sync', async () => {
  const { db, sync } = setup();
  await sync.sync({ kind: 'poll' });
  const aud = accountOf(db, 'AUD');
  const cat = db.prepare('SELECT id FROM categories WHERE archived = 0 LIMIT 1').get().id;
  const row = rowsOf(db, aud.id)[0];
  db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual', note = 'mine' WHERE id = ?").run(cat, row.id);
  await sync.sync({ kind: 'reconcile' });
  const after = db.prepare('SELECT * FROM transactions WHERE id = ?').get(row.id);
  assert.equal(after.category_id, cat);
  assert.equal(after.note, 'mine');
});

test('two statement lines that share a reference are both kept', async () => {
  const { db, sync, wise } = setup();
  const b = wise.balance('AUD');
  b.rows.push({ ref: 'CARD-0000001001', at: '2026-09-20T02:00:01.000Z', cents: -300, desc: 'Card transaction of 3.00 AUD issued by TEST STREAMING' });
  await sync.sync({ kind: 'poll' });
  const aud = accountOf(db, 'AUD');
  assert.equal(rowsOf(db, aud.id).length, 4);
  assert.equal(aud.balance_native, 154_724 - 300);
  assert.equal((await sync.sync({ kind: 'poll' })).inserted, 0);
});

test('when Wise reports more than the rows explain, the difference is one Balance adjustment, and only once', async () => {
  const { db, sync, wise } = setup();
  wise.balance('AUD').drift = 500;
  await sync.sync({ kind: 'poll' });
  const aud = accountOf(db, 'AUD');
  assert.equal(aud.balance_native, 155_224, 'matches Wise exactly');
  const adj = db.prepare("SELECT * FROM transactions WHERE account_id = ? AND description = 'Balance adjustment'").all(aud.id);
  assert.equal(adj.length, 1);
  assert.equal(adj[0].amount_native, 500);
  assert.match(adj[0].note, /wise/i);
  const cat = db.prepare("SELECT id FROM categories WHERE name = 'Balance adjustment'").get().id;
  assert.equal(adj[0].category_id, cat, 'filed under the transfer-kind category so it is never spend or income');
  await sync.sync({ kind: 'poll' });
  assert.equal(db.prepare("SELECT count(*) n FROM transactions WHERE description = 'Balance adjustment'").get().n, 1);
  assert.equal(accountOf(db, 'AUD').balance_native, 155_224);
});

test('balance snapshots exist for the account and end on Wise figure', async () => {
  const { db, sync } = setup();
  await sync.sync({ kind: 'poll' });
  const aud = accountOf(db, 'AUD');
  const snaps = db.prepare('SELECT date, native FROM balance_snapshots WHERE account_id = ? ORDER BY date').all(aud.id);
  assert.ok(snaps.length >= 3);
  assert.equal(snaps.at(-1).date, TODAY);
  assert.equal(snaps.at(-1).native, 154_724);
});

// ---------- sync: currencies ----------

test('a USD account converts every row at the rate for its date, and the balance at the latest rate', async () => {
  const { db, sync, ff } = setup();
  ff.setRate('USD', '2026-09-02', 1.4);
  await sync.sync({ kind: 'poll' });
  const usd = accountOf(db, 'USD');
  const rows = rowsOf(db, usd.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.date, r.amount_native, r.amount, r.fx_rate, r.fx_date]), [
    ['2026-09-02', 200_000, toAud(200_000, 1.4), 1.4, '2026-09-02'],
    ['2026-10-05', -4550, toAud(-4550, 1.5), 1.5, '2026-10-05'],
  ]);
  assert.equal(rows[0].currency, 'USD');
  assert.equal(usd.balance_native, 195_450);
  assert.equal(usd.balance_current, toAud(195_450, 1.5));
});

test('with no exchange rate at all the USD account is not written, the error says why, and AUD still syncs', async () => {
  const { db, sync, ff } = setup();
  ff.state.offline = true;
  const r = await sync.sync({ kind: 'poll' });
  assert.equal(r.ok, false);
  assert.match(r.error, /USD/);
  assert.match(r.error, /No exchange rate/i);
  assert.equal(accountOf(db, 'USD'), undefined, 'nothing saved without a rate');
  assert.ok(accountOf(db, 'AUD'), 'AUD needs no rate and went through');
  assert.equal(db.prepare("SELECT count(*) n FROM transactions WHERE currency = 'USD'").get().n, 0);
  ff.state.offline = false;
  const r2 = await sync.sync({ kind: 'poll' });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(accountOf(db, 'USD').balance_native, 195_450);
});

test('rates already in fx_rates are used without fetching', async () => {
  const { db, sync, ff } = setup();
  const rows = [];
  for (let d = Date.parse('2025-10-01T00:00:00Z'); d <= Date.parse('2026-10-16T00:00:00Z'); d += 86_400_000) rows.push({ date: new Date(d).toISOString().slice(0, 10), rate: 1.6 });
  storeRates(db, 'USD', rows, { source: 'test', fetchedAt: NOW.toISOString() });
  await sync.sync({ kind: 'poll' });
  assert.equal(ff.state.calls.filter((c) => c.includes('base=USD')).length, 0);
  assert.equal(rowsOf(db, accountOf(db, 'USD').id)[0].fx_rate, 1.6);
});

// ---------- SCA ----------

test('statements refused for SCA: balances only, the balance is still exact, and the account says so', async () => {
  const { db, sync, wise } = setup();
  wise.state.sca.statements = true;
  const r = await sync.sync({ kind: 'poll' });
  assert.equal(r.ok, true, 'a refusal for statements is a mode, not a failure');
  const aud = accountOf(db, 'AUD');
  assert.equal(aud.wise_statements, 'sca');
  assert.equal(aud.last_sync_error, null);
  assert.equal(aud.balance_native, 154_724);
  assert.equal(aud.opening_date, TODAY);
  assert.equal(rowsOf(db, aud.id).length, 0, 'no statement rows without statements');
  assert.equal(accountOf(db, 'USD').balance_native, 195_450);
  // Money moves: the balance follows through one adjustment.
  wise.balance('AUD').rows.push({ ref: 'CARD-0000001005', at: '2026-10-17T01:00:00.000Z', cents: -5000, desc: 'Card transaction of 50.00 AUD issued by TEST SHOP' });
  await sync.sync({ kind: 'poll' });
  const after = accountOf(db, 'AUD');
  assert.equal(after.balance_native, 149_724);
  const adj = rowsOf(db, after.id);
  assert.equal(adj.length, 1);
  assert.equal(adj[0].description, 'Balance adjustment');
  assert.equal(adj[0].amount_native, -5000);
  // The refusal is lifted: back to statements.
  wise.state.sca.statements = false;
  await sync.sync({ kind: 'poll' });
  assert.equal(accountOf(db, 'AUD').wise_statements, 'ok');
  assert.equal(accountOf(db, 'AUD').balance_native, 149_724);
});

test('balances refused for SCA: the sync fails with the exact status and a token hint, and creates nothing', async () => {
  const { db, sync, wise } = setup();
  wise.state.sca.balances = true;
  const r = await sync.sync({ kind: 'poll' });
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
  assert.match(r.error, /strong customer authentication/i);
  assert.match(r.error, /token/i);
  assert.equal(db.prepare('SELECT count(*) n FROM accounts').get().n, 0);
  assert.match(sync.status().error, /403/);
});

// ---------- failure visibility ----------

test('a failed run is one sync_log row and a status the page can show, and it clears on the next good run', async () => {
  const { db, sync, wise } = setup();
  wise.fail(/profiles$/, 500, { error: 'boom', message: 'kaput' }, 99);
  const r = await sync.sync({ kind: 'poll' });
  assert.equal(r.ok, false);
  const log = db.prepare("SELECT * FROM sync_log WHERE kind = 'wise'").all();
  assert.equal(log.length, 1);
  assert.equal(log[0].ok, 0);
  assert.match(log[0].error, /500/);
  assert.match(sync.status().error, /500/);
  wise.state.failures.length = 0;
  const r2 = await sync.sync({ kind: 'poll' });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(sync.status().error, null);
  assert.ok(sync.status().ok_at);
  assert.equal(db.prepare("SELECT count(*) n FROM sync_log WHERE kind = 'wise'").get().n, 2);
});

test('a currency that fails marks only its own account, and a retry fixes it', async () => {
  const { db, sync, wise } = setup();
  await sync.sync({ kind: 'poll' });
  wise.fail(/balance-statements\/7002/, 500, {}, 99);
  const r = await sync.sync({ kind: 'poll' });
  assert.equal(r.ok, false);
  assert.match(accountOf(db, 'USD').last_sync_error, /500/);
  assert.equal(accountOf(db, 'AUD').last_sync_error, null);
  wise.state.failures.length = 0;
  await sync.sync({ kind: 'poll' });
  assert.equal(accountOf(db, 'USD').last_sync_error, null);
});

// ---------- off without a token ----------

test('no token: the sync is off, makes no call, logs nothing, raises no alert', async () => {
  const wise = fakeWise();
  const db = openDb(':memory:');
  const sync = createWiseSync({ db, client: null, fx: null, now: () => NOW, log: () => {} });
  assert.equal(sync.enabled, false);
  const r = await sync.sync({ kind: 'poll' });
  assert.equal(r.skipped, true);
  assert.equal(wise.state.calls.length, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM sync_log').get().n, 0);
  assert.equal(sync.status().enabled, false);
  assert.deepEqual(runAlerts(db, { now: NOW, staleHours: 24, wise: sync.enabled }), []);
});

test('alerts: a failing Wise account and a failing Wise sync alert only when Wise sync is on', async () => {
  const { db, sync, wise } = setup();
  await sync.sync({ kind: 'poll' });
  wise.fail(/balance-statements\/7002/, 500, {}, 99);
  await sync.sync({ kind: 'poll' });
  const off = runAlerts(db, { now: NOW, staleHours: 24 });
  assert.equal(off.filter((a) => a.kind === 'sync').length, 0, 'default: manual accounts never alert');
  const on = runAlerts(db, { now: NOW, staleHours: 24, wise: true });
  const titles = on.filter((a) => a.kind === 'sync').map((a) => a.title);
  assert.deepEqual(titles, ['Sync failing: Wise USD']);
  wise.state.failures.length = 0;
  wise.fail(/profiles$/, 401, { error: 'invalid_token' }, 99);
  await sync.sync({ kind: 'poll' });
  const run2 = runAlerts(db, { now: NOW, staleHours: 24, wise: true });
  assert.ok(run2.some((a) => a.kind === 'sync' && a.title === 'Wise sync failing'), JSON.stringify(run2));
  assert.ok(!JSON.stringify(run2).includes(FAKE_TOKEN));
});

// ---------- the token never leaks ----------

test('the token is in no error, sync_log row, setting, account or alert, even when Wise echoes it back', async () => {
  const { db, sync, wise } = setup();
  wise.state.echoAuth = true;
  const bad = createClient({ token: FAKE_TOKEN, fetchImpl: async (u, init) => wise.fetch(u, { ...init, headers: { ...init.headers, Authorization: 'Bearer wrong' } }), sleep: async () => {} });
  const err = await bad.personalProfile().catch((e) => e);
  assert.ok(err instanceof WiseError);
  assert.equal(err.status, 401);
  assert.ok(!err.message.includes(FAKE_TOKEN));
  assert.ok(!JSON.stringify(err).includes(FAKE_TOKEN));

  // A network error that carries the header in its message.
  const net = createClient({ token: FAKE_TOKEN, fetchImpl: async () => { throw new TypeError(`fetch failed (Authorization: Bearer ${FAKE_TOKEN})`); }, sleep: async () => {}, maxRetries: 1 });
  const e2 = await net.personalProfile().catch((e) => e);
  assert.ok(e2 instanceof WiseError);
  assert.ok(!e2.message.includes(FAKE_TOKEN), e2.message);

  // The same through the service: the failing run leaves nothing behind.
  const leaky = createWiseSync({ db, client: net, fx: null, now: () => NOW, log: () => {} });
  const r = await leaky.sync({ kind: 'poll' });
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes(FAKE_TOKEN));
  await sync.sync({ kind: 'poll' });
  runAlerts(db, { now: NOW, staleHours: 24, wise: true });
  assert.ok(!everything(db).includes(FAKE_TOKEN));
  assert.ok(!JSON.stringify(sync.status()).includes(FAKE_TOKEN));
});

test('an invalid token is reported as such, plainly', async () => {
  const { db } = setup();
  const wise = fakeWise();
  const client = createClient({ token: 'some-other-token', fetchImpl: wise.fetch, sleep: async () => {} });
  const sync = createWiseSync({ db, client, fx: null, now: () => NOW, log: () => {} });
  const r = await sync.sync({ kind: 'poll' });
  assert.equal(r.ok, false);
  assert.match(r.error, /401/);
  assert.match(r.error, /invalid_token|Invalid token/i);
  assert.ok(!r.error.includes('some-other-token'));
});

// ---------- the shared queue: Redbark ingest runs it ----------

function ingestWith(wiseHook) {
  const fake = fakeRedbark({ ...fixtures, accounts: [...fixtures.accounts], transactions: {} });
  const client = createRedbark({ key: FAKE_KEY, base: fake.state.base, fetchImpl: fake.fetch, sleep: async () => {} });
  const db = openDb(':memory:');
  return { db, ingest: createIngest({ db, client, now: () => NOW, log: () => {}, wise: wiseHook }) };
}

test('a poll runs Wise after Redbark; a webhook-scoped poll does not; Wise failing does not fail the Redbark sweep', async () => {
  const calls = [];
  const hook = { enabled: true, sync: async (o) => { calls.push(o.kind); return { ok: true, inserted: 0 }; } };
  const { ingest } = ingestWith(hook);
  const r = await ingest.runSync('poll');
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['poll']);
  await ingest.runSync('poll', { accounts: ['acct_test_everyday'] });
  assert.deepEqual(calls, ['poll'], 'scoped by a webhook: Redbark only');
  await ingest.runSync('reconcile');
  assert.deepEqual(calls, ['poll', 'reconcile']);

  const failing = { enabled: true, sync: async () => ({ ok: false, error: 'Wise 500 boom' }) };
  const f = ingestWith(failing);
  const r2 = await f.ingest.runSync('poll');
  assert.equal(r2.ok, true, 'Redbark succeeded');
  assert.equal(f.ingest.state().accountErrors, 1);
});

test('the Sync now path can run Wise alone, through the same running guard', async () => {
  let n = 0;
  const hook = { enabled: true, sync: async () => { n += 1; await new Promise((r) => setTimeout(r, 20)); return { ok: true, inserted: 0 }; } };
  const { ingest } = ingestWith(hook);
  const p = ingest.runSync('wise');
  assert.equal(ingest.state().running, true);
  assert.equal((await ingest.runSync('wise')).already, true, 'a second request while running is folded');
  assert.equal((await p).ok, true);
  assert.equal(n, 1);
});

test('with Wise off, a poll never touches it', async () => {
  const { ingest } = ingestWith(undefined);
  assert.equal((await ingest.runSync('poll')).ok, true);
  const off = ingestWith({ enabled: false, sync: async () => { throw new Error('must not be called'); } });
  assert.equal((await off.ingest.runSync('poll')).ok, true);
});

test('Redbark ingest still ignores the Wise manual accounts', async () => {
  const { db, sync } = setup();
  await sync.sync({ kind: 'poll' });
  const fake = fakeRedbark({ ...fixtures, accounts: [...fixtures.accounts], transactions: {} });
  const client = createRedbark({ key: FAKE_KEY, base: fake.state.base, fetchImpl: fake.fetch, sleep: async () => {} });
  const ingest = createIngest({ db, client, now: () => NOW, log: () => {} });
  const before = db.prepare("SELECT id, status, balance_native FROM accounts WHERE wise_balance_id IS NOT NULL ORDER BY id").all();
  await ingest.runSync('poll');
  assert.deepEqual(db.prepare("SELECT id, status, balance_native FROM accounts WHERE wise_balance_id IS NOT NULL ORDER BY id").all(), before);
  assert.ok(!fake.calls.some((c) => (c.query.account ?? '').startsWith('man_')));
});
