// Owner, 2026-10-20: the "+$473 over a year" line is gone from the Home net worth card. He then dropped the
// what you own and what you owe row too, and put days to payday under the number (test/top-bar-removed.test.mjs). The page is vanilla scripts with no DOM in the test
// runner, so nwBlock is lifted out of the source and run against small stand-ins for the core.js helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = readFileSync(join(ROOT, 'public', 'home.js'), 'utf8');
const css = readFileSync(join(ROOT, 'public', 'style.css'), 'utf8');

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
function load() {
  const start = home.indexOf('function nwBlock(');
  assert.ok(start >= 0, 'nwBlock exists');
  const parts = home.indexOf('function nwParts(');
  assert.ok(parts > start, 'nwParts follows nwBlock');
  const end = home.indexOf('\n}\n', parts) + 3;
  const ctx = vm.createContext({
    money: (c) => AUD.format(c / 100),
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
  });
  vm.runInContext(`${home.slice(start, end)}\nthis.nwBlock = nwBlock;`, ctx);
  return ctx.nwBlock;
}
const NW = { net_worth: 123456789, assets: 150000000, liabilities: 26543211, groups: { cash: 1, cards: 0, loans: 0, investments: 0, other_liabilities: 0 } };

test('the net worth card has no change-over-time line', () => {
  const html = load()(NW);
  assert.doesNotMatch(html, /delta|over a|over 3 months|all time/i);
  assert.doesNotMatch(css, /\.hero \.delta/);
  assert.doesNotMatch(home, /class="delta/);
});

test('it still renders the net worth in #nwbig, with the cents in their own element', () => {
  const html = load()(NW);
  assert.match(html, /id="nwhero"/);
  assert.match(html, /id="nwbig"[^>]*>\$1,234,567<\/span>/);
  assert.match(html, /class="cents"[^>]*>\.89</);
});

test('it no longer splits what you own from what you owe under the number', () => {
  const html = load()(NW);
  assert.doesNotMatch(html, /What you own|What you owe|class="split"/);
  assert.doesNotMatch(html, /\$1,500,000\.00|\$265,432\.11/);
});

test('nwBlock no longer takes the history or the range, and paintNw does not pass them', () => {
  assert.match(home, /function nwBlock\(nw\)/);
  // The one argument is the net worth answer, passed through the demo overlay (shownNw) so demo mode's made-up balances are in it.
  assert.match(home, /const nw = shownNw\(data\.nw\)/);
  assert.match(home, /nwBlock\(nw\)/);
});

test('a payload without the totals still draws the number', () => {
  const html = load()({ net_worth: 5000, groups: {} });
  assert.match(html, /id="nwbig"/);
  assert.doesNotMatch(html, /What you own/);
});
