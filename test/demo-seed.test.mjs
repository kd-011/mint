// Story invariants for the demo (scripts/demo-seed.mjs over scripts/ui-fixture.mjs). The README
// images are shot from this book, so a stranger should see a household whose money plan works:
// positive net worth that matches the API, a pay split that mostly happened, a price rise alert,
// goals on and off pace, ATO deductions tagged, and no search in the shot list that only finds
// transfer pairs. Starts the real demo once (about ten seconds) and reads it through the API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zoneDate } from '../lib/dates.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

let child; let base;
const api = async (path) => { const r = await fetch(base + path); assert.equal(r.status, 200, `${path} ${r.status}`); return r.json(); };

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(ROOT, 'scripts/demo-seed.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], cwd: ROOT });
  await new Promise((res, rej) => {
    let seen = '';
    child.stdout.on('data', (d) => { seen += d; if (seen.includes('ready: open')) res(); });
    child.on('exit', () => rej(new Error('the demo exited before it was ready')));
    setTimeout(() => rej(new Error('the demo did not come up in 90 s')), 90_000);
  });
}, { timeout: 100_000 });
after(() => { child?.kill('SIGTERM'); });

test('net worth is positive, plausible for a homeowner, and the API adds up', async () => {
  const nw = await api('/api/networth');
  assert.ok(nw.net_worth > 0, `net worth ${nw.net_worth}`);
  assert.equal(nw.net_worth, nw.assets - nw.liabilities);
  const g = nw.groups;
  assert.equal(nw.net_worth, Object.values(g).reduce((s, v) => s + v, 0));
  assert.ok(nw.net_worth > 10_000_000 && nw.net_worth < 100_000_000, 'between $100k and $1m');
  assert.ok(g.loans < 0 && g.investments > 0, 'a home loan, plus property, super and shares');
});

test('salary lands fortnightly on one weekday', async () => {
  const { items } = await api('/api/transactions?q=SALARY&direction=in&limit=100');
  assert.ok(items.length >= 12, `${items.length} salary rows`);
  const days = items.map((t) => new Date(t.date + 'T00:00:00Z'));
  assert.equal(new Set(days.map((d) => d.getUTCDay())).size, 1, 'one weekday');
  for (let i = 1; i < days.length; i++) assert.equal((days[i - 1] - days[i]) / 86400000, 14);
});

test('the current pay split mostly happened: at most one line pending, and every past cycle is done', async () => {
  const s = await api('/api/plan/status');
  assert.ok(s.lines.length >= 3);
  const open = s.lines.filter((l) => l.status !== 'done');
  assert.ok(open.length <= 1, `open lines: ${open.map((l) => `${l.account} ${l.status}`)}`);
  assert.ok(s.lines.filter((l) => l.status === 'done').length >= s.lines.length - 1);
  const past = s.history.filter((h) => h.start !== s.cycle.start);
  assert.ok(past.length >= 3);
  for (const h of past) assert.equal(h.status, 'done', `cycle ${h.start}`);
});

test('there is a subscription price rise alert', async () => {
  const { items } = await api('/api/alerts');
  const rise = items.filter((a) => a.kind === 'subscription' && a.type === 'price_rise');
  assert.ok(rise.length >= 1, items.map((a) => a.title).join(' | '));
});

test('one goal is on pace and one is behind', async () => {
  const { items } = await api('/api/goals');
  assert.ok(items.some((g) => g.on_track === true && !g.done), 'a goal on pace');
  assert.ok(items.some((g) => g.on_track === false), 'a goal behind');
});

test('ATO deductions are tagged in more than one category', async () => {
  const s = await api('/api/tax/summary');
  // the one-off deductions are seeded inside the current financial year whatever today is, so this holds on any date
  assert.ok(s.deductions.count >= 4, `${s.deductions.count} deductions`);
  assert.ok(s.deductions.by_category.length >= 3);
});

test('the shot list never searches for transfers and every search finds real spending', async () => {
  const { shotList } = await import(join(ROOT, 'scripts/shot-list.mjs'));
  const shots = shotList({ today: zoneDate() });
  assert.ok(shots.length >= 5);
  let searched = 0;
  for (const [name, path] of shots) {
    const u = new URL(path, 'http://x');
    assert.ok(!/loan|transfer|repayment/i.test(u.searchParams.get('q') ?? ''), `${name} searches for ${u.searchParams.get('q')}`);
    if (u.pathname !== '/transactions' || ![...u.searchParams.keys()].length) continue;
    searched += 1;
    const r = await api(`/api/transactions${u.search}${u.search ? '&' : '?'}limit=100`);
    const real = r.items.filter((t) => !t.transfer);
    assert.ok(real.length >= 5, `${name}: ${real.length} real rows`);
    assert.ok(real.length === r.items.length, `${name}: transfers in the results`);
    assert.ok(r.items.reduce((s, t) => s - Math.min(0, t.amount), 0) > 20_000, `${name}: Out total under $200`);
  }
  assert.ok(searched >= 1, 'at least one searched shot');
});

test('known records show with the right amount and date in the book', async () => {
  const { items } = await api('/api/transactions?q=SALARY&direction=in&limit=1');
  assert.equal(items[0].amount, 340000);
  const today = zoneDate();
  const days = (Date.parse(today) - Date.parse(items[0].date)) / 86400000;
  assert.ok(days >= 0 && days <= 3, `latest salary ${items[0].date} is ${days} days old`);
  const rep = await api('/api/transactions?q=LOAN%20REPAYMENT&limit=100');
  assert.ok(rep.items.some((t) => t.amount === -115000 && t.transfer), 'fortnightly repayment out of Everyday as a linked transfer');
});

// The same records through the real page, when a browser is around (PLAYWRIGHT_CORE and CHROMIUM, as for scripts/gen-assets.mjs).
const BROWSER = process.env.PLAYWRIGHT_CORE && process.env.CHROMIUM;
test('the UI shows the seeded salary, repayment and net worth with the right amount and date', { skip: !BROWSER && 'no PLAYWRIGHT_CORE and CHROMIUM' }, async () => {
  const pw = await import(process.env.PLAYWRIGHT_CORE);
  const chromium = pw.chromium ?? pw.default.chromium;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })).newPage();
    const sal = (await api('/api/transactions?q=SALARY&direction=in&limit=1')).items[0];
    const [y, m, d] = sal.date.split('-');
    await page.goto(`${base}/transactions?q=SALARY&direction=in`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.vrow .row.tx');
    const first = await page.locator('.vrow .row.tx').first().innerText();
    assert.match(first, /\$3,400\.00/, first);
    const text = await page.locator('#app, main, body').first().innerText();
    assert.ok(text.includes(`${d}/${m}/${y}`) || /Today|Yesterday/.test(text), `date ${sal.date} on the page`);
    await page.goto(`${base}/transactions?q=LOAN%20REPAYMENT`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.vrow .row.tx');
    assert.match(await page.locator('.vrow .row.tx').first().innerText(), /\$1,150\.00/);
    const nw = (await api('/api/networth')).net_worth;
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const dollars = Math.floor(nw / 100).toLocaleString('en-AU');
    assert.ok((await page.locator('body').innerText()).replace(/\s/g, '').includes(`$${dollars}`), `net worth $${dollars} on Home`);
  } finally { await browser.close(); }
});
