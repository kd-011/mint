// Global search and jump-to (the command palette). Tap Search on the More
// screen, or press / or Ctrl/Cmd K on a desktop. Typing matches screens and
// actions at once (public/ux-model.js) and asks the server for transactions
// (merchant, description or amount), categories, accounts and budgets
// (GET /api/search). With nothing typed it shows recent searches and the
// jump-to actions. Up and down move, Enter opens, Escape closes.
'use strict';

const palState = { open: false, q: '', items: [], active: 0, seq: 0, server: null, status: 'idle', err: null, opener: null, overflow: '', timer: 0 };

// A jump-to action that needs a screen's own form (Add budget, Add subscription): the screen picks the intent up once it has drawn.
const jumpIntent = {
  set(name) { try { sessionStorage.setItem('mint:intent', JSON.stringify({ name, at: Date.now() })); } catch {} },
  take(name) {
    try {
      const v = JSON.parse(sessionStorage.getItem('mint:intent'));
      if (v?.name === name && Date.now() - v.at < 15000) { sessionStorage.removeItem('mint:intent'); return true; }
    } catch {}
    return false;
  },
};

function goTo(href) {
  if (href === location.pathname + location.search) { render({ keepScroll: false }); return; }
  navigate(href);
}

const palRecent = () => store.get('recent-searches') ?? [];
const palWantsServer = (q) => q.trim().length >= 2 || /^\$?\d/.test(q.trim());

// Rows are built as { key, html, run } so one list drives drawing, keys and clicks.
function palRow({ key, icon, title, sub = '', right = '', run, extra = '' }) {
  return { key, run, html: (i) => `<div class="pal-r" role="presentation"><button class="pal-row" type="button" role="option" id="pal-${i}" data-i="${i}" aria-selected="false" tabindex="-1">${icon}<span class="main"><span class="t1">${esc(title)}</span>${sub ? `<span class="t2">${esc(sub)}</span>` : ''}</span>${right}</button>${extra}</div>` };
}
const palIcon = (svg) => `<span class="ic">${svg}</span>`;

function palStaticSections(q) {
  const { actions, screens } = UxModel.matchStatic(q, { desktop: finePointer.matches });
  return [
    { title: 'Jump to', rows: actions.map((a) => palRow({ key: `a:${a.id}`, icon: palIcon(I[a.icon]), title: a.label, sub: a.hint, run: () => palAction(a.id) })) },
    { title: 'Screens', rows: screens.map((s) => palRow({ key: `s:${s.id}`, icon: palIcon(I[s.icon]), title: s.label, sub: s.hint, right: I.chevron, run: () => goTo(s.href) })) },
  ];
}

function palAction(id) {
  if (id === 'sync') startSync();
  else if (id === 'add-budget') { jumpIntent.set('add-budget'); goTo('/budgets'); } else if (id === 'add-sub') { jumpIntent.set('add-sub'); goTo('/plan?s=subs'); } else if (id === 'shortcuts') openShortcuts();
}

// What is on this device already, for when the server cannot be asked.
function palLocal(q) {
  const t = q.trim().toLowerCase();
  const categories = (categoriesData ?? []).filter((c) => !c.archived && (c.name.toLowerCase().includes(t) || (c.grp ?? '').toLowerCase().includes(t))).slice(0, 5);
  const accounts = (accountsData?.accounts ?? []).filter((a) => a.status !== 'gone' && `${accountName(a)} ${a.institution}`.toLowerCase().includes(t)).slice(0, 5);
  return { categories, accounts: accounts.map((a) => ({ id: a.id, name: accountName(a), institution: a.institution, type: a.type })), budgets: [], transactions: { total: 0, items: [] } };
}

function palTxRow(t) {
  const a = acctById(t.account_id);
  const sub = [dmy(t.date), a ? accountName(a) : acctText(t.account_name), t.category ?? 'Not filed'].filter(Boolean).join(' · ');
  const xfer = t.transfer && t.transfer.status !== 'review';
  return palRow({
    key: `t:${t.id}`, title: t.merchant || t.description || 'Unnamed', sub,
    icon: logoTile({ name: t.merchant || t.description, logo: t.logo, transfer: !!t.transfer || t.category_kind === 'transfer', icon: TYPE_ICON[a?.type] ?? I.wallet }),
    // Demo mode shows who and when, never how much.
    right: demoActive() ? I.chevron : `<span class="amt num ${t.amount > 0 && !xfer ? 'pos' : ''}">${esc(signed(t.amount))}</span>`,
    run: () => openTx(t),
  });
}

function palServerSections(q, d) {
  const out = [];
  const tx = d.transactions;
  if (tx.items.length) {
    const rows = tx.items.map(palTxRow);
    if (tx.total > tx.items.length) rows.push(palRow({ key: 't:all', icon: palIcon(I.list), title: `See all ${tx.total.toLocaleString('en-AU')} matching transactions`, sub: 'Open them in Transactions with filters', right: I.chevron, run: () => goTo(`/transactions?q=${encodeURIComponent(q.trim())}`) }));
    out.push({ title: 'Transactions', rows });
  }
  if (d.categories.length) out.push({ title: 'Categories', rows: d.categories.map((c) => palRow({ key: `c:${c.id}`, icon: palIcon(catIcon(c.name, c.grp)), title: c.name, sub: `${c.grp || 'Category'} · see its transactions`, right: I.chevron, run: () => goTo(`/transactions?category=${c.id}`) })) });
  if (d.accounts.length) out.push({ title: 'Accounts', rows: d.accounts.map((a) => palRow({ key: `x:${a.id}`, icon: palIcon(TYPE_ICON[a.type] ?? I.wallet), title: acctText(a.name), sub: `${a.institution} · see its transactions`, right: I.chevron, run: () => goTo(`/transactions?account=${encodeURIComponent(a.id)}`) })) });
  if (d.budgets.length) out.push({ title: 'Budgets', rows: d.budgets.map((b) => palRow({ key: `b:${b.category_id}`, icon: palIcon(I.target), title: `${b.name} budget`, sub: demoActive() ? 'see its transactions' : `${money0(b.cycle_target)} a pay cycle`, right: I.chevron, run: () => goTo(`/budgets?cat=${b.category_id}`) })) });
  return out;
}

function palSections() {
  const q = palState.q;
  if (!q.trim()) {
    // What was typed before may be a real amount, so demo mode shows none of it.
    const recent = demoActive() ? [] : palRecent();
    return [
      ...(recent.length ? [{ title: 'Recent', clear: true, rows: recent.map((r) => palRow({
        key: `r:${r}`, icon: palIcon(I.clock), title: r, run: () => palSet(r),
        extra: `<button class="x sm pal-rm" type="button" data-rm="${esc(r)}" aria-label="Remove ${esc(r)} from recent searches" title="Remove">${I.x}</button>`,
      })) }] : []),
      ...palStaticSections(''),
    ];
  }
  const sections = palStaticSections(q).filter((s) => s.rows.length);
  const s = palState.server;
  if (s && s.q === q) sections.push(...palServerSections(q, s.d));
  else if (palState.status === 'error') sections.push(...palServerSections(q, palLocal(q)));
  return sections;
}

function palRender() {
  const list = $('#pallist');
  if (!list) return;
  const q = palState.q;
  const sections = palSections();
  const keep = palState.items[palState.active]?.key;
  palState.items = sections.flatMap((s) => s.rows);
  const at = palState.items.findIndex((r) => r.key === keep);
  palState.active = at >= 0 ? at : 0;
  let i = 0;
  let html = sections.map((s) => `<div class="pal-sec" role="group" aria-label="${esc(s.title)}"><div class="pal-h"><span>${esc(s.title)}</span>${s.clear ? '<button class="pal-clear" type="button" id="palclear">Clear</button>' : ''}</div>${s.rows.map((r) => r.html(i++)).join('')}</div>`).join('');
  const waiting = q.trim() && palWantsServer(q) && (palState.status === 'loading' || (palState.server?.q !== q && palState.status !== 'error'));
  if (waiting) html += `<div class="pal-sec" aria-busy="true"><div class="pal-h"><span>Searching your transactions</span></div>${skeletonRows(3).replace('class="rows"', 'class="rows pal-sk"')}</div>`;
  if (palState.status === 'error') {
    const e = palState.err;
    html += `<div class="pal-note ${e?.offline ? '' : 'bad'}">${e?.offline ? `<div class="h">Offline</div><div class="d">Showing screens, categories and accounts saved on this device. Transactions need a connection.</div>` : errorCard(e, 'palretry', 'search results')}</div>`;
  } else if (q.trim() && !waiting && !palState.items.length) {
    html += `<div class="pal-empty">${emptyState({ icon: I.search, title: 'Nothing matches', line: `Try a merchant, an amount like 42.50, a category or a screen name.`, button: { id: 'palall', label: `Search transactions for "${q.trim()}"`, icon: I.list } })}</div>`;
  }
  list.innerHTML = html;
  if (palState.status === 'error' && !palState.err?.offline) $('#palretry', list)?.addEventListener('click', () => palSearch(q));
  $('#palall', list)?.addEventListener('click', () => palRunText());
  palMark(false);
}

function palMark(scroll = true) {
  const rows = $$('.pal-row', $('#pallist'));
  rows.forEach((b, i) => { const on = i === palState.active; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  const input = $('#palq');
  const cur = rows[palState.active];
  if (cur) { input.setAttribute('aria-activedescendant', cur.id); if (scroll) cur.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
}

async function palSearch(q) {
  const seq = ++palState.seq;
  palState.status = 'loading';
  palState.err = null;
  palRender();
  try {
    const d = await api(`/api/search?q=${encodeURIComponent(q.trim())}`, { retries: 1 });
    if (seq !== palState.seq) return;
    palState.server = { q, d };
    palState.status = 'idle';
  } catch (e) {
    if (seq !== palState.seq) return;
    palState.status = 'error';
    palState.err = e;
  }
  palRender();
}

function palSet(q) {
  const input = $('#palq');
  input.value = q;
  palInput();
  input.focus();
}

function palInput() {
  const input = $('#palq');
  const q = input.value;
  palState.q = q;
  $('#palx').hidden = !q;
  clearTimeout(palState.timer);
  palState.seq += 1;
  palState.status = 'idle';
  palState.err = null;
  palState.active = 0;
  palState.items = [];
  palRender();
  if (q.trim() && palWantsServer(q)) {
    // The loader shows from the first keystroke; the request waits for a pause in typing.
    palState.status = 'loading';
    palRender();
    palState.timer = setTimeout(() => palSearch(q), 160);
  }
}

function palRunText() {
  const q = palState.q.trim();
  if (!q) return;
  palRemember(q);
  closePalette();
  goTo(`/transactions?q=${encodeURIComponent(q)}`);
}

function palRemember(q) { if (demoActive()) return; store.set('recent-searches', UxModel.pushRecent(palRecent(), q)); }

function palActivate(i) {
  const row = palState.items[i];
  if (!row) return;
  buzz(6);
  if (palState.q.trim() && !row.key.startsWith('r:')) palRemember(palState.q);
  // A recent search fills the box instead of leaving.
  if (row.key.startsWith('r:')) { row.run(); return; }
  closePalette();
  row.run();
}

function openPalette({ instant = false } = {}) {
  if (palState.open) { $('#palq').focus(); return; }
  const root = $('#palette');
  palState.open = true;
  palState.opener = document.activeElement;
  palState.overflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  root.classList.remove('closing');
  root.classList.toggle('instant', instant);
  root.hidden = false;
  const input = $('#palq');
  input.value = '';
  palState.server = null;
  palInput();
  palFit();
  input.focus({ preventScroll: true });
}

function closePalette() {
  if (!palState.open) return;
  const root = $('#palette');
  palState.open = false;
  palState.seq += 1;
  clearTimeout(palState.timer);
  root.classList.add('closing');
  setTimeout(() => {
    if (palState.open) return;
    root.hidden = true;
    root.classList.remove('closing');
    if ($('#sheet').hidden && $('#modal').hidden) document.body.style.overflow = palState.overflow;
  }, reduceMotion.matches || root.classList.contains('instant') ? 0 : 180);
  const back = palState.opener;
  palState.opener = null;
  if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
}

// The panel stays above the on-screen keyboard.
function palFit() {
  if (!palState.open) return;
  const vv = window.visualViewport;
  const h = vv ? vv.height : innerHeight;
  $('#palette .panel').style.setProperty('--pal-h', `${Math.max(240, Math.round(h - 24))}px`);
}

function initPalette() {
  $$('#palette .search .si').forEach((n) => { n.innerHTML = I.search; });
  $('#palx').innerHTML = I.x;
  $('#palclose').innerHTML = I.x;
  const root = $('#palette');
  root.addEventListener('click', (e) => {
    if (e.target.classList.contains('scrim') || e.target.closest('[data-close]')) { closePalette(); return; }
    const rm = e.target.closest('[data-rm]');
    if (rm) { store.set('recent-searches', palRecent().filter((x) => x !== rm.dataset.rm)); palRender(); return; }
    if (e.target.closest('#palclear')) { store.set('recent-searches', []); palRender(); buzz(6); return; }
    if (e.target.closest('#palx')) { palSet(''); return; }
    const row = e.target.closest('.pal-row');
    if (row) palActivate(Number(row.dataset.i));
  });
  root.addEventListener('pointermove', (e) => {
    const row = e.target.closest('.pal-row');
    if (!row || e.pointerType === 'touch') return;
    const i = Number(row.dataset.i);
    if (i !== palState.active) { palState.active = i; palMark(false); }
  });
  $('#palq').addEventListener('input', palInput);
  $('#palq').addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); closePalette(); return; }
    const n = palState.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) { palState.active = (palState.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; palMark(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (n) palActivate(palState.active); else palRunText();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      (e.shiftKey ? $('#palclose') : $('#palx').hidden ? $('#palclose') : $('#palx')).focus();
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    else if (e.key === 'Tab' && !e.target.closest('#palq')) { e.preventDefault(); $('#palq').focus(); }
  });
  window.visualViewport?.addEventListener('resize', palFit);
  addEventListener('resize', palFit);
  document.addEventListener('mint:online', () => { if (palState.open && palState.status === 'error' && palState.err?.offline && palWantsServer(palState.q)) palSearch(palState.q); });
}
