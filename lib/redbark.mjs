// Redbark API v2 client (https://redbark.com/docs/api-reference/v2/overview).
// Read only. Pins the version header, follows token pagination, walks date
// windows under the 5,000-row ceiling, honours Retry-After, and keeps the key
// in this closure: it is never logged, put in an error or sent off the API host.
import { addDays, zoneDate } from './dates.mjs';

export const API_BASE = 'https://api.redbark.com/v2';
export const API_VERSION = '2026-10-01.wattle';

const MAX_WAIT_MS = 120_000; // a Retry-After longer than this fails the call instead of stalling a sync
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_PAGES = 1000; // 100,000 rows per walk, far past the 5,000 row ceiling

export class RedbarkError extends Error {
  constructor({ status, code, type, message, requestId, retryAfter }) {
    super(`Redbark ${status || 'network'} ${code}: ${message}`);
    this.name = 'RedbarkError';
    this.status = status;
    this.code = code;
    this.type = type ?? null;
    this.requestId = requestId ?? null;
    this.retryAfter = retryAfter ?? null;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseRetryAfter(v) {
  if (v == null || v === '') return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

export function createClient({
  key, base = API_BASE, fetchImpl = globalThis.fetch, sleep = defaultSleep,
  maxRetries = 4, timeoutMs = 30_000, concurrency = 3, today = () => zoneDate(),
} = {}) {
  if (!key) throw new Error('Redbark API key missing');
  const root = base.replace(/\/$/, '');
  const { origin, pathname: basePath } = new URL(root);

  // Heavy endpoints allow 4 in flight per key; stay under it.
  let active = 0;
  const waiting = [];
  const acquire = () => (active < concurrency ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

  function buildUrl(path, query) {
    if (/^https?:\/\//i.test(path)) {
      const u = new URL(path);
      if (u.origin !== origin || !u.pathname.startsWith(`${basePath}/`)) {
        throw new Error('Redbark next_page_url points outside the API base, refusing to follow it');
      }
      return u.toString();
    }
    const u = new URL(root + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, String(x)));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async function request(path, { method = 'GET', query, body } = {}) {
    const url = buildUrl(path, query);
    for (let attempt = 0; ; attempt++) {
      await acquire();
      let res;
      let text;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            'Redbark-Version': API_VERSION,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error', // the key never travels on a redirect
        });
        text = await res.text();
      } catch (e) {
        if (attempt >= maxRetries) {
          throw new RedbarkError({ status: 0, code: 'network_error', message: e?.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000}s` : String(e?.message ?? e) });
        }
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      } finally {
        release();
      }

      // Proactive pacing: out of budget for this window, wait for the reset.
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      if (remaining !== null && Number(remaining) <= 0 && reset > 0) {
        await sleep(Math.min(65_000, Math.max(0, reset * 1000 - Date.now() + 250)));
      }

      if (res.ok) {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch {
          throw new RedbarkError({ status: res.status, code: 'bad_json', message: 'response was not JSON' });
        }
        return { body: parsed, headers: res.headers, status: res.status };
      }

      let e = {};
      try { e = JSON.parse(text)?.error ?? {}; } catch {}
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const err = new RedbarkError({
        status: res.status, code: e.code ?? `http_${res.status}`, type: e.type,
        message: e.message ?? (res.statusText || 'request failed'), requestId: e.request_id, retryAfter,
      });
      if (!RETRYABLE.has(res.status) || attempt >= maxRetries || (retryAfter ?? 0) > MAX_WAIT_MS) throw err;
      await sleep(retryAfter ?? Math.min(30_000, 1000 * 2 ** attempt));
    }
  }

  async function* pages(path, query) {
    let next = path;
    let q = query;
    const seenUrls = new Set();
    while (next) {
      if (seenUrls.has(next) || seenUrls.size >= MAX_PAGES) throw new Error('Redbark pagination looped or ran past the page ceiling');
      seenUrls.add(next);
      const r = await request(next, { query: q });
      yield { data: r.body?.data ?? [], truncated: r.headers.get('x-redbark-truncated') === 'true' };
      next = r.body?.next_page_url ?? null;
      q = undefined;
    }
  }

  async function listAll(path, query) {
    const out = [];
    for await (const p of pages(path, query)) out.push(...p.data);
    return out;
  }

  // Walk one account's transactions over [from, to], newest first. When the
  // row ceiling truncates a window, the rows above its oldest date are
  // complete, so walk again over [from, that date]. Rows reach onRows once.
  async function walkTransactions({ account, from, to = today(), includePending = true, onRows }) {
    if (!account) throw new Error('walkTransactions needs an account');
    const seen = new Set();
    const result = { count: 0, splits: 0, oldest: null, newest: null, from, incomplete: false };

    async function walk(f, t) {
      let windowOldest = null;
      let truncated = false;
      for await (const page of pages('/transactions', { account, from: f, to: t, limit: 100, include_pending: includePending ? 'true' : undefined })) {
        truncated ||= page.truncated;
        const fresh = [];
        for (const row of page.data) {
          if (!windowOldest || row.date < windowOldest) windowOldest = row.date;
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          fresh.push(row);
          if (!result.oldest || row.date < result.oldest) result.oldest = row.date;
          if (!result.newest || row.date > result.newest) result.newest = row.date;
        }
        if (fresh.length) await onRows(fresh);
      }
      if (!truncated) return;
      result.splits += 1;
      const cut = windowOldest ?? f;
      if (cut === t) {
        // More rows on a single day than the ceiling: cannot narrow further.
        result.incomplete = true;
        if (f < t) await walk(f, addDays(t, -1));
      } else {
        await walk(f, cut);
      }
    }

    for (let tries = 0; ; tries++) {
      try {
        await walk(result.from, to);
        break;
      } catch (e) {
        if (!(e instanceof RedbarkError && e.code === 'from_too_old') || tries > 60) throw e;
        result.from = addDays(result.from, 7);
        if (result.from > to) break;
      }
    }
    result.count = seen.size;
    return result;
  }

  return {
    request,
    pages,
    listAll,
    walkTransactions,
    me: async () => (await request('/me')).body,
    connections: () => listAll('/connections', { limit: 100 }),
    accounts: () => listAll('/accounts', { limit: 100 }),
    details: async (id) => (await request(`/accounts/${encodeURIComponent(id)}/details`)).body,
    async balances(ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 20) out.push(...(await listAll('/balances', { account: ids.slice(i, i + 20) })));
      return out;
    },
  };
}
