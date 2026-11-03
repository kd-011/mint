// scripts/local.mjs: your own book on this machine with no login proxy. The small front it puts up is
// what a stranger's browser talks to, so these check the things that would hurt: another site or a
// rebound DNS name must not reach the book, the real server stays behind the gate, and the book
// survives a restart. Also covers the demo, which shares the front.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refusal } from '../lib/localfront.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const kids = [];
after(() => { for (const k of kids) k.kill('SIGTERM'); });

function run(script, args, env) {
  return new Promise((res, rej) => {
    const clean = { PATH: process.env.PATH, ...env };
    const child = spawn(process.execPath, [join(ROOT, script), ...args], { env: clean, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(child);
    let out = '';
    const onData = (d) => { out += d; if (out.includes('ready: open')) res({ child, out: () => out }); };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => rej(new Error(`${script} exited ${c} before it was ready:\n${out}`)));
    setTimeout(() => rej(new Error(`${script} did not come up:\n${out}`)), 60_000);
  });
}
const stop = (child) => new Promise((res) => { child.removeAllListeners('exit'); child.on('exit', res); child.kill('SIGTERM'); });

// fetch() will not let a test set Host, and that is the header that matters here.
const raw = (port, { method = 'GET', path = '/api/accounts', headers = {}, body } = {}) => new Promise((res, rej) => {
  const r = request({ host: '127.0.0.1', port, method, path, headers }, (m) => {
    let t = ''; m.on('data', (d) => { t += d; }); m.on('end', () => res({ status: m.statusCode, text: t, headers: m.headers }));
  });
  r.on('error', rej);
  if (body) r.write(body);
  r.end();
});

test('only a loopback host gets in, and an origin has to match it', () => {
  for (const host of ['127.0.0.1:8981', 'localhost:8981', '[::1]:8981', '127.0.0.1', 'LOCALHOST:8981']) assert.equal(refusal({ host }), null, host);
  for (const host of ['evil.example', 'evil.example:8981', '192.168.1.20:8981', '127.0.0.1.evil.example:8981', 'localhost.evil.example', '', undefined]) assert.ok(refusal({ host }), `refuses ${host}`);
  assert.equal(refusal({ host: 'localhost:8981', origin: 'http://localhost:8981' }), null);
  assert.equal(refusal({ host: '127.0.0.1:8981', origin: 'http://127.0.0.1:8981' }), null);
  for (const origin of ['https://evil.example', 'http://127.0.0.1:9999', 'http://localhost:8981', 'null', 'not a url']) assert.ok(refusal({ host: '127.0.0.1:8981', origin }), `refuses ${origin}`);
});

test('local mode: an own book with no proxy, closed to other sites, that survives a restart', { timeout: 90_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'mint-local-'));
  const port = await freePort();
  const env = { MINT_HOME: home, MINT_PORT: String(port), MINT_SCHEDULER: 'off', MINT_FX_BASE: 'http://127.0.0.1:1', YAHOO_CHART_BASE: 'http://127.0.0.1:1', MINT_TZ: 'Australia/Sydney', MINT_HOST: '0.0.0.0' };
  let m = await run('scripts/local.mjs', [], env);
  assert.match(m.out(), new RegExp(`ready: open http://127\\.0\\.0\\.1:${port}/`));
  assert.doesNotMatch(m.out(), /ExperimentalWarning|MINT_CHAT_KEY|MINT_ANDROID/, 'the startup output is for a person');

  const host = `127.0.0.1:${port}`;
  const ok = await raw(port, { headers: { host } });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text).accounts, [], 'a fresh book is empty, not the demo');
  assert.equal((await raw(port, { path: '/healthz', headers: { host } })).status, 200);

  // DNS rebinding: a page on evil.example that resolves to 127.0.0.1 gets nothing, not even reads.
  const rebound = await raw(port, { headers: { host: `evil.example:${port}` } });
  assert.equal(rebound.status, 403);
  assert.doesNotMatch(rebound.text, /accounts/);

  // Another site posting into the book.
  const post = (extra) => raw(port, { method: 'POST', path: '/api/manual/accounts', headers: { host, 'content-type': 'application/json', ...extra }, body: JSON.stringify({ name: 'Everyday', institution: 'CommBank', type: 'transaction', currency: 'AUD', opening_balance: 500000, opening_date: '2026-01-01' }) });
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' })).status, 403);

  // The page itself, from either name a person might type.
  const made = await post({ origin: `http://127.0.0.1:${port}` });
  assert.equal(made.status, 201, made.text);
  const viaLocalhost = await raw(port, { method: 'POST', path: '/api/goals', headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Trip', target_amount: 100000 }) });
  assert.equal(viaLocalhost.status, 201, viaLocalhost.text);

  // What a client claims about itself is overwritten, and the real server is not the one answering on this port.
  const claimed = await raw(port, { headers: { host, 'remote-user': 'someone-else', 'x-mint-gate': 'wrong' } });
  assert.equal(claimed.status, 200);

  await stop(m.child);
  assert.ok(existsSync(join(home, 'data', 'mint.db')), 'the book is a file in MINT_HOME');
  m = await run('scripts/local.mjs', [], env);
  const again = JSON.parse((await raw(port, { headers: { host } })).text);
  assert.match(JSON.stringify(again), /Everyday/, 'the account is still there after a restart');
  await stop(m.child);

  // Moving to a real login proxy later: the same book opens under your own gate key.
  const realPort = await freePort();
  const key = 'k'.repeat(40);
  const real = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { ...env, MINT_PORT: String(realPort), MINT_HOST: '127.0.0.1', MINT_USER: 'owner', MINT_GATE_KEY: key, MINT_LOCK: 'off' }, stdio: 'ignore' });
  kids.push(real);
  let moved = null;
  for (let i = 0; i < 50 && !moved; i++) {
    try { moved = await raw(realPort, { headers: { host: `127.0.0.1:${realPort}`, 'remote-user': 'owner', 'x-mint-gate': key } }); } catch { await new Promise((z) => setTimeout(z, 200)); }
  }
  assert.equal(moved?.status, 200);
  assert.match(moved.text, /Everyday/);
  real.kill('SIGTERM');
});

test('the real server behind local mode only ever binds loopback', () => {
  const src = readFileSync(join(ROOT, 'scripts/local.mjs'), 'utf8');
  assert.match(src, /MINT_HOST: '127\.0\.0\.1'/);
  assert.match(src, /MINT_LOCAL_BIND/, 'only the container asks the front to listen wider');
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /^ {2}local:\n(?:.*\n)*? {4}profiles: \["local"\]/m);
  assert.match(compose, /"127\.0\.0\.1:8981:8981"/);
});

test('the demo takes a write from localhost as well as 127.0.0.1, and shows a page while it loads', { timeout: 90_000 }, async () => {
  const port = await freePort();
  const pending = run('scripts/demo-seed.mjs', [String(port)], {});
  let loading = null;
  for (let i = 0; i < 100 && !loading; i++) {
    try { const r = await raw(port, { path: '/', headers: { host: `127.0.0.1:${port}`, accept: 'text/html' } }); if (r.status === 503) loading = r; else break; } catch { await new Promise((z) => setTimeout(z, 100)); }
  }
  assert.ok(loading, 'a person who opens the page early sees a loading page, not a half-filled book');
  assert.match(loading.text, /demo data/i);
  const m = await pending;
  assert.doesNotMatch(m.out(), /ExperimentalWarning|MINT_CHAT_KEY|MINT_ANDROID|fixture home/, 'the startup output is for a person');
  const r = await raw(port, { method: 'POST', path: '/api/goals', headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Probe', target_amount: 100000 }) });
  assert.equal(r.status, 201, r.text);
  await stop(m.child);
});
