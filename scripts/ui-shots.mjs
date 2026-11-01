// Shoots every Mint screen at 390x844 and 1440x900 against the fixture server (start it with: node scripts/ui-fixture.mjs 8991 --browse).
//   node scripts/ui-shots.mjs <out-dir> [--base http://127.0.0.1:8991] [--empty-base http://127.0.0.1:8992] [--only name,name]
// Needs playwright-core (PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.js) and a Chromium
// (CHROMIUM=/path/to/chrome). Mint itself stays zero-dependency, so neither is in package.json.
// It also reports horizontal scroll, touch targets under 44px and clipped text per screen.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = args[0] && !args[0].startsWith('--') ? args[0] : 'shots';
const BASE = flag('--base', 'http://127.0.0.1:8991');
const EMPTY = flag('--empty-base', 'http://127.0.0.1:8992');
const ONLY = flag('--only', '').split(',').filter(Boolean);
const pw = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const chromium = pw.chromium ?? pw.default.chromium;
mkdirSync(OUT, { recursive: true });

const SIZES = { m: { width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true }, d: { width: 1440, height: 900, deviceScaleFactor: 1 } };
const settle = (p, ms = 900) => p.waitForTimeout(ms);
const SCREENS = [
  ['home', '/'],
  ['transactions', '/transactions'],
  ['budgets', '/budgets'],
  ['reports', '/reports'],
  ['income', '/income'],
  ['save', '/save'],
  ['plan', '/plan'],
  ['plan-goals', '/plan?s=goals'],
  ['goal-sheet', '/save', { act: async (p) => { await p.locator('[data-goal]:not(.btn):not(.ibtn), .gcard').first().click({ position: { x: 20, y: 20 } }).catch(() => {}); await settle(p, 700); } }],
  ['assets', '/accounts?s=assets'],
  ['accounts', '/accounts'],
  ['rules', '/accounts?s=rules'],
  ['owed', '/owed'],
  ['subs', '/plan?s=subs'],
  ['tax', '/tax'],
  ['account', '/account?id=acct_test_everyday'],
  ['more', '/more'],
  ['settings', '/settings'],
  ['empty-home', '/', { empty: true }],
  ['empty-transactions', '/transactions', { empty: true }],
  ['empty-budgets', '/budgets', { empty: true }],
  ['empty-save', '/save', { empty: true }],
  ['notfound', '/nope'],
  ['sheet-tx', '/transactions', { act: async (p) => { await p.locator('.vrow .row.tx').first().click(); await settle(p, 700); } }],
  ['palette', '/more', { act: async (p) => { await p.locator('[data-act="search"]').click(); await settle(p, 700); } }],
  ['chat', '/', { act: async (p) => { await p.evaluate(() => chatUi.open()); await settle(p, 800); } }],
  ['filter', '/transactions', { act: async (p) => { await p.locator('.fchip.dd-b').first().click(); await settle(p, 500); } }],
  ['lock', '/', { act: async (p) => { await p.evaluate(() => { const l = document.getElementById('lock'); l.hidden = false; l.classList.remove('lock-out', 'lock-done'); l.dataset.state = 'locked'; document.getElementById('lock-go').hidden = false; document.getElementById('lock-line').textContent = 'Locked. Use your fingerprint to open Mint.'; }); await settle(p, 800); } }],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const report = [];
for (const [size, vp] of Object.entries(SIZES)) {
  const ctxs = {};
  for (const [name, path, opt = {}] of SCREENS) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const base = opt.empty ? EMPTY : BASE;
    const key = opt.empty ? 'e' : 'f';
    const ctx = ctxs[key] ||= await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, hasTouch: !!vp.hasTouch, isMobile: !!vp.isMobile, extraHTTPHeaders: { 'Remote-User': 'owner' }, serviceWorkers: 'block' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => report.push(`${size}-${name}: pageerror ${e.message}`));
    await p.goto(base + path, { waitUntil: 'networkidle' });
    await settle(p, 1400);
    if (opt.act) await opt.act(p);
    const probe = await p.evaluate(() => {
      const de = document.documentElement;
      const small = [...document.querySelectorAll('a,button,input:not([type=hidden]),select,textarea,[role=button],[role=switch]')].filter((e) => {
        const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none' && (r.width < 43.5 || r.height < 43.5) && !e.closest('[hidden]') && !e.closest('.skip') && r.bottom > 0 && r.top < innerHeight;
      }).map((e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
      const clipped = [...document.querySelectorAll('h1,h2,h3,.t1,.t2,.btn,.chip,.stab,.seg button,.fchip,.pill,.big,.big2')].filter((e) => {
        const cs = getComputedStyle(e); return e.scrollWidth > e.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.overflow !== 'visible' && e.clientWidth > 0;
      }).map((e) => `${e.className} ${e.textContent.trim().slice(0, 30)}`);
      return { hscroll: de.scrollWidth > de.clientWidth + 1, small: [...new Set(small)].slice(0, 12), clipped: clipped.slice(0, 6) };
    });
    if (probe.hscroll || probe.small.length || probe.clipped.length) report.push(`${size}-${name}: ${JSON.stringify(probe)}`);
    await p.screenshot({ path: join(OUT, `${size}-${name}.png`) });
    await p.close();
  }
  for (const c of Object.values(ctxs)) await c.close();
}
await browser.close();
console.log(report.join('\n') || 'no hscroll, small targets or clipped text found');
