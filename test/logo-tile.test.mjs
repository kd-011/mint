// The row icon: a merchant logo when the server has one, otherwise a letter
// tile tinted from a hash of the name, and the existing icon for transfers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { tileHue, merchantInitial, logoTile, HUES } = createRequire(import.meta.url)('../public/logo-tile.js');
const ICON = '<svg class="fallback"></svg>';

test('the tint is stable per name, case and spacing blind, and spread across the palette', () => {
  assert.equal(tileHue('Woolworths'), tileHue('  woolworths '));
  assert.equal(tileHue('Woolworths'), tileHue('Woolworths'));
  const seen = new Set(['Coles', 'Aldi', 'Kmart', 'Bunnings', 'Netflix', 'Spotify', 'Uber', 'Optus', 'Telstra', 'Temu', 'Amazon', 'BP'].map(tileHue));
  assert.ok(seen.size >= 5, `only ${seen.size} tints`);
  for (const h of seen) assert.ok(Number.isInteger(h) && h >= 0 && h < HUES);
});

test('the letter is the first letter or digit of the merchant, upper case', () => {
  assert.equal(merchantInitial('woolworths'), 'W');
  assert.equal(merchantInitial('  "7-Eleven"'), '7');
  assert.equal(merchantInitial('(a) b'), 'A');
  assert.equal(merchantInitial(''), '');
  assert.equal(merchantInitial('---'), '');
});

test('a merchant with a logo gets an image over its letter tile, lazy, async, decorative', () => {
  const html = logoTile({ name: 'Woolworths', logo: '/api/logo/woolworths?v=abcd1234', icon: ICON });
  assert.match(html, /<img /);
  assert.match(html, /src="\/api\/logo\/woolworths\?v=abcd1234"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /decoding="async"/);
  assert.match(html, /alt=""/);
  assert.match(html, />W</, 'the letter sits underneath, so a failed image leaves a tile');
  assert.match(html, /class="[^"]*\bic\b[^"]*"/);
  assert.match(html, /\blt\d+\b/);
  assert.doesNotMatch(html, /fallback/);
  assert.doesNotMatch(html, /style=|onerror=|onload=/, 'the page CSP forbids inline style and handlers');
});

test('no logo gives a letter tile, no image and no wallet icon', () => {
  const html = logoTile({ name: 'Quiet Fixers', logo: null, icon: ICON });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, />Q</);
  assert.doesNotMatch(html, /fallback/);
});

test('transfers and nameless rows keep the icon they had', () => {
  assert.match(logoTile({ name: 'Transfer to Savings', logo: '/api/logo/x?v=1', transfer: true, icon: ICON }), /fallback/);
  assert.doesNotMatch(logoTile({ name: 'Transfer to Savings', logo: '/api/logo/x?v=1', transfer: true, icon: ICON }), /<img/);
  assert.match(logoTile({ name: '', logo: null, icon: ICON }), /fallback/);
  assert.match(logoTile({ name: '!!!', logo: null, icon: ICON }), /fallback/);
});

test('names and urls are escaped', () => {
  const html = logoTile({ name: '<script>alert(1)</script>', logo: '/api/logo/x"onerror="1', icon: ICON });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /"onerror="/);
});

test('the image class is lgi, not lg (lg is the chart legend pill and stretched logos), and a bank tile is marked bk', () => {
  const html = logoTile({ name: 'NAB', logo: '/api/logo/bank%3Anab?v=1', icon: ICON, bank: true });
  assert.match(html, /<img class="lgi/);
  assert.doesNotMatch(html, /class="lg[ "]/);
  assert.match(html, /class="ic lt lt\d+ bk"/);
  assert.doesNotMatch(logoTile({ name: 'Coles', logo: '/x?v=1', icon: ICON }), /\bbk\b/);
});
