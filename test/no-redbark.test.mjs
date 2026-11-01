// A self-hoster with no Redbark account: the server starts, says once that the
// bank feed is off, runs no poll or reconcile, logs no Redbark error over a
// whole scheduler cycle, and tells the page there is no feed so the screens
// never show a Redbark error to someone who never configured it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.mjs';
import { createIngest } from '../lib/ingest.mjs';
import { dueSync } from '../lib/schedule.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const procs = [];
after(() => { for (const p of procs) p.kill('SIGTERM'); });

function start(extra = {}) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-nors-')), MINT_PORT: '0', MINT_LOCK: 'off', MINT_USER: 'owner', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', ...extra };
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    let code = null;
    let seen = false;
    p.on('exit', (c) => { code = c; });
    const done = (url) => resolve({ p, url, out: () => out, code: () => code });
    p.stdout.on('data', (d) => { out += d; const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m && !seen) { seen = true; setTimeout(() => done(`http://127.0.0.1:${m[1]}`), 300); } }); // the start-up notes follow the listening line
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', () => setTimeout(() => done(null), 50));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
}

test('the server starts with REDBARK_API_KEY unset and says once that the bank feed is off', async () => {
  const s = await start();
  assert.ok(s.url, `should be listening: ${s.out()}`);
  assert.equal(s.code(), null);
  const lines = s.out().split('\n').filter((l) => /bank feed/i.test(l));
  assert.equal(lines.length, 1, s.out());
  assert.match(lines[0], /REDBARK_API_KEY/);
  assert.match(lines[0], /poll/);
  assert.match(lines[0], /reconcile/);
  assert.match(lines[0], /CSV/);
});

test('the accounts payload tells the page there is no bank feed, and Sync now answers plainly instead of reaching for Redbark', async () => {
  const s = await start();
  const a = await (await fetch(`${s.url}/api/accounts`, { headers: H })).json();
  assert.equal(a.sync.redbark, false);
  assert.deepEqual(a.accounts, []);
  const r = await fetch(`${s.url}/api/sync`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.match(body.error, /no bank feed/i);
  assert.doesNotMatch(body.error, /redbark \d|unauthor|401|api key (missing|invalid)/i);
  const st = await (await fetch(`${s.url}/api/sync`, { headers: H })).json();
  assert.equal(st.lastError, null);
});

test('a scheduler cycle with no key logs no Redbark error and writes no failed sync', async () => {
  const s = await start({ MINT_SCHEDULER: 'on', MINT_FX_BASE: 'http://127.0.0.1:1', YAHOO_CHART_BASE: 'http://127.0.0.1:1' });
  assert.ok(s.url, s.out());
  await new Promise((r) => setTimeout(r, 9500)); // the first poll tick is at 5s, the quote tick at 8s
  const out = s.out();
  assert.doesNotMatch(out, /redbark \d|redbark network|\bpoll failed|reconcile failed|unauthori[sz]ed|invalid api key|api key missing/i, out);
  const a = await (await fetch(`${s.url}/api/accounts`, { headers: H })).json();
  assert.equal(a.sync.redbark, false);
  assert.deepEqual(a.log, [], 'no sync log rows at all');
  assert.equal(a.sync.lastError, null);
  assert.equal(a.sync.lastPollAt, null, 'no poll ever ran');
  assert.equal(a.sync.nextPollAt, null, 'nothing is scheduled to poll');
});

test('ingest with no client: poll and reconcile are no-ops that log nothing, write no sync row and never touch Redbark', async () => {
  const db = openDb(':memory:');
  const lines = [];
  const ingest = createIngest({ db, client: null, log: (m) => lines.push(m) });
  for (const kind of ['poll', 'reconcile', 'snapshot']) {
    const r = await ingest.runSync(kind);
    assert.equal(r.ok, true, `${kind}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(lines, []);
  assert.equal(db.prepare('SELECT count(*) n FROM sync_log').get().n, 0);
  assert.equal(ingest.state().lastError, null);
  assert.equal(ingest.feeds().redbark, false);
});

test('the scheduler rule still says what is due; the server is what declines to run it without a feed', () => {
  assert.equal(dueSync({ now: new Date('2026-11-01T10:00:00Z'), lastReconcile: null, lastPoll: null }), 'reconcile');
});

test('a key that is set keeps the feed on', async () => {
  const s = await start({ REDBARK_API_KEY: 'rbk_test_invented', REDBARK_API_BASE: 'http://127.0.0.1:1' });
  assert.ok(s.url, s.out());
  const a = await (await fetch(`${s.url}/api/accounts`, { headers: H })).json();
  assert.equal(a.sync.redbark, true);
  assert.doesNotMatch(s.out(), /bank feed is off/i);
});
