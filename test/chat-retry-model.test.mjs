// The page side of two chat fixes, as pure logic (public/chat-model.js):
// 1. Retrying a reply that broke mid-stream keeps its change cards (and their
//    Undo) on screen, resends the same request id so Mint can recognise the
//    resend, and shows a change the server already applied as a note, not as a
//    second card.
// 2. A queue restored from localStorage after a reload is sent, one message at
//    a time and in order, when no turn is in flight; it is held only when the
//    last reply failed in a way a resend would not fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { ChatModel: M } = createRequire(import.meta.url)('../public/chat-model.js');

const change = (token, extra = {}) => ({ kind: 'change', op: 'lot_add', summary: 'Log a buy of 5 VAS.ASX', token, expires_at: '2099-01-01T00:00:00Z', state: 'applied', ...extra });
const user = (id, text, rid) => ({ id, role: 'user', text, ...(rid ? { rid } : {}) });
const reply = (id, o = {}) => ({ id, role: 'assistant', text: '', tool: null, cards: [], status: 'done', error: null, ...o });
const broken = (id, cards) => reply(id, { text: 'Logged it, ', cards, status: 'error', error: { code: 'stream-broken', message: 'cut' } });

// ---------- fix 1 ----------

test('request ids fit the shape Mint accepts', () => {
  const a = M.newRequestId();
  assert.match(a, /^[A-Za-z0-9_-]{1,100}$/);
  assert.notEqual(a, M.newRequestId());
});

test('retry of a broken reply with a change card keeps that reply and its Undo, and resends the same request id', () => {
  const msgs = [user('u1', 'log my VAS buy', 'q_1'), broken('r1', [change('u_tok1')])];
  const p = M.planRetry(msgs, 'r1');
  assert.equal(p.question.text, 'log my VAS buy');
  assert.equal(p.rid, 'q_1');
  assert.equal(p.keep, true);
  M.shelve(msgs[1]);
  assert.equal(msgs[1].status, 'interrupted');
  assert.equal(msgs[1].error, null, 'no Retry button left on the kept reply');
  assert.equal(msgs[1].cards.length, 1);
  assert.equal(msgs[1].cards[0].state, 'applied', 'Undo is still there');
  assert.equal(msgs[1].cards[0].token, 'u_tok1');
});

test('retry of a broken reply with no change card drops it as before', () => {
  const msgs = [user('u1', 'hi', 'q_1'), broken('r1', [])];
  assert.equal(M.planRetry(msgs, 'r1').keep, false);
  const withConfirm = [user('u1', 'delete it', 'q_1'), broken('r1', [{ kind: 'confirm', op: 'goal_delete', token: 'c_x', state: 'pending' }])];
  assert.equal(M.planRetry(withConfirm, 'r1').keep, false, 'a confirm card is not an applied change; the retry brings a fresh one');
});

test('a second retry finds the question past a kept reply, and an old message without a request id gets one', () => {
  const kept = reply('r1', { status: 'interrupted', cards: [change('u_tok1')] });
  const msgs = [user('u1', 'log my VAS buy'), kept, broken('r2', [])];
  const p = M.planRetry(msgs, 'r2');
  assert.equal(p.question.id, 'u1');
  assert.match(p.rid, /^[A-Za-z0-9_-]{1,100}$/);
});

test('a change the server replays is a note on the new reply, not a second Undo card', () => {
  const r = M.newReply();
  const known = new Set(['u_tok1']);
  M.applyEvent(r, { event: 'undo', data: { op: 'lot_add', summary: 'Log a buy of 5 VAS.ASX', token: 'u_tok1', expires_at: '2099-01-01T00:00:00Z' } }, known);
  M.applyEvent(r, { event: 'undo', data: { op: 'lot_add', summary: 'Log a buy of 7 VAS.ASX', token: 'u_tok2', expires_at: '2099-01-01T00:00:00Z' } }, known);
  assert.equal(r.cards.length, 2);
  assert.equal(r.cards[0].kind, 'note');
  assert.match(r.cards[0].summary, /already/i);
  assert.equal(r.cards[1].kind, 'change');
  assert.equal(r.cards[1].token, 'u_tok2');
});

test('cardTokens collects every change token on screen', () => {
  const msgs = [user('u1', 'x'), reply('r1', { cards: [change('u_a'), { kind: 'note', summary: 'n' }] }), reply('r2', { cards: [change('u_b')] })];
  assert.deepEqual([...M.cardTokens(msgs)].sort(), ['u_a', 'u_b']);
});

// ---------- fix 2 ----------

const saved = (msgs, queue) => ({ id: 'm_1', msgs, queue });

test('restore turns a reply that was streaming into an interrupted error and keeps the queue', () => {
  const r = M.restore(saved([user('u1', 'a', 'q_1'), reply('r1', { status: 'streaming' })], ['second', 'third']));
  assert.equal(r.msgs[1].status, 'error');
  assert.equal(r.msgs[1].error.code, 'interrupted');
  assert.deepEqual(r.queue, ['second', 'third']);
  assert.equal(M.restore(null).msgs.length, 0);
  assert.match(M.restore(null).id, /^m_/);
});

test('a restored queue is sent after a reload: the first message, nothing in flight', () => {
  const r = M.restore(saved([user('u1', 'a', 'q_1'), reply('r1', { status: 'streaming' })], ['second', 'third']));
  assert.equal(M.nextQueued({ busy: false, online: true, queue: r.queue, msgs: r.msgs }), 'second');
});

test('the queue is sent after a finished or stopped turn, in order, and not while busy, offline or empty', () => {
  const done = [user('u1', 'a'), reply('r1')];
  assert.equal(M.nextQueued({ busy: false, online: true, queue: ['x', 'y'], msgs: done }), 'x');
  assert.equal(M.nextQueued({ busy: false, online: true, queue: ['x'], msgs: [user('u1', 'a'), reply('r1', { status: 'stopped' })] }), 'x');
  assert.equal(M.nextQueued({ busy: true, online: true, queue: ['x'], msgs: done }), null);
  assert.equal(M.nextQueued({ busy: false, online: false, queue: ['x'], msgs: done }), null);
  assert.equal(M.nextQueued({ busy: false, online: true, queue: [], msgs: done }), null);
  assert.equal(M.nextQueued({ busy: false, online: true, queue: ['x'], msgs: [user('u1', 'a'), reply('r1', { status: 'streaming' })] }), null, 'a live stream is a turn in flight');
});

test('a transient failure still lets the queue go; one a resend would not fix holds it', () => {
  const err = (code, status) => [user('u1', 'a'), reply('r1', { status: 'error', error: { code, status, message: 'x' } })];
  assert.equal(M.nextQueued({ busy: false, online: true, queue: ['x'], msgs: err('stream-broken') }), 'x');
  assert.equal(M.nextQueued({ busy: false, online: true, queue: ['x'], msgs: err('unreachable', 502) }), 'x');
  assert.equal(M.nextQueued({ busy: false, online: true, queue: ['x'], msgs: err('daily-limit', 429) }), null);
  assert.equal(M.nextQueued({ busy: false, online: true, queue: ['x'], msgs: err('paused', 423) }), null);
  assert.equal(M.nextQueued({ busy: false, online: true, queue: ['x'], msgs: err(null, 401) }), null);
});
