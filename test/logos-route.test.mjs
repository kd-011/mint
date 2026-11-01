// /api/logo end to end: a real server against a fake Redbark, with a logo row
// seeded into the book before it starts. No network beyond loopback.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeRedbark, FAKE_KEY } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';
import { openDb } from '../lib/db.mjs';
import { putLogo } from '../lib/logos.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(900, 7)]);
let proc, base, fakeSrv;

function start(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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

const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const get = (path, headers = H) => fetch(base + path, { headers });
const put = (path, body, headers = H) => fetch(base + path, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  const transactions = {
    acct_test_everyday: [
      fx.tx('acct_test_everyday', '2026-10-10', -5000, 'WOOLWORTHS', { id: 'txn_logo_1' }),
      fx.tx('acct_test_everyday', '2026-10-11', -1200, 'OBSCURE BAKERY', { id: 'txn_logo_2' }),
    ],
  };
  const fake = fakeRedbark({ ...fx, transactions });
  const l = await fake.listen();
  fakeSrv = l.server;
  const home = mkdtempSync(join(tmpdir(), 'mint-logo-'));
  mkdirSync(join(home, 'data'));
  const db = openDb(join(home, 'data', 'mint.db'));
  putLogo(db, 'woolworths', { domain: 'woolworths.com.au', source: 'map', status: 'ok', image: PNG, type: 'image/png', fetchedAt: '2026-10-17T00:00:00Z' });
  putLogo(db, 'bank:alpha-bank', { domain: 'alpha.example.com', source: 'map', status: 'ok', image: PNG, type: 'image/png', fetchedAt: '2026-10-17T00:00:00Z' });
  putLogo(db, 'obscure bakery', { domain: null, source: 'map', status: 'none', fetchedAt: '2026-10-17T00:00:00Z' });
  db.close();
  const s = await start({ MINT_HOME: home, MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner', REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: l.base });
  proc = s.p;
  base = s.url;
  assert.equal((await fetch(`${base}/api/sync`, { method: 'POST', headers: H })).status, 202);
  for (let i = 0; i < 100; i++) {
    const st = await (await get('/api/sync')).json();
    if (!st.running) break;
    await new Promise((r) => setTimeout(r, 50));
  }
});
after(() => { proc?.kill('SIGTERM'); fakeSrv?.close(); });

test('GET /api/logo/<key> serves the cached image with a long cache lifetime and an ETag', async () => {
  const r = await get('/api/logo/woolworths');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('cache-control'), /max-age=31536000/);
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  const etag = r.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{16,}"$/);
  assert.ok(Buffer.compare(Buffer.from(await r.arrayBuffer()), PNG) === 0);
  const again = await get('/api/logo/woolworths', { ...H, 'if-none-match': etag });
  assert.equal(again.status, 304);
});

test('an unknown merchant, a miss row and a malformed key are all 404', async () => {
  for (const k of ['nobody', 'obscure%20bakery', '..%2Fetc%2Fpasswd', '%E0%A4%A', 'a'.repeat(200), 'UPPER']) {
    const r = await get(`/api/logo/${k}`);
    assert.equal(r.status, 404, k);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
});

test('the logo route sits behind the gate like the rest of /api', async () => {
  assert.equal((await get('/api/logo/woolworths', {})).status, 401);
  assert.equal((await get('/api/logo/woolworths', { 'remote-user': 'someone-else' })).status, 401);
  assert.equal((await put('/api/logo/woolworths', { domain: null }, {})).status, 401);
  assert.equal((await get('/api/logo/nobody', {})).status, 401, 'no 404 oracle without the gate');
});

test('the transactions payload carries the hint only for the merchant with a cached image', async () => {
  const { items } = await (await get('/api/transactions?limit=50')).json();
  const w = items.find((t) => t.id === 'txn_logo_1');
  const o = items.find((t) => t.id === 'txn_logo_2');
  assert.match(w.logo, /^\/api\/logo\/woolworths\?v=[0-9a-f]{8}$/);
  assert.equal(o.logo, null);
  const one = await (await get('/api/transactions/txn_logo_1')).json();
  assert.match(one.transaction.logo, /^\/api\/logo\/woolworths/);
  const hinted = await get(w.logo);
  assert.equal(hinted.status, 200);
});

test('setting a manual domain rejects private hosts with a 400 before any request is made', async () => {
  for (const d of ['127.0.0.1', 'localhost', 'http://169.254.169.254/', 'intranet.local', '10.0.0.1']) {
    const r = await put('/api/logo/woolworths', { domain: d });
    assert.equal(r.status, 400, d);
    assert.match((await r.json()).error, /domain/i);
  }
  assert.equal((await put('/api/logo/woolworths', {})).status, 400);
  assert.equal((await put('/api/logo/BAD%20KEY', { domain: 'example.com' })).status, 404);
  const cross = await fetch(`${base}/api/logo/woolworths`, { method: 'PUT', headers: { ...H, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ domain: null }) });
  assert.equal(cross.status, 403);
  // the cached image is untouched
  assert.equal((await get('/api/logo/woolworths')).status, 200);
});

test('clearing a logo drops the image and the hint but keeps the row so it is never looked up again', async () => {
  const r = await put('/api/logo/woolworths', { domain: null });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { key: 'woolworths', domain: null, logo: null, status: 'manual' });
  assert.equal((await get('/api/logo/woolworths')).status, 404);
  const { items } = await (await get('/api/transactions?limit=50')).json();
  assert.equal(items.find((t) => t.id === 'txn_logo_1').logo, null);
});

test('the service worker caches /api/logo images in their own capped cache, apart from the shell', async () => {
  const sw = await (await get('/sw.js', {})).text();
  assert.match(sw, /\/api\/logo\//);
  assert.match(sw, /mint-logos/);
  assert.match(sw, /LOGO_MAX\s*=\s*\d+/);
  assert.match(sw, /k !== CACHE && k !== LOGOS/, 'activate must not delete the logo cache');
  assert.doesNotMatch(sw, /__[A-Z_]+__/);
});

test('/api/accounts carries a logo URL for an account whose bank is cached and null for the rest, and the bank key is served', async () => {
  const { accounts } = await (await get('/api/accounts')).json();
  const alpha = accounts.filter((a) => a.institution === 'Alpha Bank');
  const beta = accounts.filter((a) => a.institution === 'Beta Mutual');
  assert.ok(alpha.length && beta.length);
  for (const a of alpha) assert.match(a.logo, /^\/api\/logo\/bank%3Aalpha-bank\?v=[0-9a-f]{8}$/);
  for (const a of beta) assert.equal(a.logo, null);
  const img = await get(alpha[0].logo);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await get('/api/logo/bank%3Anobody')).status, 404);
  assert.equal((await get('/api/logo/bank%3A', {})).status, 401);
});
