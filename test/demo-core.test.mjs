// Demo mode in core.js: the dollar formatters honour the factor, the single
// write choke point blocks writes, the offline queue neither takes nor sends
// one, and the factor survives a reload. core.js is a classic script that
// wants a page, so it is loaded into a vm context with a stub DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(ROOT, 'public', f), 'utf8');

function boot(stored = null) {
  const ls = new Map(stored ? [['mint:demo', JSON.stringify(stored)]] : []);
  const calls = [];
  const el = () => new Proxy(function () {}, {
    get: (t, k) => (k === 'classList' ? { add() {}, remove() {}, toggle() {}, contains: () => false } : k === 'style' ? {} : k === 'dataset' ? {} : k === 'innerHTML' || k === 'textContent' ? '' : k === 'hidden' ? true : () => el()),
    set: () => true,
  });
  const ctx = {
    console, setTimeout: (fn, ms) => setTimeout(fn, ms).unref?.() ?? 0, clearTimeout, Intl, Date, Math, JSON, Promise, Number, String, Object, Array, Map, Set, URLSearchParams, Error, requestAnimationFrame: () => 0, performance,
    document: { querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, createElement: () => el(), dispatchEvent() {}, body: el(), documentElement: el() },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    navigator: { onLine: true, vibrate() {} },
    localStorage: { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), get length() { return ls.size; }, key: (i) => [...ls.keys()][i] },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    fetch: async (url, opts) => { calls.push({ url, method: opts?.method ?? 'GET' }); return { ok: true, status: 200, type: 'basic', json: async () => ({ ok: true }), statusText: 'OK' }; },
    indexedDB: undefined, UxModel: { shortAgo: () => '' },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  Object.keys(ctx); // keep order stable
  vm.createContext(ctx);
  vm.runInContext(src('demo-math.js'), ctx, { filename: 'demo-math.js' });
  vm.runInContext(src('core.js'), ctx, { filename: 'core.js' });
  const get = (expr) => vm.runInContext(expr, ctx);
  return { ctx, ls, calls, get, run: (code) => vm.runInContext(code, ctx) };
}

const ON = (factor) => ({ on: true, factor });

test('demo off: the formatters print the real figures', () => {
  const { get } = boot();
  assert.equal(get('money(123456)'), '$1,234.56');
  assert.equal(get('money0(123456)'), '$1,235');
  assert.equal(get('signed(5000)'), '+$50.00');
  assert.equal(get('signed(-5000)'), '-$50.00');
  assert.equal(get('compact(250000)'), '$2.5k');
  assert.equal(get('demoActive()'), false);
});

test('demo on: money, money0, signed, compact and signedMoney all scale by the one factor', () => {
  const { get } = boot(ON(2));
  assert.equal(get('money(123456)'), '$2,469.12');
  assert.equal(get('money0(123456)'), '$2,469');
  assert.equal(get('signed(5000)'), '+$100.00');
  assert.equal(get('signed(-5000)'), '-$100.00');
  assert.equal(get('compact(250000)'), '$5k');
  assert.equal(get('compact(-250000)'), '-$5k');
  assert.equal(get('compact(120000000)'), '$2.4m');
  assert.equal(get('demoActive()'), true);
});

test('demo on: a missing balance stays "No balance yet" and zero stays zero', () => {
  const { get } = boot(ON(1.9));
  assert.equal(get('money(null)'), 'No balance yet');
  assert.equal(get('money(0)'), '$0.00');
  assert.equal(get('money0(null)'), '$0');
});

test('demo on: tiles still add up to net worth, and percentages are untouched', () => {
  const { get } = boot(ON(0.4));
  const tiles = [1234567, -250000, 99999];
  const total = tiles.reduce((a, b) => a + b, 0);
  const shown = (c) => Number(get(`money(${c})`).replace(/[^0-9.-]/g, ''));
  const sumShown = tiles.reduce((a, c) => a + shown(c), 0);
  assert.ok(Math.abs(sumShown - shown(total)) < 0.03, `${sumShown} vs ${shown(total)}`);
  assert.equal(get('pct(0.1234)'), '12.34%');
  assert.equal(get('plural(3, "txn")'), '3 txns');
});

test('unit prices scale too, so units times price still equals the scaled value', () => {
  const { get } = boot(ON(2));
  assert.equal(get('unitPrice(12.5, "AUD")'), '$25.00');
  assert.equal(get('unitPrice(12.5, "USD")'), 'US$25.00');
  const off = boot();
  assert.equal(off.get('unitPrice(12.5, "AUD")'), '$12.50');
});

test('form fields prefilled from real money show the scaled figure', () => {
  assert.equal(boot(ON(2)).get('centsToInput(12345)'), '246.90');
  assert.equal(boot().get('centsToInput(12345)'), '123.45');
});

test('server sentences with dollars baked in are scaled client side', () => {
  assert.equal(boot(ON(2)).get('moneyText("Safe to spend $100.00 until payday")'), 'Safe to spend $200.00 until payday');
  assert.equal(boot().get('moneyText("Safe to spend $100.00 until payday")'), 'Safe to spend $100.00 until payday');
});

test('account numbers, last-4 digits and BSBs are masked in demo mode only', () => {
  const on = boot(ON(2));
  assert.equal(on.get('acctText("xxxx4710")'), 'xxxx••••');
  assert.equal(on.get('accountName({ name: "Income 2509", nickname: null })'), 'Income ••••');
  assert.equal(on.get('accountName({ name: "Everyday", nickname: "Pay 1234" })'), 'Pay ••••');
  const off = boot();
  assert.equal(off.get('acctText("xxxx4710")'), 'xxxx4710');
  assert.equal(off.get('accountName({ name: "Income 2509", nickname: null })'), 'Income 2509');
});

test('the factor persists across a reload while demo is on', () => {
  const a = boot();
  a.run('setDemo(true)');
  const f = a.get('demo.factor');
  assert.equal(a.get('demo.on'), true);
  assert.deepEqual(JSON.parse(a.ls.get('mint:demo')), { on: true, factor: f });
  const b = boot(JSON.parse(a.ls.get('mint:demo')));
  assert.equal(b.get('demo.factor'), f);
  assert.equal(b.get('money(100000)'), a.get('money(100000)'));
});

test('turning demo off stores off and prints real figures again', () => {
  const a = boot(ON(2));
  a.run('setDemo(false)');
  assert.deepEqual(JSON.parse(a.ls.get('mint:demo')), { on: false, factor: null });
  assert.equal(a.get('money(100000)'), '$1,000.00');
});

test('shuffle picks a new factor and stores it', () => {
  const a = boot(ON(2));
  a.run('shuffleDemo()');
  const f = a.get('demo.factor');
  assert.notEqual(f, 2);
  assert.equal(JSON.parse(a.ls.get('mint:demo')).factor, f);
});

test('a hand-edited storage value cannot leave a factor near 1 on screen', () => {
  const { get } = boot({ on: true, factor: 1.02 });
  assert.equal(get('demoActive()'), false);
  assert.equal(get('money(100000)'), '$1,000.00');
});

test('the factor is never sent to the server: storage is the only place it lives', () => {
  const a = boot();
  a.run('setDemo(true)');
  a.run('shuffleDemo()');
  assert.deepEqual(a.calls, []);
});

// the write choke point

test('demo on: a write through api() never reaches fetch and says why', async () => {
  const { run, calls, get } = boot(ON(2));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const err = await run(`api('/api/budgets/3', { method: '${method}', body: { cycle_target: 1 } }).then(() => null, (e) => e)`);
    assert.ok(err, `${method} rejected`);
    assert.equal(err.detail, 'Turn off demo mode to make changes');
    assert.equal(err.demo, true);
  }
  assert.deepEqual(calls, []);
  assert.equal(get('document.querySelector("#toasts") !== null'), true);
});

test('demo on: a write through mutate() is refused and never queued', async () => {
  const { run, calls } = boot(ON(2));
  const err = await run(`mutate({ method: 'PATCH', path: '/api/accounts/x', body: { business: true } }).then(() => null, (e) => e)`);
  assert.equal(err.demo, true);
  assert.deepEqual(calls, []);
  assert.equal(JSON.stringify(run('queue.all()')), '[]');
});

test('demo on: a direct queue.push is dropped, and the flush sends nothing', async () => {
  const { run, calls, ls } = boot(ON(2));
  run(`queue.push({ method: 'POST', path: '/api/goals', body: {} })`);
  assert.equal(JSON.stringify(run('queue.all()')), '[]');
  // A change queued before demo was switched on stays put and does not go out while demo is on.
  ls.set('mint:queue', JSON.stringify([{ method: 'POST', path: '/api/goals', body: { name: 'x' }, at: 1 }]));
  await run('queue.flush()');
  assert.deepEqual(calls, []);
  assert.equal(JSON.parse(ls.get('mint:queue')).length, 1);
});

test('demo off: the queue flushes as before', async () => {
  const { run, calls, ls } = boot();
  ls.set('mint:queue', JSON.stringify([{ method: 'POST', path: '/api/goals', body: { name: 'x' }, at: 1 }]));
  await run('queue.flush()');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
});

test('demo on: reads and the read-only POSTs still go out', async () => {
  const { run, calls } = boot(ON(2));
  await run(`api('/api/accounts')`);
  await run(`api('/api/rules/preview', { method: 'POST', body: { pattern: 'x' } })`);
  await run(`api('/api/budgets/starter', { method: 'POST', body: { dry_run: true } })`);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['GET /api/accounts', 'POST /api/rules/preview', 'POST /api/budgets/starter']);
});

test('demo on: undoable() refuses before changing anything on screen', () => {
  const { run } = boot(ON(2));
  const out = run(`(() => { let applied = false; undoable({ label: 'Alert dismissed', apply: () => { applied = true; }, revert() {}, op: { method: 'POST', path: '/api/alerts/1/dismiss' } }); return applied; })()`);
  assert.equal(out, false);
});

test('demo off: undoable() applies as before', () => {
  const { run } = boot();
  const out = run(`(() => { let applied = false; undoable({ label: 'Alert dismissed', apply: () => { applied = true; }, revert() {}, op: { method: 'POST', path: '/api/alerts/1/dismiss' } }); return applied; })()`);
  assert.equal(out, true);
});

test('the receipt photo queue refuses a photo in demo mode', async () => {
  const { run } = boot(ON(2));
  const r = await run(`receiptQueue.add('tx1', { type: 'image/jpeg', name: 'a.jpg' }).then(() => 'added', () => 'refused')`);
  assert.equal(r, 'refused');
});

test('a typed amount on a scaled form reads back to real cents, so form checks agree with the screen', () => {
  const on = boot(ON(2));
  assert.equal(on.get('parseMoney("200")'), 10000);
  assert.equal(on.get('parseMoney(centsToInput(12345))'), 12345);
  assert.equal(on.get('dollarsIn(10)'), '20');
  assert.equal(on.get('dollarsIn(null)'), '');
  const off = boot();
  assert.equal(off.get('parseMoney("200")'), 20000);
  assert.equal(off.get('dollarsIn(10)'), 10);
  assert.ok(Number.isNaN(on.get('parseMoney("abc")')));
});

// Demo switched on while a flush is mid-flight: the next api() call throws the demo refusal.
// That must read like being offline, never like the server refusing the change.
test('a flush interrupted by demo mode keeps the queued item and everything after it', async () => {
  const { run, ls, calls } = boot();
  const q = [1, 2, 3].map((n) => ({ method: 'POST', path: `/api/goals`, body: { name: `g${n}` }, at: n }));
  ls.set('mint:queue', JSON.stringify(q));
  // Demo goes on while the first change is in flight.
  run(`globalThis.fetch = async (url, opts) => { setDemo(true); return { ok: true, status: 200, type: 'basic', json: async () => ({ ok: true }), statusText: 'OK' }; }`);
  run(`globalThis.toasts = []; toast = (m) => globalThis.toasts.push(m)`);
  await run('queue.flush()');
  assert.deepEqual(JSON.parse(ls.get('mint:queue')).map((o) => o.body.name), ['g2', 'g3']);
  assert.equal(calls.length, 0);
  assert.ok(!run('toasts').some((m) => /refused/.test(m)), 'no "refused" toast for a demo stop');
  assert.equal(run('queue.flushing'), false);
});

test('a flush that hits the demo refusal on the first item drops nothing, then resumes once demo is off', async () => {
  const { run, ls, calls } = boot();
  const q = [1, 2].map((n) => ({ method: 'POST', path: `/api/goals`, body: { name: `g${n}` }, at: n }));
  ls.set('mint:queue', JSON.stringify(q));
  // The guard flips between flush's own demo check and the request.
  run(`{ const real = apiCall; apiCall = async (p, o) => { throw demoError(); }; globalThis.__real = real; }`);
  run(`globalThis.toasts = []; toast = (m) => globalThis.toasts.push(m)`);
  await run('queue.flush()');
  assert.equal(JSON.parse(ls.get('mint:queue')).length, 2);
  assert.ok(!run('toasts').some((m) => /refused/.test(m)));
  run('apiCall = globalThis.__real');
  await run('queue.flush()');
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(ls.get('mint:queue')).length, 0);
});

// A figure typed on a scaled screen must never come back as a prefill once demo is off.
test('a draft saved during demo mode is not restored after demo is turned off', () => {
  const { run, ls } = boot(ON(2));
  run(`drafts.set('goal:new', { target: '2000.00' })`);
  run('setDemo(false)');
  assert.equal(run(`drafts.get('goal:new')`), null);
  assert.equal(ls.get('mint:draft:goal:new') ?? null, null);
});

test('a real draft typed before demo is kept, hidden while demo is on, and back after it', () => {
  const { run } = boot();
  run(`drafts.set('goal:new', { target: '1000.00' })`);
  run('setDemo(true)');
  assert.equal(run(`drafts.get('goal:new')`), null, 'real figures must not prefill a demo screen');
  run(`drafts.set('goal:new', { target: '2000.00' })`);
  run('setDemo(false)');
  assert.deepEqual(JSON.parse(JSON.stringify(run(`drafts.get('goal:new')`))), { target: '1000.00' });
});

// made-up balances for empty cash accounts (core.js side)

const seedAccounts = () => ({ accounts: [
  { id: 'spend', type: 'transaction', balance_current: 250000, hidden: 0 },
  { id: 'off', type: 'transaction', balance_current: 0, hidden: 0 },
  { id: 'loan', type: 'loan', balance_current: -44900000, hidden: 0 },
] });

test('demo on: an empty cash account shows money, the loan and the funded account do not change', () => {
  const b = boot(ON(2));
  b.run(`accountsData = ${JSON.stringify(seedAccounts())}`);
  const shown = b.get('shownAccounts()');
  assert.ok(shown.find((a) => a.id === 'off').balance_current > 100000, 'the empty account has a made-up balance');
  assert.equal(shown.find((a) => a.id === 'spend').balance_current, 250000);
  assert.equal(shown.find((a) => a.id === 'loan').balance_current, -44900000);
  assert.equal(b.get('accountsData.accounts.find((a) => a.id === "off").balance_current'), 0, 'the real list is untouched');
  assert.notEqual(b.get('money(shownAccount(accountsData.accounts[1]).balance_current)'), '$0.00');
});

test('demo off: shownAccounts and shownNw are the real data', () => {
  const b = boot();
  b.run(`accountsData = ${JSON.stringify(seedAccounts())}`);
  assert.equal(b.get('shownAccounts() === accountsData.accounts'), true);
  assert.equal(b.get('shownAccount(accountsData.accounts[1]).balance_current'), 0);
  assert.equal(b.get('(() => { const n = { net_worth: 5, accounts: [] }; return shownNw(n) === n; })()'), true);
});

test('demo on: shownNw raises net worth and the cash tile by the made-up balance, as Home draws them', () => {
  const b = boot(ON(2));
  b.run(`accountsData = ${JSON.stringify(seedAccounts())}`);
  const nw = { assets: 250000, liabilities: 44900000, net_worth: -44650000, groups: { cash: 250000, cards: 0, loans: -44900000, investments: 0 }, accounts: [
    { id: 'spend', type: 'transaction', group: 'cash', balance: 250000, manual: false, currency: 'AUD' },
    { id: 'off', type: 'transaction', group: 'cash', balance: 0, manual: false, currency: 'AUD' },
    { id: 'loan', type: 'loan', group: 'loans', balance: -44900000, manual: false, currency: 'AUD' },
  ] };
  b.run(`var NW = ${JSON.stringify(nw)}`);
  const out = b.get('shownNw(NW)');
  const fake = b.get('shownAccounts().find((a) => a.id === "off").balance_current');
  assert.equal(out.groups.cash, 250000 + fake);
  assert.equal(out.net_worth, -44650000 + fake);
  assert.equal(b.get('NW.groups.cash'), 250000, 'real data is never altered');
});

test('the screens read balances through the demo overlay', () => {
  const read = (f) => readFileSync(join(ROOT, 'public', f), 'utf8');
  assert.match(read('home.js'), /shownNw\(data\.nw\)/);
  assert.match(read('home.js'), /accountsBlock\(shownAccounts\(\)/);
  assert.match(read('core.js'), /shownAccounts\(\)\.filter\(\(a\) => !a\.hidden\)/);
  assert.match(read('account.js'), /shownAccount\(/);
  assert.match(read('accounts.js'), /shownAccount\(/);
  assert.match(read('save.js'), /shownSavings\(/);
  assert.match(read('goals.js'), /shownGoals\(/); // the goals list moved out of save.js
});
