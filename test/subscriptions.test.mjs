// The Subscriptions list: detected subscriptions merged with ones the owner adds by
// hand, with a state per merchant (active, cancelled, not a subscription).
// Cancelled and dismissed ones drop out of the bills calendar, the forecast
// baseline and the new-subscription alerts; cancelled ones stay listed with the
// monthly amount saved. Invented data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { book, monthsBack } from './fixtures/book.mjs';
import { payBook, refreshMoney } from './fixtures/pay.mjs';
import { detectRecurring } from '../lib/recurring.mjs';
import { billsCalendar } from '../lib/bills.mjs';
import { runAlerts } from '../lib/alerts.mjs';
import { createApi } from '../lib/api.mjs';
import { HttpError } from '../lib/errors.mjs';
import {
  listSubscriptions, addSubscription, updateSubscription, deleteSubscription, setDetectedState, clearDetectedState, recurringKeys,
} from '../lib/subscriptions.mjs';

const TODAY = '2026-10-17';
const FLIX = 'testflix com';
const quiet = (b) => b.db.prepare("UPDATE accounts SET last_synced_at = '2026-11-30T00:00:00.000Z'").run();
const at = (d) => new Date(`${d}T02:00:00Z`);

function flixBook({ pay = false } = {}) {
  const b = pay ? payBook() : book();
  quiet(b);
  for (let n = 6; n >= 0; n--) b.add('acct_t_card', monthsBack('2026-10-15', n), -1599, 'TESTFLIX.COM          TESTVILLE    AU');
  for (let n = 12; n >= 6; n--) b.add('acct_t_card', monthsBack('2026-10-10', n), -999, 'OLD TESTAPP');
  if (pay) refreshMoney(b, TODAY);
  return b;
}
const statusOf = (list, key) => ['active', 'cancelled', 'dismissed', 'stopped'].find((g) => list[g].some((i) => i.merchant_key === key));
const err = (fn) => { try { fn(); } catch (e) { return e; } return null; };

test('the list merges what Mint detected with what the owner added', () => {
  const b = flixBook();
  const m = addSubscription(b.db, { name: 'Test Gym', amount: 4500, cadence: 'monthly', next_date: '2026-10-25' }, { today: TODAY });
  assert.equal(m.origin, 'manual');
  assert.equal(m.status, 'active');
  const l = listSubscriptions(b.db, TODAY);
  const flix = l.active.find((i) => i.merchant_key === FLIX);
  assert.equal(flix.origin, 'detected');
  assert.equal(flix.name, 'Testflix.com');
  assert.equal(flix.amount, 1599);
  assert.equal(flix.per_month, 1599);
  assert.equal(flix.next_date, '2026-11-15');
  const gym = l.active.find((i) => i.id === m.id);
  assert.equal(gym.name, 'Test Gym');
  assert.equal(gym.next_date, '2026-10-25');
  assert.equal(l.totals.active_per_month, 1599 + 4500);
  assert.equal(l.active.length, 2);
});

test('a detected one that stopped on its own is listed apart, not as active', () => {
  const l = listSubscriptions(flixBook().db, TODAY);
  assert.equal(statusOf(l, 'old testapp'), 'stopped');
  const s = l.stopped.find((i) => i.merchant_key === 'old testapp');
  assert.equal(s.last_date, '2026-04-10');
});

test('cost per month for each cadence', () => {
  const b = book();
  const mk = (cadence, amount) => addSubscription(b.db, { name: cadence, amount, cadence, next_date: '2026-11-01' }, { today: TODAY }).id;
  const ids = { weekly: mk('weekly', 1000), fortnightly: mk('fortnightly', 1000), monthly: mk('monthly', 1000), quarterly: mk('quarterly', 3000), yearly: mk('yearly', 12000) };
  const l = listSubscriptions(b.db, TODAY);
  const per = (cadence) => l.active.find((i) => i.id === ids[cadence]).per_month;
  assert.deepEqual([per('weekly'), per('fortnightly'), per('monthly'), per('quarterly'), per('yearly')], [4333, 2167, 1000, 1000, 1000]);
});

test('a manual next date in the past rolls forward by its cadence', () => {
  const b = book();
  const m = addSubscription(b.db, { name: 'Test Rolling', amount: 1000, cadence: 'monthly', next_date: '2026-08-25' }, { today: TODAY });
  assert.equal(listSubscriptions(b.db, TODAY).active.find((i) => i.id === m.id).next_date, '2026-10-25');
  const w = addSubscription(b.db, { name: 'Test Weekly', amount: 1000, cadence: 'weekly', next_date: '2026-10-01' }, { today: TODAY });
  assert.equal(listSubscriptions(b.db, TODAY).active.find((i) => i.id === w.id).next_date, '2026-10-22');
});

test('manual input is validated', () => {
  const b = book();
  const ok = { name: 'Test Thing', amount: 1000, cadence: 'monthly', next_date: '2026-10-25' };
  const bad = (patch, re) => { const e = err(() => addSubscription(b.db, { ...ok, ...patch }, { today: TODAY })); assert.equal(e?.status, 400, JSON.stringify(patch)); assert.match(e.message, re); };
  bad({ name: '' }, /name/);
  bad({ name: 'x'.repeat(61) }, /name/);
  bad({ amount: 0 }, /amount/);
  bad({ amount: -5 }, /amount/);
  bad({ amount: 12.5 }, /amount/);
  bad({ cadence: 'daily' }, /cadence/);
  bad({ next_date: '25/10/2026' }, /next_date/);
  bad({ status: 'cancelled', cancelled_on: '2026-12-01' }, /cancelled_on/);
  assert.equal(err(() => updateSubscription(b.db, 9999, { amount: 5 }, { today: TODAY }))?.status, 404);
  assert.equal(err(() => deleteSubscription(b.db, 9999))?.status, 404);
});

test('edit and delete a manual subscription', () => {
  const b = book();
  const m = addSubscription(b.db, { name: 'Test Gym', amount: 4500, cadence: 'monthly', next_date: '2026-10-25' }, { today: TODAY });
  const e = updateSubscription(b.db, m.id, { name: 'Test Gym Plus', amount: 4900, cadence: 'fortnightly' }, { today: TODAY });
  assert.deepEqual([e.name, e.amount, e.cadence], ['Test Gym Plus', 4900, 'fortnightly']);
  assert.deepEqual(deleteSubscription(b.db, m.id), { deleted: true });
  assert.equal(listSubscriptions(b.db, TODAY).active.length, 0);
});

test('cancelling a detected one: out of bills, recurring and alerts; listed as cancelled with the saving', () => {
  const b = flixBook({ pay: true });
  assert.ok(billsCalendar(b.db, { today: TODAY }).items.some((i) => i.merchant_key === FLIX));
  const r = setDetectedState(b.db, FLIX, { status: 'cancelled' }, { today: TODAY });
  assert.deepEqual([r.status, r.cancelled_on], ['cancelled', TODAY]);
  const l = listSubscriptions(b.db, TODAY);
  assert.equal(statusOf(l, FLIX), 'cancelled');
  const c = l.cancelled.find((i) => i.merchant_key === FLIX);
  assert.equal(c.cancelled_on, TODAY);
  assert.equal(c.per_month, 1599);
  assert.equal(c.name, 'Testflix.com');
  assert.equal(l.totals.cancelled_saved_per_month, 1599);
  assert.equal(l.totals.active_per_month, 0);
  assert.ok(!billsCalendar(b.db, { today: TODAY }).items.some((i) => i.merchant_key === FLIX));
  assert.ok(!detectRecurring(b.db, TODAY).some((s) => s.merchant_key === FLIX && s.active));
});

test('a cancelled date can be given, and is not in the future', () => {
  const b = flixBook();
  assert.equal(setDetectedState(b.db, FLIX, { status: 'cancelled', cancelled_on: '2026-10-01' }, { today: TODAY }).cancelled_on, '2026-10-01');
  assert.equal(err(() => setDetectedState(b.db, FLIX, { status: 'cancelled', cancelled_on: '2026-10-30' }, { today: TODAY }))?.status, 400);
  assert.equal(err(() => setDetectedState(b.db, FLIX, { status: 'maybe' }, { today: TODAY }))?.status, 400);
  assert.equal(err(() => setDetectedState(b.db, 'no such merchant', { status: 'cancelled' }, { today: TODAY }))?.status, 404);
});

test('a cancelled one that charges again is flagged', () => {
  const b = flixBook();
  setDetectedState(b.db, FLIX, { status: 'cancelled', cancelled_on: '2026-09-01' }, { today: TODAY });
  const c = listSubscriptions(b.db, TODAY).cancelled.find((i) => i.merchant_key === FLIX);
  assert.equal(c.still_charging, true);
  assert.equal(c.last_date, '2026-10-15');
  setDetectedState(b.db, FLIX, { status: 'cancelled', cancelled_on: '2026-10-14' }, { today: TODAY });
  assert.equal(listSubscriptions(b.db, TODAY).cancelled.find((i) => i.merchant_key === FLIX).still_charging, false);
});

test('un-cancelling puts it back as active', () => {
  const b = flixBook({ pay: true });
  setDetectedState(b.db, FLIX, { status: 'cancelled' }, { today: TODAY });
  assert.deepEqual(clearDetectedState(b.db, FLIX), { deleted: true });
  const l = listSubscriptions(b.db, TODAY);
  assert.equal(statusOf(l, FLIX), 'active');
  assert.ok(billsCalendar(b.db, { today: TODAY }).items.some((i) => i.merchant_key === FLIX));
  assert.equal(err(() => clearDetectedState(b.db, FLIX))?.status, 404);
});

test('not a subscription: dismissed, out of every list that feeds money maths, and restorable', () => {
  const b = flixBook({ pay: true });
  setDetectedState(b.db, FLIX, { status: 'dismissed' }, { today: TODAY });
  const l = listSubscriptions(b.db, TODAY);
  assert.equal(statusOf(l, FLIX), 'dismissed');
  assert.equal(l.totals.cancelled_saved_per_month, 0);
  assert.ok(!billsCalendar(b.db, { today: TODAY }).items.some((i) => i.merchant_key === FLIX));
  clearDetectedState(b.db, FLIX);
  assert.equal(statusOf(listSubscriptions(b.db, TODAY), FLIX), 'active');
});

test('a stopped one can be marked cancelled with the date it stopped', () => {
  const b = flixBook();
  setDetectedState(b.db, 'old testapp', { status: 'cancelled', cancelled_on: '2026-04-11' }, { today: TODAY });
  const l = listSubscriptions(b.db, TODAY);
  assert.equal(statusOf(l, 'old testapp'), 'cancelled');
  assert.equal(l.cancelled.find((i) => i.merchant_key === 'old testapp').per_month, 999);
});

test('manual active subscriptions feed the bills calendar like detected ones; cancelled ones do not', () => {
  const b = flixBook({ pay: true });
  const gym = addSubscription(b.db, { name: 'Test Gym', amount: 4500, cadence: 'fortnightly', next_date: '2026-10-20' }, { today: TODAY });
  const old = addSubscription(b.db, { name: 'Test Paper', amount: 900, cadence: 'monthly', next_date: '2026-10-22', status: 'cancelled', cancelled_on: '2026-10-01' }, { today: TODAY });
  const items = billsCalendar(b.db, { today: TODAY }).items;
  const mine = items.filter((i) => i.merchant === 'Test Gym');
  assert.deepEqual(mine.map((i) => i.date), ['2026-10-20', '2026-11-03', '2026-11-17']);
  assert.ok(mine.every((i) => i.kind === 'subscription' && i.amount === 4500 && i.status === 'due' && i.cadence === 'fortnightly'));
  assert.ok(!items.some((i) => i.merchant === 'Test Paper'));
  const l = listSubscriptions(b.db, TODAY);
  assert.equal(l.cancelled.find((i) => i.id === old.id).per_month, 900);
  assert.equal(l.active.some((i) => i.id === gym.id), true);
  assert.ok(detectRecurring(b.db, TODAY).some((s) => s.merchant === 'Test Gym' && s.active));
});

test('a manual entry linked to a merchant replaces the detected one instead of doubling it', () => {
  const b = flixBook({ pay: true });
  const m = addSubscription(b.db, { name: 'Testflix', amount: 1799, cadence: 'monthly', next_date: '2026-11-15', merchant_key: FLIX }, { today: TODAY });
  const l = listSubscriptions(b.db, TODAY);
  assert.deepEqual(l.active.map((i) => i.id ?? i.merchant_key).sort(), [m.id]);
  assert.equal(billsCalendar(b.db, { today: TODAY }).items.filter((i) => i.merchant_key === FLIX && i.status === 'due').length > 0, true);
  assert.ok(billsCalendar(b.db, { today: TODAY }).items.filter((i) => i.merchant_key === FLIX && i.status === 'due').every((i) => i.amount === 1799));
  deleteSubscription(b.db, m.id);
  assert.equal(statusOf(listSubscriptions(b.db, TODAY), FLIX), 'active');
});

test('a cancelled subscription raises no new-subscription alert; a live one does', () => {
  const mkBook = () => {
    const b = book();
    quiet(b);
    b.add('acct_t_card', '2026-09-08', -2200, 'TESTSTREAM PREMIUM');
    b.add('acct_t_card', '2026-10-08', -2200, 'TESTSTREAM PREMIUM');
    return b;
  };
  const live = mkBook();
  assert.ok(runAlerts(live.db, { now: at(TODAY) }).some((a) => a.kind === 'subscription' && a.type === 'new'));
  const gone = mkBook();
  setDetectedState(gone.db, 'teststream premium', { status: 'cancelled' }, { today: TODAY });
  assert.deepEqual(runAlerts(gone.db, { now: at(TODAY) }).filter((a) => a.kind === 'subscription'), []);
});

test('recurringKeys keeps cancelled merchants out of the spending baseline, but not dismissed ones', () => {
  const b = flixBook();
  for (let n = 6; n >= 0; n--) b.add('acct_t_card', monthsBack('2026-10-12', n), -2000, 'TESTSTREAM TWO');
  assert.ok(recurringKeys(b.db, TODAY).has(FLIX));
  setDetectedState(b.db, FLIX, { status: 'cancelled' }, { today: TODAY });
  assert.ok(recurringKeys(b.db, TODAY).has(FLIX));
  setDetectedState(b.db, 'teststream two', { status: 'dismissed' }, { today: TODAY });
  assert.ok(!recurringKeys(b.db, TODAY).has('teststream two'));
});

test('a state on a Play Store service survives the next charge arriving under a different cut of its name', () => {
  const b = book();
  quiet(b);
  b.add('acct_t_card', '2026-07-25', -999, 'GOOGLE TESTTUN        SYDNEY       AU');
  b.add('acct_t_card', '2026-08-25', -999, 'GOOGLE TESTTUN        SYDNEY       AU');
  for (const id of b.db.prepare('SELECT id FROM transactions').all().map((r) => r.id)) b.db.prepare("UPDATE transactions SET category_id = ? WHERE id = ?").run(b.cat('Subscriptions'), id);
  const key = listSubscriptions(b.db, '2026-09-01').active.find((i) => /testtun/.test(i.merchant_key)).merchant_key;
  setDetectedState(b.db, key, { status: 'cancelled', cancelled_on: '2026-09-01' }, { today: '2026-09-01' });
  // The next charge carries a longer cut of the name.
  const id = b.add('acct_t_card', '2026-09-28', -999, 'GOOGLE TESTTUNE APP    SYDNEY       AU');
  b.db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?').run(b.cat('Subscriptions'), id);
  const l = listSubscriptions(b.db, '2026-10-01');
  assert.equal(l.active.length, 0);
  assert.equal(l.cancelled.length, 1);
  assert.equal(l.cancelled[0].merchant_key, key);
  assert.equal(l.cancelled[0].still_charging, true);
  assert.ok(!detectRecurring(b.db, '2026-10-01').some((s) => s.active && /testtun/.test(s.merchant_key)));
  assert.ok(recurringKeys(b.db, '2026-10-01').has('google testtune app'));
});

// the API

let srv, base, ab;
before(async () => {
  ab = flixBook({ pay: true });
  const api = createApi({ db: ab.db, engine: { refresh() {}, runAi() {} }, ai: null, dataDir: mkdtempSync(join(tmpdir(), 'mint-subs-')), log() {} });
  srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!(await api(req, res, url))) { res.writeHead(404); res.end('{}'); }
    } catch (e) {
      res.writeHead(e instanceof HttpError ? e.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv?.close());

const send = (method, p, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };

test('API: add, edit, cancel, un-cancel and delete', async () => {
  const created = await json(await send('POST', '/api/subscriptions', { name: 'Test API Gym', amount: 3000, cadence: 'monthly', next_date: '2099-01-05' }), 201);
  assert.equal(created.origin, 'manual');
  const list = await json(await send('GET', '/api/subscriptions'));
  for (const k of ['as_of', 'active', 'cancelled', 'stopped', 'dismissed', 'totals']) assert.ok(k in list, k);
  assert.ok(list.active.some((i) => i.id === created.id && i.name === 'Test API Gym'));
  const edited = await json(await send('PATCH', `/api/subscriptions/${created.id}`, { amount: 3300 }));
  assert.equal(edited.amount, 3300);
  const cx = await json(await send('PATCH', `/api/subscriptions/${created.id}`, { status: 'cancelled' }));
  assert.equal(cx.status, 'cancelled');
  assert.ok(cx.cancelled_on);
  const back = await json(await send('PATCH', `/api/subscriptions/${created.id}`, { status: 'active' }));
  assert.equal(back.status, 'active');
  assert.equal(back.cancelled_on, null);
  assert.deepEqual(await json(await send('DELETE', `/api/subscriptions/${created.id}`)), { deleted: true });
  assert.equal((await send('DELETE', `/api/subscriptions/${created.id}`)).status, 404);
});

test('API: state on a detected subscription is keyed by merchant_key', async () => {
  const p = `/api/subscriptions/detected/${encodeURIComponent(FLIX)}`;
  const r = await json(await send('PUT', p, { status: 'cancelled', cancelled_on: '2026-10-01' }));
  assert.equal(r.status, 'cancelled');
  const l = await json(await send('GET', '/api/subscriptions'));
  assert.ok(l.cancelled.some((i) => i.merchant_key === FLIX && i.cancelled_on === '2026-10-01'));
  assert.deepEqual(await json(await send('DELETE', p)), { deleted: true });
  assert.ok((await json(await send('GET', '/api/subscriptions'))).active.some((i) => i.merchant_key === FLIX));
});

test('API: bad input is a 400 and the effective recurring list follows the state', async () => {
  assert.equal((await send('POST', '/api/subscriptions', { name: 'x', amount: 0, cadence: 'monthly', next_date: '2099-01-05' })).status, 400);
  assert.equal((await send('PUT', `/api/subscriptions/detected/${encodeURIComponent(FLIX)}`, { status: 'nonsense' })).status, 400);
  assert.equal((await send('PATCH', '/api/subscriptions/9999', { amount: 5 })).status, 404);
  await json(await send('PUT', `/api/subscriptions/detected/${encodeURIComponent(FLIX)}`, { status: 'dismissed' }));
  const rec = (await json(await send('GET', '/api/recurring'))).items;
  assert.ok(!rec.some((s) => s.merchant_key === FLIX));
});
