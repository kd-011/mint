// CSV import against the default exports of the big four (CommBank, ANZ, NAB,
// Westpac) plus ING and Macquarie, with invented rows.
//
// None of these layouts is documented by the bank itself in anything public (checked
// 2026-11-01: no bank publishes the column list for its consumer CSV, and the third
// party descriptions disagree), so the fixtures in test/fixtures/csv are the layouts as
// widely reported, plus the variants that differ, and they pin SHAPES the reader must
// cope with: no header row, a signed amount or a debit and credit split, a blank header
// cell, DD/MM/YYYY and DD Mon YY dates. docs/csv-import.md says so, and a layout that is
// not recognised falls back to the column mapper, which remembers its answer per account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStatement, previewImport, runImport } from '../lib/csvimport.mjs';
import { createManualAccount } from '../lib/manual.mjs';
import { book } from './fixtures/book.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'csv');
const file = (n) => readFileSync(join(DIR, n), 'utf8');
const TODAY = '2026-10-17';

const COFFEE = ['2026-10-15', -450];
const SAVINGS = ['2026-10-14', -125000];
const SALARY = ['2026-10-13', 325000];

// [fixture, header row index or null, description of the first row, mapped columns]
const BANKS = [
  ['commbank-no-header.csv', null, 'COFFEE HUT PERTH WA AUS Card xx1234 Value Date: 14/10/2026', { date: 0, amount: 1, description: 2 }],
  ['commbank-split.csv', 0, 'COFFEE HUT PERTH WA AUS', { date: 0, description: 1, debit: 2, credit: 3, balance: 4 }],
  ['anz-no-header.csv', null, 'VISA PURCHASE COFFEE HUT PERTH', { date: 0, amount: 1, description: 2 }],
  ['anz-split.csv', 0, 'VISA PURCHASE COFFEE HUT PERTH', { date: 0, description: 1, debit: 2, credit: 3 }],
  ['nab.csv', 0, 'COFFEE HUT PERTH', { date: 0, amount: 1, description: 5, balance: 6 }],
  ['westpac.csv', 0, 'COFFEE HUT PERTH', { date: 1, description: 2, debit: 3, credit: 4, balance: 5 }],
  ['ing.csv', 0, 'Coffee Hut Perth', { date: 0, description: 1, credit: 2, debit: 3, balance: 4 }],
  ['macquarie.csv', 0, 'Coffee Hut', { date: 0, description: 1, debit: 5, credit: 6, balance: 7 }],
];

for (const [name, header, firstDesc, map] of BANKS) {
  test(`${name}: columns found on their own, dates read day first, every row parsed with the right sign`, () => {
    const s = readStatement(file(name), { today: TODAY });
    assert.equal(s.incomplete, undefined, 'the mapper is not needed');
    assert.equal(s.header_row, header);
    assert.equal(s.date_format, 'DMY');
    assert.deepEqual(s.failures, []);
    for (const [role, i] of Object.entries(map)) assert.equal(s.mapping[role], i, `${role} column`);
    const rows = s.rows.slice(0, 3);
    assert.deepEqual(rows.map((r) => [r.date, r.amount]), [COFFEE, SAVINGS, SALARY], 'coffee and the transfer out are negative, the salary is positive');
    assert.equal(rows[0].description, firstDesc);
    assert.ok(s.rows.length >= 3);
  });
}

test('a comma inside a quoted amount is a thousands separator, not a column (ANZ, no header)', () => {
  const s = readStatement(file('anz-no-header.csv'), { today: TODAY });
  assert.equal(s.rows.length, 4);
  assert.deepEqual([s.rows[3].date, s.rows[3].amount], ['2026-10-13', -123456]);
});

test('closing balances are read where the export has them', () => {
  for (const n of ['commbank-no-header.csv', 'commbank-split.csv', 'nab.csv', 'westpac.csv', 'ing.csv', 'macquarie.csv']) {
    const s = readStatement(file(n), { today: TODAY });
    assert.equal(s.rows[0].balance, 199550, `${n}: balance on the newest row`);
  }
  assert.equal(readStatement(file('anz-no-header.csv'), { today: TODAY }).rows[0].balance, null, 'ANZ has no balance column, so none is invented');
});

function account() {
  const b = book();
  const a = createManualAccount(b.db, { name: 'Everyday', institution: 'Test Bank', type: 'transaction', currency: 'AUD', opening_balance: 0, opening_date: '2026-01-01' }, { today: TODAY });
  return { ...b, a };
}

for (const [name] of BANKS) {
  test(`${name}: importing the same file twice adds nothing the second time`, () => {
    const { db, a } = account();
    const text = file(name);
    const one = runImport(db, a.id, { text, file_name: name }, { today: TODAY });
    assert.ok(one.imported >= 3);
    assert.equal(one.failed, 0);
    const n = () => db.prepare('SELECT count(*) n FROM transactions WHERE account_id = ?').get(a.id).n;
    const after1 = n();
    const two = runImport(db, a.id, { text, file_name: name }, { today: TODAY });
    assert.deepEqual([two.imported, two.duplicates], [0, one.imported]);
    assert.equal(n(), after1);
    const p = previewImport(db, a.id, { text }, { today: TODAY });
    assert.deepEqual(p.counts, { total: one.imported, import: 0, duplicate: one.imported, failed: 0 });
  });
}

test('a layout the reader cannot place falls back to the mapper, imports once the columns are chosen, and remembers them for the account', () => {
  const { db, a } = account();
  const text = file('unknown-layout.csv');
  const s = readStatement(text, { today: TODAY });
  assert.equal(s.incomplete, true, 'nothing parses until the columns are chosen');
  assert.deepEqual(s.rows, []);
  const p = previewImport(db, a.id, { text }, { today: TODAY });
  assert.equal(p.incomplete, true);
  assert.deepEqual(p.columns, ['Txn', 'Val', 'Ref2']);
  assert.throws(() => runImport(db, a.id, { text }, { today: TODAY }), /pick the date, description and amount/);

  const mapping = { date: 0, amount: 1, description: 2, debit: null, credit: null, balance: null, reference: null };
  const ok = previewImport(db, a.id, { text, mapping }, { today: TODAY });
  assert.equal(ok.incomplete, false);
  assert.deepEqual(ok.counts, { total: 3, import: 3, duplicate: 0, failed: 0 });
  assert.deepEqual(ok.sample.map((r) => [r.date, r.amount, r.description]), [['2026-10-13', -450, '100234'], ['2026-10-14', -125000, '100235'], ['2026-10-15', 325000, '100236']]);
  runImport(db, a.id, { text, mapping }, { today: TODAY });

  // The next file from the same bank is read with the remembered mapping, no mapper.
  const next = previewImport(db, a.id, { text: file('unknown-layout-next.csv') }, { today: TODAY });
  assert.equal(next.incomplete, false);
  assert.equal(next.remembered, true);
  assert.deepEqual(next.counts, { total: 3, import: 2, duplicate: 1, failed: 0 });
});

test('the mapping is per account: another account still meets the mapper for the same layout', () => {
  const { db, a } = account();
  const b2 = createManualAccount(db, { name: 'Other', type: 'transaction', currency: 'AUD', opening_balance: 0, opening_date: '2026-01-01' }, { today: TODAY });
  const mapping = { date: 0, amount: 1, description: 2, debit: null, credit: null, balance: null, reference: null };
  runImport(db, a.id, { text: file('unknown-layout.csv'), mapping }, { today: TODAY });
  assert.equal(previewImport(db, b2.id, { text: file('unknown-layout-next.csv') }, { today: TODAY }).incomplete, true);
});

test('real parse errors reach the preview with their row numbers, per bank layout', () => {
  const { db, a } = account();
  const text = `${file('westpac.csv')}032-000 123456,32/13/2026,BAD DATE,1.00,,0,,\n032-000 123456,12/10/2026,BAD AMOUNT,lots,,0,,\n`; // scan-allow (invented BSB and account)
  const p = previewImport(db, a.id, { text }, { today: TODAY });
  assert.deepEqual(p.counts, { total: 5, import: 3, duplicate: 0, failed: 2 });
  assert.deepEqual(p.failures, [{ row: 5, reason: 'date "32/13/2026" is not DD/MM/YYYY' }, { row: 6, reason: 'amount "lots" is not a number' }]);
});
