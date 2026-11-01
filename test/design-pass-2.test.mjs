// Design pass 2 (Emil, Impeccable and Apple lenses): the number ticker's maths, and the
// contract the stylesheet and the page scripts keep so the motion stays one system.
// The page is plain scripts and one stylesheet with no DOM in the runner, so the CSS
// rules are checked as text, the way test/home-hero.test.mjs reads home.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { UxModel: M } = require('../public/ux-model.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const css = read('public/style.css');
const readme = read('docs/reference.md'); // the design system section lives in the engineering notes
const core = read('public/core.js');
const keys = read('public/keys.js');
const search = read('public/search.js');
const app = read('public/app.js');

// The :root block, so a literal there (a token's own value) is not mistaken for one in a component.
const rootEnd = css.indexOf('}', css.indexOf(':root{'));
const body = css.slice(rootEnd);

// ---------- the ticker ----------

test('tickValue runs from the old figure to the new one and eases out', () => {
  assert.equal(M.tickValue(1000, 5000, 0), 1000);
  assert.equal(M.tickValue(1000, 5000, 1), 5000);
  const mid = M.tickValue(1000, 5000, 0.5);
  assert.ok(mid > 3000 && mid < 5000, 'ease out: past the half way point at half the time');
  let last = -Infinity;
  for (let k = 0; k <= 1.0001; k += 0.05) { const v = M.tickValue(1000, 5000, k); assert.ok(v >= last); last = v; }
  assert.ok(Number.isInteger(M.tickValue(0, 12345, 0.37)), 'whole cents, never a fraction');
});

test('tickValue also runs downwards and across zero, and clamps k', () => {
  assert.equal(M.tickValue(5000, -2000, 1), -2000);
  assert.ok(M.tickValue(5000, -2000, 0.5) < 5000);
  assert.equal(M.tickValue(100, 900, -3), 100);
  assert.equal(M.tickValue(100, 900, 7), 900);
});

test('tickPlan: the first figure of a session counts up, a repeat figure stays put, a change ticks from what was shown', () => {
  assert.deepEqual(M.tickPlan(undefined, 41743028), { from: 0, to: 41743028, ms: M.TICK_FIRST_MS });
  assert.equal(M.tickPlan(41743028, 41743028), null, 'same figure, nothing to animate');
  const p = M.tickPlan(41743028, 41800000);
  assert.equal(p.from, 41743028);
  assert.equal(p.to, 41800000);
  assert.equal(p.ms, M.TICK_MS);
  assert.ok(M.TICK_MS < M.TICK_FIRST_MS, 'a change is quicker than the first count');
  assert.equal(M.tickPlan(5, NaN), null);
  assert.equal(M.tickPlan(5, null), null);
});

test('core.js ticks from the figure last shown and every hero figure has a key', () => {
  assert.match(core, /function countUp\(el, cents, fmt = money, key = null\)/);
  assert.match(core, /UxModel\.tickPlan\(/);
  for (const [file, key] of [['home.js', "'home:nw'"], ['owed.js', "'owed:net'"], ['budgets.js', 'budgets:flex'], ['taxest.js', 'tax:']]) {
    assert.ok(read(`public/${file}`).includes(key), `${file} keys its figure`);
  }
});

// ---------- tokens ----------

test('the new motion tokens exist and are documented in the reference design system notes', () => {
  for (const t of ['--press', '--press-icon', '--ease-drawer', '--ease-spring', '--dur-out', '--dur-4', '--grabber']) {
    assert.match(css.slice(0, rootEnd), new RegExp(`${t}:`), `${t} in :root`);
    assert.ok(readme.includes(t), `${t} in the reference design system notes`);
  }
});

test('no component rule uses ease-in, transition: all, or a literal press scale', () => {
  assert.ok(!/ease-in(?!-out)/.test(body), 'ease-in starts slow, so the interface feels late');
  assert.ok(!/transition:\s*all\b/.test(body), 'name the properties');
  for (const m of body.matchAll(/([^{}]*:active[^{}]*)\{([^}]*)\}/g)) {
    for (const s of m[2].matchAll(/scale\((var\([^)]*\)|[^)]*)\)/g)) {
      assert.match(s[1], /^var\(--press(-icon)?\)$/, `${m[1].trim()} presses with a token, not ${s[1]}`);
    }
  }
});

test('durations in component rules are tokens (loops are the exception)', () => {
  const bad = [];
  for (const m of body.matchAll(/(transition|animation)(-duration)?:([^;}]*)/g)) {
    if (/infinite|steps\(/.test(m[3])) continue;
    // the first time in a declaration is its duration; a second one is a delay, which may be a literal
    const first = m[3].replace(/var\([^)]*\)/g, 'V').match(/(^|[\s,])(\.?\d*\.?\d+m?s)\b|V/);
    if (first && first[0] !== 'V') bad.push(m[0].slice(0, 90));
  }
  assert.deepEqual(bad, []);
  assert.ok(!/style\.transition = '[^']*(?<![-\w])\.?\d+m?s\b/.test(core), 'no literal transition set from script');
});

// ---------- reduced motion ----------

test('reduced motion drops movement but keeps fades, spinners and skeletons visible', () => {
  assert.ok(!/\.01ms/.test(css), 'a 0.01ms kill freezes the spinner and the skeleton shimmer');
  const reduce = [...css.matchAll(/@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  assert.match(reduce, /\.spin/, 'the spinner still turns, just calmer');
  assert.match(reduce, /\.sk\b/, 'the skeleton pulses instead of sliding');
  assert.match(reduce, /--press:\s*1/, 'no press scale under reduced motion');
});

// ---------- sheets, toasts, palette ----------

test('sheets slide from the bottom on the drawer curve and leave faster than they arrive', () => {
  assert.match(css, /@keyframes sheet-in\{from\{transform:translateY\(100%\)\}/);
  assert.match(css, /#sheet \.panel,#modal \.panel\{[^}]*animation:sheet-in var\(--dur-3\) var\(--ease-drawer\)/);
  assert.match(css, /#sheet\.closing \.panel,#modal\.closing \.panel\{animation:sheet-out var\(--dur-out\) var\(--ease-drawer\) both\}/);
  assert.match(css, /\.grab\{[^}]*background:var\(--grabber\)/);
  assert.ok(!/panel\.style\.transition = 'transform \.38s/.test(core), 'the drag settle uses tokens');
  assert.match(core, /--ease-spring/, 'a released drag settles on the spring');
});

test('a toast leaves by class, on a token, not by an inline style', () => {
  assert.ok(!/t\.style\.opacity = '0'/.test(core));
  assert.match(core, /t\.classList\.add\('leaving'\)/);
  assert.match(css, /\.toast\.leaving\{/);
});

test('the keyboard palette opens with no animation, the tap one keeps it', () => {
  assert.match(search, /function openPalette\(\{ instant = false \} = \{\}\)/);
  assert.match(search, /classList\.toggle\('instant', instant\)/);
  assert.match(keys, /openPalette\(\{ instant: true \}\)/);
  assert.match(css, /#palette\.instant \.panel,#palette\.instant \.scrim\{animation:none\}/);
});

// ---------- the dock ----------

test('the dock has one pill that slides to the active tab on the spring', () => {
  assert.match(app, /nav\.style\.setProperty\('--i'|\$\('#nav'\)\.style\.setProperty\('--i'/);
  assert.match(css, /#nav::before\{[^}]*transition:transform var\(--dur-3\) var\(--ease-spring\)/);
  assert.match(css, /#nav a\.on\{[^}]*background:none/);
});

// ---------- fixes found by the audit ----------

test('the ledger hero lines read as sentences, with a gap between figure and words', () => {
  assert.match(css, /\.owed-hero \.split\{/);
  assert.match(css, /\.owed-hero \.split b\{[^}]*margin-right:var\(--s1\)/);
});

test('the Save screen names its goals once, not twice', () => {
  const save = read('public/save.js');
  assert.ok(!/<h2 id="sv-savings-h">Goals and savings<\/h2>/.test(save));
});

test('decorative loops are gone from empty states', () => {
  assert.ok(!/animation:float /.test(css));
  assert.ok(!/@keyframes float/.test(css));
});

// ---------- reduced motion, ordering and transforms ----------

const reduceStart = css.indexOf('/* Reduced motion means less, not nothing.');
const reduceBlock = css.slice(reduceStart);

test('the reduced-motion block is last in the file, so its @keyframes beat the ones above', () => {
  assert.ok(reduceStart > 0);
  assert.equal(css.slice(reduceStart).match(/@media \(prefers-reduced-motion/g).length, 1, 'nothing else follows it');
  const names = [...reduceBlock.matchAll(/@keyframes ([\w-]+)\{/g)].map((m) => m[1]);
  assert.ok(names.length >= 10);
  for (const n of names) {
    // when two @keyframes share a name the later one wins, media query or not
    const all = [...css.matchAll(new RegExp(`@keyframes ${n}\\{`, 'g'))].map((m) => m.index);
    assert.equal(Math.max(...all), css.indexOf(`@keyframes ${n}{`, reduceStart), `${n} is redefined after the reduced-motion block`);
  }
});

test('reduced motion also stops the transform transitions and the drawn line', () => {
  for (const sel of ['.meter i', '.gr-fg', 'body.selecting #nav', '.swipe-bg button']) assert.ok(reduceBlock.includes(sel), sel);
  assert.match(reduceBlock, /transition-property:opacity,color,background-color,border-color,box-shadow,filter/);
  assert.match(reduceBlock, /\.btn:hover\{transform:none\}/);
  assert.match(reduceBlock, /\.vline\{animation:none;stroke-dashoffset:0\}/);
});

// ---------- the sheet drag ----------

test('letting go of a short pull settles the sheet without replaying its entry animation', () => {
  const drag = core.slice(core.indexOf('// Drag the grab handle'), core.indexOf('const sheetHead'));
  const settle = drag.slice(drag.indexOf('Let go short of the mark'));
  assert.ok(!/animation = ''/.test(settle), 'clearing the inline animation: none restarts sheet-in from off screen');
  assert.match(settle, /transform = ''/);
  assert.match(settle, /--ease-spring/);
});

test('a long pull slides out from the dragged offset, and a fresh open or a plain close starts clean', () => {
  const drag = core.slice(core.indexOf('// Drag the grab handle'), core.indexOf('const sheetHead'));
  assert.match(drag, /translateY\(100%\)/);
  assert.match(drag, /panel\.dataset\.out = '1'/);
  assert.ok(!/panel\.style\.animation = ''/.test(drag));
  const layerSrc = core.slice(core.indexOf('function resetDrag'), core.indexOf('const mainSheet'));
  assert.match(layerSrc, /removeProperty\(p\)/);
  assert.match(layerSrc, /resetDrag\(root\);\n      const panel/, 'open() clears the drag state before showing');
  assert.match(layerSrc, /if \(!\$\('\.panel', root\)\.dataset\.out\) resetDrag\(root\)/, 'close() from rest plays the exit');
  assert.match(drag, /reduceMotion\.matches \? '' : null/, 'reduced motion settles with no transition');
});

// ---------- redesign 3: quiet glass ----------

test('controls are filled, not outlined in green, and selected ones are tinted without an outline', () => {
  assert.match(css, /--ctl-edge:var\(--hair\)/);
  assert.match(css, /--ctl-bg:var\(--panel-2\)/);
  assert.match(css, /\.fchip\.filt\.on,\.fchip\.act,\.fchip\.save,\.fchip\.dd-b\.on\{border-color:transparent\}/);
  assert.match(css, /\.switch\[aria-checked="true"\] \.track\{background:var\(--accent\);border-color:transparent\}/);
});

test('icon tiles are squircles from one token, and cards carry no border', () => {
  assert.match(css, /--r-tile:30%/);
  assert.match(css, /\.row \.ic,\.sk-ic,\.logo-prev \.ic,\.card-ic,\.pal-row \.ic,\.acct-head \.ic,\.ptr-c,\.empty \.art\{border-radius:var\(--r-tile\)\}/);
  assert.match(css, /\.card,\.rows,\.stat,\.health,\.agroup,\.subgrp,\.xcard\{border-color:transparent\}/);
});

test('the segmented control has one sliding thumb for 2 to 5 options', () => {
  assert.match(css, /\.seg::before\{[^}]*transform:translateX\(calc\(var\(--i\) \* \(100% \+ 4px\)\)\)[^}]*var\(--ease-spring\)/);
  for (const n of [3, 4, 5]) assert.ok(css.includes(`.seg:has(>:nth-child(${n})){--n:${n}}`), `${n} options`);
  for (const n of [2, 3, 4, 5]) assert.ok(css.includes(`.seg:has(>:nth-child(${n})[aria-checked="true"]){--i:${n - 1}}`), `index ${n - 1}`);
  assert.match(reduceBlock, /\.seg::before\{transition:none\}/);
});

test('section headings are sentences, the in-card labels stay small capitals', () => {
  assert.match(css, /\nh2,\.sech-t\{[^}]*text-transform:none[^}]*\}/);
  assert.match(css, /\.eyebrow,h2,\.cgroup/, 'the eyebrow rule is still shared by the small labels');
});

test('the redesign tokens are in the reference design system notes', () => {
  for (const t of ['--ctl-bg', '--thumb', '--thumb-solid', '--r-tile']) assert.ok(readme.includes(t), t);
});

test('a Transactions row keeps its hairline: its own bottom-edge border-image, inset like the others', () => {
  assert.match(css, /\.vrow \.row\.tx\{[^}]*border:0;border-bottom:1px solid var\(--line-soft\)/, 'the row still draws a bottom border');
  assert.match(css, /\.vrow \.row\.tx\{border-image:linear-gradient\(90deg,transparent var\(--sep\),var\(--line-soft\) var\(--sep\)\) 0 0 1 0\}/);
});
