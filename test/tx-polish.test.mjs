// Transactions screen polish: the row subline, the short account label, and the
// summary strip. Pure helpers in public/ux-model.js; the page only draws them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UxModel: M } = require('../public/ux-model.js');

const tx = (o) => ({ id: String(Math.random()), amount: -1000, status: 'posted', category: 'Groceries', category_kind: 'expense', transfer: null, ...o });

test('countsInTotals leaves out settled transfers and transfer categories, keeps ones under review', () => {
  assert.equal(M.countsInTotals(tx({})), true);
  assert.equal(M.countsInTotals(tx({ transfer: { kind: 'transfer', status: 'confirmed' } })), false);
  assert.equal(M.countsInTotals(tx({ transfer: { kind: 'transfer', status: 'auto' } })), false);
  assert.equal(M.countsInTotals(tx({ category_kind: 'transfer' })), false);
  assert.equal(M.countsInTotals(tx({ transfer: { kind: 'transfer', status: 'review' } })), true);
  // on one account every row counts
  assert.equal(M.countsInTotals(tx({ transfer: { kind: 'transfer', status: 'confirmed' } }), { account: true }), true);
  assert.equal(M.countsInTotals(tx({ category_kind: 'transfer' }), { account: true }), true);
  assert.equal(M.countsInTotals(tx({ transfer: { kind: 'transfer', status: 'confirmed' } }), { account: false }), false);
});

test('accountShort keeps short names and shrinks long product names to bank and last four', () => {
  const a = (o) => ({ name: 'Spendings 1334', nickname: null, institution: 'NATIONAL AUSTRALIA BANK', number_masked: 'xxxx1334', ...o });
  assert.equal(M.accountShort(a()), 'Spendings 1334');
  assert.equal(M.accountShort(a({ nickname: 'Everyday' })), 'Everyday');
  assert.equal(M.accountShort(a({ name: 'Bankwest Zero Platinum Mastercard', institution: 'Bankwest', number_masked: 'xxxx9671' })), 'Bankwest 9671');
  assert.equal(M.accountShort(a({ name: 'Easy Transaction Account', institution: 'Bankwest', number_masked: 'xxxx4710' })), 'Bankwest 4710');
  // a long name with no number to lean on stays whole (CSS ellipsis does the rest)
  assert.equal(M.accountShort(a({ name: 'Some Very Long Manual Account', institution: 'Manual', number_masked: null })), 'Some Very Long Manual Account');
  assert.equal(M.accountShort(null), '');
});

test('subline leads with the category, adds the account only when it says something', () => {
  assert.deepEqual(M.txSubline(tx({ category: 'Takeaway and delivery' }), { account: 'Spendings 1334', showAccount: true }), { lead: 'Takeaway and delivery', account: 'Spendings 1334' });
  assert.deepEqual(M.txSubline(tx({ category: 'Groceries' }), { account: 'Spendings 1334', showAccount: false }), { lead: 'Groceries', account: '' });
  assert.equal(M.txSubline(tx({ category: null }), { account: 'X', showAccount: false }).lead, 'Not filed');
});

test('a settled transfer reads as a transfer and always names its account', () => {
  const t = tx({ category: 'Transfers', transfer: { kind: 'transfer', status: 'confirmed' } });
  assert.deepEqual(M.txSubline(t, { account: 'Income 2509', showAccount: false }), { lead: 'Transfer', account: 'Income 2509' });
  assert.equal(M.txSubline(tx({ transfer: { kind: 'card_repayment', status: 'auto' } }), { account: 'A', showAccount: true }).lead, 'Card repayment');
  assert.equal(M.txSubline(tx({ transfer: { kind: 'loan_repayment', status: 'auto' } }), { account: 'A', showAccount: true }).lead, 'Loan repayment');
  // one still waiting for review is a normal row with a prompt chip, not a muted one
  assert.equal(M.txSubline(tx({ category: 'Transfers', transfer: { kind: 'transfer', status: 'review' } }), { account: 'A', showAccount: false }).lead, 'Transfers');
});

test('rowFlags: pending and settled transfers get no chip, the rest are icons', () => {
  assert.deepEqual(M.txRowFlags(tx({ status: 'pending' })), { pending: true, muted: false, chips: [] });
  assert.deepEqual(M.txRowFlags(tx({ transfer: { kind: 'transfer', status: 'confirmed' } })), { pending: false, muted: true, chips: [] });
  const f = M.txRowFlags(tx({ transfer: { kind: 'transfer', status: 'review' }, tax: { ato_category: 'D5' }, receipts: 2, business: true }));
  assert.equal(f.muted, false);
  assert.deepEqual(f.chips, ['review', 'tax', 'receipt']);
  assert.deepEqual(M.txRowFlags(tx({ business: true })).chips, ['business']);
  // business on a settled transfer is noise
  assert.deepEqual(M.txRowFlags(tx({ business: true, transfer: { kind: 'transfer', status: 'confirmed' } })).chips, []);
});

test('summary adds up in and out, leaves transfers out, counts every row', () => {
  const items = [
    tx({ amount: 25000 }),
    tx({ amount: -525 }),
    tx({ amount: -13027 }),
    tx({ amount: -8000, transfer: { kind: 'transfer', status: 'confirmed' } }),
    tx({ amount: 8000, transfer: { kind: 'transfer', status: 'confirmed' } }),
    tx({ amount: -100, category_kind: 'transfer' }),
  ];
  assert.deepEqual(M.txSummary(items), { count: 6, inCents: 25000, outCents: 13552, net: 11448, transfers: 3, movedOutCents: 0 });
  assert.deepEqual(M.txSummary([]), { count: 0, inCents: 0, outCents: 0, net: 0, transfers: 0, movedOutCents: 0 });
});

test('summary matches the day net the list already shows', () => {
  const day = [tx({ amount: 25000 }), tx({ amount: -525 }), tx({ amount: -8000, transfer: { kind: 'transfer', status: 'confirmed' } })];
  const dayNet = day.filter(M.countsInTotals).reduce((s, t) => s + t.amount, 0);
  assert.equal(M.txSummary(day).net, dayNet);
});

test('summary line: singular, partial while more pages load, transfers noted', () => {
  const fmt = (c) => `$${(c / 100).toFixed(2)}`;
  const s = (o) => M.summaryParts({ count: 1, inCents: 0, outCents: 500, net: -500, transfers: 0, ...o }, { more: false, fmt });
  assert.deepEqual(s({}), { count: '1 transaction', in: '$0.00', out: '$5.00', moved: '', note: '' });
  assert.equal(s({ count: 42 }).count, '42 transactions');
  assert.equal(s({ transfers: 1 }).note, '1 transfer not counted');
  assert.equal(s({ transfers: 4 }).note, '4 transfers not counted');
  const partial = M.summaryParts({ count: 100, inCents: 1, outCents: 1, net: 0, transfers: 0 }, { more: true, fmt });
  assert.equal(partial.count, '100+ transactions');
  assert.match(partial.note, /loading/i);
});

test('filtered to one account, transfers count and the moved-out figure shows what left as a transfer', () => {
  const items = [
    tx({ amount: 500000 }),
    tx({ amount: -525 }),
    tx({ amount: -200000, transfer: { kind: 'transfer', status: 'confirmed' } }),
    tx({ amount: -30000, category_kind: 'transfer' }),
    tx({ amount: 10000, transfer: { kind: 'transfer', status: 'auto' } }),
  ];
  const s = M.txSummary(items, { account: true });
  assert.deepEqual(s, { count: 5, inCents: 510000, outCents: 230525, net: 279475, transfers: 0, movedOutCents: 230000 });
  assert.equal(s.inCents - s.outCents, items.reduce((n, t) => n + t.amount, 0));
  // unfiltered keeps leaving them out
  const all = M.txSummary(items);
  assert.deepEqual(all, { count: 5, inCents: 500000, outCents: 525, net: 499475, transfers: 3, movedOutCents: 0 });
});

test('summary wording: moved out only when there is something, transfers note only when they are left out', () => {
  const fmt = (c) => `$${(c / 100).toFixed(2)}`;
  const base = { count: 5, inCents: 100, outCents: 200, net: -100, transfers: 0 };
  assert.equal(M.summaryParts({ ...base, movedOutCents: 0 }, { fmt }).moved, '');
  assert.equal(M.summaryParts({ ...base, movedOutCents: 150 }, { fmt }).moved, '$1.50');
  assert.equal(M.summaryParts({ ...base, movedOutCents: 150 }, { fmt }).note, '');
  assert.equal(M.summaryParts({ ...base, transfers: 2 }, { fmt }).note, '2 transfers not counted');
});

// Row marks are plain, not capsules (Owner, 2026-10-22). txMarks is pulled out of transactions.js and run with stub helpers.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const txSrc = readFileSync(new URL('../public/transactions.js', import.meta.url), 'utf8');
const marks = (() => {
  const code = txSrc.slice(txSrc.indexOf('const ROW_MARK'), txSrc.indexOf('// showAccount: false'));
  const ctx = { esc: (s) => String(s), I: new Proxy({}, { get: (_, k) => `<svg data-i="${String(k)}"></svg>` }) };
  vm.createContext(ctx);
  return vm.runInContext(`${code}; txMarks`, ctx);
})();

test('a row with deductible, business and receipt shows one muted icon and says all three to a screen reader', () => {
  const h = marks(['business', 'tax', 'receipt']);
  assert.equal((h.match(/<svg/g) ?? []).length, 1);
  assert.match(h, /data-i="tag"/);
  assert.match(h, /<span class="sr">Deductible, Business, Receipt attached<\/span>/);
  assert.doesNotMatch(h, /class="chip/);
});

test('a transfer waiting for review keeps its words, in plain amber text; a plain row shows nothing', () => {
  assert.equal(marks(['review']), '<span class="tf warn">Check transfer</span>');
  assert.equal(marks([]), '');
});

test('the Transactions screen draws no .chip capsule per row or in the transfer card', () => {
  assert.doesNotMatch(txSrc.slice(txSrc.indexOf('function txRowButton'), txSrc.indexOf('const dayHeadHtml')), /class="chip/);
  assert.match(txSrc, /class="xkind"/);
  assert.doesNotMatch(txSrc, /ROW_CHIP|txChip/);
});

test('the plain-Transactions styles are scoped, so .chip, .fchip and .pill keep their look elsewhere', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('/* Transactions, plain'));
  const sels = block.split('\n').filter((l) => /\{/.test(l) && !l.startsWith('@') && !l.startsWith('/*')).map((l) => l.split('{')[0].trim());
  for (const s of sels) for (const part of s.split(',')) assert.doesNotMatch(part.trim(), /^\.(chip|fchip|pill)\b/, `unscoped: ${part}`);
});
