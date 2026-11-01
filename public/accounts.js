// Accounts and sync: connection health and consent expiry, Sync now with
// stepped progress, accounts with the personal/business flag, manual assets
// (shares, super) with a monthly nudge, the rules editor, and review queues.
// The section is in the URL (?s=).
'use strict';

const ACC_TABS = [['accounts', 'Accounts'], ['assets', 'Assets'], ['rules', 'Rules'], ['review', 'Review']];

// ---------- sync card ----------

function syncCardHtml() {
  const d = accountsData;
  const s = syncState?.running ? syncState : null;
  const last = d?.sync;
  const lastErr = !s && (syncState?.lastError ?? last?.lastError);
  const failing = d?.accounts.filter((a) => a.last_sync_error).length ?? 0;
  const step = s ? Math.min(1, (s.step || 0) / Math.max(1, s.steps || 1)) : 0;
  const slow = s && s.elapsed > 5000;
  const waiting = queue.all().length;
  return `<div class="card sync" id="synccard">
    <div class="head"><span class="card-ic">${I.refresh}</span><div class="sh-t"><div class="t1">${s ? 'Syncing' : 'Sync'}</div>
      <div class="sub">${s ? esc(s.label || 'Starting') : `Last ${esc(ago(last?.lastPollAt))}${last?.nextPollAt ? ` · next ${esc(new Date(last.nextPollAt).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Perth' }))}` : ''}`}</div></div>
      <button class="btn ${s ? 'ghost' : ''}" type="button" id="syncnow" ${s || !online ? 'disabled' : ''} title="${!online ? 'Offline: sync needs a connection' : s ? 'A sync is already running' : 'Pull the latest from every bank'}">${s ? '<span class="spin"></span>Syncing' : `${I.refresh}Sync now`}</button></div>
    ${s ? `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${s.steps}" aria-valuenow="${s.step}"><i data-w="${(step * 100).toFixed(1)}"></i></div>
      <div class="steptext">Step ${s.step} of ${s.steps}${s.label ? `: ${esc(s.label)}` : ''}</div>${slow ? '<div class="slow">Still working. A first sync can take a few minutes.</div>' : ''}` : ''}
    ${!online ? `<div class="slow">Offline: sync needs a connection.${waiting ? ` ${plural(waiting, 'saved change')} will go up when you are back.` : ''}</div>` : ''}
    ${lastErr ? `<div class="error"><div class="h">The last sync failed</div><div class="d">${esc(lastErr)}</div></div>` : ''}
    ${!s && last?.wise?.error ? `<div class="error compact"><div class="h">Wise sync failed</div><div class="d">${esc(last.wise.error)}</div><button class="btn ghost" type="button" id="wiseretrycard" ${online && !demoActive() ? '' : 'disabled'} title="${esc(wiseRetryTitle())}">${I.refresh}Retry</button></div>` : ''}
    ${!s && failing ? `<div class="slow">${failing} account${failing > 1 ? 's' : ''} failed on the last sync</div>` : ''}
    <div class="sub">Webhook ${d?.sync.webhook ? (d.sync.lastWebhookAt ? `last delivery ${esc(ago(d.sync.lastWebhookAt))}` : 'ready, no deliveries yet') : 'not set up, polling every 30 min'} · balance snapshot ${esc(ago(last?.lastSnapshotAt))}</div>
  </div>`;
}
function renderSyncCard() {
  const el = $('#synccard');
  if (!el) return;
  el.outerHTML = syncCardHtml();
  wireSyncCard();
}
function wireSyncCard() {
  applyDims($('#synccard') ?? document);
  $('#wiseretrycard')?.addEventListener('click', (e) => wiseSyncNow(e.currentTarget));
  $('#syncnow')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.innerHTML = '<span class="spin"></span>Starting';
    try {
      const r = await api('/api/sync', { method: 'POST', body: {} });
      syncState = { ...r, elapsed: 0 };
      renderSyncCard();
      buzz();
      watchSync();
    } catch (err) {
      toast(`Couldn't start a sync: ${err.detail}`, { error: true, action: { label: 'Retry', fn: () => $('#syncnow')?.click() } });
      renderSyncCard();
    }
  });
}

// ---------- accounts ----------

function accountRow(a) {
  const sub = `${TYPE_LABEL[a.type] ?? titleCase(a.type)} · ${acctText(a.number_masked ?? '')}`;
  let side = '';
  if (a.type === 'credit-card' && a.balance_available != null) side = `${money(a.balance_available)} available`;
  if (a.type === 'loan' && a.rates?.lending_rate) side = `${pct(a.rates.lending_rate)}${a.loan?.repayment_type ? ` · ${titleCase(a.loan.repayment_type)}` : ''}`;
  const held = a.earliest_date ? `Held since ${dmy(a.earliest_date)}` : a.backfill_done_at ? 'No history' : 'Backfill pending';
  return `<div class="row" data-acct="${esc(a.id)}">
    <button class="ic" type="button" data-open="${esc(a.id)}" aria-label="Details for ${esc(accountName(a))}">${TYPE_ICON[a.type] ?? I.wallet}</button>
    <button class="main" type="button" data-open="${esc(a.id)}">
      <div class="t1">${esc(accountName(a))}</div>
      <div class="t2">${esc(sub)}</div>
      <div class="t2">${esc(held)}${a.tx_count ? ` · ${a.tx_count.toLocaleString('en-AU')} txns` : ''}</div>
      ${a.last_sync_error ? `<div class="err-line">${esc(a.last_sync_error)}</div>` : ''}
    </button>
    <div class="amt"><div class="num">${esc(money(a.balance_current))}</div>${side ? `<div class="t2">${esc(side)}</div>` : ''}
      <div class="bizline"><span class="tag-biz ${a.is_business ? 'pos' : ''}" data-biztag="${esc(a.id)}">${a.is_business ? 'Business' : 'Personal'}</span>${switchHtml('data-biz', a.id, a.is_business, 'Business account', a.is_business ? 'Business: tap for personal' : 'Personal: tap for business')}</div>
    </div></div>`;
}

function connectionBlock(c, accounts) {
  let chip;
  if (c.status !== 'active') chip = `<span class="chip bad">${esc(titleCase(c.status))}</span>`;
  else if (c.consent_warning) chip = `<span class="chip warn">Renew in ${plural(c.consent_days, 'day')}</span>`;
  else chip = '<span class="chip ok">Connected</span>';
  const exp = c.consent_expires_at ? `Consent to ${dmy(PERTH.format(new Date(c.consent_expires_at)))}${c.consent_days != null ? ` (${plural(c.consent_days, 'day')})` : ''}` : 'No consent expiry reported';
  return `<h2>${esc(c.institution)}</h2>
    <div class="rows"><div class="row"><div class="main"><div class="t2 wrap">${esc(exp)} · refreshed ${esc(ago(c.last_refreshed_at))}</div></div>${chip}</div>
    ${accounts.map(accountRow).join('')}</div>`;
}

function logRow(l) {
  const what = l.kind === 'account' ? acctText(l.account_name ?? l.account_id) : { poll: 'Sync', reconcile: 'Nightly reconcile', snapshot: 'Snapshot', wise: 'Wise' }[l.kind] ?? l.kind;
  const counts = [l.inserted && `${l.inserted} new`, l.updated && `${l.updated} changed`, l.removed && `${l.removed} settled`].filter(Boolean).join(', ') || `${l.fetched} checked`;
  return `<div class="row"><div class="main"><div class="t1">${esc(what)}</div><div class="t2">${esc(ago(l.started_at))} · ${esc(counts)}</div>${l.error ? `<div class="err-line">${esc(l.error)}</div>` : ''}</div>
    <span class="chip ${l.ok ? 'ok' : 'bad'}">${l.ok ? 'OK' : 'Failed'}</span></div>`;
}

function accountsSection(box) {
  const d = shownAccountsData();
  const groups = d.connections.map((c) => connectionBlock(c, d.accounts.filter((a) => a.connection_id === c.id)));
  const orphans = d.accounts.filter((a) => !a.manual && !d.connections.some((c) => c.id === a.connection_id));
  box.innerHTML = `${d.accounts.some((a) => !a.manual) ? '' : `<div class="card">${emptyState({ icon: I.bank, title: 'No bank accounts yet', line: 'Run a sync to pull your banks.' })}</div>`}
    <div class="stagger">${groups.join('')}${orphans.length ? `<h2>Other</h2><div class="rows">${orphans.map(accountRow).join('')}</div>` : ''}<div id="manblock">${manualBlockHtml(d)}</div></div>
    ${d.log.length ? `<h2>Recent syncs</h2><div class="rows">${d.log.slice(0, 10).map(logRow).join('')}</div>` : ''}`;
  stagger($('.stagger', box), ':scope > *');
}

async function toggleBusiness(sw) {
  const id = sw.dataset.biz;
  const a = accountsData.accounts.find((x) => x.id === id);
  if (!a || sw.getAttribute('aria-busy') === 'true') return;
  const next = !a.is_business;
  const apply = (v) => {
    a.is_business = v ? 1 : 0;
    store.set('accounts', accountsData);
    $$(`[data-biz="${CSS.escape(id)}"]`).forEach((s) => s.setAttribute('aria-checked', v ? 'true' : 'false'));
    $$(`[data-biztag="${CSS.escape(id)}"]`).forEach((t) => { t.textContent = v ? 'Business' : 'Personal'; t.classList.toggle('pos', v); });
  };
  apply(next);
  sw.setAttribute('aria-busy', 'true');
  try {
    const r = await mutate({ method: 'PATCH', path: `/api/accounts/${encodeURIComponent(id)}`, body: { is_business: next } });
    buzz();
    toast(r.queued ? 'Saved offline, syncs when you are back' : `${accountName(a)} is ${next ? 'business' : 'personal'}`);
  } catch (err) {
    apply(!next);
    toast(`Couldn't change ${accountName(a)}: ${err.detail}`, { error: true, action: { label: 'Retry', fn: () => toggleBusiness(sw) } });
  } finally { sw.removeAttribute('aria-busy'); }
}

function openAccount(id) {
  const a = shownAccount(acctById(id));
  if (!a) return;
  if (a.manual) return openManualAccount(id);
  const offset = a.type === 'loan' && a.loan?.offset_account_enabled
    ? shownAccounts().find((x) => x.connection_id === a.connection_id && x.type !== 'loan' && /offset/i.test(x.name))
    : null;
  const rows = [
    ['Bank', a.institution],
    ['Type', TYPE_LABEL[a.type] ?? titleCase(a.type)],
    ['Number', acctText(a.number_masked)],
    ['Balance', money(a.balance_current)],
    ['Available', a.balance_available != null ? money(a.balance_available) : null],
    ['Read', a.balance_observed_at ? `${ago(a.balance_observed_at)} (${a.balance_freshness ?? 'unknown'})` : null],
    ['Product', a.rates?.product_name],
    ['Interest rate', pct(a.rates?.lending_rate ?? a.rates?.deposit_rate)],
    ['Repayments', a.loan ? [titleCase(a.loan.repayment_type), a.loan.repayment_frequency === 'P1M' ? 'monthly' : a.loan.repayment_frequency].filter(Boolean).join(', ') : null],
    ['Next instalment', a.loan?.next_instalment_date ? dmy(a.loan.next_instalment_date) : null],
    ['Loan ends', a.loan?.loan_end_date ? dmy(a.loan.loan_end_date) : null],
    ['Original amount', a.loan?.original_loan_amount ? money(Math.round(Number(a.loan.original_loan_amount) * 100)) : null],
    ['Offset', offset ? `${accountName(offset)}: ${money(offset.balance_current)}` : null],
    ['Owed net of offset', offset ? money((a.balance_current ?? 0) + (offset.balance_current ?? 0)) : null],
    ['History held from', a.earliest_date ? dmy(a.earliest_date) : 'Nothing yet'],
    ['Latest transaction', a.latest_date ? dmy(a.latest_date) : null],
    ['Transactions', a.tx_count != null ? `${a.tx_count.toLocaleString('en-AU')}${a.pending_count ? ` (${a.pending_count} pending)` : ''}` : null],
    ['Full backfill', a.backfill_done_at ? `Done ${ago(a.backfill_done_at)}` : 'Not yet'],
    ['Last synced', ago(a.last_synced_at)],
  ].filter(([, v]) => v != null && v !== '');
  openSheet(`${sheetHead(a.institution, accountName(a))}
    <div class="amount-big num">${esc(money(a.balance_current))}</div>
    ${a.last_sync_error ? `<div class="error"><div class="h">Last sync failed for this account</div><div class="d">${esc(a.last_sync_error)}</div></div>` : ''}
    <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <p><a class="btn ghost wide" href="${esc(UxModel.accountHref(a.id))}" data-nav>${I.bank}Account page</a></p>
    <p><a class="btn ghost wide" href="/transactions?account=${encodeURIComponent(a.id)}" data-nav>${I.list}Transactions</a></p>`, 'account');
}

// ---------- shares and super: manual snapshots ----------

async function assetsSection(box, token) {
  let items = null;
  const paint = () => {
    if (token !== renderToken || !items) return;
    const due = items.filter((a) => a.due);
    box.innerHTML = `${due.length ? `<div class="nudge">${I.bell}<div><b>Time to update ${esc(due.map((a) => a.name).join(' and '))}</b></div></div>` : ''}
      ${items.length ? `<div class="rows stagger" id="arows">${items.map((a) => `<button class="row" type="button" data-asset="${a.id}"><div class="ic">${ASSET_ICON[a.kind] ?? I.wallet}</div><div class="main"><div class="t1">${esc(a.name)}${a.is_liability ? ' <span class="chip">Debt</span>' : ''}${a.superseded ? ' <span class="chip warn" title="Your holdings stand in for this value in net worth">Not counted</span>' : ''}</div><div class="t2">${a.as_of ? `Updated ${esc(dmy(a.as_of))}` : 'No value yet'}${a.due ? ' · due' : ''}${a.superseded ? ' · replaced by your holdings in Save and Invest' : ''}</div></div><div class="amt num">${a.value != null ? esc(money(a.value)) : 'Not set'}</div>${a.due ? '<span class="chip warn">Update</span>' : ''}</button>`).join('')}</div>`
      : `<div class="card">${emptyState({ icon: I.piggy, title: 'No shares or super yet', line: 'Add each one and update its value monthly.', button: { id: 'newasset', label: 'Add shares or super', icon: I.plus } })}</div>`}
      ${items.length ? `<button class="btn ghost wide mt10" type="button" id="newasset">${I.plus}Add another</button>` : ''}`;
    stagger($('#arows', box) ?? box);
  };
  const load = () => swr('/api/assets', (d) => { items = d.items; paint(); }).catch((e) => {
    if (token !== renderToken) return;
    box.innerHTML = errorCard(e, 'assetretry', 'your manual assets');
    $('#assetretry', box)?.addEventListener('click', () => { box.innerHTML = skeletonRows(2); load(); });
  });
  if (!store.get('c:/api/assets')) box.innerHTML = skeletonRows(2);
  load();
  const reload = () => { store.del('c:/api/assets'); return load(); };
  box.addEventListener('click', (e) => {
    if (e.target.closest('#newasset')) return openAssetForm(reload);
    const a = e.target.closest('[data-asset]');
    if (a) openAsset(items.find((x) => x.id === Number(a.dataset.asset)), reload);
  });
}

function openAssetForm(done) {
  const panel = openModal(`${sheetHead(null, 'Add shares or super')}
    <form class="form" novalidate>
      <div class="field"><label for="an">Name</label><input id="an" name="name" maxlength="60" autocomplete="off" placeholder="Spaceship Voyager"></div>
      <div class="field"><label>Kind</label>${segmented('kind', [['shares', 'Shares'], ['super', 'Super'], ['property', 'Property'], ['other', 'Other']], 'shares')}</div>
      <div class="field"><label for="av">Value now</label><div class="money-in"><span>$</span><input id="av" name="value" inputmode="decimal" autocomplete="off"></div></div>
      <button class="btn wide" type="submit">${I.plus}Add</button>
    </form>`);
  const form = $('form', panel);
  const d = bindDraft(form, 'asset:new');
  const kind = wireSeg(form, 'kind', () => {});
  const name = $('#an', form);
  const val = $('#av', form);
  name.addEventListener('input', () => fieldError(name, name.value.trim() ? '' : 'Give it a name'));
  val.addEventListener('input', () => fieldError(val, Number.isNaN(parseMoney(val.value)) ? 'Enter an amount like 12500.00' : ''));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cents = parseMoney(val.value);
    const ok = [fieldError(name, name.value.trim() ? '' : 'Give it a name'), fieldError(val, !val.value.trim() || Number.isNaN(cents) ? 'Enter an amount like 12500.00' : '')].every(Boolean);
    if (!ok) return;
    formError(form, null);
    try {
      await withBusy($('button[type=submit]', form), 'Adding', async () => {
        const a = await api('/api/assets', { method: 'POST', body: { name: name.value.trim(), kind: kind() ?? 'shares' } });
        await api(`/api/assets/${a.id}/snapshots`, { method: 'POST', body: { date: todayIso(), value: cents } });
      });
      d.clear();
      closeModal();
      toast('Added');
      buzz(12);
      done();
    } catch (err) { formError(form, err, 'Add it'); }
  });
}

async function openAsset(a, done) {
  if (!a) return;
  const panel = openSheet(`${sheetHead(titleCase(a.kind), a.name)}
    <form class="form" novalidate>
      <div class="field"><label for="sv">New value</label><div class="money-in"><span>$</span><input id="sv" name="value" inputmode="decimal" autocomplete="off" value="${esc(a.value != null ? centsToInput(a.value) : '')}"></div></div>
      <div class="two"><div class="field"><label for="sd">Date</label><input id="sd" name="date" type="date" value="${todayIso()}" max="${todayIso()}"></div><div class="field"><label for="sn">Note</label><input id="sn" name="note" maxlength="200" autocomplete="off"></div></div>
      <button class="btn wide" type="submit">${I.check}Save value</button>
    </form>
    <h2>History</h2><div id="shist">${skeletonRows(2)}</div>
    <button class="btn danger wide mt10" type="button" id="arch">${I.trash}Remove from net worth</button>`, 'asset');
  const form = $('form', panel);
  const d = bindDraft(form, `snap:${a.id}`, { skip: ['date'] });
  const val = $('#sv', form);
  const check = () => (!val.value.trim() ? fieldError(val, 'Enter the current value') : Number.isNaN(parseMoney(val.value)) ? fieldError(val, 'Enter an amount like 12500.00') : fieldError(val, ''));
  val.addEventListener('input', check);
  let hist = [];
  const paintHist = () => {
    $('#shist', panel).innerHTML = hist.length ? `<div class="rows">${hist.map((s) => `<div class="row"><div class="main"><div class="t1 num">${esc(money(s.value))}</div><div class="t2">${esc(dmy(s.date))}${s.note ? ` · ${esc(s.note)}` : ''}</div></div><button class="x sm" type="button" data-sdel="${esc(s.date)}" aria-label="Delete the ${esc(dmy(s.date))} value" title="Delete this value">${I.trash}</button></div>`).join('')}</div>` : '<p class="sub pad">No values yet.</p>';
  };
  const loadHist = () => swr(`/api/assets/${a.id}/snapshots`, (r) => { hist = r.items; paintHist(); }).catch((e) => { $('#shist', panel).innerHTML = errorCard(e, 'histretry', 'the history'); $('#histretry', panel)?.addEventListener('click', loadHist); });
  loadHist();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!check()) return;
    const body = { date: $('#sd', form).value || todayIso(), value: parseMoney(val.value), note: $('#sn', form).value.trim() || null };
    formError(form, null);
    try {
      const r = await withBusy($('button[type=submit]', form), 'Saving', () => mutate({ method: 'POST', path: `/api/assets/${a.id}/snapshots`, body }));
      d.clear();
      hist = [body, ...hist.filter((s) => s.date !== body.date)].sort((x, y) => (x.date < y.date ? 1 : -1));
      paintHist();
      toast(r.queued ? 'Saved offline, syncs when you are back' : `${a.name} saved`);
      buzz(12);
      done();
    } catch (err) { formError(form, err, 'Save'); }
  });
  panel.addEventListener('click', (e) => {
    const del = e.target.closest('[data-sdel]');
    if (del) {
      const date = del.dataset.sdel;
      const prev = hist;
      undoable({
        label: 'Value deleted',
        apply: () => { hist = hist.filter((s) => s.date !== date); paintHist(); },
        revert: () => { hist = prev; paintHist(); },
        op: { method: 'DELETE', path: `/api/assets/${a.id}/snapshots/${date}` },
      });
    }
    if (e.target.closest('#arch')) {
      closeSheet();
      undoable({
        label: `${a.name} removed`,
        apply: () => {},
        revert: () => done(),
        op: { method: 'PATCH', path: `/api/assets/${a.id}`, body: { archived: true } },
      });
      setTimeout(done, 5400);
    }
  });
}

// ---------- rules ----------

const MATCH_LABEL = { contains: 'contains', starts: 'starts with', exact: 'is exactly', regex: 'matches' };

async function rulesSection(box, token) {
  await loadCategories().catch(() => {});
  let rules = null;
  let q = '';
  // ?account= scopes the list to the rules limited to that account (the account page links here).
  const scopeId = new URLSearchParams(location.search).get('account');
  const scopeBar = () => {
    if (!scopeId) return '';
    const a = acctById(scopeId);
    const everywhere = rules.filter((r) => r.account_id == null).length;
    return `<div class="scopebar"><div class="sb-t"><b>${esc(a ? accountName(a) : 'This account')}</b><small>${esc(`Only rules limited to this account${everywhere ? `. ${plural(everywhere, 'rule')} apply to every account.` : '.'}`)}</small></div>
      <div class="sb-b">${a ? `<a class="btn ghost" href="${esc(UxModel.accountHref(a.id))}" data-nav>${I.back}Account</a>` : ''}<a class="btn ghost" href="/accounts?s=rules" data-nav>All rules</a></div></div>`;
  };
  const paint = () => {
    if (token !== renderToken || !rules) return;
    const term = q.trim().toLowerCase();
    const base = scopeId ? rules.filter((r) => r.account_id === scopeId) : rules;
    const list = base.filter((r) => !term || r.pattern.toLowerCase().includes(term) || (r.category ?? '').toLowerCase().includes(term));
    box.innerHTML = `${scopeBar()}<div class="trow"><label class="search">${I.search}<input id="rq" type="search" placeholder="Search rules" value="${esc(q)}" autocomplete="off" aria-label="Search rules"></label><button class="btn" type="button" id="newrule">${I.plus}Rule</button></div>
      ${list.length ? `<div class="rows stagger mt10" id="rrows">${list.map((r) => `<button class="row rule" type="button" data-rule="${r.id}"><div class="main"><div class="t1">${esc(r.field === 'merchant' ? 'Merchant' : 'Description')} ${esc(MATCH_LABEL[r.match])} <span class="pat">${esc(r.pattern)}</span></div><div class="t2">${esc(r.category ?? '')}${r.account_name ? ` · ${esc(acctText(r.account_name))}` : ''}${r.set_merchant ? ` · renames to ${esc(r.set_merchant)}` : ''}</div></div><div class="amt"><span class="chip ${r.source === 'correction' ? 'ok' : ''}">${r.source === 'correction' ? 'Your fix' : r.source === 'seed' ? 'Built in' : 'Rule'}</span><div class="t2 num">${plural(r.hits, 'match', 'matches')}</div></div></button>`).join('')}</div>`
        : `<div class="card mt10">${base.length ? emptyState({ icon: I.search, title: 'No rules match', line: `Nothing matches "${q}".` }) : scopeId ? emptyState({ icon: I.rules, title: 'No rules for this account', line: 'Rules that apply to every account still file its transactions. Add one to cover this account only.', button: { id: 'newrule2', label: 'Add a rule', icon: I.plus } }) : emptyState({ icon: I.rules, title: 'No rules yet', line: 'Add one, or fix a transaction and choose Always.', button: { id: 'newrule2', label: 'Add a rule', icon: I.plus } })}</div>`}`;
    $('#rq', box)?.addEventListener('input', (e) => { q = e.target.value; const pos = e.target.selectionStart; paint(); const n = $('#rq', box); n.focus(); n.setSelectionRange(pos, pos); });
    stagger($('#rrows', box) ?? box);
  };
  const load = () => swr('/api/rules', (d) => { rules = d.items; paint(); }).catch((e) => {
    if (token !== renderToken) return;
    box.innerHTML = errorCard(e, 'ruleretry', 'the rules');
    $('#ruleretry', box)?.addEventListener('click', () => { box.innerHTML = skeletonRows(4); load(); });
  });
  if (!store.get('c:/api/rules')) box.innerHTML = skeletonRows(5);
  load();
  const reload = () => { store.del('c:/api/rules'); return load(); };
  box.addEventListener('click', (e) => {
    if (e.target.closest('#newrule') || e.target.closest('#newrule2')) return openRuleEditor(null, reload, undefined, undefined, undefined, scopeId ? { account_id: scopeId } : {});
    const r = e.target.closest('[data-rule]');
    if (r) openRuleEditor(rules.find((x) => x.id === Number(r.dataset.rule)), reload, (id) => { rules = rules.filter((x) => x.id !== id); paint(); }, (prev) => { rules = prev; paint(); }, () => rules);
  });
}

function openRuleEditor(rule, done, removeLocal, restoreLocal, getRules, defaults = {}) {
  const accts = accountsData?.accounts ?? [];
  const dir = rule?.amount_max != null && rule.amount_max < 0 ? 'out' : rule?.amount_min != null && rule.amount_min > 0 ? 'in' : '';
  let catId = rule?.category_id ?? null;
  const panel = openSheet(`${sheetHead(rule ? 'Edit rule' : 'New rule', rule ? `${rule.category}` : 'Categorising rule')}
    <form class="form" novalidate>
      <div class="field"><label>Look at</label>${segmented('field', [['merchant', 'Merchant'], ['description', 'Description']], rule?.field ?? 'merchant')}</div>
      <div class="two"><div class="field"><label for="rm">When it</label><select id="rm" name="match">${Object.entries(MATCH_LABEL).map(([v, l]) => `<option value="${v}" ${(rule?.match ?? 'contains') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="rp">Text</label><input id="rp" name="pattern" maxlength="200" autocomplete="off" value="${esc(rule?.pattern ?? '')}"></div></div>
      <div class="field"><label>File it under</label><button class="erow solo" type="button" id="rcat"><span class="v l">${esc(rule?.category ?? 'Choose a category')}</span>${I.chevron}</button></div>
      <div class="field"><label>Money</label>${segmented('dir', [['', 'Any'], ['out', 'Out'], ['in', 'In']], dir)}</div>
      <div class="field"><label for="ra">Account</label><select id="ra" name="account"><option value="">Any account</option>${accts.map((a) => `<option value="${esc(a.id)}" ${(rule ? rule.account_id : defaults.account_id) === a.id ? 'selected' : ''}>${esc(accountName(a))}</option>`).join('')}</select></div>
      <div class="two"><div class="field"><label for="rr">Rename merchant to</label><input id="rr" name="rename" maxlength="80" autocomplete="off" value="${esc(rule?.set_merchant ?? '')}"></div>
        <div class="field"><label for="rpr">Priority</label><input id="rpr" name="priority" inputmode="numeric" value="${rule?.priority ?? 100}"></div></div>
      <div id="rprev" class="preview" aria-live="polite"></div>
      <button class="btn wide" type="submit">${I.check}${rule ? 'Save rule' : 'Add rule'}</button>
      ${rule ? `<button class="btn danger wide" type="button" id="rdel2">${I.trash}Delete rule</button>` : ''}
    </form>`, 'rule');
  const form = $('form', panel);
  const d = bindDraft(form, `rule:${rule?.id ?? 'new'}`);
  const field = wireSeg(form, 'field', () => preview());
  const dirv = wireSeg(form, 'dir', () => preview());
  const pat = $('#rp', form);
  const body = () => {
    const direction = dirv() ?? dir;
    return {
      field: field() ?? rule?.field ?? 'merchant', match: $('#rm', form).value, pattern: pat.value.trim(), category_id: catId,
      account_id: $('#ra', form).value || null, set_merchant: $('#rr', form).value.trim() || null,
      amount_min: direction === 'in' ? 1 : null, amount_max: direction === 'out' ? -1 : null,
      priority: Number($('#rpr', form).value) || 100,
    };
  };
  let deb;
  let seq = 0;
  async function preview() {
    clearTimeout(deb);
    const out = $('#rprev', form);
    if (!pat.value.trim()) { out.innerHTML = ''; return; }
    out.innerHTML = '<span class="spin dim"></span><span class="sub">Checking against your history</span>';
    deb = setTimeout(async () => {
      const mine = ++seq;
      try {
        const b = body();
        const r = await api('/api/rules/preview', { method: 'POST', body: { ...b, category_id: undefined } });
        if (mine !== seq) return;
        fieldError(pat, '');
        out.innerHTML = r.count ? `<div class="sub"><b>${plural(r.count, 'transaction')}</b> would match${r.sample.length ? `, like ${esc(r.sample.slice(0, 3).map((s) => s.merchant || s.description.trim()).join(', '))}` : ''}.</div>` : '<div class="sub">Nothing in your history matches this yet.</div>';
      } catch (e) {
        if (mine !== seq) return;
        out.innerHTML = '';
        if (e.status === 400) fieldError(pat, e.detail.replace(/^400 /, ''));
        else out.innerHTML = `<div class="sub warnc">Couldn't check: ${esc(e.detail)}</div>`;
      }
    }, 320);
  }
  for (const id of ['rp', 'rm', 'ra']) $(`#${id}`, form).addEventListener('input', preview);
  $('#rcat', form).addEventListener('click', async () => {
    const id = await pickCategory({ title: 'File under', selected: catId, allowNew: true });
    if (id == null) return;
    catId = id;
    $('#rcat .v', form).textContent = catName(id);
    fieldError($('#rcat', form), '');
  });
  const catErr = () => (catId ? fieldError($('#rcat', form), '') : fieldError($('#rcat', form), 'Choose a category'));
  preview();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = [fieldError(pat, pat.value.trim() ? '' : 'Enter the text to look for'), catErr()].every(Boolean);
    if (!ok) return;
    formError(form, null);
    try {
      const r = await withBusy($('button[type=submit]', form), 'Saving and re-filing history', () => api(rule ? `/api/rules/${rule.id}` : '/api/rules', { method: rule ? 'PATCH' : 'POST', body: body() }));
      d.clear();
      closeSheet();
      toast(`Rule saved, ${plural(r.applied, 'transaction')} filed`);
      buzz(12);
      done();
      document.dispatchEvent(new CustomEvent('mint:data'));
    } catch (err) {
      if (err.status === 400 && /pattern/.test(err.detail)) fieldError(pat, err.detail.replace(/^400 /, ''));
      else formError(form, err, 'Save');
    }
  });
  $('#rdel2', form)?.addEventListener('click', () => {
    closeSheet();
    const prev = getRules();
    undoable({
      label: 'Rule deleted',
      apply: () => removeLocal(rule.id),
      revert: () => restoreLocal(prev),
      op: { method: 'DELETE', path: `/api/rules/${rule.id}` },
    });
    setTimeout(() => document.dispatchEvent(new CustomEvent('mint:data')), 5600);
  });
}

// ---------- review ----------

async function reviewSection(box, token) {
  box.innerHTML = `${skeletonRows(2)}`;
  let items = null;
  let rv = null;
  let alerts = [];
  const paint = () => {
    if (token !== renderToken || !items) return;
    box.innerHTML = `<h2>Doubtful transfers</h2>
      ${items.length ? `<div class="xlistin stagger" id="xl">${items.map(transferCardHtml).join('')}</div>` : `<div class="card">${emptyState({ icon: I.check, title: 'Nothing doubtful', line: 'Every transfer is confirmed or clear-cut.' })}</div>`}
      <h2>To file</h2>
      <div class="rows">
        <a class="row" href="/transactions?category=none" data-nav><div class="ic">${I.tag}</div><div class="main"><div class="t1">Uncategorised</div><div class="t2">Transactions with no category</div></div><div class="amt num">${(rv?.uncategorised ?? 0).toLocaleString('en-AU')}</div>${I.chevron}</a>
        <a class="row" href="/transactions?source=ai" data-nav><div class="ic">${I.list}</div><div class="main"><div class="t1">Model guesses</div><div class="t2">Filed by the model, worth a look</div></div><div class="amt num">${(rv?.guessed ?? 0).toLocaleString('en-AU')}</div>${I.chevron}</a>
        <a class="row" href="/transactions?source=provider" data-nav><div class="ic">${I.bank}</div><div class="main"><div class="t1">Bank guesses</div><div class="t2">Only the bank's category to go on</div></div>${I.chevron}</a>
      </div>
      ${alerts.length ? `<h2>Alerts</h2><div class="rows">${alerts.map((a) => `<div class="row alert" data-alert="${a.id}"><button class="main as-btn" type="button" data-aopen="${esc(a.transaction_id ?? '')}"><div class="t1">${esc(moneyText(a.title))}</div><div class="t2 wrap">${esc(moneyText(a.body))}</div></button><button class="x sm" type="button" data-adismiss="${a.id}" aria-label="Dismiss alert" title="Dismiss">${I.x}</button></div>`).join('')}</div>` : ''}`;
    stagger($('#xl', box) ?? box);
    if ($('#xl', box)) wireTransferReview($('#xl', box), items, { onChange: (full) => { if (full || !items.length) paint(); document.dispatchEvent(new CustomEvent('mint:txchanged')); } });
  };
  try {
    const [t, r, a] = await Promise.all([api('/api/transfers?status=review'), api('/api/review'), api('/api/alerts')]);
    items = t.items; rv = r; alerts = a.items;
    paint();
  } catch (e) {
    if (token !== renderToken) return;
    box.innerHTML = errorCard(e, 'revretry', 'the review queues');
    $('#revretry', box)?.addEventListener('click', () => reviewSection(box, token));
    return;
  }
  box.addEventListener('click', (e) => {
    const dis = e.target.closest('[data-adismiss]');
    if (dis) {
      const id = Number(dis.dataset.adismiss);
      const prev = alerts;
      undoable({ label: 'Alert dismissed', apply: () => { alerts = alerts.filter((x) => x.id !== id); paint(); }, revert: () => { alerts = prev; paint(); }, op: { method: 'POST', path: `/api/alerts/${id}/dismiss` } });
      return;
    }
    const open = e.target.closest('[data-aopen]');
    if (open?.dataset.aopen) openTxById(open.dataset.aopen);
  });
}

// ---------- the screen ----------

async function viewAccounts(el, token) {
  let section = new URLSearchParams(location.search).get('s');
  if (!ACC_TABS.some(([k]) => k === section)) section = 'accounts';
  const rv = store.get('c:/api/review')?.d;
  el.innerHTML = `<div id="synchost"></div>
    <div class="subtabs" role="tablist" aria-label="Accounts sections">${ACC_TABS.map(([k, l]) => `<button class="stab ${k === section ? 'on' : ''}" type="button" role="tab" aria-selected="${k === section}" data-s="${k}">${esc(l)}${k === 'review' && rv && (rv.transfers) ? `<span class="badge">${rv.transfers}</span>` : ''}</button>`).join('')}</div>
    <div id="secbox" class="secbox"></div>`;
  const box = $('#secbox', el);
  $('.subtabs', el).addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (!b || b.dataset.s === section) return;
    buzz(6);
    history.replaceState({}, '', b.dataset.s === 'accounts' ? '/accounts' : `/accounts?s=${b.dataset.s}`);
    render({ keepScroll: false });
  });
  swr('/api/review', (d) => { if (token === renderToken) { const b = $('[data-s="review"]', el); if (b) b.innerHTML = `Review${d.transfers ? `<span class="badge">${d.transfers}</span>` : ''}`; } }).catch(() => {});

  const drawTop = () => {
    if (token !== renderToken) return;
    $('#synchost', el).innerHTML = accountsData ? syncCardHtml() : skeletonCard(110);
    applyDims($('#synchost', el));
    wireSyncCard();
  };
  const drawAccounts = () => {
    if (token !== renderToken || section !== 'accounts' || !accountsData) return;
    accountsSection(box);
  };

  if (section === 'accounts') {
    if (accountsData) { drawTop(); drawAccounts(); } else { drawTop(); box.innerHTML = skeletonRows(5); }
    el.addEventListener('click', async (e) => {
      const sw = e.target.closest('[data-biz]');
      if (sw) return toggleBusiness(sw);
      const open = e.target.closest('[data-open]');
      if (open) openAccount(open.dataset.open);
    });
    wireManualBlock(box);
    try {
      await refreshAccounts();
      drawTop();
      drawAccounts();
      if (accountsData.sync.running) watchSync();
    } catch (e) {
      if (accountsData) { toast(`Showing saved accounts: ${e.detail}`, { error: true }); return; }
      box.innerHTML = errorCard(e, 'retry', 'your accounts');
      $('#retry', box)?.addEventListener('click', () => render());
    }
  } else {
    drawTop();
    refreshAccounts(true).then(() => { drawTop(); if (accountsData?.sync.running) watchSync(); });
    if (section === 'assets') assetsSection(box, token);
    if (section === 'rules') rulesSection(box, token);
    if (section === 'review') reviewSection(box, token);
  }
  const onSynced = () => { if (token === renderToken && section === 'accounts') drawAccounts(); };
  accountsListeners.add(onSynced);
  cleanup.push(() => accountsListeners.delete(onSynced));
  setPaneDefault(() => {
    const d = shownAccountsData();
    if (!d) return skeletonRows(4);
    return `<h2>Net worth</h2><div class="card"><div class="amount-big num">${esc(money(d.totals.net_worth))}</div><div class="sub">Synced ${esc(ago(d.sync.lastPollAt))}</div></div>`;
  });
}
