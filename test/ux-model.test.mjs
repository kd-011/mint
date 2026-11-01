// The logic behind search, shortcuts, the Home sync strip and the insights
// card. public/ux-model.js is plain script in the page and a CommonJS module here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UxModel: M } = require('../public/ux-model.js');
const { resolveRoute, ROUTES } = require('../public/routes.js');

test('every screen the palette lists is a real route', () => {
  const ids = new Set();
  for (const s of M.SCREENS) {
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    const u = new URL(s.href, 'http://x');
    const r = resolveRoute(u.pathname, u.search);
    assert.ok(r.redirect || ROUTES[u.pathname], `${s.href} is not a route`);
    assert.notEqual(r.view, 'notfound', s.href);
  }
});

test('typing matches screens and actions, label starts first', () => {
  const m = (q, o) => M.matchStatic(q, o);
  assert.deepEqual(m('sync').actions.map((a) => a.id), ['sync']);
  assert.equal(m('add b').actions[0].id, 'add-budget');
  assert.deepEqual(m('sub').screens.map((s) => s.id).slice(0, 1), ['subs']);
  assert.equal(m('sub').actions[0].id, 'add-sub'); // matched on "subscription"
  assert.equal(m('salary').screens[0].id, 'income'); // by an extra word
  assert.equal(m('tr').screens[0].id, 'transactions');
  assert.deepEqual(m('zzzz'), { actions: [], screens: [] });
  // Every word has to match.
  assert.deepEqual(m('home loan').screens.map((s) => s.id), ['debt']);
  // Nothing typed lists the actions and the first few screens.
  assert.equal(m('').actions.length, 4);
  assert.equal(m('').screens.length, 6);
  // Shortcuts are a desktop thing.
  assert.ok(m('keyboard').actions.some((a) => a.id === 'shortcuts'));
  assert.ok(!m('keyboard', { desktop: false }).actions.some((a) => a.id === 'shortcuts'));
});

test('recent searches: newest first, no repeats, no noise, capped', () => {
  let r = [];
  for (const q of ['coles', 'Bunnings', ' coles ', 'x', '', 'a'.repeat(61)]) r = M.pushRecent(r, q);
  assert.deepEqual(r, ['coles', 'Bunnings']);
  for (const q of ['one1', 'two2', 'three', 'four', 'five5', 'six66', 'seven']) r = M.pushRecent(r, q);
  assert.equal(r.length, 6);
  assert.equal(r[0], 'seven');
});

test('saved view filters compare by value, not by order or blanks', () => {
  assert.ok(M.sameFilters({ q: 'a', from: '2026-10-01' }, { from: '2026-10-01', q: 'a', tax: '' }));
  assert.ok(!M.sameFilters({ q: 'a' }, { q: 'a', tax: '1' }));
  assert.ok(!M.sameFilters({ q: 'a' }, { q: 'b' }));
  assert.ok(M.sameFilters({}, { q: undefined }));
  assert.ok(M.hasFilters({ q: 'a' }) && !M.hasFilters({ q: '' }) && !M.hasFilters({}));
});

const press = (state, key, extra = {}, now = 1000) => M.keyAction(state, { key, ...extra }, now);

test('slash, question mark and Ctrl or Cmd K', () => {
  assert.equal(press(null, '/').action.type, 'palette');
  assert.equal(press(null, '?', { shiftKey: true }).action.type, 'help');
  assert.equal(press(null, 'k', { ctrlKey: true }).action.type, 'palette');
  assert.equal(press(null, 'K', { metaKey: true }).action.type, 'palette');
  assert.ok(press(null, '/').prevent);
});

test('typing in a field leaves every key alone except Ctrl K', () => {
  for (const key of ['/', '?', 'j', 'k', 'e', 'g']) assert.deepEqual(press(null, key, { typing: true }).action, null, key);
  assert.equal(press(null, 'k', { ctrlKey: true, typing: true }).action.type, 'palette');
  assert.equal(press(null, 'e', { ctrlKey: true }).action, null); // browser shortcuts stay the browser's
  assert.equal(press(null, 'j', { altKey: true }).action, null);
});

test('g then a letter goes to a tab, within a short window', () => {
  const a = press(null, 'g', {}, 1000);
  assert.deepEqual(a.action, { type: 'chord', pending: 'g' });
  for (const [k, tab] of Object.entries({ h: 'home', s: 'spending', v: 'save', t: 'tax', m: 'more' })) {
    assert.deepEqual(press(a.state, k, {}, 1400).action, { type: 'go', tab }, k);
  }
  assert.equal(press(a.state, 'h', {}, 1000 + 1501).action, null, 'too slow');
  assert.equal(press(a.state, 'x', {}, 1200).action, null);
  assert.equal(press(press(a.state, 'x', {}, 1200).state, 'h', {}, 1300).action, null, 'a wrong key cancels the chord');
  assert.deepEqual(press(a.state, 'g', {}, 1200).action, { type: 'chord', pending: 'g' }, 'g g starts over');
});

test('j, k and e drive the list, and a list never steps off its ends', () => {
  assert.deepEqual(press(null, 'j').action, { type: 'move', delta: 1 });
  assert.deepEqual(press(null, 'k').action, { type: 'move', delta: -1 });
  assert.deepEqual(press(null, 'e').action, { type: 'edit' });
  assert.equal(press(null, 'J', { shiftKey: true }).action, null);
  assert.equal(M.nextIndex(-1, 1, 5), 0);
  assert.equal(M.nextIndex(-1, -1, 5), 0);
  assert.equal(M.nextIndex(2, 1, 5), 3);
  assert.equal(M.nextIndex(4, 1, 5), 4);
  assert.equal(M.nextIndex(0, -1, 5), 0);
  assert.equal(M.nextIndex(0, 1, 0), -1);
});

test('the help sheet lists what the keys do', () => {
  const keys = M.SHORTCUTS.flatMap(([, rows]) => rows.map(([k]) => k));
  for (const k of ['/', 'g h', 'g s', 'g v', 'g t', 'g m', 'j', 'k', 'e', '?']) assert.ok(keys.includes(k), k);
});

test('sync progress is four named steps with a bar that only moves forward', () => {
  assert.equal(M.syncSteps({ running: false }), null);
  assert.equal(M.syncSteps(null), null);
  const at = (label) => M.syncSteps({ running: true, label });
  const labels = ['Starting', 'Checking connections', 'Reading balances', 'Fetching Everyday (1 of 4)', 'Fetching Card (3 of 4)', 'Fetching Loan (4 of 4)', 'Categorising'];
  const pcts = labels.map((l) => at(l).pct);
  assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b));
  assert.ok(pcts[0] > 0 && pcts.at(-1) < 100);
  assert.deepEqual(at('Fetching Card (3 of 4)').phases.map((p) => p.state), ['done', 'done', 'now', 'todo']);
  assert.equal(at('Fetching Card (3 of 4)').text, 'Pulling transactions, account 3 of 4');
  assert.equal(at('Backfilling Old (1 of 1)').now, 2);
  assert.deepEqual(at('Categorising').phases.map((p) => p.state), ['done', 'done', 'done', 'now']);
  assert.equal(at('Starting').text, 'Connecting to your banks');
});

test('pull to refresh resists the finger and arms past the mark', () => {
  assert.deepEqual(M.pull(-20), { shown: 0, ready: false, pct: 0 });
  assert.equal(M.pull(60).ready, false);
  assert.equal(M.pull(140).ready, true);
  assert.equal(M.pull(900).shown, 110);
});

test('insight lines and the links behind them', () => {
  const fmt = (c) => `$${(c / 100).toFixed(0)}`;
  const ins = { cycle: { start: '2026-10-07', to: '2026-10-17' } };
  assert.equal(M.moverText({ change: 25000, percent: 125, before: 20000 }, fmt), 'Up $250 (+125%)');
  assert.equal(M.moverText({ change: -8500, percent: -71, before: 12000 }, fmt), 'Down $85 (-71%)');
  assert.equal(M.moverText({ change: 9000, percent: null, before: 0 }, fmt), 'Up $90');
  assert.equal(M.changeWord({ before: 0, percent: null }), 'new this cycle');
  assert.equal(M.changeWord({ before: 5, percent: -20 }), '-20%');
  assert.equal(M.moverHref(ins, { category_id: 7 }), '/transactions?category=7&direction=out&business=0&from=2026-10-07&to=2026-10-17');
  assert.match(M.moverHref(ins, { category_id: null }), /^\/transactions\?category=none&/);
  assert.match(M.merchantHref(ins, 'Test Servo & Co'), /q=Test\+Servo\+%26\+Co&/);
  // Whatever the card links to, the list reads back.
  const u = new URL(M.moverHref(ins, { category_id: 7 }), 'http://x');
  assert.ok([...u.searchParams.keys()].every((k) => M.FILTER_KEYS.includes(k)));
});

test('a download name comes from the header, safely', () => {
  assert.equal(M.filenameFrom('attachment; filename="mint-transactions-2026-10-17.csv"'), 'mint-transactions-2026-10-17.csv');
  assert.equal(M.filenameFrom(null), 'mint-transactions.csv');
  assert.equal(M.filenameFrom('attachment; filename="../../x/y.csv"'), '....xy.csv');
});
