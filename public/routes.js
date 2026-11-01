// Mint routes: the four tabs, what lives under each, and every legacy URL that
// still has to land somewhere. Pure (no DOM) so the same file runs in the page,
// in the server (which serves the shell for SHELL_PATHS and stamps the worker)
// and in tests.
'use strict';

// icon is a key into the I icon table in core.js; short is the label that fits
// the phone dock.
const MINT_TABS = [
  { id: 'home', href: '/', label: 'Home', short: 'Home', icon: 'home' },
  { id: 'spending', href: '/transactions', label: 'Spending', short: 'Spending', icon: 'wallet' },
  { id: 'save', href: '/save', label: 'Save and Invest', short: 'Save', icon: 'piggy' },
  { id: 'more', href: '/more', label: 'More', short: 'More', icon: 'dots' },
];

const SPENDING_SEGS = [['transactions', 'Transactions', '/transactions'], ['budgets', 'Budgets', '/budgets']];

// The More list. Each keeps its current screen; Assets, Rules and Review are
// sections of the Accounts screen. Income, Plan and Tax are not tabs (the owner's
// four are Home, Spending, Save and Invest, More). Settings is last.
const MORE_ITEMS = [
  { href: '/accounts', label: 'Accounts and sync', line: 'Banks, balances, Sync now', icon: 'bank' },
  { href: '/income', label: 'Income', line: 'Pay cycles, salary, regular payers', icon: 'income' },
  { href: '/plan', label: 'Plan', line: 'Pay split, goals, debt and bills', icon: 'target' },
  { href: '/owed', label: 'Ledger', line: 'Who owes you and who you owe', icon: 'user' },
  { href: '/tax', label: 'Tax', line: 'Deductions, estimate and the accountant CSV', icon: 'receipt' },
  { href: '/reports', label: 'Reports', line: 'Spend, cash flow, net worth, monthly budgets', icon: 'chart' },
  { href: '/accounts?s=assets', label: 'Assets', line: 'Shares, super and other things you own', icon: 'piggy' },
  { href: '/accounts?s=rules', label: 'Rules', line: 'How merchants get filed', icon: 'rules' },
  { href: '/accounts?s=review', label: 'Review', line: 'Transfers and guesses to check', icon: 'check', badge: 'review' },
  { href: '/settings', label: 'Settings', line: 'Fingerprint lock, demo mode', icon: 'gear' },
];

// Search is not a screen, it opens the palette, so it is not in the list above (those are routes). The More
// screen draws it as the first row now that the top bar's search button is gone.
const MORE_SEARCH = { label: 'Search', icon: 'search' };

// path -> screen. tab is the nav entry that lights up.
const ROUTES = {
  '/': { view: 'home', tab: 'home', title: 'Home' },
  '/transactions': { view: 'transactions', tab: 'spending', seg: 'transactions', title: 'Transactions' },
  '/budgets': { view: 'budgets', tab: 'spending', seg: 'budgets', title: 'Budgets' },
  '/save': { view: 'save', tab: 'save', title: 'Save and Invest' },
  '/account': { view: 'account', tab: 'home', title: 'Account', parent: '/', parentLabel: 'Home' },
  '/more': { view: 'more', tab: 'more', title: 'More' },
  '/tax': { view: 'tax', tab: 'more', title: 'Tax', parent: '/more' },
  '/income': { view: 'income', tab: 'more', title: 'Income', parent: '/more' },
  '/plan': { view: 'plan', tab: 'more', title: 'Plan', parent: '/more' },
  '/accounts': { view: 'accounts', tab: 'more', title: 'Accounts', parent: '/more' },
  '/reports': { view: 'reports', tab: 'more', title: 'Reports', parent: '/more' },
  '/owed': { view: 'owed', tab: 'more', title: 'Ledger', parent: '/more' },
  '/settings': { view: 'settings', tab: 'more', title: 'Settings', parent: '/more' },
};

// Paths that are only a way in: they redirect, keeping the query.
const ALIASES = {
  '/spending': (q) => {
    const seg = q.get('seg');
    q.delete('seg');
    return seg === 'budgets' ? '/budgets' : '/transactions';
  },
  '/invest': () => '/save',
  '/savings': () => '/save',
  '/assets': (q) => { q.set('s', 'assets'); return '/accounts'; },
  '/rules': (q) => { q.set('s', 'rules'); return '/accounts'; },
  '/review': (q) => { q.set('s', 'review'); return '/accounts'; },
};

const SHELL_PATHS = [...Object.keys(ROUTES), ...Object.keys(ALIASES)];

const withQuery = (path, q) => (q.toString() ? `${path}?${q}` : path);

// Resolve a location. A result with .redirect is not a screen: replace the URL
// with it and resolve again. A hash like #/budgets is an old-style deep link;
// one that is not a known route (an anchor) is ignored.
function resolveRoute(pathname = '/', search = '', hash = '') {
  const h = /^#\/?([^?]*)(\?.*)?$/.exec(hash || '');
  if (h && h[1]) {
    const hp = `/${h[1]}`.replace(/\/+$/, '') || '/';
    if (ROUTES[hp] || ALIASES[hp]) {
      const to = resolveRoute(hp, h[2] ?? '');
      return { redirect: to.redirect ?? withQuery(hp, new URLSearchParams(h[2] ?? '')) };
    }
  }
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
  const q = new URLSearchParams(search);
  if (path !== pathname) return { redirect: withQuery(path, q) };
  if (ALIASES[path]) {
    const to = ALIASES[path](q);
    return { redirect: withQuery(to, q) };
  }
  const r = ROUTES[path];
  if (!r) return { view: 'notfound', tab: null, title: 'Not found' };
  return { ...r, path };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { MINT_TABS, MORE_ITEMS, MORE_SEARCH, SPENDING_SEGS, ROUTES, SHELL_PATHS, resolveRoute };
