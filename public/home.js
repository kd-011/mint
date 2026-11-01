// Home opens with net worth (days to payday quiet on the line under the number), every account with its bank's logo and
// balance, the group totals those add up to (cash, cards, loans, investments), then the quick actions and a
// cash warning that only shows when cash is short. Each block loads on its own, so one slow or failed read
// never blanks the screen.
'use strict';

function healthBanner() {
  const d = accountsData;
  const items = [];
  if (!online) items.push(['warn', 'You are offline', queue.all().length ? `${plural(queue.all().length, 'change')} waiting to sync` : 'Showing saved data']);
  if (d) {
    const bad = d.connections.filter((c) => c.status !== 'active');
    if (bad.length) items.push(['bad', `${bad.map((c) => c.institution).join(', ')} ${bad.length > 1 ? 'need' : 'needs'} reconnecting`, 'Renew the bank consent in Redbark']);
    const exp = d.connections.filter((c) => c.status === 'active' && c.consent_warning);
    if (exp.length) items.push(['warn', `${exp[0].institution} consent ends ${exp[0].consent_days <= 0 ? 'now' : `in ${exp[0].consent_days} ${exp[0].consent_days === 1 ? 'day' : 'days'}`}`, 'Renew it in Redbark to keep syncing']);
    const failing = d.accounts.filter((a) => a.last_sync_error);
    if (failing.length) items.push(['bad', `${plural(failing.length, 'account')} failed to sync`, failing[0].last_sync_error]);
    else if (d.sync.lastError) items.push(['bad', 'The last sync failed', d.sync.lastError]);
  }
  if (!items.length) return '';
  return `<a class="health" href="/accounts" data-nav>${items.slice(0, 2).map(([k, h, s]) => `<div class="hline ${k}">${I.alert}<span><b>${esc(h)}</b><small>${esc(s)}</small></span></div>`).join('')}${I.chevron}</a>`;
}

// The net worth card: the number with its cents set quieter, then days to payday on a quiet line under it
// (empty and hidden until the cycle arrives, or when there is none).
function nwBlock(nw) {
  const [whole, cents] = nwParts(nw.net_worth);
  return `<section class="hero nw" id="nwhero">
      <div class="label">Net worth</div>
      <div class="big num"><span id="nwbig">${esc(whole)}</span><span class="cents" id="nwcents">${esc(cents)}</span></div>
      <div class="pay" id="nwpay" hidden></div>
    </section>`;
}
// money() as [dollars, ".cc"], so the cents can be styled apart (and still follow demo mode's scaling).
function nwParts(cents) {
  const t = money(cents);
  const i = t.lastIndexOf('.');
  return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i)];
}

// Every account under the hero: the bank's logo (a letter tile until it loads, or when the bank has none),
// the name with the bank and number quiet underneath, the balance on the right. Rows open that account's transactions.
const ASSET_ICON = { shares: I.chartLine, super: I.piggy, property: I.house, vehicle: I.car, cash: I.wallet };
function acctTile(r) {
  const icon = r.kind === 'account' ? (TYPE_ICON[r.type] ?? I.wallet) : r.kind === 'holdings' ? I.chartLine : (ASSET_ICON[r.type] ?? I.bank);
  return r.kind === 'account' ? logoTile({ name: r.institution || r.name, logo: r.logo, icon, bank: true }) : `<div class="ic">${icon}</div>`;
}
function acctRowHtml(r) {
  // A share under the portfolio row: no tile, the text lines up with the portfolio name; no value says "No price", never $0.
  if (r.kind === 'holding' || r.kind === 'holding-more') {
    const right = r.kind === 'holding-more' ? '' : `<div class="amt num ${r.noPrice ? 'quiet' : ''}">${esc(r.noPrice ? 'No price' : money(r.balance))}</div>`;
    return `<a class="row hold" href="${esc(r.href)}" data-nav><div class="main"><div class="${r.kind === 'holding-more' ? 't2' : 't1'}">${esc(r.name)}</div>${r.sub ? `<div class="t2">${esc(r.sub)}</div>` : ''}</div>${right}</a>`;
  }
  const native = r.currency ? `<div class="t2 num">${esc(moneyIn(r.native, r.currency))}</div>` : '';
  return `<a class="row" href="${esc(r.href)}" data-nav>${acctTile(r)}<div class="main"><div class="t1">${esc(r.name)}</div>${r.sub ? `<div class="t2">${esc(acctText(r.sub))}</div>` : ''}</div><div class="amt num ${r.balance < 0 ? 'neg-red' : ''}">${esc(money(r.balance))}${native}</div></a>`;
}

// One card, rows under small section labels (the labels are left off when there is only one section). Edit order
// (public/home-order.js) swaps the rows for ones with a drag handle and up and down buttons, within each section.
function accountsBlock(accounts, nw, ord = { on: false }) {
  // The shares themselves show in the plain list only; edit order keeps the single portfolio row. Demo mode hides
  // them: the units and tickers would give away what the scaled values hide.
  const list = UxModel.accountRows({ accounts, manual: nw?.manual, holdings: nw?.holdings }, { name: accountName }, { expandHoldings: !ord.on && !demoActive() });
  if (!list.count) {
    return `<section class="card">${emptyState({ icon: I.bank, title: 'No accounts yet', line: 'Connect a bank in Redbark and every account shows up here with its balance.', action: { href: '/accounts', label: 'Open accounts' } })}</section>`;
  }
  const labels = list.sections.length > 1;
  const demo = demoActive();
  const edit = list.count > 1
    ? `<button type="button" class="pill ho-btn ibtn" data-reorder aria-pressed="${ord.on}" aria-label="${ord.on ? 'Done ordering' : 'Edit order'}" ${demo ? 'aria-disabled="true" title="Turn off demo mode to change the order"' : `title="${ord.on ? 'Finish ordering' : 'Edit order'}"`}>${ord.on ? I.check : I.reorder}</button>`
    : '';
  // No heading over the card: its top line carries the first group's label and the Edit order button.
  const top = (sec) => (!labels && !edit ? '' : `<div class="atop">${labels ? `<div class="rlabel">${esc(sec.label)}</div>` : '<span></span>'}${edit}</div>`);
  const label = (sec, i) => (i === 0 ? '' : labels ? `<div class="rlabel">${esc(sec.label)}</div>` : '');
  if (!ord.on) return `<div class="rows arows">${top(list.sections[0])}${list.sections.map((sec, i) => `${label(sec, i)}${sec.rows.map(acctRowHtml).join('')}`).join('')}</div>`;
  const sec = (s, i) => `<div class="ro-sec" data-sec="${s.id}" data-label="${esc(s.label)}">${label(s, i)}${s.rows.map((r, j) => hoRowHtml({ ...r, section: s.label }, acctTile(r), { first: j === 0, last: j === s.rows.length - 1 })).join('')}</div>`;
  return `<div class="rows arows reorder">${top(list.sections[0])}<div class="ro-note" role="status" aria-live="polite">${hoNoteHtml(ord)}</div>${list.sections.map(sec).join('')}</div>`;
}

// The totals those accounts add up to, under them. Each tile opens where it is kept.
function balancesBlock(nw) {
  const tiles = UxModel.balanceTiles(nw.groups);
  if (!tiles.length) return '';
  return `<div class="grid2 bals">${tiles.map((t) => `<a class="stat" href="${esc(t.href)}" data-nav><div class="k">${esc(t.label)}</div><div class="v num ${t.value < 0 ? 'neg-red' : ''}">${esc(money(t.value))}</div></a>`).join('')}</div>`;
}

// Five tiles under the hero for the jobs done most: sort what is unfiled, open budgets, log what a friend owes, ask, sync.
const QA_TITLES = { fix: 'Sort transactions that have no category', budgets: 'Open budgets', owed: 'Add something a friend owes you', ask: 'Ask about your money', sync: 'Sync every bank now' };
function actionsBlock(rv) {
  // Ask is chat, which is off in demo mode (its answers carry real dollars).
  const acts = UxModel.homeActions({ uncategorised: rv?.uncategorised ?? 0, online, syncRunning: !!syncState?.running }).filter((a) => !((demoActive() && a.act === 'chat') || (!CHAT_ON && a.act === 'chat')));
  return `<div class="qactions ${acts.length < 5 ? 'n4' : ''}" role="group" aria-label="Quick actions">${acts.map((a) => {
    const inner = `<span class="qi">${a.id === 'sync' && a.disabled && syncState?.running ? '<span class="spin"></span>' : I[a.icon]}${a.badge ? `<b class="qb num">${esc(a.badge)}</b>` : ''}</span><span class="ql">${esc(a.label)}</span>`;
    const title = esc(a.why ?? QA_TITLES[a.id]);
    return a.href
      ? `<a class="qa" href="${esc(a.href)}" data-nav title="${title}" aria-label="${title}${a.badge ? `, ${esc(a.badge)} waiting` : ''}">${inner}</a>`
      : `<button class="qa" type="button" data-qa="${a.act}" title="${title}" aria-label="${title}" ${a.disabled ? 'disabled' : ''}>${inner}</button>`;
  }).join('')}</div>`;
}

// Spendable balances will not cover the bills still due before payday.
function cashBlock(safe) {
  const cash = safe?.cash;
  if (!cash?.short) return '';
  return `<a class="nudge bad" href="/plan?s=bills" data-nav>${I.alert}<div><b>Cash will not cover the bills</b><small>${esc(money(cash.spendable))} spendable, ${esc(money(cash.bills_due))} due, ${esc(money(Math.abs(cash.after_bills)))} short</small></div></a>`;
}

// Days to payday, on the line under the net worth number.
const paydayText = (c) => (c?.next_payday ? (c.late ? `Payday ${plural(c.days_late, 'day')} late` : c.days_left === 0 ? 'Payday today' : `${plural(c.days_left, 'day')} to payday`) : '');

async function viewHome(el, token) {
  const data = { safe: null, bud: null, nw: null, rv: null };
  // Net worth, the accounts and their totals first, then the quick actions; the cash-short nudge is last and empty unless cash is short.
  const slots = ['health', 'nw', 'accts', 'bals', 'actions', 'sync', 'cash'];
  const hs = (list) => list.map((s) => `<div id="h-${s}" class="hslot"></div>`).join('');
  el.innerHTML = hs(slots);
  const slot = (s) => $(`#h-${s}`, el);
  wireLogoTiles(slot('accts'));
  const skeleton = {
    nw: () => skeletonCard(136),
    accts: () => skeletonRows(4),
    bals: () => '<div class="grid2 bals"><div class="sk sk-stat"></div><div class="sk sk-stat"></div></div>',
  };
  for (const [k, f] of Object.entries(skeleton)) { slot(k).innerHTML = f(); applyDims(slot(k)); }
  slot('health').innerHTML = healthBanner();
  mountHomeSync(slot('sync'), token);
  const paintActions = () => { if (token === renderToken) slot('actions').innerHTML = actionsBlock(data.rv); };
  paintActions();
  document.addEventListener('mint:syncstate', paintActions);
  document.addEventListener('mint:online', paintActions);
  cleanup.push(() => { document.removeEventListener('mint:syncstate', paintActions); document.removeEventListener('mint:online', paintActions); });

  // Only the cash-short nudge is left of the safe to spend read; it stays empty unless cash will not cover the bills.
  const paintCash = () => { if (token === renderToken && data.safe) slot('cash').innerHTML = cashBlock(data.safe); };
  // Days to payday sits under the net worth number, so it waits for both reads and stays hidden until it has words.
  const paintPayday = () => {
    const t = $('#nwpay', el);
    if (token !== renderToken || !t) return;
    t.textContent = paydayText(data.bud?.cycle);
    t.hidden = !t.textContent;
  };
  // The saved accounts paint at once; the manual assets join when net worth arrives. A repaint with the
  // same markup is skipped, and only the first one staggers in, so a refresh never replays the motion.
  let acctsHtml = null;
  let localOrder = null; // the order the owner last set on this page
  const ord = hoMount(slot('accts'), {
    getList: () => UxModel.accountRows({ accounts: shownAccounts(), manual: data.nw?.manual, holdings: data.nw?.holdings }, { name: accountName }),
    // The order goes onto what the page holds and its saved copies, so a reload offline shows it too.
    applyLocal: (ids) => { localOrder = ids; putOrder(ids); },
    repaint: () => { acctsHtml = null; paintAccts(); },
    alive: () => token === renderToken,
  });
  function putOrder(ids) {
    {
      const pos = new Map(ids.map((id, i) => [id, i + 1]));
      for (const a of accountsData?.accounts ?? []) if (pos.has(a.id)) a.sort = pos.get(a.id);
      for (const m of data.nw?.manual ?? []) if (pos.has(`asset_${m.id}`)) m.sort = pos.get(`asset_${m.id}`);
      if (data.nw?.holdings && pos.has('holdings')) data.nw.holdings.sort = pos.get('holdings');
      if (accountsData) store.set('accounts', accountsData);
      const c = store.get('c:/api/networth');
      if (c && data.nw) store.set('c:/api/networth', { ...c, d: data.nw });
    }
  }
  const paintAccts = () => {
    if (token !== renderToken || !accountsData) return;
    // A sync or a refresh must not redraw rows under a finger that is dragging one.
    if (ord.on && $('.ro.drag', slot('accts'))) return;
    // A refresh asked for before a save landed brings the old order back with it: while a change is unsaved or
    // just saved, the order on screen wins (it is what gets saved).
    if (localOrder && ord.busy()) putOrder(localOrder);
    const html = accountsBlock(shownAccounts(), data.nw, ord);
    if (html === acctsHtml) return;
    const first = acctsHtml === null;
    acctsHtml = html;
    slot('accts').innerHTML = html;
    if (first) stagger($('.arows', slot('accts')) ?? slot('accts'));
    if (ord.on) applyDims(slot('accts'));
  };
  const paintNw = () => {
    if (token !== renderToken || !data.nw) return;
    const prev = $('#nwbig', el)?.textContent;
    const nw = shownNw(data.nw); // net worth and the cash tile carry the made-up balances in demo mode
    slot('nw').innerHTML = nwBlock(nw);
    slot('bals').innerHTML = balancesBlock(nw);
    const cents = $('#nwcents', el);
    countUp($('#nwbig', el), nw.net_worth, (c) => { const [w, f] = nwParts(c); cents.textContent = f; return w; }, 'home:nw');
    if (!prev) stagger($('.bals', slot('bals')) ?? slot('bals'));
    paintPayday();
  };
  const fail = (id, what, again) => (e) => {
    if (token !== renderToken) return;
    if (id === 'nw') slot('bals').innerHTML = '';
    if (id === 'accts') acctsHtml = null;
    slot(id).innerHTML = errorCard(e, `retry-${id}`, what);
    $(`#retry-${id}`, slot(id))?.addEventListener('click', () => { slot(id).innerHTML = skeleton[id]?.() ?? ''; applyDims(slot(id)); again(); });
  };
  const loads = {
    cash: () => swr('/api/safe-to-spend', (d) => { data.safe = d; paintCash(); }).catch(() => {}),
    pay: () => swr('/api/budgets', (d) => { data.bud = d; paintPayday(); }).catch(() => {}),
    nw: () => swr('/api/networth', (d) => { data.nw = d; paintNw(); paintAccts(); }).catch(fail('nw', 'net worth', loads.nw)),
    accts: () => refreshAccounts(!!accountsData).then(refreshHealth).catch(fail('accts', 'your accounts', loads.accts)),
    review: () => swr('/api/review', (d) => { data.rv = d; paintActions(); }).catch(() => {}),
  };
  accountsListeners.add(refreshHealth);
  accountsListeners.add(paintAccts);
  cleanup.push(() => { accountsListeners.delete(refreshHealth); accountsListeners.delete(paintAccts); });
  function refreshHealth() { if (token === renderToken) slot('health').innerHTML = healthBanner(); }
  paintAccts();
  Object.values(loads).forEach((f) => f());

  el.addEventListener('click', (e) => {
    const qa = e.target.closest('[data-qa]');
    if (qa) { buzz(6); if (qa.dataset.qa === 'chat') chatUi.open(); else if (qa.dataset.qa === 'sync') startSync(); }
  });
  const onTx = () => { if (token === renderToken) { loads.cash(); loads.pay(); loads.review(); } };
  document.addEventListener('mint:txchanged', onTx);
  cleanup.push(() => document.removeEventListener('mint:txchanged', onTx));
}
