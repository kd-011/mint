// The gate's shared secret (MINT_GATE_KEY): caddy injects X-Mint-Gate on every
// request it proxies, so a forged Remote-User sent straight to the port is
// refused. PWA assets, /healthz, the HMAC webhook and the loopback bearer door
// stay exempt, exactly as they are exempt from the identity check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { fakeRedbark, FAKE_KEY } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = 'gate-key-invented-for-tests-0123456789abcdef';
const API = 'api-key-invented-for-tests-0123456789abcdef';
const SECRET = 'whsec_gate_test_invented';
let proc, base, fakeSrv, home, env;

function start(extra) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ p, url: `http://127.0.0.1:${m[1]}`, out: () => out });
    });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ p, code, out: () => out }));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
}
const stop = (p) => new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); });

before(async () => {
  const fake = fakeRedbark({ ...fx, transactions: { acct_test_everyday: fx.history('acct_test_everyday', '2026-09-01', '2026-10-16', 2) } });
  const l = await fake.listen();
  fakeSrv = l.server;
  home = mkdtempSync(join(tmpdir(), 'mint-gate-'));
  env = {
    MINT_HOME: home, MINT_PORT: '0', MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner',
    REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: l.base, REDBARK_WEBHOOK_SECRET: SECRET, MINT_API_KEY: API,
  };
  const s = await start({ ...env, MINT_GATE_KEY: GATE });
  assert.ok(s.url, s.out());
  proc = s.p;
  base = s.url;
});
after(() => { proc?.kill('SIGTERM'); fakeSrv?.close(); });

const get = (path, headers = {}) => fetch(base + path, { headers });

test('a gate key shorter than 32 characters stops the server starting', async () => {
  const s = await start({ ...env, MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-gate-short-')), MINT_GATE_KEY: 'too-short' });
  if (s.url) await stop(s.p);
  assert.notEqual(s.code, 0);
  assert.match(s.out(), /MINT_GATE_KEY/);
  assert.doesNotMatch(s.out(), /too-short/);
});

test('a forged Remote-User without the gate key gets 401', async () => {
  for (const p of ['/api/accounts', '/', '/transactions', '/app.js']) {
    assert.equal((await get(p, { 'remote-user': 'owner' })).status, 401, p);
  }
});

test('a wrong gate key gets 401, the right one with the identity gets in', async () => {
  assert.equal((await get('/api/accounts', { 'remote-user': 'owner', 'x-mint-gate': 'wrong-wrong-wrong-wrong-wrong-wrong-wrong' })).status, 401);
  assert.equal((await get('/api/accounts', { 'remote-user': 'owner', 'x-mint-gate': GATE.slice(0, -1) })).status, 401);
  assert.equal((await get('/api/accounts', { 'x-mint-gate': GATE })).status, 401, 'the key alone is not an identity');
  assert.equal((await get('/api/accounts', { 'remote-user': 'someone-else', 'x-mint-gate': GATE })).status, 401);
  assert.equal((await get('/api/accounts', { 'remote-user': 'owner', 'x-mint-gate': GATE })).status, 200);
  assert.equal((await get('/', { 'remote-user': 'owner', 'x-mint-gate': GATE })).status, 200);
});

test('PWA assets and /healthz stay open without the key', async () => {
  for (const p of ['/healthz', '/manifest.webmanifest', '/sw.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']) {
    assert.equal((await get(p)).status, 200, p);
  }
});

test('the HMAC webhook stays open without the key', async () => {
  const body = JSON.stringify({ id: 'dlv-gate', object: 'event', type: 'transactions.synced', data: { new: [], updated: [] }, metadata: {} });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  const r = await fetch(base + '/api/redbark/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-redbark-signature': `sha256=${sig}`, 'x-redbark-timestamp': String(t), 'x-redbark-delivery-id': 'dlv-gate' }, body });
  assert.equal(r.status, 200);
});

test('the loopback bearer door stays open without the gate key, and the gate header makes it a proxied call', async () => {
  assert.equal((await get('/api/assistant/summary', { authorization: `Bearer ${API}` })).status, 200);
  assert.equal((await get('/api/assistant/summary', { authorization: `Bearer ${API}`, 'x-mint-gate': GATE })).status, 401);
});

test('once enabled, the server refuses to start without the gate key', async () => {
  await stop(proc);
  proc = null;
  const off = await start(env);
  if (off.url) await stop(off.p);
  assert.notEqual(off.code, 0, 'started with the gate key missing');
  assert.match(off.out(), /MINT_GATE_KEY/);
  const on = await start({ ...env, MINT_GATE_KEY: GATE });
  assert.ok(on.url, on.out());
  proc = on.p;
  base = on.url;
  assert.equal((await get('/api/accounts', { 'remote-user': 'owner' })).status, 401);
  assert.equal((await get('/api/accounts', { 'remote-user': 'owner', 'x-mint-gate': GATE })).status, 200);
});
