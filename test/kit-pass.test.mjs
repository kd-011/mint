// The kit pass, second attempt (UI quality programme 2026-10, phone-first kit 24b57b7): Mint keeps its own palette, gradient hero, tracked caps and glass dock,
// and takes the kit's face, phone type roles, toasts and sheet spring on top. The page is vanilla scripts
// with no DOM in the test runner, so these read the source, and the served shell is checked through
// server.mjs's static table by a real request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const read = (f) => readFileSync(join(PUB, f), 'utf8');
const css = read('style.css');
const core = read('core.js');
const html = read('index.html');

test('the kit is vendored: css, motion helper, icons, fonts and the commit it came from', () => {
  for (const f of ['kit/kit.css', 'kit/kit.js', 'kit/icons.svg', 'kit/VERSION', 'kit/fonts/geist-latin.woff2', 'kit/fonts/geist-mono-latin.woff2']) assert.ok(existsSync(join(PUB, f)), f);
  assert.match(read('kit/VERSION'), /^[0-9a-f]{7}/);
});

test('the page loads the kit before its own css, pinned dark, and the worker caches it', () => {
  assert.match(html, /<html[^>]*class="k-root"[^>]*data-theme="dark"/);
  assert.ok(html.indexOf('/kit/kit.css') > 0 && html.indexOf('/kit/kit.css') < html.indexOf('/style.css'), 'kit.css first');
  assert.match(html, /<script type="module" src="\/kit-boot\.js\?v=__V__"><\/script>/, 'no inline script: the CSP is script-src self');
  assert.match(read('kit-boot.js'), /import \* as kit from '\/kit\/kit\.js[^']*';\nwindow\.kit = kit;/);
  assert.doesNotMatch(read('kit-boot.js').replace(/\/\/.*$/gm, ''), /kit\.init\(/, 'kit.init() installs a click guard on [aria-busy], which would eat clicks in the busy chat log');
  const sw = read('sw.js');
  assert.match(sw, /'\/kit\/kit\.css\?v=__V__'/);
  assert.match(sw, /'\/kit\/kit\.js\?v=__V__'/);
});

test('Mint keeps its own palette, gradient hero, tracked caps and glass dock: the kit adds knobs, it does not replace tokens', () => {
  assert.match(css, /--bg:#0b0d0c; --panel:#161b19;/);
  assert.match(css, /--accent:#3ddc97;/);
  assert.match(css, /\.hero\.nw\{[^}]*\n?[^}]*linear-gradient\(165deg,#12382a/, 'the green gradient net worth hero stays');
  assert.match(css, /\.hero\.nw::after|radial-gradient\(120% 90% at 0% 0%/);
  assert.match(css, /letter-spacing:\.1em;text-transform:uppercase/, 'tracked-caps labels stay');
  assert.match(css, /backdrop-filter:blur\(22px\)/, 'the glass dock stays');
  assert.match(css, /--k-accent:#3ddc97; --k-on-accent:#03261a; --k-hero:#1f9d6c;/, 'the kit knobs wear Mint green');
});

test('phone-first type: the kit face, body 16, secondary 14, meta 12 at the smallest, row titles 17 at 600', () => {
  assert.match(css, /--font:var\(--k-font\);/);
  assert.match(css, /--fs-2xs:12px; --fs-xs:13px; --fs-sm:14px; --fs-md:15px; --fs-base:16px; --fs-lg:17px;/);
  const sizes = [...css.matchAll(/--fs-[0-9a-z]+:(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(Math.min(...sizes) >= 12, 'nothing under 12px');
  assert.match(css, /\.row \.t1\{font-size:var\(--fs-lg\);font-weight:var\(--fw-semi\)/);
  assert.match(html, /<html[^>]*data-density="phone"/);
});

test('rows wrap their title and meta on a phone; only the virtualised transactions list ellipsizes', () => {
  assert.match(css, /\.row:not\(\.tx\) :is\(\.t1,\.t2\)\{white-space:normal;overflow-wrap:anywhere\}/);
});

test('a neutral chip is plain text, a status chip (ok, warn, bad) keeps its fill', () => {
  assert.match(css, /\.chip:not\(\.ok\):not\(\.warn\):not\(\.bad\)\{background:none;padding:0;border-radius:0/);
  assert.match(css, /\.chip\.warn\{background:var\(--amber-soft\)/);
});

test('the focus pull entrance is capped by core.js and gone under reduced motion', () => {
  assert.match(css, /@keyframes pull\{from\{opacity:0;transform:translateY\(6px\);filter:blur\(4px\)\}/);
  assert.match(css, /\.stag\{animation:pull var\(--dur-2\) var\(--spring\) both\}/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\s*\.vline\{animation:none;stroke-dashoffset:0\}\s*\.bar,\.vfade,\.stag\{animation:none\}/);
});

test('the consent banner says 1 day, not 1 days, and the offset row carries no hint line', () => {
  assert.match(read('home.js'), /consent_days === 1 \? 'day' : 'days'/);
  assert.doesNotMatch(read('save.js'), /No interest, it trims loan interest/);
});

test('sheets rise on the kit spring, a drag takes over, and a list reveal is capped at 8 items inside 400ms', () => {
  assert.match(core, /window\.kit\.spring\(window\.kit\.springs\.sheet\)/);
  assert.match(core, /panel\._enter\?\.cancel\(\); \/\/ a drag takes over/);
  assert.match(core, /Math\.min\(i, 7\) \* 30/);
  });

test('toasts go through the kit, with the real error text underneath, and fall back to the old toast without it', () => {
  assert.match(core, /window\.kit\.toast\(/);
  assert.match(core, /detail: cut > 0 \? msg\.slice\(cut \+ 2\) : undefined/);
  assert.match(core, /if \(window\.kit\) \{/);
});

test('the server serves the kit with the right types and the version covers it', async () => {
  const src = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  assert.match(src, /'\.woff2': 'font\/woff2'/);
  assert.match(src, /const KIT = \['kit\/kit\.css', 'kit\/kit\.js', 'kit\/icons\.svg'/);
  assert.match(src, /\.update\(Buffer\.concat\(KIT\.map\(\(f\) => raw\[f\]\)\)\)/, 'a kit change busts the cache');
});

test('kit toasts sit above sheets, modals and the palette, and clear the dock on a phone', () => {
  const z = Number(/\.k-toasts\{z-index:(\d+)\}/.exec(css)?.[1]);
  for (const id of ['sheet', 'modal', 'palette']) {
    const m = new RegExp(`#${id}\\{[^}]*z-index:(\\d+)`).exec(css);
    if (m) assert.ok(z > Number(m[1]), `toasts above #${id}`);
  }
  assert.ok(z > 95, 'above the palette (95)');
  assert.match(css, /\.k-toasts\{bottom:calc\(var\(--navh\) \+ env\(safe-area-inset-bottom\) \+ 16px\)\}/);
});

test('the chat log keeps aria-busy while a turn streams, and nothing in the page blocks clicks on it', () => {
  assert.match(read('chat.js'), /log\.setAttribute\('aria-busy', String\(S\.busy\)\)/);
  assert.doesNotMatch(read('kit-boot.js').replace(/\/\/.*$/gm, ''), /init\(/);
});

test('the budgets flexible card has one figure (what is left) and no total repeated in the section headings', () => {
  const b = read('budgets.js');
  assert.match(b, /id="flexleft"/);
  assert.doesNotMatch(b, /id="flexspent"/);
  const sec = /function budgetSection[\s\S]*?\n\}/.exec(b)[0];
  assert.doesNotMatch(sec, /money0/, 'the section heading carries no total');
});

// review round 2: Undo must be real, and Budgets says each figure once
import vm from 'node:vm';

function bootUndo() {
  const timers = [];
  const el = () => new Proxy(function () {}, { get: (t, k) => (k === 'classList' ? { add() {}, remove() {}, toggle() {}, contains: () => false } : k === 'style' || k === 'dataset' ? {} : k === 'innerHTML' || k === 'textContent' ? '' : k === 'hidden' ? true : () => el()), set: () => true });
  const ctx = {
    console, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; }, Intl, Date, Math, JSON, Promise, Number, String, Object, Array, Map, Set, URLSearchParams, Error, requestAnimationFrame: () => 0, performance,
    document: { querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, createElement: () => el(), dispatchEvent() {}, body: el(), documentElement: el() },
    matchMedia: () => ({ matches: false, addEventListener() {} }), navigator: { onLine: true, vibrate() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, length: 0, key: () => null },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, CustomEvent: class {},
    fetch: async () => ({ ok: true, status: 200, type: 'basic', json: async () => ({ ok: true }), statusText: 'OK' }), indexedDB: undefined, UxModel: { shortAgo: () => '' },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['demo-math.js', 'core.js']) vm.runInContext(readFileSync(join(PUB, f), 'utf8'), ctx, { filename: f });
  return { ctx, timers, run: (c) => vm.runInContext(c, ctx) };
}

test('Undo before the change is sent reverts it and sends nothing', async () => {
  const { ctx, timers, run } = bootUndo();
  run(`var log = { sent: 0, reverted: 0, undo: null, dismissed: 0 };
    mutate = async () => { log.sent++; return {}; };
    toast = (m, o) => { log.undo = o.action.fn; return () => { log.dismissed++; }; };
    undoable({ label: 'Deleted', apply() {}, revert() { log.reverted++; }, op: { method: 'DELETE', path: '/api/x/1' } });`);
  run('log.undo()');
  for (const t of timers) if (!t.dead) await t.fn();
  assert.deepEqual(JSON.parse(run('JSON.stringify({ sent: log.sent, reverted: log.reverted })')), { sent: 0, reverted: 1 });
  void ctx;
});

test('Undo after the change has been sent does nothing, and the Undo toast is dismissed with the commit', async () => {
  const { timers, run } = bootUndo();
  run(`var log = { sent: 0, reverted: 0, undo: null, dismissed: 0 };
    mutate = async () => { log.sent++; return {}; };
    toast = (m, o) => { if (o.action) log.undo = o.action.fn; return () => { log.dismissed++; }; };
    undoable({ label: 'Deleted', apply() {}, revert() { log.reverted++; }, op: { method: 'DELETE', path: '/api/x/1' } });`);
  const commit = timers.find((t) => t.ms === 5200);
  await commit.fn();
  await new Promise((r) => setImmediate(r));
  run('log.undo()'); // a late tap on a toast that outlived its timer (hover, hidden tab)
  assert.deepEqual(JSON.parse(run('JSON.stringify({ sent: log.sent, reverted: log.reverted, dismissed: log.dismissed })')), { sent: 1, reverted: 0, dismissed: 1 });
});

test('Budgets does not say the Ready to assign figure twice', () => {
  const b = read('budgets.js');
  const ready = /function readyCard[\s\S]*?\n\}/.exec(b)[0];
  assert.doesNotMatch(ready, /<b>\$\{esc\(money\(-?z\.ready\)\)\}/, 'no banner repeats the card figure');
  assert.match(ready, /Assigned more than this cycle brings in/);
});

test('only the main budgets card says Flexible; the month roll-up and a category card keep Left and Over', () => {
  const b = read('budgets.js');
  assert.equal([...b.matchAll(/'Flexible left'/g)].length, 1);
  assert.equal([...b.matchAll(/left >= 0 \? 'Left' : 'Over'/g)].length, 2);
});
