// The order the owner sets on Home: PUT /api/home/order stores it (accounts.sort,
// manual_assets.sort, and the share portfolio's place in settings), it comes
// back on the account view, net worth and holdings, and a Redbark sync never
// resets it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { book } from './fixtures/book.mjs';
import { createApi } from '../lib/api.mjs';
import { HttpError } from '../lib/errors.mjs';
import { openDb } from '../lib/db.mjs';
import { createAsset, addSnapshot, netWorth } from '../lib/networth.mjs';
import { createClient } from '../lib/redbark.mjs';
import { createIngest } from '../lib/ingest.mjs';
import { fakeRedbark, FAKE_KEY } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';

let srv, base, b, home, car;

before(async () => {
  b = book();
  home = createAsset(b.db, { name: 'Test Home', kind: 'property' });
  car = createAsset(b.db, { name: 'Test Car', kind: 'vehicle' });
  addSnapshot(b.db, home.id, { date: '2026-10-01', value: 50000000 });
  addSnapshot(b.db, car.id, { date: '2026-10-01', value: 2000000 });
  const api = createApi({ db: b.db, engine: { refresh() {}, runAi() {} }, ai: null, dataDir: mkdtempSync(join(tmpdir(), 'mint-order-')), log() {} });
  srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!(await api(req, res, url))) { res.writeHead(404); res.end('{}'); }
    } catch (e) {
      res.writeHead(e instanceof HttpError ? e.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv?.close());

const put = (ids) => fetch(`${base}/api/home/order`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
const sorts = (table) => Object.fromEntries(b.db.prepare(`SELECT id, sort FROM ${table}`).all().map((r) => [r.id, r.sort]));

test('PUT /api/home/order stores the position of each row, accounts and assets alike', async () => {
  const r = await put([`asset_${car.id}`, 'acct_t_savings', 'acct_t_everyday', `asset_${home.id}`]);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { saved: 4 });
  const a = sorts('accounts');
  assert.equal(a.acct_t_savings, 2);
  assert.equal(a.acct_t_everyday, 3);
  const m = sorts('manual_assets');
  assert.equal(m[car.id], 1);
  assert.equal(m[home.id], 4);
});

test('the share portfolio takes a place too, kept in settings, and reads back on net worth', async () => {
  const r = await put([`asset_${home.id}`, 'holdings', `asset_${car.id}`]);
  assert.equal(r.status, 200, await r.clone().text());
  const nw = netWorth(b.db);
  assert.equal(nw.holdings.sort, 2);
  assert.equal(nw.manual.find((x) => x.id === home.id).sort, 1);
  assert.equal(nw.manual.find((x) => x.id === car.id).sort, 3);
});

test('the same request twice changes nothing more (a replayed offline write is harmless)', async () => {
  const ids = ['acct_t_card', 'acct_t_everyday'];
  await put(ids);
  const first = sorts('accounts');
  assert.equal((await put(ids)).status, 200);
  assert.deepEqual(sorts('accounts'), first);
});

test('bad bodies are refused and change nothing', async () => {
  const before = JSON.stringify([sorts('accounts'), sorts('manual_assets')]);
  for (const ids of [[], 'acct_t_card', ['acct_t_card', 'acct_t_card'], ['nope'], ['asset_99999'], ['asset_x'], [1], Array.from({ length: 201 }, (_, i) => `asset_${i}`)]) {
    const r = await put(ids);
    assert.equal(r.status, 400, JSON.stringify(ids).slice(0, 60));
  }
  assert.equal((await fetch(`${base}/api/home/order`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal(JSON.stringify([sorts('accounts'), sorts('manual_assets')]), before, 'one bad id rolls the whole request back');
});

test('an account that has gone is not orderable', async () => {
  b.db.prepare("UPDATE accounts SET status = 'gone' WHERE id = 'acct_t_biz'").run();
  assert.equal((await put(['acct_t_biz'])).status, 400);
});

test('a new manual asset goes to the end of the assets', () => {
  const x = createAsset(b.db, { name: 'Later', kind: 'property' });
  const max = b.db.prepare('SELECT max(sort) m FROM manual_assets WHERE id != ?').get(x.id).m;
  assert.ok(x.sort > max);
});

test('opening an older book adds manual_assets.sort without touching its rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mint-mig-'));
  const file = join(dir, 'mint.db');
  let db = openDb(file);
  db.exec('ALTER TABLE manual_assets DROP COLUMN sort');
  db.prepare("INSERT INTO manual_assets (name, kind, is_liability, created_at) VALUES ('Old home', 'property', 0, '2026-01-01')").run();
  db.close();
  db = openDb(file);
  const rows = db.prepare('SELECT name, kind, sort FROM manual_assets').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ name: 'Old home', kind: 'property', sort: 0 }]);
  db.close();
});

test('a Redbark sync never resets the order, and a new account lands after the others', async () => {
  const accts = [...fx.accounts];
  const fake = fakeRedbark({ ...fx, accounts: accts, transactions: {} });
  const client = createClient({ key: FAKE_KEY, base: fake.state.base, fetchImpl: fake.fetch, sleep: async () => {} });
  const db = openDb(':memory:');
  const ingest = createIngest({ db, client, now: () => new Date('2026-10-17T02:00:00Z'), log: () => {} });
  await ingest.syncMeta();
  const ids = db.prepare('SELECT id FROM accounts ORDER BY sort, name').all().map((r) => r.id);
  const mine = [...ids].reverse();
  mine.forEach((id, i) => db.prepare("UPDATE accounts SET sort = ? WHERE id = ?").run(i + 10, id));
  await ingest.syncMeta();
  await ingest.syncBalances();
  await ingest.reconcile();
  assert.deepEqual(db.prepare('SELECT id FROM accounts ORDER BY sort, name').all().map((r) => r.id), mine);
  accts.push({ ...accts[0], id: 'acct_test_newcomer', name: 'Newcomer' });
  await ingest.syncMeta();
  const order = db.prepare('SELECT id FROM accounts ORDER BY sort, name').all().map((r) => r.id);
  assert.equal(order.at(-1), 'acct_test_newcomer');
  assert.deepEqual(order.slice(0, -1), mine);
});

test('a new manual asset goes after the share portfolio too, not tied with it', async () => {
  await put([`asset_${home.id}`, `asset_${car.id}`, 'holdings']);
  const x = createAsset(b.db, { name: 'After holdings', kind: 'property' });
  const hs = Number(b.db.prepare("SELECT value FROM settings WHERE key = 'home_sort_holdings'").get().value);
  assert.ok(x.sort > hs, `${x.sort} should be after holdings at ${hs}`);
});
