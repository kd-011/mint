import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { fakeRedbark, FAKE_KEY } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'whsec_server_test_invented';
let proc, base, fakeSrv, home;

function start(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => {
      out += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ p, url: `http://127.0.0.1:${m[1]}`, out: () => out });
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ p, code, out: () => out }));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
}

before(async () => {
  const transactions = {
    acct_test_everyday: [
      ...fx.history('acct_test_everyday', '2026-06-01', '2026-10-16', 1),
      fx.tx('acct_test_everyday', '2026-10-17', -725, 'AUTHORISATION ONLY - TEST SAAS', { id: 'txn_srv_pending', status: 'pending' }),
    ],
    acct_test_card: fx.history('acct_test_card', '2026-09-01', '2026-10-16', 2),
  };
  const fake = fakeRedbark({ ...fx, transactions });
  const l = await fake.listen();
  fakeSrv = l.server;
  home = mkdtempSync(join(tmpdir(), 'mint-srv-'));
  const s = await start({
    MINT_HOME: home, MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner',
    REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: l.base, REDBARK_WEBHOOK_SECRET: SECRET,
  });
  assert.ok(s.url, s.out());
  proc = s.p;
  base = s.url;
});

after(() => { proc?.kill('SIGTERM'); fakeSrv?.close(); });

const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const get = (path, headers = H) => fetch(base + path, { headers });
const send = (method, path, body, headers = {}) => fetch(base + path, { method, headers: { ...H, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('starts without the Redbark key: the bank feed is optional (manual accounts and CSV import work without it)', async () => {
  const s = await start({ MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-noenv-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off' });
  try {
    assert.ok(s.url, s.out());
    await new Promise((r) => setTimeout(r, 300)); // the start-up notes follow the listening line
    assert.match(s.out(), /bank feed is off/);
  } finally { s.p.kill('SIGTERM'); }
});

test('data and API routes need the gate identity', async () => {
  assert.equal((await get('/api/accounts', {})).status, 401);
  assert.equal((await get('/api/accounts', { 'remote-user': 'someone-else' })).status, 401);
  assert.equal((await get('/', {})).status, 401);
  assert.equal((await get('/api/accounts')).status, 200);
});

test('PWA assets load without the identity so install works', async () => {
  for (const p of ['/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon.svg']) {
    assert.equal((await get(p, {})).status, 200, p);
  }
});

test('security headers on every response', async () => {
  const r = await get('/');
  assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('every tab path serves the shell; unknown paths get a 404 in the shell', async () => {
  for (const p of ['/', '/transactions', '/budgets', '/tax', '/accounts', '/reports']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /<nav/);
  }
  const r = await get('/nope/at/all');
  assert.equal(r.status, 404);
  assert.match(await r.text(), /<nav/);
  assert.equal((await get('/api/nope')).status, 404);
});

test('the five-tab shell: new paths serve the shell, the worker caches them, routes.js ships first', async () => {
  for (const p of ['/spending', '/save', '/income', '/plan', '/more', '/invest', '/assets', '/rules', '/review']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /<nav/);
  }
  const html = await (await get('/')).text();
  assert.ok(html.indexOf('/routes.js?v=') > 0 && html.indexOf('/routes.js?v=') < html.indexOf('/core.js?v='), 'routes.js loads before core.js');
  // Income and Plan keep their scripts; Save and Invest has its own.
  assert.match(html, /\/save\.js\?v=/);
  assert.match(html, /\/plan\.js\?v=/);
  assert.match(html, /\/income\.js\?v=/);
  assert.equal((await get('/routes.js')).status, 200);
  assert.equal((await get('/plan.js')).status, 200);
  assert.equal((await get('/save.js')).status, 200);
  const sw = await (await get('/sw.js', {})).text();
  assert.match(sw, /\/routes\.js\?v=[0-9a-f]{10}/);
  assert.match(sw, /\/plan\.js\?v=[0-9a-f]{10}/);
  assert.match(sw, /\/save\.js\?v=[0-9a-f]{10}/);
  assert.match(sw, /"\/save"/);
  assert.match(sw, /"\/plan"/);
  assert.match(sw, /"\/income"/);
  assert.match(sw, /"\/more"/);
  assert.doesNotMatch(sw, /__[A-Z_]+__/);
});

test('Sync now pulls accounts, balances and transactions end to end', async () => {
  const r = await send('POST', '/api/sync', {});
  assert.equal(r.status, 202);
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await get('/api/sync')).json();
    if (!state.running) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.equal(state.running, false);
  assert.equal(state.lastError, null);
  const acc = await (await get('/api/accounts')).json();
  assert.equal(acc.accounts.length, 4);
  assert.equal(acc.connections.length, 2);
  const card = acc.accounts.find((a) => a.id === 'acct_test_card');
  assert.equal(card.balance_current, -50000);
  assert.ok(card.earliest_date);
  assert.ok(card.last_synced_at);
  assert.equal(acc.accounts.find((a) => a.id === 'acct_test_everyday').earliest_date, '2026-06-01');
  assert.ok(acc.sync.lastPollAt);
  assert.equal(acc.connections.find((c) => c.id === 'conn_test_beta').consent_warning, true);
  assert.equal(JSON.stringify(acc).includes(FAKE_KEY), false);
});

test('transactions list paginates newest first with a cursor', async () => {
  const first = await (await get('/api/transactions?limit=50')).json();
  assert.equal(first.items.length, 50);
  assert.equal(first.items[0].id, 'txn_srv_pending');
  assert.equal(first.items[0].status, 'pending');
  assert.ok(first.next);
  const second = await (await get(`/api/transactions?limit=50&cursor=${encodeURIComponent(first.next)}`)).json();
  assert.equal(second.items.length, 50);
  const ids = new Set([...first.items, ...second.items].map((t) => t.id));
  assert.equal(ids.size, 100);
  assert.ok(second.items[0].date <= first.items.at(-1).date);
  const only = await (await get('/api/transactions?account=acct_test_card&limit=200')).json();
  assert.ok(only.items.length > 0 && only.items.every((t) => t.account_id === 'acct_test_card'));
  assert.equal((await get('/api/transactions?limit=abc')).status, 400);
});

test('business flag toggles and validates', async () => {
  const r = await send('PATCH', '/api/accounts/acct_test_offset', { is_business: true });
  assert.equal(r.status, 200);
  const acc = await (await get('/api/accounts')).json();
  assert.equal(acc.accounts.find((a) => a.id === 'acct_test_offset').is_business, 1);
  assert.equal((await send('PATCH', '/api/accounts/acct_test_offset', { is_business: 'yes' })).status, 400);
  assert.equal((await send('PATCH', '/api/accounts/acct_nope', { is_business: true })).status, 404);
  assert.equal((await send('PATCH', '/api/accounts/acct_test_offset', '{bad')).status, 400);
});

test('cross-origin writes are refused', async () => {
  const r = await send('PATCH', '/api/accounts/acct_test_offset', { is_business: false }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('webhook path skips the identity check but demands a signature', async () => {
  const body = JSON.stringify({ id: 'dlv-srv', object: 'event', type: 'transactions.synced', data: { new: [], updated: [] }, metadata: {} });
  const unsigned = await fetch(base + '/api/redbark/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(unsigned.status, 401);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  const ok = await fetch(base + '/api/redbark/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-redbark-signature': `sha256=${sig}`, 'x-redbark-timestamp': String(t), 'x-redbark-delivery-id': 'dlv-srv' }, body });
  assert.equal(ok.status, 200);
});

test('the database file is private to the service user', () => {
  assert.equal(statSync(join(home, 'data', 'mint.db')).mode & 0o077, 0);
  assert.equal(statSync(join(home, 'data')).mode & 0o077, 0);
});
