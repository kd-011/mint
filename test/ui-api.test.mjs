// API the six screens lean on: transaction filters, bulk edit, report
// series, review counts and the deductions list. A real server against a fake
// Redbark over invented data; dates are relative to today in Perth.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeRedbark, FAKE_KEY, addDays } from './fixtures/fake-redbark.mjs';
import * as fx from './fixtures/data.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth' }).format(new Date());
const FY = Number(T.slice(0, 4)) + (Number(T.slice(5, 7)) >= 7 ? 1 : 0);
let proc, base, fakeSrv;

function start(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ p, url: `http://127.0.0.1:${m[1]}` });
    });
    p.stderr.on('data', (d) => { out += d; });
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
}

const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const get = (path, headers = H) => fetch(base + path, { headers });
const send = (method, path, body) => fetch(base + path, { method, headers: { ...H, 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
const json = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };
const catId = async (name) => (await json(await get('/api/categories'))).items.find((c) => c.name === name).id;
const monthOf = (d) => d.slice(0, 7);

before(async () => {
  const e = 'acct_test_everyday';
  const transactions = {
    [e]: [
      fx.tx(e, addDays(T, -1), -8123, 'TEST GROCER         TESTVILLE    WA', { id: 'txn_ui_groc1', provider_category: 'FOOD_AND_DRINK' }),
      fx.tx(e, addDays(T, -2), -4410, 'TEST GROCER         TESTVILLE    WA', { id: 'txn_ui_groc2', provider_category: 'FOOD_AND_DRINK' }),
      fx.tx(e, addDays(T, -3), -2300, 'TEST NOODLE BAR', { id: 'txn_ui_noodle', provider_category: 'FOOD_AND_DRINK' }),
      fx.tx(e, addDays(T, -40), -7700, 'TEST GROCER         TESTVILLE    WA', { id: 'txn_ui_old', provider_category: 'FOOD_AND_DRINK' }),
      fx.tx(e, addDays(T, -4), -9900, 'TEST HARDWARE', { id: 'txn_ui_hw', provider_category: 'MERCHANDISE' }),
      fx.tx(e, addDays(T, -5), 400000, 'SALARY/WAGES TEST PERSON', { id: 'txn_ui_salary', provider_category: 'INCOME' }),
      fx.tx(e, addDays(T, -6), -50000, 'ONLINE X1 Linked Acc Trns', { id: 'txn_ui_xout', provider_category: 'TRANSFER_OUT' }),
      fx.tx(e, addDays(T, -7), -3000, 'TEST MYSTERY SHOP', { id: 'txn_ui_mystery', provider_category: 'UNMAPPED_THING' }),
    ],
    acct_test_offset: [fx.tx('acct_test_offset', addDays(T, -6), 50000, 'ONLINE X1 Linked Acc Trns', { provider_category: 'TRANSFER_IN' })],
  };
  const fake = fakeRedbark({ ...fx, today: T, transactions });
  const l = await fake.listen();
  fakeSrv = l.server;
  const s = await start({
    MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-uiapi-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner',
    REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: l.base,
  });
  proc = s.p;
  base = s.url;
  await send('POST', '/api/sync', {});
  for (let i = 0; i < 200; i++) {
    const st = await (await get('/api/sync')).json();
    if (!st.running && st.finishedAt) break;
    await new Promise((r) => setTimeout(r, 50));
  }
});

after(() => { proc?.kill('SIGTERM'); fakeSrv?.close(); });

test('the new endpoints need the gate identity', async () => {
  for (const p of ['/api/reports/monthly', '/api/reports/merchants', '/api/review', `/api/tax/deductions?fy=${FY}`]) {
    assert.equal((await get(p, {})).status, 401, p);
  }
  assert.equal((await fetch(`${base}/api/transactions/bulk`, { method: 'POST', body: '{}' })).status, 401);
});

test('transactions filter by date range, direction and source', async () => {
  const ids = async (q) => (await json(await get(`/api/transactions?limit=200&${q}`))).items.map((t) => t.id);
  assert.ok(!(await ids(`from=${addDays(T, -10)}`)).includes('txn_ui_old'));
  assert.deepEqual(await ids(`from=${addDays(T, -45)}&to=${addDays(T, -30)}`), ['txn_ui_old']);
  const out = (await json(await get('/api/transactions?limit=200&direction=out'))).items;
  assert.ok(out.length && out.every((t) => t.amount < 0));
  const inn = (await json(await get('/api/transactions?limit=200&direction=in'))).items;
  assert.ok(inn.length && inn.every((t) => t.amount > 0));
  const prov = (await json(await get('/api/transactions?limit=200&source=provider'))).items;
  assert.ok(prov.length && prov.every((t) => t.category_source === 'provider'));
  assert.equal((await get('/api/transactions?from=nope')).status, 400);
  assert.equal((await get('/api/transactions?direction=sideways')).status, 400);
  assert.equal((await get('/api/transactions?source=nope')).status, 400);
});

test('transactions filter by business and by deductible tag', async () => {
  await json(await send('PATCH', '/api/transactions/txn_ui_hw', { is_business: true }));
  const biz = (await json(await get('/api/transactions?limit=200&business=1'))).items.map((t) => t.id);
  assert.ok(biz.includes('txn_ui_hw'));
  const personal = (await json(await get('/api/transactions?limit=200&business=0'))).items.map((t) => t.id);
  assert.ok(!personal.includes('txn_ui_hw'));
  await json(await send('PUT', '/api/transactions/txn_ui_hw/tax', { ato_category: 'D5', deductible_amount: 5000 }));
  const tagged = (await json(await get('/api/transactions?limit=200&tax=1'))).items.map((t) => t.id);
  assert.deepEqual(tagged, ['txn_ui_hw']);
  const untagged = (await json(await get('/api/transactions?limit=200&tax=0'))).items.map((t) => t.id);
  assert.ok(!untagged.includes('txn_ui_hw') && untagged.length > 3);
});

test('bulk edit sets a category and the business flag on many rows at once', async () => {
  const groceries = await catId('Groceries');
  const r = await json(await send('POST', '/api/transactions/bulk', { ids: ['txn_ui_groc1', 'txn_ui_groc2', 'txn_ui_nope'], category_id: groceries, is_business: false }));
  assert.equal(r.updated, 2);
  const items = (await json(await get('/api/transactions?limit=200'))).items;
  for (const id of ['txn_ui_groc1', 'txn_ui_groc2']) {
    const t = items.find((x) => x.id === id);
    assert.equal(t.category_id, groceries);
    assert.equal(t.category_source, 'manual');
    assert.equal(t.business, false);
  }
  // Null hands the rows back to the rules.
  const back = await json(await send('POST', '/api/transactions/bulk', { ids: ['txn_ui_groc1'], category_id: null }));
  assert.equal(back.updated, 1);
  assert.notEqual((await json(await get('/api/transactions?limit=200'))).items.find((x) => x.id === 'txn_ui_groc1').category_source, 'manual');
});

test('bulk edit validates before it writes anything', async () => {
  const groceries = await catId('Groceries');
  assert.equal((await send('POST', '/api/transactions/bulk', { category_id: groceries })).status, 400);
  assert.equal((await send('POST', '/api/transactions/bulk', { ids: [], category_id: groceries })).status, 400);
  assert.equal((await send('POST', '/api/transactions/bulk', { ids: ['txn_ui_hw'] })).status, 400);
  assert.equal((await send('POST', '/api/transactions/bulk', { ids: ['txn_ui_hw'], category_id: 99999 })).status, 400);
  assert.equal((await send('POST', '/api/transactions/bulk', { ids: Array.from({ length: 501 }, (_, i) => `x${i}`), category_id: groceries })).status, 400);
  assert.equal((await send('POST', '/api/transactions/bulk', { ids: [7], category_id: groceries })).status, 400);
  assert.equal((await send('POST', '/api/transactions/bulk', { ids: ['txn_ui_hw'], is_business: 'yes' })).status, 400);
});

test('reports/monthly gives income, spend and spend by category per month, leaving transfers out', async () => {
  const from = monthOf(addDays(T, -45));
  const r = await json(await get(`/api/reports/monthly?from=${from}&to=${monthOf(T)}`));
  assert.ok(r.months.length >= 2);
  assert.deepEqual(r.months.map((m) => m.month), [...r.months.map((m) => m.month)].sort());
  const sumSpent = r.months.reduce((s, m) => s + m.spent, 0);
  const catSpent = r.categories.reduce((s, c) => s + c.spent, 0);
  assert.equal(sumSpent, catSpent);
  assert.equal(r.months.reduce((s, m) => s + m.income, 0), 400000);
  // 8123 + 4410 + 2300 + 7700 + 3000 of personal spend; the 50000 transfer and the business 9900 are out.
  assert.equal(sumSpent, 8123 + 4410 + 2300 + 7700 + 3000);
  const withBiz = await json(await get(`/api/reports/monthly?from=${from}&to=${monthOf(T)}&include_business=1`));
  assert.equal(withBiz.months.reduce((s, m) => s + m.spent, 0), sumSpent + 9900);
  const row = r.categories[0];
  for (const k of ['month', 'category_id', 'name', 'grp', 'spent']) assert.ok(k in row, k);
  assert.equal((await get('/api/reports/monthly?from=2026-13&to=2026-14')).status, 400);
  assert.equal((await get('/api/reports/monthly?from=2026-05&to=2026-01')).status, 400);
});

test('reports/merchants ranks merchants by spend in a window', async () => {
  const r = await json(await get(`/api/reports/merchants?from=${addDays(T, -60)}&to=${T}&limit=3`));
  assert.ok(r.items.length <= 3);
  assert.equal(r.items[0].merchant.toLowerCase().includes('grocer'), true);
  assert.equal(r.items[0].spent, 8123 + 4410 + 7700);
  assert.equal(r.items[0].count, 3);
  assert.ok(r.items.every((x, i, a) => i === 0 || a[i - 1].spent >= x.spent));
  assert.equal((await get('/api/reports/merchants?limit=0')).status, 400);
  assert.equal((await get('/api/reports/merchants?from=x')).status, 400);
});

test('review counts what needs a look', async () => {
  const r = await json(await get('/api/review'));
  for (const k of ['transfers', 'uncategorised', 'guessed', 'alerts', 'assets_due']) assert.equal(typeof r[k], 'number', k);
  assert.ok(r.uncategorised >= 1, 'the mystery shop has no category');
  const list = (await json(await get('/api/transactions?limit=200&category=none'))).items;
  assert.equal(r.uncategorised, list.length);
});

test('tax/deductions lists tagged spend with its receipts for a financial year', async () => {
  const r = await json(await get(`/api/tax/deductions?fy=${FY}`));
  const hw = r.items.find((x) => x.transaction_id === 'txn_ui_hw');
  assert.ok(hw);
  assert.equal(hw.deductible_amount, 5000);
  assert.equal(hw.amount, -9900);
  assert.equal(hw.ato_category, 'D5');
  assert.equal(hw.receipts, 0);
  assert.ok('label' in hw && 'merchant' in hw && 'date' in hw && 'account_name' in hw);
  assert.equal((await get('/api/tax/deductions?fy=abc')).status, 400);
});

test('an asset lists its snapshot history, newest first', async () => {
  const a = await json(await send('POST', '/api/assets', { name: 'Test Super', kind: 'super' }), 201);
  await json(await send('POST', `/api/assets/${a.id}/snapshots`, { date: addDays(T, -40), value: 900000, note: 'older' }));
  await json(await send('POST', `/api/assets/${a.id}/snapshots`, { date: T, value: 950000 }));
  const r = await json(await get(`/api/assets/${a.id}/snapshots`));
  assert.deepEqual(r.items.map((s) => [s.date, s.value, s.note]), [[T, 950000, null], [addDays(T, -40), 900000, 'older']]);
  assert.equal((await get('/api/assets/99999/snapshots')).status, 404);
  assert.equal((await get(`/api/assets/${a.id}/snapshots`, {})).status, 401);
});

test('an Always pick returns the rule row itself, so the client can undo it by id', async () => {
  const groceries = await catId('Groceries');
  const r = await json(await send('PATCH', '/api/transactions/txn_ui_noodle', { category_id: groceries, always: true }));
  assert.equal(typeof r.rule.id, 'number');
  assert.equal(r.rule.rule, undefined);
  assert.equal((await send('DELETE', `/api/rules/${r.rule.id}`)).status, 200);
});

test('v2 pay-cycle API: cycles, income, bills, safe to spend, plan, goals, debt, cycle budgets', async () => {
  const cur = await json(await get('/api/cycles/current'));
  assert.equal(cur.cycle.start, addDays(T, -5));
  assert.equal(cur.cycle.open, true);
  const list = await json(await get('/api/cycles'));
  assert.equal(list.items.length, 1);
  assert.equal((await json(await get(`/api/cycles/at?date=${addDays(T, -1)}`))).cycle.start, addDays(T, -5));
  assert.equal((await json(await get(`/api/cycles/at?date=${addDays(T, -30)}`))).cycle, null);
  assert.equal((await get('/api/cycles/at?date=nope')).status, 400);

  const inc = await json(await get('/api/income'));
  assert.equal(inc.salary.last.amount, 400000);
  assert.ok(inc.next_payday.date);
  const sources = await json(await get('/api/income/sources'));
  assert.ok(sources.items.some((s) => s.kind === 'salary'));
  const made = await json(await send('POST', '/api/income/sources', { name: 'Test side gig', kind: 'regular', pattern: 'TEST GIG', match: 'starts' }), 201);
  assert.equal((await json(await send('PATCH', `/api/income/sources/${made.id}`, { name: 'Gig' }))).name, 'Gig');
  assert.equal((await send('POST', '/api/income/sources', { name: 'x', kind: 'nope', pattern: 'x' })).status, 400);
  assert.equal((await json(await send('DELETE', `/api/income/sources/${made.id}`))).deleted, true);
  const pick = await json(await send('PATCH', '/api/income/transactions/txn_ui_salary', { kind: 'other' }));
  assert.equal(pick.income_kind, 'other');
  assert.equal((await json(await send('PATCH', '/api/income/transactions/txn_ui_salary', { auto: true }))).income_kind, 'salary');

  const bills = await json(await get('/api/bills'));
  assert.ok(Array.isArray(bills.items) && bills.cycle);
  const safe = await json(await get('/api/safe-to-spend'));
  assert.equal(typeof safe.safe, 'number');
  assert.equal(typeof safe.per_day, 'number');
  assert.ok(safe.cash && Array.isArray(safe.breakdown));

  const plan = await json(await send('PUT', '/api/plan', { lines: [{ account_id: 'acct_test_offset', amount: 50000 }] }));
  assert.equal(plan.lines.length, 1);
  assert.equal((await json(await get('/api/plan'))).lines[0].account_id, 'acct_test_offset');
  assert.ok(Array.isArray((await json(await get('/api/plan/suggest'))).lines));
  assert.equal((await json(await get('/api/plan/status'))).lines[0].status, 'not_yet');
  assert.equal((await send('PUT', '/api/plan', { lines: [{ account_id: 'acct_test_everyday', amount: 1 }] })).status, 400);

  const g = await json(await send('POST', '/api/goals', { name: 'Test goal', target_amount: 100000 }), 201);
  await json(await send('POST', `/api/goals/${g.id}/contributions`, { amount: 25000 }), 201);
  const goals = await json(await get('/api/goals'));
  assert.equal(goals.items.find((x) => x.id === g.id).progress, 25000);
  assert.equal((await json(await send('PATCH', `/api/goals/${g.id}`, { name: 'Renamed' }))).name, 'Renamed');
  assert.equal((await json(await send('DELETE', `/api/goals/${g.id}`))).deleted, true);

  const debt = await json(await get('/api/debt?extra=20000'));
  assert.equal(debt.loans.length, 1);
  assert.equal(debt.loans[0].extra.per_cycle, 20000);
  assert.equal((await get('/api/debt?extra=abc')).status, 400);

  const bud = await json(await get('/api/budgets'));
  assert.equal(bud.basis, 'cycle');
  assert.equal(bud.cycle.start, addDays(T, -5));
  assert.equal((await json(await get(`/api/budgets?month=${monthOf(T)}`))).basis, 'month');
  const groceries = await catId('Groceries');
  const put = await json(await send('PUT', `/api/budgets/${groceries}`, { cycle_target: 30000, fixed: false }));
  assert.equal(put.cycle_target, 30000);
  assert.equal(put.monthly_target, 65000);
  const starter = await json(await send('POST', '/api/budgets/starter', { dry_run: true }));
  assert.ok('created' in starter);

  const acct = await json(await send('PATCH', '/api/accounts/acct_test_offset', { spendable: true }));
  assert.equal(acct.spendable, true);
  assert.equal((await send('PATCH', '/api/accounts/acct_test_offset', { spendable: 'yes' })).status, 400);
  await json(await send('PATCH', '/api/accounts/acct_test_offset', { spendable: null }));
});
