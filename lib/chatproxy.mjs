// The in-app chat's server half. The browser talks only to Mint (POST /api/chat,
// behind the login gateway); Mint calls the assistant on loopback with the dedicated
// MINT_CHAT_KEY and streams the reply straight back. The key stays in this
// process. Nothing here logs a message or a reply: a refusal logs its code and
// status and nothing else.
import { HttpError } from './errors.mjs';
import { SECURITY_HEADERS, send, readJson } from './http.mjs';
import { MIN_KEY_LENGTH } from './apikey.mjs';
import { REQUEST_ID } from './chatturn.mjs';

export const MAX_MESSAGE = 8000;
export const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 30; // messages per window; the assistant has its own daily cap on top
const IDLE_MS = 120_000; // no bytes from the assistant for this long and the turn is given up
const PING_MS = 15_000; // keeps tunnels and proxies from closing an idle stream

const refusal = (res, status, code, error, headers = {}) => send(res, status, { ok: false, code, error }, headers);

// A fixed window per process (one user). Returns 0 when allowed, else seconds to wait.
export function windowLimiter(max = MAX_PER_WINDOW, windowMs = WINDOW_MS, now = Date.now) {
  let n = 0;
  let until = 0;
  return () => {
    const t = now();
    if (t >= until) { n = 0; until = t + windowMs; }
    n += 1;
    return n > max ? Math.max(1, Math.ceil((until - t) / 1000)) : 0;
  };
}

export function createChatProxy({ key = '', base = 'http://127.0.0.1:3000', log = () => {}, limit = windowLimiter(), turns = null } = {}) {
  let target = null;
  let why = null;
  const k = String(key ?? '').trim();
  if (!k) why = 'MINT_CHAT_KEY is not set in Mint\'s .env, so chat is off.';
  else if (k.length < MIN_KEY_LENGTH) why = `MINT_CHAT_KEY must be at least ${MIN_KEY_LENGTH} characters, so chat is off.`;
  else {
    try {
      const u = new URL(base);
      if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname)) why = 'MINT_CHAT_URL must be a loopback http address, so chat is off.';
      else target = { url: new URL('/api/mint/chat', u).href, host: u.host };
    } catch { why = 'MINT_CHAT_URL is not a valid URL, so chat is off.'; }
  }
  if (why) log(`chat: ${why}`);

  const unreachable = (res, e) => {
    const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? 'unknown error';
    log(`chat: The assistant not reachable (${String(cause).replace(/[^\w .:-]/g, '')})`);
    return refusal(res, 502, 'unreachable', `The assistant is not reachable at ${target.host}. Is it running? (${cause})`);
  };

  // The assistant answered with JSON instead of a stream: a refusal before any turn.
  async function relayRefusal(res, up) {
    const b = await up.json().catch(() => null);
    const code = typeof b?.code === 'string' ? b.code : null;
    const text = typeof b?.error === 'string' && b.error ? b.error : up.statusText || 'no detail';
    log(`chat: The assistant refused with ${up.status}${code ? ` ${code}` : ''}`);
    // The assistant rejecting Mint's key or its loopback check is a Mint setup fault. Passing a 401 on would
    // look like a sign-out to the page, so it becomes a 502 that names the real problem.
    if (up.status === 401 || up.status === 403) {
      return refusal(res, 502, 'assistant-rejected', `The assistant refused Mint's chat key (${up.status} ${code ?? 'refused'}: ${text}). MINT_CHAT_KEY must match on both sides.`);
    }
    if ([400, 409, 423, 429, 503].includes(up.status)) return refusal(res, up.status, up.status === 400 ? 'bad-request' : (code ?? 'refused'), text);
    return refusal(res, 502, 'assistant-error', `The assistant answered ${up.status}: ${text}`);
  }

  async function chat(req, res) {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const body = await readJson(req);
    const id = body.conversation_id;
    const message = body.message;
    if (typeof id !== 'string' || !CONVERSATION_ID.test(id)) return refusal(res, 400, 'bad-request', 'conversation_id must be 1 to 100 letters, digits, underscores or dashes');
    if (typeof message !== 'string' || !message.trim()) return refusal(res, 400, 'bad-request', 'message must be some text');
    if (message.length > MAX_MESSAGE) return refusal(res, 400, 'bad-request', `message is over ${MAX_MESSAGE} characters`);
    // The page's id for this question, the same on every attempt at it. Optional; it is not sent on to the assistant.
    const rid = body.request_id;
    if (rid != null && (typeof rid !== 'string' || !REQUEST_ID.test(rid))) return refusal(res, 400, 'bad-request', 'request_id must be 1 to 100 letters, digits, underscores or dashes');
    if (!target) return refusal(res, 503, 'not-configured', `Chat is not set up: ${why}`);
    const wait = limit();
    if (wait) return refusal(res, 429, 'rate-limited', `That is a lot of messages in a short time. Try again in ${wait > 90 ? `${Math.ceil(wait / 60)} minutes` : `${wait} seconds`}.`, { 'Retry-After': String(wait) });

    const ac = new AbortController();
    let finished = false;
    res.on('close', () => { if (!finished) ac.abort(); });
    let idle = setTimeout(() => ac.abort(new Error('idle')), IDLE_MS);
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(new Error('idle')), IDLE_MS); };
    let ping = null;
    const endTurn = rid && turns ? turns.begin(rid) : null;
    try {
      let up;
      try {
        up = await fetch(target.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ conversation_id: id, message }),
          signal: ac.signal,
        });
      } catch (e) {
        if (res.destroyed || res.writableEnded) return;
        if (ac.signal.reason?.message === 'idle') return refusal(res, 504, 'timeout', 'The assistant did not answer in time.');
        return unreachable(res, e);
      }
      if (!up.ok || !/^text\/event-stream/i.test(up.headers.get('content-type') ?? '')) return await relayRefusal(res, up);

      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
      ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, PING_MS);
      let tail = '';
      let terminal = false;
      try {
        const dec = new TextDecoder();
        for await (const chunk of up.body) {
          touch();
          res.write(chunk);
          tail = (tail + dec.decode(chunk, { stream: true })).slice(-4000);
          if (/^event: (done|error)$/m.test(tail)) terminal = true;
        }
      } catch (e) {
        if (res.destroyed) return; // the page went away
        const idled = ac.signal.reason?.message === 'idle';
        log(`chat: stream from the assistant ${idled ? 'went quiet' : 'broke'}`);
        res.write(`event: error\ndata: ${JSON.stringify({ code: idled ? 'timeout' : 'stream-broken', error: idled ? 'The assistant stopped sending for two minutes, so Mint gave up on this reply.' : `The connection to the assistant dropped mid-reply (${e?.cause?.code ?? e?.message ?? 'unknown'}).` })}\n\n`);
        return;
      }
      if (!terminal && !res.destroyed) {
        res.write(`event: error\ndata: ${JSON.stringify({ code: 'stream-broken', error: 'The assistant ended the reply early without finishing.' })}\n\n`);
      }
    } finally {
      finished = true;
      endTurn?.();
      clearTimeout(idle);
      if (ping) clearInterval(ping);
      if (!res.writableEnded && !res.destroyed && res.headersSent) res.end();
    }
  }

  return { chat, configured: !!target };
}
