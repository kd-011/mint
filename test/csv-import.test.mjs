// CSV statement import into a manual account (lib/csvimport.mjs): a small RFC
// 4180 parser, delimiter and header detection, a column mapper, date format
// guessing with an ambiguity warning, amount parsing, a preview with counts
// before anything is written, idempotent re-imports, one undo per import, and
// file content treated as untrusted text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, sniffDelimiter, parseAmount, parseDate, guessDateFormat, decodeCsv, readStatement, previewImport, runImport, undoImport, listImports, CSV_MAX_BYTES } from '../lib/csvimport.mjs';
import { storeRates } from '../lib/fx.mjs';
import { createManualAccount } from '../lib/manual.mjs';
import { book } from './fixtures/book.mjs';

const TODAY = '2026-10-17';

function setup(currency = 'USD') {
  const b = book();
  storeRates(b.db, 'USD', [{ date: '2026-01-01', rate: 1.5 }], { source: 'test', fetchedAt: '2026-10-17T00:00:00Z' });
  const a = createManualAccount(b.db, { name: 'Wise', type: 'transaction', currency, opening_balance: 0, opening_date: '2026-01-01' }, { today: TODAY });
  return { ...b, a };
}

test('parser: quoted fields, doubled quotes, embedded commas and newlines, CRLF, a trailing newline', () => {
  const rows = parseCsv('a,b,c\r\n"x, y","he said ""hi""","line one\nline two"\r\n1,,3\r\n', ',');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'he said "hi"', 'line one\nline two'], ['1', '', '3']]);
  assert.deepEqual(parseCsv('a;b\n1;2', ';'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('', ','), []);
  assert.throws(() => parseCsv('a,"unterminated\n', ','), /quote/);
});

test('delimiter sniffing: comma, semicolon, tab and pipe, ignoring ones inside quotes', () => {
  assert.equal(sniffDelimiter('Date,Desc,Amount\n01/02/2026,"A; B",1.00\n'), ',');
  assert.equal(sniffDelimiter('Date;Desc;Amount\n01/02/2026;"A, B";1,00\n'), ';');
  assert.equal(sniffDelimiter('Date\tDesc\tAmount\n01/02/2026\tA\t1.00\n'), '\t');
  assert.equal(sniffDelimiter('Date|Desc|Amount\n01/02/2026|A|1.00\n'), '|');
});

test('amounts: thousands separators, brackets, trailing minus, currency marks, DR and CR', () => {
  assert.equal(parseAmount('1,234.56'), 123456);
  assert.equal(parseAmount('-1,234.56'), -123456);
  assert.equal(parseAmount('(12.50)'), -1250);
  assert.equal(parseAmount('12.50-'), -1250);
  assert.equal(parseAmount('$1,000'), 100000);
  assert.equal(parseAmount('US$ 3.10'), 310);
  assert.equal(parseAmount('€1.234,56'), 123456);
  assert.equal(parseAmount('1 234,5'), 123450);
  assert.equal(parseAmount('45.00 DR'), -4500);
  assert.equal(parseAmount('45.00 CR'), 4500);
  assert.equal(parseAmount('+7'), 700);
  assert.equal(parseAmount('0.005'), null, 'more than two decimals is not money');
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(''), null);
});

test('dates: three formats, month names, times stripped, impossible dates refused', () => {
  assert.equal(parseDate('05/03/2026', 'DMY'), '2026-03-05');
  assert.equal(parseDate('05/03/2026', 'MDY'), '2026-05-03');
  assert.equal(parseDate('2026-03-05', 'YMD'), '2026-03-05');
  assert.equal(parseDate('2026-03-05 14:22:01', 'YMD'), '2026-03-05');
  assert.equal(parseDate('5 Mar 2026', 'DMY'), '2026-03-05');
  assert.equal(parseDate('Mar 5, 2026', 'MDY'), '2026-03-05');
  assert.equal(parseDate('5.3.26', 'DMY'), '2026-03-05');
  assert.equal(parseDate('31/02/2026', 'DMY'), null);
  assert.equal(parseDate('13/13/2026', 'DMY'), null);
});

test('date format guess: a day over 12 settles it, all-small days are flagged as ambiguous', () => {
  assert.deepEqual(guessDateFormat(['01/02/2026', '25/02/2026']), { format: 'DMY', ambiguous: false, possible: ['DMY'] });
  assert.deepEqual(guessDateFormat(['01/02/2026', '02/25/2026']), { format: 'MDY', ambiguous: false, possible: ['MDY'] });
  assert.deepEqual(guessDateFormat(['2026-02-01']), { format: 'YMD', ambiguous: false, possible: ['YMD'] });
  const amb = guessDateFormat(['01/02/2026', '03/04/2026']);
  assert.equal(amb.format, 'DMY', 'Australian order by default');
  assert.equal(amb.ambiguous, true);
  assert.deepEqual(amb.possible, ['DMY', 'MDY']);
});

test('decoding: a BOM is dropped, Windows-1252 text is read, binary and oversize files are refused', () => {
  assert.equal(decodeCsv(Buffer.from('﻿a,b\n', 'utf8')), 'a,b\n');
  assert.equal(decodeCsv(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x0a])), 'Café\n');
  assert.throws(() => decodeCsv(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x14, 0x00])), /binary|not a CSV/i);
  assert.throws(() => decodeCsv('x'.repeat(CSV_MAX_BYTES + 1)), /2 MB/);
});

test('header and mapping are guessed from the names, past a preamble of bank lines', () => {
  const text = 'Account: Wise USD\nExported 17/10/2026\n\nDate,Description,Paid out,Paid in,Balance,Reference\n03/10/2026,COFFEE,4.50,,95.50,R1\n04/10/2026,WAGES,,100.00,195.50,R2\n';
  const s = readStatement(text, {});
  assert.equal(s.header_row, 3);
  assert.deepEqual(s.columns, ['Date', 'Description', 'Paid out', 'Paid in', 'Balance', 'Reference']);
  assert.deepEqual(s.mapping, { date: 0, description: 1, amount: null, debit: 2, credit: 3, balance: 4, reference: 5 });
  assert.deepEqual(s.rows.map((r) => [r.date, r.amount, r.description, r.reference, r.balance]), [
    ['2026-10-03', -450, 'COFFEE', 'R1', 9550], ['2026-10-04', 10000, 'WAGES', 'R2', 19550],
  ]);
});

test('debit and credit columns: a debit is money out whatever its sign, and a row with neither fails with its row number', () => {
  const text = 'Date,Details,Debit,Credit\n03/10/2026,A,-4.50,\n04/10/2026,B,,10\n05/10/2026,C,,\n';
  const s = readStatement(text, {});
  assert.deepEqual(s.rows.map((r) => r.amount), [-450, 1000]);
  assert.deepEqual(s.failures, [{ row: 4, reason: 'no amount in Debit or Credit' }]);
});

test('preview counts what will import, skip and fail, with row numbers and reasons, and writes nothing', () => {
  const { db, a } = setup();
  const text = 'Date,Description,Amount\n03/10/2026,ONE,-1.00\nnot a date,TWO,-2.00\n05/10/2026,THREE,lots\n06/10/2026,"=HYPERLINK(""http://x"")",-4.00\n';
  const p = previewImport(db, a.id, { text }, { today: TODAY });
  assert.deepEqual(p.counts, { total: 4, import: 2, duplicate: 0, failed: 2 });
  assert.deepEqual(p.failures, [{ row: 3, reason: 'date "not a date" is not DD/MM/YYYY' }, { row: 4, reason: 'amount "lots" is not a number' }]);
  assert.equal(p.sample.length, 2);
  assert.equal(p.sample[1].description, '=HYPERLINK("http://x")', 'a formula is plain text');
  assert.equal(db.prepare('SELECT count(*) n FROM transactions WHERE account_id = ?').get(a.id).n, 0);
});

test('ambiguous dates are flagged in the preview, and the chosen format is what imports', () => {
  const { db, a } = setup();
  const text = 'Date,Description,Amount\n01/02/2026,ONE,-1.00\n03/04/2026,TWO,-2.00\n';
  const p = previewImport(db, a.id, { text }, { today: TODAY });
  assert.equal(p.date_guess.ambiguous, true);
  assert.match(p.warnings.join(' '), /could be read either way/);
  runImport(db, a.id, { text, date_format: 'MDY' }, { today: TODAY });
  assert.deepEqual(db.prepare('SELECT date FROM transactions WHERE account_id = ? ORDER BY date').all(a.id).map((r) => r.date), ['2026-01-02', '2026-03-04']);
});

test('future dates fail rather than import', () => {
  const { db, a } = setup();
  const p = previewImport(db, a.id, { text: 'Date,Description,Amount\n01/01/2027,LATER,-1.00\n' }, { today: TODAY });
  assert.deepEqual(p.failures, [{ row: 2, reason: 'date 01/01/2027 is in the future' }]);
});

test('import is idempotent: the same file twice, and an overlapping statement, add nothing twice', () => {
  const { db, a } = setup();
  const one = 'Date,Description,Amount\n03/10/2026,COFFEE,-4.50\n03/10/2026,COFFEE,-4.50\n04/10/2026,LUNCH,-12.00\n';
  const r1 = runImport(db, a.id, { text: one, file_name: 'oct-a.csv' }, { today: TODAY });
  assert.equal(r1.imported, 3, 'two identical coffees on one day are two rows');
  const r2 = runImport(db, a.id, { text: one }, { today: TODAY });
  assert.deepEqual([r2.imported, r2.duplicates], [0, 3]);
  const overlap = 'Date,Description,Amount\n03/10/2026,Coffee,-4.50\n03/10/2026,COFFEE ,-4.50\n04/10/2026,LUNCH,-12.00\n05/10/2026,DINNER,-30.00\n';
  const r3 = runImport(db, a.id, { text: overlap }, { today: TODAY });
  assert.deepEqual([r3.imported, r3.duplicates], [1, 3], 'description compared without case or spacing');
  const p = previewImport(db, a.id, { text: overlap }, { today: TODAY });
  assert.deepEqual(p.counts, { total: 4, import: 0, duplicate: 4, failed: 0 });
  assert.equal(db.prepare('SELECT count(*) n FROM transactions WHERE account_id = ?').get(a.id).n, 4);
});

test('imported rows carry native and AUD amounts, the account balance follows, and the mapping is remembered', () => {
  const { db, a } = setup();
  const text = 'When;What;Out;In\n2026-10-03;COFFEE;4,50;\n2026-10-04;TOPUP;;100,00\n';
  const r = runImport(db, a.id, { text, mapping: { date: 0, description: 1, debit: 2, credit: 3 }, date_format: 'YMD' }, { today: TODAY });
  assert.equal(r.imported, 2);
  const rows = db.prepare('SELECT amount, amount_native, currency, import_id FROM transactions WHERE account_id = ? ORDER BY date').all(a.id);
  assert.deepEqual(rows.map((x) => [x.amount_native, x.amount, x.currency]), [[-450, -675, 'USD'], [10000, 15000, 'USD']]);
  assert.ok(rows.every((x) => x.import_id === r.import_id));
  assert.equal(db.prepare('SELECT balance_native FROM accounts WHERE id = ?').get(a.id).balance_native, 9550);
  const p = previewImport(db, a.id, { text }, { today: TODAY });
  assert.deepEqual(p.mapping, { date: 0, description: 1, amount: null, debit: 2, credit: 3, balance: null, reference: null });
  assert.equal(p.date_format, 'YMD');
  assert.equal(p.remembered, true);
});

test('undo removes exactly one import, in one go, and puts the balance back', () => {
  const { db, a } = setup();
  const r1 = runImport(db, a.id, { text: 'Date,Description,Amount\n03/10/2026,A,-1.00\n' }, { today: TODAY });
  const r2 = runImport(db, a.id, { text: 'Date,Description,Amount\n04/10/2026,B,-2.00\n05/10/2026,C,-3.00\n' }, { today: TODAY });
  assert.equal(db.prepare('SELECT balance_native FROM accounts WHERE id = ?').get(a.id).balance_native, -600);
  const u = undoImport(db, r2.import_id, { today: TODAY });
  assert.equal(u.removed, 2);
  assert.deepEqual(db.prepare('SELECT description FROM transactions WHERE account_id = ?').all(a.id).map((x) => x.description), ['A']);
  assert.equal(db.prepare('SELECT balance_native FROM accounts WHERE id = ?').get(a.id).balance_native, -100);
  assert.throws(() => undoImport(db, r2.import_id, { today: TODAY }), /already undone/);
  const l = listImports(db, a.id);
  assert.deepEqual(l.map((x) => [x.id, x.rows, !!x.undone_at]), [[r2.import_id, 2, true], [r1.import_id, 1, false]]);
  // Re-importing an undone file brings its rows back.
  assert.equal(runImport(db, a.id, { text: 'Date,Description,Amount\n04/10/2026,B,-2.00\n05/10/2026,C,-3.00\n' }, { today: TODAY }).imported, 2);
});

test('an import is all or nothing: a missing rate for a foreign file refuses the whole thing', () => {
  const b = book();
  storeRates(b.db, 'THB', [{ date: '2026-06-01', rate: 0.045 }], { source: 'test', fetchedAt: '2026-10-17T00:00:00Z' });
  const a = createManualAccount(b.db, { name: 'Baht', type: 'transaction', currency: 'THB', opening_balance: 0, opening_date: '2026-06-01' }, { today: TODAY });
  const text = 'Date,Description,Amount\n02/06/2026,A,-1.00\n03/01/2026,B,-2.00\n';
  assert.throws(() => runImport(b.db, a.id, { text }, { today: TODAY }), (e) => e.status === 422 && /No exchange rate for THB on 03\/01\/2026/.test(e.message));
  assert.equal(b.db.prepare('SELECT count(*) n FROM transactions WHERE account_id = ?').get(a.id).n, 0);
  assert.equal(listImports(b.db, a.id).length, 0);
});

test('limits: no more than 20,000 rows, and a manual account only', () => {
  const { db, a } = setup();
  const big = `Date,Description,Amount\n${'03/10/2026,X,-1.00\n'.repeat(20_001)}`;
  assert.throws(() => previewImport(db, a.id, { text: big }, { today: TODAY }), /20,000 rows/);
  assert.throws(() => previewImport(db, 'acct_t_everyday', { text: 'Date,Description,Amount\n03/10/2026,X,-1.00\n' }, { today: TODAY }), /not a manual account/);
  assert.throws(() => previewImport(db, a.id, { text: 'just one line' }, { today: TODAY }), /date|columns/i);
});

test('a huge amount or date cell is refused at once, not parsed', () => {
  const t = performance.now();
  assert.equal(parseAmount(`1${' '.repeat(80000)}x`), null);
  assert.equal(parseDate(`1${' '.repeat(80000)}x`), null);
  assert.ok(performance.now() - t < 250);
  assert.equal(parseAmount('  $1,234.56 CR  '), 123456);
});
