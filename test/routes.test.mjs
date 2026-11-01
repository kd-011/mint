// Route mapping for the four-tab shell: every old URL still lands somewhere
// sensible, and the tab list the nav draws matches the paths the server serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { MINT_TABS, MORE_ITEMS, SHELL_PATHS, resolveRoute } = createRequire(import.meta.url)(join(ROOT, 'public', 'routes.js'));

// The owner's decision (plan-hll10n, 2026-10-17): Home, Spending, Save and Invest,
// Tax, More, with Income and Plan under More. 2026-10-19 he moved Tax under More
// too, leaving four tabs.
test('the nav has the owner\'s four tabs in order', () => {
  assert.deepEqual(MINT_TABS.map((t) => t.label), ['Home', 'Spending', 'Save and Invest', 'More']);
  assert.deepEqual(MINT_TABS.map((t) => t.id), ['home', 'spending', 'save', 'more']);
  for (const t of MINT_TABS) assert.ok(resolveRoute(t.href).view, `${t.id} href resolves`);
});

test('Spending owns transactions and budgets as segments, URL params untouched', () => {
  const tx = resolveRoute('/transactions', '?category=none&from=2026-10-01&q=coles');
  assert.equal(tx.tab, 'spending');
  assert.equal(tx.seg, 'transactions');
  assert.equal(tx.view, 'transactions');
  assert.equal(tx.redirect, undefined);
  const b = resolveRoute('/budgets', '?month=2026-09');
  assert.equal(b.tab, 'spending');
  assert.equal(b.seg, 'budgets');
  assert.equal(b.view, 'budgets');
  assert.equal(b.redirect, undefined);
});

test('/spending is an alias that redirects to a segment and keeps every param', () => {
  assert.equal(resolveRoute('/spending').redirect, '/transactions');
  assert.equal(resolveRoute('/spending', '?seg=budgets').redirect, '/budgets');
  assert.equal(resolveRoute('/spending', '?seg=budgets&month=2026-09').redirect, '/budgets?month=2026-09');
  assert.equal(resolveRoute('/spending', '?account=acct_1&source=ai').redirect, '/transactions?account=acct_1&source=ai');
  assert.equal(resolveRoute('/spending', '?seg=nonsense').redirect, '/transactions');
});

test('old hash deep links redirect: a bookmarked #/budgets lands on Spending, Budgets', () => {
  assert.equal(resolveRoute('/', '', '#/budgets').redirect, '/budgets');
  assert.equal(resolveRoute('/', '', '#/budgets?month=2026-08').redirect, '/budgets?month=2026-08');
  assert.equal(resolveRoute('/', '', '#/transactions?category=none').redirect, '/transactions?category=none');
  assert.equal(resolveRoute('/', '', '#/reports?range=12M').redirect, '/reports?range=12M');
  assert.equal(resolveRoute('/', '', '#/accounts').redirect, '/accounts');
  assert.equal(resolveRoute('/', '', '#budgets').redirect, '/budgets');
  // A hash that is not a route (an anchor) is left alone.
  assert.equal(resolveRoute('/', '', '#top').redirect, undefined);
  assert.equal(resolveRoute('/', '', '#/nope').redirect, undefined);
  // The hash redirect composes with an alias.
  assert.equal(resolveRoute('/', '', '#/spending').redirect, '/transactions');
});

test('More leads to Accounts, Income, Plan, Ledger, Tax, Reports, Assets, Rules, Review and Settings, each keeping its screen', () => {
  assert.deepEqual(MORE_ITEMS.map((i) => i.label), ['Accounts and sync', 'Income', 'Plan', 'Ledger', 'Tax', 'Reports', 'Assets', 'Rules', 'Review', 'Settings']);
  for (const i of MORE_ITEMS) {
    const r = resolveRoute(i.href.split('?')[0], i.href.includes('?') ? `?${i.href.split('?')[1]}` : '');
    assert.equal(r.tab, 'more', i.label);
    assert.equal(r.redirect, undefined, i.label);
    assert.ok(r.view, i.label);
  }
  assert.equal(resolveRoute('/more').view, 'more');
  assert.equal(resolveRoute('/accounts', '?s=rules').view, 'accounts');
  assert.equal(resolveRoute('/reports', '?range=FY').view, 'reports');
});

test('short section URLs redirect into the Accounts sections', () => {
  assert.equal(resolveRoute('/assets').redirect, '/accounts?s=assets');
  assert.equal(resolveRoute('/rules').redirect, '/accounts?s=rules');
  assert.equal(resolveRoute('/review').redirect, '/accounts?s=review');
});

test('Save and Invest is its own tab; Income, Plan and Tax sit under More', () => {
  assert.equal(resolveRoute('/save').tab, 'save');
  assert.equal(resolveRoute('/save').view, 'save');
  assert.equal(resolveRoute('/invest').redirect, '/save');
  assert.equal(resolveRoute('/savings').redirect, '/save');
  for (const p of ['/income', '/plan', '/tax']) {
    const r = resolveRoute(p);
    assert.equal(r.tab, 'more', p);
    assert.equal(r.parent, '/more', p);
  }
  assert.equal(resolveRoute('/plan', '?s=goals').redirect, undefined);
  assert.equal(resolveRoute('/').tab, 'home');
});

test('trailing slashes redirect; unknown paths are not found with no tab lit', () => {
  assert.equal(resolveRoute('/budgets/', '?month=2026-09').redirect, '/budgets?month=2026-09');
  const nf = resolveRoute('/nope/at/all');
  assert.equal(nf.view, 'notfound');
  assert.equal(nf.tab, null);
});

test('titles say where you are', () => {
  assert.equal(resolveRoute('/budgets').title, 'Budgets');
  assert.equal(resolveRoute('/transactions').title, 'Transactions');
  assert.equal(resolveRoute('/save').title, 'Save and Invest');
  assert.equal(resolveRoute('/plan').title, 'Plan');
  assert.equal(resolveRoute('/more').title, 'More');
});

test('every path the router can serve is in the shell list the server and worker use', () => {
  for (const p of ['/', '/spending', '/transactions', '/budgets', '/save', '/invest', '/tax', '/more', '/accounts', '/reports', '/assets', '/rules', '/review']) {
    assert.ok(SHELL_PATHS.includes(p), p);
  }
  assert.ok(!SHELL_PATHS.includes('/nope'));
});
