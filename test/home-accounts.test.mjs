// Home lists every visible account under the net worth hero. The grouping,
// ordering and filtering are pure (public/ux-model.js accountRows), so they are
// tested here without a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UxModel: M } = require('../public/ux-model.js');

const acct = (id, name, type, balance, extra = {}) => ({ id, name, nickname: null, type, institution: 'Alpha Bank', number_masked: '••1234', balance_current: balance, hidden: 0, status: 'active', is_business: 0, logo: null, ...extra });
const nameOf = (a) => a.nickname || a.name;

const accounts = [
  acct('a1', 'Everyday Test', 'transaction', 120000, { number_masked: '••1111' }),
  acct('a2', 'Savings Test', 'transaction', 500000, { institution: 'Beta Mutual', number_masked: '••2222', logo: '/api/logo/bank%3Abeta-mutual?v=abcd1234' }),
  acct('a3', 'Platinum Card', 'credit-card', -50000, { number_masked: '••3333' }),
  acct('a4', 'Home Loan', 'loan', -40000000, { institution: 'Beta Mutual', number_masked: '••4444' }),
  acct('a5', 'Old Account', 'transaction', 100, { hidden: 1 }),
  acct('a6', 'Closed Account', 'transaction', 0, { status: 'gone' }),
];

test('accounts group under Cash, Cards and Loans in that order, hidden and gone ones left out', () => {
  const r = M.accountRows({ accounts }, { name: nameOf });
  assert.deepEqual(r.sections.map((s) => s.label), ['Cash', 'Cards', 'Loans']);
  assert.deepEqual(r.sections.map((s) => s.rows.map((x) => x.id)), [['a1', 'a2'], ['a3'], ['a4']]);
  assert.equal(r.count, 4);
});

test('a row carries the nickname, a quiet institution and number line, the signed balance, the logo and the transactions link', () => {
  const r = M.accountRows({ accounts: [acct('a7', 'Raw Name', 'transaction', -2500, { nickname: 'Rainy day', logo: '/api/logo/x' })] }, { name: nameOf });
  assert.deepEqual(r.sections[0].rows[0], {
    id: 'a7', kind: 'account', type: 'transaction', name: 'Rainy day', sub: 'Alpha Bank · ••1234', institution: 'Alpha Bank',
    balance: -2500, href: '/account?id=a7', logo: '/api/logo/x', sort: 0,
  });
});

test('the sub line drops what is missing and a missing balance stays null', () => {
  const r = M.accountRows({ accounts: [acct('a8', 'No Number', 'transaction', null, { number_masked: null }), acct('a9', 'No Bank', 'transaction', 5, { institution: null })] }, { name: nameOf });
  const [a, b] = r.sections[0].rows;
  assert.equal(a.sub, 'Alpha Bank');
  assert.equal(a.balance, null);
  assert.equal(b.sub, '••1234');
});

test('the name function is applied, so demo mode masking reaches the rows', () => {
  const r = M.accountRows({ accounts }, { name: (a) => `[${a.name}]` });
  assert.equal(r.sections[0].rows[0].name, '[Everyday Test]');
});

test('manual assets and the share portfolio join the list: property is an investment, so there is no Other section', () => {
  const manual = [
    { id: 1, name: 'Super fund', kind: 'super', is_liability: 0, value: 9000000, counted: true },
    { id: 2, name: 'Car', kind: 'vehicle', is_liability: 0, value: 2000000, counted: true },
    { id: 5, name: 'Home (Test Street)', kind: 'property', is_liability: 0, value: 78741700, counted: true },
    { id: 4, name: 'Old shares', kind: 'shares', is_liability: 0, value: 100, counted: false },
  ];
  const r = M.accountRows({ accounts, manual, holdings: { count: 3, value: 700000 } }, { name: nameOf });
  assert.deepEqual(r.sections.map((s) => s.label), ['Cash', 'Cards', 'Loans', 'Investments']);
  assert.ok(!r.sections.some((s) => /other/i.test(s.label)));
  const inv = r.sections[3].rows;
  assert.deepEqual(inv.map((x) => [x.name, x.balance, x.kind, x.sub, x.href]), [
    ['Super fund', 9000000, 'asset', 'Super', '/accounts?s=assets'],
    ['Car', 2000000, 'asset', 'Vehicle', '/accounts?s=assets'],
    ['Home (Test Street)', 78741700, 'asset', 'Property', '/accounts?s=assets'],
    ['Share portfolio', 700000, 'holdings', '3 holdings', '/save'],
  ]);
  assert.equal(r.count, 8);
});

test('a manual debt is never dropped: it gets a small Debts section only when one exists', () => {
  const manual = [{ id: 3, name: 'Personal loan', kind: 'other', is_liability: 1, value: 300000, counted: true }];
  const r = M.accountRows({ accounts, manual }, { name: nameOf });
  assert.deepEqual(r.sections.map((s) => s.label), ['Cash', 'Cards', 'Loans', 'Debts']);
  assert.deepEqual(r.sections[3].rows.map((x) => [x.name, x.balance, x.sub]), [['Personal loan', -300000, 'Debt']]);
  assert.ok(!M.accountRows({ accounts }, { name: nameOf }).sections.some((s) => s.id === 'debts'));
});

test('every counted row amount adds up to what net worth counts (nothing vanishes into a dropped section)', () => {
  const manual = [
    { id: 1, name: 'Super fund', kind: 'super', is_liability: 0, value: 9000000, counted: true },
    { id: 2, name: 'Car', kind: 'vehicle', is_liability: 0, value: 2000000, counted: true },
    { id: 3, name: 'Personal loan', kind: 'other', is_liability: 1, value: 300000, counted: true },
    { id: 5, name: 'Home', kind: 'property', is_liability: 0, value: 50000000, counted: true },
  ];
  const r = M.accountRows({ accounts, manual, holdings: { count: 1, value: 700000 } }, { name: nameOf });
  const sum = r.sections.flatMap((s) => s.rows).reduce((n, x) => n + x.balance, 0);
  assert.equal(sum, 120000 + 500000 - 50000 - 40000000 + 9000000 + 2000000 - 300000 + 50000000 + 700000);
});

// ---------- the order the owner sets ----------

test('rows follow their sort within a section; the section order never changes', () => {
  const a = [
    acct('c1', 'Cash A', 'transaction', 1, { sort: 3 }), acct('c2', 'Cash B', 'transaction', 2, { sort: 1 }), acct('c3', 'Cash C', 'transaction', 3, { sort: 2 }),
    acct('k1', 'Card A', 'credit-card', -1, { sort: 5 }), acct('k2', 'Card B', 'credit-card', -2, { sort: 4 }),
  ];
  const r = M.accountRows({ accounts: a }, { name: nameOf });
  assert.deepEqual(r.sections.map((s) => s.rows.map((x) => x.id)), [['c2', 'c3', 'c1'], ['k2', 'k1']]);
  assert.deepEqual(r.sections.map((s) => s.id), ['cash', 'cards']);
});

test('assets and the share portfolio reorder together inside Investments; ties keep their natural order', () => {
  const manual = [
    { id: 1, name: 'Super fund', kind: 'super', is_liability: 0, value: 9, counted: true, sort: 3 },
    { id: 5, name: 'Home', kind: 'property', is_liability: 0, value: 8, counted: true, sort: 1 },
  ];
  const r = M.accountRows({ accounts: [], manual, holdings: { count: 1, value: 7, sort: 2 } }, { name: nameOf });
  assert.deepEqual(r.sections[0].rows.map((x) => x.id), ['asset_5', 'holdings', 'asset_1']);
  const flat = M.accountRows({ accounts: [], manual: manual.map(({ sort, ...m }) => m), holdings: { count: 1, value: 7 } }, { name: nameOf });
  assert.deepEqual(flat.sections[0].rows.map((x) => x.id), ['asset_1', 'asset_5', 'holdings']);
});

test('moveRow swaps a row with its neighbour inside one section and stops at the ends', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(M.moveRow(ids, 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(M.moveRow(ids, 'b', 1), ['a', 'c', 'b']);
  assert.deepEqual(M.moveRow(ids, 'a', -1), ids);
  assert.deepEqual(M.moveRow(ids, 'c', 1), ids);
  assert.deepEqual(M.moveRow(ids, 'zz', 1), ids);
  assert.deepEqual(ids, ['a', 'b', 'c'], 'the input is not changed');
});

test('orderIds flattens the sections in the order shown, the body the order endpoint takes', () => {
  const list = M.accountRows({ accounts, manual: [{ id: 5, name: 'Home', kind: 'property', is_liability: 0, value: 5, counted: true }] }, { name: nameOf });
  assert.deepEqual(M.orderIds(list), ['a1', 'a2', 'a3', 'a4', 'asset_5']);
});

test('a bank name that arrives in capitals is tidied for display; unknown ones are left alone', () => {
  assert.equal(M.bankName('NATIONAL AUSTRALIA BANK'), 'NAB');
  assert.equal(M.bankName('National Australia Bank'), 'NAB');
  assert.equal(M.bankName('NAB'), 'NAB');
  assert.equal(M.bankName('Bankwest'), 'Bankwest');
  assert.equal(M.bankName('ANZ'), 'ANZ');
  assert.equal(M.bankName('Alpha Bank'), 'Alpha Bank');
  assert.equal(M.bankName('SOME CREDIT UNION'), 'SOME CREDIT UNION');
  assert.equal(M.bankName(null), null);
  const r = M.accountRows({ accounts: [acct('n1', 'Spendings 1334', 'transaction', 1, { institution: 'NATIONAL AUSTRALIA BANK', number_masked: 'xxxx1334' })] }, { name: nameOf });
  assert.equal(r.sections[0].rows[0].sub, 'NAB · xxxx1334');
  assert.equal(r.sections[0].rows[0].institution, 'NATIONAL AUSTRALIA BANK', 'the logo still keys off the real institution');
});

test('an empty book gives no sections and a zero count; holdings with no count are not a row', () => {
  assert.deepEqual(M.accountRows({}, { name: nameOf }), { sections: [], count: 0 });
  assert.deepEqual(M.accountRows({ accounts: [], manual: [], holdings: { count: 0, value: 0 } }, { name: nameOf }), { sections: [], count: 0 });
});
