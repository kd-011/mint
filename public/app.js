// Mint SPA: router and boot. The current tab lives in the URL path (and its
// sub-state in the query), so a refresh lands on the same screen with the nav
// drawn. Screens live in their own files; core.js has the shared plumbing.
'use strict';

const VIEWS = { home: viewHome, transactions: viewTransactions, budgets: viewBudgets, income: viewIncome, plan: viewPlan, save: viewSave, tax: viewTax, more: viewMore, accounts: viewAccounts, account: viewAccount, reports: viewReports, owed: viewOwed, settings: viewSettings };
let renderToken = 0;
let lastTabIdx = -1;
let cleanup = [];
let route = resolveRoute('/');
// Transactions keep a scroll position per filter set; a budget's category view has its own, apart from the list it opened from.
const scrollKey = (p) => `mint:scroll:${p}${p === '/transactions' || p === '/account' || (p === '/budgets' && /[?&]cat=/.test(location.search)) ? location.search : ''}`;

function viewNotFound(el) {
  el.innerHTML = `<div class="card">${emptyState({ icon: I.compass, title: 'Nothing here', line: `There is no page at ${location.pathname}.`, action: { href: '/', label: 'Go home' } })}</div>`;
}

// Old URLs (/spending, #/budgets, /assets, a trailing slash) are rewritten in
// place to their canonical form, so the address bar and back button stay clean.
function resolveHere() {
  let r = resolveRoute(location.pathname, location.search, location.hash);
  for (let i = 0; r.redirect && i < 3; i++) {
    history.replaceState({}, '', r.redirect);
    r = resolveRoute(location.pathname, location.search, location.hash);
  }
  return r;
}

// Spending is two segments under one tab. Each segment remembers its own last
// URL (filters, month) for the session, so flipping between them loses nothing;
// the dock tab itself returns to whichever segment you were last on.
const spendMem = {
  get: (seg) => sessionStorage.getItem(`mint:spend:${seg}`),
  remember() {
    const r = ROUTES[location.pathname];
    if (r?.tab === 'spending') {
      sessionStorage.setItem(`mint:spend:${r.seg}`, location.pathname + location.search);
      sessionStorage.setItem('mint:spend:last', r.seg);
    }
  },
  tabHref() { const seg = sessionStorage.getItem('mint:spend:last'); return SPENDING_SEGS.find(([k]) => k === seg)?.[2] ?? '/transactions'; },
};

let reviewCount = store.get('c:/api/review')?.d?.transfers ?? 0;

function drawNav() {
  // The dock's pill sits under the active tab by index; the first draw puts it there without sliding in from the first tab.
  const nav = $('#nav');
  const first = !nav.dataset.drawn;
  nav.dataset.drawn = '1';
  const at = MINT_TABS.findIndex((t) => t.id === route.tab);
  nav.classList.toggle('none', at < 0);
  if (at >= 0) nav.style.setProperty('--i', String(at));
  if (first) { nav.classList.add('still'); requestAnimationFrame(() => requestAnimationFrame(() => nav.classList.remove('still'))); }
  nav.innerHTML = MINT_TABS.map((t) => {
    const on = route.tab === t.id;
    const href = t.id === 'spending' ? spendMem.tabHref() : t.href;
    const badge = t.id === 'more' && reviewCount ? `<b class="nb" aria-label="${reviewCount} to review">${reviewCount > 99 ? '99+' : reviewCount}</b>` : '';
    return `<a href="${href}" data-nav data-tab="${t.id}" class="${on ? 'on' : ''}" ${on ? 'aria-current="page"' : ''}>${I[t.icon]}<span class="lf">${esc(t.label)}</span><span class="ls" aria-hidden="true">${esc(t.short)}</span>${badge}</a>`;
  }).join('');
}

// The count on More comes from the same /api/review the Review section uses.
// Drawn from the saved copy at once, refreshed when it is stale (or when a
// screen that just fetched it asks).
function refreshReviewBadge(force = false) {
  const saved = store.get('c:/api/review');
  reviewCount = saved?.d?.transfers ?? 0;
  if (!force && saved && Date.now() - saved.at < 30_000) return;
  if (!online) return;
  swr('/api/review', (d) => { if (d.transfers !== reviewCount) { reviewCount = d.transfers ?? 0; drawNav(); } }).catch(() => {});
}

async function render({ keepScroll = true } = {}) {
  const token = ++renderToken;
  cleanup.forEach((f) => f());
  cleanup = [];
  clearCharts();
  spendMem.remember();
  route = resolveHere();
  drawNav();
  chatUi.setView(route.view);
  closeSheet();
  closeModal();
  paneOwner = null;
  paneDefaultFn = balancesPane;
  paneDefault();
  const view = VIEWS[route.view] ?? viewNotFound;
  const old = $('#view');
  const el = old.cloneNode(false);
  el.className = ''; // a clone carries the last screen's classes
  // Moving along the dock slides the new screen in from that side; anything else just rises in.
  const tabIdx = MINT_TABS.findIndex((t) => t.id === route.tab);
  const dir = lastTabIdx >= 0 && tabIdx >= 0 && tabIdx !== lastTabIdx ? (tabIdx > lastTabIdx ? 'vt-r' : 'vt-l') : '';
  if (tabIdx >= 0) lastTabIdx = tabIdx;
  el.classList.add('view-enter');
  if (dir) el.classList.add(dir);
  old.replaceWith(el);
  document.title = `${route.title} · Mint`;
  // Spending carries its segment control; the More screens carry a way back.
  let host = el;
  if (route.tab === 'spending') {
    el.innerHTML = `<div class="spendseg">${segmented('spend', SPENDING_SEGS.map(([k, l]) => [k, l]), route.seg).replace('role="radiogroup"', 'role="radiogroup" aria-label="Spending view"')}</div><div class="spendbody"></div>`;
    host = $('.spendbody', el);
    wireSeg(el, 'spend', (seg) => {
      if (seg === route.seg) return;
      navigate(spendMem.get(seg) ?? SPENDING_SEGS.find(([k]) => k === seg)[2]);
    });
  } else if (route.parent) {
    el.innerHTML = `<div class="pagehead"><a class="backlink ${route.parent === '/' ? 'always' : ''}" href="${route.parent}" data-nav ${route.parent === '/' ? 'data-back' : ''}>${I.back}${esc(route.parentLabel ?? 'More')}</a>${route.view === 'account' ? '' : `<h1 class="pagetitle">${esc(route.title)}</h1>`}</div><div class="morebody"></div>`;
    host = $('.morebody', el);
  }
  const saved = keepScroll ? Number(sessionStorage.getItem(scrollKey(location.pathname)) ?? 0) : 0;
  // After a few seconds of skeletons, say so rather than hang silently.
  const slowTimer = setTimeout(() => {
    if (token !== renderToken || !$('.sk, .sk-row', el)) return;
    const bar = document.createElement('div');
    bar.className = 'slowbar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<span class="spin dim"></span>Still loading, the server may be busy.';
    el.prepend(bar);
    const poll = setInterval(() => { if (token !== renderToken || !$('.sk, .sk-row', el)) { clearInterval(poll); bar.remove(); } }, 500);
    cleanup.push(() => clearInterval(poll));
  }, 4500);
  cleanup.push(() => clearTimeout(slowTimer));
  try {
    await view(host, token);
  } catch (e) {
    console.error(e);
    if (token === renderToken) {
      host.innerHTML = `<div class="error"><div class="h">Something broke drawing this screen</div><div class="d">${esc(e?.message ?? e)}</div><button class="btn ghost" type="button" id="crash">${I.refresh}Reload</button></div>`;
      $('#crash', host)?.addEventListener('click', () => location.reload());
    }
  }
  if (token === renderToken) refreshReviewBadge(route.view === 'more' || route.view === 'accounts');
  if (token === renderToken) refreshGlance();
  if (token === renderToken && location.pathname !== '/transactions') requestAnimationFrame(() => restoreScroll(el, saved, token));
  else if (token === renderToken && !saved) scrollTo(0, 0);
}

// A screen whose data lands after it drew is shorter than when the owner left it, so a single scrollTo is clamped
// short and the scroll saver then writes the clamped figure over the real one. Hold the saved position while
// the page grows, and let go the moment the owner scrolls, taps or leaves.
let restoring = false;
let stopRestore = () => {};
function restoreScroll(el, y, token) {
  stopRestore();
  scrollTo(0, y);
  if (!y || scrollY >= y - 2 || typeof ResizeObserver === 'undefined') return;
  restoring = true;
  const grow = new ResizeObserver(() => {
    if (token !== renderToken) return stopRestore();
    scrollTo(0, y);
    if (scrollY >= y - 2) stopRestore();
  });
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  const timer = setTimeout(() => stopRestore(), 8000);
  stopRestore = () => {
    grow.disconnect();
    clearTimeout(timer);
    for (const ev of events) removeEventListener(ev, stopRestore);
    restoring = false;
    stopRestore = () => {};
  };
  for (const ev of events) addEventListener(ev, stopRestore, { passive: true });
  grow.observe(el);
}

function navigate(href) {
  spendMem.remember();
  sessionStorage.setItem(scrollKey(location.pathname), String(scrollY));
  history.pushState({ from: location.pathname + location.search }, '', href);
  render({ keepScroll: false });
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  // A back link to the screen we came from is the back button, so that screen lands where it was left.
  if (a.hasAttribute('data-back') && history.state?.from === a.getAttribute('href')) { history.back(); return; }
  const sameTab = a.dataset.tab && a.dataset.tab === route.tab && a.dataset.tab === 'spending';
  if (sameTab || a.getAttribute('href') === location.pathname + location.search) { scrollTo({ top: 0, behavior: 'smooth' }); return; }
  navigate(a.getAttribute('href'));
});
addEventListener('popstate', () => render());
// An old bookmark edited into the bar (#/budgets) is a route too.
addEventListener('hashchange', () => { if (resolveRoute(location.pathname, location.search, location.hash).redirect) render({ keepScroll: false }); });
let scrollSaver = 0;
addEventListener('scroll', () => {
  clearTimeout(scrollSaver);
  if (restoring) return;
  scrollSaver = setTimeout(() => sessionStorage.setItem(scrollKey(location.pathname), String(scrollY)), 80);
}, { passive: true });

// Demo mode: a body class. A change redraws the screen so every figure is formatted again; Settings repaints itself in place.
function paintDemo() {
  document.body.classList.toggle('demo', demoActive());
}
document.addEventListener('mint:demo', () => {
  paintDemo();
  if (!demoActive() && online && queue.all().length) queue.flush(); // changes that waited out demo mode
  if (route.view !== 'settings') render({ keepScroll: true });
});
desktop.addEventListener('change', () => { closeSheet(); paneDefault(); });

// A sync, a bulk edit or a rule change ripples through every screen: redraw the
// current one quietly unless the owner is mid-edit.
let softTimer = 0;
const soft = () => {
  clearTimeout(softTimer);
  softTimer = setTimeout(() => {
    if (document.hidden || !$('#sheet').hidden || !$('#modal').hidden || paneOwner || document.body.classList.contains('selecting')) return;
    if (location.pathname === '/transactions') txMem.fresh = false;
    render({ keepScroll: true });
  }, 500);
};
document.addEventListener('mint:data', soft);
window.addEventListener('mint:synced', soft);

// boot

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && navigator.serviceWorker.controller) { reloaded = true; location.reload(); } });
}
history.scrollRestoration = 'manual';
// The lock first: until it opens, every /api/ call made below waits behind it.
lockUi.init();
$('#offline').hidden = online;
queueChanged();
loadCategories().catch(() => {});
paintDemo();
chatUi.init();
initPalette();
initKeys();
initPullToRefresh();
render();
refreshAccounts(true).then(() => { if (accountsData?.sync.running) watchSync(); });
if (online) queue.flush();
setInterval(() => { if (document.visibilityState === 'visible' && online) refreshAccounts(true); }, 60_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshAccounts(true); if (online && queue.all().length) queue.flush(); } });
