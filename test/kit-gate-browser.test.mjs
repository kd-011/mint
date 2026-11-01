// The browser path, not just the server: a real Chromium loads Mint through a proxy that adds Remote-User and
// X-Mint-Gate the way caddy-gate does, lock on, service worker allowed. Every request the page and its worker make
// (shell, module script, kit css and js, the crossorigin font preload, the worker's precache) must come back below 400,
// and the server must log no `refused` line, which is what a request arriving without the gate headers produces.
// Needs a browser Mint does not depend on, so it is skipped unless PLAYWRIGHT_CORE (path to playwright-core's index.mjs)
// and CHROMIUM (path to chrome) are set, the same two variables scripts/ui-shots.mjs reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = 'gate-key-invented-for-tests-0123456789abcdef';
const have = process.env.PLAYWRIGHT_CORE && process.env.CHROMIUM;

test('through a caddy-style gate proxy the page, its worker and the kit load with no refusal', { skip: !have && 'set PLAYWRIGHT_CORE and CHROMIUM to run', timeout: 60000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'mint-kitbrowser-'));
  let out = '';
  const srv = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, MINT_HOME: home, MINT_PORT: '0', MINT_SCHEDULER: 'off', MINT_USER: 'owner', MINT_GATE_KEY: GATE, REDBARK_API_KEY: 'rb-invented-for-tests-0123456789' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const port = await new Promise((resolve, reject) => {
    const t = setInterval(() => { const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) { clearInterval(t); resolve(Number(m[1])); } }, 50);
    setTimeout(() => { clearInterval(t); reject(new Error(`server did not start: ${out}`)); }, 8000);
  });
  const seen = [];
  const proxy = http.createServer((req, res) => {
    const r = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: { ...req.headers, 'remote-user': 'owner', 'x-mint-gate': GATE } }, (u) => { seen.push(`${u.statusCode} ${req.method} ${req.url}`); res.writeHead(u.statusCode, u.headers); u.pipe(res); });
    req.pipe(r);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const pport = proxy.address().port;
  const pw = await import(process.env.PLAYWRIGHT_CORE);
  const chromium = pw.chromium ?? pw.default.chromium;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (let i = 0; i < 2; i++) { // the second load runs under the worker the first one installed
      await page.goto(`http://localhost:${pport}/`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);
    }
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForTimeout(1500);
    assert.deepEqual(errors, []);
    assert.ok(seen.some((s) => s.includes('/kit/kit.css')) && seen.some((s) => s.includes('/kit-boot.js')) && seen.some((s) => s.includes('/kit/fonts/geist-latin.woff2')), `kit requests went through the gate: ${seen.join(', ')}`);
    assert.deepEqual(seen.filter((s) => Number(s.slice(0, 3)) >= 400), [], 'no request was refused');
    assert.doesNotMatch(out, /refused /, 'the server logged no gate refusal');
  } finally {
    await browser.close();
    proxy.close();
    srv.kill('SIGTERM');
  }
});
