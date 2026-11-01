// Mint: a single-user Australian personal finance app.
// Zero-dependency Node: node:http + node:sqlite, a vanilla SPA in public/.
// Sits behind your own login gateway (Authelia, Authentik, oauth2-proxy or
// similar, in front of a reverse proxy); every route checks the gateway's
// Remote-User and its shared secret (X-Mint-Gate) server-side, except
// the Redbark webhook (HMAC signed), the PWA install assets and /healthz.
// On top of that the data API needs the fingerprint lock's unlock cookie
// (lib/lock.mjs): without it every /api/ route but the lock's own answers 423.
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting, setSetting } from './lib/db.mjs';
import { loadEnv } from './lib/env.mjs';
import { createClient, API_BASE } from './lib/redbark.mjs';
import { createClient as createWiseClient, normalizeToken } from './lib/wise.mjs';
import { createWiseSync } from './lib/wisesync.mjs';
import { createIngest } from './lib/ingest.mjs';
import { createWebhookHandler } from './lib/webhook.mjs';
import { perthDate, perthMinutes } from './lib/dates.mjs';
import { HttpError } from './lib/errors.mjs';
import { send, readBody, readJson } from './lib/http.mjs';
import { createAi } from './lib/categorise.mjs';
import { createLogos, withBankLogos } from './lib/logos.mjs';
import { createEngine } from './lib/engine.mjs';
import { createApi } from './lib/api.mjs';
import { createQuotes, createAlphaVantage, createYahoo, createPriceRouter } from './lib/quotes.mjs';
import { createFx, createFrankfurter } from './lib/fx.mjs';
import { revalueManual, recomputeAll } from './lib/manual.mjs';
import { snapshotPortfolio } from './lib/holdings.mjs';
import { createAssistantApi } from './lib/assistant.mjs';
import { createChatProxy, windowLimiter } from './lib/chatproxy.mjs';
import { createChatTurns } from './lib/chatturn.mjs';
import { updateAccount, accountView } from './lib/accounts.mjs';
import { parseBearer, keyMatches, isDirectLoopback, MIN_KEY_LENGTH } from './lib/apikey.mjs';
import { createLock, LockError, readCookie } from './lib/lock.mjs';
import { androidAppOrigin, androidCert, assetLinks } from './lib/androidapp.mjs';

process.umask(0o077); // db, WAL and receipts are private to the service user

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.MINT_HOME || ROOT;
loadEnv(join(HOME, '.env'));

const KEY = process.env.REDBARK_API_KEY || '';
if (!KEY) {
  console.error('REDBARK_API_KEY missing from .env, refusing to start');
  process.exit(1);
}
// The assistant's server-to-server key (step 4). Optional: unset, the bearer door is shut.
// Set, it must be long enough to be a key. It only ever opens /api/assistant/ and
// only for a direct loopback caller (see lib/apikey.mjs).
const API_KEY = (process.env.MINT_API_KEY ?? '').trim();
if (API_KEY && API_KEY.length < MIN_KEY_LENGTH) {
  console.error(`MINT_API_KEY must be at least ${MIN_KEY_LENGTH} characters, refusing to start`);
  process.exit(1);
}
// The gate's shared secret. the login proxy adds it to every request it proxies as
// X-Mint-Gate (header_up from an env file), so a Remote-User that did not come
// through the gate, say a tunnel pointed straight at this port, is refused.
// Same rules as MINT_API_KEY: 32+ characters or the server will not start.
// Once a key has been used it is required (see the check after the db opens).
const GATE_KEY = (process.env.MINT_GATE_KEY ?? '').trim();
if (GATE_KEY && GATE_KEY.length < MIN_KEY_LENGTH) {
  console.error(`MINT_GATE_KEY must be at least ${MIN_KEY_LENGTH} characters, refusing to start`);
  process.exit(1);
}
const PORT = Number(process.env.MINT_PORT ?? 8970);
// Loopback unless you say otherwise. Only the Docker image sets this (to 0.0.0.0, inside the container, where compose publishes the port on the host's loopback).
const HOST = (process.env.MINT_HOST || '127.0.0.1').trim();
// The login name your gateway sends as Remote-User. Only this user gets in.
const USER = process.env.MINT_USER || 'owner';
// The public https origin you serve Mint from (the passkey lock is bound to it).
// Unset, it is the local address, which is right for a trial on one machine.
const ORIGIN = (process.env.MINT_ORIGIN || '').trim().replace(/\/+$/, '') || `http://localhost:${PORT}`;
const SCHEDULER = process.env.MINT_SCHEDULER !== 'off';
// The fingerprint lock is on unless MINT_LOCK=off, and that is only honoured
// until the first fingerprint is enrolled (see the check after the db opens).
const LOCK_OFF = (process.env.MINT_LOCK ?? '').trim().toLowerCase() === 'off';
// A localhost origin the lock also accepts, with rp id localhost: for tests and a
// throwaway check on this box only. Never set on the live service.
const LOCK_DEV_ORIGIN = (process.env.MINT_LOCK_DEV_ORIGIN ?? '').trim();
if (LOCK_DEV_ORIGIN && !/^http:\/\/localhost(:\d{1,5})?$/.test(LOCK_DEV_ORIGIN)) {
  console.error('MINT_LOCK_DEV_ORIGIN must be http://localhost[:port], refusing to start');
  process.exit(1);
}
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SECRETS = { webhook: list(process.env.REDBARK_WEBHOOK_SECRET), events: list(process.env.REDBARK_EVENTS_SECRET) };
// Wise (lib/wise.mjs): read only, on when WISE_API_TOKEN is set and silently off when it is not.
// The value is read once here, handed to the client closure and nowhere else; a token that
// cannot be a header leaves Wise on but failing in the open, with a message that omits it.
let WISE_TOKEN = '';
let WISE_CONFIG_ERROR = null;
try { WISE_TOKEN = normalizeToken(process.env.WISE_API_TOKEN); } catch (e) { WISE_CONFIG_ERROR = e.message; }
const POLL_MS = 30 * 60 * 1000;
const RECONCILE_AT = 2 * 60 + 40; // 02:40 Perth

const log = (msg) => console.log(String(msg).replace(/[\r\n]+/g, ' '));

const DATA = join(HOME, 'data');
mkdirSync(DATA, { recursive: true, mode: 0o700 });
chmodSync(DATA, 0o700);
const db = openDb(join(DATA, 'mint.db'));
chmodSync(join(DATA, 'mint.db'), 0o600);
// A lost or blanked MINT_GATE_KEY must not quietly reopen the gap, so the
// first start with a key records it and later starts without one fail. To
// turn the gate key off on purpose, delete the gate_key_enabled_at setting.
const gateSince = getSetting(db, 'gate_key_enabled_at');
if (GATE_KEY && !gateSince) setSetting(db, 'gate_key_enabled_at', new Date().toISOString());
if (!GATE_KEY && gateSince) {
  console.error(`MINT_GATE_KEY is missing but the gate key has been required since ${gateSince}, refusing to start`);
  db.close();
  process.exit(1);
}

// Same rule for the fingerprint lock: once a fingerprint has been enrolled,
// MINT_LOCK=off does not reopen Mint. The only way off is scripts/lock-reset.mjs
// --disable (shell on this box) and then the flag.
const lockSince = getSetting(db, 'lock_enabled_at');
if (LOCK_OFF && lockSince) {
  console.error(`MINT_LOCK=off but the fingerprint lock has been on since ${lockSince}, refusing to start (scripts/lock-reset.mjs --disable turns it off)`);
  db.close();
  process.exit(1);
}
const LOCK_ON = !LOCK_OFF;
// Say plainly when the Android app is not configured, so a missing value is visible in the log.
{
  const raw = (process.env.MINT_ANDROID_CERT_SHA256 ?? '').trim();
  if (!raw) log('android: MINT_ANDROID_CERT_SHA256 is not set, so the Android app is not recognised (the web app is unaffected)');
  else if (!androidCert()) log('android: MINT_ANDROID_CERT_SHA256 is not a colon-separated SHA-256 fingerprint, so the Android app is not recognised');
}
const lock = createLock({ db, origin: ORIGIN, devOrigin: LOCK_DEV_ORIGIN, appOrigins: [androidAppOrigin()].filter(Boolean), log });

const client = createClient({ key: KEY, base: process.env.REDBARK_API_BASE || API_BASE });
// Unknown merchants go to a cheap model through the shared OpenRouter key:
// merchant and description only, cached per merchant, capped per day.
const ai = createAi({
  db, log, key: process.env.OPENROUTER_API_KEY || '',
  model: process.env.MINT_AI_MODEL || 'google/gemini-3.1-flash-lite',
  base: process.env.MINT_AI_BASE || 'https://openrouter.ai/api/v1',
  dailyCap: Number(process.env.MINT_AI_DAILY_CAP) || 1500,
  today: () => perthDate(),
});
// Merchant logos: icons fetched once per merchant and cached in the book. The
// model is asked for a site's domain once per merchant it cannot place, through
// the same key and daily cap. Background runs only when this process polls.
const logos = createLogos({
  db, log, key: process.env.OPENROUTER_API_KEY || '',
  model: process.env.MINT_AI_MODEL || 'google/gemini-3.1-flash-lite',
  base: process.env.MINT_AI_BASE || 'https://openrouter.ai/api/v1',
  dailyCap: Number(process.env.MINT_AI_DAILY_CAP) || 1500,
  today: () => perthDate(),
});
// Staleness alerts only make sense when this process is polling.
const engine = createEngine({ db, ai, logos: SCHEDULER ? logos : null, log, staleHours: SCHEDULER ? 24 : 0, wise: !!WISE_TOKEN || !!WISE_CONFIG_ERROR });
engine.init();
// Exchange rates (lib/fx.mjs): one Frankfurter client for the share prices' USD rate
// and the manual foreign-currency accounts. New rates re-convert any manual rows
// that were saved on an older stand-in rate while offline.
const frankfurter = createFrankfurter({ base: process.env.MINT_FX_BASE || undefined });
const fx = createFx({ db, client: frankfurter, log, onRates: (cur) => revalueManual(db, cur, { today: perthDate() }) });
// Wise rides on the Redbark queue below (a poll, a reconcile, Sync now), so there is no second one.
const wise = createWiseSync({ db, client: WISE_TOKEN ? createWiseClient({ token: WISE_TOKEN }) : null, configError: WISE_CONFIG_ERROR, fx, log });
const ingest = createIngest({ db, client, log, afterSync: () => engine.afterSync(), wise });
// Share prices: US tickers from Alpha Vantage's free key (unset means hand-entered
// US prices only), ASX tickers from Yahoo Finance (keyless, unofficial, personal
// use), AUD per USD from Frankfurter. See the Mint dossier for the terms and limits.
const priceSource = createPriceRouter({
  US: createAlphaVantage({ key: process.env.ALPHAVANTAGE_API_KEY || '', base: process.env.ALPHAVANTAGE_BASE || undefined }),
  ASX: createYahoo({ base: process.env.YAHOO_CHART_BASE || undefined }),
}, { fx: (from) => frankfurter.rate(from) });
const quotes = createQuotes({ db, source: priceSource, log, dailyCap: Number(process.env.MINT_QUOTE_DAILY_CAP) || 25, today: () => perthDate() });
const api = createApi({ db, engine, ai, quotes, logos, fx, dataDir: DATA, log });
const chatTurns = createChatTurns({ db });
const assistantApi = createAssistantApi({ db, engine, quotes, fx, turns: chatTurns, origin: ORIGIN, log });
// The in-app chat: the page talks to /api/chat, Mint talks to the assistant on loopback with MINT_CHAT_KEY
// (a different key from MINT_API_KEY, which opens /api/assistant/ the other way round).
const chatProxy = createChatProxy({ key: process.env.MINT_CHAT_KEY, base: process.env.MINT_CHAT_URL || 'http://127.0.0.1:3000', log, turns: chatTurns });
const chatActionLimit = windowLimiter(120);

// Webhook deliveries and Sync now share one queue: a request while a sync runs
// is folded into one follow-up run.
let queued = null;
let queueTimer = null;
function queueSync(opts = {}, delayMs = 15_000) {
  if (!queued) queued = { accounts: opts.accounts ?? null, from: opts.from ?? null };
  else {
    queued.accounts = queued.accounts && opts.accounts ? [...new Set([...queued.accounts, ...opts.accounts])] : null;
    queued.from = queued.from && opts.from ? (opts.from < queued.from ? opts.from : queued.from) : (queued.from ?? opts.from ?? null);
  }
  clearTimeout(queueTimer);
  queueTimer = setTimeout(drainQueue, delayMs);
}
async function drainQueue() {
  if (!queued) return;
  if (ingest.state().running) { queueTimer = setTimeout(drainQueue, 10_000); return; }
  const opts = queued;
  queued = null;
  await ingest.runSync('poll', opts);
}

const webhook = createWebhookHandler({
  db, secrets: SECRETS, log,
  onSync: (o) => queueSync(o),
  onConnections: () => queueSync({}),
});

// ---------- static shell ----------

const PUBLIC = join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
// routes.js is plain script in the page and a CommonJS module here: one list of shell paths for the nav, this server and the worker.
const { SHELL_PATHS } = createRequire(import.meta.url)('./public/routes.js');
const SCRIPTS = ['routes.js', 'cycle-math.js', 'ux-model.js', 'goal-calc.js', 'demo-math.js', 'core.js', 'lock.js', 'logo-tile.js', 'charts.js', 'homesync.js', 'home-order.js', 'home.js', 'transactions.js', 'filters.js', 'views.js', 'budgets.js', 'subs.js', 'income.js', 'goals.js', 'plan.js', 'save.js', 'shares.js', 'taxest.js', 'tax.js', 'accounts.js', 'account.js', 'manual.js', 'reports.js', 'owed-math.js', 'owed.js', 'lockset.js', 'settings.js', 'more.js', 'search.js', 'keys.js', 'chat-model.js', 'chat.js', 'app.js'];
// The vendored ui-kit (public/kit): CSS, the motion helper, the icon sprite and the faces.
const KIT = ['kit/kit.css', 'kit/kit.js', 'kit/icons.svg', 'kit/fonts/geist-latin.woff2', 'kit/fonts/geist-mono-latin.woff2'];
const FILES = ['index.html', 'style.css', 'kit-boot.js', ...KIT, ...SCRIPTS, 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const raw = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(PUBLIC, f))]));
// Asset version from content, so every frontend change busts Cloudflare and the SW cache.
const VERSION = createHash('sha256').update(raw['style.css']).update(raw['index.html']).update(raw['kit-boot.js']).update(Buffer.concat(KIT.map((f) => raw[f]))).update(Buffer.concat(SCRIPTS.map((f) => raw[f]))).digest('hex').slice(0, 10);
// __CHAT__ becomes on or off: the chat UI is optional and only appears when MINT_CHAT_KEY is set (see CHAT_ON in public/core.js).
// The page lists its scripts as __SCRIPTS__ and the worker lists them as __SHELL_SCRIPTS__, so a new file is added in one place.
const scriptTags = SCRIPTS.map((f) => `<script src="/${f}?v=${VERSION}" defer></script>`).join('\n');
const shellScripts = SCRIPTS.map((f) => `'/${f}?v=${VERSION}'`).join(', ');
const STATIC = Object.fromEntries(FILES.map((f) => {
  const body = /\.(html|js)$/.test(f)
    ? Buffer.from(raw[f].toString().replaceAll('__SCRIPTS__', scriptTags).replaceAll('__SHELL_SCRIPTS__', shellScripts).replaceAll('__TAB_PATHS__', JSON.stringify(SHELL_PATHS)).replaceAll('__V__', VERSION).replaceAll('__CHAT__', chatProxy.configured ? 'on' : 'off'))
    : raw[f];
  return [`/${f}`, { body, type: TYPES[f.slice(f.lastIndexOf('.'))], cache: /\.(png|svg|woff2)$/.test(f) ? 'public, max-age=86400' : 'no-cache' }];
}));
const TABS = new Set(SHELL_PATHS);
// Reachable without the gate identity: PWA install assets, the HMAC webhook, the local health check.
const OPEN = new Set(['/manifest.webmanifest', '/sw.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/healthz', '/api/redbark/webhook', '/.well-known/assetlinks.json']);
// Reachable with the gate identity while locked: the lock's own endpoints. The shell
// and its scripts are not under /api/ and hold no data, so they need no exemption.
const LOCK_OPEN = new Set(['/api/lock/status', '/api/lock/challenge', '/api/lock/verify', '/api/lock/register-challenge', '/api/lock/register-verify', '/api/lock/lock']);


// ---------- helpers ----------





// A blank gate key refuses everyone rather than trusting the client-supplied
// Remote-User alone: a DB restored to a new path has no gate_key_enabled_at row,
// and the startup check above would otherwise let it start with the gate open.
const gateKeyOk = (req) => GATE_KEY !== '' && keyMatches(req.headers['x-mint-gate'] ?? '', GATE_KEY);
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');

// Failures per IP in a 10 minute window, then 429.
function failCounter(max) {
  const seen = new Map();
  return {
    limited(ip) {
      const e = seen.get(ip);
      return e && e.until > Date.now() && e.n >= max;
    },
    note(ip) {
      const e = seen.get(ip);
      if (!e || e.until < Date.now()) seen.set(ip, { n: 1, until: Date.now() + 10 * 60 * 1000 });
      else e.n += 1;
      if (seen.size > 5000) for (const [k, v] of seen) if (v.until < Date.now()) seen.delete(k);
    },
  };
}
// Bad webhook signatures and bad bearer keys: 30. Failed fingerprint checks: 20.
const badSigs = failCounter(30);
const badUnlocks = failCounter(20);
const safeIp = (req) => clientIp(req).replace(/[^\w.:-]/g, '');
const unlocked = (req) => !LOCK_ON || !!lock.session(readCookie(req.headers.cookie));

// ---------- read models ----------

function accountsPayload() {
  const rows = db.prepare(`SELECT a.*,
      (SELECT count(*) FROM transactions t WHERE t.account_id = a.id) tx_count,
      (SELECT count(*) FROM transactions t WHERE t.account_id = a.id AND t.status = 'pending') pending_count
    FROM accounts a WHERE a.status IS NOT 'gone' ORDER BY a.sort, a.name`).all().map((a) => accountView(a, fx.status));
  const accounts = withBankLogos(db, rows);
  const h = ingest.health();
  const lastPoll = h.sync.lastPollAt;
  const assets = accounts.filter((a) => !a.hidden && (a.balance_current ?? 0) > 0).reduce((s, a) => s + a.balance_current, 0);
  const liabilities = accounts.filter((a) => !a.hidden && (a.balance_current ?? 0) < 0).reduce((s, a) => s - a.balance_current, 0);
  // Archived manual accounts, so the page can bring one back.
  const archived = db.prepare("SELECT id, name, nickname, institution, type, currency, balance_native FROM accounts WHERE manual = 1 AND status = 'gone' ORDER BY name").all();
  return {
    connections: h.connections,
    accounts,
    archived,
    totals: { assets, liabilities, net_worth: assets - liabilities },
    sync: {
      ...h.sync,
      nextPollAt: SCHEDULER && lastPoll ? new Date(Date.parse(lastPoll) + POLL_MS).toISOString() : null,
      scheduler: SCHEDULER,
      webhook: SECRETS.webhook.length + SECRETS.events.length > 0,
      wise: wise.status(),
      lastWebhookAt: db.prepare('SELECT max(received_at) t FROM webhook_deliveries').get().t,
    },
    log: db.prepare(`SELECT l.id, l.kind, l.account_id, a.name account_name, l.started_at, l.finished_at, l.ok, l.fetched, l.inserted, l.updated, l.removed, l.error
      FROM sync_log l LEFT JOIN accounts a ON a.id = l.account_id ORDER BY l.id DESC LIMIT 20`).all(),
  };
}


// ---------- the fingerprint lock ----------

const LOCK_STATUS = { credential: 404, last: 409, duplicate: 409, locked: 423 };
async function lockRoute(req, res, pathname, method) {
  const ip = clientIp(req);
  const cookie = readCookie(req.headers.cookie);
  const live = LOCK_ON ? lock.session(cookie) : null;
  const enrolled = lock.count();
  const rpOrigin = req.headers.origin || ORIGIN;
  const post = (p) => {
    if (pathname !== p) return false;
    if (method !== 'POST') throw new HttpError(405, 'POST only');
    return true;
  };

  if (pathname === '/api/lock/status') {
    if (method !== 'GET') throw new HttpError(405, 'GET only');
    return send(res, 200, { on: LOCK_ON, locked: LOCK_ON && !live, enrolled, setup: LOCK_ON && enrolled === 0, idleMs: lock.idleMs, expiresAt: live?.expiresAt ?? null });
  }
  if (post('/api/lock/lock')) {
    lock.revoke(cookie);
    return send(res, 200, { ok: true, locked: LOCK_ON }, { 'Set-Cookie': lock.clearCookieHeader() });
  }
  if (post('/api/lock/challenge')) {
    if (badUnlocks.limited(ip)) return send(res, 429, { error: 'too many failed fingerprint checks, wait 10 minutes' }, { 'Retry-After': '600' });
    if (!enrolled) throw new HttpError(409, 'no fingerprint is set up yet');
    return send(res, 200, lock.assertOptions({ origin: rpOrigin }));
  }
  if (post('/api/lock/verify')) {
    if (badUnlocks.limited(ip)) return send(res, 429, { error: 'too many failed fingerprint checks, wait 10 minutes' }, { 'Retry-After': '600' });
    const body = await readJson(req, 32 * 1024);
    try {
      const { credentialId } = lock.assert(body);
      const value = lock.startSession(credentialId);
      if (cookie && cookie !== value) lock.revoke(cookie);
      return send(res, 200, { ok: true, expiresAt: lock.session(value)?.expiresAt ?? null }, { 'Set-Cookie': lock.cookieHeader(value) });
    } catch (e) {
      if (!(e instanceof LockError)) throw e;
      badUnlocks.note(ip);
      log(`lock: refused unlock (${e.reason}) from ${safeIp(req)}`);
      return send(res, 401, { error: `Fingerprint check failed: ${e.message}`, reason: e.reason });
    }
  }
  if (pathname === '/api/lock/register-challenge' || pathname === '/api/lock/register-verify') {
    if (method !== 'POST') throw new HttpError(405, 'POST only');
    if (!LOCK_ON) throw new HttpError(409, 'the lock is off on this server (MINT_LOCK=off)');
    // The first fingerprint needs only the gate identity; every later one an unlocked session.
    if (enrolled > 0 && !live) {
      log(`refused ${method} ${pathname}: locked`);
      return send(res, 423, { error: 'locked' });
    }
    if (pathname === '/api/lock/register-challenge') return send(res, 200, lock.registerOptions({ origin: rpOrigin }));
    if (badUnlocks.limited(ip)) return send(res, 429, { error: 'too many failed fingerprint checks, wait 10 minutes' }, { 'Retry-After': '600' });
    const body = await readJson(req, 32 * 1024);
    try {
      const { credentialId } = lock.register(body, { firstOnly: !live });
      if (live) return send(res, 200, { ok: true, credentialId });
      const value = lock.startSession(credentialId);
      return send(res, 200, { ok: true, credentialId, expiresAt: lock.session(value)?.expiresAt ?? null }, { 'Set-Cookie': lock.cookieHeader(value) });
    } catch (e) {
      if (!(e instanceof LockError)) throw e;
      badUnlocks.note(ip);
      log(`lock: refused enrolment (${e.reason}) from ${safeIp(req)}`);
      return send(res, LOCK_STATUS[e.reason] ?? 400, { error: `Couldn't set up the fingerprint: ${e.message}`, reason: e.reason });
    }
  }
  // Below here the handler has already demanded an unlocked session.
  if (pathname === '/api/lock/credentials' && method === 'GET') return send(res, 200, { credentials: lock.credentials().map(({ id, label, alg, created_at, last_used_at }) => ({ id, label, alg, created_at, last_used_at })) });
  const del = /^\/api\/lock\/credentials\/([A-Za-z0-9_-]{16,1400})$/.exec(pathname);
  if (del && method === 'DELETE') {
    try { lock.removeCredential(del[1]); } catch (e) {
      if (e instanceof LockError) throw new HttpError(LOCK_STATUS[e.reason] ?? 400, e.message);
      throw e;
    }
    return send(res, 200, { ok: true, credentials: lock.count() });
  }
  throw new HttpError(404, 'no such endpoint');
}

// ---------- routes ----------

async function route(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/healthz' && method === 'GET') return send(res, 200, { ok: true });
  if (pathname === '/.well-known/assetlinks.json' && method === 'GET') return send(res, 200, assetLinks(), { 'Cache-Control': 'public, max-age=3600' });

  if (pathname === '/api/redbark/webhook') {
    if (method !== 'POST') return send(res, 405, { error: 'POST only' }, { Allow: 'POST' });
    const ip = clientIp(req);
    if (badSigs.limited(ip)) return send(res, 429, { error: 'too many bad signatures' }, { 'Retry-After': '600' });
    const rawBody = await readBody(req, 5 * 1024 * 1024);
    const r = await webhook({ headers: req.headers, rawBody, ip });
    if (r.status === 401) badSigs.note(ip);
    return send(res, r.status, r.body);
  }

  if (method === 'GET' && STATIC[pathname] && pathname !== '/index.html') {
    const f = STATIC[pathname];
    return send(res, 200, f.body, { 'Content-Type': f.type, 'Cache-Control': f.cache });
  }

  // State-changing requests must come from the app itself.
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if ((origin && origin !== ORIGIN && origin !== `http://127.0.0.1:${PORT}` && origin !== (LOCK_DEV_ORIGIN || null)) || req.headers['sec-fetch-site'] === 'cross-site') {
      log(`refused cross-origin ${method} ${pathname} from ${origin ?? req.headers['sec-fetch-site']}`);
      throw new HttpError(403, 'cross-origin request refused');
    }
  }

  if (pathname.startsWith('/api/lock/')) return lockRoute(req, res, pathname, method);

  if (pathname === '/api/accounts' && method === 'GET') return send(res, 200, accountsPayload());

  const m = /^\/api\/accounts\/(acct_[A-Za-z0-9_]{1,64}|man_[a-f0-9]{16})$/.exec(pathname);
  if (m && method === 'PATCH') {
    const body = await readJson(req);
    updateAccount(db, m[1], body);
    log(`account ${m[1]} updated: ${Object.keys(body).join(', ')}`);
    return send(res, 200, accountView(db.prepare('SELECT * FROM accounts WHERE id = ?').get(m[1]), fx.status));
  }

  if (pathname === '/api/sync' && method === 'GET') return send(res, 200, { ...ingest.state(), queued: !!queued });
  if (pathname === '/api/sync' && method === 'POST') {
    const already = ingest.state().running;
    if (!already) ingest.runSync('poll');
    return send(res, 202, { ...ingest.state(), already });
  }

  // Wise sync now: the same run the poll does, on the same running guard as Sync now.
  if (pathname === '/api/wise/status' && method === 'GET') return send(res, 200, wise.status());
  if (pathname === '/api/wise/sync' && method === 'POST') {
    if (!wise.enabled) throw new HttpError(404, 'Wise sync is off: WISE_API_TOKEN is not set');
    const already = ingest.state().running;
    if (!already) ingest.runSync('wise');
    return send(res, 202, { ...ingest.state(), already });
  }

  if (pathname === '/api/chat') return chatProxy.chat(req, res);
  // The page's way to the undo and confirm tokens a chat reply carries: the same operations as the
  // bearer door's /undo and /confirm, but behind the sign-in, so the page never holds a key.
  const act = /^\/api\/chat\/(undo|confirm)\/([A-Za-z0-9_-]{10,100})$/.exec(pathname);
  if (act) {
    if (method !== 'POST') throw new HttpError(405, 'POST only');
    if (chatActionLimit()) throw new HttpError(429, 'too many undo and confirm requests, wait a minute');
    if (await assistantApi(req, res, new URL(`/api/assistant/${act[1]}/${act[2]}`, 'http://localhost'))) return;
    throw new HttpError(404, 'no such endpoint');
  }

  if (pathname.startsWith('/api/assistant/')) {
    if (await assistantApi(req, res, url)) return;
    throw new HttpError(404, 'no such endpoint');
  }

  if (pathname.startsWith('/api/')) {
    if (await api(req, res, url)) return;
    throw new HttpError(404, 'no such endpoint');
  }

  if (method === 'GET') {
    const shell = STATIC['/index.html'];
    return send(res, TABS.has(pathname) ? 200 : 404, shell.body, { 'Content-Type': shell.type, 'Cache-Control': 'no-cache' });
  }
  throw new HttpError(405, 'method not allowed');
}

const server = createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'bad url' }); }
  try {
    const presented = parseBearer(req.headers.authorization);
    if (presented !== null) {
      // An API caller (the assistant on this box). The key opens /api/assistant/ and nothing else.
      const ip = clientIp(req);
      if (badSigs.limited(ip)) return send(res, 429, { error: 'too many bad keys' }, { 'Retry-After': '600' });
      if (!API_KEY || !isDirectLoopback(req) || !keyMatches(presented, API_KEY)) {
        badSigs.note(ip);
        log(`refused ${req.method} ${url.pathname}: bad api key from ${ip.replace(/[^\w.:-]/g, '')}`);
        return send(res, 401, { error: 'bad api key' });
      }
      if (!url.pathname.startsWith('/api/assistant/')) return send(res, 403, { error: 'this key reaches /api/assistant/ only' });
      // A held change is the owner's to apply, not the agent's: the model reads bank
      // text anyone can write, so a key holder that could confirm would make the
      // hold a suggestion. Confirm is the card's button, behind the sign-in and
      // the fingerprint (/api/chat/confirm). Undo stays open, it only puts back.
      if (url.pathname.startsWith('/api/assistant/confirm/')) {
        log(`refused ${req.method} ${url.pathname.slice(0, 22)}: confirm needs the owner, not the api key`);
        return send(res, 403, { error: 'not done: a held change is applied only when the owner taps Confirm on its card in Mint. Ask them to tap it; the key cannot confirm.', code: 'confirm-needs-owner' });
      }
    } else if (!OPEN.has(url.pathname) && (req.headers['remote-user'] !== USER || !gateKeyOk(req))) {
      const why = req.headers['remote-user'] !== USER ? `gate identity ${req.headers['remote-user'] ? 'mismatch' : 'missing'}` : `gate key ${req.headers['x-mint-gate'] ? 'wrong' : 'missing'}`;
      log(`refused ${req.method} ${url.pathname}: ${why} from ${safeIp(req)}`);
      return send(res, 401, url.pathname.startsWith('/api/') ? { error: 'sign in through your login gateway' } : 'Unauthorised');
    } else if (url.pathname.startsWith('/api/') && !OPEN.has(url.pathname) && !LOCK_OPEN.has(url.pathname) && !unlocked(req)) {
      // Signed in through the gate but not unlocked with the fingerprint: no data.
      log(`refused ${req.method} ${url.pathname}: locked`);
      return send(res, 423, { error: 'locked' });
    }
    await route(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    const id = randomUUID().slice(0, 8);
    log(`error ${id} ${req.method} ${url.pathname}: ${e?.stack ?? e}`);
    if (!res.headersSent) send(res, 500, { error: 'server error', id });
  }
});

// ---------- scheduler ----------
// Poll every 30 minutes (first run backfills each account's full history),
// reconcile nightly at 02:40 Perth: a 120 day re-walk, balances and loan
// details into today's snapshot row. Every poll also refreshes today's row.

function tick() {
  if (ingest.state().running) return;
  const now = new Date();
  const lastReconcile = getSetting(db, 'last_reconcile_at');
  if (perthMinutes(now) >= RECONCILE_AT && (!lastReconcile || perthDate(new Date(lastReconcile)) !== perthDate(now))) {
    ingest.runSync('reconcile');
    return;
  }
  const lastPoll = getSetting(db, 'last_poll_at');
  if (!lastPoll || now - Date.parse(lastPoll) >= POLL_MS) ingest.runSync('poll');
}

// Quotes: the service decides what is due (15 minutes while a market is open,
// within the daily call budget), so this just asks once a minute. Today's
// portfolio snapshot is kept fresh on the same beat.
let quoteBusy = false;
async function quoteTick() {
  if (quoteBusy) return;
  quoteBusy = true;
  try {
    await quotes.refresh();
    snapshotPortfolio(db, { cap: quotes.status().cap });
  } catch (e) { log(`quote tick failed: ${e?.message ?? e}`); } finally { quoteBusy = false; }
  // Manual accounts: the latest rate for each currency in use (every 6 hours), and
  // today's snapshot row for each, once a Perth day, so net worth history has the day.
  try {
    await fx.refreshLatest();
    const day = perthDate();
    if (getSetting(db, 'manual_snapshot_day') !== day) { recomputeAll(db, { today: day }); setSetting(db, 'manual_snapshot_day', day); }
  } catch (e) { log(`exchange rate tick failed: ${e?.message ?? e}`); }
}

process.on('unhandledRejection', (e) => { log(`unhandled rejection: ${e?.stack ?? e}`); process.exit(1); });
process.on('uncaughtException', (e) => { log(`uncaught exception: ${e?.stack ?? e}`); process.exit(1); });
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(); try { db.close(); } catch {} process.exit(0); });
}

server.listen(PORT, HOST, () => {
  log(`mint listening on http://${HOST}:${server.address().port} (scheduler ${SCHEDULER ? 'on' : 'off'}, webhook ${SECRETS.webhook.length + SECRETS.events.length ? 'on' : 'off'}, ${LOCK_ON ? `fingerprint lock on, ${lock.count()} enrolled` : 'fingerprint lock off (MINT_LOCK=off)'})`);
  if (SCHEDULER) {
    setTimeout(tick, 5_000);
    setInterval(tick, 60_000).unref();
    setTimeout(quoteTick, 8_000);
    setInterval(quoteTick, 60_000).unref();
    // Bank logos first and promptly, so the first load after a deploy has them.
    setTimeout(() => logos.runBanks().catch((e) => log(`logos: banks: ${e?.message ?? e}`)), 2_000);
    // The one-off backfill (biggest spenders first), then hourly to retry misses and errors that have come due.
    setTimeout(() => engine.runLogos({ drain: true }), 30_000);
    setInterval(() => engine.runLogos(), 60 * 60 * 1000).unref();
  }
});
