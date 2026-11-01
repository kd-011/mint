// The Settings screen: /settings under More with Demo mode as its first and
// only section, in the shell list and the worker's file list, with the top-bar
// Demo chip next to the Synced pill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { MINT_TABS, MORE_ITEMS, SHELL_PATHS, resolveRoute } = createRequire(import.meta.url)(join(ROOT, 'public', 'routes.js'));
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const SCRIPTS = /const SCRIPTS = \[([^\]]+)\]/.exec(read('server.mjs'))[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));

test('/settings is a screen under More, and the dock still has exactly four tabs', () => {
  const r = resolveRoute('/settings');
  assert.equal(r.view, 'settings');
  assert.equal(r.tab, 'more');
  assert.equal(r.parent, '/more');
  assert.equal(r.title, 'Settings');
  assert.equal(resolveRoute('/settings/').redirect, '/settings');
  assert.ok(SHELL_PATHS.includes('/settings'));
  assert.equal(MINT_TABS.length, 4);
});

test('More has a Settings row with an icon that exists in the I table', () => {
  const i = MORE_ITEMS.find((x) => x.href === '/settings');
  assert.ok(i, 'row exists');
  assert.equal(i.label, 'Settings');
  assert.equal(MORE_ITEMS.at(-1).href, '/settings', 'last in the list');
  assert.match(read('public', 'core.js'), new RegExp(`^  ${i.icon}: ic\\(`, 'm'));
  assert.match(read('public', 'core.js'), /^  gear: ic\(/m);
});

test('the scripts: demo-math.js before core.js, settings.js after core.js, both in the shell', () => {
  assert.ok(existsSync(join(ROOT, 'public', 'demo-math.js')));
  assert.ok(existsSync(join(ROOT, 'public', 'settings.js')));
  assert.ok(SCRIPTS.indexOf('demo-math.js') >= 0 && SCRIPTS.indexOf('demo-math.js') < SCRIPTS.indexOf('core.js'));
  assert.ok(SCRIPTS.indexOf('settings.js') > SCRIPTS.indexOf('core.js') && SCRIPTS.indexOf('settings.js') < SCRIPTS.indexOf('app.js'));
  // The worker's list is stamped from SCRIPTS and the shell paths, so both are covered by these.
  assert.match(read('public', 'sw.js'), /__SHELL_SCRIPTS__/);
  assert.match(read('public', 'sw.js'), /__TAB_PATHS__/);
});

test('the router draws it', () => {
  assert.match(read('public', 'app.js'), /settings: viewSettings/);
});

test('Settings: a switch, a Shuffle numbers button that says why it is off, a toast and a haptic', () => {
  const s = read('public', 'settings.js');
  assert.match(s, /role="switch"|switchHtml\(/);
  assert.match(s, /Shuffle numbers/);
  assert.match(s, /setDemo\(/);
  assert.match(s, /shuffleDemo\(/);
  assert.match(s, /toast\(/);
  assert.match(s, /buzz\(/);
  assert.match(s, /disabled/);
  assert.match(s, /title="[^"]*[Tt]urn on demo mode/);
  assert.doesNotMatch(s, /—/, 'no em dashes');
  assert.doesNotMatch(s, /api\(|mutate\(|fetch\(/, 'the toggle is local only, nothing is sent');
});

test('there is no Demo chip: Settings and the More row carry the demo state', () => {
  assert.doesNotMatch(read('public', 'index.html'), /id="demochip"/);
  assert.doesNotMatch(read('public', 'app.js'), /demochip/);
  assert.match(read('public', 'more.js'), /Demo mode is on/);
});

test('the Ask tile is hidden in demo mode and opening chat is blocked with a toast', () => {
  const chat = read('public', 'chat.js');
  assert.match(chat, /demoActive\(\)/);
  assert.match(chat, /DEMO_NO_CHAT|Chat is off in demo mode/);
  assert.match(read('public', 'home.js'), /demoActive\(\) && a\.act === 'chat'/);
});

test('no copy in the new files uses an em dash', () => {
  for (const f of ['demo-math.js', 'settings.js']) assert.doesNotMatch(read('public', f), /—/, f);
});
