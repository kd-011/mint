// A book built from CSV statements has no bank-supplied "SALARY/WAGES" label, so Mint has to find the pay
// from what the rows look like. Without it a stranger with no feed gets no pay cycles, no safe to spend
// and no cycle budgets, which is the whole point of the app. All rows here are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createManualAccount, insertManualRow, getManual } from '../lib/manual.mjs';
import { runIncome, listSources } from '../lib/income.mjs';
import { currentCycle } from '../lib/cycles.mjs';
import { setSetting, getSetting } from '../lib/db.mjs';
import { csvMerchantText } from '../lib/csvimport.mjs';
import { deriveMerchant } from '../lib/merchant.mjs';

const TODAY = '2026-11-03';
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);

function book() {
  const db = openDb(':memory:');
  const a = createManualAccount(db, { name: 'Everyday', institution: 'CommBank', type: 'transaction', currency: 'AUD', opening_balance: 500000, opening_date: '2026-01-01' }, { today: TODAY });
  const acct = getManual(db, a.id);
  return { db, acct, add: (date, amount, description) => insertManualRow(db, acct, { date, amount_native: amount, description }) };
}

// `n` deposits, `gap` days apart, the latest on `last`.
const series = (b, description, amount, { n = 6, gap = 14, last = '2026-10-29' } = {}) => {
  for (let i = 0; i < n; i++) b.add(addDays(last, -gap * i), amount, description);
};
const salaryOf = (db) => listSources(db).find((s) => s.kind === 'salary');

test('a fortnightly deposit that says SALARY becomes the pay stream that starts the cycle', () => {
  const b = book();
  series(b, 'SALARY ACME PTY LTD PAYROLL', 325000);
  b.add('2026-10-30', -2024, 'THE COFFEE CLUB NORTHBRIDGE AU');
  runIncome(b.db, { today: TODAY });
  const s = salaryOf(b.db);
  assert.ok(s, 'a salary stream was found');
  assert.equal(s.anchor, true);
  assert.equal(s.cadence_days, 14);
  const c = currentCycle(b.db, { today: TODAY });
  assert.equal(c.start, '2026-10-29');
  assert.equal(c.payday.amount, 325000);
  assert.equal(c.next_payday, '2026-11-12');
  const row = b.db.prepare("SELECT income_kind FROM transactions WHERE date = '2026-10-29' AND amount > 0").get();
  assert.equal(row.income_kind, 'salary');
});

test('the words banks use for pay are all found, weekly and monthly as well as fortnightly', () => {
  for (const [desc, gap, cadence] of [
    ['DIRECT CREDIT 123456 ACME WAGES', 7, 7],
    ['PAY/SALARY FROM GLOBEX PTY LTD', 14, 14],
    ['GLOBEX PAYROLL REF 8821', 30, 30],
  ]) {
    const b = book();
    series(b, desc, 410000, { gap, last: '2026-10-28' });
    runIncome(b.db, { today: TODAY });
    const s = salaryOf(b.db);
    assert.ok(s, `found ${desc}`);
    assert.equal(s.cadence_days, cadence, desc);
  }
});

test('pay that moves a little with overtime and public holidays still counts', () => {
  const b = book();
  for (const [d, amt] of [['2026-10-29', 331000], ['2026-10-15', 318000], ['2026-09-30', 325000], ['2026-09-17', 342000], ['2026-09-03', 325000]]) b.add(d, amt, 'SALARY ACME');
  runIncome(b.db, { today: TODAY });
  assert.ok(salaryOf(b.db));
});

test('a steady employer deposit with no pay word is found when it is the biggest steady credit', () => {
  const b = book();
  series(b, 'INITECH PTY LTD 88213', 280000);
  series(b, 'RENT FROM TENANT 11', 60000, { gap: 7 });
  runIncome(b.db, { today: TODAY });
  const s = salaryOf(b.db);
  assert.ok(s);
  assert.match(s.pattern, /^INITECH/);
});

test('what is not pay stays out: a housemate, transfers, interest, a one-off and a stream that stopped', () => {
  for (const seed of [
    (b) => series(b, 'SAM PLACEHOLDER rent', 90000),
    (b) => series(b, 'TRANSFER FROM SAVINGS', 90000),
    (b) => series(b, 'INTEREST PAID', 60000, { gap: 30 }),
    (b) => b.add('2026-10-20', 800000, 'SALARY BONUS ACME'),
    (b) => series(b, 'SALARY OLD EMPLOYER', 300000, { last: '2026-03-01' }),
    (b) => { for (const [d, a] of [['2026-10-29', 90000], ['2026-10-02', 300000], ['2026-09-01', 150000]]) b.add(d, a, 'ETSY PAYOUT'); },
  ]) {
    const b = book();
    seed(b);
    runIncome(b.db, { today: TODAY });
    assert.equal(salaryOf(b.db), undefined);
    assert.equal(getSetting(b.db, 'income_seeded'), null, 'still looking, so a later import can find the pay');
  }
});

test('nothing is found twice, and a later import does not move a stream the owner already has', () => {
  const b = book();
  series(b, 'SALARY ACME', 325000);
  runIncome(b.db, { today: TODAY });
  const before = listSources(b.db).length;
  series(b, 'WAGES GLOBEX', 500000, { last: '2026-10-30' });
  runIncome(b.db, { today: TODAY });
  assert.equal(listSources(b.db).length, before);
  assert.match(salaryOf(b.db).pattern, /^SALARY ACME/);
});

test('a book already seeded, or with streams of its own, is never touched', () => {
  const seeded = book();
  setSetting(seeded.db, 'income_seeded', '2026-10-20T00:00:00.000Z');
  series(seeded, 'SALARY ACME', 325000);
  runIncome(seeded.db, { today: TODAY });
  assert.equal(listSources(seeded.db).length, 0, 'income_seeded means the question is closed');

  const own = book();
  own.db.prepare(`INSERT INTO income_sources (name, kind, field, match, pattern, anchor, priority, source, created_at, updated_at)
    VALUES ('Mine', 'regular', 'description', 'starts', 'MY CLIENT', 0, 20, 'manual', 'x', 'x')`).run();
  series(own, 'SALARY ACME', 325000);
  runIncome(own.db, { today: TODAY });
  assert.deepEqual(listSources(own.db).map((s) => s.name), ['Mine'], 'an owner who has set up streams keeps them');
});

test('the feed label still wins and gives the same stream as before', () => {
  const b = book();
  series(b, 'SALARY/WAGES ACME CONSULTING', 340000);
  runIncome(b.db, { today: TODAY });
  const s = salaryOf(b.db);
  assert.equal(s.pattern, 'SALARY/WAGES');
  assert.equal(s.name, 'Salary');
});

test('a statement tail is left out of the merchant name, and only for an imported row', () => {
  assert.equal(deriveMerchant(csvMerchantText('NETFLIX.COM SYDNEY AU Card xx1234'), null), 'Netflix.com Sydney');
  assert.equal(deriveMerchant(csvMerchantText('WOOLWORTHS 1234 PERTH AUS Card xx1234 Value Date: 28/10/2026'), null), 'Woolworths 1234 Perth');
  assert.equal(csvMerchantText('BPAY REAL ESTATE RENT 1002'), 'BPAY REAL ESTATE RENT 1002');
  // lib/merchant.mjs is untouched: a change there would re-file a live feed's merchants.
  assert.equal(deriveMerchant('NETFLIX.COM SYDNEY AU Card xx1234', null), 'Netflix.com Sydney Au Card xx1234');
});
