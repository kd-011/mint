// How Owed to me is wired into the shell: a route under More (not a sixth
// tab), a row in the More list, a script the server serves and the worker
// caches, and a screen function the router can find.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { MINT_TABS, MORE_ITEMS, SHELL_PATHS, resolveRoute } = createRequire(import.meta.url)(join(ROOT, 'public', 'routes.js'));
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

test('/owed is a screen under More, and the dock still has exactly four tabs', () => {
  const r = resolveRoute('/owed');
  assert.equal(r.view, 'owed');
  assert.equal(r.tab, 'more');
  assert.equal(r.parent, '/more');
  assert.equal(r.title, 'Ledger');
  assert.equal(resolveRoute('/owed/').redirect, '/owed');
  assert.ok(SHELL_PATHS.includes('/owed'));
  assert.equal(MINT_TABS.length, 4);
  assert.ok(!MINT_TABS.some((t) => t.href === '/owed'));
});

test('the More list has a Ledger row with the resting line', () => {
  const i = MORE_ITEMS.find((x) => x.href === '/owed');
  assert.ok(i, 'row exists');
  assert.equal(i.label, 'Ledger');
  assert.equal(i.line, 'Who owes you and who you owe');
  assert.ok(i.icon);
});

test('server lists owed-math.js and owed.js, in that order and before app.js; the router has the view', () => {
  const scripts = /const SCRIPTS = \[([^\]]+)\]/.exec(read('server.mjs'))[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  for (const f of ['owed-math.js', 'owed.js']) assert.ok(scripts.includes(f), f);
  assert.ok(scripts.indexOf('owed-math.js') < scripts.indexOf('owed.js'));
  assert.ok(scripts.indexOf('owed.js') < scripts.indexOf('app.js'));
  assert.match(read('public', 'app.js'), /owed: viewOwed/);
  assert.match(read('public', 'owed.js'), /async function viewOwed\(/);
});

test('the owed screen reaches its list only through its own state, and uses the shared plumbing', () => {
  const src = read('public', 'owed.js');
  for (const need of ['swr(', 'mutate(', 'undoable(', 'emptyState(', 'skeletonRows(', 'bindDraft(', 'fieldError(', 'withBusy(', 'formError(', 'errorCard(', 'parseMoney(']) assert.ok(src.includes(need), need);
  assert.ok(!/\u2014/.test(src), 'no em dashes');
});

test('the Ledger hero counts up to the net it is labelled with, and the deposit picker keeps `mine` meaning the debt direction', () => {
  const src = read('public', 'owed.js');
  assert.match(src, /countUp\(\$\('#owedbig', el\), Math\.abs\(data\.net\), money, 'owed:net'\)/);
  const picker = src.slice(src.indexOf('function openDepositPicker'), src.indexOf('// ----- actions on a debt'));
  assert.equal((picker.match(/const mine\b/g) ?? []).length, 1, 'mine is declared once, as the debt direction');
  assert.match(picker, /const mine = !owesYou\(d\)/);
  assert.match(picker, /direction=\$\{mine \? 'out' : 'in'\}/);
});
