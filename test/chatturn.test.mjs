// Which chat question a write belongs to (lib/chatturn.mjs): the one in flight,
// the latest for a few minutes after its stream ended, and nothing when two
// different questions overlap. Invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { createChatTurns } from '../lib/chatturn.mjs';
import { saveUndo } from '../lib/undo.mjs';

function setup() {
  const b = book();
  let t = Date.parse('2026-10-17T02:00:00Z');
  const turns = createChatTurns({ db: b.db, now: () => t });
  let writes = 0;
  // A write that leaves a real, open undo token behind, like a chat write does.
  const write = () => {
    writes += 1;
    const u = saveUndo(b.db, { op: 'lot_add', summary: `write ${writes}`, changes: [{ t: 'goals', b: null, a: { id: writes } }], now: t });
    return { status: 201, body: { applied: true, op: 'lot_add', undo: u } };
  };
  return { turns, write, tick: (ms) => { t += ms; }, count: () => writes };
}

test('the same write under the same question is made once, then replayed', () => {
  const { turns, write, count } = setup();
  let end = turns.begin('q_a');
  const first = turns.guard('lot_add', { ref: 'VAS', units: 5 }, write);
  end();
  end = turns.begin('q_a');
  const again = turns.guard('lot_add', { units: 5, ref: 'VAS' }, write);
  end();
  assert.equal(count(), 1);
  assert.equal(again.body.undo.token, first.body.undo.token);
  assert.equal(again.body.replayed, true);
  assert.equal(again.status, 201);
});

test('two identical writes in one turn are two writes; a resend replays both, in order', () => {
  const { turns, write, count } = setup();
  let end = turns.begin('q_a');
  const a = turns.guard('lot_add', { units: 5 }, write);
  const b = turns.guard('lot_add', { units: 5 }, write);
  end();
  assert.notEqual(a.body.undo.token, b.body.undo.token);
  end = turns.begin('q_a');
  assert.equal(turns.guard('lot_add', { units: 5 }, write).body.undo.token, a.body.undo.token);
  assert.equal(turns.guard('lot_add', { units: 5 }, write).body.undo.token, b.body.undo.token);
  assert.equal(turns.guard('lot_add', { units: 5 }, write).body.replayed, undefined, 'a third is new');
  end();
  assert.equal(count(), 3);
});

test('a write after the grace period, or with no question in flight, is not tracked', () => {
  const { turns, write, tick, count } = setup();
  turns.guard('lot_add', { units: 1 }, write);
  turns.guard('lot_add', { units: 1 }, write);
  assert.equal(count(), 2);
  turns.begin('q_a')();
  tick(60_000);
  assert.equal(turns.current()?.rid, 'q_a', 'The assistant can still be writing a minute after the stream ended');
  tick(5 * 60_000);
  assert.equal(turns.current(), null);
});

test('two different questions in flight at once are ambiguous, so nothing is attributed', () => {
  const { turns, write, count } = setup();
  const e1 = turns.begin('q_a');
  const e2 = turns.begin('q_b');
  assert.equal(turns.current(), null);
  turns.guard('lot_add', { units: 5 }, write);
  turns.guard('lot_add', { units: 5 }, write);
  assert.equal(count(), 2);
  e1();
  assert.equal(turns.current().rid, 'q_b');
  e2();
});
