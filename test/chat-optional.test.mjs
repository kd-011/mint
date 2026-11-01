// Assistant chat is optional: the page is served with the chat off unless MINT_CHAT_KEY
// is set, and with the key set it is served on (behaviour for a configured install).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_KEY } from './fixtures/gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const CHAT_KEY = 'chat-key-for-tests-0123456789abcdef0123';

function start(extra) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
      env: { PATH: process.env.PATH, MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-chatopt-')), MINT_PORT: '0', MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner', MINT_GATE_KEY: GATE_KEY, REDBARK_API_KEY: 'rbk_live_xxx', ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) resolve({ p, url: `http://127.0.0.1:${m[1]}` }); });
    p.stderr.on('data', (d) => { out += d; });
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
}

async function chatFlag(extra) {
  const s = await start(extra);
  try {
    const html = await (await fetch(`${s.url}/`, { headers: H })).text();
    const core = /\/core\.js\?v=[0-9a-f]+/.exec(html)[0];
    const js = await (await fetch(`${s.url}${core}`, { headers: H })).text();
    const flag = /const CHAT_ON = '(on|off)' === 'on';/.exec(js);
    assert.ok(flag, 'core.js carries the chat switch');
    const api = await fetch(`${s.url}/api/chat`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ conversation_id: 'c1', message: 'hi' }) });
    return { flag: flag[1], apiStatus: api.status };
  } finally {
    s.p.kill('SIGTERM');
  }
}

test('with no MINT_CHAT_KEY the chat UI is off and /api/chat answers not configured', async () => {
  const r = await chatFlag({});
  assert.equal(r.flag, 'off');
  assert.equal(r.apiStatus, 503);
});

test('with MINT_CHAT_KEY set the chat UI is on', async () => {
  const r = await chatFlag({ MINT_CHAT_KEY: CHAT_KEY });
  assert.equal(r.flag, 'on');
  assert.notEqual(r.apiStatus, 503, 'configured: the request goes on to the assistant (which is not running here)');
});
