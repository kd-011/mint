// (c) Recurring: subscriptions and bills by merchant + cadence + amount,
// price rises, next expected dates. (d) Unusual charges, conservative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book, monthsBack } from './fixtures/book.mjs';
import { detectRecurring } from '../lib/recurring.mjs';
import { detectUnusual } from '../lib/unusual.mjs';
import { matchTransfers } from '../lib/transfers.mjs';
import { applyRules } from '../lib/categorise.mjs';

const TODAY = '2026-10-17';
const find = (list, key) => list.find((r) => r.merchant_key === key);

test('monthly subscription with next expected date', () => {
  const b = book();
  for (let n = 6; n >= 1; n--) b.add('acct_t_card', monthsBack('2026-10-15', n), -1599, 'TESTFLIX.COM          TESTVILLE    AU');
  b.add('acct_t_card', '2026-10-15', -1599, 'TESTFLIX.COM          TESTVILLE    AU');
  const s = find(detectRecurring(b.db, TODAY), 'testflix com');
  assert.ok(s, 'found');
  assert.equal(s.cadence, 'monthly');
  assert.equal(s.amount, 1599);
  assert.equal(s.count, 7);
  assert.equal(s.last_date, '2026-10-15');
  assert.equal(s.next_date, '2026-11-15');
  assert.equal(s.active, true);
  assert.equal(s.price_rise, null);
  assert.equal(s.is_new, false);
});

test('price rise is detected on the latest charge', () => {
  const b = book();
  for (let n = 5; n >= 1; n--) b.add('acct_t_card', monthsBack('2026-10-03', n), -1599, 'TESTMUSIC');
  b.add('acct_t_card', '2026-10-03', -1799, 'TESTMUSIC');
  const s = find(detectRecurring(b.db, TODAY), 'testmusic');
  assert.equal(s.cadence, 'monthly');
  assert.deepEqual(s.price_rise, { from: 1599, to: 1799, date: '2026-10-03' });
  assert.equal(s.amount, 1799);
});

test('weekly fixed charge and a yearly renewal', () => {
  const b = book();
  for (let d = 0; d < 8; d++) b.add('acct_t_everyday', new Date(Date.UTC(2026, 7, 28 + 7 * d)).toISOString().slice(0, 10), -2495, 'TEST GYM DD');
  b.add('acct_t_card', '2025-03-02', -9900, 'TEST DOMAIN RENEWAL');
  b.add('acct_t_card', '2026-03-02', -9900, 'TEST DOMAIN RENEWAL');
  const list = detectRecurring(b.db, TODAY);
  assert.equal(find(list, 'test gym dd').cadence, 'weekly');
  const y = find(list, 'test domain renewal');
  assert.equal(y.cadence, 'yearly');
  assert.equal(y.next_date, '2027-03-02');
});

test('varied grocery shops, lapsed subscriptions and transfers are not live subscriptions', () => {
  const b = book();
  const amounts = [-8123, -4410, -12999, -6650, -9020, -3105, -15060, -7777];
  amounts.forEach((a, i) => b.add('acct_t_everyday', new Date(Date.UTC(2026, 7, 20 + 7 * i)).toISOString().slice(0, 10), a, 'TEST SUPERMARKET'));
  for (let n = 12; n >= 6; n--) b.add('acct_t_card', monthsBack('2026-10-10', n), -999, 'OLD TESTAPP');
  for (let n = 6; n >= 0; n--) {
    b.add('acct_t_everyday', monthsBack('2026-10-01', n), -100000, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_OUT' });
    b.add('acct_t_savings', monthsBack('2026-10-01', n), 100000, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_IN' });
  }
  matchTransfers(b.db);
  applyRules(b.db);
  const list = detectRecurring(b.db, TODAY);
  assert.equal(find(list, 'test supermarket'), undefined);
  assert.equal(find(list, 'old testapp')?.active ?? false, false);
  assert.equal(find(list, 'linked acc trns'), undefined);
});

test('a brand new monthly subscription shows up after its second identical charge', () => {
  const b = book();
  b.add('acct_t_card', '2026-09-08', -2200, 'TESTSTREAM PREMIUM');
  b.add('acct_t_card', '2026-10-08', -2200, 'TESTSTREAM PREMIUM');
  b.add('acct_t_card', '2026-09-01', -550, 'TEST COFFEE');
  b.add('acct_t_card', '2026-10-01', -550, 'TEST COFFEE'); // under the minimum for a two-charge series
  const list = detectRecurring(b.db, TODAY);
  const s = find(list, 'teststream premium');
  assert.equal(s.cadence, 'monthly');
  assert.equal(s.count, 2);
  assert.equal(s.is_new, true);
  assert.equal(find(list, 'test coffee'), undefined);
});

test('unusual: a never-seen merchant over the threshold', () => {
  const b = book();
  const big = b.add('acct_t_card', '2026-10-15', -45000, 'TEST LUXURY GOODS');
  b.add('acct_t_card', '2026-10-15', -4500, 'TEST SMALL NEW SHOP');
  b.add('acct_t_card', '2026-09-01', -60000, 'TEST OLD BIG ONE'); // outside the recent window
  b.add('acct_t_card', '2026-10-15', 90000, 'TEST REFUND BIG'); // money in is never unusual
  b.add('acct_t_card', '2026-10-16', -90000, 'TEST PENDING BIG', { status: 'pending' });
  const list = detectUnusual(b.db, TODAY);
  assert.deepEqual(list.map((u) => [u.transaction_id, u.reason]), [[big, 'new_merchant']]);
});

test('unusual: well above the merchant norm, not a normal spread', () => {
  const b = book();
  [2000, 2200, 1900, 2500, 2100, 2300].forEach((a, i) => b.add('acct_t_everyday', `2026-0${3 + i}-10`, -a, 'TEST TAKEAWAY'));
  const spike = b.add('acct_t_everyday', '2026-10-14', -15000, 'TEST TAKEAWAY');
  b.add('acct_t_everyday', '2026-10-15', -3500, 'TEST TAKEAWAY');
  const list = detectUnusual(b.db, TODAY);
  assert.equal(list.length, 1);
  assert.equal(list[0].transaction_id, spike);
  assert.equal(list[0].reason, 'above_norm');
  assert.equal(list[0].norm, 2150);
});

test('unusual: transfers never flag', () => {
  const b = book();
  b.add('acct_t_everyday', '2026-10-15', -500000, 'ONLINE BIG MOVE', { provider_category: 'TRANSFER_OUT' });
  b.add('acct_t_savings', '2026-10-15', 500000, 'ONLINE BIG MOVE', { provider_category: 'TRANSFER_IN' });
  b.add('acct_t_everyday', '2026-10-15', -300000, 'TEST CARD PAYMENT', { provider_category: 'TRANSFER_OUT' });
  matchTransfers(b.db);
  applyRules(b.db);
  assert.deepEqual(detectUnusual(b.db, TODAY), []);
});

test('pay-in-4 instalments are not a subscription', () => {
  const b = book();
  for (let i = 1; i <= 4; i++) b.add('acct_t_everyday', new Date(Date.UTC(2026, 8, 1 + 14 * (i - 1))).toISOString().slice(0, 10), -2500, `TESTSHOP.COM 2026-09-01 ${i} of 4`);
  assert.equal(detectRecurring(b.db, TODAY).length, 0);
});

test('unusual: not flagged when the merchant has charged as much before', () => {
  const b = book();
  [2000, 2200, 1900, 18000, 2100, 2300].forEach((a, i) => b.add('acct_t_everyday', `2026-0${3 + i}-10`, -a, 'TEST FUEL'));
  b.add('acct_t_everyday', '2026-10-14', -17000, 'TEST FUEL');
  assert.deepEqual(detectUnusual(b.db, TODAY), []);
});

// detection that tolerates the owner's Subscriptions category
// A merchant whose rows the owner (or a rule) filed under Subscriptions is a
// candidate with a looser test: price points that alternate, amounts that
// drift up to about 35%, two charges are enough. Everything else keeps the
// strict test above. Invented merchants and amounts only.

const subCat = (b, id) => b.db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(b.cat('Subscriptions'), id);
const addSub = (b, date, cents, desc, acct = 'acct_t_card') => subCat(b, b.add(acct, date, -cents, desc));
const addCat = (b, name, date, cents, desc, acct = 'acct_t_everyday', extra = {}) => {
  const id = b.add(acct, date, -cents, desc, extra);
  b.db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(b.cat(name), id);
  return id;
};
const all = (list, key) => list.filter((r) => r.merchant_key === key);

test('Subscriptions: two price points on two billing days are two series', () => {
  const b = book();
  for (let n = 8; n >= 0; n--) addSub(b, monthsBack('2026-10-09', n), 300, 'TESTSOFT');
  for (let n = 8; n >= 1; n--) addSub(b, monthsBack('2026-10-18', n), 1600, 'TESTSOFT');
  const found = all(detectRecurring(b.db, TODAY), 'testsoft').filter((r) => r.active);
  assert.deepEqual(found.map((r) => [r.amount, r.cadence, r.next_date, r.kind]).sort((x, y) => x[0] - y[0]), [
    [300, 'monthly', '2026-11-09', 'subscription'],
    [1600, 'monthly', '2026-10-18', 'subscription'],
  ]);
});

test('Subscriptions: a monthly charge with an extra top-up mid-month is still monthly', () => {
  const b = book();
  addSub(b, '2025-09-01', 1687, 'TESTAI');
  addSub(b, '2026-09-07', 3000, 'TESTAI');
  addSub(b, '2026-10-07', 3000, 'TESTAI');
  addSub(b, '2026-10-16', 3192, 'TESTAI');
  const [s] = all(detectRecurring(b.db, TODAY), 'testai').filter((r) => r.active);
  assert.ok(s, 'found');
  assert.equal(s.cadence, 'monthly');
  assert.equal(s.next_date, '2026-11-07');
  assert.equal(s.amount, 3000);
  assert.equal(s.is_new, false);
});

test('Subscriptions: two charges a month apart are enough, even at different prices', () => {
  const b = book();
  addSub(b, '2026-09-07', 963, 'TESTWORK SPACE');
  addSub(b, '2026-10-05', 1298, 'TESTWORK SPACE');
  const [s] = all(detectRecurring(b.db, TODAY), 'testwork space');
  assert.equal(s.cadence, 'monthly');
  assert.equal(s.active, true);
  assert.equal(s.next_date, '2026-11-05');
  assert.equal(s.count, 2);
});

test('Subscriptions: usage-priced service within about 35% of its norm', () => {
  const b = book();
  [2000, 2700, 1500, 2500, 2200].forEach((c, i) => addSub(b, monthsBack('2026-10-03', 4 - i), c, 'TESTAPI USAGE'));
  const [s] = all(detectRecurring(b.db, TODAY), 'testapi usage');
  assert.equal(s.cadence, 'monthly');
  assert.equal(s.active, true);
  assert.equal(s.variable, true);
  assert.equal(s.price_rise, null, 'a drifting bill is not a price rise');
});

test('the same shapes outside Subscriptions stay out: strict test unchanged', () => {
  const b = book();
  b.add('acct_t_card', '2026-09-07', -963, 'TESTSHOP ONE');
  b.add('acct_t_card', '2026-10-05', -1298, 'TESTSHOP ONE');
  [2000, 2700, 1500, 2500, 2200].forEach((c, i) => b.add('acct_t_card', monthsBack('2026-10-03', 5 - i), -c, 'TESTSHOP TWO'));
  const list = detectRecurring(b.db, TODAY);
  assert.equal(find(list, 'testshop one'), undefined);
  assert.equal(find(list, 'testshop two'), undefined);
});

test('Subscriptions: one charge is not a series, and a merchant that stopped is not active', () => {
  const b = book();
  addSub(b, '2026-10-10', 2799, 'TESTONCE');
  for (let n = 9; n >= 5; n--) addSub(b, monthsBack('2026-10-12', n), 2200, 'TESTGONE');
  const list = detectRecurring(b.db, TODAY);
  assert.equal(find(list, 'testonce'), undefined);
  assert.equal(find(list, 'testgone')?.active ?? false, false);
});

test('Subscriptions: Play Store names cut short at different lengths are one service', () => {
  const b = book();
  addSub(b, '2026-07-25', 999, 'GOOGLE TESTTUN        SYDNEY       AU');
  addSub(b, '2026-08-25', 999, 'GOOGLE TESTTUN        SYDNEY       AU');
  addSub(b, '2026-09-28', 999, 'GOOGLE TESTTUNE APP    SYDNEY       AU');
  const live = detectRecurring(b.db, TODAY).filter((r) => r.merchant_key.startsWith('google testtun'));
  assert.equal(live.length, 1);
  assert.equal(live[0].active, true);
  assert.equal(live[0].cadence, 'monthly');
  assert.equal(live[0].next_date, '2026-10-28');
});

test('Subscriptions: the Google Play prefix does not split a service from its direct billing', () => {
  const b = book();
  addSub(b, '2026-07-25', 1699, 'TESTTUBE');
  addSub(b, '2026-08-23', 1699, 'TESTTUBE');
  addSub(b, '2026-09-25', 1699, 'GOOGLE TESTTUBE      SYDNEY       AU');
  const live = detectRecurring(b.db, TODAY).filter((r) => r.merchant_key.endsWith('testtube'));
  assert.equal(live.length, 1);
  assert.equal(live[0].active, true);
  assert.equal(live[0].next_date, '2026-10-25');
});

test('transfers and person-to-person payments are not subscriptions', () => {
  const b = book();
  for (let n = 5; n >= 0; n--) {
    const d = () => new Date(Date.UTC(2026, 9, 10 - 14 * n)).toISOString().slice(0, 10);
    addCat(b, 'Eating out', d(), 3000, 'ONLINE X1234567890 Lunch TESTFAM TF', 'acct_t_everyday', { provider_category: 'FOOD_AND_DRINK' });
    addCat(b, 'Other', d(), 20000, 'Internet Transfer House Savings', 'acct_t_everyday', { provider_category: 'FOOD_AND_DRINK' });
    addCat(b, 'Debt repayments', d(), 25000, 'Loan Instalment To A/C 123456 Test Person', 'acct_t_everyday', { provider_category: 'LOAN_PAYMENTS' });
    addCat(b, 'Parking and tolls', d(), 10500, 'ONLINE Y1234567890 Parking TESTFAM TF', 'acct_t_everyday', { provider_category: 'FOOD_AND_DRINK' });
  }
  for (let n = 6; n >= 1; n--) addCat(b, 'Eating out', monthsBack('2026-10-10', n), 3324, 'TESTCAFE KBENHAVN', 'acct_t_card'); // a fixed coffee habit is not a subscription
  const list = detectRecurring(b.db, TODAY);
  assert.deepEqual(list.filter((r) => r.kind === 'subscription').map((r) => r.merchant_key), []);
  assert.deepEqual(list, []);
});

test('a bill paid by online transfer is still a bill', () => {
  const b = book();
  for (let n = 5; n >= 0; n--) addCat(b, 'Utilities', new Date(Date.UTC(2026, 9, 10 - 14 * n)).toISOString().slice(0, 10), 11500, 'ONLINE Z1234567890 TESTPOWER 1/2 TESTFAM TF', 'acct_t_everyday', { provider_category: 'RENT_AND_UTILITIES' });
  const list = detectRecurring(b.db, TODAY);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'bill');
  assert.equal(list[0].cadence, 'fortnightly');
});

test('existing steady subscription is unchanged by the looser test', () => {
  const b = book();
  for (let n = 7; n >= 1; n--) addSub(b, monthsBack('2026-10-15', n), 1599, 'TESTFLIX.COM          TESTVILLE    AU');
  addSub(b, '2026-10-15', 1599, 'TESTFLIX.COM          TESTVILLE    AU');
  const s = find(detectRecurring(b.db, TODAY), 'testflix com');
  assert.equal(s.cadence, 'monthly');
  assert.equal(s.amount, 1599);
  assert.equal(s.count, 8);
  assert.equal(s.variable ?? false, false);
  assert.equal(s.next_date, '2026-11-15');
});
