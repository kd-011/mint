// The chat panel's brain, without a browser: the event stream parser, how stream
// events build a reply with its change and confirm cards, the plain-English error
// text, the small reply renderer (it must never let markup through), and the
// suggested prompts per tab. public/chat-model.js is plain script in the page and
// a CommonJS module here, like routes.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { ChatModel: M } = createRequire(import.meta.url)('../public/chat-model.js');

const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test('parseSse: whole events, in order', () => {
  const { events, rest } = M.parseSse('', ev('start', { conversation_id: 'c1' }) + ev('delta', { text: 'Hi' }));
  assert.deepEqual(events, [{ event: 'start', data: { conversation_id: 'c1' } }, { event: 'delta', data: { text: 'Hi' } }]);
  assert.equal(rest, '');
});

test('parseSse: an event split across chunks waits for the rest, CRLF and comments are fine', () => {
  const whole = `: ping\r\n\r\n${ev('delta', { text: 'one' })}`.replace(/\n/g, '\r\n');
  const cut = whole.indexOf('one') + 1;
  let r = M.parseSse('', whole.slice(0, cut));
  assert.deepEqual(r.events, []);
  r = M.parseSse(r.rest, whole.slice(cut));
  assert.deepEqual(r.events, [{ event: 'delta', data: { text: 'one' } }]);
  assert.equal(r.rest, '');
});

test('parseSse: a block with bad JSON is skipped, not fatal', () => {
  const { events } = M.parseSse('', 'event: delta\ndata: {nope\n\n' + ev('done', { reply: 'ok' }));
  assert.deepEqual(events, [{ event: 'done', data: { reply: 'ok' } }]);
});

test('a streamed reply builds up token by token and ends done with the final reply', () => {
  const m = M.newReply();
  assert.equal(m.status, 'streaming');
  M.applyEvent(m, { event: 'start', data: { conversation_id: 'c1', session_id: 's1' } });
  M.applyEvent(m, { event: 'tool', data: { name: 'mint_cycle', label: 'Checking the pay cycle' } });
  assert.equal(m.tool, 'Checking the pay cycle');
  M.applyEvent(m, { event: 'delta', data: { text: 'You have ' } });
  M.applyEvent(m, { event: 'delta', data: { text: '$420 left.' } });
  assert.equal(m.text, 'You have $420 left.');
  assert.equal(m.tool, null, 'the tool label clears once words arrive');
  M.applyEvent(m, { event: 'done', data: { reply: 'You have $420 left.' } });
  assert.equal(m.status, 'done');
  assert.equal(m.text, 'You have $420 left.');
});

test('done fills in the reply when no deltas came', () => {
  const m = M.newReply();
  M.applyEvent(m, { event: 'done', data: { reply: 'All good.' } });
  assert.equal(m.text, 'All good.');
  assert.equal(m.status, 'done');
});

test('an undo event is a change card with its token and expiry', () => {
  const m = M.newReply();
  M.applyEvent(m, { event: 'undo', data: { op: 'recategorise', summary: 'Moved 3 rows to Fuel', token: 'u_abc', expires_at: '2026-10-18T02:00:00Z' } });
  assert.equal(m.cards.length, 1);
  assert.deepEqual(m.cards[0], { kind: 'change', op: 'recategorise', summary: 'Moved 3 rows to Fuel', token: 'u_abc', expires_at: '2026-10-18T02:00:00Z', state: 'applied' });
});

test('a confirm event is a pending confirm card carrying the sample and counts', () => {
  const m = M.newReply();
  const sample = [{ date: '2026-09-01', merchant: 'TEST BARN', amount: -2500, from: 'Uncategorised', to: 'Groceries' }];
  M.applyEvent(m, { event: 'confirm', data: { op: 'bulk', summary: 'Not done yet: move 12 rows to Groceries.', token: 'c_abc', expires_at: '2026-10-17T02:10:00Z', changes: { transactions: 12 }, sample } });
  const c = m.cards[0];
  assert.equal(c.kind, 'confirm');
  assert.equal(c.state, 'pending');
  assert.equal(c.token, 'c_abc');
  assert.deepEqual(c.sample, sample);
  assert.deepEqual(c.changes, { transactions: 12 });
});

test('an undo or confirm event may arrive before the tool event of the same call', () => {
  const m = M.newReply();
  M.applyEvent(m, { event: 'undo', data: { op: 'rule', summary: 'Added a rule', token: 'u_1', expires_at: 'x' } });
  M.applyEvent(m, { event: 'tool', data: { name: 'mint_rule', label: 'Adding a rule' } });
  assert.equal(m.cards.length, 1);
  assert.equal(m.tool, 'Adding a rule');
});

test('an undone event marks the matching change card undone', () => {
  const m = M.newReply();
  M.applyEvent(m, { event: 'undo', data: { op: 'recategorise', summary: 'Moved 1 row', token: 'u_1', expires_at: 'x' } });
  M.applyEvent(m, { event: 'undone', data: { op: 'recategorise', summary: 'Undone: Moved 1 row' } });
  assert.equal(m.cards[0].state, 'undone');
});

test('an undone event with no card to match becomes a note', () => {
  const m = M.newReply();
  M.applyEvent(m, { event: 'undone', data: { op: 'rule', summary: 'Undone: Added a rule' } });
  assert.deepEqual(m.cards.map((c) => [c.kind, c.summary]), [['note', 'Undone: Added a rule']]);
});

test('an error event ends the reply with the real text and code, keeping what already streamed', () => {
  const m = M.newReply();
  M.applyEvent(m, { event: 'delta', data: { text: 'Working on' } });
  M.applyEvent(m, { event: 'error', data: { error: 'the model run failed: exit 1', code: 'turn-failed' } });
  assert.equal(m.status, 'error');
  assert.equal(m.text, 'Working on');
  assert.deepEqual(m.error, { message: 'the model run failed: exit 1', code: 'turn-failed' });
});

test('events after done or error are ignored', () => {
  const m = M.newReply();
  M.applyEvent(m, { event: 'done', data: { reply: 'Hi' } });
  M.applyEvent(m, { event: 'delta', data: { text: ' extra' } });
  assert.equal(m.text, 'Hi');
});

test('a stream that ends without done or error is an error, not a hang', () => {
  const m = M.newReply();
  M.applyEvent(m, { event: 'delta', data: { text: 'half' } });
  M.endStream(m);
  assert.equal(m.status, 'error');
  assert.equal(m.error.code, 'stream-broken');
  const ok = M.newReply();
  M.applyEvent(ok, { event: 'done', data: { reply: 'fine' } });
  M.endStream(ok);
  assert.equal(ok.status, 'done');
});

test('errorText: plain English, the real detail kept, retry only when trying again can help', () => {
  const busy = M.errorText({ status: 409, code: 'busy', error: 'still answering' });
  assert.match(busy.head, /still answering/i);
  assert.equal(busy.retry, true);
  assert.equal(busy.detail, '409 busy: still answering');

  const down = M.errorText({ status: 502, code: 'unreachable', error: 'connect ECONNREFUSED 127.0.0.1:3000' });
  assert.match(down.head, /The assistant is not reachable/);
  assert.match(down.detail, /ECONNREFUSED/);
  assert.equal(down.retry, true);

  const limit = M.errorText({ status: 429, code: 'daily-limit', error: 'daily limit of 100 reached' });
  assert.match(limit.head, /daily/i);
  assert.equal(limit.retry, false);

  assert.equal(M.errorText({ status: 429, code: 'quota', error: 'x' }).retry, false);
  assert.equal(M.errorText({ status: 423, code: 'paused', error: 'x' }).retry, false);
  assert.equal(M.errorText({ status: 503, code: 'not-configured', error: 'x' }).retry, false);
  assert.match(M.errorText({ offline: true, error: 'Failed to fetch' }).head, /No connection/);
  assert.match(M.errorText({ status: 401, error: 'sign in' }).head, /Signed out/);
  // An unknown code still shows the server's own words.
  const odd = M.errorText({ status: 500, code: 'weird', error: 'kaboom' });
  assert.match(odd.detail, /kaboom/);
  assert.equal(odd.retry, true);
});

test('renderMd escapes everything and only adds bold, code, bullets and breaks', () => {
  const html = M.renderMd('<img src=x onerror=alert(1)> **bold** and `code`\n- one\n- two\n\nnext & <b>');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<b>'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.equal((html.match(/<li>/g) ?? []).length, 2);
  assert.match(html, /next &amp; &lt;b&gt;/);
  assert.ok(!/<a\b/.test(M.renderMd('[x](javascript:alert(1))')));
});

test('renderMd never produces a link or an attribute from the text', () => {
  assert.ok(!/<a\b/.test(M.renderMd('[click](https://evil.test) https://evil.test')));
  // Escaped quotes leave the words as plain text; what matters is that no tag carries an attribute.
  assert.ok(!/<[a-z]+\s/i.test(M.renderMd('" onmouseover="x <b onclick=1>')));
});

test('suggested prompts depend on the tab and are never empty', () => {
  const views = ['home', 'transactions', 'budgets', 'save', 'tax', 'more', 'accounts', 'reports', 'income', 'plan'];
  const seen = new Map();
  for (const v of views) {
    const p = M.promptsFor(v);
    assert.ok(p.length >= 2 && p.length <= 4, v);
    assert.ok(p.every((s) => typeof s === 'string' && s.length > 8 && s.length <= 80), v);
    seen.set(v, p.join('|'));
  }
  assert.notEqual(seen.get('home'), seen.get('tax'));
  assert.notEqual(seen.get('save'), seen.get('transactions'));
  assert.notEqual(seen.get('budgets'), seen.get('transactions'));
  assert.ok(M.promptsFor('nonsense').length >= 2, 'an unknown screen still gets a default set');
  assert.ok(!M.promptsFor('home').some((s) => /—|–/.test(s)), 'no dashes in copy');
});

test('newConversationId is a valid assistant conversation id and different each time', () => {
  const a = M.newConversationId();
  const b = M.newConversationId();
  assert.match(a, /^[A-Za-z0-9_-]{1,100}$/);
  assert.notEqual(a, b);
});

test('trimHistory keeps the newest messages and drops a leading orphan', () => {
  const msgs = Array.from({ length: 90 }, (_, i) => ({ id: i, role: i % 2 ? 'assistant' : 'user', text: `m${i}` }));
  const t = M.trimHistory(msgs, 60);
  assert.equal(t.length, 60);
  assert.equal(t.at(-1).id, 89);
  assert.equal(t[0].role, 'user');
});

test('cardLive: an undo or confirm card is only usable until it expires', () => {
  const now = Date.parse('2026-10-17T02:00:00Z');
  assert.equal(M.cardLive({ expires_at: '2026-10-17T02:05:00Z' }, now), true);
  assert.equal(M.cardLive({ expires_at: '2026-10-17T01:59:00Z' }, now), false);
  assert.equal(M.cardLive({ expires_at: null }, now), true);
});
