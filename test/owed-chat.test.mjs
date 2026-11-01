// Owed to me through the assistant door: the read (GET /api/assistant/owed) and the
// chat writes (owed_add, owed_repay, owed_settle, owed_delete) with the same
// safe-vs-confirm and undo rules as goals. The real handler over an in-memory
// book with a fake clock. Invented names and amounts only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { book } from './fixtures/book.mjs';
import { createAssistantApi } from '../lib/assistant.mjs';
import { HttpError } from '../lib/errors.mjs';
import { createOwed, addOwedPayment } from '../lib/owed.mjs';

const T0 = Date.parse('2026-10-17T02:00:00Z'); // 17 Oct in Perth
const TODAY = '2026-10-17';
let srv, base, b;

beforeEach(async () => {
  b = book();
  const api = createAssistantApi({ db: b.db, engine: { refresh() {} }, quotes: null, origin: 'https://finance.example.test', now: () => new Date(T0), log() {} });
  srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!(await api(req, res, url))) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"no such endpoint"}'); }
    } catch (e) {
      res.writeHead(e instanceof HttpError ? e.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}/api/assistant`;
});
afterEach(() => srv?.close());

const get = (p) => fetch(base + p);
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const json = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };
const state = () => ({
  owed: b.db.prepare('SELECT * FROM owed ORDER BY id').all(),
  owed_payments: b.db.prepare('SELECT * FROM owed_payments ORDER BY id').all(),
});
const make = (person, amount, extra = {}) => createOwed(b.db, { person, amount, lent_on: '2026-10-01', ...extra }, { today: TODAY });

test('GET /api/assistant/owed: as_of, total, people and items', async () => {
  const a = make('Liam', 4000, { note: 'fuel', due_on: '2026-10-10' });
  make('Sam', 10000);
  addOwedPayment(b.db, a.id, { amount: 1000, date: '2026-10-05' }, { today: TODAY });
  const r = await json(await get('/owed'));
  assert.equal(r.as_of, TODAY);
  assert.equal(r.total_outstanding, 13000);
  assert.equal(r.overdue_total, 3000);
  assert.deepEqual(r.people.map((p) => [p.name, p.outstanding]), [['Sam', 10000], ['Liam', 3000]]);
  assert.equal(r.items.length, 2);
  assert.equal(r.items.find((i) => i.person === 'Liam').outstanding, 3000);
  assert.equal(r.items.find((i) => i.person === 'Liam').payments.length, 1);
});

test('GET is read only on the door: PUT and DELETE on /owed are refused', async () => {
  for (const m of ['PUT', 'DELETE']) assert.equal((await fetch(`${base}/owed`, { method: m })).status, 404, m);
});

test('"Liam owes me $40 for fuel": owed_add applies at once and the undo removes it exactly', async () => {
  const before = state();
  const r = await json(await post('/owed', { person: 'Liam', amount: 4000, note: 'fuel' }), 201);
  assert.equal(r.applied, true);
  assert.equal(r.op, 'owed_add');
  assert.match(r.summary, /\$40\.00/);
  assert.match(r.summary, /Liam/);
  assert.equal(r.result.person, 'Liam');
  assert.equal(r.result.lent_on, TODAY, 'defaults to today in Perth');
  assert.match(r.undo.token, /^u_[A-Za-z0-9_-]{20,}$/);
  assert.equal(state().owed.length, 1);
  await json(await post(`/undo/${r.undo.token}`));
  assert.deepEqual(state(), before);
});

test('owed_add refuses nonsense with a 400 and writes nothing', async () => {
  const before = state();
  for (const body of [{ person: '', amount: 100 }, { person: 'Liam', amount: 0 }, { person: 'Liam', amount: 12.5 }, { person: 'Liam', amount: 100, lent_on: '2026-12-01' }]) {
    assert.equal((await post('/owed', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(state(), before);
});

test('"Liam paid me back $20": owed_repay by name takes the oldest open debt first, spills over, and one undo reverses all of it', async () => {
  make('Liam', 1500, { lent_on: '2026-09-01' });
  make('Liam', 4000, { lent_on: '2026-10-01' });
  make('Sam', 9000);
  const before = state();
  const r = await json(await post('/owed/liam/payments', { amount: 2000 }), 201);
  assert.equal(r.applied, true);
  assert.equal(r.op, 'owed_repay');
  assert.match(r.summary, /\$20\.00/);
  const rows = state().owed_payments;
  assert.deepEqual(rows.map((p) => [p.owed_id, p.amount, p.date]), [[1, 1500, TODAY], [2, 500, TODAY]]);
  assert.equal(r.result.outstanding, 3500, 'what Liam still owes in all');
  await json(await post(`/undo/${r.undo.token}`));
  assert.deepEqual(state(), before);
});

test('owed_repay by debt id targets that one debt; over-repaying is a 400 that says how much is left', async () => {
  const d = make('Liam', 3000);
  const e = await post(`/owed/${d.id}/payments`, { amount: 3500 });
  assert.equal(e.status, 400);
  assert.match((await e.json()).error, /\$30\.00/);
  const e2 = await post('/owed/liam/payments', { amount: 3500 });
  assert.equal(e2.status, 400);
  assert.match((await e2.json()).error, /\$30\.00/);
  assert.equal(state().owed_payments.length, 0);
  await json(await post(`/owed/${d.id}/payments`, { amount: 3000, note: 'bank' }), 201);
  assert.equal(state().owed_payments[0].note, 'bank');
});

test('owed_repay for someone nobody has lent to says who is owed; an ambiguous name says which', async () => {
  make('Liam Park', 1000);
  make('Liam Cho', 1000);
  const none = await post('/owed/zed/payments', { amount: 100 });
  assert.equal(none.status, 404);
  assert.match((await none.json()).error, /Liam Park/);
  const two = await post('/owed/liam/payments', { amount: 100 });
  assert.equal(two.status, 400);
  assert.match((await two.json()).error, /more than one/);
});

test('owed_settle marks every open debt of a person settled or written off, safe, and undo reopens them', async () => {
  make('Liam', 1500);
  make('Liam', 4000);
  make('Sam', 9000);
  const before = state();
  const r = await json(await post('/owed/liam/settle', { status: 'written_off' }));
  assert.equal(r.applied, true);
  assert.equal(r.op, 'owed_settle');
  assert.match(r.summary, /write off|written off/i);
  assert.deepEqual(state().owed.map((o) => o.closed), ['written_off', 'written_off', null]);
  await json(await post(`/undo/${r.undo.token}`));
  assert.deepEqual(state(), before);
  assert.equal((await post('/owed/liam/settle', { status: 'nope' })).status, 400);
});

test('deleting a debt always needs a confirm; nothing applies on the first call; undo brings back the debt and its repayments', async () => {
  const d = make('Liam', 4000);
  addOwedPayment(b.db, d.id, { amount: 1000, date: '2026-10-05' }, { today: TODAY });
  addOwedPayment(b.db, d.id, { amount: 500, date: '2026-10-06' }, { today: TODAY });
  const before = state();
  const p = await json(await post(`/owed/${d.id}/delete`), 202);
  assert.equal(p.op, 'owed_delete');
  assert.ok(p.needs_confirm && p.token);
  assert.match(p.summary, /Liam/);
  assert.match(p.summary, /2 repayments/);
  assert.deepEqual(state(), before, 'the preview changes nothing');
  const ok = await json(await post(`/confirm/${p.token}`));
  assert.equal(state().owed.length, 0);
  assert.equal(state().owed_payments.length, 0);
  await json(await post(`/undo/${ok.undo.token}`));
  assert.deepEqual(state(), before);
});

test('"I owe Trav $96": owed_add takes a direction and says so; by-name repayments and settles ignore what I owe', async () => {
  createOwed(b.db, { person: 'Trav', amount: 9600, direction: 'i_owe', lent_on: '2026-10-10' }, { today: TODAY });
  const r = await json(await post('/owed', { person: 'Connor', amount: 5000, note: 'flights', direction: 'i_owe' }), 201);
  assert.match(r.summary, /you owe Connor/);
  assert.equal(state().owed.at(-1).direction, 'i_owe');
  const res = await post('/owed/Trav/payments', { amount: 100 });
  assert.equal(res.status, 404, 'Trav owes the owner nothing, so the by-name door has no one to repay');
  assert.equal(state().owed_payments.length, 0);
  const byId = await json(await post(`/owed/${state().owed[0].id}/payments`, { amount: 2000 }), 201);
  assert.match(byId.summary, /paid to Trav/);
});
