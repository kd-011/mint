// The UI uplift's pure logic: Home quick actions, short counts and times for
// tight spaces, deep links that save taps, and when the saved views row earns
// its space. public/ux-model.js is plain script in the page and a CommonJS
// module here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UxModel: M } = require('../public/ux-model.js');
const { resolveRoute } = require('../public/routes.js');

test('compactCount keeps big numbers short and exact when small', () => {
  assert.equal(M.compactCount(0), '0');
  assert.equal(M.compactCount(7), '7');
  assert.equal(M.compactCount(999), '999');
  assert.equal(M.compactCount(1000), '1k');
  assert.equal(M.compactCount(1049), '1k');
  assert.equal(M.compactCount(4502), '4.5k');
  assert.equal(M.compactCount(12000), '12k');
  assert.equal(M.compactCount(null), '0');
});

test('shortAgo fits a header pill: now, minutes, hours, days', () => {
  const now = Date.parse('2026-10-19T04:00:00Z');
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(M.shortAgo(null, now), 'never');
  assert.equal(M.shortAgo(at(20_000), now), 'now');
  assert.equal(M.shortAgo(at(5 * 60_000), now), '5m');
  assert.equal(M.shortAgo(at(59 * 60_000), now), '59m');
  assert.equal(M.shortAgo(at(3 * 3600_000), now), '3h');
  assert.equal(M.shortAgo(at(50 * 3600_000), now), '2d');
  assert.equal(M.shortAgo(at(-5000), now), 'now', 'a clock a little ahead is still now');
});

test('a budget deep link opens the category, with the cycle when one is given', () => {
  assert.equal(M.budgetHref(12), '/budgets?cat=12');
  assert.equal(M.budgetHref(12, '2026-10-07'), '/budgets?cat=12&cycle=2026-10-07');
  const r = resolveRoute('/budgets', '?cat=12&cycle=2026-10-07');
  assert.equal(r.view, 'budgets');
});

test('Home quick actions: the five jobs in a fixed order', () => {
  const a = M.homeActions({ uncategorised: 4502, online: true, syncRunning: false });
  assert.deepEqual(a.map((x) => x.id), ['fix', 'budgets', 'owed', 'ask', 'sync']);
  for (const x of a) {
    assert.ok(x.label && x.label.length <= 10, `${x.id} label fits a phone tile`);
    assert.ok(x.href || x.act, `${x.id} does something`);
    assert.ok(!/—/.test(JSON.stringify(x)), 'no em dashes');
  }
  const fix = a.find((x) => x.id === 'fix');
  assert.equal(fix.badge, '4.5k');
  assert.equal(fix.href, '/transactions?category=none');
  assert.equal(a.find((x) => x.id === 'budgets').href, '/budgets');
  assert.equal(a.find((x) => x.id === 'owed').href, '/owed?add=1');
  assert.equal(resolveRoute('/owed', '?add=1').view, 'owed');
  assert.equal(a.find((x) => x.id === 'ask').act, 'chat');
  assert.equal(a.find((x) => x.id === 'sync').act, 'sync');
});

test('Home quick actions: nothing to fix drops the badge, a sync in flight or offline explains itself', () => {
  const clean = M.homeActions({ uncategorised: 0, online: true, syncRunning: false });
  const fix = clean.find((x) => x.id === 'fix');
  assert.equal(fix.badge, undefined);
  assert.equal(fix.href, '/transactions');

  const running = M.homeActions({ uncategorised: 0, online: true, syncRunning: true }).find((x) => x.id === 'sync');
  assert.equal(running.disabled, true);
  assert.match(running.why, /already running/i);

  const off = M.homeActions({ uncategorised: 3, online: false, syncRunning: false });
  const sync = off.find((x) => x.id === 'sync');
  assert.equal(sync.disabled, true);
  assert.match(sync.why, /offline/i);
  assert.ok(!off.find((x) => x.id === 'ask').disabled, 'chat opens offline and says so itself');
  assert.ok(!off.find((x) => x.id === 'owed').disabled, 'owed writes queue offline');
});

test('the saved views row only takes space when it has something to show', () => {
  assert.equal(M.showViewsRow({ views: 0, loaded: true, canSave: false, error: false }), false);
  assert.equal(M.showViewsRow({ views: 2, loaded: true, canSave: false, error: false }), true);
  assert.equal(M.showViewsRow({ views: 0, loaded: true, canSave: true, error: false }), true, 'Save view is offered while filtering');
  assert.equal(M.showViewsRow({ views: 0, loaded: false, canSave: false, error: false }), true, 'skeleton pills while loading');
  assert.equal(M.showViewsRow({ views: 0, loaded: true, canSave: false, error: true }), false, 'the error note carries itself');
});

test('recent categories: newest first, no repeats, capped', () => {
  assert.deepEqual(M.pushRecentCat([], 5), [5]);
  assert.deepEqual(M.pushRecentCat([5, 7, 9], 7), [7, 5, 9]);
  assert.deepEqual(M.pushRecentCat([1, 2, 3, 4, 5, 6], 9, 6), [9, 1, 2, 3, 4, 5]);
  assert.deepEqual(M.pushRecentCat([1, 2], null), [1, 2], 'clearing a category is not a recent pick');
  assert.deepEqual(M.pushRecentCat(null, 3), [3]);
});

test('category suggestions: what the same merchant is filed under, then recents, never the current one', () => {
  const items = [
    { merchant: 'Uber Eats', category_id: 8 },
    { merchant: 'Uber Eats', category_id: 8 },
    { merchant: 'Uber Eats', category_id: 4 },
    { merchant: 'Uber Eats', category_id: null },
    { merchant: 'Shell', category_id: 2 },
  ];
  const s = (extra) => M.suggestCategories({ merchant: 'Uber Eats', current: null, items, recent: [2, 8, 11], ...extra });
  assert.deepEqual(s(), [8, 4, 2, 11], 'merchant history by count, then recents, 8 not repeated');
  assert.deepEqual(s({ current: 8 }), [4, 2, 11], 'the category it already has is not a suggestion');
  assert.deepEqual(s({ max: 2 }), [8, 4]);
  assert.deepEqual(s({ merchant: 'Nobody', items: [] }), [2, 8, 11], 'a new merchant falls back to recents');
  assert.deepEqual(M.suggestCategories({ merchant: null, current: null, items, recent: [] }), []);
});

// ---------- layout rules that can be checked without a browser ----------
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

test('the full-bleed rows use the same gutter as the screen padding, so nothing overflows sideways', () => {
  const css = read('style.css');
  const px = (name) => Number(new RegExp(`--${name}:(\\d+)px`).exec(css)[1]);
  const gut = px('gut');
  // The last phone-size #view padding rule must be built on the same gutter the toolbar and list bleed by.
  const viewRules = [...css.matchAll(/(?:^|\n)#view\{padding:([^;}]+)\}/g)].map((m) => m[1]);
  const phone = viewRules.filter((r) => !/px \d+px 40px/.test(r)).pop();
  const first = /var\(--(\w+)\)/.exec(phone)[1];
  const pad = first === 'gut' ? gut : px(first);
  assert.equal(pad, gut, `#view pads ${pad}px but the toolbar and list bleed by ${gut}px`);
});

test('Home leads with net worth, the account list and its totals tiles, then the quick actions', () => {
  const src = read('home.js');
  const slots = /const slots = \[([^\]]+)\]/.exec(src)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(slots.slice(0, 5), ['health', 'nw', 'accts', 'bals', 'actions']);
  assert.ok(slots.indexOf('cash') > slots.indexOf('actions'), 'the cash-short nudge stays below the quick actions');
  for (const gone of ['cockpit', 'split', 'weekly']) assert.ok(!slots.includes(gone), `${gone} is off Home`);
  for (const gone of ['cycle', 'bills', 'insights', 'nwchart']) assert.ok(!slots.includes(gone), `${gone} is off Home`);
  assert.equal(slots.at(-1), 'cash');
});

test('there is no top bar, and chat opens from the Home Ask tile rather than a button of its own', () => {
  assert.doesNotMatch(read('index.html'), /<header\b|id="top"|class="top-r"/);
  const chat = read('chat.js');
  assert.doesNotMatch(chat, /\$\('#top \.top-r'\)/);
  assert.doesNotMatch(read('style.css'), /\.chatfab|clear-fab/);
  assert.match(read('index.html'), /class="skip" href="#view"/, 'a skip link for the keyboard');
});

test('no em dashes in anything the uplift added', () => {
  for (const f of ['home.js', 'homesync.js', 'views.js', 'ux-model.js', 'core.js', 'chat.js', 'owed.js']) {
    assert.doesNotMatch(read(f), /—/, f);
  }
});

test('a new screen starts with no classes left over from the last one', () => {
  const app = read('app.js');
  assert.match(app, /const el = old\.cloneNode\(false\);\s*\n\s*el\.className = ''/);
});
