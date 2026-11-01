// The doubtful-transfer card shows one amount for an equal pair, and each leg's
// own amount when the two differ (a Wise top-up: the fee and the rate day).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'transactions.js'), 'utf8');
const fn = src.slice(src.indexOf('function transferCardHtml('), src.indexOf('function wireTransferReview('));
const ctx = { esc: String, money: (c) => `$${(c / 100).toFixed(2)}`, dmy: (d) => d, acctText: String, titleCase: String, I: { chevron: '', check: '' } };
vm.createContext(ctx);
vm.runInContext(fn, ctx);
const leg = (amount, name) => ({ amount, date: '2026-10-10', account_name: name, merchant: null, description: 'x' });
const card = (o, i) => vm.runInContext(`transferCardHtml(${JSON.stringify({ id: 1, kind: 'transfer', confidence: 0.8, amount: Math.abs(o.amount), out: o, in: i })})`, ctx);

test('an equal pair shows the amount once', () => {
  const h = card(leg(-100000, 'Everyday'), leg(100000, 'Savings'));
  assert.equal((h.match(/\$1000\.00/g) ?? []).length, 1);
});

test('a cross-currency pair shows what left and what arrived', () => {
  const h = card(leg(-100000, 'Everyday'), leg(98560, 'Wise USD'));
  assert.match(h, /\$1000\.00[\s\S]*\$985\.60/);
  assert.equal((h.match(/class="t2 num"/g) ?? []).length, 2);
});
