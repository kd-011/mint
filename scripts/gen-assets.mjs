// Regenerates the README media from the demo's invented data: screenshots, hero, banner,
// social preview and the animated demo. Nothing here touches a real book: it starts its own
// throwaway demo (scripts/demo-seed.mjs) on a free port and stops it when done.
//
//   node scripts/gen-assets.mjs [shots] [hero] [banner] [social] [demo]     (no argument: all of them)
//
// Needs, outside the repo (Mint itself has no dependencies and no build step):
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.js
//   CHROMIUM=/path/to/chrome
//   ffmpeg and ImageMagick `convert` on PATH (only for the GIF and the PNG squeeze)
// Output goes to docs/ (banner.png, hero.png, social-preview.png, demo.gif) and docs/screenshots/.
// Open every image by eye before committing: the demo is invented, but a script cannot tell.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zoneDate } from '../lib/dates.mjs';
import { shotList, DESKTOP_SHOTS } from './shot-list.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const SHOTS = join(DOCS, 'screenshots');
const FONTS = pathToFileURL(join(ROOT, 'public/kit/fonts/geist-latin.woff2')).href;
// the app icon without its dark tile, so the leaf sits straight on the page
const ICON = readFileSync(join(ROOT, 'public/icon.svg'), 'utf8').replace(/<rect [^>]*\/>/, '');
const WANT = process.argv.slice(2);
const want = (n) => !WANT.length || WANT.includes(n);

const pw = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const chromium = pw.chromium ?? pw.default.chromium;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// ---- the demo -------------------------------------------------------------------------------
async function startDemo() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, 'scripts/demo-seed.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], cwd: ROOT });
  const ready = new Promise((res, rej) => {
    let seen = '';
    child.stdout.on('data', (d) => { seen += d; if (seen.includes('ready: open')) res(); });
    child.on('exit', () => rej(new Error('the demo exited before it was ready')));
    setTimeout(() => rej(new Error('the demo did not come up in 60 s')), 60_000);
  });
  try { await ready; } catch (e) { child.kill('SIGTERM'); throw e; }
  return { base: `http://127.0.0.1:${port}`, stop: () => child.kill('SIGTERM') };
}

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' };
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' };
const squeeze = (file) => { try { execFileSync('convert', [file, '-strip', '-define', 'png:compression-level=9', file]); } catch { /* convert is optional */ } };

// ---- screenshots ----------------------------------------------------------------------------
// The screens live in scripts/shot-list.mjs; test/demo-seed.test.mjs checks that every search in it finds real spending.
const SCREENS = shotList({ today: zoneDate() });
async function shots(browser, base) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [prefix, ctxOpts, names] of [['m', PHONE, SCREENS.map((s) => s[0])], ['d', DESK, DESKTOP_SHOTS]]) {
    const ctx = await browser.newContext(ctxOpts);
    for (const [name, path] of SCREENS.filter((s) => names.includes(s[0]))) {
      const p = await ctx.newPage();
      await p.goto(base + path, { waitUntil: 'networkidle' });
      await p.waitForTimeout(1400);
      const out = join(SHOTS, `${prefix}-${name}.png`);
      await p.screenshot({ path: out });
      squeeze(out);
      await p.close();
    }
    await ctx.close();
  }
}

// ---- HTML pages for the banner, hero and social card ---------------------------------------------
const MINT = '#3ddc97';
const HEAD = `<meta charset="utf-8"><style>
@font-face{font-family:Geist;src:url("${FONTS}");font-weight:100 900}
*{box-sizing:border-box;margin:0}
body{font-family:Geist,system-ui,sans-serif;color:#f3f7f5;background:#0b0d0c;-webkit-font-smoothing:antialiased}
.glow{position:absolute;inset:0;background:radial-gradient(60% 90% at 78% 40%,rgba(61,220,151,.20),transparent 70%),radial-gradient(40% 60% at 8% 100%,rgba(61,220,151,.09),transparent 70%)}
.logo{width:var(--s);height:var(--s);display:block}
.phone{position:absolute;border-radius:38px;border:3px solid #2b322f;overflow:hidden;background:#0b0d0c;box-shadow:0 40px 90px rgba(0,0,0,.65),0 0 0 1px rgba(255,255,255,.05)}
.phone img{display:block;width:100%}
.win{position:absolute;border-radius:16px;overflow:hidden;border:1px solid #2b322f;box-shadow:0 40px 90px rgba(0,0,0,.65)}
.win img{display:block;width:100%}
.dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:${MINT};margin:0 14px;vertical-align:middle;opacity:.8}
</style>`;
const logo = (s) => `<div class="logo" style="--s:${s}px">${ICON.replace('<svg ', '<svg width="100%" height="100%" ')}</div>`;
const shot = (n) => pathToFileURL(join(SHOTS, n)).href;

const BANNER = `<html><head>${HEAD}</head><body style="width:1280px;height:320px;position:relative;overflow:hidden">
<div class="glow"></div>
<div style="position:absolute;left:96px;top:0;bottom:0;display:flex;align-items:center;gap:36px">
  ${logo(132)}
  <div><div style="font-size:112px;font-weight:700;letter-spacing:-.045em;line-height:1">Mint</div>
  <div style="font-size:27px;color:#a3b3ac;margin-top:12px;letter-spacing:-.005em">Self-hosted personal finance for Australians</div></div>
</div></body></html>`;

const SOCIAL = `<html><head>${HEAD}</head><body style="width:1280px;height:640px;position:relative;overflow:hidden">
<div class="glow"></div>
<div style="position:absolute;left:80px;top:96px;width:640px">
  <div style="display:flex;align-items:center;gap:20px">${logo(72)}<div style="font-size:64px;font-weight:700;letter-spacing:-.04em">Mint</div></div>
  <div style="font-size:60px;font-weight:700;letter-spacing:-.035em;line-height:1.06;margin-top:48px">Self-hosted money for Australians.</div>
  <div style="font-size:27px;color:#a3b3ac;line-height:1.5;margin-top:28px">Pay-cycle budgets, CDR bank feeds and ATO tax tags in one SQLite file you own.</div>
  <div style="font-size:22px;color:${MINT};margin-top:40px;letter-spacing:.01em">Zero dependencies<span class="dot"></span>AGPL-3.0<span class="dot"></span>Node 22</div>
</div>
<div class="phone" style="left:790px;top:70px;width:230px;transform:rotate(-4deg)"><img src="${shot('m-home.png')}"></div>
<div class="phone" style="left:1030px;top:150px;width:230px;transform:rotate(3deg)"><img src="${shot('m-plan.png')}"></div>
</body></html>`;

const HERO = `<html><head>${HEAD}</head><body style="width:1600px;height:900px;position:relative;overflow:hidden">
<div class="glow"></div>
<div class="win" style="left:430px;top:90px;width:1080px"><img src="${shot('d-groceries.png')}"></div>
<div class="phone" style="left:70px;top:90px;width:300px;transform:rotate(-3deg)"><img src="${shot('m-home.png')}"></div>
<div class="phone" style="left:300px;top:250px;width:300px;transform:rotate(2deg)"><img src="${shot('m-plan.png')}"></div>
</body></html>`;

async function render(browser, html, { width, height, out, scale = 1 }) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-asset-'));
  const file = join(dir, 'page.html');
  writeFileSync(file, html);
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  const p = await ctx.newPage();
  await p.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  await p.screenshot({ path: out });
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
  squeeze(out);
}

// ---- the animated demo ----------------------------------------------------------------------------
// One phone, one real flow: net worth, a search that finds a month of groceries with its total, the
// pay split plan, a goal. Recorded by Playwright, then cut and palette-squeezed into a GIF.
async function demoGif(browser, base) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-rec-'));
  const ctx = await browser.newContext({ ...PHONE, deviceScaleFactor: 1, recordVideo: { dir, size: { width: 390, height: 844 } } });
  const p = await ctx.newPage();
  const tab = (id) => p.locator(`a[data-tab="${id}"]`);
  await p.goto(base + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2200); // home: net worth
  await p.mouse.move(195, 500);
  for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, 150); await p.waitForTimeout(420); } // loan, shares
  await p.waitForTimeout(900);
  await tab('spending').click();
  await p.waitForTimeout(1500);
  await p.locator('#q').click();
  await p.keyboard.type('woolworths', { delay: 200 });
  await p.waitForTimeout(2600); // the rows and the Out total
  await tab('more').click();
  await p.waitForTimeout(1000);
  await p.locator('a[href="/plan"]').first().click();
  await p.waitForTimeout(2600); // pay split
  await tab('save').click();
  await p.waitForTimeout(1600);
  await p.getByText('House deposit').first().click();
  await p.waitForTimeout(2600); // a goal
  await ctx.close(); // flushes the video
  const webm = join(dir, readdirSync(dir).find((f) => f.endsWith('.webm')));
  const out = join(DOCS, 'demo.gif');
  const pal = join(dir, 'pal.png');
  const vf = 'fps=10,scale=270:-1:flags=lanczos';
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '0.6', '-i', webm, '-vf', `${vf},palettegen=max_colors=96:stats_mode=diff`, pal]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '0.6', '-i', webm, '-i', pal, '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, out]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`demo.gif ${(statSync(out).size / 1024).toFixed(0)} KB`);
}

// ---- main -----------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
const demo = await startDemo();
try {
  if (want('shots') || want('hero') || want('social')) await shots(browser, demo.base);
  if (want('banner')) await render(browser, BANNER, { width: 1280, height: 320, scale: 2, out: join(DOCS, 'banner.png') });
  if (want('hero')) await render(browser, HERO, { width: 1600, height: 900, out: join(DOCS, 'hero.png') });
  if (want('social')) await render(browser, SOCIAL, { width: 1280, height: 640, out: join(DOCS, 'social-preview.png') });
  if (want('demo')) await demoGif(browser, demo.base);
} finally {
  await browser.close();
  demo.stop();
}
for (const f of ['banner.png', 'hero.png', 'social-preview.png', 'demo.gif']) { try { console.log(f, `${(statSync(join(DOCS, f)).size / 1024).toFixed(0)} KB`); } catch { /* not generated this run */ } }
