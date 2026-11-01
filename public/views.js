// Saved views and CSV export on Transactions. A view is the current filter set
// under a name: a pill to apply it, a sheet to rename or delete it (delete has
// the 5 second undo). Views live in /api/views, cached for offline, and every
// write goes through the offline queue; the id is chosen here so a view made
// offline can be edited before it ever syncs. Export asks the server for
// every row the filters match (not just the rows loaded) and saves the file.
'use strict';

let viewsData = store.get('c:/api/views')?.d?.items ?? null;
let viewsUi = null; // the mounted bar: { paint, note }
let exportBusy = null; // null, 'prep' or 'slow'

const viewsSave = (items) => { viewsData = items; store.set('c:/api/views', { d: { items }, at: Date.now() }); };
const newViewId = () => `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
const viewFilters = (f) => Object.fromEntries(UxModel.FILTER_KEYS.filter((k) => f[k]).map((k) => [k, String(f[k])]));
const viewNameTaken = (name, exceptId = null) => (viewsData ?? []).some((v) => v.id !== exceptId && v.name.toLowerCase() === name.trim().toLowerCase());

// A plain-English line per filter, for the save sheet.
function filterWords(f) {
  const out = filterChips(f).map(([, label]) => label);
  if (f.q) out.unshift(`"${f.q}"`);
  return out;
}

function viewPillHtml(v, on) {
  if (!on) return `<button class="fchip" type="button" data-vapply="${esc(v.id)}">${esc(v.name)}</button>`;
  return `<span class="vp"><button type="button" data-vapply="${esc(v.id)}" aria-pressed="true">${esc(v.name)}</button><button class="vedit" type="button" data-vedit="${esc(v.id)}" aria-label="Rename or delete ${esc(v.name)}" title="Rename or delete this view">${I.edit}</button></span>`;
}

// Mounts the pill row into #vchips under the toolbar. getF reads the live filters, apply sets them.
function mountViews(el, token, getF, apply) {
  const bar = $('#vchips', el);
  const note = $('#vnote', el);
  let loadError = null;
  const paint = () => {
    if (token !== renderToken) return;
    const f = getF();
    const list = viewsData ?? [];
    const active = list.find((v) => UxModel.sameFilters(v.filters, f));
    const canSave = UxModel.hasFilters(f) && !active;
    const why = !online ? 'Offline: exporting needs a connection' : exportBusy ? (exportBusy === 'slow' ? 'Still preparing, the server may be busy' : 'Preparing the CSV') : 'Export every transaction these filters match as a CSV';
    const exp = $('#vexport', el);
    if (exp) {
      exp.disabled = !online || !!exportBusy;
      exp.title = why;
      exp.setAttribute('aria-label', exportBusy ? why : 'Export CSV');
      exp.toggleAttribute('aria-busy', !!exportBusy);
      exp.innerHTML = exportBusy ? '<span class="spin dim"></span>' : I.download;
    }
    const pending = viewsData === null && !loadError;
    bar.hidden = !UxModel.showViewsRow({ views: list.length, loaded: !pending, canSave, error: !!loadError });
    bar.innerHTML = `${pending ? '<span class="sk sk-pill" aria-hidden="true"></span><span class="sk sk-pill" aria-hidden="true"></span>' : list.map((v) => viewPillHtml(v, v === active)).join('')}
      ${canSave ? `<button class="fchip save" type="button" id="vsave">${I.bookmark}Save view</button>` : ''}`;
    note.innerHTML = loadError ? `<div class="error compact"><div class="h">Couldn't load your saved views</div><div class="d">${esc(loadError.detail ?? loadError.message)}</div><button class="btn ghost sm" type="button" id="vretry">${I.refresh}Retry</button></div>` : note.innerHTML;
  };
  const load = () => {
    loadError = null;
    return swr('/api/views', (d) => { viewsSave(d.items); if (loadError) { loadError = null; note.innerHTML = ''; } paint(); }).catch((e) => { loadError = e; paint(); });
  };
  viewsUi = { paint, note, getF };
  cleanup.push(() => { if (viewsUi?.paint === paint) viewsUi = null; });
  document.addEventListener('mint:online', paint);
  cleanup.push(() => document.removeEventListener('mint:online', paint));

  let pressTimer = 0;
  let swallow = false;
  const manage = (id) => { const v = (viewsData ?? []).find((x) => x.id === id); if (v) openViewSheet(v, getF, apply, paint); };
  bar.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-vapply]');
    if (!b || e.pointerType === 'mouse') return;
    pressTimer = setTimeout(() => { swallow = true; buzz(18); manage(b.dataset.vapply); }, 480);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave', 'scroll']) bar.addEventListener(t, () => clearTimeout(pressTimer), { passive: true });
  bar.addEventListener('contextmenu', (e) => { const b = e.target.closest('[data-vapply]'); if (b) { e.preventDefault(); manage(b.dataset.vapply); } });
  bar.addEventListener('click', (e) => {
    if (swallow) { swallow = false; return; }
    const ap = e.target.closest('[data-vapply]');
    if (ap && !e.target.closest('[data-vedit]')) {
      const v = (viewsData ?? []).find((x) => x.id === ap.dataset.vapply);
      if (!v) return;
      buzz(6);
      // Tapping the view you are already on turns it off.
      apply(UxModel.sameFilters(v.filters, getF()) ? {} : { ...v.filters });
      return;
    }
    const ed = e.target.closest('[data-vedit]');
    if (ed) { buzz(6); manage(ed.dataset.vedit); return; }
    if (e.target.closest('#vsave')) { buzz(6); openSaveViewSheet(getF, paint); return; }
  });
  $('#vexport', el)?.addEventListener('click', () => runExport());
  note.addEventListener('click', (e) => {
    if (e.target.closest('#vretry')) { note.innerHTML = ''; load(); paint(); }
    if (e.target.closest('#exretry')) runExport();
    if (e.target.closest('#exdismiss')) note.innerHTML = '';
  });
  paint();
  load();
}

// ---------- save, rename, delete ----------

function openSaveViewSheet(getF, repaint) {
  const f = viewFilters(getF());
  const panel = openModal(`${sheetHead('Saved view', 'Save these filters')}
    <form class="form" novalidate>
      <div class="vwords">${filterWords(f).map((w) => `<span class="chip">${esc(w)}</span>`).join('')}</div>
      <div class="field"><label for="vname">Name</label><input id="vname" name="name" maxlength="40" autocomplete="off" placeholder="Eating out this month" autofocus></div>
      <button class="btn wide" type="submit">${I.check}Save view</button>
    </form>`);
  const form = $('form', panel);
  const d = bindDraft(form, 'view:new');
  const name = $('#vname', form);
  const check = () => {
    const v = name.value.trim();
    if (!v) return fieldError(name, 'Give the view a name');
    if (v.length > 40) return fieldError(name, 'Keep it to 40 characters or fewer');
    if (viewNameTaken(v)) return fieldError(name, 'You already have a view with that name');
    if ((viewsData ?? []).length >= 30) return fieldError(name, 'That is 30 views already, delete one first');
    return fieldError(name, '');
  };
  name.addEventListener('input', check);
  if (d.restored) check();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!check()) return;
    const body = { id: newViewId(), name: name.value.trim().replace(/\s+/g, ' '), filters: f };
    formError(form, null);
    try {
      const r = await withBusy($('button[type=submit]', form), 'Saving', () => mutate({ method: 'POST', path: '/api/views', body }));
      const made = { ...body, sort: (viewsData ?? []).length, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...(r.data ?? {}) };
      viewsSave([...(viewsData ?? []), made]);
      d.clear();
      closeModal();
      repaint();
      toast(r.queued ? 'Saved offline, syncs when you are back' : `Saved the view ${made.name}`);
      buzz(12);
    } catch (err) {
      if (err.status === 409) return fieldError(name, 'You already have a view with that name');
      formError(form, err, 'Save');
    }
  });
}

function openViewSheet(v, getF, apply, repaint) {
  const f = viewFilters(getF());
  const differs = UxModel.hasFilters(f) && !UxModel.sameFilters(v.filters, f);
  const panel = openModal(`${sheetHead('Saved view', v.name)}
    <form class="form" novalidate>
      <div class="vwords">${filterWords(v.filters).map((w) => `<span class="chip">${esc(w)}</span>`).join('')}</div>
      <div class="field"><label for="vname">Name</label><input id="vname" name="name" maxlength="40" autocomplete="off" value="${esc(v.name)}"></div>
      <button class="btn wide" type="submit">${I.check}Rename</button>
      ${differs ? `<button class="btn ghost wide" type="button" id="vrefilter">${I.filter}Use the current filters instead</button>` : ''}
      <button class="btn danger wide" type="button" id="vdelete">${I.trash}Delete view</button>
    </form>`);
  const form = $('form', panel);
  const name = $('#vname', form);
  const check = () => {
    const t = name.value.trim();
    if (!t) return fieldError(name, 'Give the view a name');
    if (viewNameTaken(t, v.id)) return fieldError(name, 'You already have a view with that name');
    return fieldError(name, '');
  };
  name.addEventListener('input', check);
  const patch = async (body, btn, busy, done) => {
    formError(form, null);
    try {
      const r = await withBusy(btn, busy, () => mutate({ method: 'PATCH', path: `/api/views/${encodeURIComponent(v.id)}`, body }));
      viewsSave((viewsData ?? []).map((x) => (x.id === v.id ? { ...x, ...body, ...(r.data ?? {}) } : x)));
      closeModal();
      repaint();
      toast(r.queued ? 'Saved offline, syncs when you are back' : done);
      buzz(12);
    } catch (err) {
      if (err.status === 409) return fieldError(name, 'You already have a view with that name');
      formError(form, err, 'Save');
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!check()) return;
    const next = name.value.trim().replace(/\s+/g, ' ');
    if (next === v.name) { closeModal(); return; }
    patch({ name: next }, $('button[type=submit]', form), 'Renaming', `Renamed to ${next}`);
  });
  $('#vrefilter', form)?.addEventListener('click', (e) => patch({ filters: f }, e.currentTarget, 'Saving', `Updated ${v.name}`));
  $('#vdelete', form).addEventListener('click', () => {
    const prev = viewsData ?? [];
    closeModal();
    undoable({
      label: `Deleted the view ${v.name}`,
      apply: () => { viewsSave(prev.filter((x) => x.id !== v.id)); repaint(); },
      revert: () => { viewsSave(prev); repaint(); },
      op: { method: 'DELETE', path: `/api/views/${encodeURIComponent(v.id)}` },
    });
  });
}

// ---------- CSV export ----------

async function fetchCsv(path) {
  if (demoActive()) throw demoNoDownload();
  for (let i = 0; ; i++) {
    let res;
    try { res = await fetch(path, { credentials: 'same-origin', redirect: 'manual' }); } catch (e) {
      if (i < 2) { await sleep(400 * 3 ** i); continue; }
      setOnline(false);
      throw new ApiError('No connection', String(e?.message ?? e), { offline: true });
    }
    setOnline(true);
    if (res.type === 'opaqueredirect' || res.status === 401) throw new ApiError('Signed out', 'The sign-in gate session expired. Sign in again to carry on.', { signedOut: true });
    if (res.status >= 500 && i < 2) { await sleep(400 * 3 ** i); continue; }
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      throw new ApiError('Request failed', `${res.status} ${d?.error ?? res.statusText}${d?.id ? ` (ref ${d.id})` : ''}`, { status: res.status });
    }
    return res;
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

async function runExport() {
  if (exportBusy || !viewsUi) return;
  const ui = viewsUi;
  const set = (v) => { exportBusy = v; if (viewsUi === ui) ui.paint(); };
  ui.note.innerHTML = '';
  set('prep');
  const slow = setTimeout(() => { if (exportBusy) set('slow'); }, 4000);
  loadBar(1);
  try {
    const qs = new URLSearchParams(viewFilters(ui.getF()));
    const res = await fetchCsv(`/api/transactions/export.csv${qs.toString() ? `?${qs}` : ''}`);
    const rows = Number(res.headers.get('x-export-rows') ?? 0);
    const blob = await res.blob();
    if (!rows) toast('No transactions match these filters, so there is nothing to export');
    else {
      saveBlob(blob, UxModel.filenameFrom(res.headers.get('content-disposition')));
      toast(res.headers.get('x-export-truncated') === '1' ? `Exported the newest ${plural(rows, 'transaction')}, the most one file holds` : `Exported ${plural(rows, 'transaction')}`);
      buzz(12);
    }
  } catch (e) {
    if (viewsUi === ui) {
      ui.note.innerHTML = `<div class="error compact"><div class="h">${esc(e.offline ? 'No connection, couldn\'t export the CSV' : e.signedOut ? 'Signed out' : 'Couldn\'t export the CSV')}</div><div class="d">${esc(e.detail ?? e.message)}</div>
        <div class="ex-act">${e.signedOut ? '<button class="btn sm" type="button" data-signin>Sign in</button>' : `<button class="btn ghost sm" type="button" id="exretry">${I.refresh}Retry</button>`}<button class="btn ghost sm" type="button" id="exdismiss">Dismiss</button></div></div>`;
    }
  } finally {
    clearTimeout(slow);
    loadBar(-1);
    set(null);
  }
}
