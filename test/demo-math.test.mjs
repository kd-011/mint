// Demo mode, the pure side (public/demo-math.js): one global factor scales every
// dollar so the arithmetic on screen stays true, the factor is never near 1,
// shuffle really changes it, off is the identity, and the write guard blocks
// every write that could save a scaled number. No DOM; the same file runs in
// the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const m = createRequire(import.meta.url)(join(ROOT, 'public', 'demo-math.js'));

// A small seeded generator so the draws are repeatable.
const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const ON = (factor) => ({ on: true, factor });
const OFF = { on: false, factor: null };

test('the range is 0.35 to 2.6 with a gap around 1.0', () => {
  assert.equal(m.DEMO_RANGE.min, 0.35);
  assert.equal(m.DEMO_RANGE.max, 2.6);
  assert.ok(m.DEMO_RANGE.gapLo < 1 && m.DEMO_RANGE.gapHi > 1);
  assert.ok(m.DEMO_RANGE.gapLo <= 0.75 && m.DEMO_RANGE.gapHi >= 1.3, 'a factor is never close to 1');
});

test('every factor drawn is in range and never close to 1.0, from both sides of 1', () => {
  const rand = seeded(7);
  let low = 0;
  let high = 0;
  let prev = null;
  for (let i = 0; i < 2000; i++) {
    const f = m.demoPickFactor(prev, rand);
    assert.ok(f >= 0.35 && f <= 2.6, `${f} in range`);
    assert.ok(f <= m.DEMO_RANGE.gapLo || f >= m.DEMO_RANGE.gapHi, `${f} clear of 1.0`);
    assert.ok(Math.abs(f - 1) >= 0.25, `${f} at least 0.25 away from 1`);
    assert.equal(m.demoFactorOk(f), true);
    if (f < 1) low++; else high++;
    prev = f;
  }
  assert.ok(low > 100 && high > 100, 'both bands get used');
});

test('extreme random values still give a valid factor', () => {
  for (const r of [0, 0.0000001, 0.4999, 0.5, 0.5001, 0.9999999]) {
    assert.equal(m.demoFactorOk(m.demoPickFactor(null, () => r)), true, `rand ${r}`);
  }
});

test('demoFactorOk rejects 1, near 1, out of range and junk', () => {
  for (const f of [1, 0.99, 1.1, 0.8, 1.3, 0.2, 3, 0, -2, NaN, Infinity, null, undefined, '2', {}]) assert.equal(m.demoFactorOk(f), false, String(f));
  for (const f of [0.35, 0.5, 0.7, 1.4, 2, 2.6]) assert.equal(m.demoFactorOk(f), true, String(f));
});

test('shuffle always changes the factor, by a lot, and stays valid', () => {
  const rand = seeded(42);
  let s = m.demoTurnOn(OFF, rand);
  for (let i = 0; i < 500; i++) {
    const next = m.demoShuffle(s, rand);
    assert.equal(next.on, true);
    assert.notEqual(next.factor, s.factor);
    const ratio = Math.max(next.factor, s.factor) / Math.min(next.factor, s.factor);
    assert.ok(ratio >= 1.15, `${s.factor} -> ${next.factor} is a visible change`);
    assert.equal(m.demoFactorOk(next.factor), true);
    s = next;
  }
});

test('shuffle with demo off does nothing', () => {
  assert.deepEqual(m.demoShuffle(OFF, seeded(1)), OFF);
});

test('turning on picks a factor, turning off drops it', () => {
  const on = m.demoTurnOn(OFF, seeded(3));
  assert.equal(on.on, true);
  assert.equal(m.demoFactorOk(on.factor), true);
  assert.deepEqual(m.demoTurnOff(on), OFF);
});

test('off is the identity for cents and text', () => {
  for (const c of [0, 1, -1, 123456789, -98765, 5]) assert.equal(m.demoScale(c, OFF), c);
  assert.equal(m.demoScale(null, OFF), null);
  assert.equal(m.demoScaleText('You spent $1,234.56 of $2,000', OFF), 'You spent $1,234.56 of $2,000');
});

test('on: null and undefined pass through, zero stays zero, the sign is kept', () => {
  assert.equal(m.demoScale(null, ON(2)), null);
  assert.equal(m.demoScale(undefined, ON(2)), undefined);
  assert.equal(m.demoScale(0, ON(2)), 0);
  assert.equal(m.demoScale(-1000, ON(2)), -2000);
  assert.equal(m.demoScale(1000, ON(0.5)), 500);
});

test('the scaler is linear: the sum of scaled equals the scaled sum within a cent', () => {
  const rand = seeded(99);
  for (let round = 0; round < 300; round++) {
    const f = m.demoPickFactor(null, rand);
    const s = ON(f);
    const parts = Array.from({ length: 2 + Math.floor(rand() * 12) }, () => Math.round((rand() - 0.4) * 5_000_000));
    const total = parts.reduce((a, b) => a + b, 0);
    const scaledParts = parts.reduce((a, c) => a + m.demoScale(c, s), 0);
    assert.ok(Math.abs(scaledParts - m.demoScale(total, s)) <= 1, `factor ${f}: ${scaledParts} vs ${m.demoScale(total, s)}`);
  }
});

test('ratios survive: a bar at 40 percent is still 40 percent', () => {
  const s = ON(2.37);
  assert.ok(Math.abs(m.demoScale(4000, s) / m.demoScale(10000, s) - 0.4) < 1e-9);
});

test('demoParse reads the stored value and falls back to off on anything wrong', () => {
  assert.deepEqual(m.demoParse(JSON.stringify({ on: true, factor: 1.9 })), ON(1.9));
  assert.deepEqual(m.demoParse({ on: true, factor: 1.9 }), ON(1.9));
  for (const bad of [null, undefined, '', 'nope', '{', '[]', '{"on":true}', '{"on":true,"factor":1}', '{"on":true,"factor":50}', '{"on":"yes","factor":2}', 42]) {
    assert.deepEqual(m.demoParse(bad), OFF, String(bad));
  }
  assert.deepEqual(m.demoParse({ on: false, factor: 2 }), OFF);
});

test('demoScaleText scales dollar amounts in a server sentence and keeps its shape', () => {
  const s = ON(2);
  assert.equal(m.demoScaleText('$1,234.56 on 05/10/2026 on Bankwest, usually about $20.00', s), '$2,469.12 on 05/10/2026 on Bankwest, usually about $40.00');
  assert.equal(m.demoScaleText('Without it the levy would add $1,500.', s), 'Without it the levy would add $3,000.');
  assert.equal(m.demoScaleText('A -$400 loss', s), 'A -$800 loss');
  assert.equal(m.demoScaleText('-$1,000.50 left', ON(0.5)), '-$500.25 left');
  assert.equal(m.demoScaleText('day 3 of 14, 35% used', s), 'day 3 of 14, 35% used');
  assert.equal(m.demoScaleText('', s), '');
  assert.equal(m.demoScaleText(null, s), null);
});

test('demoMask hides account numbers, last-4 digits and BSBs but leaves words', () => {
  assert.equal(m.demoMask('xxxx4710'), 'xxxx••••');
  assert.equal(m.demoMask('Income 2509'), 'Income ••••');
  assert.equal(m.demoMask('Emergency Fund 4402'), 'Emergency Fund ••••');
  assert.equal(m.demoMask('BSB 123-456 acct 12345678'), 'BSB •••-••• acct ••••'); // scan-allow (made-up numbers)
  assert.equal(m.demoMask('Everyday Account'), 'Everyday Account');
  assert.equal(m.demoMask(null), null);
});

test('writes are blocked whenever demo is on, including queued ones', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
    assert.equal(m.demoWriteBlocked({ method, path: '/api/budgets/3', body: { cycle_target: 1 } }, ON(2)), true, method);
    assert.equal(m.demoWriteBlocked({ method, path: '/api/budgets/3' }, OFF), false, `${method} off`);
  }
  assert.equal(m.demoWriteBlocked({ method: 'POST', path: '/api/transactions/abc/receipts', raw: true }, ON(2)), true);
  assert.equal(m.demoWriteBlocked({ method: 'POST', path: '/api/chat', body: { message: 'hi' } }, ON(2)), true, 'chat would leak real numbers');
  assert.equal(m.demoWriteBlocked({ method: 'POST', path: '/api/chat/confirm/abc', body: {} }, ON(2)), true);
});

test('reads and the read-only POSTs are not blocked', () => {
  assert.equal(m.demoWriteBlocked({ method: 'GET', path: '/api/accounts' }, ON(2)), false);
  assert.equal(m.demoWriteBlocked({ path: '/api/accounts' }, ON(2)), false, 'method defaults to GET');
  assert.equal(m.demoWriteBlocked({ method: 'POST', path: '/api/rules/preview', body: {} }, ON(2)), false);
  assert.equal(m.demoWriteBlocked({ method: 'POST', path: '/api/income/sources/preview', body: {} }, ON(2)), false);
  assert.equal(m.demoWriteBlocked({ method: 'POST', path: '/api/budgets/starter', body: { dry_run: true, replace: 'starter' } }, ON(2)), false);
  assert.equal(m.demoWriteBlocked({ method: 'POST', path: '/api/sync', body: {} }, ON(2)), false, 'sync carries nothing from the page');
});

test('the apply half of a preview is still blocked', () => {
  assert.equal(m.demoWriteBlocked({ method: 'POST', path: '/api/budgets/starter', body: { replace: 'starter' } }, ON(2)), true);
  assert.equal(m.demoWriteBlocked({ method: 'POST', path: '/api/budgets/starter' }, ON(2)), true);
  assert.equal(m.demoWriteBlocked({ method: 'POST', path: '/api/rules', body: {} }, ON(2)), true);
  assert.equal(m.demoWriteBlocked({ method: 'POST', path: '/api/rules/preview/../x', body: {} }, ON(2)), true);
});

test('the toast text is the one the owner asked for', () => {
  assert.equal(m.DEMO_BLOCKED_MSG, 'Turn off demo mode to make changes');
});

// ---- made-up balances for empty cash accounts ----

const acct = (over = {}) => ({ id: 'acc_offset', type: 'transaction', balance_current: 0, manual: false, currency: 'AUD', ...over });
const shownDollars = (cents, f) => m.demoScale(cents, ON(f)) / 100;

test('fake balances: off, or an unusable state, fakes nothing', () => {
  assert.equal(m.demoFakeBalance(acct(), OFF), null);
  assert.equal(m.demoFakeBalance(acct(), undefined), null);
  assert.equal(m.demoFakeBalance(acct(), { on: true, factor: 1.02 }), null);
  const list = [acct(), acct({ id: 'b', balance_current: 500 })];
  assert.equal(m.demoAccounts(list, OFF), list, 'off is the identity');
});

test('fake balances: only an empty cash account (transaction or savings, under $1) gets one', () => {
  for (const type of ['transaction', 'savings']) {
    for (const bal of [0, 1, 32, 99]) {
      const fake = m.demoFakeBalance(acct({ type, balance_current: bal }), ON(1.6));
      assert.ok(Number.isInteger(fake) && fake > 100, `${type} ${bal} is faked: ${fake}`);
    }
    for (const bal of [100, 101, 5000, 123456]) assert.equal(m.demoFakeBalance(acct({ type, balance_current: bal }), ON(1.6)), null, `${type} ${bal} is real money`);
  }
  assert.equal(m.demoFakeBalance(acct({ balance_current: null }), ON(1.6)), null, 'no balance yet stays that way');
  assert.equal(m.demoFakeBalance(acct({ balance_current: -2500 }), ON(1.6)), null, 'an overdrawn account is not empty');
});

test('fake balances: loans, credit cards and anything else are never faked', () => {
  for (const type of ['loan', 'credit-card', 'investment', 'mortgage', '', undefined]) {
    assert.equal(m.demoFakeBalance(acct({ type }), ON(1.6)), null, String(type));
  }
  // A foreign-currency manual account has a native balance the AUD figure cannot stand in for.
  assert.equal(m.demoFakeBalance(acct({ manual: true, currency: 'EUR' }), ON(1.6)), null);
  assert.notEqual(m.demoFakeBalance(acct({ manual: true, currency: 'AUD' }), ON(1.6)), null);
});

test('fake balances: believable, not round, and in the right band once the factor is applied', () => {
  for (const f of [0.4, 0.62, 1.5, 2.2, 2.6]) {
    for (let i = 0; i < 60; i++) {
      const tx = shownDollars(m.demoFakeBalance(acct({ id: `tx_${i}` }), ON(f)), f);
      const sv = shownDollars(m.demoFakeBalance(acct({ id: `sv_${i}`, type: 'savings' }), ON(f)), f);
      assert.ok(tx >= 399 && tx <= 6001, `transaction ${tx} at ${f}`);
      assert.ok(sv >= 1999 && sv <= 25001, `savings ${sv} at ${f}`);
      for (const v of [tx, sv]) assert.notEqual(Math.round(v * 100) % 1000, 0, `${v} reads as made up round`);
    }
  }
});

test('fake balances: stable for an account and a factor, different across accounts and on shuffle', () => {
  const a = m.demoFakeBalance(acct(), ON(1.6));
  assert.equal(m.demoFakeBalance(acct(), ON(1.6)), a, 'same account, same factor: same figure on every redraw');
  assert.equal(m.demoFakeBalance(acct({ balance_current: 32 }), ON(1.6)), a, 'it does not depend on the real cents');
  const ids = Array.from({ length: 12 }, (_, i) => `acc_${i}`);
  const at = (f) => ids.map((id) => shownDollars(m.demoFakeBalance(acct({ id }), ON(f)), f));
  assert.ok(new Set(at(1.6)).size > 8, 'accounts do not all show the same figure');
  const before = at(1.6);
  const after = at(0.5);
  assert.ok(before.filter((v, i) => v !== after[i]).length >= 10, 'a new factor gives new figures');
});

test('demoAccounts: swaps the balance of an empty cash account and leaves the rest, and the input, alone', () => {
  const list = [
    acct({ id: 'off', balance_current: 0, balance_available: 0 }),
    acct({ id: 'sav', type: 'savings', balance_current: 32, balance_available: 32 }),
    acct({ id: 'tx', balance_current: 250000, balance_available: 250000 }),
    acct({ id: 'loan', type: 'loan', balance_current: 0 }),
    acct({ id: 'card', type: 'credit-card', balance_current: 0 }),
  ];
  const frozen = JSON.stringify(list);
  const out = m.demoAccounts(list, ON(1.6));
  assert.equal(JSON.stringify(list), frozen, 'real data is never altered');
  assert.equal(out[0].balance_current, m.demoFakeBalance(list[0], ON(1.6)));
  assert.equal(out[0].balance_available, out[0].balance_current, 'available agrees with the balance');
  assert.equal(out[1].balance_current, m.demoFakeBalance(list[1], ON(1.6)));
  assert.equal(out[2], list[2]);
  assert.equal(out[3], list[3]);
  assert.equal(out[4], list[4]);
});

const NW = () => ({
  assets: 3000032, liabilities: 45000000, net_worth: -41999968,
  groups: { cash: 3000032, cards: -100000, loans: -44900000, investments: 0, other_assets: 0, other_liabilities: 0 },
  accounts: [
    { id: 'spend', type: 'transaction', group: 'cash', balance: 3000000, manual: false, currency: 'AUD' },
    { id: 'off', type: 'transaction', group: 'cash', balance: 0, manual: false, currency: 'AUD', offset: true },
    { id: 'sav', type: 'savings', group: 'cash', balance: 32, manual: false, currency: 'AUD' },
    { id: 'card', type: 'credit-card', group: 'cards', balance: -100000, manual: false, currency: 'AUD' },
    { id: 'loan', type: 'loan', group: 'loans', balance: -44900000, manual: false, currency: 'AUD' },
  ],
  manual: [], holdings: { count: 0, value: 0 }, loans: [{ id: 'loan', owing: 44900000, offsets: [{ id: 'off', balance: 0 }], offset_total: 0, net_owing: 44900000 }],
});

test('demoNetWorth: the cash tile and net worth gain exactly what the made-up balances add', () => {
  const real = NW();
  const frozen = JSON.stringify(real);
  const st = ON(1.6);
  const out = m.demoNetWorth(real, st);
  assert.equal(JSON.stringify(real), frozen, 'real data is never altered');
  const fakeOff = m.demoFakeBalance({ id: 'off', type: 'transaction', balance_current: 0 }, st);
  const fakeSav = m.demoFakeBalance({ id: 'sav', type: 'savings', balance_current: 32 }, st);
  const extra = fakeOff + fakeSav - 32;
  assert.equal(out.groups.cash, real.groups.cash + extra);
  assert.equal(out.net_worth, real.net_worth + extra);
  assert.equal(out.assets, real.assets + extra);
  assert.equal(out.liabilities, real.liabilities);
  assert.equal(out.net_worth, out.assets - out.liabilities);
  assert.equal(out.groups.cards, real.groups.cards);
  assert.equal(out.groups.loans, real.groups.loans);
  // The tiles still sum to net worth, scaled or not, and the cash tile is its accounts.
  const cash = out.accounts.filter((a) => a.group === 'cash').reduce((s, a) => s + a.balance, 0);
  assert.equal(cash, out.groups.cash);
  const parts = out.groups.cash + out.groups.cards + out.groups.loans + out.groups.investments + out.groups.other_liabilities;
  assert.equal(parts, out.net_worth);
  // Loans and the offset figures that derive from the real offset are not touched.
  assert.deepEqual(out.loans, real.loans);
  assert.equal(out.accounts.find((a) => a.id === 'loan').balance, -44900000);
  assert.equal(out.accounts.find((a) => a.id === 'card').balance, -100000);
});

test('demoNetWorth: off, or nothing to fake, returns the same object', () => {
  const real = NW();
  assert.equal(m.demoNetWorth(real, OFF), real);
  const full = NW();
  full.accounts = full.accounts.filter((a) => a.id === 'spend' || a.type === 'loan' || a.type === 'credit-card');
  assert.equal(m.demoNetWorth(full, ON(1.6)), full);
  assert.equal(m.demoNetWorth(null, ON(1.6)), null);
});

test('demoNetWorth and demoAccounts agree: the tiles equal the accounts the page lists', () => {
  const st = ON(0.45);
  const real = NW();
  const listed = m.demoAccounts(real.accounts.map((a) => ({ ...a, balance_current: a.balance })), st);
  const out = m.demoNetWorth(real, st);
  for (const a of out.accounts) assert.equal(a.balance, listed.find((x) => x.id === a.id).balance_current, a.id);
  const shownSum = (c) => Math.round(m.demoScale(c, st));
  const tiles = ['cash', 'cards', 'loans'].reduce((s, g) => s + out.groups[g], 0);
  assert.ok(Math.abs(shownSum(tiles) - shownSum(out.net_worth)) <= 1);
});

test('demoSavings and demoGoals: the Save screen balances follow the same made-up figures', () => {
  const st = ON(1.6);
  const accounts = [{ id: 'off', type: 'transaction', balance_current: 0 }, { id: 'sav', type: 'savings', balance_current: 32 }, { id: 'big', type: 'savings', balance_current: 900000 }];
  const fakeOff = m.demoFakeBalance(accounts[0], st);
  const fakeSav = m.demoFakeBalance(accounts[1], st);
  const sv = { total_balance: 900032, accounts: [{ id: 'off', role: 'offset', balance: 0 }, { id: 'sav', role: 'savings', balance: 32 }, { id: 'big', role: 'savings', balance: 900000 }], interest: { month: 5 } };
  const out = m.demoSavings(sv, st, accounts);
  assert.deepEqual(out.accounts.map((a) => a.balance), [fakeOff, fakeSav, 900000]);
  assert.equal(out.total_balance, out.accounts.reduce((s, a) => s + a.balance, 0));
  assert.equal(out.total_balance, 900032 - 32 + fakeOff + fakeSav);
  assert.deepEqual(out.interest, sv.interest);
  assert.equal(sv.accounts[0].balance, 0, 'real data is never altered');
  assert.equal(m.demoSavings(sv, OFF, accounts), sv);
  const goals = [{ id: 1, account_id: 'off', account_balance: 0, progress: 0 }, { id: 2, account_id: 'big', account_balance: 900000 }, { id: 3, account_id: null }];
  const g = m.demoGoals(goals, st, accounts);
  assert.equal(g[0].account_balance, fakeOff);
  assert.equal(g[0].progress, 0, 'progress is a goal figure, not an account balance');
  assert.equal(g[1], goals[1]);
  assert.equal(g[2], goals[2]);
  assert.equal(m.demoGoals(goals, OFF, accounts), goals);
});

test('demoAccountsData: the accounts and the server totals over the visible ones move together', () => {
  const st = ON(1.6);
  const d = {
    accounts: [acct({ id: 'a', balance_current: 250000 }), acct({ id: 'b', balance_current: 0 }), acct({ id: 'h', balance_current: 0, hidden: 1 }), acct({ id: 'l', type: 'loan', balance_current: -1000000 })],
    totals: { assets: 250000, liabilities: 1000000, net_worth: -750000 }, sync: { running: false },
  };
  const frozen = JSON.stringify(d);
  const out = m.demoAccountsData(d, st);
  assert.equal(JSON.stringify(d), frozen, 'real data is never altered');
  const fakeB = m.demoFakeBalance(d.accounts[1], st);
  assert.equal(out.accounts[1].balance_current, fakeB);
  assert.equal(out.totals.assets, 250000 + fakeB, 'a hidden account is not in the totals');
  assert.equal(out.totals.net_worth, -750000 + fakeB);
  assert.equal(out.totals.liabilities, 1000000);
  assert.deepEqual(out.sync, d.sync);
  assert.equal(m.demoAccountsData(d, OFF), d);
});
