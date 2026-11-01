// v2 step 1: a LOAN DRAWDOWN on a loan account is the bank lending money, not
// spend. The settlement rows must not poison spend, budgets or averages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { createEngine } from '../lib/engine.mjs';
import { monthlyReport } from '../lib/reports.mjs';
import { spendReport } from '../lib/assistant.mjs';

const NOW = () => new Date('2026-10-17T02:00:00Z');

function settlement() {
  const b = book();
  const big = b.add('acct_t_loan', '2026-07-28', -35099895, 'LOAN DRAWDOWN', { provider_category: 'LOAN_PAYMENTS' });
  const mid = b.add('acct_t_loan', '2026-07-28', -2370296, 'LOAN DRAWDOWN', { provider_category: 'LOAN_PAYMENTS' });
  const sec = b.add('acct_t_loan', '2026-07-28', -45020, 'LOAN DRAWDOWN FOR SECURITY CHARGES', { provider_category: 'LOAN_PAYMENTS' });
  b.add('acct_t_everyday', '2026-07-20', -12000, 'TEST GROCER', { provider_category: 'FOOD_AND_DRINK' });
  // The same words on a cash account are not a drawdown of this loan.
  const elsewhere = b.add('acct_t_everyday', '2026-07-21', -5000, 'LOAN DRAWDOWN', { provider_category: 'LOAN_PAYMENTS' });
  return { b, big, mid, sec, elsewhere };
}

test('LOAN DRAWDOWN rows on the loan move to a transfer-kind category and stop counting as spend', () => {
  const { b, big, mid, sec, elsewhere } = settlement();
  const before = monthlyReport(b.db, { from: '2026-07', to: '2026-07' });
  createEngine({ db: b.db, now: NOW, log: () => {} }).refresh();
  const drawdown = b.db.prepare("SELECT id, kind FROM categories WHERE name = 'Loan drawdown'").get();
  assert.ok(drawdown, 'Loan drawdown category seeded');
  assert.equal(drawdown.kind, 'transfer');
  for (const id of [big, mid, sec]) assert.equal(b.row(id).category_id, drawdown.id, id);
  assert.notEqual(b.row(elsewhere).category_id, drawdown.id);
  const after = monthlyReport(b.db, { from: '2026-07', to: '2026-07' });
  assert.ok(before.months[0].spent > 37000000);
  assert.equal(after.months[0].spent, 12000 + 5000);
  assert.equal(spendReport(b.db, { from: '2026-07-01', to: '2026-07-31' }).totals.spent, 17000);
});

test('the drawdown rule is scoped to the loan, made once, and never fights a manual pick or a deleted rule', () => {
  const { b, mid } = settlement();
  b.db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(b.cat('Home and garden'), mid);
  const engine = createEngine({ db: b.db, now: NOW, log: () => {} });
  engine.refresh();
  engine.refresh();
  const rules = b.db.prepare("SELECT * FROM rules WHERE pattern = 'LOAN DRAWDOWN'").all();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].account_id, 'acct_t_loan');
  assert.equal(b.row(mid).category_id, b.cat('Home and garden'));
  b.db.prepare('DELETE FROM rules WHERE id = ?').run(rules[0].id);
  engine.refresh();
  assert.equal(b.db.prepare("SELECT count(*) n FROM rules WHERE pattern = 'LOAN DRAWDOWN'").get().n, 0);
});

test('the deposit paid from the offset into the settlement links to the loan, whatever the bank called the debit', () => {
  const { b } = settlement();
  b.add('acct_t_loan', '2026-07-28', 2370296, 'CUSTOMER FUNDS CONTRIBUTION', { provider_category: 'INCOME' });
  const fee = b.add('acct_t_offset', '2026-07-29', -2370296, 'BANK/GOVT FEE REFER LOAN APPROVAL LETTER', { provider_category: 'BANK_FEES' });
  createEngine({ db: b.db, now: NOW, log: () => {} }).refresh();
  const x = b.db.prepare('SELECT kind, status FROM transfers WHERE out_tx = ?').get(fee);
  assert.deepEqual({ ...x }, { kind: 'loan_repayment', status: 'auto' });
  assert.equal(monthlyReport(b.db, { from: '2026-07', to: '2026-07' }).months[0].spent, 17000);
  // A fee with no matching loan credit is still a fee.
  const real = b.add('acct_t_offset', '2026-07-30', -2500, 'MONTHLY ACCOUNT FEE', { provider_category: 'BANK_FEES' });
  createEngine({ db: b.db, now: NOW, log: () => {} }).refresh();
  assert.equal(b.db.prepare('SELECT count(*) n FROM transfers WHERE out_tx = ?').get(real).n, 0);
});
