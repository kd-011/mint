// Owner, 2026-10-20: "Remove the mint top bar and all those buttons not needed, also remove that what you own and
// owe, and put pay day under net worth number." The page is vanilla scripts with no DOM in the test runner, so
// these read the source, and lift nwBlock and paydayText out of home.js to run them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => readFileSync(join(PUB, f), 'utf8');
const code = (f) => read(f).split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
const { MORE_ITEMS } = createRequire(import.meta.url)(join(PUB, 'routes.js'));

const GONE = ['top', 'brand', 'searchbtn', 'demochip', 'status', 'lockbtn'];

test('index.html has no top bar and none of its buttons', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /<header\b/);
  for (const id of GONE) assert.doesNotMatch(html, new RegExp(`id="${id}"`), `#${id} is gone`);
  assert.doesNotMatch(html, /top-r/);
  assert.match(html, /id="palette"/, 'the search palette itself stays');
  assert.match(html, /class="skip" href="#view"/, 'the skip link stays');
});

test('no script reaches for the removed elements', () => {
  for (const f of ['app.js', 'chat.js', 'search.js', 'core.js', 'homesync.js', 'home.js']) {
    const src = code(f);
    for (const id of ['#top', '#brand', '#searchbtn', '#demochip', '#status', '#lockbtn']) assert.ok(!src.includes(`'${id}`) && !src.includes(`"${id}`) && !src.includes(`${id} `), `${f} does not use ${id}`);
    assert.doesNotMatch(src, /getElementById\('top'\)/, `${f} does not measure the top bar`);
  }
  assert.doesNotMatch(code('chat.js'), /top-r|insertBefore\(fab/, 'the Ask button is no longer put in a bar');
  assert.doesNotMatch(code('core.js'), /function renderStatus/, 'the status pill painter is gone');
});

test('lock logic stays: the lock card, auto-lock and the lockstate event', () => {
  const lock = code('lock.js');
  assert.match(lock, /mint:lockstate/);
  assert.match(lock, /function cover\(/);
  assert.doesNotMatch(lock, /'top'/, 'cover() no longer lists the top bar');
});

test('chat still opens from Home and from the palette without a button of its own', () => {
  assert.match(code('home.js'), /data-qa'?\]?[\s\S]*chatUi\.open\(\)/);
  const chat = code('chat.js');
  assert.match(chat, /open\(\) \{ if \(!S\.open\) open\(\); \}/);
  assert.doesNotMatch(chat, /\bfab\b/, 'no floating or bar button is built');
});

test('the CSS drops the bar rules and sticky offsets sit at the safe area', () => {
  const css = read('style.css');
  assert.doesNotMatch(css, /(^|\n)#top\b|#brand|#searchbtn|#demochip|#lockbtn|#status\b|top-r|\.leaf\b/);
  assert.match(css, /--top:0px/);
  assert.doesNotMatch(css, /--top:56px/);
  // The notch is cleared once, on the shell, not by a header that is no longer there.
  assert.match(css, /body\{[^}]*padding-top:env\(safe-area-inset-top\)/);
});

test('More lists a Search row that opens the palette, 44px or more to tap', () => {
  const more = code('more.js');
  const routes = code('routes.js');
  assert.match(routes, /MORE_SEARCH/);
  assert.match(more, /MORE_SEARCH/);
  assert.match(more, /openPalette\(\)/);
  assert.match(more, /<button[^>]*class="row"[^>]*data-act="search"/);
  assert.ok(!MORE_ITEMS.some((i) => i.label === 'Search'), 'Search is an action, not a route in the list');
  assert.match(read('style.css'), /\.row\{[^}]*min-height:60px/);
});

test('the / and Ctrl or Cmd K shortcuts still open the palette', () => {
  assert.match(code('ux-model.js'), /key === '\/'\) return \{ state: idle, action: \{ type: 'palette' \}/);
  assert.match(code('keys.js'), /a\.type === 'palette'\) openPalette\(\{ instant: true \}\)/);
  assert.doesNotMatch(code('search.js'), /searchbtn/);
});

// the net worth card

const home = read('home.js');
const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
function lift() {
  const a = home.indexOf('function nwBlock(');
  const b = home.indexOf('\n}\n', home.indexOf('function nwParts(')) + 3;
  const p = home.indexOf('const paydayText');
  const pEnd = home.indexOf('\n', p);
  const ctx = vm.createContext({
    money: (c) => AUD.format(c / 100),
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`,
  });
  vm.runInContext(`${home.slice(a, b)}\n${home.slice(p, pEnd + 1)}\nthis.nwBlock = nwBlock; this.paydayText = paydayText;`, ctx);
  return ctx;
}
const NW = { net_worth: 123456789, assets: 150000000, liabilities: 26543211, groups: {} };

test('nwBlock has no own and owe row', () => {
  const html = lift().nwBlock(NW);
  assert.doesNotMatch(html, /What you own|What you owe|class="split"/);
  assert.match(html, /id="nwbig"[^>]*>\$1,234,567<\/span>/);
});

test('payday sits on its own line directly under the number, hidden until there is a cycle', () => {
  const html = lift().nwBlock(NW);
  const big = html.indexOf('class="big');
  const pay = html.indexOf('id="nwpay"');
  assert.ok(big >= 0 && pay > big, 'the payday line follows the number');
  assert.doesNotMatch(html, /<div class="label">[^<]*<span[^>]*id="nwpay"/, 'no longer in the label');
  assert.match(html, /<[a-z]+ [^>]*id="nwpay"[^>]*\bhidden\b|<[a-z]+ [^>]*\bhidden\b[^>]*id="nwpay"/, 'no empty gap before the cycle arrives');
  assert.doesNotMatch(html, /class="h2r"/);
});

test('paydayText keeps its words', () => {
  const { paydayText } = lift();
  assert.equal(paydayText({ next_payday: '2026-10-29', days_left: 9 }), '9 days to payday');
  assert.equal(paydayText({ next_payday: '2026-10-29', days_left: 0 }), 'Payday today');
  assert.equal(paydayText({ next_payday: '2026-10-29', late: true, days_late: 2 }), 'Payday 2 days late');
  assert.equal(paydayText(null), '');
});

test('paintPayday shows the line only when there is text, and the skeleton matches the smaller card', () => {
  const src = code('home.js');
  assert.match(src, /const paintPayday = [\s\S]*?\.hidden = !/);
  assert.doesNotMatch(src, /skeletonCard\(189\)/);
  assert.doesNotMatch(src, /What you own|What you owe/);
  assert.doesNotMatch(read('style.css'), /\.hero \.split|\.hero\.nw \.split/);
});

test('the README no longer describes the top bar or the own and owe split', () => {
  const readme = readFileSync(join(PUB, '..', 'docs', 'reference.md'), 'utf8');
  assert.doesNotMatch(readme, /search pill in the header|header pill|beside the Synced pill|Demo chip sits/);
});
