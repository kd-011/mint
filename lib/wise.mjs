// Wise Platform API client (https://docs.wise.com), read only. GET and nothing
// else: it can list the profile, read balances and read statements, and has no
// way to quote, transfer or change anything. The base URL is pinned, redirects
// are refused, 429 and 5xx back off (Retry-After honoured), and the token lives
// in this closure: it is never logged, never put in an error and never sent
// off api.wise.com.
import { addDays, zoneDate, zoneDayStart, zoneDayEnd } from './dates.mjs';

export const API_BASE = 'https://api.wise.com';

const MAX_WAIT_MS = 120_000; // a Retry-After longer than this fails the call instead of stalling a sync
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const WINDOW_DAYS = 460; // Wise allows 469 days from start to end of one statement

export class WiseError extends Error {
  constructor({ status, code, message, sca = false, retryAfter = null }) {
    super(`Wise ${status || 'network'} ${code}: ${message}`);
    this.name = 'WiseError';
    this.status = status;
    this.code = code;
    this.sca = sca;
    this.retryAfter = retryAfter;
  }
}

// .env lines are read raw, so a value saved as "abc" arrives with its quotes.
// Returns '' when unset; throws (without the value) when it cannot be a header.
export function normalizeToken(raw) {
  const s = String(raw ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!s) return '';
  if (/[\s\u0000-\u001f\u007f]/.test(s) || /[^\x21-\x7e]/.test(s)) throw new Error('WISE_API_TOKEN is malformed: it should be a single token with no spaces or quotes inside');
  return s;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseRetryAfter(v) {
  if (v == null || v === '') return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

// Date windows (YYYY-MM-DD, local days, inclusive) that each fit one statement call.
export function statementWindows(from, to, maxDays = WINDOW_DAYS) {
  const out = [];
  for (let f = from; f <= to; ) {
    const t = addDays(f, maxDays - 1) < to ? addDays(f, maxDays - 1) : to;
    out.push({ from: f, to: t });
    f = addDays(t, 1);
  }
  return out;
}

const cents = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) : null);

export function createClient({ token, fetchImpl = globalThis.fetch, sleep = defaultSleep, maxRetries = 4, timeoutMs = 30_000, now = () => new Date() } = {}) {
  const secret = normalizeToken(token);
  if (!secret) throw new Error('Wise API token missing');

  const redact = (text) => String(text ?? '').split(secret).join('[token]').replace(/Bearer\s+[^\s"',;)]+/gi, 'Bearer [token]');

  async function get(path, query) {
    const u = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v != null) u.searchParams.set(k, String(v));
    const url = u.toString();
    for (let attempt = 0; ; attempt++) {
      let res;
      let text;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error', // the token never travels on a redirect
        });
        text = await res.text();
      } catch (e) {
        if (attempt >= maxRetries) {
          throw new WiseError({ status: 0, code: 'network_error', message: e?.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : redact(e?.message ?? e).slice(0, 200) });
        }
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      if (res.ok) {
        try { return text ? JSON.parse(text) : null; } catch {
          throw new WiseError({ status: res.status, code: 'bad_json', message: 'response was not JSON' });
        }
      }
      let body = {};
      try { body = JSON.parse(text) ?? {}; } catch {}
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const said = redact(body.message ?? body.error_description ?? body.errors?.[0]?.message ?? res.statusText ?? 'request failed').slice(0, 200);
      const sca = res.status === 403 && (res.headers.get('x-2fa-approval') != null || /\bsca\b|strong customer|two.?factor|\b2fa\b/i.test(`${said} ${body.error ?? ''}`));
      const err = new WiseError({
        status: res.status, retryAfter, sca,
        code: redact(typeof body.error === 'string' ? body.error : body.errors?.[0]?.code ?? `http_${res.status}`).slice(0, 60),
        message: sca ? "Wise wants strong customer authentication (SCA) for this request, which a personal API token cannot give. Check the token's scope in Wise" : said || 'request failed',
      });
      if (!RETRYABLE.has(res.status) || attempt >= maxRetries || (retryAfter ?? 0) > MAX_WAIT_MS) throw err;
      await sleep(retryAfter ?? Math.min(30_000, 1000 * 2 ** attempt));
    }
  }

  // One statement call for [from, to] (local days): rows oldest first with local
  // dates and whole-hundredth amounts, plus Wise's own balance at both ends.
  async function statement(profileId, balanceId, { currency, from, to }) {
    const end = zoneDayEnd(to);
    const cap = now();
    const s = await get(`/v1/profiles/${encodeURIComponent(profileId)}/balance-statements/${encodeURIComponent(balanceId)}/statement.json`, {
      currency,
      intervalStart: zoneDayStart(from).toISOString(),
      intervalEnd: (end > cap ? cap : end).toISOString(),
      type: 'COMPACT',
    });
    const rows = [];
    for (const t of s?.transactions ?? []) {
      const amount = cents(t?.amount?.value);
      if (amount == null || amount === 0 || typeof t.date !== 'string' || Number.isNaN(Date.parse(t.date))) continue;
      rows.push({
        ref: t.referenceNumber == null ? '' : String(t.referenceNumber),
        at: t.date,
        date: zoneDate(new Date(t.date)),
        amount,
        description: String(t.details?.description ?? '').replace(/\s+/g, ' ').trim(),
        kind: t.details?.type ?? null,
      });
    }
    rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.amount - b.amount || a.ref.localeCompare(b.ref));
    return { rows, openingCents: cents(s?.startOfStatementBalance?.value), closingCents: cents(s?.endOfStatementBalance?.value) };
  }

  return {
    redact,
    profiles: () => get('/v2/profiles'),
    async personalProfile() {
      const list = await get('/v2/profiles');
      const p = (Array.isArray(list) ? list : []).find((x) => String(x?.type).toLowerCase() === 'personal');
      if (!p?.id) throw new WiseError({ status: 200, code: 'no_personal_profile', message: 'this token has no personal profile' });
      return p;
    },
    async balances(profileId) {
      const list = await get(`/v4/profiles/${encodeURIComponent(profileId)}/balances`, { types: 'STANDARD' });
      return Array.isArray(list) ? list : [];
    },
    statement,
    // Any range: windows of at most 460 days, rows joined, opening balance from
    // the oldest window and closing from the newest.
    async walkStatement(profileId, balanceId, { currency, from, to }) {
      const out = { rows: [], openingCents: null, closingCents: null };
      for (const [i, w] of statementWindows(from, to).entries()) {
        const s = await statement(profileId, balanceId, { currency, from: w.from, to: w.to });
        out.rows.push(...s.rows);
        if (i === 0) out.openingCents = s.openingCents;
        out.closingCents = s.closingCents;
      }
      return out;
    },
  };
}
