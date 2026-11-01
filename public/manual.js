// Manual accounts: money Redbark cannot see (Wise, an overseas bank, a travel
// card), in any currency Frankfurter publishes. The add form with a currency
// picker, the account sheet (native balance with the AUD figure and its rate,
// edit, set balance, archive, delete), hand-entered transactions, and CSV
// statement import with a column mapper and a preview before anything is
// written. Writes queue offline like every other (the page picks the ids, so
// a replay is harmless); an import needs a connection.
'use strict';

const MAN_TYPES = [['transaction', 'Everyday'], ['savings', 'Savings'], ['credit-card', 'Card'], ['loan', 'Loan']];
const MAN_ROLES = [['date', 'Date'], ['description', 'Description'], ['amount', 'Amount'], ['debit', 'Money out'], ['credit', 'Money in'], ['balance', 'Balance'], ['reference', 'Reference']];
const MAN_DATE_FORMATS = [['DMY', 'Day first'], ['MDY', 'Month first'], ['YMD', 'Year first']];
const manHex = (prefix) => `${prefix}_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const isManual = (a) => !!a?.manual;
const foreign = (a) => isManual(a) && a.currency && a.currency !== 'AUD';

// ---------- currencies ----------

let manCurrencies = store.get('fx:currencies');
async function loadCurrencies() {
  try {
    const d = await api('/api/fx/currencies');
    manCurrencies = d.items;
    store.set('fx:currencies', d.items);
  } catch (e) { if (!manCurrencies) throw e; }
  return manCurrencies;
}
const currencyName = (code) => manCurrencies?.find((c) => c.code === code)?.name ?? '';

// Resolves to a currency code, or undefined when dismissed.
function pickCurrency(selected = 'AUD') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
    const panel = openModal(`${sheetHead(null, 'Currency')}
      <label class="search">${I.search}<input id="curq" type="search" placeholder="Search by code or name" autocomplete="off" aria-label="Search currencies"></label>
      <div id="curlist" class="catlist">${skeletonRows(4)}</div>`);
    const list = $('#curlist', panel);
    const paint = (q = '') => {
      const t = q.trim().toLowerCase();
      const items = (manCurrencies ?? []).filter((c) => !t || c.code.toLowerCase().includes(t) || c.name.toLowerCase().includes(t));
      list.innerHTML = items.length
        ? items.map((c) => `<button class="crow ${c.code === selected ? 'on' : ''}" type="button" data-cur="${esc(c.code)}"><span><b>${esc(c.code)}</b> ${esc(c.name)}</span>${c.code === selected ? I.check : ''}</button>`).join('')
        : `<p class="sub pad">No currency matches "${esc(q)}". Frankfurter (ECB) publishes about 30.</p>`;
    };
    const load = () => loadCurrencies().then(() => paint($('#curq', panel)?.value ?? '')).catch((e) => {
      list.innerHTML = errorCard(e, 'curretry', 'the currency list');
      $('#curretry', list)?.addEventListener('click', () => { list.innerHTML = skeletonRows(4); load(); });
    });
    if (manCurrencies) paint();
    load();
    $('#curq', panel).addEventListener('input', (e) => paint(e.target.value));
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-cur]'); if (b) { buzz(6); finish(b.dataset.cur); } });
    modalSheet.root.addEventListener('click', function h(e) { if (e.target.classList.contains('scrim') || e.target.closest('[data-close]')) { modalSheet.root.removeEventListener('click', h); finish(undefined); } });
  });
}

// ---------- rows and notes ----------

// "At 1.5216, rate from 16/10/2026" when the rate is old or could not refresh; '' when fresh.
function fxNote(a) {
  if (!foreign(a) || !a.fx) return '';
  if (a.fx.rate == null) return 'No exchange rate yet: AUD shows once Mint is online';
  if (!a.fx.stale) return '';
  return `Rate from ${dmy(a.fx.date)}${a.fx.error ? ', could not refresh' : ''}`;
}
const audLine = (a) => (foreign(a) ? (a.balance_current == null ? 'AUD when online' : `${money(a.balance_current)} AUD`) : '');

// A Wise account follows its Wise balance (lib/wisesync.mjs). 'sca' means Wise would not hand over
// statements, so the balance stays exact and the rows come from a CSV import.
const wiseOnly = (a) => !!a.wise && a.wise_statements === 'sca';
const wiseFresh = (a) => (a.last_synced_at ? `synced ${ago(a.last_synced_at)}` : 'not synced yet');

// Runs a Wise sync on the shared queue (the same guard as Sync now) and waits for it; the retry
// on a failed Wise account or on the sync card. watchSync keeps the progress card and toasts honest.
async function wiseSyncNow(btn, done = null) {
  try {
    await withBusy(btn, 'Syncing Wise', async () => {
      syncState = { ...(await api('/api/wise/sync', { method: 'POST', body: {} })), elapsed: 0 };
      watchSync();
      await syncWatch;
    });
    await done?.();
  } catch (err) { toast(`Couldn't sync Wise: ${err.detail}`, { error: true, action: { label: 'Retry', fn: () => wiseSyncNow(btn, done) } }); }
}
const wiseRetryTitle = () => (!online ? 'Offline: syncing needs a connection' : demoActive() ? 'Turn off demo mode to sync' : 'Sync Wise now');

function manualRowHtml(a) {
  const note = fxNote(a);
  return `<div class="row" data-acct="${esc(a.id)}">
    <button class="ic" type="button" data-mopen="${esc(a.id)}" aria-label="Details for ${esc(accountName(a))}">${TYPE_ICON[a.type] ?? I.wallet}</button>
    <button class="main" type="button" data-mopen="${esc(a.id)}">
      <div class="t1">${esc(accountName(a))}</div>
      <div class="t2">${esc([a.institution !== a.name && a.institution !== 'Manual' ? a.institution : '', a.tx_count ? plural(a.tx_count, 'txn') : wiseOnly(a) ? 'Balance only' : 'No transactions yet', a.wise ? wiseFresh(a) : ''].filter(Boolean).join(' · '))}</div>
      ${note ? `<div class="t2 warnc">${esc(note)}</div>` : ''}
      ${a.last_sync_error ? `<div class="err-line">${esc(a.last_sync_error)}</div>` : ''}
    </button>
    <div class="amt"><div class="num">${esc(moneyIn(a.balance_native, a.currency))}</div>${foreign(a) ? `<div class="t2 num">${esc(audLine(a))}</div>` : ''}
      <div class="bizline"><span class="tag-biz ${a.is_business ? 'pos' : ''}" data-biztag="${esc(a.id)}">${a.is_business ? 'Business' : 'Personal'}</span>${switchHtml('data-biz', a.id, a.is_business, 'Business account', a.is_business ? 'Business: tap for personal' : 'Personal: tap for business')}</div>
    </div></div>`;
}

// The Manual block on the Accounts screen: its accounts, the add button, and archived ones to bring back.
function manualBlockHtml(d) {
  const mine = d.accounts.filter(isManual);
  const archived = d.archived ?? [];
  const add = `<button class="btn ghost wide mt10" type="button" id="manadd">${I.plus}Add an account by hand</button>`;
  return `<h2>Manual</h2>${mine.length ? `<div class="rows">${mine.map(manualRowHtml).join('')}</div>${add}`
    : `<div class="card">${emptyState({ icon: I.wallet, title: 'Accounts Redbark cannot see', line: d.sync?.wise?.enabled ? 'Your Wise currencies appear here after the next sync. For an overseas bank or a travel card, add it by hand in its own currency, then type in or import its transactions.' : 'Wise, an overseas bank or a travel card: add it by hand in its own currency, then type in or import its transactions.', button: { id: 'manadd', label: 'Add an account', icon: I.plus } })}</div>`}
    ${archived.length ? `<div class="rlabel mt10">Archived</div><div class="rows">${archived.map((a) => `<div class="row"><div class="main"><div class="t1">${esc(acctText(a.nickname || a.name))}</div><div class="t2">${esc([a.institution, a.currency].filter(Boolean).join(' · '))}</div></div><button class="btn ghost" type="button" data-munarch="${esc(a.id)}">Bring back</button></div>`).join('')}</div>` : ''}`;
}

function wireManualBlock(box) {
  box.addEventListener('click', (e) => {
    if (e.target.closest('#manadd')) return openManualAccountForm();
    const o = e.target.closest('[data-mopen]');
    if (o) return openManualAccount(o.dataset.mopen);
    const u = e.target.closest('[data-munarch]');
    if (u) return manualUnarchive(u.dataset.munarch, u);
  });
}

async function manualUnarchive(id, btn) {
  try {
    await withBusy(btn, 'Bringing back', () => api(`/api/manual/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: { archived: false } }));
    toast('Account brought back');
    buzz(10);
    await refreshAccounts(true);
    document.dispatchEvent(new CustomEvent('mint:data'));
  } catch (err) { toast(`Couldn't bring it back: ${err.detail}`, { error: true, action: { label: 'Retry', fn: () => manualUnarchive(id, btn) } }); }
}

// After any manual write: the balances, the account list and every open screen.
async function manualChanged() {
  await refreshAccounts(true);
  document.dispatchEvent(new CustomEvent('mint:data'));
  document.dispatchEvent(new CustomEvent('mint:txchanged'));
}

// ---------- add or edit an account ----------

function openManualAccountForm(a = null) {
  let cur = a?.currency ?? 'AUD';
  const today = todayIso();
  const panel = openSheet(`${sheetHead(a ? 'Edit' : 'Add by hand', a ? accountName(a) : 'New account')}
    <form class="form" novalidate>
      <div class="field"><label for="mn">Name</label><input id="mn" name="name" maxlength="60" autocomplete="off" placeholder="Wise USD" value="${esc(a?.name ?? '')}"></div>
      <div class="field"><label for="mi">Bank or provider</label><input id="mi" name="institution" maxlength="60" autocomplete="off" placeholder="Wise" value="${esc(a?.institution && a.institution !== 'Manual' ? a.institution : '')}"></div>
      <div class="field"><label>Type</label>${segmented('mtype', MAN_TYPES, a?.type ?? 'transaction')}</div>
      <div class="field"><label>Currency</label>${a ? `<div class="erow static"><span class="v l">${esc(cur)} ${esc(currencyName(cur))}</span></div><div class="sub">The currency stays as it is. For another currency, add another account.</div>`
        : `<button class="erow solo" type="button" id="mcur"><span class="v l"><b>${esc(cur)}</b> ${esc(currencyName(cur) || 'Australian Dollar')}</span>${I.chevron}</button>`}</div>
      <div class="two"><div class="field"><label for="mob">Opening balance</label><div class="money-in"><span id="mcurcode">${esc(cur)}</span><input id="mob" name="opening" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${a ? esc(centsToInput(a.opening_balance)) : ''}"></div></div>
        <div class="field"><label for="mod">As at the start of</label><input id="mod" name="opening_date" type="date" max="${today}" value="${esc(a?.opening_date ?? today)}"></div></div>
      <p class="sub">Transactions dated before this day are history: they are kept but do not change the balance.</p>
      ${a?.wise ? '<p class="sub">This account follows Wise, which set the opening balance. If you change it, the next sync adds a balance adjustment to match Wise again.</p>' : ''}
      ${a ? '' : `<div class="field"><label>Counts as</label>${segmented('mbiz', [['personal', 'Personal'], ['biz', 'Business']], 'personal')}</div>`}
      <button class="btn wide" type="submit">${a ? `${I.check}Save` : `${I.plus}Add account`}</button>
    </form>`, 'manualform');
  const form = $('form', panel);
  const d = bindDraft(form, a ? `manual:${a.id}` : 'manual:new');
  const type = wireSeg(form, 'mtype', () => {});
  const biz = a ? null : wireSeg(form, 'mbiz', () => {});
  const name = $('#mn', form);
  const ob = $('#mob', form);
  const od = $('#mod', form);
  const checkName = () => fieldError(name, name.value.trim() ? '' : 'Give it a name, like Wise USD');
  const checkOb = () => fieldError(ob, ob.value.trim() && Number.isNaN(parseMoney(ob.value)) ? 'Enter an amount like 1250.00' : '');
  const checkOd = () => fieldError(od, !od.value ? 'Pick the date the balance is from' : od.value > today ? 'The date cannot be in the future' : '');
  name.addEventListener('input', checkName);
  ob.addEventListener('input', checkOb);
  od.addEventListener('change', checkOd);
  $('#mcur', form)?.addEventListener('click', async () => {
    const c = await pickCurrency(cur);
    if (!c) return;
    cur = c;
    $('#mcur .v', form).innerHTML = `<b>${esc(c)}</b> ${esc(currencyName(c))}`;
    $('#mcurcode', form).textContent = c;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (![checkName(), checkOb(), checkOd()].every(Boolean)) return;
    formError(form, null);
    const body = {
      name: name.value.trim(), institution: $('#mi', form).value.trim() || null, type: type() ?? a?.type ?? 'transaction',
      opening_balance: ob.value.trim() ? parseMoney(ob.value) : 0, opening_date: od.value,
    };
    try {
      if (a) {
        const r = await withBusy($('button[type=submit]', form), 'Saving', () => mutate({ method: 'PATCH', path: `/api/manual/accounts/${encodeURIComponent(a.id)}`, body }));
        d.clear();
        closeSheet();
        toast(r.queued ? 'Saved offline, syncs when you are back' : `${body.name} saved`);
      } else {
        const id = manHex('man');
        const full = { ...body, id, currency: cur, is_business: biz?.() === 'biz' };
        const r = await withBusy($('button[type=submit]', form), 'Adding, fetching the rate', () => mutate({ method: 'POST', path: '/api/manual/accounts', body: full }));
        d.clear();
        closeSheet();
        if (r.queued) {
          // Shown at once; the AUD figure comes once the server has a rate.
          accountsData?.accounts.push({ id, manual: true, name: full.name, institution: full.institution ?? 'Manual', type: full.type, currency: cur, balance_native: full.opening_balance, balance_current: cur === 'AUD' ? full.opening_balance : null, is_business: full.is_business ? 1 : 0, hidden: 0, tx_count: 0, fx: null });
          accountsListeners.forEach((f) => f());
          toast('Saved offline, syncs when you are back');
        } else toast(`Added ${full.name}`);
      }
      buzz(12);
      manualChanged();
    } catch (err) {
      if (err.status === 400 && /name/.test(err.detail)) fieldError(name, err.detail.replace(/^400 /, ''));
      else formError(form, err, a ? 'Save' : 'Add it');
    }
  });
}

// ---------- the account sheet ----------

async function openManualAccount(id) {
  const a = acctById(id);
  if (!a) return;
  let info = null;
  const draw = () => {
    const s = shownAccount(a); // the balance as a demo screen shows it
    const note = fxNote(a);
    const imports = info?.imports ?? [];
    const rows = [
      ['Type', TYPE_LABEL[a.type] ?? titleCase(a.type)],
      ['Opening balance', `${moneyIn(a.opening_balance, a.currency)} on ${dmy(a.opening_date)}`],
      ['Rate', foreign(a) && a.fx?.rate ? `1 ${a.currency} = ${a.fx.rate.toLocaleString('en-AU', { maximumFractionDigits: 6 })} AUD, ${dmy(a.fx.date)} (Frankfurter, ECB)` : null],
      ['Transactions', info ? `${info.summary.transactions.toLocaleString('en-AU')}${info.summary.earliest ? `, ${dmy(info.summary.earliest)} to ${dmy(info.summary.latest)}` : ''}` : 'Loading'],
    ].filter(([, v]) => v != null);
    return `${sheetHead(a.wise ? 'Wise, synced' : a.institution && a.institution !== a.name && a.institution !== 'Manual' ? `${a.institution}, kept by hand` : 'Kept by hand', accountName(a))}
      <div class="amount-big num">${esc(moneyIn(s.balance_native, s.currency))}</div>
      ${foreign(s) ? `<div class="sub num">${esc(audLine(s))}</div>` : ''}
      ${a.wise ? (wiseOnly(a)
        ? `<div class="nudge">${I.refresh}<div><b>Balance syncs from Wise; transactions via CSV import</b><small>Wise would not hand over statements to a personal token, so Mint keeps the balance exact and you add the rows with Import CSV. Last ${esc(wiseFresh(a))}.</small></div></div>`
        : `<div class="sub">Balance and transactions sync from Wise, read only, every 30 minutes and on Sync now. Last ${esc(wiseFresh(a))}.</div>`) : ''}
      ${a.wise && a.last_sync_error ? `<div class="error compact"><div class="h">Last Wise sync failed for this account</div><div class="d">${esc(a.last_sync_error)}</div><button class="btn ghost" type="button" id="wiseretry" ${online && !demoActive() ? '' : 'disabled'} title="${esc(wiseRetryTitle())}">${I.refresh}Retry</button></div>` : ''}
      ${note ? `<div class="nudge">${I.clock}<div><b>${esc(note)}</b><small>The AUD figure uses the last rate Mint has. It updates on its own when Frankfurter answers.</small></div></div>` : ''}
      <div class="man-acts">
        <button class="btn" type="button" id="maddtx">${I.plus}Transaction</button>
        <button class="btn ghost" type="button" id="mimport" ${online && !demoActive() ? '' : 'disabled'} title="${!online ? 'Importing needs a connection' : demoActive() ? 'Turn off demo mode to import' : 'Import a CSV statement'}">${I.file}Import CSV</button>
        <button class="btn ghost" type="button" id="msetbal">${I.sliders}Set balance</button>
      </div>
      ${!online ? '<div class="sub">Offline: importing needs a connection. Adding a transaction still works and syncs later.</div>' : ''}
      <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <p><a class="btn ghost wide" href="/transactions?account=${encodeURIComponent(a.id)}" data-nav>${I.list}Transactions</a></p>
      ${imports.length ? `<h2>Imports</h2><div class="rows">${imports.slice(0, 8).map((i) => `<div class="row"><div class="main"><div class="t1">${esc(i.file_name || 'CSV import')}</div><div class="t2">${esc(dmy(PERTH.format(new Date(i.created_at))))} · ${esc(plural(i.rows, 'row'))}${i.from_date ? ` · ${esc(dmy(i.from_date))} to ${esc(dmy(i.to_date))}` : ''}${i.undone_at ? ' · undone' : ''}</div></div>${i.undone_at ? '' : `<button class="btn ghost danger-text" type="button" data-mundo="${i.id}" title="Remove the rows this import added">Undo import</button>`}</div>`).join('')}</div>` : ''}
      <button class="btn ghost wide mt10" type="button" id="medit">${I.edit}Edit details</button>
      <button class="btn ghost wide mt10" type="button" id="march">${I.download}Archive</button>
      <button class="btn danger wide mt10" type="button" id="mdel">${I.trash}Delete account</button>`;
  };
  // Listeners go on this wrapper, which is new each time, so a sheet opened before never answers for this one.
  const host = $('#msheet', openSheet(`<div id="msheet">${draw()}</div>`, 'account'));
  const redraw = () => { if (host.isConnected) host.innerHTML = draw(); };
  const load = () => api(`/api/manual/accounts/${encodeURIComponent(id)}`).then((d) => { info = d; Object.assign(a, d.account); redraw(); }).catch(() => { info = { summary: { transactions: a.tx_count ?? 0 }, imports: [] }; redraw(); });
  load();
  host.addEventListener('click', async (e) => {
    const wr = e.target.closest('#wiseretry');
    if (wr) return wiseSyncNow(wr, load);
    if (e.target.closest('#maddtx')) return openManualTxForm(a);
    if (e.target.closest('#mimport')) return openImport(a, load);
    if (e.target.closest('#msetbal')) return openSetBalance(a, load);
    if (e.target.closest('#medit')) return openManualAccountForm(a);
    const u = e.target.closest('[data-mundo]');
    if (u) return undoManualImport(Number(u.dataset.mundo), u, load);
    if (e.target.closest('#march')) {
      closeSheet();
      undoable({
        label: `${accountName(a)} archived`,
        apply: () => { accountsData.accounts = accountsData.accounts.filter((x) => x.id !== a.id); accountsListeners.forEach((f) => f()); },
        revert: () => { refreshAccounts(true); },
        op: { method: 'PATCH', path: `/api/manual/accounts/${encodeURIComponent(a.id)}`, body: { archived: true } },
      });
      setTimeout(manualChanged, 5600);
    }
    if (e.target.closest('#mdel')) confirmManualDelete(a, info?.summary.transactions ?? a.tx_count ?? 0);
  });
}

function confirmManualDelete(a, n) {
  const panel = openModal(`${sheetHead(null, `Delete ${accountName(a)}?`)}
    <p>This removes the account and ${n ? `its <b>${esc(plural(n, 'transaction'))}</b>` : 'its balance'} from Mint. Your other accounts and their rows are not touched. To keep the history but hide the account, archive it instead.${a.wise ? ' Wise brings a deleted account back on its next sync; an archived one stays away.' : ''}</p>
    <div class="sticky-actions"><button class="btn ghost" type="button" data-close>Keep it</button><button class="btn danger" type="button" id="mdelyes">${I.trash}Delete${n ? ` with ${esc(plural(n, 'transaction'))}` : ''}</button></div>`);
  $('#mdelyes', panel).addEventListener('click', () => {
    buzz(20);
    closeModal();
    closeSheet();
    undoable({
      label: `${accountName(a)} deleted`,
      apply: () => { accountsData.accounts = accountsData.accounts.filter((x) => x.id !== a.id); accountsListeners.forEach((f) => f()); },
      revert: () => { refreshAccounts(true); },
      op: { method: 'DELETE', path: `/api/manual/accounts/${encodeURIComponent(a.id)}` },
    });
    setTimeout(manualChanged, 5600);
  });
}

async function undoManualImport(importId, btn, done) {
  try {
    const r = await withBusy(btn, 'Undoing', () => api(`/api/manual/imports/${importId}`, { method: 'DELETE' }));
    toast(`Import undone, ${plural(r.removed, 'row')} removed`);
    buzz(14);
    done?.();
    manualChanged();
  } catch (err) { toast(`Couldn't undo the import: ${err.detail}`, { error: true, action: { label: 'Retry', fn: () => undoManualImport(importId, btn, done) } }); }
}

function openSetBalance(a, done) {
  const today = todayIso();
  const panel = openModal(`${sheetHead(accountName(a), 'Set balance')}
    <form class="form" novalidate>
      <p class="sub">Mint shows ${esc(moneyIn(shownAccount(a).balance_native, a.currency))}. Enter what the account really holds and Mint records the difference as a balance adjustment, never as spend or income.</p>
      <div class="two"><div class="field"><label for="sbv">Balance</label><div class="money-in"><span>${esc(a.currency)}</span><input id="sbv" name="balance" inputmode="decimal" autocomplete="off"></div></div>
        <div class="field"><label for="sbd">On</label><input id="sbd" name="date" type="date" max="${today}" min="${esc(a.opening_date)}" value="${today}"></div></div>
      <button class="btn wide" type="submit">${I.check}Set balance</button>
    </form>`);
  const form = $('form', panel);
  const v = $('#sbv', form);
  const check = () => fieldError(v, !v.value.trim() ? 'Enter the balance' : Number.isNaN(parseMoney(v.value)) ? 'Enter an amount like 1250.00' : '');
  v.addEventListener('input', check);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!check()) return;
    formError(form, null);
    try {
      const r = await withBusy($('button[type=submit]', form), 'Recording', () => mutate({ method: 'POST', path: `/api/manual/accounts/${encodeURIComponent(a.id)}/balance`, body: { balance: parseMoney(v.value), date: $('#sbd', form).value || today } }));
      closeModal();
      toast(r.queued ? 'Saved offline, syncs when you are back' : 'Balance set');
      buzz(12);
      done?.();
      manualChanged();
    } catch (err) {
      if (err.status === 400 && /already/.test(err.detail)) fieldError(v, 'That is already the balance');
      else formError(form, err, 'Set it');
    }
  });
}

// ---------- a transaction by hand ----------

function openManualTxForm(a, t = null) {
  const today = todayIso();
  const native = t ? t.amount_native ?? t.amount : null;
  let catId = t?.category_id ?? null;
  const panel = openSheet(`${sheetHead(accountName(a), t ? 'Edit transaction' : 'New transaction')}
    <form class="form" novalidate>
      <div class="field"><label>Money</label>${segmented('mdir', [['out', 'Out'], ['in', 'In']], native != null && native > 0 ? 'in' : 'out')}</div>
      <div class="two"><div class="field"><label for="mta">Amount</label><div class="money-in"><span>${esc(a.currency)}</span><input id="mta" name="amount" inputmode="decimal" autocomplete="off" value="${native != null ? esc(centsToInput(Math.abs(native))) : ''}"></div></div>
        <div class="field"><label for="mtd">Date</label><input id="mtd" name="date" type="date" max="${today}" value="${esc(t?.date ?? today)}"></div></div>
      <div class="field"><label for="mtx">Description</label><input id="mtx" name="description" maxlength="200" autocomplete="off" placeholder="Cafe in Bangkok" value="${esc(t?.description ?? '')}"></div>
      <div class="field"><label>Category</label><button class="erow solo" type="button" id="mtc"><span class="v l">${esc(catId ? catName(catId) : 'Let the rules decide')}</span>${I.chevron}</button></div>
      <div class="field"><label for="mtn">Note</label><input id="mtn" name="note" maxlength="500" autocomplete="off" value="${esc(t?.note ?? '')}"></div>
      <div class="field"><label>Counts as</label>${segmented('mtb', [['auto', 'Account'], ['biz', 'Business'], ['personal', 'Personal']], t?.is_business == null ? 'auto' : t.is_business ? 'biz' : 'personal')}</div>
      ${foreign(a) ? '<p class="sub">Mint converts it to AUD at the rate for its date.</p>' : ''}
      <button class="btn wide" type="submit">${t ? `${I.check}Save` : `${I.plus}Add`}</button>
      ${t ? `<button class="btn danger wide" type="button" id="mtdel">${I.trash}Delete transaction</button>` : ''}
    </form>`, 'manualtx');
  const form = $('form', panel);
  const d = bindDraft(form, t ? `mtx:${t.id}` : `mtx:new:${a.id}`);
  const dir = wireSeg(form, 'mdir', () => {});
  const biz = wireSeg(form, 'mtb', () => {});
  const amt = $('#mta', form);
  const date = $('#mtd', form);
  const desc = $('#mtx', form);
  const checkAmt = () => { const c = parseMoney(amt.value); return fieldError(amt, !amt.value.trim() ? 'Enter the amount' : Number.isNaN(c) || c === 0 ? 'Enter an amount like 12.50' : ''); };
  const checkDate = () => fieldError(date, !date.value ? 'Pick a date' : date.value > today ? 'The date cannot be in the future' : '');
  const checkDesc = () => fieldError(desc, desc.value.trim() ? '' : 'Say what it was');
  amt.addEventListener('input', checkAmt);
  date.addEventListener('change', checkDate);
  desc.addEventListener('input', checkDesc);
  $('#mtc', form).addEventListener('click', async () => {
    const id = await pickCategory({ title: 'File under', selected: catId, allowClear: true });
    if (id === undefined) return;
    catId = id;
    $('#mtc .v', form).textContent = id ? catName(id) : 'Let the rules decide';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (![checkAmt(), checkDate(), checkDesc()].every(Boolean)) return;
    formError(form, null);
    const cents = Math.abs(parseMoney(amt.value)) * ((dir() ?? 'out') === 'out' ? -1 : 1);
    const b = biz();
    const body = { date: date.value, amount: cents, description: desc.value.trim(), note: $('#mtn', form).value.trim() || null, category_id: catId, is_business: b === 'auto' ? null : b === 'biz' };
    try {
      const op = t ? { method: 'PATCH', path: `/api/manual/transactions/${encodeURIComponent(t.id)}`, body } : { method: 'POST', path: `/api/manual/accounts/${encodeURIComponent(a.id)}/transactions`, body: { ...body, id: manHex('mtx') } };
      const r = await withBusy($('button[type=submit]', form), t ? 'Saving' : 'Adding', () => mutate(op));
      d.clear();
      closeSheet();
      if (t && r.data) { Object.assign(t, r.data); txChanged(t); }
      toast(r.queued ? 'Saved offline, syncs when you are back' : t ? 'Saved' : `Added ${moneyIn(cents, a.currency)}`);
      buzz(12);
      reloadTransactions();
      manualChanged();
    } catch (err) {
      if (err.status === 400 && /date/.test(err.detail)) fieldError(date, err.detail.replace(/^400 /, ''));
      else formError(form, err, t ? 'Save' : 'Add it');
    }
  });
  $('#mtdel', form)?.addEventListener('click', () => {
    closeSheet();
    undoable({
      label: 'Transaction deleted',
      apply: () => { txMem.items = txMem.items.filter((x) => x.id !== t.id); txChanged(); },
      revert: () => reloadTransactions(),
      op: { method: 'DELETE', path: `/api/manual/transactions/${encodeURIComponent(t.id)}` },
    });
    setTimeout(manualChanged, 5600);
  });
}

// ---------- CSV import ----------

async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function openImport(a, done) {
  const st = { file: null, b64: null, preview: null, mapping: null, dateFormat: null, setBalance: false, busy: false, error: null, seq: 0 };
  const panel = openModal(`${sheetHead(accountName(a), 'Import a CSV statement')}<div id="imbody"></div>`);
  const body = $('#imbody', panel);

  const pickHtml = () => `<label class="card import-drop" for="imfile">${I.file}<b>Choose a CSV file</b><span class="sub">Exported from ${esc(a.institution && a.institution !== 'Manual' ? a.institution : 'the bank')}. Up to 2 MB and 20,000 rows. Nothing is saved until you have checked the preview.</span></label>
    <input type="file" id="imfile" accept=".csv,.txt,text/csv,text/plain" hidden>`;
  const stepsHtml = (at, label) => `<div class="card" role="status" aria-live="polite"><ol class="steps">${['Reading the file', 'Checking every row against your book'].map((s, i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}"><span class="dot">${i < at ? I.check : i === at ? '<span class="spin dim"></span>' : ''}</span><span>${esc(i === at && label ? label : s)}</span></li>`).join('')}</ol></div>`;

  const colOpts = (cols, sel) => `<option value="">Not in this file</option>${cols.map((c, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
  const previewHtml = (p) => {
    const m = p.mapping;
    const twoCols = m.amount == null && (m.debit != null || m.credit != null);
    const roles = MAN_ROLES.filter(([k]) => (twoCols ? k !== 'amount' : k !== 'debit' && k !== 'credit'));
    const sb = p.statement_balance;
    const sbDiff = sb && sb.balance !== p.balance_after;
    return `${p.warnings.map((w) => `<div class="nudge">${I.alert}<div><b>${esc(w)}</b></div></div>`).join('')}
      <div class="stat-row imp-counts" role="status">
        <div class="stat"><div class="k">To import</div><div class="v num">${p.counts.import.toLocaleString('en-AU')}</div></div>
        <div class="stat"><div class="k">Already there</div><div class="v num">${p.counts.duplicate.toLocaleString('en-AU')}</div></div>
        <div class="stat"><div class="k">Can't read</div><div class="v num ${p.counts.failed ? 'warnc' : ''}">${p.counts.failed.toLocaleString('en-AU')}</div></div>
      </div>
      ${p.incomplete ? '<p class="sub warnc">Pick the date, description and amount columns to see the rows.</p>' : ''}
      ${p.sample.length ? `<h2>First rows</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Row</th><th scope="col">Date</th><th scope="col">Description</th><th scope="col" class="r">Amount</th></tr></thead>
        <tbody>${p.sample.map((r) => `<tr class="${r.duplicate ? 'dim' : ''}"><td class="num">${r.row}</td><td>${esc(dmy(r.date))}</td><td>${esc(r.description)}${r.duplicate ? ' <span class="chip">Already in Mint</span>' : ''}</td><td class="r num">${esc(signedIn(r.amount, a.currency))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${p.failures.length ? `<h2>Rows Mint can't read</h2><div class="rows">${p.failures.slice(0, 20).map((f) => `<div class="row"><div class="main"><div class="t1">Row ${f.row}</div><div class="t2 wrap">${esc(f.reason)}</div></div></div>`).join('')}</div>${p.failures.length > 20 || p.counts.failed > p.failures.length ? `<p class="sub">And ${plural(p.counts.failed - 20, 'more row')}.</p>` : ''}<p class="sub">These are left out. Fix them in the file and import it again: rows already in Mint are skipped.</p>` : ''}
      <h2>Columns and dates</h2>
      <div class="field"><label>Amounts are in</label>${segmented('imamt', [['one', 'One column'], ['two', 'Out and in columns']], twoCols ? 'two' : 'one')}</div>
      <div class="grid2">${roles.map(([k, label]) => `<div class="field"><label for="imc-${k}">${esc(label)}</label><select id="imc-${k}" data-role="${k}">${colOpts(p.columns, m[k])}</select></div>`).join('')}</div>
      <div class="field"><label>Dates read as</label>${segmented('imdf', MAN_DATE_FORMATS, p.date_format)}</div>
      ${!p.incomplete ? `<p class="sub">Balance now ${esc(moneyIn(p.balance_now, a.currency))}, after the import ${esc(moneyIn(p.balance_after, a.currency))}.</p>` : ''}
      ${sbDiff ? `<label class="erow static"><span class="k">Match the statement<small>Its closing balance is ${esc(moneyIn(sb.balance, a.currency))} on ${esc(dmy(sb.date))}. Record the difference as an adjustment.</small></span><input type="checkbox" id="imsb" ${st.setBalance ? 'checked' : ''}></label>` : ''}
      <div class="sticky-actions"><button class="btn ghost" type="button" id="imother">Another file</button><button class="btn" type="button" id="imgo" ${p.incomplete || !p.counts.import ? 'disabled' : ''} title="${p.incomplete ? 'Pick the columns first' : !p.counts.import ? 'Nothing new to import: every row is already in Mint or unreadable' : 'Import these rows'}">${I.check}${p.counts.import ? `Import ${esc(p.counts.import.toLocaleString('en-AU'))}` : 'Nothing new'}</button></div>`;
  };

  const paint = () => {
    if (st.error) {
      body.innerHTML = `${st.preview ? previewHtml(st.preview) : pickHtml()}<div class="error"><div class="h">${esc(st.error.headline)}</div><div class="d">${esc(st.error.detail)}</div><button class="btn ghost" type="button" id="imretry">${I.refresh}Retry</button></div>`;
    } else if (st.busy) body.innerHTML = stepsHtml(st.busy === 'read' ? 0 : 1, st.busy === 'import' ? `Importing ${plural(st.preview?.counts.import ?? 0, 'row')}` : '');
    else body.innerHTML = st.preview ? previewHtml(st.preview) : pickHtml();
    wire();
  };

  async function run(dry = true) {
    const mine = ++st.seq;
    st.error = null;
    st.busy = st.b64 ? 'check' : 'read';
    if (!dry) st.busy = 'import';
    paint();
    const stopSlow = slowNote(body, 5000, 'Still working. A long statement can take a few seconds.');
    try {
      if (!st.b64) { st.b64 = await fileBase64(st.file); st.busy = 'check'; paint(); }
      const req = { base64: st.b64, file_name: st.file.name, dry_run: dry, ...(st.mapping ? { mapping: st.mapping } : {}), ...(st.dateFormat ? { date_format: st.dateFormat } : {}), ...(!dry && st.setBalance ? { set_balance: true } : {}) };
      const r = await api(`/api/manual/accounts/${encodeURIComponent(a.id)}/import`, { method: 'POST', body: req, retries: dry ? 2 : 0 });
      if (mine !== st.seq) return;
      st.busy = false;
      if (dry) { st.preview = r; st.mapping = r.incomplete ? null : r.mapping; st.dateFormat = r.date_format; paint(); return; }
      closeModal();
      buzz(16);
      const undo = r.import_id ? { label: 'Undo', fn: () => api(`/api/manual/imports/${r.import_id}`, { method: 'DELETE' }).then((u) => { toast(`Import undone, ${plural(u.removed, 'row')} removed`); manualChanged(); done?.(); }).catch((err) => toast(`Couldn't undo the import: ${err.detail}`, { error: true })) } : null;
      toast(`Imported ${plural(r.imported, 'row')}${r.duplicates ? `, ${r.duplicates} already there` : ''}${r.failed ? `, ${r.failed} left out` : ''}`, { action: undo, ms: 9000 });
      done?.();
      reloadTransactions();
      manualChanged();
    } catch (e) {
      if (mine !== st.seq) return;
      st.busy = false;
      st.error = { headline: dry ? "Couldn't read the statement" : "Couldn't import the statement", detail: e.detail ?? e.message, dry };
      if (!dry || st.preview) paint(); else { st.b64 = st.b64 ?? null; paint(); }
    } finally { stopSlow(); }
  }

  function wire() {
    $('#imfile', body)?.addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) { st.error = { headline: 'That file is too big', detail: `${(f.size / 1048576).toFixed(1)} MB; an import takes up to 2 MB. Export a shorter date range.`, dry: true }; paint(); return; }
      Object.assign(st, { file: f, b64: null, preview: null, mapping: null, dateFormat: null, setBalance: false });
      run(true);
    });
    $('#imretry', body)?.addEventListener('click', () => { const dry = st.error?.dry !== false; st.error = null; if (st.file) run(dry); else paint(); });
    $('#imother', body)?.addEventListener('click', () => { Object.assign(st, { file: null, b64: null, preview: null, mapping: null, dateFormat: null }); paint(); $('#imfile', body)?.click(); });
    $('#imgo', body)?.addEventListener('click', () => run(false));
    $('#imsb', body)?.addEventListener('change', (e) => { st.setBalance = e.target.checked; buzz(6); });
    const p = st.preview;
    if (!p) return;
    const remap = () => {
      const m = { ...p.mapping };
      for (const s of $$('select[data-role]', body)) m[s.dataset.role] = s.value === '' ? null : Number(s.value);
      st.mapping = m;
      run(true);
    };
    $$('select[data-role]', body).forEach((s) => s.addEventListener('change', remap));
    wireSeg(body, 'imamt', (v) => {
      const m = { ...p.mapping };
      if (v === 'two') { m.amount = null; } else { m.debit = null; m.credit = null; }
      p.mapping = m;
      st.preview = { ...p, mapping: m };
      paint();
    });
    wireSeg(body, 'imdf', (v) => { st.dateFormat = v; st.mapping = p.incomplete ? null : p.mapping; run(true); });
  }
  paint();
}
