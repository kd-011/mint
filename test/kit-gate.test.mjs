// The kit pass must not add a request the gate path cannot serve. Caddy puts Remote-User and X-Mint-Gate on every
// request it proxies, the page's own requests (shell, scripts, module scripts, the kit css, js, icons and fonts)
// all carry them, and every one has to come back 200 with its real type, lock on or off, no redirect and nothing
// that would land in the service worker's cache as the app shell by mistake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = 'gate-key-invented-for-tests-0123456789abcdef';
const ok = { 'Remote-User': 'owner', 'X-Mint-Gate': GATE };
let proc, base;

before(async () => {
  const home = mkdtempSync(join(tmpdir(), 'mint-kitgate-'));
  const s = await new Promise((resolve, reject) => {
    // The lock is left ON: the shell and the kit are not under /api, so a locked Mint still has to serve them.
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, MINT_HOME: home, MINT_PORT: '0', MINT_SCHEDULER: 'off', MINT_USER: 'owner', MINT_GATE_KEY: GATE, REDBARK_API_KEY: 'rb-invented-for-tests-0123456789' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) resolve({ p, url: `http://127.0.0.1:${m[1]}` }); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', () => reject(new Error(out)));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
  proc = s.p; base = s.url;
});
after(() => proc?.kill('SIGTERM'));

const get = (path, headers = ok) => fetch(base + path, { headers, redirect: 'manual' });

test('the shell, the kit and every url the shell names load through the gate path with the right type', async () => {
  const html = await (await get('/')).text();
  const urls = [...html.matchAll(/(?:href|src)="(\/[^"#]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('/api/'));
  assert.ok(urls.some((u) => u.startsWith('/kit/kit.css')), 'the page links the kit css');
  assert.ok(urls.some((u) => u.startsWith('/kit-boot.js')), 'and the module that loads kit.js');
  const kit = ['/kit/kit.js', '/kit/icons.svg', '/kit/fonts/geist-latin.woff2', '/kit/fonts/geist-mono-latin.woff2'];
  for (const u of new Set([...urls, ...kit])) {
    const r = await get(u);
    assert.equal(r.status, 200, `${u} -> ${r.status}`);
    assert.ok(!r.headers.get('location'), `${u} redirects`);
    const type = r.headers.get('content-type') ?? '';
    const want = /\.css/.test(u) ? 'text/css' : /\.m?js/.test(u) ? 'text/javascript' : /\.woff2/.test(u) ? 'font/woff2' : /\.svg/.test(u) ? 'image/svg' : /\.png/.test(u) ? 'image/png' : /\.webmanifest/.test(u) ? 'manifest' : u === '/' ? 'text/html' : '';
    assert.ok(type.includes(want), `${u} is ${type}`);
  }
});

test('the module import inside kit-boot.js and every worker precache url resolve', async () => {
  const boot = await (await get('/kit-boot.js')).text();
  const imp = /from '(\/kit\/kit\.js[^']*)'/.exec(boot)?.[1];
  assert.ok(imp && !imp.includes('__V__'), `import was ${imp}: the version placeholder must be replaced`);
  assert.equal((await get(imp)).status, 200);
  const sw = await (await get('/sw.js', {})).text();
  assert.doesNotMatch(sw, /__[A-Z_]+__/, 'no unreplaced placeholder in the worker');
  const shell = /const SHELL = \[(.*)\];/.exec(sw)[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
  assert.ok(shell.some((u) => u.startsWith('/kit/kit.css')) && shell.includes('/kit/icons.svg'));
  for (const u of shell) assert.equal((await get(u)).status, 200, `precache ${u}`);
});

test('without the gate headers the shell is refused, and a refusal is not an app shell the worker could keep', async () => {
  for (const headers of [{}, { 'Remote-User': 'owner' }]) {
    const r = await get('/', headers);
    assert.equal(r.status, 401);
    assert.ok(!(r.headers.get('content-type') ?? '').includes('html') || !(await r.clone().text()).includes('id="shell"'));
  }
  const sw = readFileSync(join(ROOT, 'public/sw.js'), 'utf8');
  assert.match(sw, /if \(res\.ok && !res\.redirected && res\.type === 'basic'\)/, 'only a real 200 is cached as the shell');
  assert.match(sw, /c\.addAll\(SHELL\)/, 'addAll rejects the whole install on any non-2xx');
});

test('the kit asset names the shell uses are all served by an open-by-design path or the gate, never a third place', () => {
  const src = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const open = /const OPEN = new Set\(\[([^\]]*)\]/.exec(src)[1];
  assert.doesNotMatch(open, /kit/, 'the kit rides the gate like the rest of the shell');
});
