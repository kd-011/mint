// A stand-in for the Wise Platform API over invented data: GET /v2/profiles,
// /v4/profiles/{id}/balances and the per-balance statement.json, with the real
// shapes (value/currency amounts, newest first, startOfStatementBalance and
// endOfStatementBalance, a 469 day window cap). Bearer auth is checked, only
// GET is allowed, and the failures a sync meets are injectable: 429 with
// Retry-After, 5xx, an SCA refusal (403 with x-2fa-approval) on balances or
// statements, a bad token, and an error body that echoes the Authorization
// header the way a careless proxy might.
export const FAKE_TOKEN = 'wise-test-token-0123456789abcdef';
export const PERSONAL_ID = 41001;
export const BUSINESS_ID = 41002;

const DAY = 86_400_000;
const value = (cents) => cents / 100;

export function fakeWise({ token = FAKE_TOKEN, balances = defaultBalances() } = {}) {
  const state = {
    calls: [], failures: [], sca: { balances: false, statements: false }, echoAuth: false,
    profiles: [
      { id: BUSINESS_ID, type: 'BUSINESS', fullName: 'Test Trading Pty Ltd' },
      { id: PERSONAL_ID, type: 'PERSONAL', fullName: 'Test Person' },
    ],
    balances,
  };

  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const total = (b) => b.start + b.rows.reduce((s, r) => s + r.cents, 0);

  function statement(b, qs) {
    const from = Date.parse(qs.get('intervalStart'));
    const to = Date.parse(qs.get('intervalEnd'));
    if (Number.isNaN(from) || Number.isNaN(to)) return json(400, { error: 'invalid_interval', message: 'bad interval' });
    if (to - from > 469 * DAY) return json(400, { error: 'invalid_interval', message: 'The interval cannot be more than 469 days' });
    if (qs.get('type') !== 'COMPACT') return json(400, { error: 'invalid_type', message: 'type must be COMPACT' });
    if (qs.get('currency') !== b.currency) return json(400, { error: 'invalid_currency', message: 'currency does not match the balance' });
    const before = b.start + b.rows.filter((r) => Date.parse(r.at) < from).reduce((s, r) => s + r.cents, 0);
    const inside = b.rows.filter((r) => Date.parse(r.at) >= from && Date.parse(r.at) <= to).sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
    let run = before + inside.reduce((s, r) => s + r.cents, 0);
    const transactions = inside.map((r) => {
      const row = {
        type: r.cents < 0 ? 'DEBIT' : 'CREDIT', date: r.at,
        amount: { value: value(r.cents), currency: b.currency, zero: false },
        totalFees: { value: 0, currency: b.currency, zero: true },
        details: { type: r.kind ?? 'CARD', description: r.desc },
        exchangeDetails: null, runningBalance: { value: value(run), currency: b.currency, zero: run === 0 }, referenceNumber: r.ref,
      };
      run -= r.cents;
      return row;
    });
    return json(200, {
      accountHolder: { type: 'PERSONAL', profileId: PERSONAL_ID, firstName: 'Test', lastName: 'Person' },
      transactions,
      startOfStatementBalance: { value: value(before), currency: b.currency, zero: before === 0 },
      endOfStatementBalance: { value: value(before + inside.reduce((s, r) => s + r.cents, 0)), currency: b.currency, zero: false },
      query: { intervalStart: qs.get('intervalStart'), intervalEnd: qs.get('intervalEnd'), type: 'COMPACT', currency: b.currency, profileId: PERSONAL_ID },
    });
  }

  const sca = () => json(403, { status: 403, error: 'Forbidden', message: 'You are forbidden to send this request' }, { 'x-2fa-approval': 'ott-invented', 'x-2fa-approval-result': 'REJECTED' });

  async function fetch(u, init = {}) {
    const url = new URL(String(u));
    const method = init.method ?? 'GET';
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? '';
    state.calls.push({ method, origin: url.origin, path: url.pathname, query: Object.fromEntries(url.searchParams), auth, redirect: init.redirect });
    const f = state.failures.findIndex((x) => x.match.test(url.pathname) && x.times > 0);
    if (f >= 0) {
      const x = state.failures[f];
      x.times -= 1;
      return json(x.status, { error: x.error ?? 'rate_limit', message: x.message ?? 'slow down' }, x.headers ?? {});
    }
    if (method !== 'GET') return json(405, { error: 'method_not_allowed' });
    if (auth !== `Bearer ${token}`) {
      return json(401, { error: 'invalid_token', error_description: state.echoAuth ? `Invalid token ${auth}` : 'Invalid token' });
    }
    if (url.pathname === '/v2/profiles') return json(200, state.profiles);
    let m = /^\/v4\/profiles\/(\d+)\/balances$/.exec(url.pathname);
    if (m) {
      if (Number(m[1]) !== PERSONAL_ID) return json(403, { error: 'forbidden', message: 'not your profile' });
      if (state.sca.balances) return sca();
      if (url.searchParams.get('types') !== 'STANDARD') return json(400, { error: 'invalid_types' });
      return json(200, state.balances.map((b) => ({
        id: b.id, currency: b.currency, type: 'STANDARD', visible: true,
        amount: { value: value(total(b) + (b.drift ?? 0)), currency: b.currency },
        reservedAmount: { value: 0, currency: b.currency }, cashAmount: { value: value(total(b) + (b.drift ?? 0)), currency: b.currency },
      })));
    }
    m = /^\/v1\/profiles\/(\d+)\/balance-statements\/(\d+)\/statement\.json$/.exec(url.pathname);
    if (m) {
      if (Number(m[1]) !== PERSONAL_ID) return json(403, { error: 'forbidden', message: 'not your profile' });
      const b = state.balances.find((x) => x.id === Number(m[2]));
      if (!b) return json(404, { error: 'not_found', message: 'no such balance' });
      if (state.sca.statements) return sca();
      return statement(b, url.searchParams);
    }
    return json(404, { error: 'not_found' });
  }

  return {
    fetch, state, token,
    fail: (match, status, extra = {}, times = 1) => state.failures.push({ match, status, times, ...extra }),
    balance: (currency) => state.balances.find((b) => b.currency === currency),
  };
}

// Invented: AUD with a row before the 12 month window (history) and three in it,
// USD with two, THB empty. start is the balance in cents before the first row.
export function defaultBalances() {
  return [
    {
      id: 7001, currency: 'AUD', start: 60_000, rows: [
        { ref: 'CARD-0000000900', at: '2025-08-01T03:00:00.000Z', cents: -777, desc: 'Card transaction of 7.77 AUD issued by TEST OLD SHOP' },
        { ref: 'CARD-0000001001', at: '2026-09-20T02:00:00.000Z', cents: -1999, desc: 'Card transaction of 19.99 AUD issued by TEST STREAMING' },
        { ref: 'CARD-0000001002', at: '2026-10-01T03:00:00.000Z', cents: -2500, desc: 'Card transaction of 25.00 AUD issued by TEST CAFE' },
        // 17:30 UTC on the 9th is 01:30 on the 10th in Perth.
        { ref: 'TRANSFER-0000001003', at: '2026-10-09T17:30:00.000Z', cents: 100_000, desc: 'Received money from TEST PAYER with reference invoice 12', kind: 'TRANSFER' },
      ],
    },
    {
      id: 7002, currency: 'USD', start: 0, rows: [
        { ref: 'MONEY_ADDED-0000002001', at: '2026-09-02T04:00:00.000Z', cents: 200_000, desc: 'Added money from TEST BANK', kind: 'MONEY_ADDED' },
        { ref: 'CARD-0000002002', at: '2026-10-05T04:00:00.000Z', cents: -4550, desc: 'Card transaction of 45.50 USD issued by TEST DINER' },
      ],
    },
    { id: 7003, currency: 'THB', start: 0, rows: [] },
  ];
}
