// The account page (/account?id=): Home's rows open it, and it opens that one account's transactions, rules
// and config. The facts, status line, gaps and links are pure helpers in public/ux-model.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { UxModel: M } = require('../public/ux-model.js');
const { resolveRoute, SHELL_PATHS } = require('../public/routes.js');

const card = { id: 'acct_c', name: 'Platinum Card', nickname: null, type: 'credit-card', institution: 'Alpha Bank', number_masked: 'xxxx2222', is_business: 0, hidden: 0, status: 'active', balance_current: -50000, balance_available: 950000, balance_observed_at: '2026-10-17T01:00:00Z', last_synced_at: '2026-10-17T01:00:00Z', last_sync_error: null, tx_count: 23, pending_count: 2, earliest_date: '2026-09-01', latest_date: '2026-10-15', backfill_done_at: '2026-09-02T00:00:00Z', rates: { product_name: 'Platinum', lending_rate: '0.1999', deposit_rate: null }, loan: null, manual: false };
const loan = { ...card, id: 'acct_l', name: 'Home Loan', type: 'loan', balance_available: null, rates: { product_name: 'Variable', lending_rate: '0.06', deposit_rate: null }, loan: { repayment_type: 'PRINCIPAL_AND_INTEREST', repayment_frequency: 'P1M', next_instalment_date: '2026-11-01', loan_end_date: '2050-01-01', original_loan_amount: '400000.00', offset_account_enabled: true } };
const facts = (a, o) => Object.fromEntries(M.accountFacts(a, o).map(([k, v]) => [k, v]));

test('the account page is a Home route with Home as its way back, and the shell is served for it', () => {
  const r = resolveRoute('/account', '?id=acct_c');
  assert.equal(r.view, 'account');
  assert.equal(r.tab, 'home');
  assert.equal(r.parent, '/');
  assert.equal(r.parentLabel, 'Home');
  assert.equal(r.redirect, undefined);
  assert.ok(SHELL_PATHS.includes('/account'));
});

test('Home rows open the account page; transactions and rules links are scoped to the account', () => {
  const rows = M.accountRows({ accounts: [{ ...card, id: 'a b' }] });
  assert.equal(rows.sections[0].rows[0].href, '/account?id=a%20b');
  assert.equal(M.accountHref('acct_c'), '/account?id=acct_c');
  assert.equal(M.accountTransactionsHref('acct_c'), '/transactions?account=acct_c');
  assert.equal(M.accountRulesHref('acct_c'), '/accounts?s=rules&account=acct_c');
  assert.equal(resolveRoute('/transactions', '?account=acct_c').view, 'transactions');
  assert.equal(resolveRoute('/accounts', '?s=rules&account=acct_c').view, 'accounts');
});

test('a card shows only what is stored: number, balance, available credit, rate, product', () => {
  const f = facts(card);
  assert.deepEqual(f['Account number'], { t: 'acct', v: 'xxxx2222' });
  assert.deepEqual(f.Balance, { t: 'money', v: -50000 });
  assert.deepEqual(f['Available credit'], { t: 'money', v: 950000 });
  assert.deepEqual(f['Interest rate'], { t: 'pct', v: '0.1999' });
  assert.equal(f.Product.v, 'Platinum');
  assert.equal(f.Institution.v, 'Alpha Bank');
  assert.equal(f['Counts as'].v, 'Personal');
  assert.equal('Credit limit' in f, false, 'a limit Mint does not hold is never invented');
  assert.equal('Next instalment' in f, false);
});

test('a loan adds its repayment terms and the offset, and original amount is in cents', () => {
  const f = facts(loan, { offset: { name: 'Offset', balance_current: 2500000 } });
  assert.equal(f.Repayments.v, 'Principal And Interest, monthly');
  assert.equal(f['Next instalment'].v, '2026-11-01');
  assert.equal(f['Loan ends'].v, '2050-01-01');
  assert.equal(f['Original amount'].v, 40000000);
  assert.deepEqual(f.Offset.v, { name: 'Offset', cents: 2500000 });
  assert.equal(f['Owed net of offset'].v, -50000 + 2500000);
});

test('missing fields are left out, not blanked or made up', () => {
  const f = facts({ id: 'x', name: 'Bare', type: 'transaction', institution: 'Alpha Bank', number_masked: null, balance_current: null, rates: null, loan: null });
  assert.equal('Account number' in f, false);
  assert.equal('Balance' in f, false);
  assert.equal('Interest rate' in f, false);
  assert.equal('Deposit rate' in f, false);
  assert.equal('Last synced' in f, false);
});

test('a manual account in another currency shows its own currency and opening balance', () => {
  const f = facts({ id: 'm', name: 'Wise USD', type: 'transaction', institution: 'Wise', number_masked: null, manual: true, currency: 'USD', balance_current: 150000, balance_native: 100000, opening_balance: 50000, opening_date: '2026-01-01' });
  assert.equal(f.Currency.v, 'USD');
  assert.deepEqual(f['Opening balance'].v, { cents: 50000, currency: 'USD', date: '2026-01-01' });
  assert.deepEqual(f['Balance in USD'].v, { cents: 100000, currency: 'USD' });
  assert.equal('Last synced' in f, false);
});

test('the status line: synced, never synced, failed with the real error, kept by hand, gone', () => {
  const ago = (t) => `ago(${t.slice(0, 10)})`;
  assert.deepEqual(M.accountStatus(card, { ago }), { tone: 'ok', text: 'Synced ago(2026-10-17) · 23 transactions · 2 pending', detail: null });
  assert.equal(M.accountStatus({ ...card, last_synced_at: null }, { ago }).tone, 'warn');
  assert.equal(M.accountStatus({ ...card, last_synced_at: null }, { ago }).text, 'Not synced yet');
  assert.deepEqual(M.accountStatus({ ...card, last_sync_error: 'consent expired (403)' }, { ago }), { tone: 'bad', text: 'Last sync failed', detail: 'consent expired (403)' });
  assert.equal(M.accountStatus({ ...card, manual: true, tx_count: 1, last_synced_at: null }, { ago }).text, 'Kept by hand · 1 transaction');
  assert.equal(M.accountStatus({ ...card, status: 'gone' }, { ago }).tone, 'bad');
});

test('gaps name what Mint does not hold: BSB and notes always, a limit for cards', () => {
  assert.deepEqual(M.accountGaps(card), ['a BSB', 'a credit limit', 'notes']);
  assert.deepEqual(M.accountGaps({ ...loan, rates: null }), ['a BSB', 'an interest rate', 'notes']);
  assert.deepEqual(M.accountGaps({ ...card, type: 'transaction', number_masked: null }), ['an account number', 'a BSB', 'notes']);
  assert.equal(M.gapLine(['a BSB', 'a credit limit', 'notes']), 'Mint does not hold a BSB, a credit limit or notes for this account, so none is shown.');
  assert.equal(M.gapLine(['notes']), 'Mint does not hold notes for this account, so none is shown.');
});

test('rules for one account: those limited to it, and how many apply everywhere', () => {
  const rules = [{ id: 1, account_id: 'acct_c' }, { id: 2, account_id: null }, { id: 3, account_id: 'other' }, { id: 4, account_id: null }];
  const r = M.accountRules(rules, 'acct_c');
  assert.deepEqual(r.mine.map((x) => x.id), [1]);
  assert.equal(r.everywhere, 2);
  assert.equal(M.rulesLine(r), '1 rule for this account · 2 for every account');
  assert.equal(M.rulesLine({ mine: [], everywhere: 0 }), '0 rules for this account');
});

test('the page script is served, and its copy has no em dashes', () => {
  const server = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  assert.match(server, /'accounts\.js', 'account\.js'/);
  for (const f of ['public/account.js', 'public/ux-model.js', 'public/accounts.js']) {
    const added = readFileSync(join(ROOT, f), 'utf8');
    assert.equal(/—|–/.test(added), false, `${f} has an em or en dash`);
  }
});
