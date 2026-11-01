// (f) Tax and business: deductible tags with ATO categories, business inherited
// from the account with a per-transaction override, receipts (validated,
// capped, stored under data/receipts), FY summary and CSV. No GST anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { book } from './fixtures/book.mjs';
import { ATO_CATEGORIES, setTaxTag, clearTaxTag, setBusiness, fyRange, fySummary, fyCsv, sniffReceipt, saveReceipt, deleteReceipt, RECEIPT_MAX_BYTES } from '../lib/tax.mjs';
import { applyRules } from '../lib/categorise.mjs';
import { matchTransfers } from '../lib/transfers.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)]);
const HEIC = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(64)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);

test('ATO categories cover the individual D items and business expense labels', () => {
  const codes = ATO_CATEGORIES.map((c) => c.code);
  for (const c of ['D1', 'D2', 'D3', 'D4', 'D5', 'D7', 'D8', 'D9', 'D10', 'D15', 'BUS_OTHER']) assert.ok(codes.includes(c), c);
  assert.ok(ATO_CATEGORIES.every((c) => c.label && c.group));
});

test('tagging validates the category and the deductible amount', () => {
  const b = book();
  const t = b.add('acct_t_card', '2026-03-01', -12000, 'TEST OFFICE SUPPLIES');
  const tag = setTaxTag(b.db, t, { ato_category: 'D5' });
  assert.equal(tag.deductible_amount, 12000); // defaults to the whole charge
  assert.equal(setTaxTag(b.db, t, { ato_category: 'D5', deductible_amount: 6000, note: 'half work use' }).deductible_amount, 6000);
  const bad = (body) => assert.throws(() => setTaxTag(b.db, t, body), (e) => e.status === 400, JSON.stringify(body));
  bad({ ato_category: 'GST1' });
  bad({ ato_category: 'D5', deductible_amount: 12001 });
  bad({ ato_category: 'D5', deductible_amount: 0 });
  bad({ ato_category: 'D5', deductible_amount: 10.5 });
  bad({ ato_category: 'D5', note: 'x'.repeat(501) });
  assert.throws(() => setTaxTag(b.db, 'txn_none', { ato_category: 'D5' }), (e) => e.status === 404);
  clearTaxTag(b.db, t);
  assert.equal(b.db.prepare('SELECT count(*) n FROM tax_tags').get().n, 0);
});

test('business flag: inherited from the account, overridable per transaction', () => {
  const b = book();
  const t = b.add('acct_t_everyday', '2026-03-01', -5000, 'TEST');
  assert.equal(setBusiness(b.db, t, true).business, true);
  assert.equal(setBusiness(b.db, t, null).business, false);
  const u = b.add('acct_t_biz', '2026-03-01', -5000, 'TEST');
  assert.equal(setBusiness(b.db, u, null).business, true);
  assert.equal(setBusiness(b.db, u, false).business, false);
  assert.throws(() => setBusiness(b.db, u, 'yes'), (e) => e.status === 400);
});

test('FY runs 1 July to 30 June', () => {
  assert.deepEqual(fyRange(2026), { from: '2025-07-01', to: '2026-06-30' });
  assert.throws(() => fyRange(1999), (e) => e.status === 400);
});

function fyBook() {
  const b = book();
  const d5 = b.add('acct_t_card', '2025-08-01', -12000, 'TEST OFFICE SUPPLIES');
  const d4 = b.add('acct_t_everyday', '2026-06-30', -50000, '=TEST COURSE FEES');
  const before = b.add('acct_t_card', '2025-06-30', -7000, 'TEST LAST YEAR');
  const after = b.add('acct_t_card', '2026-07-01', -8000, 'TEST NEXT YEAR');
  b.add('acct_t_biz', '2025-09-01', 300000, 'TEST CLIENT PAYMENT', { provider_category: 'INCOME' });
  b.add('acct_t_biz', '2025-09-02', -4500, 'TEST HOSTING');
  b.add('acct_t_biz', '2025-09-03', -100000, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_OUT' });
  b.add('acct_t_everyday', '2025-09-03', 100000, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_IN' });
  applyRules(b.db);
  matchTransfers(b.db);
  setTaxTag(b.db, d5, { ato_category: 'D5' });
  setTaxTag(b.db, d4, { ato_category: 'D4', deductible_amount: 25000 });
  setTaxTag(b.db, before, { ato_category: 'D5' });
  setTaxTag(b.db, after, { ato_category: 'D5' });
  return { b, d5, d4 };
}

test('FY summary totals deductions by ATO category and business income and expenses', () => {
  const { b } = fyBook();
  const s = fySummary(b.db, 2026);
  assert.equal(s.from, '2025-07-01');
  assert.equal(s.deductions.total, 12000 + 25000);
  assert.deepEqual(s.deductions.by_category.map((c) => [c.code, c.amount, c.count]), [['D4', 25000, 1], ['D5', 12000, 1]]);
  assert.equal(s.business.income, 300000);
  assert.equal(s.business.expenses, 4500);
  assert.equal(s.business.net, 295500);
  assert.equal(s.receipts.missing, 2);
  assert.doesNotMatch(JSON.stringify(s), /gst|bas/i);
});

test('FY CSV: deductions and business rows, DD/MM/YYYY, dollars, only that year, formula cells neutralised', () => {
  const { b } = fyBook();
  const csv = fyCsv(b.db, 2026);
  const lines = csv.trim().split('\r\n');
  assert.match(lines[0], /^Date,Description,Merchant,Account,Amount,Deductible,ATO code,ATO category,Business,Category,Note,Receipts$/);
  assert.equal(lines.length, 5); // two deductions plus the two business rows, transfers left out
  assert.match(csv, /01\/09\/2025,TEST CLIENT PAYMENT,.*,3000\.00,,,,Business,/);
  assert.match(csv, /02\/09\/2025,TEST HOSTING,.*,-45\.00,,,,Business,/);
  assert.match(csv, /01\/08\/2025,TEST OFFICE SUPPLIES,.*,-120\.00,120\.00,D5,/);
  assert.match(csv, /30\/06\/2026,'=TEST COURSE FEES,/);
  assert.doesNotMatch(csv, /LAST YEAR|NEXT YEAR/);
});

test('receipts: magic bytes, size cap, private file, linked to the transaction', () => {
  const b = book();
  const t = b.add('acct_t_card', '2026-03-01', -12000, 'TEST OFFICE SUPPLIES');
  const dir = join(mkdtempSync(join(tmpdir(), 'mint-rcpt-')), 'receipts');
  assert.equal(sniffReceipt(PNG), 'image/png');
  assert.equal(sniffReceipt(JPEG), 'image/jpeg');
  assert.equal(sniffReceipt(WEBP), 'image/webp');
  assert.equal(sniffReceipt(HEIC), 'image/heic');
  assert.equal(sniffReceipt(PDF), 'application/pdf');
  assert.equal(sniffReceipt(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(sniffReceipt(Buffer.from('GIF89a........')), null);
  const r = saveReceipt({ db: b.db, dir, transactionId: t, buf: PNG, declaredType: 'image/png' });
  assert.equal(r.mime, 'image/png');
  assert.match(r.file, /^[0-9a-f]{32}\.png$/);
  const path = join(dir, r.file);
  assert.equal(statSync(path).mode & 0o077, 0);
  assert.equal(b.db.prepare('SELECT transaction_id FROM receipts WHERE id = ?').get(r.id).transaction_id, t);
  const err = (args, status) => assert.throws(() => saveReceipt({ db: b.db, dir, transactionId: t, ...args }), (e) => e.status === status);
  err({ buf: Buffer.from('<html>'), declaredType: 'image/png' }, 415);
  err({ buf: PNG, declaredType: 'image/jpeg' }, 415); // declared type must match the bytes
  err({ buf: Buffer.alloc(RECEIPT_MAX_BYTES + 1, 0x89), declaredType: 'image/png' }, 413);
  err({ buf: Buffer.alloc(0), declaredType: 'image/png' }, 400);
  assert.throws(() => saveReceipt({ db: b.db, dir, transactionId: 'txn_none', buf: PNG, declaredType: 'image/png' }), (e) => e.status === 404);
  deleteReceipt({ db: b.db, dir, id: r.id });
  assert.equal(existsSync(path), false);
  assert.deepEqual(readdirSync(dir), []);
});
