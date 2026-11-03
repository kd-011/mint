// Accountant year-end pack: one zip per financial year with a summary, the
// deductions and business CSVs, receipts grouped by ATO category and a manifest
// of deductions with no receipt. Invented data only; read back with system unzip.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream, mkdtempSync, readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { book } from './fixtures/book.mjs';
import { setTaxTag, saveReceipt, fyCsv } from '../lib/tax.mjs';
import { applyRules } from '../lib/categorise.mjs';
import { matchTransfers } from '../lib/transfers.mjs';
import { buildPack } from '../lib/pack.mjs';
import { createApi } from '../lib/api.mjs';
import { HttpError } from '../lib/errors.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('invented receipt'), Buffer.alloc(64)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('invented receipt two'), Buffer.alloc(64)]);
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

async function pack(b, fy, dir, extra = {}) {
  const file = join(dir, `pack-${fy}.zip`);
  const out = createWriteStream(file);
  const stats = await buildPack({ db: b.db, fy, receiptsDir: join(dir, 'receipts'), out, ...extra });
  out.end();
  await once(out, 'close');
  const x = join(dir, `x-${fy}-${Math.random().toString(36).slice(2)}`);
  execFileSync('unzip', ['-q', file, '-d', x]);
  return { file, x, stats };
}
const walk = (d, base = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), base) : [join(d, e.name).slice(base.length + 1)])).sort();

function fyBook(dir) {
  const b = book();
  const rdir = join(dir, 'receipts');
  const d5 = b.add('acct_t_card', '2025-08-01', -12000, 'TEST OFFICE SUPPLIES');
  const d4 = b.add('acct_t_everyday', '2026-06-30', -50000, '=TEST COURSE FEES');
  const noRcpt = b.add('acct_t_card', '2025-11-11', -3300, '+TEST PARKING');
  const outside = b.add('acct_t_card', '2026-07-01', -8000, 'TEST NEXT YEAR');
  b.add('acct_t_biz', '2025-09-01', 300000, 'TEST CLIENT PAYMENT', { provider_category: 'INCOME' });
  b.add('acct_t_biz', '2025-09-02', -4500, '@TEST HOSTING');
  b.add('acct_t_everyday', '2025-10-01', 250000, 'ACME SALARY/WAGES', { provider_category: 'SALARY' });
  applyRules(b.db);
  matchTransfers(b.db);
  setTaxTag(b.db, d5, { ato_category: 'D5' });
  setTaxTag(b.db, d4, { ato_category: 'D4', deductible_amount: 25000 });
  setTaxTag(b.db, noRcpt, { ato_category: 'D2' });
  setTaxTag(b.db, outside, { ato_category: 'D5' });
  saveReceipt({ db: b.db, dir: rdir, transactionId: d5, buf: PNG, declaredType: 'image/png' });
  saveReceipt({ db: b.db, dir: rdir, transactionId: d5, buf: PDF, declaredType: 'application/pdf' });
  saveReceipt({ db: b.db, dir: rdir, transactionId: d4, buf: PDF, declaredType: 'application/pdf' });
  saveReceipt({ db: b.db, dir: rdir, transactionId: outside, buf: PNG, declaredType: 'image/png' });
  return { b, d5, d4, noRcpt, rdir };
}

test('pack zip passes unzip -t and holds summary, both CSVs, receipts and manifest', async () => {
  const dir = tmp('mint-pack-');
  const { b } = fyBook(dir);
  const { file, x, stats } = await pack(b, 2026, dir);
  assert.match(execFileSync('unzip', ['-t', file]).toString(), /No errors detected/);
  const files = walk(x);
  assert.ok(files.includes('summary.html'));
  assert.ok(files.includes('deductions.csv'));
  assert.ok(files.includes('business.csv'));
  assert.ok(files.includes('manifest.txt'));
  const rc = files.filter((f) => f.startsWith('receipts/'));
  assert.equal(rc.length, 3); // the other FY's receipt is not in this pack
  assert.equal(stats.receipts, 3);
  assert.equal(stats.missing, 1);
});

test('receipts sit in one folder per ATO category, named date_merchant_amount, mode untouched', async () => {
  const dir = tmp('mint-pack-');
  const { b, rdir } = fyBook(dir);
  const { x } = await pack(b, 2026, dir);
  const rc = walk(join(x, 'receipts'));
  assert.equal(rc.length, 3);
  for (const f of rc) assert.match(f, /^D\d+ [^/]+\/\d{4}-\d{2}-\d{2}_[a-z0-9-]+_\d+\.\d{2}(-\d)?\.(png|pdf)$/, f);
  assert.ok(rc.some((f) => f.startsWith('D5 ') && f.includes('2025-08-01_test-office-supplies_120.00')));
  assert.ok(rc.some((f) => f.startsWith('D4 ') && f.includes('2026-06-30_') && f.includes('_500.00')));
  // two receipts on one transaction never collide
  assert.equal(new Set(rc).size, 3);
  // the originals on disk stay mode 600
  for (const f of readdirSync(rdir)) assert.equal(statSync(join(rdir, f)).mode & 0o777, 0o600);
  // the receipt bytes are the originals
  const pdf = rc.find((f) => f.startsWith('D4 '));
  assert.ok(readFileSync(join(x, 'receipts', pdf)).equals(PDF));
});

test('CSVs keep formula neutralisation and match the existing export rows', async () => {
  const dir = tmp('mint-pack-');
  const { b } = fyBook(dir);
  const { x } = await pack(b, 2026, dir);
  const ded = readFileSync(join(x, 'deductions.csv'), 'utf8');
  const biz = readFileSync(join(x, 'business.csv'), 'utf8');
  assert.match(ded, /'=TEST COURSE FEES/);
  assert.match(ded, /'\+TEST PARKING/);
  assert.doesNotMatch(ded, /(^|,)[=+@]TEST/m);
  assert.match(biz, /'@TEST HOSTING/);
  assert.doesNotMatch(biz, /(^|,)@TEST/m);
  assert.match(biz, /TEST CLIENT PAYMENT/);
  assert.doesNotMatch(biz, /COURSE FEES/); // personal deductions are not business rows
  assert.doesNotMatch(ded, /NEXT YEAR/);
  assert.doesNotMatch(ded, /CLIENT PAYMENT/);
  // the combined export is unchanged
  const all = fyCsv(b.db, 2026);
  assert.match(all, /COURSE FEES/);
  assert.match(all, /CLIENT PAYMENT/);
});

test('summary lists income by source, deductions by ATO category, business, and the not-advice line', async () => {
  const dir = tmp('mint-pack-');
  const { b } = fyBook(dir);
  const { x } = await pack(b, 2026, dir);
  const html = readFileSync(join(x, 'summary.html'), 'utf8');
  assert.match(html, /FY 2025-26/);
  assert.match(html, /Income by source/);
  assert.match(html, /Salary|ACME/i);
  assert.match(html, /Work-related self-education expenses/);
  assert.match(html, /\$250\.00/); // D4 partial deductible
  assert.match(html, /Business income/);
  assert.match(html, /\$3,000\.00/);
  assert.match(html, /not tax advice/i);
  assert.doesNotMatch(html, /GST|BAS/);
  // user text is escaped
  assert.doesNotMatch(html, /<script/i);
});

test('an estimate, when supplied, is printed with the estimate-not-advice line', async () => {
  const dir = tmp('mint-pack-');
  const { b } = fyBook(dir);
  const plain = await pack(b, 2026, dir);
  assert.doesNotMatch(readFileSync(join(plain.x, 'summary.html'), 'utf8'), /Tax return estimate/);
  const est = { title: 'Tax return estimate', lines: [{ label: 'Taxable income', amount: 6500000 }, { label: 'Estimated refund', amount: 123456 }] };
  const { x } = await pack(b, 2026, dir, { estimate: est });
  const html = readFileSync(join(x, 'summary.html'), 'utf8');
  assert.match(html, /Tax return estimate/);
  assert.match(html, /\$65,000\.00/);
  assert.match(html, /\$1,234\.56/);
  assert.match(html, /estimate, not tax advice/i);
});

test('manifest lists deductions with no receipt and nothing else as missing', async () => {
  const dir = tmp('mint-pack-');
  const { b } = fyBook(dir);
  const { x } = await pack(b, 2026, dir);
  const m = readFileSync(join(x, 'manifest.txt'), 'utf8');
  assert.match(m, /FY 2025-26/);
  assert.match(m, /No receipt attached \(1\)/);
  assert.match(m, /11\/11\/2025/);
  assert.match(m, /\+TEST PARKING/);
  assert.match(m, /\$33\.00/);
  assert.match(m, /D2/);
  const missing = m.split('No receipt attached')[1];
  assert.doesNotMatch(missing, /OFFICE SUPPLIES|COURSE FEES/);
  assert.match(m, /receipts\/D5 /); // the files that are in the pack
});

test('a receipt row whose file is gone is reported, not fatal', async () => {
  const dir = tmp('mint-pack-');
  const { b, rdir } = fyBook(dir);
  const row = b.db.prepare("SELECT file FROM receipts r JOIN transactions t ON t.id = r.transaction_id WHERE t.date = '2026-06-30'").get();
  execFileSync('rm', [join(rdir, row.file)]);
  const { x, stats } = await pack(b, 2026, dir);
  assert.equal(stats.receipts, 2);
  const m = readFileSync(join(x, 'manifest.txt'), 'utf8');
  assert.match(m, /file missing on disk/i);
  assert.match(m, /COURSE FEES/);
});

test('empty FY still gives a valid zip with zeroes and header-only CSVs', async () => {
  const dir = tmp('mint-pack-');
  const b = book();
  const { file, x, stats } = await pack(b, 2024, dir);
  assert.match(execFileSync('unzip', ['-t', file]).toString(), /No errors detected/);
  assert.deepEqual(walk(x), ['business.csv', 'deductions.csv', 'manifest.txt', 'summary.html']);
  assert.equal(readFileSync(join(x, 'deductions.csv'), 'utf8').trim().split(/\r?\n/).length, 1);
  assert.equal(readFileSync(join(x, 'business.csv'), 'utf8').trim().split(/\r?\n/).length, 1);
  assert.match(readFileSync(join(x, 'summary.html'), 'utf8'), /Nothing recorded/i);
  assert.match(readFileSync(join(x, 'manifest.txt'), 'utf8'), /No receipt attached \(0\)/);
  assert.equal(stats.receipts, 0);
});

test('a bad fy is a 400', async () => {
  const dir = tmp('mint-pack-');
  const out = createWriteStream(join(dir, 'x.zip'));
  await assert.rejects(() => buildPack({ db: book().db, fy: 1999, receiptsDir: dir, out }), (e) => e.status === 400);
  out.destroy();
});

test('too many receipt bytes is refused with a clear message', async () => {
  const dir = tmp('mint-pack-');
  const { b } = fyBook(dir);
  const out = createWriteStream(join(dir, 'x.zip'));
  await assert.rejects(() => buildPack({ db: b.db, fy: 2026, receiptsDir: join(dir, 'receipts'), out, maxReceiptBytes: 50 }), (e) => e.status === 413 && /too large/i.test(e.message));
  out.destroy();
});

// the route
let srv, base, apiDir, rb;
before(async () => {
  apiDir = tmp('mint-packapi-');
  rb = fyBook(apiDir).b;
  mkdirSync(join(apiDir, 'receipts'), { recursive: true });
  const api = createApi({ db: rb.db, engine: { refresh() {}, runAi() {} }, ai: null, dataDir: apiDir, log() {} });
  srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!(await api(req, res, url))) { res.writeHead(404); res.end('{}'); }
    } catch (e) {
      res.writeHead(e instanceof HttpError ? e.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv?.close());

const packTemps = () => readdirSync(tmpdir()).filter((n) => n.startsWith('mint-pack-tmp-'));

test('GET /api/tax/pack streams a zip with a length, then removes its temp file', async () => {
  const before = packTemps();
  const r = await fetch(`${base}/api/tax/pack?fy=2026`);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="mint-fy2026-accountant-pack\.zip"/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(Number(r.headers.get('content-length')), buf.length);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const f = join(tmp('mint-packapi-out-'), 'p.zip');
  writeFileSync(f, buf);
  assert.match(execFileSync('unzip', ['-t', f]).toString(), /No errors detected/);
  await new Promise((r2) => setTimeout(r2, 100));
  assert.deepEqual(packTemps().filter((n) => !before.includes(n)), []); // nothing left behind
});

test('GET /api/tax/pack rejects a bad fy and a wrong method', async () => {
  assert.equal((await fetch(`${base}/api/tax/pack?fy=abc`)).status, 400);
  assert.equal((await fetch(`${base}/api/tax/pack?fy=1999`)).status, 400);
  const post = await fetch(`${base}/api/tax/pack?fy=2026`, { method: 'POST' });
  assert.notEqual(post.status, 200);
});

test('GET /api/tax/pack for an empty year still downloads', async () => {
  const r = await fetch(`${base}/api/tax/pack?fy=2020`);
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 2).toString(), 'PK');
});
