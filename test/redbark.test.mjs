import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, RedbarkError, API_VERSION } from '../lib/redbark.mjs';
import { fakeRedbark, FAKE_KEY } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';

function setup(opts = {}) {
  const fake = fakeRedbark({ ...fx, transactions: opts.transactions ?? {}, ...opts.fake });
  const slept = [];
  const client = createClient({
    key: FAKE_KEY, base: fake.state.base, fetchImpl: fake.fetch,
    sleep: async (ms) => { slept.push(ms); }, maxRetries: opts.maxRetries ?? 4,
  });
  return { fake, client, slept };
}

test('every call carries the bearer key and the pinned version header', async () => {
  const { fake, client } = setup();
  await client.connections();
  await client.accounts();
  assert.equal(API_VERSION, '2026-10-01.wattle');
  assert.ok(fake.calls.length >= 2);
  for (const c of fake.calls) {
    assert.equal(c.auth, `Bearer ${FAKE_KEY}`);
    assert.equal(c.version, '2026-10-01.wattle');
  }
});

test('accounts and balances come back as plain arrays', async () => {
  const { client } = setup();
  const accounts = await client.accounts();
  assert.equal(accounts.length, 4);
  const bal = await client.balances(accounts.map((a) => a.id));
  assert.equal(bal.length, 4);
  assert.equal(bal.find((b) => b.account === 'acct_test_card').current.amount, -50000);
});

test('loan details', async () => {
  const { client } = setup();
  const d = await client.details('acct_test_loan');
  assert.equal(d.loan_details.offset_account_enabled, true);
});

test('token pagination follows next_page_url to the end', async () => {
  const rows = fx.history('acct_test_everyday', '2026-01-01', '2026-10-17', 1);
  const { client, fake } = setup({ transactions: { acct_test_everyday: rows } });
  const got = [];
  const res = await client.walkTransactions({ account: 'acct_test_everyday', from: '2026-01-01', to: '2026-10-17', onRows: (r) => got.push(...r) });
  assert.equal(got.length, rows.length);
  assert.equal(new Set(got.map((r) => r.id)).size, rows.length);
  assert.ok(fake.calls.filter((c) => c.path === '/transactions').length >= 3, 'more than one page');
  assert.equal(res.count, rows.length);
});

test('a truncated window is split until every row is fetched exactly once', async () => {
  const rows = fx.history('acct_test_everyday', '2024-01-01', '2026-10-17', 1);
  const { client } = setup({ transactions: { acct_test_everyday: rows }, fake: { ceiling: 250 } });
  const seen = new Map();
  const res = await client.walkTransactions({ account: 'acct_test_everyday', from: '2024-01-01', to: '2026-10-17', onRows: (r) => r.forEach((t) => seen.set(t.id, t)) });
  assert.equal(seen.size, rows.length);
  assert.ok(res.splits > 0, 'reported that it had to split');
  assert.equal(res.oldest, '2024-01-01');
});

test('from_too_old moves the start forward instead of failing', async () => {
  const rows = fx.history('acct_test_everyday', '2020-01-01', '2020-03-01', 5);
  const { client } = setup({ transactions: { acct_test_everyday: rows }, fake: { oldest: '2019-12-01' } });
  const got = [];
  const res = await client.walkTransactions({ account: 'acct_test_everyday', from: '2019-10-24', to: '2020-03-01', onRows: (r) => got.push(...r) });
  assert.equal(got.length, rows.length);
  assert.ok(res.from >= '2019-12-01');
});

test('429 honours Retry-After and then succeeds', async () => {
  const { client, fake, slept } = setup();
  fake.fail(/^\/accounts$/, 429, { headers: { 'retry-after': '7' }, times: 2 });
  const accounts = await client.accounts();
  assert.equal(accounts.length, 4);
  assert.deepEqual(slept.filter((ms) => ms >= 1000), [7000, 7000]);
});

test('503 provider_wait is retried too', async () => {
  const { client, fake, slept } = setup();
  fake.fail(/^\/connections$/, 503, { code: 'provider_wait', headers: { 'retry-after': '2' } });
  assert.equal((await client.connections()).length, 2);
  assert.ok(slept.includes(2000));
});

test('gives up after maxRetries with a typed error', async () => {
  const { client, fake } = setup({ maxRetries: 2 });
  fake.fail(/^\/accounts$/, 429, { headers: { 'retry-after': '1' }, times: 10 });
  await assert.rejects(client.accounts(), (e) => e instanceof RedbarkError && e.status === 429 && e.code === 'rate_limit_exceeded');
});

test('4xx errors fail fast with the Redbark code and never leak the key', async () => {
  const { client, fake } = setup();
  fake.fail(/^\/connections$/, 400, { code: 'parameter_invalid', message: 'nope' });
  const err = await client.connections().catch((e) => e);
  assert.ok(err instanceof RedbarkError);
  assert.equal(err.code, 'parameter_invalid');
  assert.equal(fake.calls.filter((c) => c.path === '/connections').length, 1, 'no retry on 400');
  assert.ok(!String(err.message).includes(FAKE_KEY));
  assert.ok(!String(err.stack).includes(FAKE_KEY));
  assert.ok(!JSON.stringify(err).includes(FAKE_KEY));
});

test('refuses to send the key to a next_page_url on another host', async () => {
  const leaked = [];
  const client = createClient({
    key: FAKE_KEY, base: 'https://api.redbark.test/v2', sleep: async () => {},
    fetchImpl: async (url, init) => {
      if (!String(url).startsWith('https://api.redbark.test/')) leaked.push(init.headers);
      return new Response(JSON.stringify({ object: 'list', data: [], next_page_url: 'https://evil.example/v2/accounts?page=x', previous_page_url: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await assert.rejects(client.accounts(), /next_page_url/);
  assert.equal(leaked.length, 0);
});

test('requires a key', () => {
  assert.throws(() => createClient({ key: '' }), /key/);
});
