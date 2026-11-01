// More: the list page behind the last tab. Search opens the palette; Accounts and sync, Income, Plan,
// Tax, Reports, Assets, Rules, Review and Settings each keep their own screen; this is the way
// in, with a badge where Review has items.
'use strict';

// The Ledger shows the net balance in its line once there is one (above zero they owe the owner, below he owes them).
const owedNet = (d) => d?.net ?? d?.total_outstanding ?? 0;
const moreOwed = () => owedNet(store.get('c:/api/owed')?.d);

function moreRowHtml(i, reviewCount, owed = 0) {
  const n = i.badge === 'review' ? reviewCount : 0;
  const line = n ? `${n} to check` : i.href === '/settings' && demoActive() ? 'Demo mode is on' : i.href === '/owed' && owed !== 0 ? (owed > 0 ? `${money(owed)} owed to you` : `${money(-owed)} you owe`) : '';
  return `<a class="row" href="${i.href}" data-nav><div class="ic">${I[i.icon]}</div>
    <div class="main"><div class="t1">${esc(i.label)}</div>${line ? `<div class="t2">${esc(line)}</div>` : ''}</div>
    ${n ? `<span class="badge" aria-label="${n} to review">${n}</span>` : ''}${I.chevron}</a>`;
}

// The one row that is an action, not a link: the top bar's search button used to be the way in on a phone.
const moreSearchHtml = () => `<button type="button" class="row" data-act="search"><div class="ic">${I[MORE_SEARCH.icon]}</div>
    <div class="main"><div class="t1">${esc(MORE_SEARCH.label)}</div></div>${I.chevron}</button>`;

async function viewMore(el, token) {
  const count = (rv) => rv?.transfers ?? 0;
  // Rows are found by their link, so the Search row ahead of them does not shift anything.
  const rowFor = (i) => $(`#morelist > a.row[href="${i.href}"]`, el);
  el.innerHTML = `<div class="rows" id="morelist">${moreSearchHtml()}${MORE_ITEMS.map((i) => moreRowHtml(i, count(store.get('c:/api/review')?.d), moreOwed())).join('')}</div>`;
  stagger($('#morelist', el), ':scope > .row');
  $('#morelist [data-act="search"]', el).addEventListener('click', () => { buzz(6); openPalette(); });
  // The list is static so it draws at once; the fresh review count then swaps
  // into its own row without replaying the entrance.
  swr('/api/review', (d) => {
    if (token !== renderToken) return;
    MORE_ITEMS.forEach((i) => { if (i.badge === 'review') { const row = rowFor(i); if (row) row.outerHTML = moreRowHtml(i, count(d)); } });
  }).catch(() => {});
  swr('/api/owed', (d) => {
    if (token !== renderToken) return;
    const i = MORE_ITEMS.find((x) => x.href === '/owed');
    const row = rowFor(i);
    if (row) row.outerHTML = moreRowHtml(i, 0, owedNet(d));
  }).catch(() => {});
}
