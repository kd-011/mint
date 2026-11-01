// (b) Transfers: opposite amounts across the owner's own accounts within a few
// days, provider TRANSFER_* as the hint, both legs linked, card and loan
// repayments typed, doubtful pairs queued for review, confirm and reject.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { matchTransfers, listTransfers, confirmTransfer, rejectTransfer, linkTransfer, setSplit, transferOf } from '../lib/transfers.mjs';

const OUT = { provider_category: 'TRANSFER_OUT' };
const IN = { provider_category: 'TRANSFER_IN' };

test('a clear transfer between two own accounts is linked automatically', () => {
  const b = book();
  const o = b.add('acct_t_everyday', '2026-10-01', -50000, 'ONLINE X1 Linked Acc Trns', OUT);
  const i = b.add('acct_t_savings', '2026-10-02', 50000, 'ONLINE X1 Linked Acc Trns', IN);
  const r = matchTransfers(b.db);
  assert.equal(r.auto, 1);
  assert.equal(r.review, 0);
  const t = transferOf(b.db, o);
  assert.equal(t.in_tx, i);
  assert.equal(t.status, 'auto');
  assert.equal(t.kind, 'transfer');
  assert.ok(t.confidence >= 0.8);
  assert.equal(transferOf(b.db, i).id, t.id);
  // Idempotent.
  assert.deepEqual(matchTransfers(b.db), { auto: 0, review: 0, scanned: 0 });
  assert.equal(b.db.prepare('SELECT count(*) n FROM transfers').get().n, 1);
});

test('card repayments and loan repayments are typed', () => {
  const b = book();
  const cardOut = b.add('acct_t_everyday', '2026-10-03', -120000, 'PAYMENT TO TEST CARD', OUT);
  b.add('acct_t_card', '2026-10-04', 120000, 'PAYMENT RECEIVED THANK YOU', IN);
  const loanOut = b.add('acct_t_offset', '2026-10-01', -250000, 'LOAN INSTALMENT TO A/C', { provider_category: 'LOAN_PAYMENTS' });
  b.add('acct_t_loan', '2026-10-01', 250000, 'REPAYMENT', IN);
  matchTransfers(b.db);
  assert.equal(transferOf(b.db, cardOut).kind, 'card_repayment');
  assert.equal(transferOf(b.db, cardOut).status, 'auto');
  assert.equal(transferOf(b.db, loanOut).kind, 'loan_repayment');
});

test('no hint either side goes to review; a merchant or income hint is not a transfer', () => {
  const b = book();
  const o = b.add('acct_t_everyday', '2026-10-05', -30000, 'SOMETHING', { provider_category: null });
  b.add('acct_t_savings', '2026-10-07', 30000, 'SOMETHING ELSE', { provider_category: null });
  const shop = b.add('acct_t_everyday', '2026-10-05', -4321, 'TEST SHOP', { provider_category: 'FOOD_AND_DRINK' });
  const pay = b.add('acct_t_savings', '2026-10-05', 4321, 'TEST EMPLOYER', { provider_category: 'INCOME' });
  const r = matchTransfers(b.db);
  assert.equal(r.review, 1);
  assert.equal(transferOf(b.db, o).status, 'review');
  assert.equal(transferOf(b.db, shop), null);
  assert.equal(transferOf(b.db, pay), null);
  assert.equal(listTransfers(b.db, { status: 'review' }).length, 1);
});

test('two equally good counterparts make the pair doubtful', () => {
  const b = book();
  const o = b.add('acct_t_everyday', '2026-10-05', -20000, 'ONLINE Linked Acc Trns', OUT);
  b.add('acct_t_savings', '2026-10-05', 20000, 'ONLINE Linked Acc Trns', IN);
  b.add('acct_t_offset', '2026-10-05', 20000, 'ONLINE Linked Acc Trns', IN);
  matchTransfers(b.db);
  assert.equal(transferOf(b.db, o).status, 'review');
  assert.equal(b.db.prepare('SELECT count(*) n FROM transfers').get().n, 1);
});

test('same account, wrong amount or too far apart never match', () => {
  const b = book();
  b.add('acct_t_everyday', '2026-10-01', -10000, 'X', OUT);
  b.add('acct_t_everyday', '2026-10-01', 10000, 'X', IN);
  b.add('acct_t_savings', '2026-10-01', 10001, 'X', IN);
  b.add('acct_t_offset', '2026-10-12', 10000, 'X', IN);
  assert.equal(matchTransfers(b.db).auto + matchTransfers(b.db).review, 0);
});

test('list joins both legs with account names', () => {
  const b = book();
  b.add('acct_t_everyday', '2026-10-01', -50000, 'ONLINE X1', OUT);
  b.add('acct_t_savings', '2026-10-01', 50000, 'ONLINE X1', IN);
  matchTransfers(b.db);
  const [t] = listTransfers(b.db, {});
  assert.equal(t.out.account_name, 'Everyday Test');
  assert.equal(t.in.account_name, 'Savings Test');
  assert.equal(t.amount, 50000);
});

test('confirm keeps the pair, reject unlinks it for good', () => {
  const b = book();
  const o = b.add('acct_t_everyday', '2026-10-05', -30000, 'SOMETHING', { provider_category: null });
  const i = b.add('acct_t_savings', '2026-10-06', 30000, 'SOMETHING', { provider_category: null });
  const o2 = b.add('acct_t_everyday', '2026-10-08', -7000, 'OTHER', { provider_category: null });
  b.add('acct_t_offset', '2026-10-08', 7000, 'OTHER', { provider_category: null });
  matchTransfers(b.db);
  const t1 = transferOf(b.db, o);
  const t2 = transferOf(b.db, o2);
  assert.equal(confirmTransfer(b.db, t1.id).status, 'confirmed');
  rejectTransfer(b.db, t2.id);
  assert.equal(transferOf(b.db, o2), null);
  matchTransfers(b.db);
  assert.equal(transferOf(b.db, o2), null); // not proposed again
  assert.equal(transferOf(b.db, i).status, 'confirmed');
  assert.throws(() => confirmTransfer(b.db, 999), (e) => e.status === 404);
});

test('manual link, and principal/interest split only on a loan repayment', () => {
  const b = book();
  const o = b.add('acct_t_offset', '2026-09-01', -250000, 'MANUAL REPAYMENT', { provider_category: null });
  const i = b.add('acct_t_loan', '2026-09-20', 250000, 'REPAYMENT', { provider_category: null });
  const t = linkTransfer(b.db, o, i);
  assert.equal(t.status, 'confirmed');
  assert.equal(t.kind, 'loan_repayment');
  assert.equal(setSplit(b.db, t.id, { principal: 150000, interest: 100000 }).principal, 150000);
  assert.throws(() => setSplit(b.db, t.id, { principal: 1, interest: 1 }), (e) => e.status === 400);
  assert.throws(() => linkTransfer(b.db, o, i), (e) => e.status === 409);
  const x = b.add('acct_t_everyday', '2026-09-01', -100, 'A', OUT);
  const y = b.add('acct_t_everyday', '2026-09-01', 100, 'B', IN);
  assert.throws(() => linkTransfer(b.db, x, y), (e) => e.status === 400); // same account
  const p = b.add('acct_t_everyday', '2026-09-02', -100, 'C', OUT);
  const q = b.add('acct_t_savings', '2026-09-02', 100, 'D', IN);
  const plain = linkTransfer(b.db, p, q);
  assert.throws(() => setSplit(b.db, plain.id, { principal: 100, interest: 0 }), (e) => e.status === 400);
});

test('a shared bank reference settles a pair that would otherwise be doubtful', () => {
  const b = book();
  const o = b.add('acct_t_everyday', '2026-10-05', -20000, 'ONLINE J1234567890 Linked Acc Trns', OUT);
  const i = b.add('acct_t_savings', '2026-10-05', 20000, 'ONLINE J1234567890 Linked Acc Trns', IN);
  b.add('acct_t_offset', '2026-10-05', 20000, 'ONLINE K9999999999 Linked Acc Trns', IN);
  matchTransfers(b.db);
  const t = transferOf(b.db, o);
  assert.equal(t.in_tx, i);
  assert.equal(t.status, 'auto');
});

test('twin transfers (same accounts, day and amount) link without review', () => {
  const b = book();
  const o1 = b.add('acct_t_everyday', '2026-10-05', -10000, 'ONLINE A1111111111 Linked Acc Trns', OUT);
  const o2 = b.add('acct_t_everyday', '2026-10-05', -10000, 'ONLINE B2222222222 Linked Acc Trns', OUT);
  b.add('acct_t_savings', '2026-10-05', 10000, 'ONLINE C3333333333 Linked Acc Trns', IN);
  b.add('acct_t_savings', '2026-10-05', 10000, 'ONLINE D4444444444 Linked Acc Trns', IN);
  assert.deepEqual(matchTransfers(b.db), { auto: 2, review: 0, scanned: 4 });
  assert.equal(transferOf(b.db, o1).status, 'auto');
  assert.equal(transferOf(b.db, o2).status, 'auto');
});
