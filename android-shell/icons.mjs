// Rasterise Mint's mark (public/icon.svg in the repo root) into the Android
// launcher icons (legacy, round, adaptive foreground/background, themed
// monochrome) and the splash icons. Dev-only, run when the mark changes:
// needs Playwright: set PLAYWRIGHT_DIR to its install directory, or install it
// where Node can resolve `playwright`.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const res = join(import.meta.dirname, 'android', 'app', 'src', 'main', 'res');

const BG = '#0b0d0c';
const LEAF = 'M256 92c-92 64-132 142-118 218 10 54 52 94 118 110 66-16 108-56 118-110 14-76-26-154-118-218z';
const MARK = `<path d="${LEAF}" fill="#3ddc97"/>
  <path d="M256 150v262" stroke="${BG}" stroke-width="18" stroke-linecap="round" fill="none"/>
  <path d="M256 250l-62-48M256 318l70-56" stroke="${BG}" stroke-width="16" stroke-linecap="round" fill="none"/>`;
const MONO = `<mask id="m"><rect x="-200" y="-200" width="1000" height="1000" fill="#fff"/>
    <path d="M256 150v262M256 250l-62-48M256 318l70-56" stroke="#000" stroke-width="18" stroke-linecap="round" fill="none"/></mask>
  <path d="${LEAF}" fill="#fff" mask="url(#m)"/>`;
// The leaf reaches 164 units from the centre (256, 256). A viewBox of side
// 600 puts that at 27% of the canvas (a 54% tall mark), inside the 36 dp
// circle every launcher mask shows; 590 fits the Android 12 splash icon's
// 192 dp circle on its 288 dp canvas.
const box = (s) => `${256 - s / 2} ${256 - s / 2} ${s} ${s}`;
const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;

const full = svg('0 0 512 512', `<rect width="512" height="512" rx="112" fill="${BG}"/>${MARK}`);
const round = svg('0 0 512 512', `<circle cx="256" cy="256" r="256" fill="${BG}"/>${MARK}`);
const fg = svg(box(600), MARK);
const bgLayer = svg(box(600), `<rect x="-400" y="-400" width="1400" height="1400" fill="${BG}"/>`);
const mono = svg(box(600), MONO);
const splashIcon = svg(box(590), MARK);

const D = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const jobs = [];
for (const [d, k] of Object.entries(D)) {
  jobs.push([full, `mipmap-${d}/ic_launcher.png`, 48 * k, 48 * k]);
  jobs.push([round, `mipmap-${d}/ic_launcher_round.png`, 48 * k, 48 * k]);
  jobs.push([fg, `mipmap-${d}/ic_launcher_foreground.png`, 108 * k, 108 * k]);
  jobs.push([bgLayer, `mipmap-${d}/ic_launcher_background.png`, 108 * k, 108 * k]);
  jobs.push([mono, `mipmap-${d}/ic_launcher_monochrome.png`, 108 * k, 108 * k]);
  jobs.push([splashIcon, `drawable-${d}/splash_icon.png`, 288 * k, 288 * k]);
}
// Pre-Android-12 splash: the app icon in the middle of the background colour.
const SPLASH = { 'port-mdpi': [320, 480], 'port-hdpi': [480, 800], 'port-xhdpi': [720, 1280], 'port-xxhdpi': [960, 1600], 'port-xxxhdpi': [1280, 1920], 'land-mdpi': [480, 320], 'land-hdpi': [800, 480], 'land-xhdpi': [1280, 720], 'land-xxhdpi': [1600, 960], 'land-xxxhdpi': [1920, 1280] };
const splash = (w, h) => { const s = Math.min(w, h) * 0.32; return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${BG}"/><svg x="${(w - s) / 2}" y="${(h - s) / 2}" width="${s}" height="${s}" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="${BG}"/>${MARK}</svg></svg>`; };
for (const [d, [w, h]] of Object.entries(SPLASH)) jobs.push([splash(w, h), `drawable-${d}/splash.png`, w, h]);
jobs.push([splash(480, 320), 'drawable/splash.png', 480, 320]);

const b = await chromium.launch();
const p = await b.newPage();
for (const [src, out, w, h] of jobs) {
  mkdirSync(join(res, out, '..'), { recursive: true });
  await p.setViewportSize({ width: Math.round(w), height: Math.round(h) });
  await p.setContent(`<html><body style="margin:0;background:transparent">${src.replace('<svg ', `<svg width="${Math.round(w)}" height="${Math.round(h)}" `)}</body></html>`);
  await p.screenshot({ path: join(res, out), omitBackground: true });
}
await b.close();
console.log(`${jobs.length} icons written`);
