// The fingerprint lock, enforced by the server: with the gate identity but no
// unlock cookie every data route answers 423, the lock endpoints, the shell,
// the PWA assets, /healthz, the webhook and the assistant's loopback bearer door stay
// as they were, and once a fingerprint is enrolled the lock cannot be switched
// off from the environment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { fakeRedbark, FAKE_KEY } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';
import { authenticator } from './fixtures/webauthn.mjs';
import { LOCK_COOKIE } from '../lib/lock.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';
// A made-up app signing certificate fingerprint, so the Android passkey origin is configured for these tests.
const CERT = Array.from({ length: 32 }, (_, i) => ((i * 11 + 5) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://mint.example.com';
const RP = 'mint.example.com';
const API = 'api-key-invented-for-lock-tests-0123456789abcdef';
const SECRET = 'whsec_lock_test_invented';
let proc, base, fakeSrv, home, env, out;

function start(extra) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => {
      o += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(o);
      if (m) resolve({ p, url: `http://127.0.0.1:${m[1]}`, out: () => o });
    });
    p.stderr.on('data', (d) => { o += d; });
    p.on('exit', (code) => resolve({ p, code, out: () => o }));
    setTimeout(() => reject(new Error(`server did not start: ${o}`)), 8000);
  });
}
const stop = (p) => new Promise((r) => { if (p.exitCode !== null) return r(); p.once('exit', r); p.kill('SIGTERM'); });

before(async () => {
  const fake = fakeRedbark({ ...fx, transactions: { acct_test_everyday: fx.history('acct_test_everyday', '2026-09-01', '2026-10-16', 2) } });
  const l = await fake.listen();
  fakeSrv = l.server;
  home = mkdtempSync(join(tmpdir(), 'mint-lock-srv-'));
  env = {
    MINT_HOME: home, MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_USER: 'owner', MINT_ORIGIN: ORIGIN, MINT_ANDROID_CERT_SHA256: CERT,
    REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: l.base, REDBARK_WEBHOOK_SECRET: SECRET, MINT_API_KEY: API,
  };
  const s = await start(env);
  assert.ok(s.url, s.out());
  proc = s.p;
  base = s.url;
  out = s.out;
});
after(async () => { if (proc) await stop(proc); fakeSrv?.close(); });

const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const get = (path, headers = H) => fetch(base + path, { headers });
const post = (path, body = {}, headers = {}) => fetch(base + path, { method: 'POST', headers: { ...H, origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const cookieOf = (r) => {
  const m = new RegExp(`${LOCK_COOKIE}=([^;]*)`).exec(r.headers.get('set-cookie') ?? '');
  return m ? `${LOCK_COOKIE}=${m[1]}` : null;
};

const SAMPLE = ['/api/accounts', '/api/transactions', '/api/budgets', '/api/review', '/api/sync', '/api/assistant/summary', '/api/lock/credentials'];
const phone = authenticator();
let cookie = null;

test('a fresh install is locked with nothing enrolled: status says set up', async () => {
  const r = await get('/api/lock/status');
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.locked, true);
  assert.equal(s.enrolled, 0);
  assert.equal(s.setup, true);
});

test('the lock endpoints still need the gate identity', async () => {
  assert.equal((await get('/api/lock/status', {})).status, 401);
  assert.equal((await post('/api/lock/challenge', {}, { 'remote-user': '' })).status, 401);
});

test('locked: a sample of data routes answer 423 {error: locked}', async () => {
  for (const p of SAMPLE) {
    const r = await get(p);
    assert.equal(r.status, 423, p);
    assert.deepEqual(await r.json(), { error: 'locked' }, p);
  }
  for (const [method, p] of [['POST', '/api/sync'], ['PATCH', '/api/accounts/acct_test_everyday'], ['POST', '/api/chat']]) {
    const r = await fetch(base + p, { method, headers: { ...H, origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 423, `${method} ${p}`);
  }
});

test('locked: the shell and its scripts load (they hold no data), so the lock screen can draw', async () => {
  for (const p of ['/', '/transactions', '/settings', '/style.css', '/core.js', '/lock.js', '/app.js']) assert.equal((await get(p)).status, 200, p);
  const html = await (await get('/')).text();
  assert.match(html, /id="lock"/);
  assert.match(html, /\/lock\.js\?v=/);
});

test('the service worker never caches an API response (only merchant logo images)', async () => {
  const sw = await (await get('/sw.js', {})).text();
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)\) return;/, 'every /api/ request but logos goes straight to the network');
  assert.match(sw, /\/\^image\\\/\/\.test/, 'the logo cache only keeps images');
});

test('assetlinks.json is public (no gate identity, no unlock) and carries the app certificate', async () => {
  const r = await get('/.well-known/assetlinks.json', {});
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/json/);
  const doc = await r.json();
  assert.equal(doc[0].target.package_name, 'io.github.kd011.mint');
  assert.equal(doc[0].target.sha256_cert_fingerprints.length, 1);
  assert.equal((await get('/.well-known/other.json', {})).status, 401);
});

test('locked: PWA assets, /healthz and the webhook stay open', async () => {
  for (const p of ['/healthz', '/manifest.webmanifest', '/sw.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']) {
    assert.equal((await get(p, {})).status, 200, p);
  }
  const body = JSON.stringify({ id: 'dlv-lock', object: 'event', type: 'transactions.synced', data: { new: [], updated: [] }, metadata: {} });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  const r = await fetch(base + '/api/redbark/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-redbark-signature': `sha256=${sig}`, 'x-redbark-timestamp': String(t), 'x-redbark-delivery-id': 'dlv-lock' }, body });
  assert.equal(r.status, 200);
});

test('locked: The assistant\'s loopback bearer door is unaffected', async () => {
  const r = await get('/api/assistant/summary', { authorization: `Bearer ${API}` });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).as_of, 'a real summary came back');
  assert.equal((await get('/api/assistant/summary', { authorization: 'Bearer wrong-wrong-wrong-wrong-wrong-wrong-wrong' })).status, 401);
});

test('first run: enrolling a fingerprint unlocks and turns the lock on', async () => {
  const o = await (await post('/api/lock/register-challenge')).json();
  assert.equal(o.rp.id, RP);
  const r = await post('/api/lock/register-verify', { ...phone.create({ challenge: o.challenge, origin: ORIGIN, rpId: RP }), label: 'Pixel' });
  assert.equal(r.status, 200, await r.clone().text());
  cookie = cookieOf(r);
  assert.ok(cookie, 'a cookie was set');
  const set = r.headers.get('set-cookie');
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(set.includes(part), part);
  for (const p of SAMPLE) assert.equal((await get(p, { ...H, cookie })).status, 200, p);
  const s = await (await get('/api/lock/status', { ...H, cookie })).json();
  assert.equal(s.locked, false);
  assert.equal(s.enrolled, 1);
  assert.equal(s.setup, false);
});

test('the unlock cookie alone is not an identity: the gate still applies', async () => {
  assert.equal((await get('/api/accounts', { cookie })).status, 401);
  assert.equal((await get('/api/accounts', { 'remote-user': 'someone-else', cookie })).status, 401);
});

test('once enrolled, another fingerprint needs an unlocked session', async () => {
  assert.equal((await post('/api/lock/register-challenge')).status, 423);
  const o = await (await post('/api/lock/register-challenge', {}, { cookie })).json();
  const second = authenticator();
  // A locked caller cannot spend an unlocked caller's challenge either.
  assert.equal((await post('/api/lock/register-verify', second.create({ challenge: o.challenge, origin: ORIGIN, rpId: RP }))).status, 423);
  const o2 = await (await post('/api/lock/register-challenge', {}, { cookie })).json();
  const r = await post('/api/lock/register-verify', { ...second.create({ challenge: o2.challenge, origin: ORIGIN, rpId: RP }), label: 'Laptop' }, { cookie });
  assert.equal(r.status, 200);
  const list = await (await get('/api/lock/credentials', { ...H, cookie })).json();
  assert.deepEqual(list.credentials.map((c) => c.label).sort(), ['Laptop', 'Pixel']);
  // Remove it again, from Settings.
  const del = await fetch(`${base}/api/lock/credentials/${second.id}`, { method: 'DELETE', headers: { ...H, origin: ORIGIN, cookie } });
  assert.equal(del.status, 200);
  const last = await fetch(`${base}/api/lock/credentials/${phone.id}`, { method: 'DELETE', headers: { ...H, origin: ORIGIN, cookie } });
  assert.equal(last.status, 409, 'the last fingerprint stays');
});

test('Lock now revokes the session server side', async () => {
  const r = await post('/api/lock/lock', {}, { cookie });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal((await get('/api/accounts', { ...H, cookie })).status, 423, 'the old cookie is dead even if the browser kept it');
  assert.equal((await (await get('/api/lock/status', { ...H, cookie })).json()).locked, true);
});

test('unlocking with the fingerprint: a good assertion opens, a bad one is refused and logged without secrets', async () => {
  const o = await (await post('/api/lock/challenge')).json();
  assert.deepEqual(o.allowCredentials.map((c) => c.id), [phone.id]);
  const bad = await post('/api/lock/verify', phone.get({ challenge: o.challenge, origin: ORIGIN, rpId: RP, uv: false }));
  assert.equal(bad.status, 401);
  assert.match((await bad.json()).error, /fingerprint|verif/i);
  assert.equal(cookieOf(bad), null);
  assert.doesNotMatch(out(), new RegExp(o.challenge), 'the challenge never reaches the log');
  assert.doesNotMatch(out(), new RegExp(phone.id), 'nor the credential id');
  assert.match(out(), /lock: refused/);

  const o2 = await (await post('/api/lock/challenge')).json();
  const ok = await post('/api/lock/verify', phone.get({ challenge: o2.challenge, origin: ORIGIN, rpId: RP }));
  assert.equal(ok.status, 200);
  cookie = cookieOf(ok);
  assert.equal((await get('/api/accounts', { ...H, cookie })).status, 200);
});

test('a forged or tampered cookie is locked', async () => {
  const [name, value] = cookie.split('=');
  assert.equal((await get('/api/accounts', { ...H, cookie: `${name}=${value.slice(0, -3)}xyz` })).status, 423);
  assert.equal((await get('/api/accounts', { ...H, cookie: `${name}=nothing` })).status, 423);
});

test('cross-origin lock calls are refused like any other write', async () => {
  assert.equal((await post('/api/lock/challenge', {}, { origin: 'https://evil.example' })).status, 403);
});

test('failed verifications are rate limited per IP', async () => {
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  let last;
  for (let i = 0; i < 21; i++) {
    last = await post('/api/lock/verify', { id: 'x', authenticatorData: 'AA', clientDataJSON: 'AA', signature: 'AA' }, ip);
  }
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
  // A different IP is not caught by it.
  const o = await (await post('/api/lock/challenge')).json();
  assert.equal((await post('/api/lock/verify', phone.get({ challenge: o.challenge, origin: ORIGIN, rpId: RP }))).status, 200);
});

test('once enrolled, MINT_LOCK=off refuses to start; lock-reset clears it; --disable allows off', async () => {
  await stop(proc);
  proc = null;
  const off = await start({ ...env, MINT_LOCK: 'off' });
  if (off.url) await stop(off.p);
  assert.notEqual(off.code, 0, 'started with the lock switched off after enrolment');
  assert.match(off.out(), /MINT_LOCK/);

  // A blank flag is the default: on.
  const blank = await start({ ...env, MINT_LOCK: '' });
  assert.ok(blank.url, blank.out());
  base = blank.url;
  assert.equal((await get('/api/accounts', { ...H, cookie })).status, 200, 'the session survives a restart');
  await stop(blank.p);

  // Break glass: clears fingerprints and sessions, the lock stays on and offers set up again.
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'lock-reset.mjs'), '--yes'], { env: { PATH: process.env.PATH, MINT_HOME: home } });
  const after1 = await start(env);
  assert.ok(after1.url, after1.out());
  base = after1.url;
  assert.equal((await get('/api/accounts', { ...H, cookie })).status, 423);
  assert.equal((await (await get('/api/lock/status')).json()).setup, true);
  await stop(after1.p);
  const stillOff = await start({ ...env, MINT_LOCK: 'off' });
  if (stillOff.url) await stop(stillOff.p);
  assert.notEqual(stillOff.code, 0, 'a plain reset keeps the lock on');

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'lock-reset.mjs'), '--yes', '--disable'], { env: { PATH: process.env.PATH, MINT_HOME: home } });
  const offNow = await start({ ...env, MINT_LOCK: 'off' });
  assert.ok(offNow.url, offNow.out());
  proc = offNow.p;
  base = offNow.url;
  assert.match(offNow.out(), /lock off/i);
  assert.equal((await get('/api/accounts')).status, 200);
});
