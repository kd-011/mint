// Owed to me: a manual ledger of money other people owe the owner. Debts, partial
// repayments (optionally linked to a real incoming bank transaction), the
// per-person and grand tally, and the JSON API. The real handler over an
// in-memory book, invented names and amounts only. Dates are relative to
// today in Perth because the server reads the real clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { book } from './fixtures/book.mjs';
import { createApi } from '../lib/api.mjs';
import { HttpError } from '../lib/errors.mjs';
import { perthDate, addDays } from '../lib/dates.mjs';

const T = perthDate();
let srv, base, b;

before(async () => {
  b = book();
  const api = createApi({ db: b.db, engine: { refresh() {}, runAi() {} }, ai: null, dataDir: mkdtempSync(join(tmpdir(), 'mint-owed-')), log() {} });
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

const get = (p) => fetch(base + p);
const send = (method, p, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const json = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };
const err = async (r, status = 400) => { assert.equal(r.status, status, await r.clone().text()); return (await r.json()).error; };
const clear = () => b.db.prepare('DELETE FROM owed').run();

test('an empty ledger answers zero, not an error', async () => {
  clear();
  const r = await json(await get('/api/owed'));
  assert.equal(r.total_outstanding, 0);
  assert.equal(r.overdue_total, 0);
  assert.deepEqual(r.people, []);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.names, []);
  assert.equal(r.as_of, T);
});

test('add a debt: defaults to today, trims the person, is open with the full amount outstanding', async () => {
  clear();
  const d = await json(await send('POST', '/api/owed', { person: '  Liam  ', amount: 4000, note: 'fuel' }), 201);
  assert.equal(d.person, 'Liam');
  assert.equal(d.amount, 4000);
  assert.equal(d.note, 'fuel');
  assert.equal(d.lent_on, T);
  assert.equal(d.due_on, null);
  assert.equal(d.status, 'open');
  assert.equal(d.repaid, 0);
  assert.equal(d.outstanding, 4000);
  assert.equal(d.overdue, false);
  assert.deepEqual(d.payments, []);
});

test('validation: person 1 to 60 characters, amount whole positive cents, dates real and not in the future', async () => {
  clear();
  const ok = { person: 'Sam', amount: 1000 };
  for (const bad of [
    { ...ok, person: '' }, { ...ok, person: '   ' }, { ...ok, person: 'x'.repeat(61) }, { ...ok, person: 5 },
    { ...ok, amount: 0 }, { ...ok, amount: -100 }, { ...ok, amount: 12.5 }, { ...ok, amount: '40' }, { person: 'Sam' },
    { ...ok, lent_on: addDays(T, 1) }, { ...ok, lent_on: '2026-02-30' }, { ...ok, lent_on: '18/10/2026' },
    { ...ok, due_on: 'soon' }, { ...ok, lent_on: addDays(T, -5), due_on: addDays(T, -9) },
    { ...ok, note: 'x'.repeat(201) },
  ]) assert.equal((await send('POST', '/api/owed', bad)).status, 400, JSON.stringify(bad));
  assert.match(await err(await send('POST', '/api/owed', { ...ok, person: '' })), /person/);
  assert.match(await err(await send('POST', '/api/owed', { ...ok, amount: 12.5 })), /whole cents/);
  assert.equal((await json(await get('/api/owed'))).items.length, 0, 'nothing was saved');
  assert.equal((await send('POST', '/api/owed', { ...ok, person: 'x'.repeat(60) })).status, 201);
});

test('partial repayments reduce the balance; the last one settles the debt; over-repaying says how much is left', async () => {
  clear();
  const d = await json(await send('POST', '/api/owed', { person: 'Liam', amount: 5000, note: 'dinner at Sosta', lent_on: addDays(T, -10) }), 201);
  const p1 = await json(await send('POST', `/api/owed/${d.id}/payments`, { amount: 2000, note: 'cash' }), 201);
  assert.equal(p1.amount, 2000);
  assert.equal(p1.date, T);
  assert.equal(p1.transaction_id, null);
  let r = await json(await get(`/api/owed/${d.id}`));
  assert.equal(r.repaid, 2000);
  assert.equal(r.outstanding, 3000);
  assert.equal(r.status, 'open');
  assert.equal(r.payments.length, 1);

  const over = await err(await send('POST', `/api/owed/${d.id}/payments`, { amount: 3001 }));
  assert.match(over, /\$30\.00 left/);
  assert.equal((await json(await get(`/api/owed/${d.id}`))).repaid, 2000, 'a refused repayment writes nothing');

  await json(await send('POST', `/api/owed/${d.id}/payments`, { amount: 3000 }), 201);
  r = await json(await get(`/api/owed/${d.id}`));
  assert.equal(r.status, 'settled');
  assert.equal(r.outstanding, 0);
  assert.match(await err(await send('POST', `/api/owed/${d.id}/payments`, { amount: 1 })), /settled|nothing left/i);

  // Deleting a repayment reopens it.
  await json(await send('DELETE', `/api/owed/${d.id}/payments/${r.payments[0].id}`));
  r = await json(await get(`/api/owed/${d.id}`));
  assert.equal(r.status, 'open');
  assert.equal(r.outstanding, 3000, 'the 30.00 repayment was the latest, so it is the one removed');
  assert.equal((await send('DELETE', `/api/owed/${d.id}/payments/999999`)).status, 404);
});

test('repayment validation: whole positive cents, a real date, not future, not before it was lent', async () => {
  clear();
  const d = await json(await send('POST', '/api/owed', { person: 'Mia', amount: 9000, lent_on: addDays(T, -10) }), 201);
  for (const bad of [{ amount: 0 }, { amount: -5 }, { amount: 1.5 }, { amount: 100, date: addDays(T, 1) }, { amount: 100, date: addDays(T, -11) }, { amount: 100, date: 'x' }, {}]) {
    assert.equal((await send('POST', `/api/owed/${d.id}/payments`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await send('POST', '/api/owed/99999/payments', { amount: 100 })).status, 404);
});

test('a repayment can link to a real incoming bank transaction; never altered, never an outgoing one, never over-assigned', async () => {
  clear();
  const credit = b.add('acct_t_everyday', addDays(T, -2), 6000, 'TEST TRANSFER FROM LIAM');
  const debit = b.add('acct_t_everyday', addDays(T, -2), -6000, 'TEST SHOP');
  const before = b.row(credit);
  const d1 = await json(await send('POST', '/api/owed', { person: 'Liam', amount: 5000, lent_on: addDays(T, -20) }), 201);
  const d2 = await json(await send('POST', '/api/owed', { person: 'Sam', amount: 4000, lent_on: addDays(T, -20) }), 201);

  assert.match(await err(await send('POST', `/api/owed/${d1.id}/payments`, { amount: 100, transaction_id: debit })), /incoming/);
  assert.equal((await send('POST', `/api/owed/${d1.id}/payments`, { amount: 100, transaction_id: 'txn_nope' })).status, 404);

  const p = await json(await send('POST', `/api/owed/${d1.id}/payments`, { amount: 5000, transaction_id: credit, date: addDays(T, -2) }), 201);
  assert.equal(p.transaction_id, credit);
  // $60.00 came in; $50.00 is assigned, so only $10.00 is left to link.
  assert.match(await err(await send('POST', `/api/owed/${d2.id}/payments`, { amount: 2000, transaction_id: credit })), /\$10\.00/);
  await json(await send('POST', `/api/owed/${d2.id}/payments`, { amount: 1000, transaction_id: credit }), 201);

  assert.deepEqual(b.row(credit), before, 'the transaction itself is untouched');
  const one = await json(await get(`/api/owed/${d1.id}`));
  assert.equal(one.payments[0].transaction_id, credit);
  assert.equal(one.status, 'settled');
});

test('a linked repayment survives the bank row being removed (link goes null, the money stays counted)', async () => {
  clear();
  const credit = b.add('acct_t_everyday', addDays(T, -2), 2500, 'TEST TRANSFER FROM ZOE');
  const d = await json(await send('POST', '/api/owed', { person: 'Zoe', amount: 2500, lent_on: addDays(T, -3) }), 201);
  await json(await send('POST', `/api/owed/${d.id}/payments`, { amount: 2500, transaction_id: credit }), 201);
  b.db.prepare('DELETE FROM transactions WHERE id = ?').run(credit);
  const r = await json(await get(`/api/owed/${d.id}`));
  assert.equal(r.repaid, 2500);
  assert.equal(r.payments[0].transaction_id, null);
});

test('settle, write off and reopen; a closed debt owes nothing but keeps its history', async () => {
  clear();
  const d = await json(await send('POST', '/api/owed', { person: 'Ned', amount: 8000, lent_on: addDays(T, -9) }), 201);
  await json(await send('POST', `/api/owed/${d.id}/payments`, { amount: 3000 }), 201);
  let r = await json(await send('PATCH', `/api/owed/${d.id}`, { closed: 'written_off' }));
  assert.equal(r.status, 'written_off');
  assert.equal(r.outstanding, 0);
  assert.equal(r.written_off, 5000, 'what was written off is kept');
  assert.equal((await json(await get('/api/owed'))).total_outstanding, 0);
  assert.match(await err(await send('POST', `/api/owed/${d.id}/payments`, { amount: 100 })), /written off|reopen/i);

  r = await json(await send('PATCH', `/api/owed/${d.id}`, { closed: 'settled' }));
  assert.equal(r.status, 'settled');
  assert.equal(r.written_off, 0);
  r = await json(await send('PATCH', `/api/owed/${d.id}`, { closed: null }));
  assert.equal(r.status, 'open');
  assert.equal(r.outstanding, 5000);
  assert.equal((await send('PATCH', `/api/owed/${d.id}`, { closed: 'maybe' })).status, 400);
});

test('edit a debt: person, note, due date; the amount cannot drop below what is already repaid', async () => {
  clear();
  const d = await json(await send('POST', '/api/owed', { person: 'Ivy', amount: 5000, lent_on: addDays(T, -9) }), 201);
  await json(await send('POST', `/api/owed/${d.id}/payments`, { amount: 3000 }), 201);
  const r = await json(await send('PATCH', `/api/owed/${d.id}`, { person: 'Ivy K', note: 'concert', due_on: addDays(T, 7), amount: 4000 }));
  assert.deepEqual([r.person, r.note, r.due_on, r.amount, r.outstanding], ['Ivy K', 'concert', addDays(T, 7), 4000, 1000]);
  assert.match(await err(await send('PATCH', `/api/owed/${d.id}`, { amount: 2000 })), /\$30\.00/);
  assert.equal((await send('PATCH', `/api/owed/${d.id}`, {})).status, 400);
  assert.equal((await send('PATCH', '/api/owed/99999', { note: 'x' })).status, 404);
});

test('tally: per person (case-insensitive, trimmed), grand total, oldest outstanding date, overdue', async () => {
  clear();
  const a = await json(await send('POST', '/api/owed', { person: 'Liam', amount: 4000, lent_on: addDays(T, -30), due_on: addDays(T, -5) }), 201);
  await json(await send('POST', '/api/owed', { person: 'liam ', amount: 2500, lent_on: addDays(T, -3) }), 201);
  await json(await send('POST', '/api/owed', { person: 'Sam', amount: 10000, lent_on: addDays(T, -8), due_on: addDays(T, 10) }), 201);
  const paid = await json(await send('POST', '/api/owed', { person: 'Mia', amount: 1500, lent_on: addDays(T, -4) }), 201);
  await json(await send('POST', `/api/owed/${paid.id}/payments`, { amount: 1500 }), 201);
  await json(await send('POST', `/api/owed/${a.id}/payments`, { amount: 1000 }), 201);

  const r = await json(await get('/api/owed'));
  assert.equal(r.total_outstanding, 3000 + 2500 + 10000);
  assert.equal(r.overdue_total, 3000, 'only the past-due balance counts as overdue');
  const [sam, liam, mia] = r.people;
  assert.deepEqual(r.people.map((p) => p.name), ['Sam', 'liam', 'Mia'], 'biggest balance first');
  assert.equal(sam.outstanding, 10000);
  assert.equal(liam.outstanding, 5500);
  assert.equal(liam.open_count, 2);
  assert.equal(liam.debts, 2);
  assert.equal(liam.oldest_open, addDays(T, -30));
  assert.equal(liam.overdue_count, 1);
  assert.equal(liam.overdue_amount, 3000);
  assert.equal(liam.name, 'liam', 'the most recently used spelling is the display name');
  assert.equal(mia.outstanding, 0);
  assert.equal(mia.open_count, 0);
  assert.equal(mia.oldest_open, null);
  assert.deepEqual(r.names.sort(), ['Mia', 'Sam', 'liam']);
  assert.equal(r.items.length, 4);
  assert.ok(r.items.every((i) => Array.isArray(i.payments)));
});

test('archive hides a finished debt from the list but not from ?all=1; an open debt cannot be archived', async () => {
  clear();
  const d = await json(await send('POST', '/api/owed', { person: 'Kai', amount: 2000, lent_on: addDays(T, -2) }), 201);
  assert.match(await err(await send('PATCH', `/api/owed/${d.id}`, { archived: true })), /settle|write/i);
  await json(await send('PATCH', `/api/owed/${d.id}`, { closed: 'settled' }));
  await json(await send('PATCH', `/api/owed/${d.id}`, { archived: true }));
  assert.equal((await json(await get('/api/owed'))).items.length, 0);
  assert.equal((await json(await get('/api/owed?all=1'))).items.length, 1);
});

test('delete takes the repayments with it; the transaction a repayment linked to is untouched', async () => {
  clear();
  const credit = b.add('acct_t_everyday', addDays(T, -1), 1000, 'TEST TRANSFER FROM ROY');
  const d = await json(await send('POST', '/api/owed', { person: 'Roy', amount: 3000, lent_on: addDays(T, -4) }), 201);
  await json(await send('POST', `/api/owed/${d.id}/payments`, { amount: 1000, transaction_id: credit }), 201);
  assert.deepEqual(await json(await send('DELETE', `/api/owed/${d.id}`)), { deleted: true });
  assert.equal(b.db.prepare('SELECT count(*) n FROM owed_payments').get().n, 0);
  assert.ok(b.row(credit));
  assert.equal((await send('DELETE', `/api/owed/${d.id}`)).status, 404);
  assert.equal((await get('/api/owed/abc')).status, 404);
});

test('the owed ledger touches nothing else: net worth, safe to spend, budgets and the forecast read the same before and after', async () => {
  clear();
  const snap = async () => JSON.stringify([await json(await get('/api/networth')), await json(await get('/api/safe-to-spend')), await json(await get('/api/budgets')), await json(await get('/api/forecast'))].map((x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'generated_at' || k === 'at' ? undefined : v)))));
  const before = await snap();
  const d = await json(await send('POST', '/api/owed', { person: 'Pat', amount: 99900, lent_on: addDays(T, -1) }), 201);
  await json(await send('POST', `/api/owed/${d.id}/payments`, { amount: 100 }), 201);
  assert.equal(await snap(), before);
});

test('a debt can run either way: direction defaults to owed_to_me, I owe nets against them, bad values are refused', async () => {
  clear();
  const a = await json(await send('POST', '/api/owed', { person: 'Connor', amount: 9000, note: 'villa' }), 201);
  assert.equal(a.direction, 'owed_to_me');
  const b2 = await json(await send('POST', '/api/owed', { person: 'connor', amount: 4000, note: 'flights', direction: 'i_owe' }), 201);
  assert.equal(b2.direction, 'i_owe');
  assert.equal(b2.outstanding, 4000);
  assert.match(await err(await send('POST', '/api/owed', { person: 'X', amount: 100, direction: 'sideways' })), /direction/);
  const r = await json(await get('/api/owed'));
  const c = r.people[0];
  assert.deepEqual([c.outstanding, c.i_owe, c.net], [9000, 4000, 5000]);
  assert.deepEqual([r.total_outstanding, r.total_i_owe, r.net], [9000, 4000, 5000]);
});

test('paying what I owe: part payments reduce it, over-paying says how much is left, it links to an outgoing bank row only', async () => {
  clear();
  const out = b.add('acct_t_everyday', addDays(T, -2), -6000, 'TEST PAID TRAV');
  const inn = b.add('acct_t_everyday', addDays(T, -2), 6000, 'TEST DEPOSIT');
  const d = await json(await send('POST', '/api/owed', { person: 'Trav', amount: 9600, direction: 'i_owe', lent_on: addDays(T, -5) }), 201);
  assert.match(await err(await send('POST', `/api/owed/${d.id}/payments`, { amount: 100, transaction_id: inn })), /outgoing/);
  const p = await json(await send('POST', `/api/owed/${d.id}/payments`, { amount: 6000, transaction_id: out }), 201);
  assert.equal(p.outstanding, 3600);
  assert.match(await err(await send('POST', `/api/owed/${d.id}/payments`, { amount: 3700 })), /\$36\.00 left to pay/);
  assert.match(await err(await send('POST', `/api/owed/${d.id}/payments`, { amount: 100, transaction_id: out })), /\$0\.00/);
  await json(await send('POST', `/api/owed/${d.id}/payments`, { amount: 3600 }), 201);
  const r = await json(await get('/api/owed'));
  assert.equal(r.total_i_owe, 0);
  assert.equal(r.items[0].status, 'settled');
});

test('a debt with repayments cannot switch direction; one without can', async () => {
  clear();
  const d = await json(await send('POST', '/api/owed', { person: 'Sam', amount: 5000 }), 201);
  const flipped = await json(await send('PATCH', `/api/owed/${d.id}`, { direction: 'i_owe' }));
  assert.equal(flipped.direction, 'i_owe');
  await json(await send('POST', `/api/owed/${d.id}/payments`, { amount: 1000 }), 201);
  assert.match(await err(await send('PATCH', `/api/owed/${d.id}`, { direction: 'owed_to_me' })), /direction/);
});
