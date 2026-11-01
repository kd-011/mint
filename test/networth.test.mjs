// (g) Net worth: account balances plus manual assets (shares, super) minus
// card and loan balances, offset shown against the loan, history from the
// daily snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { netWorth, netWorthHistory, createAsset, updateAsset, addSnapshot, deleteSnapshot, listAssets } from '../lib/networth.mjs';

const loanDetails = JSON.stringify({ lending_rate: '0.0599', loan_details: { offset_account_enabled: true, repayment_type: 'PRINCIPAL_AND_INTEREST' } });

function nwBook() {
  const b = book();
  b.db.prepare("UPDATE accounts SET details_json = ? WHERE id = 'acct_t_loan'").run(loanDetails);
  const shares = createAsset(b.db, { name: 'Test Shares', kind: 'shares' });
  const sup = createAsset(b.db, { name: 'Test Super', kind: 'super' });
  const owe = createAsset(b.db, { name: 'Test Family Loan', kind: 'other', is_liability: true });
  addSnapshot(b.db, shares.id, { date: '2026-09-01', value: 2000000 });
  addSnapshot(b.db, shares.id, { date: '2026-10-01', value: 3000000 });
  addSnapshot(b.db, sup.id, { date: '2026-10-01', value: 8000000 });
  addSnapshot(b.db, owe.id, { date: '2026-10-01', value: 100000 });
  return { b, shares, sup, owe };
}

test('totals: cash and manual assets less card, loan and manual liabilities', () => {
  const { b } = nwBook();
  b.db.prepare("UPDATE accounts SET hidden = 1 WHERE id = 'acct_t_biz'").run();
  const nw = netWorth(b.db);
  const cash = 100000 + 500000 + 2500000;
  assert.equal(nw.assets, cash + 3000000 + 8000000);
  assert.equal(nw.liabilities, 50000 + 40000000 + 100000);
  assert.equal(nw.net_worth, nw.assets - nw.liabilities);
  assert.equal(nw.groups.cash, cash);
  assert.equal(nw.groups.cards, -50000);
  assert.equal(nw.groups.loans, -40000000);
  assert.equal(nw.groups.investments, 11000000);
  assert.ok(!nw.accounts.some((a) => a.id === 'acct_t_biz'));
  assert.equal(nw.manual.find((m) => m.name === 'Test Shares').value, 3000000);
  assert.equal(nw.manual.find((m) => m.name === 'Test Shares').as_of, '2026-10-01');
});

test('the offset account is shown against its loan', () => {
  const { b } = nwBook();
  const [loan] = netWorth(b.db).loans;
  assert.equal(loan.id, 'acct_t_loan');
  assert.equal(loan.owing, 40000000);
  assert.deepEqual(loan.offsets.map((o) => o.id), ['acct_t_offset']);
  assert.equal(loan.offset_total, 2500000);
  assert.equal(loan.net_owing, 37500000);
  assert.equal(loan.lending_rate, '0.0599');
});

test('history carries each account and asset forward from its last snapshot', () => {
  const { b, shares } = nwBook();
  const snap = b.db.prepare('INSERT INTO balance_snapshots (account_id, date, current) VALUES (?, ?, ?)');
  snap.run('acct_t_everyday', '2026-09-01', 100000);
  snap.run('acct_t_card', '2026-09-01', -20000);
  snap.run('acct_t_everyday', '2026-09-02', 90000); // card has no row this day: carried
  snap.run('acct_t_card', '2026-09-03', -30000);
  b.db.prepare('DELETE FROM manual_snapshots WHERE asset_id != ?').run(shares.id);
  const h = netWorthHistory(b.db, { from: '2026-09-01', to: '2026-09-03' });
  assert.deepEqual(h.map((p) => [p.date, p.net_worth]), [
    ['2026-09-01', 100000 - 20000 + 2000000],
    ['2026-09-02', 90000 - 20000 + 2000000],
    ['2026-09-03', 90000 - 30000 + 2000000],
  ]);
});

test('asset and snapshot validation', () => {
  const b = book();
  const bad = (fn, status = 400) => assert.throws(fn, (e) => e.status === status);
  bad(() => createAsset(b.db, { name: '', kind: 'shares' }));
  bad(() => createAsset(b.db, { name: 'X', kind: 'crypto-moonshot' }));
  const a = createAsset(b.db, { name: 'Test Super', kind: 'super' });
  bad(() => addSnapshot(b.db, a.id, { date: '2026-13-01', value: 1 }));
  bad(() => addSnapshot(b.db, a.id, { date: '2026-10-01', value: 1.5 }));
  bad(() => addSnapshot(b.db, 999, { date: '2026-10-01', value: 1 }), 404);
  addSnapshot(b.db, a.id, { date: '2026-10-01', value: 100 });
  addSnapshot(b.db, a.id, { date: '2026-10-01', value: 200 }); // same day replaces
  assert.equal(listAssets(b.db)[0].value, 200);
  assert.equal(updateAsset(b.db, a.id, { archived: true }).archived, 1);
  deleteSnapshot(b.db, a.id, '2026-10-01');
  assert.equal(listAssets(b.db, { includeArchived: true })[0].value, null);
});

test('property is an investment: it counts in groups.investments, other_assets stays 0, and net worth does not move', () => {
  const { b } = nwBook();
  const before = netWorth(b.db);
  const home = createAsset(b.db, { name: 'Test Home', kind: 'property' });
  const car = createAsset(b.db, { name: 'Test Car', kind: 'vehicle' });
  const misc = createAsset(b.db, { name: 'Test Misc', kind: 'other' });
  addSnapshot(b.db, home.id, { date: '2026-10-01', value: 78741700 });
  addSnapshot(b.db, car.id, { date: '2026-10-01', value: 2000000 });
  addSnapshot(b.db, misc.id, { date: '2026-10-01', value: 5000 });
  const nw = netWorth(b.db);
  assert.equal(nw.groups.investments, before.groups.investments + 78741700 + 2000000 + 5000);
  assert.equal(nw.groups.other_assets, 0, 'the key stays for readers of the old shape, but nothing lands in it');
  assert.equal(nw.net_worth, before.net_worth + 78741700 + 2000000 + 5000);
  const g = nw.groups;
  assert.equal(g.cash + g.cards + g.loans + g.investments + g.other_assets + g.other_liabilities, nw.net_worth - 0, 'the groups still add up to net worth');
});

test('a manual liability stays in other_liabilities', () => {
  const { b } = nwBook();
  assert.equal(netWorth(b.db).groups.other_liabilities, -100000);
});

test('manual assets and net worth accounts carry their sort, so the Home list can order them', () => {
  const { b } = nwBook();
  const a = createAsset(b.db, { name: 'Second', kind: 'property' });
  const c = createAsset(b.db, { name: 'Third', kind: 'property' });
  assert.ok(c.sort > a.sort, 'a new asset goes to the end');
  addSnapshot(b.db, a.id, { date: '2026-10-01', value: 1 });
  const nw = netWorth(b.db);
  assert.equal(typeof nw.manual.find((m) => m.name === 'Second').sort, 'number');
  assert.equal(nw.holdings.sort, 0);
});
