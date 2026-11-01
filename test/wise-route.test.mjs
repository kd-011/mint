// The Wise routes on a real server: with WISE_API_TOKEN unset the sync is
// silently off (no alert, no log row, the route says so); with a malformed
// token it is on and visibly failing without ever calling out or echoing the
// value. No test here can reach api.wise.com: the client is never built from
// a base other than the pinned one, and these cases stop before any request.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeRedbark, FAKE_KEY } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const procs = [];
const servers = [];

function start(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ url: `http://127.0.0.1:${m[1]}`, out: () => out });
    });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', () => resolve({ out: () => out }));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
}

async function boot(extra = {}) {
  const fake = fakeRedbark({ ...fx, transactions: {} });
  const l = await fake.listen();
  servers.push(l.server);
  const s = await start({
    MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-wise-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner',
    REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: l.base, ...extra,
  });
  assert.ok(s.url, s.out());
  return s;
}
const get = (s, path) => fetch(s.url + path, { headers: H });
const post = (s, path) => fetch(s.url + path, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}' });
const settled = async (s) => {
  for (let i = 0; i < 100; i++) {
    const st = await (await get(s, '/api/sync')).json();
    if (!st.running && st.finishedAt) return st;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('sync never finished');
};

after(() => { procs.forEach((p) => p.kill('SIGTERM')); servers.forEach((x) => x.close()); });

test('token unset: Wise sync is off, the route says so, and nothing is logged or alerted', async () => {
  const s = await boot();
  const accounts = await (await get(s, '/api/accounts')).json();
  assert.equal(accounts.sync.wise.enabled, false);
  const r = await post(s, '/api/wise/sync');
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /WISE_API_TOKEN is not set/);
  assert.equal((await (await get(s, '/api/wise/status')).json()).enabled, false);
  const list = await (await get(s, '/api/alerts')).json();
  assert.ok(!JSON.stringify(list).toLowerCase().includes('wise'));
  assert.ok(!(await (await get(s, '/api/accounts')).json()).log.some((l) => l.kind === 'wise'));
});

test('a malformed token is on and failing in the open, without echoing it', async () => {
  const bad = 'not a token with spaces';
  const s = await boot({ WISE_API_TOKEN: bad });
  assert.equal((await (await get(s, '/api/accounts')).json()).sync.wise.enabled, true);
  const r = await post(s, '/api/wise/sync');
  assert.equal(r.status, 202);
  await settled(s);
  const st = await (await get(s, '/api/wise/status')).json();
  assert.equal(st.enabled, true);
  assert.match(st.error, /malformed/i);
  const accounts = await (await get(s, '/api/accounts')).json();
  assert.ok(accounts.log.some((l) => l.kind === 'wise' && l.ok === 0));
  const alerts = JSON.stringify(await (await get(s, '/api/alerts')).json());
  assert.match(alerts, /Wise sync failing/);
  for (const body of [JSON.stringify(st), JSON.stringify(accounts), alerts, s.out()]) assert.ok(!body.includes(bad), 'the value is nowhere');
});

test('the Wise routes need the gate identity like every other', async () => {
  const s = await boot();
  assert.equal((await fetch(`${s.url}/api/wise/status`)).status, 401);
  assert.equal((await fetch(`${s.url}/api/wise/sync`, { method: 'POST' })).status, 401);
});
