// Money that passes through an account on its way somewhere else. The owner pays
// his card from the pay account via a second everyday account: pay -> pass
// -> card, same day, same amount. The split, the suggested plan, the forecast
// and the assistant cycle read must all see that as a move to the card. Plus the
// own-name credit ("MR <FIRST> <MIDDLE> <INITIAL> ... CREDIT TO ACCOUNT") the
// bank files as income, which is the owner's own transfer and must match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, PAY_ACCOUNT } from './fixtures/pay.mjs';
import { applyRules } from '../lib/categorise.mjs';
import { matchTransfers, transferOf } from '../lib/transfers.mjs';
import { setTransactionIncome } from '../lib/income.mjs';
import { setPlan, splitStatus, suggestPlan } from '../lib/plan.mjs';
import { forecast } from '../lib/forecast.mjs';
import { cycleSummary } from '../lib/assistant.mjs';

const PASS = 'acct_t_pass';
const PASS2 = 'acct_t_pass2';
const CARD = 'acct_t_card';

function chainBook() {
  const b = payBook();
  const ins = b.db.prepare(`INSERT INTO accounts (id, connection_id, name, type, institution, number_masked, is_business, balance_current, sort, created_at, updated_at, last_synced_at)
    VALUES (?, 'conn_t_alpha', ?, 'transaction', 'Alpha Bank', ?, 0, 0, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-17T01:00:00.000Z')`);
  ins.run(PASS, 'Pass Test', 'xxxx2001', 10);
  ins.run(PASS2, 'Pass Two Test', 'xxxx2002', 11);
  b.db.prepare('UPDATE accounts SET balance_current = -300000 WHERE id = ?').run(CARD);
  return b;
}

// A linked transfer whose legs share a bank reference, so several of the same
// amount on one day still pair up the right way round.
let ref = 0;
function transfer(b, from, to, date, amount) {
  ref += 1;
  const r = `R${String(ref).padStart(10, '0')}`;
  b.add(from, date, -amount, `ONLINE ${r} Linked Acc Trns`, { provider_category: 'TRANSFER_OUT' });
  b.add(to, date, amount, `ONLINE ${r} Linked Acc Trns`, { provider_category: 'TRANSFER_IN' });
}

const line = (st, id) => st.lines.find((l) => l.account_id === id);

test('two-hop chain: pay -> pass-through -> card on the same day is a move to the card', () => {
  const b = chainBook();
  transfer(b, PAY_ACCOUNT, PASS, '2026-10-07', 200000);
  transfer(b, PASS, CARD, '2026-10-07', 200000);
  refreshMoney(b, '2026-10-12');
  setPlan(b.db, { lines: [{ account_id: CARD, kind: 'debt', amount: 112708 }] });
  const st = splitStatus(b.db, { today: '2026-10-12' });
  assert.deepEqual([line(st, CARD).moved, line(st, CARD).status], [200000, 'done']);
  assert.deepEqual(st.other_moves, []);
  assert.equal(st.status, 'done');
  const c = cycleSummary(b.db, '2026-10-12');
  assert.deepEqual(c.split.lines.map((l) => [l.account, l.moved, l.status]), [['Test Platinum Card', 200000, 'done']]);
  assert.deepEqual(c.split.other_moves, []);
});

test('the suggested plan names the final destination, not the pass-through', () => {
  const b = chainBook();
  for (const d of ['2026-08-26', '2026-09-09', '2026-09-23', '2026-10-07']) {
    transfer(b, PAY_ACCOUNT, PASS, d, 150000);
    transfer(b, PASS, CARD, d, 150000);
  }
  refreshMoney(b, '2026-10-12');
  const s = suggestPlan(b.db, { today: '2026-10-12' });
  assert.deepEqual(s.lines.map((l) => [l.account_id, l.amount, l.seen]), [[CARD, 150000, 4]]);
});

test('a forward a day or two later still counts, one past the window does not', () => {
  const b = chainBook();
  transfer(b, PAY_ACCOUNT, PASS, '2026-10-07', 60000);
  transfer(b, PASS, CARD, '2026-10-09', 60000);
  transfer(b, PAY_ACCOUNT, PASS2, '2026-10-07', 40000);
  transfer(b, PASS2, CARD, '2026-10-11', 40000);
  refreshMoney(b, '2026-10-12');
  setPlan(b.db, { lines: [{ account_id: CARD, kind: 'debt', amount: 100000 }] });
  const st = splitStatus(b.db, { today: '2026-10-12' });
  assert.equal(line(st, CARD).moved, 60000);
  assert.deepEqual(st.other_moves.map((m) => [m.account_id, m.amount]), [[PASS2, 40000]]);
});

test('partial forward: only the amount sent on moves to the card, the rest stays with the pass-through', () => {
  const b = chainBook();
  transfer(b, PAY_ACCOUNT, PASS, '2026-10-07', 200000);
  transfer(b, PASS, CARD, '2026-10-08', 150000);
  refreshMoney(b, '2026-10-12');
  setPlan(b.db, { lines: [{ account_id: CARD, kind: 'debt', amount: 150000 }] });
  const st = splitStatus(b.db, { today: '2026-10-12' });
  assert.deepEqual([line(st, CARD).moved, line(st, CARD).status], [150000, 'done']);
  assert.deepEqual(st.other_moves.map((m) => [m.account_id, m.amount]), [[PASS, 50000]]);
});

test('a forward bigger than what came in only carries what came in, and is not counted twice', () => {
  const b = chainBook();
  transfer(b, PAY_ACCOUNT, PASS, '2026-10-07', 50000);
  transfer(b, PAY_ACCOUNT, PASS, '2026-10-07', 30000);
  transfer(b, PASS, CARD, '2026-10-07', 70000);
  refreshMoney(b, '2026-10-12');
  setPlan(b.db, { lines: [{ account_id: CARD, kind: 'debt', amount: 100000 }] });
  const st = splitStatus(b.db, { today: '2026-10-12' });
  assert.equal(line(st, CARD).moved, 70000);
  assert.deepEqual(st.other_moves.map((m) => [m.account_id, m.amount]), [[PASS, 10000]]);
});

test('loop guard: money sent round in a circle ends where the circle closes, counted once', () => {
  const b = chainBook();
  transfer(b, PAY_ACCOUNT, PASS, '2026-10-07', 100000);
  transfer(b, PASS, PASS2, '2026-10-07', 100000);
  transfer(b, PASS2, PASS, '2026-10-07', 100000);
  transfer(b, PASS, PAY_ACCOUNT, '2026-10-08', 100000);
  refreshMoney(b, '2026-10-12');
  setPlan(b.db, { lines: [{ account_id: CARD, kind: 'debt', amount: 100000 }] });
  const st = splitStatus(b.db, { today: '2026-10-12' });
  const all = [...st.lines.map((l) => l.moved), ...st.other_moves.map((m) => m.amount)].reduce((s, n) => s + n, 0);
  // Out of the pay account: the first hop, and nothing else (the circle back
  // to PASS and on to the pay account itself are not destinations).
  assert.equal(all, 100000);
  assert.deepEqual(st.other_moves.map((m) => [m.account_id, m.amount]), [[PASS2, 100000]]);
});

test('forecast: a card repayment made through the pass-through is not projected again this cycle', () => {
  const b = chainBook();
  setPlan(b.db, { lines: [{ account_id: CARD, kind: 'debt', amount: 80000 }] });
  refreshMoney(b, '2026-10-08');
  const before = forecast(b.db, { today: '2026-10-08' }).items.filter((i) => i.kind === 'card' && i.date === '2026-10-08');
  assert.equal(before.length, 1, 'not moved yet: today carries the repayment');
  transfer(b, PAY_ACCOUNT, PASS, '2026-10-07', 80000);
  transfer(b, PASS, CARD, '2026-10-07', 80000);
  refreshMoney(b, '2026-10-08');
  const after = forecast(b.db, { today: '2026-10-08' }).items.filter((i) => i.kind === 'card' && i.date === '2026-10-08');
  assert.deepEqual(after, []);
});

test('own-name credit filed as income by the bank matches the transfer out of the pay account', () => {
  const b = chainBook();
  const o = b.add(PAY_ACCOUNT, '2026-09-15', -106919, 'TEST PERSON L3000000001', { provider_category: 'TRANSFER_OUT' });
  const i = b.add(PASS, '2026-09-15', 106919, 'MR TEST MIDDLE P 02:09PM 15Sep CREDIT TO ACCOUNT', { provider_category: 'INCOME' });
  transfer(b, PASS, CARD, '2026-09-15', 106919);
  refreshMoney(b, '2026-10-17');
  const t = transferOf(b.db, o);
  assert.ok(t, 'linked');
  assert.equal(t.in_tx, i);
  assert.equal(t.status, 'auto');
  assert.equal(b.row(i).income_kind, null, 'no longer other income');
  setPlan(b.db, { lines: [{ account_id: CARD, kind: 'debt', amount: 100000 }] });
  const h = splitStatus(b.db, { today: '2026-10-17' }).history.find((c) => c.start === '2026-09-09');
  assert.equal(line(h, CARD).moved, 106919);
});

test('own name on wages or a tax refund is still income, never a transfer', () => {
  const b = chainBook();
  b.add('acct_t_savings', '2026-09-16', -212600, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_OUT' });
  const w = b.add(PASS, '2026-09-16', 212600, 'WAGES ROSTER 25 26 TEST PERSON', { provider_category: 'INCOME' });
  b.add('acct_t_savings', '2026-09-17', -93960, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_OUT' });
  const ato = b.add(PASS, '2026-09-17', 93960, 'ATO006000000000000 ATO TEST PERSON', { provider_category: 'INCOME' });
  refreshMoney(b, '2026-10-17');
  assert.equal(transferOf(b.db, w), null);
  assert.equal(transferOf(b.db, ato), null);
});

test('an own-name credit the owner pinned as income stays income', () => {
  const b = chainBook();
  b.add(PAY_ACCOUNT, '2026-09-15', -70000, 'TEST PERSON L3000000002', { provider_category: 'TRANSFER_OUT' });
  const i = b.add(PASS, '2026-09-15', 70000, 'MR TEST MIDDLE P 03:57PM 15Sep CREDIT TO ACCOUNT', { provider_category: 'INCOME' });
  applyRules(b.db);
  setTransactionIncome(b.db, i, { kind: 'other' });
  matchTransfers(b.db);
  assert.equal(transferOf(b.db, i), null);
  assert.equal(b.row(i).income_manual, 1);
});
