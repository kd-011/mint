// Transactions: a windowed list (only the rows on screen exist), search and
// filters in the URL, swipe actions, bulk edit, and the bottom-sheet editor
// that Home, Tax and Reports reuse (openTxById).
'use strict';

const ROW_H = 56;
const HEAD_H = 34;
const FILTER_KEYS = ['q', 'account', 'category', 'from', 'to', 'business', 'tax', 'direction', 'source'];
const txChanged = (t) => document.dispatchEvent(new CustomEvent('mint:txchanged', { detail: t }));

// ---------- one transaction: optimistic patch ----------

function applyPatchLocal(t, patch) {
  if ('category_id' in patch) {
    t.category_id = patch.category_id;
    t.category = patch.category_id == null ? null : catName(patch.category_id);
    t.category_source = patch.category_id == null ? null : 'manual';
    t.category_kind = categoriesData?.find((c) => c.id === patch.category_id)?.kind ?? null;
  }
  if ('is_business' in patch) {
    t.is_business = patch.is_business;
    t.business = patch.is_business ?? !!acctById(t.account_id)?.is_business;
  }
  if ('note' in patch) t.note = patch.note;
}

// Applies at once, sends in the background, rolls back with the real error.
async function patchTx(t, patch, { always = false } = {}) {
  const before = { ...t };
  applyPatchLocal(t, patch);
  txChanged(t);
  try {
    const { data, queued } = await mutate({ method: 'PATCH', path: `/api/transactions/${encodeURIComponent(t.id)}`, body: { ...patch, ...(always ? { always: true } : {}) } });
    if (data?.transaction) Object.assign(t, data.transaction);
    txChanged(t);
    return { ok: true, queued, rule: data?.rule ?? null, applied: data?.applied ?? 0 };
  } catch (e) {
    Object.assign(t, before);
    txChanged(t);
    toast(`Couldn't save: ${e.detail}`, { error: true, action: { label: 'Retry', fn: () => patchTx(t, patch, { always }) } });
    return { ok: false };
  }
}

// After a manual category pick: offer the rule once, from the toast.
function offerRule(t, catId) {
  if (!t.merchant && !t.description) return;
  toast(`Filed under ${catName(catId)}`, {
    ms: 7000,
    action: {
      label: 'Always',
      fn: async () => {
        const r = await patchTx(t, { category_id: catId }, { always: true });
        if (!r.ok) return;
        buzz(12);
        if (r.rule) toast(`Rule saved, ${plural(r.applied, 'transaction')} filed`, { action: { label: 'Undo', fn: () => mutate({ method: 'DELETE', path: `/api/rules/${r.rule.id}` }).then(() => document.dispatchEvent(new CustomEvent('mint:data'))).catch((e) => toast(`Couldn't undo: ${e.detail}`, { error: true })) } });
        else toast('Rule saved');
        document.dispatchEvent(new CustomEvent('mint:data'));
      },
    },
  });
}

const rememberCat = (id) => store.set('recentcats', UxModel.pushRecentCat(store.get('recentcats'), id));

// One-tap picks for a transaction: how its merchant is filed elsewhere, then what was used lately.
function quickCats(t) {
  return UxModel.suggestCategories({ merchant: t.merchant, current: t.category_id, items: txMem.items ?? [], recent: store.get('recentcats') ?? [] })
    .filter((id) => catName(id));
}

async function chooseCategory(t) {
  const id = await pickCategory({ title: 'Category', selected: t.category_id, allowClear: !!t.category_id });
  if (id === undefined || id === t.category_id) return false;
  const r = await patchTx(t, { category_id: id });
  if (r.ok) {
    buzz(10);
    rememberCat(id);
    if (id !== null) offerRule(t, id);
    else toast('Handed back to the rules');
  }
  return r.ok;
}

// ---------- tax tag form ----------

let atoList = store.get('ato');
async function loadAto() {
  if (atoList) return atoList;
  const d = await api('/api/tax/categories');
  atoList = d.items;
  store.set('ato', atoList);
  return atoList;
}

async function openTaxForm(t) {
  if (t.amount >= 0) { toast('Only money out can be a deduction', { error: true }); return; }
  let list;
  try { list = await loadAto(); } catch (e) { toast(`Couldn't load the ATO categories: ${e.detail}`, { error: true }); return; }
  const full = -t.amount;
  const last = store.get('last-ato');
  const cur = t.tax?.ato_category ?? last ?? (t.business ? 'BUS_OTHER' : 'D5');
  const groups = [...new Set(list.map((c) => c.group))];
  const panel = openModal(`${sheetHead(t.merchant || 'Transaction', t.tax ? 'Edit deduction' : 'Mark as deductible')}
    <form class="form" novalidate>
      <div class="field"><label for="txa">ATO category</label><select id="txa" name="ato">${groups.map((g) => `<optgroup label="${esc(g)}">${list.filter((c) => c.group === g).map((c) => `<option value="${c.code}" ${c.code === cur ? 'selected' : ''}>${esc(`${c.code.startsWith('D') ? `${c.code} ` : ''}${c.label}`)}</option>`).join('')}</optgroup>`).join('')}</select></div>
      <div class="field"><label for="txamt">Deductible amount</label><div class="money-in"><span>$</span><input id="txamt" name="amount" inputmode="decimal" autocomplete="off" value="${centsToInput(t.tax?.deductible_amount ?? full)}"></div></div>
      <div class="field"><label for="txnote">Note</label><input id="txnote" name="note" maxlength="500" autocomplete="off" placeholder="What it was for" value="${esc(t.tax?.note ?? '')}"></div>
      <button class="btn wide" type="submit">${I.check}${t.tax ? 'Save deduction' : 'Mark deductible'}</button>
      ${t.tax ? `<button class="btn danger wide" type="button" id="txuntag">${I.trash}Remove deduction</button>` : ''}
    </form>`);
  const form = $('form', panel);
  const d = bindDraft(form, `tax:${t.id}`);
  const amt = $('#txamt', form);
  const check = () => {
    const c = parseMoney(amt.value);
    if (Number.isNaN(c)) return fieldError(amt, 'Enter an amount like 42.50');
    if (c < 1) return fieldError(amt, 'Must be more than $0');
    if (c > full) return fieldError(amt, `No more than the charge, ${money(full)}`);
    return fieldError(amt, '');
  };
  amt.addEventListener('input', check);
  if (d.restored) check();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!check()) return;
    const body = { ato_category: $('#txa', form).value, deductible_amount: parseMoney(amt.value), note: $('#txnote', form).value.trim() || null };
    formError(form, null);
    const btn = $('button[type=submit]', form);
    const before = t.tax;
    try {
      await withBusy(btn, 'Saving', async () => {
        t.tax = { ato_category: body.ato_category, deductible_amount: body.deductible_amount, note: body.note };
        const r = await mutate({ method: 'PUT', path: `/api/transactions/${encodeURIComponent(t.id)}/tax`, body }).catch((err) => { t.tax = before; throw err; });
        if (r.queued) toast('Saved offline, syncs when you are back');
      });
      store.set('last-ato', body.ato_category);
      d.clear();
      closeModal();
      txChanged(t);
      toast('Marked deductible');
      buzz(12);
    } catch (err) { formError(form, err, 'Save'); }
  });
  $('#txuntag', form)?.addEventListener('click', () => {
    const prev = t.tax;
    closeModal();
    undoable({
      label: 'Deduction removed',
      apply: () => { t.tax = null; txChanged(t); },
      revert: () => { t.tax = prev; txChanged(t); },
      op: { method: 'DELETE', path: `/api/transactions/${encodeURIComponent(t.id)}/tax` },
    });
  });
}

// ---------- merchant logo ----------

// A website for this merchant's logo, or none. The server validates and looks the icon up; this is the quick check as you type.
const siteOk = (v) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(v.trim().replace(/^https?:\/\//i, '').split(/[/?#]/)[0].replace(/^www\./i, ''));

function openLogoForm(t, info, onDone) {
  const name = t.merchant || t.description;
  const panel = openModal(`${sheetHead(name, 'Logo')}
    <form class="form" novalidate>
      <div class="logo-prev">${logoTile({ name, logo: t.logo, icon: '' })}<div class="sub">${t.logo ? 'Showing the logo for' : 'Showing a letter tile for'} ${esc(name)}</div></div>
      <div class="field"><label for="lgdom">Website</label><input id="lgdom" name="domain" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" placeholder="example.com.au" value="${esc(info.domain ?? '')}"></div>
      <button class="btn wide" type="submit">${I.check}Save logo</button>
      ${info.domain || t.logo ? `<button class="btn ghost wide" type="button" id="lgclear">${I.x}Use a letter tile</button>` : ''}
    </form>`);
  wireLogoTiles(panel);
  const form = $('form', panel);
  const input = $('#lgdom', form);
  const d = bindDraft(form, `logo:${info.key}`);
  const check = () => fieldError(input, !input.value.trim() || siteOk(input.value) ? '' : 'Enter a website like example.com.au');
  input.addEventListener('input', check);
  if (d.restored) check();
  // The server fetches the icon before it answers, so this can take a few seconds.
  const put = async (domain, btn, busy) => {
    formError(form, null);
    const slow = setTimeout(() => { if (btn.isConnected) btn.innerHTML = '<span class="spin"></span>Still looking, the icon service can be slow'; }, 4000);
    try {
      return await withBusy(btn, busy, () => api(`/api/logo/${encodeURIComponent(info.key)}`, { method: 'PUT', body: { domain } }));
    } finally { clearTimeout(slow); }
  };
  const applied = (out) => {
    for (const x of txMem.items) if (x.merchant === t.merchant) x.logo = out.logo;
    t.logo = out.logo;
    onDone({ ...info, domain: out.domain, source: 'manual', status: 'manual', logo: out.logo });
    d.clear();
    closeModal();
    txChanged(t);
    buzz(12);
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) { $('#lgclear', form)?.click(); return; }
    if (!check()) return;
    try {
      applied(await put(v, $('button[type=submit]', form), 'Looking up the icon'));
      toast('Logo saved');
    } catch (err) { formError(form, err, 'Save'); }
  });
  $('#lgclear', form)?.addEventListener('click', async () => {
    const prev = info.domain;
    try {
      applied(await put(null, $('#lgclear', form), 'Turning the logo off'));
      toast('Logo turned off', { ms: 7000, action: prev ? { label: 'Undo', fn: async () => {
        try { const back = await api(`/api/logo/${encodeURIComponent(info.key)}`, { method: 'PUT', body: { domain: prev } }); for (const x of txMem.items) if (x.merchant === t.merchant) x.logo = back.logo; t.logo = back.logo; txChanged(t); } catch (er) { toast(`Couldn't undo: ${er.detail}`, { error: true }); }
      } } : null });
    } catch (err) { formError(form, err, 'Try'); }
  });
}

// ---------- receipts ----------

// A phone photo is often 5 MB or more; shrink it before it goes up.
async function prepareReceipt(file) {
  if (!file.type.startsWith('image/') || /hei[cf]/i.test(file.type) || file.size < 1_500_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
    return blob && blob.size < file.size ? new File([blob], 'receipt.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

function receiptThumb(r) {
  if (r.mime === 'application/pdf') return `<a class="rthumb" href="/api/receipts/${r.id}" target="_blank" rel="noopener" aria-label="Open PDF receipt">${I.file}<small>PDF</small></a>`;
  return `<button class="rthumb" type="button" data-rcpt="${r.id}" aria-label="View receipt"><img src="/api/receipts/${r.id}" alt="Receipt photo" loading="lazy"></button>`;
}

function viewReceipt(r, t, redraw) {
  const panel = openModal(`${sheetHead('Receipt', t.merchant || 'Transaction')}
    <div class="rview"><img src="/api/receipts/${r.id}" alt="Receipt photo"></div>
    <button class="btn danger wide" type="button" id="rdel">${I.trash}Delete receipt</button>`);
  $('#rdel', panel).addEventListener('click', () => {
    closeModal();
    undoable({
      label: 'Receipt deleted',
      apply: () => { t.receipts = Math.max(0, (t.receipts ?? 1) - 1); r.gone = true; redraw(); txChanged(t); },
      revert: () => { t.receipts += 1; r.gone = false; redraw(); txChanged(t); },
      op: { method: 'DELETE', path: `/api/receipts/${r.id}` },
    });
  });
}

// ---------- the editor ----------

function sourceLabel(t) { return t.category_source === 'manual' ? 'Set by you' : t.category_source === 'rule' ? 'By a rule' : t.category_source === 'ai' ? 'Model guess' : t.category_source === 'provider' ? 'Bank guess' : 'Not filed'; }

function openTx(t) {
  const acct = acctById(t.account_id);
  let receipts = [];
  let waiting = 0;
  // What the Logo row shows: undefined while the detail loads, false if it could not, null for a row with no merchant.
  let lgInfo;
  const logoRow = () => {
    if (t.transfer || t.category_kind === 'transfer' || lgInfo === null || !(t.merchant || t.description)) return '';
    const label = lgInfo === undefined ? 'Loading' : lgInfo === false ? 'Needs a connection'
      : `${lgInfo.domain ? esc(lgInfo.domain) : 'Letter tile'}<small>${lgInfo.source === 'manual' ? (lgInfo.domain ? 'Set by you' : 'Logo turned off') : lgInfo.domain ? 'Found automatically' : 'No logo found'}</small>`;
    return `<button class="erow" type="button" id="edlogo" ${lgInfo ? '' : 'disabled'}><span class="k">Logo</span><span class="v">${label}</span>${lgInfo ? I.chevron : ''}</button>`;
  };
  const body = () => {
    const biz = t.is_business == null ? 'auto' : t.is_business ? 'biz' : 'personal';
    const out = t.amount < 0;
    const rows = [
      ['Date', dmy(t.date)],
      ['Posted', t.post_date ? dmy(String(t.post_date).slice(0, 10)) : 'Not yet'],
      ['Status', t.status === 'pending' ? 'Pending' : 'Posted'],
      ['Account', acct ? `${accountName(acct)} (${acct.institution})` : acctText(t.account_name)],
      ['Bank category', t.provider_category ? titleCase(t.provider_category) : null],
      ['Reference', t.reference],
      ['Description', t.description],
      ['Details', t.extended_description],
    ].filter(([, v]) => v);
    const qc = quickCats(t);
    return `<div class="ed">
      ${qc.length ? `<div class="qcats" role="group" aria-label="File under">${qc.map((id) => `<button class="fchip" type="button" data-qcat="${id}">${esc(catName(id))}</button>`).join('')}</div>` : ''}
      <button class="erow" type="button" id="edcat"><span class="k">Category</span><span class="v">${esc(t.category ?? 'Not filed')}<small>${esc(sourceLabel(t))}</small></span>${I.chevron}</button>
      ${logoRow()}
      <div class="erow static col"><span class="k">Counts as</span>${segmented('biz', [['auto', 'Account'], ['biz', 'Business'], ['personal', 'Personal']], biz)}</div>
      ${out ? `<button class="erow" type="button" id="eddeduct"><span class="k">Deductible</span><span class="v">${t.tax ? `${esc(t.tax.ato_category)} · ${esc(money(t.tax.deductible_amount))}` : 'Not tagged'}</span>${I.chevron}</button>` : ''}
      <div class="erow static col"><span class="k">Receipts</span>
        <div class="rgrid">${receipts.filter((r) => !r.gone).map(receiptThumb).join('')}${waiting ? `<div class="rthumb wait" title="Uploads when you are back online">${I.refresh}<small>${waiting} waiting</small></div>` : ''}
          <label class="rthumb add" title="Attach a receipt">${I.plus}<small>Add</small><input type="file" id="rfile" accept="image/*,application/pdf" hidden></label>
          <label class="rthumb add cam" title="Take a photo of a receipt">${I.camera}<small>Photo</small><input type="file" id="rcam" accept="image/*" capture="environment" hidden></label></div></div>
      <label class="erow static col"><span class="k">Note</span><textarea id="ednote" rows="2" maxlength="500" placeholder="Add a note" aria-label="Note">${esc(t.note ?? '')}</textarea></label>
    </div>
    ${t.transfer ? `<div class="card xfer-note"><div class="t1">Counted as a ${esc(titleCase(t.transfer.kind).toLowerCase())}</div><div class="sub">Transfers never count as spend or income. ${t.transfer.status === 'review' ? 'This one is waiting for your review.' : ''}</div>
      <button class="btn ghost danger-text wide" type="button" id="edxfer">${I.swap}Not a transfer</button></div>` : ''}
    <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  };
  const fxLine = txFx(t) ? `<div class="sub num">${esc(signed(t.amount))} AUD${t.fx_rate ? ` at ${esc(t.fx_rate.toLocaleString('en-AU', { maximumFractionDigits: 6 }))}, rate from ${esc(dmy(t.fx_date))}` : ''}</div>` : '';
  const manualActs = t.manual && t.amount_native != null && acct
    ? `<div class="man-acts two-acts"><button class="btn ghost" type="button" id="edmanual">${I.edit}Edit</button><button class="btn ghost danger-text" type="button" id="edmdel">${I.trash}Delete</button></div>` : '';
  const panel = openSheet(`${sheetHead(null, t.merchant || t.description || 'Transaction')}
    <div class="amount-big num ${t.amount > 0 ? 'pos' : ''}" id="edamt">${esc(txFx(t) ? signedIn(t.amount_native, t.currency) : signed(t.amount))}</div>
    ${fxLine}${manualActs}
    <div id="edbody">${body()}</div>`, 'tx');
  $('#edmanual', panel)?.addEventListener('click', () => openManualTxForm(acct, t));
  $('#edmdel', panel)?.addEventListener('click', () => {
    closeSheet();
    undoable({
      label: 'Transaction deleted',
      apply: () => { txMem.items = txMem.items.filter((x) => x.id !== t.id); txChanged(); },
      revert: () => reloadTransactions(),
      op: { method: 'DELETE', path: `/api/manual/transactions/${encodeURIComponent(t.id)}` },
    });
    setTimeout(manualChanged, 5600);
  });
  const root = () => $('#edbody', panel);
  const redraw = () => {
    if (!root()) return;
    const keep = $('#ednote', panel)?.value;
    root().innerHTML = body();
    if (keep != null && $('#ednote', panel)) $('#ednote', panel).value = keep;
    wire();
  };
  const wire = () => {
    $('#edcat', panel).addEventListener('click', async () => { if (await chooseCategory(t)) redraw(); });
    $$('[data-qcat]', panel).forEach((b) => b.addEventListener('click', async () => {
      const id = Number(b.dataset.qcat);
      b.disabled = true;
      const r = await patchTx(t, { category_id: id });
      if (r.ok) { buzz(10); rememberCat(id); offerRule(t, id); }
      redraw();
    }));
    const getBiz = wireSeg(panel, 'biz', async (v) => {
      const r = await patchTx(t, { is_business: v === 'auto' ? null : v === 'biz' });
      if (r.ok) { toast(v === 'auto' ? 'Follows the account' : v === 'biz' ? 'Counted as business' : 'Counted as personal'); buzz(8); }
      redraw();
    });
    void getBiz;
    $('#eddeduct', panel)?.addEventListener('click', () => openTaxForm(t));
    $('#edlogo', panel)?.addEventListener('click', () => { if (lgInfo) openLogoForm(t, lgInfo, (next) => { lgInfo = next; redraw(); }); });
    $('#edxfer', panel)?.addEventListener('click', () => {
      const prev = t.transfer;
      undoable({
        label: 'Marked as not a transfer',
        apply: () => { t.transfer = null; redraw(); txChanged(t); },
        revert: () => { t.transfer = prev; redraw(); txChanged(t); },
        op: { method: 'POST', path: `/api/transfers/${prev.id}/reject` },
      });
    });
    const note = $('#ednote', panel);
    const d = drafts.get(`note:${t.id}`);
    if (d != null && d !== (t.note ?? '')) note.value = d;
    note.addEventListener('input', () => drafts.set(`note:${t.id}`, note.value));
    note.addEventListener('blur', async () => {
      const v = note.value.trim();
      if (v === (t.note ?? '')) { drafts.clear(`note:${t.id}`); return; }
      const r = await patchTx(t, { note: v || null });
      if (r.ok) { drafts.clear(`note:${t.id}`); toast('Note saved'); }
    });
    for (const id of ['rfile', 'rcam']) $(`#${id}`, panel)?.addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) attach(f); });
    $$('[data-rcpt]', panel).forEach((b) => b.addEventListener('click', () => viewReceipt(receipts.find((r) => r.id === Number(b.dataset.rcpt)), t, redraw)));
  };
  async function attach(file) {
    if (file.size > 25 * 1024 * 1024) return toast('That file is too big, receipts are capped at 10 MB', { error: true });
    const grid = $('.rgrid', panel);
    const ph = document.createElement('div');
    ph.className = 'rthumb wait';
    ph.innerHTML = '<span class="spin"></span><small>Uploading</small>';
    grid?.prepend(ph);
    try {
      const f = await prepareReceipt(file);
      if (f.size > 10 * 1024 * 1024) throw new ApiError('Too big', 'Receipts are capped at 10 MB', {});
      const r = await api(`/api/transactions/${encodeURIComponent(t.id)}/receipts`, { method: 'POST', raw: f, type: f.type || file.type, retries: 2 });
      receipts.push({ id: r.id, mime: r.mime, bytes: r.bytes });
      t.receipts = (t.receipts ?? 0) + 1;
      toast('Receipt attached');
      buzz(12);
      txChanged(t);
    } catch (e) {
      if (e.offline) {
        await receiptQueue.add(t.id, file).catch(() => {});
        waiting += 1;
        toast('Saved offline, uploads when you are back');
      } else toast(`Couldn't attach the receipt: ${e.detail}`, { error: true, action: { label: 'Retry', fn: () => attach(file) } });
    }
    redraw();
  }
  wire();
  // Receipts and the freshest copy come from the detail endpoint.
  (async () => {
    waiting = await receiptQueue.count(t.id);
    try {
      await swr(`/api/transactions/${encodeURIComponent(t.id)}`, (d) => { receipts = d.receipts; lgInfo = d.logo_info; });
      redraw();
    } catch { lgInfo ??= false; redraw(); }
  })();
  return panel;
}

async function openTxById(id) {
  try {
    const d = await api(`/api/transactions/${encodeURIComponent(id)}`);
    openTx(d.transaction);
  } catch (e) { toast(`Couldn't open the transaction: ${e.detail}`, { error: true }); }
}

// ---------- doubtful transfers: review queue (also embedded in Accounts) ----------

function transferCardHtml(x) {
  const o = x.out;
  const i = x.in;
  const conf = x.confidence != null ? `${Math.round(x.confidence * 100)}% sure` : '';
  // Across a currency the two AUD values differ by the fee and the rate day, so each leg says its own.
  const fee = o && i && o.amount + i.amount !== 0;
  const legAmt = (l) => (fee && l ? `<div class="t2 num">${esc(money(Math.abs(l.amount)))}</div>` : '');
  return `<article class="xcard" data-x="${x.id}">
    <div class="xtop"><span class="xkind">${esc(titleCase(x.kind))}</span><span class="sub">${esc(conf)}</span></div>
    <div class="xamt num">${esc(money(x.amount))}</div>
    <div class="xlegs">
      <div class="xleg"><div class="t2">Out · ${esc(o ? dmy(o.date) : '')}</div><div class="t1">${esc(acctText(o?.account_name ?? 'Unknown'))}</div><div class="t2">${esc(o?.merchant || o?.description || '')}</div>${legAmt(o)}</div>
      <div class="xarrow">${I.chevron}</div>
      <div class="xleg"><div class="t2">In · ${esc(i ? dmy(i.date) : '')}</div><div class="t1">${esc(acctText(i?.account_name ?? 'Unknown'))}</div><div class="t2">${esc(i?.merchant || i?.description || '')}</div>${legAmt(i)}</div>
    </div>
    <div class="xact"><button class="btn ghost danger-text" type="button" data-xno="${x.id}">Not a transfer</button><button class="btn" type="button" data-xyes="${x.id}">${I.check}Confirm</button></div>
  </article>`;
}

function wireTransferReview(root, items, { onChange }) {
  const drop = (id, cb) => { const n = $(`[data-x="${id}"]`, root); if (!n) return cb(); n.classList.add('leaving'); setTimeout(() => { n.remove(); cb(); onChange(); }, reduceMotion.matches ? 0 : 200); };
  root.addEventListener('click', async (e) => {
    const yes = e.target.closest('[data-xyes]');
    const no = e.target.closest('[data-xno]');
    if (yes) {
      const id = Number(yes.dataset.xyes);
      const idx = items.findIndex((x) => x.id === id);
      const x = items[idx];
      items.splice(idx, 1);
      drop(id, () => {});
      buzz(10);
      try { const r = await mutate({ method: 'POST', path: `/api/transfers/${id}/confirm` }); toast(r.queued ? 'Saved offline, syncs when you are back' : 'Confirmed as a transfer'); } catch (err) {
        items.splice(idx, 0, x);
        onChange(true);
        toast(`Couldn't confirm: ${err.detail}`, { error: true, action: { label: 'Retry', fn: () => yes.click() } });
      }
    }
    if (no) {
      const id = Number(no.dataset.xno);
      const idx = items.findIndex((x) => x.id === id);
      const x = items[idx];
      undoable({
        label: 'Marked as not a transfer',
        apply: () => { items.splice(idx, 1); drop(id, () => {}); },
        revert: () => { items.splice(idx, 0, x); onChange(true); },
        op: { method: 'POST', path: `/api/transfers/${id}/reject` },
      });
    }
  });
}

async function openTransferReview() {
  const panel = openSheet(`${sheetHead(null, 'Transfers to review')}<div id="xlist">${skeletonRows(2)}</div>`, 'xfers');
  const box = $('#xlist', panel);
  const items = [];
  const paint = () => {
    box.innerHTML = items.length
      ? `<div class="xlistin stagger">${items.map(transferCardHtml).join('')}</div>`
      : emptyState({ icon: I.check, title: 'Nothing to review', line: 'Every transfer Mint spotted is either confirmed or clear-cut.' });
  };
  try {
    const d = await api('/api/transfers?status=review');
    items.push(...d.items);
    paint();
    wireTransferReview(box, items, { onChange: (full) => { if (full || !items.length) paint(); document.dispatchEvent(new CustomEvent('mint:txchanged')); } });
  } catch (e) {
    box.innerHTML = errorCard(e, 'xretry', 'the review list');
    $('#xretry', box)?.addEventListener('click', () => openTransferReview());
  }
}

// ---------- the list ----------

const txMem = { key: null, items: [], next: null, fresh: false };
// After a manual write (add, edit, import, delete): drop the saved lists so the screen reads fresh.
function reloadTransactions() {
  Object.assign(txMem, { key: null, items: [], next: null, fresh: false });
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('mint:tx:')) localStorage.removeItem(k); } catch {}
  if (route.view === 'transactions') render();
}

function readFilters() {
  const p = new URLSearchParams(location.search);
  return Object.fromEntries(FILTER_KEYS.filter((k) => p.get(k)).map((k) => [k, p.get(k)]));
}
function writeFilters(f) {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) if (f[k]) p.set(k, f[k]);
  history.replaceState({}, '', `/transactions${p.toString() ? `?${p}` : ''}`);
}
const filterQuery = (f, cursor) => {
  const p = new URLSearchParams({ limit: '100' });
  for (const k of FILTER_KEYS) if (f[k]) p.set(k, f[k]);
  if (cursor) p.set('cursor', cursor);
  return `/api/transactions?${p}`;
};

function filterChips(f) {
  const out = [];
  if (f.account) out.push(['account', acctById(f.account) ? accountName(acctById(f.account)) : 'Account']);
  if (f.category) out.push(['category', f.category === 'none' ? 'Uncategorised' : catName(Number(f.category)) || 'Category']);
  if (f.direction) out.push(['direction', f.direction === 'in' ? 'Money in' : 'Money out']);
  if (f.from || f.to) out.push(['from,to', `${f.from ? dmy(f.from) : 'Start'} to ${f.to ? dmy(f.to) : 'now'}`]);
  if (f.business) out.push(['business', f.business === '1' ? 'Business' : 'Personal']);
  if (f.tax) out.push(['tax', f.tax === '1' ? 'Deductible' : 'Not deductible']);
  if (f.source) out.push(['source', { ai: 'Model guesses', provider: 'Bank guesses', rule: 'By a rule', manual: 'Set by you' }[f.source]]);
  return out;
}

// One transaction row. The Transactions list and a budget's category view draw
// it the same way; the caller wires the tap.
// A row from a manual account in another currency: shown in its own currency, with the AUD it counts as.
const txFx = (t) => t.manual && t.amount_native != null && t.currency && t.currency !== 'AUD';

// Row marks are plain text, never a capsule: "Check transfer" asks something of you so it keeps its words; the rest
// collapse to one muted icon (deductible, then business, then receipt) with every label kept for screen readers.
const ROW_MARK = { business: [() => I.briefcase, 'Business'], tax: [() => I.tag, 'Deductible'], receipt: [() => I.camera, 'Receipt attached'] };
function txMarks(chips) {
  if (chips.includes('review')) return '<span class="tf warn">Check transfer</span>';
  const marks = ['tax', 'business', 'receipt'].filter((c) => chips.includes(c));
  if (!marks.length) return '';
  const labels = marks.map((c) => ROW_MARK[c][1]);
  return `<span class="tf" title="${esc(labels.join(', '))}">${ROW_MARK[marks[0]][0]()}<span class="sr">${esc(labels.join(', '))}</span></span>`;
}

// showAccount: false when the list is already one account's, so the subline does not repeat it.
function txRowButton(t, { selecting = false, picked = false, showAccount = true } = {}) {
  const a = acctById(t.account_id);
  const { lead, account } = UxModel.txSubline(t, { account: acctText(a ? UxModel.accountShort(a) : t.account_name ?? ''), showAccount });
  const fl = UxModel.txRowFlags(t);
  const flags = `${txFx(t) ? `<span class="aud">${esc(money(t.amount))}</span>` : ''}${txMarks(fl.chips)}`;
  return `<button class="row tx ${fl.muted ? 'xfer' : ''} ${fl.pending ? 'pend' : ''} ${picked ? 'picked' : ''}" type="button" data-tx="${esc(t.id)}" role="listitem">
    ${selecting ? `<span class="chk" aria-hidden="true">${picked ? I.check : ''}</span>` : ''}
    ${logoTile({ name: t.merchant || t.description, logo: t.logo, transfer: !!t.transfer || t.category_kind === 'transfer', icon: TYPE_ICON[a?.type] ?? I.wallet })}
    <div class="main"><div class="t1">${esc(t.merchant || t.description || 'Unnamed')}</div><div class="t2 txsub"><span class="sl-lead">${esc(lead)}</span>${account ? `<span class="sl-acc">${esc(account)}</span>` : ''}</div></div>
    <div class="amt num ${t.amount > 0 && !fl.muted ? 'pos' : ''}"><span class="amtl">${fl.pending ? `<span class="pendic" title="Pending">${I.clock}<span class="sr">Pending</span></span>` : ''}${esc(txFx(t) ? signedIn(t.amount_native, t.currency) : signed(t.amount))}</span>${flags ? `<div class="t2 flags">${flags}</div>` : ''}</div></button>`;
}

const dayHeadHtml = (h) => `<span class="dh-l">${esc(dayLabel(h.day))}${h.n > 1 ? `<small>${h.n}</small>` : ''}</span><span class="num dh-t ${h.net > 0 ? 'in' : ''}">${esc(signed(h.net))}</span>`;

async function viewTransactions(el, token) {
  el.innerHTML = skeletonRows(9);
  await loadCategories().catch(() => {});
  if (token !== renderToken) return;
  let f = readFilters();
  const accts = accountsData?.accounts ?? [];
  const mem = txMem;
  let selecting = false;
  const sel = new Set();
  let openSwipe = null;
  let swipeAt = 0;
  let kbId = null; // the row j and k have landed on

  el.innerHTML = `<div class="toolbar" id="txbar">
      <div class="trow"><label class="search">${I.search}<input id="q" type="search" placeholder="Search transactions" value="${esc(f.q ?? '')}" autocomplete="off" enterkeyhint="search" aria-label="Search transactions"><button type="button" id="qclear" aria-label="Clear search" title="Clear search" ${f.q ? '' : 'hidden'}>${I.x}</button></label>
      <button class="x selbtn" type="button" id="selbtn" aria-label="Select transactions" title="Select several">${I.select}</button><button class="x" type="button" id="vexport" aria-label="Export CSV" title="Export every transaction these filters match as a CSV">${I.download}</button></div>
      <div class="chips" id="chips" role="group" aria-label="Filters"></div>
      <div class="fsum" id="fsum" aria-label="Active filters"></div>
      <div class="txbusy" id="txbusy" role="progressbar" aria-label="Loading transactions" hidden></div>
    </div>
    <div class="vchips" id="vchips" role="group" aria-label="Saved views"></div>
    <div id="vnote"></div>
    <div id="txnotes"></div>
    <div id="txstale"></div>
    <div id="manbar"></div>
    <div id="txsum"></div>
    <div class="vlist" id="vlist" role="list" aria-label="Transactions"></div>
    <div id="txempty"></div>
    <div id="txmore"></div>`;
  const bar = $('#txbar', el);
  const list = $('#vlist', el);
  // Filtered to a manual account: add a row or import a statement from here.
  const manAcct = f.account ? acctById(f.account) : null;
  if (manAcct?.manual) {
    $('#manbar', el).innerHTML = `<div class="man-acts two-acts"><button class="btn" type="button" id="manaddtx">${I.plus}Add transaction</button><button class="btn ghost" type="button" id="manimp" ${online && !demoActive() ? '' : 'disabled'} title="${!online ? 'Importing needs a connection' : demoActive() ? 'Turn off demo mode to import' : 'Import a CSV statement'}">${I.file}Import CSV</button></div>`;
    $('#manaddtx', el).addEventListener('click', () => openManualTxForm(manAcct));
    $('#manimp', el).addEventListener('click', () => openImport(manAcct));
  }
  wireLogoTiles(list);
  const more = $('#txmore', el);
  const floatHead = document.createElement('div');
  floatHead.className = 'dayfloat';
  floatHead.hidden = true;
  document.body.append(floatHead);
  cleanup.push(() => floatHead.remove());

  const syncBar = () => document.documentElement.style.setProperty('--tbh', `${bar.offsetHeight}px`);

  const paintChips = () => {
    $('#chips', el).innerHTML = filterBarHtml(f);
    const sum = $('#fsum', el);
    sum.innerHTML = filterSummaryHtml(f);
    sum.hidden = !sum.innerHTML;
    requestAnimationFrame(syncBar);
  };

  // ----- summary strip: what the filtered list adds up to -----
  const SUM_CAP = 1000; // rows fetched in the background to complete the totals
  // Until a fresh page has arrived the rows are a saved copy (the first 40, next unset), so the totals are partial.
  let capped = false;
  const paintSummary = () => {
    const box = $('#txsum', el);
    if (!box) return;
    if (!UxModel.hasFilters(f) || !mem.items.length) { box.innerHTML = ''; return; }
    const p = UxModel.summaryParts(UxModel.txSummary(mem.items, { account: !!f.account }), { more: !!mem.next || !mem.fresh, capped, fmt: money });
    box.innerHTML = `<div class="txsum" role="status"><b>${esc(p.count)}</b><span class="sums"><span class="in">In <span class="num">${esc(p.in)}</span></span><span class="out">Out <span class="num">${esc(p.out)}</span></span>${p.moved ? `<span class="moved">Moved out <span class="num">${esc(p.moved)}</span></span>` : ''}</span>${p.note ? `<small>${esc(p.note)}</small>` : ''}</div>`;
  };

  // ----- windowed layout -----
  let layout = [];
  let total = 0;
  let pool = new Map();
  const buildLayout = () => {
    layout = [];
    let y = 0;
    let day = null;
    const nets = new Map();
    const counts = new Map();
    for (const t of mem.items) counts.set(t.date, (counts.get(t.date) ?? 0) + 1);
    for (const t of mem.items) if (UxModel.countsInTotals(t, { account: !!f.account })) nets.set(t.date, (nets.get(t.date) ?? 0) + t.amount);
    for (const t of mem.items) {
      if (t.date !== day) { day = t.date; layout.push({ kind: 'h', day, net: nets.get(day) ?? 0, n: counts.get(day), y, h: HEAD_H }); y += HEAD_H; }
      layout.push({ kind: 'r', t, y, h: ROW_H });
      y += ROW_H;
    }
    total = y;
    list.style.height = `${total}px`;
  };
  const rowHtml = (t) => `<div class="swipe-bg" aria-hidden="${selecting}"><button type="button" data-act="cat" tabindex="-1">${I.tag}<span>Category</span></button>${t.amount < 0 ? `<button type="button" data-act="ded" tabindex="-1" class="ded">${I.receipt}<span>${t.tax ? 'Edit tag' : 'Deduct'}</span></button>` : `<button type="button" data-act="biz" tabindex="-1" class="ded">${I.briefcase}<span>${t.business ? 'Personal' : 'Business'}</span></button>`}</div>
      ${txRowButton(t, { selecting, picked: sel.has(t.id), showAccount: !f.account })}`;
  const mk = (e, idx) => {
    const n = document.createElement('div');
    if (e.kind === 'h') {
      n.className = 'vhead';
      n.innerHTML = dayHeadHtml(e);
    } else {
      n.className = `vrow${sel.has(e.t.id) ? ' sel' : ''}${openSwipe === e.t.id ? ' open' : ''}${kbId === e.t.id ? ' kb' : ''}`;
      n.dataset.id = e.t.id;
      n.innerHTML = rowHtml(e.t);
    }
    n.dataset.i = idx;
    n.style.transform = `translateY(${e.y}px)`;
    return n;
  };
  const listTop = () => list.getBoundingClientRect().top + scrollY;
  let raf = 0;
  const windowRender = () => {
    raf = 0;
    const lt = listTop();
    const from = scrollY - lt - 700;
    const to = scrollY + innerHeight - lt + 700;
    let lo = 0;
    let hi = layout.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (layout[m].y + layout[m].h < from) lo = m + 1; else hi = m; }
    const keep = new Set();
    for (let i = lo; i < layout.length && layout[i].y <= to; i++) {
      keep.add(i);
      if (!pool.has(i)) { const n = mk(layout[i], i); pool.set(i, n); list.append(n); }
    }
    for (const [i, n] of pool) if (!keep.has(i)) { n.remove(); pool.delete(i); }
    // The day header that scrolled off stays pinned under the toolbar.
    const topY = scrollY - lt;
    let k = lo;
    while (k < layout.length - 1 && layout[k + 1].y <= topY + 1) k++;
    let hd = null;
    for (let j = Math.min(k, layout.length - 1); j >= 0; j--) if (layout[j].kind === 'h') { hd = layout[j]; break; }
    if (hd && topY > hd.y + 2 && mem.items.length) {
      const vr = $('#view').getBoundingClientRect();
      floatHead.style.left = `${vr.left}px`;
      floatHead.style.width = `${vr.width}px`;
      floatHead.hidden = false;
      floatHead.innerHTML = dayHeadHtml(hd);
    } else floatHead.hidden = true;
    if (mem.next && !loading && scrollY + innerHeight * 2.2 > lt + total) loadMore();
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(windowRender); };
  const repaintAll = () => { for (const n of pool.values()) n.remove(); pool = new Map(); buildLayout(); windowRender(); paintSummary(); };
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  cleanup.push(() => { removeEventListener('scroll', schedule); removeEventListener('resize', schedule); cancelAnimationFrame(raf); });
  // A row edited elsewhere (editor, Home, Tax) repaints here.
  const onTxChanged = (ev) => {
    const t = ev.detail;
    if (t) { const i = mem.items.findIndex((x) => x.id === t.id); if (i >= 0 && mem.items[i] !== t) Object.assign(mem.items[i], t); }
    repaintAll();
    store.set(`tx:${mem.key}`, { items: mem.items.slice(0, 40), next: null });
  };
  document.addEventListener('mint:txchanged', onTxChanged);
  cleanup.push(() => document.removeEventListener('mint:txchanged', onTxChanged));

  // ----- data -----
  const key = JSON.stringify(f);
  if (mem.key !== key) {
    const cached = store.get(`tx:${key}`);
    Object.assign(mem, { key, items: cached?.items ?? [], next: cached?.next ?? null, fresh: false });
  }
  let loading = false;
  const paintState = () => {
    if (token !== renderToken) return;
    buildLayout();
    const empty = $('#txempty', el);
    if (!mem.items.length) {
      list.hidden = true;
      paintSummary();
      const filtered = Object.keys(f).length;
      if (manAcct?.manual && Object.keys(f).length === 1) {
        empty.innerHTML = emptyState({ icon: I.wallet, title: 'Nothing in this account yet', line: `Add what went in and out of ${accountName(manAcct)}, or import a CSV statement from the bank.`, button: { id: 'manfirst', label: 'Add a transaction', icon: I.plus } });
        $('#manfirst', el)?.addEventListener('click', () => openManualTxForm(manAcct));
        return;
      }
      empty.innerHTML = filtered
        ? emptyState({ icon: I.search, title: 'No matches', line: f.q ? `Nothing matches "${f.q}" with these filters.` : 'Nothing fits these filters.', button: { id: 'clearall', label: 'Clear filters', icon: I.x } })
        : emptyState({ icon: I.list, title: 'No transactions yet', line: 'The first sync pulls every account back as far as each bank allows.', action: { href: '/accounts', label: 'Open sync' } });
      $('#clearall', el)?.addEventListener('click', () => clearAll());
      return;
    }
    list.hidden = false;
    empty.innerHTML = '';
    windowRender();
    paintSummary();
    if (mem.fresh) fillForSummary();
  };
  // true when a page arrived, false when it failed, null when there was nothing to do. quiet: no skeleton, no error card.
  async function loadMore({ quiet = false } = {}) {
    if (loading || !mem.next) return null;
    loading = true;
    if (!quiet) more.innerHTML = skeletonRows(3);
    try {
      const d = await api(filterQuery(f, mem.next));
      if (token !== renderToken) return null;
      const seen = new Set(mem.items.map((t) => t.id));
      mem.items.push(...d.items.filter((t) => !seen.has(t.id)));
      mem.next = d.next;
      more.innerHTML = '';
      buildLayout();
      windowRender();
      paintSummary();
      return true;
    } catch (e) {
      if (!quiet) {
        more.innerHTML = errorCard(e, 'moreretry', 'more transactions');
        $('#moreretry', more)?.addEventListener('click', () => { loading = false; loadMore(); });
      }
      return false;
    } finally { loading = false; }
  }
  // With filters on, keep pulling pages (up to SUM_CAP rows) so the strip adds up the whole answer, not the first 100.
  let filling = false;
  async function fillForSummary() {
    if (filling || !UxModel.hasFilters(f)) return;
    filling = true;
    while (mem.next && mem.items.length < SUM_CAP && token === renderToken) {
      if (loading) { await new Promise((r) => setTimeout(r, 150)); continue; }
      if ((await loadMore({ quiet: true })) !== true) break;
    }
    filling = false;
    if (token !== renderToken) return;
    capped = !!mem.next;
    paintSummary();
  }

  paintChips();
  if (mem.items.length) paintState(); else { $('#txempty', el).innerHTML = skeletonRows(9); list.hidden = true; }
  // Review banner for doubtful transfers.
  swr('/api/review', (d) => {
    if (token !== renderToken) return;
    $('#txnotes', el).innerHTML = d.transfers ? `<button class="banner-card" type="button" id="xbanner">${I.swap}<span><b>${plural(d.transfers, 'transfer')}</b> to review</span>${I.chevron}</button>` : '';
    $('#xbanner', el)?.addEventListener('click', openTransferReview);
    requestAnimationFrame(syncBar);
  }).catch(() => {});

  if (!mem.fresh) {
    const busy = $('#txbusy', el);
    const stale = $('#txstale', el);
    busy.hidden = false;
    // A few seconds in, say so: the server may be waking up.
    const slow = setTimeout(() => { stale.innerHTML = `<div class="txnote" role="status"><span class="spin dim"></span>Still loading, the server may be cold-starting</div>`; }, 4000);
    const stop = () => { clearTimeout(slow); busy.hidden = true; stale.innerHTML = ''; };
    try {
      const d = await api(filterQuery(f));
      stop();
      if (token !== renderToken) return;
      const head = d.items;
      const known = new Set(head.map((t) => t.id));
      const rest = mem.items.length > head.length ? mem.items.slice(head.length).filter((t) => !known.has(t.id)) : [];
      // Keep what was loaded below the first page when returning to the list.
      mem.items = rest.length && mem.items.slice(0, head.length).every((t) => known.has(t.id)) ? [...head, ...rest] : head;
      if (!rest.length) mem.next = d.next;
      mem.fresh = true;
      store.set(`tx:${key}`, { items: head.slice(0, 40), next: head.length > 40 ? null : d.next });
      for (const n of pool.values()) n.remove();
      pool = new Map();
      paintState();
    } catch (e) {
      stop();
      if (token !== renderToken) return;
      if (!mem.items.length) {
        list.innerHTML = errorCard(e, 'txretry', 'transactions');
        $('#txretry', list)?.addEventListener('click', () => render());
        return;
      }
      capped = true; // the saved copy is only the first rows, so the strip must not read as the whole answer
      paintSummary();
      stale.innerHTML = `<div class="error compact" role="alert"><div class="h">Showing saved transactions</div><div class="d">Couldn't refresh: ${esc(e.detail ?? e.message)}</div><button class="btn ghost sm" type="button" id="txrefresh">${I.refresh}Retry</button></div>`;
      $('#txrefresh', stale)?.addEventListener('click', () => render());
    }
  }

  // Scroll restore when the list is deeper than what is loaded.
  const want = Number(sessionStorage.getItem(scrollKey('/transactions')) ?? 0);
  if (want > 0 && mem.items.length) {
    for (let n = 0; n < 30 && mem.next && want > listTop() + total - innerHeight; n++) { await loadMore(); if (token !== renderToken) return; }
    scrollTo(0, want);
    windowRender();
  }

  // ----- interaction -----
  const setFilters = (next) => { f = next; writeFilters(f); render({ keepScroll: false }); };
  mountViews(el, token, () => f, setFilters);
  let deb;
  $('#q', el).addEventListener('input', (e) => {
    $('#qclear', el).hidden = !e.target.value;
    clearTimeout(deb);
    deb = setTimeout(() => setFilters({ ...f, q: e.target.value.trim() || undefined }), 350);
  });
  $('#qclear', el).addEventListener('click', () => setFilters({ ...f, q: undefined }));
  const clearAll = () => {
    clearTimeout(deb);
    $('#q', el).value = '';
    $('#qclear', el).hidden = true;
    setFilters({});
  };
  $('#chips', el).addEventListener('click', (e) => {
    const d = e.target.closest('[data-dd]');
    if (d) { buzz(4); openFilterDropdown(d.dataset.dd, d, f, setFilters); }
  });
  $('#fsum', el).addEventListener('click', (e) => {
    if (e.target.closest('#fclearall')) { buzz(); clearAll(); return; }
    const r = e.target.closest('[data-rm]');
    if (!r) return;
    buzz();
    if (r.dataset.rm === 'q') { $('#q', el).value = ''; $('#qclear', el).hidden = true; }
    const next = { ...f };
    for (const k of r.dataset.rm.split(',')) delete next[k];
    setFilters(next);
  });
  cleanup.push(() => closeDropdown());

  // Rows: tap opens, long-press selects, swipe reveals actions.
  const byId = (id) => mem.items.find((t) => t.id === id);
  const closeSwipes = () => { if (!openSwipe) return; const n = $(`.vrow[data-id="${CSS.escape(openSwipe)}"]`, list); if (n) { n.classList.remove('open'); $('.row', n).style.transform = ''; } openSwipe = null; };
  let swallow = false;
  list.addEventListener('click', async (e) => {
    if (swallow) { swallow = false; return; }
    const act = e.target.closest('[data-act]');
    const row = e.target.closest('[data-tx]');
    if (act) {
      const t = byId(act.closest('.vrow').dataset.id);
      closeSwipes();
      if (!t) return;
      if (act.dataset.act === 'cat') await chooseCategory(t);
      if (act.dataset.act === 'ded') openTaxForm(t);
      if (act.dataset.act === 'biz') { const r = await patchTx(t, { is_business: !t.business }); if (r.ok) toast(t.business ? 'Counted as business' : 'Counted as personal'); }
      return;
    }
    if (!row) return;
    if (openSwipe) { closeSwipes(); return; }
    const t = byId(row.dataset.tx);
    if (!t) return;
    if (selecting) { toggleSel(t.id); return; }
    kbId = t.id;
    $$('.vrow.kb', list).forEach((r) => r.classList.remove('kb'));
    $$('.vrow.sel', list).forEach((r) => r.classList.remove('sel'));
    row.closest('.vrow').classList.add('sel');
    openTx(t);
  });
  let press = null;
  list.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.row.tx');
    if (!row) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const vr = row.closest('.vrow');
    const id = vr.dataset.id;
    let mode = null;
    let dx = 0;
    let vel = 0;
    let lastX = startX;
    let lastT = performance.now();
    if (openSwipe && openSwipe !== id) closeSwipes();
    press = setTimeout(() => { if (!mode) { swallow = true; buzz(18); startSelecting(id); } }, 480);
    const move = (ev) => {
      dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!mode && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        clearTimeout(press);
        mode = ev.pointerType !== 'mouse' && !selecting && Math.abs(dx) > Math.abs(dy) * 1.4 && dx < 0 || (openSwipe === id && dx > 0 && Math.abs(dx) > Math.abs(dy)) ? 'swipe' : 'scroll';
        if (mode === 'swipe') { row.setPointerCapture?.(ev.pointerId); row.classList.add('dragging'); }
      }
      if (mode === 'swipe') {
        const now = performance.now();
        if (now - lastT > 30) { vel = (ev.clientX - lastX) / (now - lastT); lastX = ev.clientX; lastT = now; }
        const base = openSwipe === id ? -168 : 0;
        let x = base + dx;
        if (x < -168) x = -168 + (x + 168) * 0.22; // resistance past the buttons
        else if (x > 0) x *= 0.2;
        row.style.transform = `translateX(${Math.max(-200, Math.min(24, x))}px)`;
        vr.style.setProperty('--sp', String(Math.max(0, Math.min(1, -x / 168))));
      }
    };
    const end = () => {
      clearTimeout(press);
      row.removeEventListener('pointermove', move);
      row.removeEventListener('pointerup', end);
      row.removeEventListener('pointercancel', end);
      if (mode === 'swipe') {
        row.classList.remove('dragging');
        swallow = true;
        setTimeout(() => { swallow = false; }, 60);
        const base = openSwipe === id ? -168 : 0;
        const open = Math.abs(vel) > 0.45 ? vel < 0 : base + dx < -64;
        row.style.transform = open ? 'translateX(-168px)' : '';
        vr.style.removeProperty('--sp');
        vr.classList.toggle('open', open);
        openSwipe = open ? id : null;
        swipeAt = scrollY;
        if (open) buzz(8);
      }
    };
    row.addEventListener('pointermove', move);
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', end);
  });
  const swipeScroll = () => { if (openSwipe && Math.abs(scrollY - swipeAt) > 24) closeSwipes(); };
  addEventListener('scroll', swipeScroll, { passive: true });
  cleanup.push(() => removeEventListener('scroll', swipeScroll));

  // ----- keyboard (desktop): j and k move a highlight down the list, e edits it -----
  const kbMark = () => {
    $$('.vrow.kb', list).forEach((n) => { if (n.dataset.id !== kbId) n.classList.remove('kb'); });
    if (kbId) $(`.vrow[data-id="${CSS.escape(kbId)}"]`, list)?.classList.add('kb');
  };
  listKeys = {
    move(delta) {
      const rows = layout.filter((x) => x.kind === 'r');
      if (!rows.length) return;
      const lt = listTop();
      const head = (parseFloat(getComputedStyle(bar).top) || 0) + bar.offsetHeight + HEAD_H; // the safe-area inset the bar sticks at, then the bar, then a day header
      const i = rows.findIndex((x) => x.t.id === kbId);
      // First press lands on the first row in view rather than the top of the list.
      const first = Math.max(0, rows.findIndex((x) => lt + x.y >= scrollY + head));
      const next = i < 0 ? first : UxModel.nextIndex(i, delta, rows.length);
      if (i >= 0 && next === i && delta > 0 && mem.next) loadMore();
      const row = rows[next];
      kbId = row.t.id;
      kbMark();
      const top = lt + row.y;
      if (top < scrollY + head) scrollTo({ top: Math.max(0, top - head) });
      else if (top + row.h > scrollY + innerHeight - 24) scrollTo({ top: top + row.h - innerHeight + 24 });
      windowRender();
      kbMark();
    },
    edit() {
      const t = kbId && byId(kbId);
      if (t) { buzz(6); openTx(t); } else toast('Press j or k to pick a transaction first');
    },
  };
  cleanup.push(() => { listKeys = null; });

  // ----- bulk edit -----
  let bulkBar = null;
  function startSelecting(id) {
    selecting = true;
    if (id) sel.add(id);
    $('#selbtn', el).classList.add('on');
    document.body.classList.add('selecting');
    drawBulk();
    repaintAll();
  }
  function stopSelecting() {
    selecting = false;
    sel.clear();
    $('#selbtn', el)?.classList.remove('on');
    document.body.classList.remove('selecting');
    bulkBar?.remove();
    bulkBar = null;
    repaintAll();
  }
  function toggleSel(id) {
    if (sel.has(id)) sel.delete(id); else sel.add(id);
    buzz(6);
    drawBulk();
    const n = $(`.vrow[data-id="${CSS.escape(id)}"]`, list);
    if (n) { n.classList.toggle('sel', sel.has(id)); const t = byId(id); n.innerHTML = rowHtml(t); }
  }
  function drawBulk() {
    if (!bulkBar) { bulkBar = document.createElement('div'); bulkBar.className = 'bulkbar'; document.body.append(bulkBar); }
    const n = sel.size;
    bulkBar.innerHTML = `<button class="x" type="button" data-b="done" aria-label="Done selecting" title="Done selecting">${I.x}</button>
      <div class="bcount" aria-live="polite"><b>${n}</b> selected</div>
      <button class="btn ghost" type="button" data-b="all" ${mem.items.length ? '' : 'disabled'}>${n === mem.items.length ? 'None' : 'All'}</button>
      <button class="btn" type="button" data-b="cat" ${n ? '' : 'disabled'} title="${n ? 'Set a category on the selected' : 'Select some transactions first'}">${I.tag}Category</button>
      <button class="btn ghost" type="button" data-b="biz" ${n ? '' : 'disabled'} title="${n ? 'Count the selected as business or personal' : 'Select some transactions first'}">${I.briefcase}Business</button>`;
  }
  async function bulkApply(patch, doneMsg) {
    const ids = [...sel];
    const targets = ids.map(byId).filter(Boolean);
    const before = targets.map((t) => ({ ...t }));
    targets.forEach((t) => applyPatchLocal(t, patch));
    stopSelecting();
    try {
      const { queued } = await mutate({ method: 'POST', path: '/api/transactions/bulk', body: { ids, ...patch } });
      toast(queued ? 'Saved offline, syncs when you are back' : `${doneMsg} on ${plural(ids.length, 'transaction')}`);
      buzz(14);
      document.dispatchEvent(new CustomEvent('mint:data'));
    } catch (e) {
      targets.forEach((t, i) => Object.assign(t, before[i]));
      repaintAll();
      toast(`Couldn't update ${plural(ids.length, 'transaction')}: ${e.detail}`, { error: true, action: { label: 'Retry', fn: () => { ids.forEach((id) => sel.add(id)); startSelecting(); } } });
    }
  }
  document.addEventListener('click', async function bulkClick(e) {
    if (!el.isConnected) return document.removeEventListener('click', bulkClick);
    const b = e.target.closest('.bulkbar [data-b]');
    if (!b) return;
    const what = b.dataset.b;
    if (what === 'done') return stopSelecting();
    if (what === 'all') { if (sel.size === mem.items.length) sel.clear(); else mem.items.forEach((t) => sel.add(t.id)); drawBulk(); repaintAll(); return; }
    if (what === 'cat') { const id = await pickCategory({ title: `Category for ${plural(sel.size, 'transaction')}` }); if (id !== undefined) bulkApply({ category_id: id }, `Filed under ${id == null ? 'the rules' : catName(id)}`); }
    if (what === 'biz') {
      const panel = openModal(`${sheetHead(null, `Count ${plural(sel.size, 'transaction')} as`)}
        <div class="stack"><button class="btn" type="button" data-bz="1">${I.briefcase}Business</button><button class="btn ghost" type="button" data-bz="0">Personal</button><button class="btn ghost" type="button" data-bz="n">Follow the account</button></div>`);
      panel.addEventListener('click', (ev) => {
        const z = ev.target.closest('[data-bz]');
        if (!z) return;
        closeModal();
        bulkApply({ is_business: z.dataset.bz === 'n' ? null : z.dataset.bz === '1' }, 'Counted');
      });
    }
  });
  $('#selbtn', el).addEventListener('click', () => (selecting ? stopSelecting() : startSelecting()));
  cleanup.push(() => { document.body.classList.remove('selecting'); bulkBar?.remove(); });
}
