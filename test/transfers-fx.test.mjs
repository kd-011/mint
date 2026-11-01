// Cross-currency transfers: an AUD debit and the Wise credit in another currency
// carry different native amounts, but a foreign manual row also stores its AUD
// value at the day's rate (transactions.amount), so the pair is two AUD figures a
// fee and a rate-day apart. The matcher pairs them within a tolerance, never
// touches a row already linked, and never auto-links on money alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { matchTransfers, transferOf, linkTransfer, confirmTransfer, rejectTransfer } from '../lib/transfers.mjs';
import { LINKED } from '../lib/spend.mjs';

const OUT = { provider_category: 'TRANSFER_OUT' };

// A Wise balance: a manual account in its own currency, rows holding native cents plus the AUD value at that day's rate.
function wise(b, id, currency, { balanceId = null } = {}) {
  b.db.prepare("INSERT INTO accounts (id, name, type, institution, currency, manual, wise_balance_id, created_at, updated_at) VALUES (?, ?, 'transaction', 'Wise', ?, 1, ?, 'now', 'now')").run(id, `Wise ${currency}`, currency, balanceId);
  return (date, native, rate, description, extra = {}) => {
    const aud = Math.round(native * rate);
    const t = b.add(id, date, aud, description, { provider_category: null, ...extra });
    b.db.prepare('UPDATE transactions SET currency = ?, amount_native = ?, fx_rate = ?, fx_date = ? WHERE id = ?').run(currency, native, rate, date, t);
    return t;
  };
}

test('a bank top-up to Wise pairs with the USD credit, a fee and a rate-day apart', () => {
  const b = book();
  const usd = wise(b, 'acct_w_usd', 'USD');
  // $1,000.00 AUD out; Wise took its fee and landed USD 640.00 at 1.54 AUD each = $985.60 AUD.
  const o = b.add('acct_t_everyday', '2026-10-10', -100000, 'WISE AUSTRALIA PTY LTD Transfer', OUT);
  const i = usd('2026-10-11', 64000, 1.54, 'Received money from TEST PAYER');
  const r = matchTransfers(b.db);
  assert.equal(r.auto + r.review, 1);
  const t = transferOf(b.db, o);
  assert.equal(t.in_tx, i);
  assert.equal(t.kind, 'transfer');
  assert.equal(t.status, 'auto', 'the bank calls it a transfer and the other side is Wise');
  // Neither leg is spend or income any more.
  const linked = b.db.prepare(`SELECT t.id FROM transactions t WHERE ${LINKED}`).all().map((x) => x.id).sort();
  assert.deepEqual(linked, [o, i].sort());
});

test('a Wise AUD to USD conversion pairs, and the AUD leg is no longer spend', () => {
  const b = book();
  const aud = wise(b, 'acct_w_aud', 'AUD', { balanceId: '1' });
  const usd = wise(b, 'acct_w_usd', 'USD', { balanceId: '2' });
  const o = aud('2026-10-12', -50000, 1, 'Converted 500.00 AUD to USD');
  const i = usd('2026-10-12', 32200, 1.54, 'Converted 500.00 AUD to USD');
  matchTransfers(b.db);
  assert.equal(transferOf(b.db, o)?.in_tx, i);
});

test('equal AUD amounts with no Wise link are not paired across currencies', () => {
  const b = book();
  const usd = wise(b, 'acct_w_usd', 'USD');
  b.add('acct_t_everyday', '2026-10-10', -100000, 'TEST SHOP', { provider_category: 'FOOD_AND_DRINK' });
  usd('2026-10-10', 64935, 1.54, 'Client invoice 114');
  assert.deepEqual(matchTransfers(b.db), { auto: 0, review: 0, scanned: 0 });
});

test('an amount well outside the fee and rate tolerance is not paired', () => {
  const b = book();
  const usd = wise(b, 'acct_w_usd', 'USD');
  const o = b.add('acct_t_everyday', '2026-10-10', -100000, 'WISE AUSTRALIA PTY LTD Transfer', OUT);
  usd('2026-10-10', 55000, 1.54, 'Received money from TEST PAYER'); // $847 AUD, 15% off
  matchTransfers(b.db);
  assert.equal(transferOf(b.db, o), null);
});

test('a purchase-hinted debit against a Wise credit goes to review, not auto', () => {
  const b = book();
  const usd = wise(b, 'acct_w_usd', 'USD');
  const o = b.add('acct_t_everyday', '2026-10-10', -100000, 'WISE AUSTRALIA PTY LTD', { provider_category: 'GENERAL_SERVICES' });
  usd('2026-10-10', 64935, 1.54, 'Received money from TEST PAYER');
  matchTransfers(b.db);
  assert.equal(transferOf(b.db, o)?.status, 'review');
});

test('a row already linked or confirmed is left alone', () => {
  const b = book();
  const usd = wise(b, 'acct_w_usd', 'USD');
  const o = b.add('acct_t_everyday', '2026-10-10', -100000, 'WISE AUSTRALIA PTY LTD Transfer', OUT);
  const s = b.add('acct_t_savings', '2026-10-10', 100000, 'Linked', { provider_category: 'TRANSFER_IN' });
  const link = linkTransfer(b.db, o, s);
  confirmTransfer(b.db, link.id);
  usd('2026-10-10', 64000, 1.54, 'Received money from TEST PAYER');
  matchTransfers(b.db);
  assert.equal(transferOf(b.db, o).in_tx, s);
  assert.equal(b.db.prepare('SELECT count(*) n FROM transfers').get().n, 1);
});

test('a rejected cross-currency pair is not proposed again', () => {
  const b = book();
  const usd = wise(b, 'acct_w_usd', 'USD');
  const o = b.add('acct_t_everyday', '2026-10-10', -100000, 'WISE AUSTRALIA PTY LTD Transfer', OUT);
  usd('2026-10-10', 64000, 1.54, 'Received money from TEST PAYER');
  matchTransfers(b.db);
  rejectTransfer(b.db, transferOf(b.db, o).id);
  matchTransfers(b.db);
  assert.equal(transferOf(b.db, o), null);
});

test('linking a cross-currency pair by hand is allowed inside the tolerance and refused outside it', () => {
  const b = book();
  const usd = wise(b, 'acct_w_usd', 'USD');
  const o = b.add('acct_t_everyday', '2026-10-10', -100000, 'Something', { provider_category: null });
  const near = usd('2026-10-10', 62000, 1.54, 'In'); // 954.80
  const far = usd('2026-10-10', 30000, 1.54, 'In');
  assert.throws(() => linkTransfer(b.db, o, far), (e) => e.status === 400);
  assert.equal(linkTransfer(b.db, o, near).status, 'confirmed');
});

test('AUD pairs are unchanged: still exact', () => {
  const b = book();
  const o = b.add('acct_t_everyday', '2026-10-01', -50000, 'X', OUT);
  b.add('acct_t_savings', '2026-10-02', 49000, 'X', { provider_category: 'TRANSFER_IN' });
  matchTransfers(b.db);
  assert.equal(transferOf(b.db, o), null);
});

test('a Wise USD card purchase is not paired with an unrelated PayID credit or a salary-hinted credit', () => {
  const b = book();
  const usd = wise(b, 'acct_w_usd', 'USD', { balanceId: '2' });
  // USD 32.00 spent on the Wise card at 1.5469 = $49.50 AUD; a friend pays $50.00 in the same days.
  const buy = usd('2026-10-10', -3200, 1.5469, 'Card transaction of 32.00 USD issued by Some Store');
  const friend = b.add('acct_t_everyday', '2026-10-11', 5000, 'PAYID FROM A FRIEND', { provider_category: 'TRANSFER_IN' });
  const pay = b.add('acct_t_savings', '2026-10-12', 5000, 'ACME PTY LTD SALARY', { provider_category: 'INCOME' });
  assert.deepEqual(matchTransfers(b.db), { auto: 0, review: 0, scanned: 0 });
  for (const id of [buy, friend, pay]) assert.equal(transferOf(b.db, id), null);
});

test('a Wise USD credit is not paired with an unrelated TRANSFER_OUT debit that never mentions Wise', () => {
  const b = book();
  const usd = wise(b, 'acct_w_usd', 'USD', { balanceId: '2' });
  const o = b.add('acct_t_everyday', '2026-10-10', -100000, 'ONLINE Linked Acc Trns', OUT);
  usd('2026-10-10', 64000, 1.54, 'Received money from TEST PAYER');
  matchTransfers(b.db);
  assert.equal(transferOf(b.db, o), null);
});
