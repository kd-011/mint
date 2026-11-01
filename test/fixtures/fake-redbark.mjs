// A fake Redbark v2 API over invented fixtures: auth and version headers,
// token pagination, the row ceiling with X-Redbark-Truncated, from_too_old,
// and injectable failures (429 with Retry-After and friends).
import { createServer } from 'node:http';

export const FAKE_KEY = 'rbk_test_fake_key_do_not_use';

export function fakeRedbark({
  connections = [], accounts = [], balances = {}, details = {}, transactions = {},
  oldest = '2019-10-24', today = '2026-10-17', ceiling = 5000, base = 'https://api.redbark.test/v2',
  unavailable = [],
} = {}) {
  const calls = [];
  const failures = [];
  const state = { base, transactions };

  function json(status, body, headers = {}) {
    return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
  }
  function err(status, code, message, headers = {}) {
    return json(status, { error: { type: 'invalid_request_error', code, message, param: null, doc_url: '', request_id: 'req_test' } }, headers);
  }
  function list(data, url, extra = {}) {
    return json(200, { object: 'list', data, next_page_url: null, previous_page_url: null, ...extra });
  }

  function handle(method, rawUrl, headers) {
    const url = new URL(rawUrl, state.base);
    const path = url.pathname.replace(/^\/v2/, '');
    const call = { method, path, query: Object.fromEntries(url.searchParams), auth: headers.authorization, version: headers['redbark-version'] };
    calls.push(call);
    const f = failures.findIndex((x) => x.match.test(path) && x.times > 0);
    if (f >= 0) {
      failures[f].times -= 1;
      const x = failures[f];
      return err(x.status, x.code ?? 'rate_limit_exceeded', x.message ?? 'slow down', x.headers ?? {});
    }
    if (headers.authorization !== `Bearer ${FAKE_KEY}`) return err(401, 'invalid_api_key', 'bad key');
    if (headers['redbark-version'] !== '2026-10-01.wattle') return err(400, 'version_required', 'version header');
    if (method === 'GET' && path === '/connections') return list(connections);
    if (method === 'GET' && path === '/accounts') return list(accounts);
    if (method === 'GET' && path === '/balances') {
      const ids = url.searchParams.getAll('account');
      return list(ids.map((id) => ({
        object: 'balance', account: id, currency: 'aud', observed_at: `${today}T01:00:00.000Z`,
        freshness: balances[id] ? 'fresh' : 'unavailable', livemode: false,
        current: balances[id]?.current ?? null, available: balances[id]?.available ?? null,
      })));
    }
    let m = /^\/accounts\/([^/]+)\/details$/.exec(path);
    if (method === 'GET' && m) return details[m[1]] ? json(200, details[m[1]]) : err(400, 'not_supported', 'no details');
    if (method === 'GET' && path === '/transactions') {
      const account = url.searchParams.get('account');
      if (!account) return err(400, 'parameter_missing', 'account is required');
      if (unavailable.includes(account)) return err(404, 'account_unavailable', 'account gone');
      const from = url.searchParams.get('from') ?? addDays(today, -30);
      const to = url.searchParams.get('to') ?? today;
      if (from < oldest) return err(400, 'from_too_old', 'from is too old');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 100);
      const pending = url.searchParams.get('include_pending') === 'true';
      const rows = (state.transactions[account] ?? [])
        .filter((t) => t.date >= from && t.date <= to && (pending || t.status !== 'pending'))
        .sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1));
      const truncated = rows.length > ceiling;
      const capped = rows.slice(0, ceiling);
      const offset = url.searchParams.get('page') ? Number(Buffer.from(url.searchParams.get('page'), 'base64url').toString()) : 0;
      const page = capped.slice(offset, offset + limit);
      let next = null;
      if (offset + limit < capped.length) {
        const n = new URL(url);
        n.searchParams.set('page', Buffer.from(String(offset + limit)).toString('base64url'));
        next = n.toString();
      }
      return json(200, { object: 'list', data: page, next_page_url: next, previous_page_url: null },
        truncated ? { 'x-redbark-truncated': 'true' } : {});
    }
    return err(404, 'route_missing', 'no route');
  }

  async function fetchImpl(input, init = {}) {
    const headers = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
    const r = handle(init.method ?? 'GET', String(input), headers);
    return new Response(r.body, { status: r.status, headers: r.headers });
  }

  // Real HTTP form for the server test.
  function listen() {
    return new Promise((resolve) => {
      const srv = createServer((req, res) => {
        const r = handle(req.method, `http://${req.headers.host}${req.url}`, req.headers);
        res.writeHead(r.status, r.headers);
        res.end(r.body);
      });
      srv.listen(0, '127.0.0.1', () => {
        state.base = `http://127.0.0.1:${srv.address().port}/v2`;
        resolve({ server: srv, base: state.base });
      });
    });
  }

  return {
    fetch: fetchImpl, listen, calls, state,
    fail(match, status, opts = {}) { failures.push({ match, status, times: opts.times ?? 1, ...opts }); },
  };
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
