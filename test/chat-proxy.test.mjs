// The in-app chat's server side: /api/chat proxies to the assistant over loopback with
// the dedicated key, streams the reply through as it arrives, maps the assistant's
// refusals to plain text without ever looking like a sign-out, rate limits, and
// never logs a message. /api/chat/undo and /api/chat/confirm are the browser's
// way to the same undo and confirm tokens the bearer door issues. A fake assistant
// stands in for the real one; the real Mint server runs against a throwaway book.
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
const CHAT_KEY = 'c0ffee'.repeat(8); // 48 hex, invented
const API_KEY = 'a'.repeat(40);
const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// a fake assistant

let assistant, assistantUrl;
const seen = []; // what the fake received, minus nothing: the test checks the headers
let aborted = 0;

function startAssistant() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        const msg = String(body.message ?? '');
        const refuse = (status, code, error) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, code, error })); };
        if (req.headers.authorization !== `Bearer ${CHAT_KEY}`) return refuse(401, 'bad-key', 'wrong key');
        if (msg.startsWith('refuse-busy')) return refuse(409, 'busy', 'still answering the last message in this conversation');
        if (msg.startsWith('refuse-daily')) return refuse(429, 'daily-limit', 'the daily limit of 100 chat turns is used up');
        if (msg.startsWith('refuse-paused')) return refuse(423, 'paused', 'The assistant is paused');
        if (msg.startsWith('refuse-key')) return refuse(401, 'bad-key', 'wrong key');
        if (msg.startsWith('refuse-loopback')) return refuse(403, 'not-loopback', 'not from loopback');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(sse('start', { conversation_id: body.conversation_id, session_id: 's_1' }));
        if (msg.startsWith('stream')) {
          res.write(sse('tool', { name: 'mint_cycle', label: 'Checking the pay cycle' }));
          setTimeout(() => res.write(sse('delta', { text: 'You have ' })), 20);
          setTimeout(() => res.write(sse('delta', { text: '$420 left.' })), 60);
          setTimeout(() => { res.write(sse('done', { reply: 'You have $420 left.' })); res.end(); }, 100);
        } else if (msg.startsWith('change')) {
          res.write(sse('undo', { op: 'recategorise', summary: 'Moved 3 rows to Fuel', token: 'u_faketoken0123456789', expires_at: '2026-10-18T02:00:00Z' }));
          res.write(sse('delta', { text: 'Done.' }));
          res.write(sse('done', { reply: 'Done.' }));
          res.end();
        } else if (msg.startsWith('error')) {
          res.write(sse('error', { error: 'the model run failed: exit 1', code: 'turn-failed' }));
          res.end();
        } else if (msg.startsWith('cut')) {
          res.write(sse('delta', { text: 'half a rep' }));
          setTimeout(() => res.destroy(), 40);
        } else if (msg.startsWith('hang')) {
          res.write(sse('delta', { text: 'thinking' }));
          res.on('close', () => { aborted += 1; });
        } else {
          res.write(sse('done', { reply: 'ok' }));
          res.end();
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// a real Mint server

function startMint(env) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'mint-chat-'));
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

let mint, base;
before(async () => {
  assistant = await startAssistant();
  assistantUrl = `http://127.0.0.1:${assistant.address().port}`;
  mint = await startMint({ MINT_CHAT_KEY: CHAT_KEY, MINT_CHAT_URL: assistantUrl, MINT_API_KEY: API_KEY });
  assert.ok(mint.url, mint.out());
  base = mint.url;
});
after(() => { mint?.p.kill('SIGTERM'); assistant?.close(); assistant?.closeAllConnections?.(); });

const chat = (message, { id = 'conv_1', headers = H, url = base, signal } = {}) =>
  fetch(`${url}/api/chat`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ conversation_id: id, message }), signal });

// Read a whole event stream through the same parser the page uses.
async function events(res) {
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

// the proxy

test('chat needs the sign-in gate like every other route', async () => {
  const r = await chat('stream please', { headers: {} });
  assert.equal(r.status, 401);
  // The bearer key opens /api/assistant/ only, never the browser chat route.
  const k = await chat('stream please', { headers: { authorization: `Bearer ${API_KEY}` } });
  assert.equal(k.status, 403);
});

test('a cross-origin post is refused', async () => {
  const r = await chat('stream please', { headers: { ...H, origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('streams the assistant events through in order, as they arrive', async () => {
  const r = await chat('stream: how much is left?');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/event-stream/);
  assert.match(r.headers.get('cache-control'), /no-store|no-cache/);
  const first = Date.now();
  const stamps = [];
  const dec = new TextDecoder();
  let rest = '';
  const evs = [];
  for await (const chunk of r.body) {
    const p = M.parseSse(rest, dec.decode(chunk, { stream: true }));
    rest = p.rest;
    for (const e of p.events) { evs.push(e); stamps.push(Date.now() - first); }
  }
  assert.deepEqual(evs.map((e) => e.event), ['start', 'tool', 'delta', 'delta', 'done']);
  assert.equal(evs[1].data.label, 'Checking the pay cycle');
  assert.equal(evs.at(-1).data.reply, 'You have $420 left.');
  assert.ok(stamps.at(-1) - stamps[0] >= 60, 'the deltas arrive spread out, not buffered into one lump');
});

test('The assistant receives the dedicated key and the message, and no proxy headers', async () => {
  seen.length = 0;
  await events(await chat('stream: headers', { id: 'conv_hdr' }));
  const s = seen.at(-1);
  assert.equal(s.method, 'POST');
  assert.equal(s.url, '/api/mint/chat');
  assert.equal(s.headers.authorization, `Bearer ${CHAT_KEY}`);
  assert.deepEqual(s.body, { conversation_id: 'conv_hdr', message: 'stream: headers' });
  for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'remote-user', 'x-mint-gate', 'cookie']) assert.equal(s.headers[h], undefined, h);
  assert.equal(s.headers.host, `127.0.0.1:${assistant.address().port}`);
});

test('the key never reaches the browser', async () => {
  const r = await chat('stream: leak check');
  const text = JSON.stringify([...r.headers]) + (await r.text());
  assert.ok(!text.includes(CHAT_KEY));
  const bad = await chat('refuse-key');
  assert.ok(!(JSON.stringify([...bad.headers]) + (await bad.text())).includes(CHAT_KEY));
});

test('the page never gets the key either', async () => {
  for (const f of ['/chat.js', '/chat-model.js', '/app.js', '/']) {
    const r = await fetch(base + f, { headers: H });
    assert.ok(!(await r.text()).includes(CHAT_KEY), f);
  }
});

test('an applied change and a confirm both reach the page as events', async () => {
  const evs = await events(await chat('change: move fuel'));
  const undo = evs.find((e) => e.event === 'undo');
  assert.equal(undo.data.summary, 'Moved 3 rows to Fuel');
  assert.match(undo.data.token, /^u_/);
});

test('an error event from the assistant passes through with its real text', async () => {
  const evs = await events(await chat('error: boom'));
  const e = evs.find((x) => x.event === 'error');
  assert.equal(e.data.error, 'the model run failed: exit 1');
  assert.equal(e.data.code, 'turn-failed');
});

test('a stream cut off mid-reply ends with an error event, not a silent stop', async () => {
  const evs = await events(await chat('cut: this one drops'));
  assert.equal(evs.find((x) => x.event === 'delta')?.data.text, 'half a rep');
  const e = evs.at(-1);
  assert.equal(e.event, 'error');
  assert.equal(e.data.code, 'stream-broken');
  assert.ok(e.data.error.length > 10);
});

test('refusals before a turn come back as JSON with a code, never as a sign-out', async () => {
  const cases = [
    ['refuse-busy', 409, 'busy'],
    ['refuse-daily', 429, 'daily-limit'],
    ['refuse-paused', 423, 'paused'],
  ];
  for (const [msg, status, code] of cases) {
    const r = await chat(msg);
    assert.equal(r.status, status, msg);
    assert.match(r.headers.get('content-type'), /application\/json/);
    const b = await r.json();
    assert.equal(b.code, code);
    assert.ok(b.error.length > 5);
  }
  // The assistant rejecting Mint's key (401) or its loopback check (403) is Mint's fault, not the browser's session.
  for (const msg of ['refuse-key', 'refuse-loopback']) {
    const r = await chat(msg);
    assert.equal(r.status, 502, msg);
    const b = await r.json();
    assert.equal(b.code, 'assistant-rejected');
    assert.match(b.error, /The assistant/);
  }
});

test('The assistant being down says so plainly', async () => {
  const dead = createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  const m = await startMint({ MINT_CHAT_KEY: CHAT_KEY, MINT_CHAT_URL: `http://127.0.0.1:${port}` });
  try {
    const r = await chat('stream hello', { url: m.url });
    assert.equal(r.status, 502);
    const b = await r.json();
    assert.equal(b.code, 'unreachable');
    assert.match(b.error, /not reachable/i);
    assert.match(b.error, /The assistant/);
  } finally { m.p.kill('SIGTERM'); }
});

test('without a chat key the route says chat is not set up', async () => {
  const m = await startMint({ MINT_CHAT_URL: assistantUrl });
  try {
    const r = await chat('stream hello', { url: m.url });
    assert.equal(r.status, 503);
    const b = await r.json();
    assert.equal(b.code, 'not-configured');
    assert.match(b.error, /MINT_CHAT_KEY/);
  } finally { m.p.kill('SIGTERM'); }
});

test('bad requests are 400 with the reason', async () => {
  for (const [body, re] of [
    [{ conversation_id: 'ok_id', message: '' }, /message/i],
    [{ conversation_id: 'ok_id', message: '   ' }, /message/i],
    [{ conversation_id: 'ok_id', message: 'x'.repeat(8001) }, /8000/],
    [{ conversation_id: 'has spaces!', message: 'hi' }, /conversation/i],
    [{ conversation_id: 'x'.repeat(101), message: 'hi' }, /conversation/i],
    [{ message: 'hi' }, /conversation/i],
    [{ conversation_id: 'ok_id', message: 42 }, /message/i],
  ]) {
    const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    const b = await r.json();
    assert.match(b.error, re);
    assert.equal(b.code, 'bad-request');
  }
  const get = await fetch(`${base}/api/chat`, { headers: H });
  assert.equal(get.status, 405);
});

test('the client going away stops the upstream turn', async () => {
  const before = aborted;
  const ac = new AbortController();
  const r = await chat('hang: never finishes', { signal: ac.signal });
  const reader = r.body.getReader();
  await reader.read();
  ac.abort();
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(aborted, before + 1);
});

test('a message body is never written to the log', async () => {
  const marker = 'ZEBRA-MARKER-7731-private-words';
  await events(await chat(`stream: ${marker}`));
  await events(await chat(`error: ${marker}`));
  await (await chat(`refuse-busy ${marker}`)).text();
  await events(await chat(`cut: ${marker}`));
  const log = mint.out();
  assert.ok(!log.includes(marker));
  assert.ok(!log.includes(CHAT_KEY));
});

test('the route is rate limited, and says when to try again', async () => {
  const m = await startMint({ MINT_CHAT_KEY: CHAT_KEY, MINT_CHAT_URL: assistantUrl });
  try {
    let limited = null;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await chat(`quick ${i}`, { url: m.url });
      if (r.status === 429) limited = r; else await r.text();
    }
    assert.ok(limited, 'a 429 within 40 quick messages');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const b = await limited.json();
    assert.equal(b.code, 'rate-limited');
  } finally { m.p.kill('SIGTERM'); }
});

// undo and confirm from the browser

const door = (path, body) => fetch(`${base}/api/assistant${path}`, { method: 'POST', headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const browser = (path, body = {}, headers = H) => fetch(`${base}/api/chat${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('undo: the browser route undoes an applied change once', async () => {
  const made = await door('/rules', { pattern: 'UNDO TEST SHOP', category: 'Groceries' });
  assert.equal(made.status, 201, await made.clone().text());
  const rule = await made.json();
  assert.match(rule.undo.token, /^u_/);
  const gone = await browser(`/undo/${rule.undo.token}`, {}, {});
  assert.equal(gone.status, 401, 'needs the gate too');
  const r = await browser(`/undo/${rule.undo.token}`);
  assert.equal(r.status, 200, await r.clone().text());
  const b = await r.json();
  assert.equal(b.undone, true);
  assert.match(b.summary, /^Undone:/);
  const again = await browser(`/undo/${rule.undo.token}`);
  assert.equal(again.status, 410);
  assert.ok((await again.json()).error.length > 5);
});

test('undo with an unknown token is 404 with a message', async () => {
  const r = await browser('/undo/u_doesnotexistdoesnotexistdoesnotexist12');
  assert.equal(r.status, 404);
  assert.ok((await r.json()).error);
});

test('confirm: the browser route applies a held change and hands back its undo', async () => {
  const made = await (await door('/rules', { pattern: 'CONFIRM TEST SHOP', category: 'Groceries' })).json();
  const held = await door(`/rules/${made.rule.id}/delete`);
  assert.equal(held.status, 202, await held.clone().text());
  const h = await held.json();
  assert.equal(h.needs_confirm, true);
  assert.match(h.token, /^c_/);
  const r = await browser(`/confirm/${h.token}`, { op: h.op });
  assert.equal(r.status, 200, await r.clone().text());
  const b = await r.json();
  assert.equal(b.confirmed, true);
  assert.match(b.undo.token, /^u_/);
  const again = await browser(`/confirm/${h.token}`);
  assert.equal(again.status, 410);
  // And that confirmed delete can itself be undone from the page.
  const back = await browser(`/undo/${b.undo.token}`);
  assert.equal(back.status, 200);
});

test('undo and confirm paths accept only token-shaped ids', async () => {
  for (const p of ['/undo/../summary', '/undo/short', '/confirm/%2e%2e', '/other/u_abcdefghijklmnopqrstuvwxyz']) {
    const r = await browser(p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
});
