// Retrying a chat reply that broke mid-stream must not apply the same write
// twice. The page sends a request_id with each question; Mint remembers which
// writes the assistant made during that request, and a resend of the same request gets
// the earlier answer (same undo token) instead of a second write. A new
// question, or a write whose undo was used, applies as normal.
// A real Mint server on a throwaway book, a fake assistant that writes through the
// bearer door and then drops the stream. Invented data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_KEY } from './fixtures/fake-redbark.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';

const { ChatModel: M } = createRequire(import.meta.url)('../public/chat-model.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_KEY = 'c0ffee'.repeat(8);
const API_KEY = 'a'.repeat(40);
const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

let assistant, mint, base;

// The fake assistant: "lot" adds one share lot through the door, tells the page
// about it, then drops the stream. "lot-finish" does the same and completes.
// "other" adds a different lot.
function startAssistant() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        const body = JSON.parse(raw || '{}');
        const msg = String(body.message ?? '');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sse('start', { conversation_id: body.conversation_id }));
        const units = msg.startsWith('other') ? 7 : 5;
        const w = await fetch(`${base}/api/assistant/holdings/VAS/lots`, {
          method: 'POST', headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ date: '2026-10-01', units, price: 98 }),
        });
        const out = await w.json();
        res.write(sse('undo', { op: out.op, summary: out.summary, token: out.undo.token, expires_at: out.undo.expires_at }));
        res.write(sse('delta', { text: 'Logged it, ' }));
        if (msg.startsWith('lot-finish')) { res.write(sse('done', { reply: 'Logged it.' })); res.end(); } else setTimeout(() => res.destroy(), 30);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function startMint(env) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'mint-retry-'));
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
      env: { PATH: process.env.PATH, MINT_HOME: home, MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner', REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: 'http://127.0.0.1:9', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => {
      out += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ p, url: `http://127.0.0.1:${m[1]}`, out: () => out });
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', (code) => resolve({ p, code, out: () => out }));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
}

const door = (path, body) => fetch(`${base}/api/assistant${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
// With lots a holding's units are the sum of them, so every extra lot shows here.
const units = async () => (await (await door('/holdings')).json()).holdings[0].units;

before(async () => {
  assistant = await startAssistant();
  mint = await startMint({ MINT_CHAT_KEY: CHAT_KEY, MINT_CHAT_URL: `http://127.0.0.1:${assistant.address().port}`, MINT_API_KEY: API_KEY });
  assert.ok(mint.url, mint.out());
  base = mint.url;
  const h = await door('/holdings', { ticker: 'VAS', exchange: 'ASX', lots: [{ date: '2026-01-02', units: 100, price: 90 }] });
  assert.equal(h.status, 201, await h.text());
});
after(() => { mint?.p.kill('SIGTERM'); assistant?.close(); assistant?.closeAllConnections?.(); });

async function turn(message, request_id) {
  const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ conversation_id: 'conv_r', message, ...(request_id ? { request_id } : {}) }) });
  assert.equal(res.status, 200, await res.clone().text());
  let rest = '';
  const out = [];
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    const r = M.parseSse(rest, dec.decode(chunk, { stream: true }));
    rest = r.rest;
    out.push(...r.events);
  }
  return out;
}
const undoOf = (evs) => evs.find((e) => e.event === 'undo')?.data;

test('a retry after a broken stream applies the write once and hands back the same undo token', async () => {
  const u0 = await units();
  const first = await turn('lot please', 'q_retry_one');
  assert.equal(first.at(-1).event, 'error');
  assert.equal(first.at(-1).data.code, 'stream-broken');
  const tok = undoOf(first);
  assert.ok(tok?.token);
  assert.equal(await units(), u0 + 5, 'applied once');

  const second = await turn('lot please', 'q_retry_one');
  assert.equal(undoOf(second).token, tok.token, 'the resend gets the first undo, not a new one');
  assert.equal(await units(), u0 + 5, 'not applied twice');

  // The undo from the first reply still works, once.
  const un = await fetch(`${base}/api/chat/undo/${tok.token}`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(un.status, 200, await un.text());
  assert.equal(await units(), u0);
});

test('a new question, with its own request id, is a new write', async () => {
  const u0 = await units();
  await turn('lot please', 'q_fresh_a');
  await turn('lot please', 'q_fresh_b');
  assert.equal(await units(), u0 + 10);
});

test('a different write on the retry applies; the same one is not repeated', async () => {
  const u0 = await units();
  await turn('lot please', 'q_diff');
  await turn('other please', 'q_diff');
  assert.equal(await units(), u0 + 12, 'the other lot is new, the first is not repeated');
});

test('if the first write was undone before the retry, the retry applies it again', async () => {
  const u0 = await units();
  const first = await turn('lot please', 'q_undone');
  const un = await fetch(`${base}/api/chat/undo/${undoOf(first).token}`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(un.status, 200);
  assert.equal(await units(), u0);
  const second = await turn('lot please', 'q_undone');
  assert.notEqual(undoOf(second).token, undoOf(first).token);
  assert.equal(await units(), u0 + 5);
});

test('a finished turn resent with the same id is not repeated either', async () => {
  const u0 = await units();
  await turn('lot-finish please', 'q_done');
  await turn('lot-finish please', 'q_done');
  assert.equal(await units(), u0 + 5);
});

test('a bad request id is a 400, and no id keeps the old behaviour', async () => {
  const bad = await fetch(`${base}/api/chat`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ conversation_id: 'conv_r', message: 'hi', request_id: 'no spaces allowed' }) });
  assert.equal(bad.status, 400);
  const u0 = await units();
  await turn('lot-finish please');
  await turn('lot-finish please');
  assert.equal(await units(), u0 + 10);
});
