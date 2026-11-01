// Subscriptions: what Mint detected, merged with the ones the owner adds by hand, and a
// state for each (active, cancelled, not a subscription). Shown on Plan (?s=subs) and
// above the transactions in the Subscriptions budget. Cancelled ones come off the
// bills calendar, the forecast and the alerts but stay listed with what they save;
// "Maybe" are merchants filed under Subscriptions that charged lately with no rhythm yet.
// Every write is optimistic, with a 5 second undo on cancel, dismiss and delete.
'use strict';

const SUB_CADENCES = [['weekly', 'Weekly'], ['fortnightly', 'Fortnightly'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly']];
const SUB_GROUPS = ['active', 'cancelled', 'stopped', 'dismissed', 'maybe'];
const subCadenceWord = (c) => SUB_CADENCES.find(([k]) => k === c)?.[1] ?? '';
const subSum = (list) => list.reduce((s, i) => s + i.per_month, 0);
const subDetectedPath = (key) => `/api/subscriptions/detected/${encodeURIComponent(key)}`;
const subIsDetected = (it) => it.origin === 'detected';
const SUB_FACTOR = { weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
const subPerMonth = (amount, cadence) => Math.round(amount * SUB_FACTOR[cadence]);

function subRecalc(d) {
  d.totals = { active_per_month: subSum(d.active), cancelled_saved_per_month: subSum(d.cancelled) };
}
function subFind(d, key) {
  for (const g of SUB_GROUPS) { const it = d[g].find((i) => i.key === key); if (it) return it; }
  return null;
}

function subRow(it) {
  const chips = [
    it.variable ? '<span class="chip" title="The amount changes from charge to charge">Varies</span>' : '',
    it.still_charging ? '<span class="chip warn" title="A charge landed after the date you cancelled">Charged again</span>' : '',
  ].join('');
  const when = it.status === 'active' ? `${it.cadence === 'monthly' ? 'Next' : `${subCadenceWord(it.cadence)} · next`} ${shortDay(it.next_date)}, ${inDays(it.next_date)}`
    : it.status === 'cancelled' ? `Cancelled ${dmy(it.cancelled_on)}${it.last_date ? ` · last charge ${shortDay(it.last_date)}` : ''}`
      : it.status === 'stopped' ? `Last charged ${shortDay(it.last_date)}`
        : it.status === 'maybe' ? `Charged ${shortDay(it.last_date)}, ${plural(it.count, 'time')} seen`
          : it.last_date ? `Last charged ${shortDay(it.last_date)}` : 'Not counted';
  const amt = it.amount == null ? '' : `${it.variable ? 'About ' : ''}${money(it.amount)}`;
  const per = it.cadence && it.cadence !== 'monthly' && it.per_month ? `${money0(it.per_month)} a month` : subCadenceWord(it.cadence) === 'Monthly' ? 'a month' : '';
  return `<button class="row sub" type="button" data-sub="${esc(it.key)}">
    ${logoTile({ name: it.name, logo: it.logo, icon: I.repeat })}
    <div class="main"><div class="t1">${esc(it.name)} ${chips}</div><div class="t2">${esc(when)}</div></div>
    <div class="amt num ${it.status === 'cancelled' ? 'dim' : ''}">${esc(amt)}<div class="t2">${esc(per)}</div></div></button>`;
}

function subGroup(title, items, { note = '', open = null, id = '', right = '' } = {}) {
  if (!items.length) return '';
  const rows = `<div class="rows stagger" role="list">${items.map(subRow).join('')}</div>`;
  if (open == null) return `<div class="sec-head"><h2>${esc(title)}</h2><span class="sub num">${right}</span></div>${note ? `<p class="sub pad">${esc(note)}</p>` : ''}${rows}`;
  return `<details class="subgrp" data-grp="${id}" ${open ? 'open' : ''}><summary><span>${esc(title)} <span class="num">${items.length}</span></span>${I.more}</summary>${note ? `<p class="sub pad">${esc(note)}</p>` : ''}${rows}</details>`;
}

// Draws the list into `box` and wires it. `embedded` drops the page-level intro (used inside a budget).
function subsSection(box, token, { embedded = false } = {}) {
  let data = null;
  const opened = new Set();
  const paint = () => {
    if (token !== renderToken || !data) return;
    const t = data.totals;
    const hasAny = SUB_GROUPS.some((g) => data[g].length);
    box.innerHTML = `<div class="sec-head"><h2>${embedded ? 'Subscriptions' : 'Your subscriptions'}</h2><button class="btn ghost sm" type="button" id="subadd">${I.plus}Add one</button></div>
      ${data.active.length || data.cancelled.length ? `<section class="card month"><div class="mtop"><div><div class="k">Active, a month</div><div class="big2 num">${esc(money0(t.active_per_month))}</div></div>
          ${data.cancelled.length ? `<div class="mr"><div class="k">Cancelled, saving</div><div class="v num pos">${esc(money0(t.cancelled_saved_per_month))} a month</div></div>` : ''}</div>
        <div class="mline"><span>${esc(plural(data.active.length, 'active subscription'))}</span><span class="num">${esc(money0(t.active_per_month * 12))} a year</span></div></section>` : ''}
      ${data.active.length ? `<div class="rows stagger" role="list">${data.active.map(subRow).join('')}</div>`
    : `<div class="card">${emptyState({ icon: I.repeat, title: hasAny ? 'No active subscriptions' : 'No subscriptions found', line: hasAny ? 'Everything found is cancelled or set aside.' : 'Add one by hand if you pay for something.', button: { id: 'subadd2', label: 'Add a subscription', icon: I.plus } })}</div>`}
      ${subGroup('Cancelled', data.cancelled, { right: `${esc(money0(t.cancelled_saved_per_month))} a month saved` })}
      ${subGroup('Maybe subscriptions', data.maybe, { open: opened.has('maybe'), id: 'maybe' })}
      ${subGroup('Stopped charging', data.stopped, { open: opened.has('stopped'), id: 'stopped' })}
      ${subGroup('Not subscriptions', data.dismissed, { open: opened.has('dismissed'), id: 'dismissed' })}`;
    wireLogoTiles(box);
    applyDims(box);
    // "Add subscription" from search lands here and opens the form once the section has drawn.
    if (jumpIntent.take('add-sub')) setTimeout(() => openSubForm(null, ctx), 0);
  };
  const load = () => swr('/api/subscriptions', (d) => { data = d; paint(); }).catch((e) => {
    if (token !== renderToken) return;
    if (data) { toast(`Showing saved subscriptions: ${e.detail ?? e.message}`, { error: true }); return; }
    box.innerHTML = errorCard(e, 'subretry', 'subscriptions');
    $('#subretry', box)?.addEventListener('click', () => { box.innerHTML = subSkeleton(); applyDims(box); load(); });
  });
  const ctx = {
    get data() { return data; }, set data(v) { data = v; }, paint, load,
  };
  box.addEventListener('toggle', (e) => {
    const g = e.target.dataset?.grp;
    if (g) { if (e.target.open) opened.add(g); else opened.delete(g); }
  }, true);
  box.addEventListener('click', (e) => {
    if (e.target.closest('#subadd, #subadd2')) { buzz(6); return openSubForm(null, ctx); }
    const r = e.target.closest('[data-sub]');
    if (r && data) { const it = subFind(data, r.dataset.sub); if (it) { buzz(6); openSubSheet(it, ctx); } }
  });
  if (!store.get('c:/api/subscriptions')) { box.innerHTML = subSkeleton(); applyDims(box); }
  return load();
}
const subSkeleton = () => `<div class="sec-head"><h2>Your subscriptions</h2></div>${skeletonCard(110)}${skeletonRows(4)}`;

// ---------- one subscription ----------

function subLine(label, value) { return `<div class="erow static"><span class="k">${esc(label)}</span><span class="v">${value}</span></div>`; }

function openSubSheet(it, ctx) {
  const manual = it.origin === 'manual';
  const lines = [
    it.amount != null ? subLine('Amount', `${it.variable ? 'About ' : ''}${esc(money(it.amount))} ${esc(subCadenceWord(it.cadence).toLowerCase())}`) : '',
    it.per_month ? subLine('Per month', esc(money(it.per_month))) : '',
    it.status === 'active' ? subLine('Next charge', `${esc(dmy(it.next_date))}, ${esc(inDays(it.next_date))}`) : '',
    it.status === 'cancelled' ? subLine('Cancelled on', esc(dmy(it.cancelled_on))) : '',
    it.last_date ? subLine('Last charge', esc(dmy(it.last_date))) : '',
    it.count ? subLine('Charges seen', esc(String(it.count))) : '',
    it.category ? subLine('Category', esc(it.category)) : '',
  ].join('');
  const watch = it.still_charging ? `<div class="nudge">${I.alert}<div><b>Charged again</b><small>A charge landed after ${esc(dmy(it.cancelled_on))}. It may not have cancelled, or the last bill was late.</small></div></div>` : '';
  const find = it.merchant_key || it.origin === 'detected' ? `<a class="btn ghost wide" href="/transactions?q=${encodeURIComponent(it.name)}" data-nav data-close>${I.search}See its charges</a>` : '';
  const actions = {
    active: `<button class="btn wide" type="button" data-do="cancel">${I.x}Cancel this subscription</button>
      ${manual ? `<button class="btn ghost wide" type="button" data-do="edit">${I.edit}Edit details</button><button class="btn danger wide" type="button" data-do="delete">${I.trash}Delete</button>` : `<button class="btn ghost wide" type="button" data-do="dismiss">${I.tag}Not a subscription</button>`}`,
    cancelled: `<button class="btn wide" type="button" data-do="restore">${I.refresh}Not cancelled after all</button>
      <button class="btn ghost wide" type="button" data-do="cancel">${I.calendar}Change the cancelled date</button>
      ${manual ? `<button class="btn ghost wide" type="button" data-do="edit">${I.edit}Edit details</button><button class="btn danger wide" type="button" data-do="delete">${I.trash}Delete</button>` : ''}`,
    stopped: `<button class="btn wide" type="button" data-do="cancel">${I.x}Mark as cancelled</button><button class="btn ghost wide" type="button" data-do="dismiss">${I.tag}Not a subscription</button>`,
    maybe: `<button class="btn wide" type="button" data-do="adopt">${I.plus}Add as a subscription</button><button class="btn ghost wide" type="button" data-do="dismiss">${I.tag}Not a subscription</button>`,
    dismissed: `<button class="btn wide" type="button" data-do="restore">${I.refresh}Bring it back</button>`,
  }[it.status];
  const sub = { active: 'Subscription', cancelled: 'Cancelled', stopped: 'Stopped charging', maybe: 'Maybe a subscription', dismissed: 'Not a subscription' }[it.status];
  const panel = openModal(`${sheetHead(sub, it.name)}${watch}<div class="ed">${lines}</div><div class="sheet-actions">${find}${actions}</div>`);
  panel.addEventListener('click', (e) => {
    const a = e.target.closest('[data-do]');
    if (!a) return;
    const act = a.dataset.do;
    if (act === 'cancel') return openSubCancel(it, ctx);
    if (act === 'edit') return openSubForm(it, ctx);
    if (act === 'adopt') return openSubForm({ ...it, id: null, origin: 'manual', adopt: true }, ctx);
    closeModal();
    if (act === 'dismiss') return subDismiss(it, ctx);
    if (act === 'restore') return subRestore(it, ctx);
    if (act === 'delete') return subDelete(it, ctx);
  });
}

// Detected variants of one merchant move together, so a state change touches every item with its key.
const subSameKey = (d, it) => {
  const all = SUB_GROUPS.flatMap((g) => d[g]);
  return it.origin === 'detected' && it.merchant_key ? all.filter((i) => i.origin === 'detected' && i.merchant_key === it.merchant_key) : all.filter((i) => i.key === it.key);
};
function subTake(d, items) {
  const keys = new Set(items.map((i) => i.key));
  for (const g of SUB_GROUPS) d[g] = d[g].filter((i) => !keys.has(i.key));
}

function subCancelledCopy(items, date) {
  const first = items[0];
  const many = items.length > 1;
  return { ...first, status: 'cancelled', cancelled_on: date, still_charging: false, variable: many ? false : first.variable, amount: many ? subSum(items) : first.amount, cadence: many ? 'monthly' : first.cadence, per_month: subSum(items) };
}

function openSubCancel(it, ctx) {
  const when = it.status === 'cancelled' ? it.cancelled_on : it.status === 'stopped' && it.last_date ? it.last_date : todayIso();
  const panel = openModal(`${sheetHead(it.status === 'cancelled' ? 'Change cancelled date' : 'Cancel subscription', it.name)}
    
    <form class="form" novalidate>
      <div class="field"><label for="scdate">Cancelled on</label><input id="scdate" name="date" type="date" max="${todayIso()}" value="${esc(when)}"></div>
      <button class="btn wide" type="submit">${I.check}${it.status === 'cancelled' ? 'Save date' : 'Cancel subscription'}</button>
    </form>`);
  const form = $('form', panel);
  const date = $('#scdate', form);
  const check = () => fieldError(date, !date.value ? 'Pick the date' : date.value > todayIso() ? 'It cannot be in the future' : '');
  date.addEventListener('input', check);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!check()) return;
    closeModal();
    subCancel(it, date.value, ctx);
  });
}

function subCancel(it, date, ctx) {
  const keep = ctx.data;
  const op = subIsDetected(it) ? { method: 'PUT', path: subDetectedPath(it.merchant_key), body: { status: 'cancelled', cancelled_on: date } }
    : { method: 'PATCH', path: `/api/subscriptions/${it.id}`, body: { status: 'cancelled', cancelled_on: date } };
  undoable({
    label: `${it.name} cancelled`,
    apply: () => {
      const d = structuredClone(ctx.data);
      const items = subSameKey(d, it);
      subTake(d, items);
      d.cancelled.unshift(subCancelledCopy(items.length ? items : [it], date));
      subRecalc(d);
      ctx.data = d;
      ctx.paint();
    },
    revert: () => { ctx.data = keep; ctx.paint(); },
    op,
  });
}

function subDismiss(it, ctx) {
  const keep = ctx.data;
  undoable({
    label: `${it.name} set aside as not a subscription`,
    apply: () => {
      const d = structuredClone(ctx.data);
      const items = subSameKey(d, it);
      subTake(d, items);
      d.dismissed.push({ ...(items[0] ?? it), status: 'dismissed', still_charging: false });
      subRecalc(d);
      ctx.data = d;
      ctx.paint();
    },
    revert: () => { ctx.data = keep; ctx.paint(); },
    op: { method: 'PUT', path: subDetectedPath(it.merchant_key), body: { status: 'dismissed' } },
  });
}

async function subRestore(it, ctx) {
  const keep = ctx.data;
  const d = structuredClone(ctx.data);
  subTake(d, [it]);
  d.active.push({ ...it, status: 'active', cancelled_on: null, still_charging: false, next_date: it.next_date || todayIso() });
  subRecalc(d);
  ctx.data = d;
  ctx.paint();
  const op = subIsDetected(it) ? { method: 'DELETE', path: subDetectedPath(it.merchant_key) } : { method: 'PATCH', path: `/api/subscriptions/${it.id}`, body: { status: 'active' } };
  try {
    const r = await mutate(op);
    toast(r.queued ? 'Saved offline, syncs when you are back' : `${it.name} is back on the list`);
    buzz(12);
    if (!r.queued) await ctx.load();
  } catch (e) {
    ctx.data = keep;
    ctx.paint();
    toast(`Couldn't put ${it.name} back: ${e.detail ?? e.message}`, { error: true, action: { label: 'Retry', fn: () => subRestore(it, ctx) } });
  }
}

function subDelete(it, ctx) {
  const keep = ctx.data;
  undoable({
    label: `${it.name} deleted`,
    apply: () => { const d = structuredClone(ctx.data); subTake(d, [it]); subRecalc(d); ctx.data = d; ctx.paint(); },
    revert: () => { ctx.data = keep; ctx.paint(); },
    op: { method: 'DELETE', path: `/api/subscriptions/${it.id}` },
  });
}

// Add by hand, edit one of the owner's, or adopt a "maybe" (prefilled, linked to its merchant so the detected one steps aside).
function openSubForm(it, ctx) {
  const editing = !!it?.id;
  const adopt = !!it?.adopt;
  const nextGuess = it?.next_date || isoOffset(todayIso(), 7);
  const panel = openModal(`${sheetHead(editing ? 'Edit subscription' : adopt ? 'Add as a subscription' : 'New subscription', editing || adopt ? it.name : 'Something you pay for on a schedule')}
    <form class="form" novalidate>
      <div class="field"><label for="sbname">Name</label><input id="sbname" name="name" maxlength="60" autocomplete="off" value="${esc(it?.name ?? '')}" ${editing ? '' : 'autofocus'}></div>
      <div class="two"><div class="field"><label for="sbamt">Amount</label><div class="money-in"><span>$</span><input id="sbamt" name="amount" inputmode="decimal" autocomplete="off" value="${centsToInput(it?.amount)}"></div></div>
        <div class="field"><label for="sbcad">How often</label><select id="sbcad" name="cadence">${SUB_CADENCES.map(([k, l]) => `<option value="${k}" ${k === (it?.cadence ?? 'monthly') ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="field"><label for="sbnext">Next charge</label><input id="sbnext" name="next" type="date" value="${esc(nextGuess)}"><div class="sub" id="sbper"></div></div>
      <button class="btn wide" type="submit">${I.check}${editing ? 'Save changes' : 'Add subscription'}</button>
    </form>`);
  const form = $('form', panel);
  const draftKey = `sub:${editing ? it.id : adopt ? it.merchant_key : 'new'}`;
  bindDraft(form, draftKey);
  const name = $('#sbname', form);
  const amt = $('#sbamt', form);
  const cad = $('#sbcad', form);
  const next = $('#sbnext', form);
  const check = () => {
    let ok = true;
    ok = fieldError(name, name.value.trim() ? '' : 'Give it a name') && ok;
    const c = parseMoney(amt.value);
    ok = fieldError(amt, !amt.value.trim() ? 'Enter the amount' : Number.isNaN(c) || c <= 0 ? 'An amount like 15 or 15.99' : '') && ok;
    ok = fieldError(next, next.value ? '' : 'Pick the next charge date') && ok;
    $('#sbper', form).textContent = Number.isFinite(c) && c > 0 ? `About ${money0(subPerMonth(c, cad.value))} a month` : '';
    return ok;
  };
  form.addEventListener('input', check);
  check();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!check()) return;
    const body = { name: name.value.trim(), amount: parseMoney(amt.value), cadence: cad.value, next_date: next.value };
    if (adopt) body.merchant_key = it.merchant_key;
    formError(form, null);
    const op = editing ? { method: 'PATCH', path: `/api/subscriptions/${it.id}`, body } : { method: 'POST', path: '/api/subscriptions', body };
    try {
      const r = await withBusy($('button[type=submit]', form), 'Saving', () => mutate(op));
      drafts.clear(draftKey);
      closeModal();
      if (r.queued) {
        const d = structuredClone(ctx.data);
        if (editing) Object.assign(subFind(d, it.key) ?? {}, body, { per_month: subPerMonth(body.amount, body.cadence) });
        else {
          if (adopt) subTake(d, subSameKey(d, it));
          d.active.push({ id: -Date.now(), key: `m:${-Date.now()}`, origin: 'manual', merchant_key: body.merchant_key ?? null, name: body.name, amount: body.amount, cadence: body.cadence, next_date: body.next_date, last_date: null, status: 'active', cancelled_on: null, variable: false, count: 0, still_charging: false, per_month: subPerMonth(body.amount, body.cadence) });
        }
        subRecalc(d);
        ctx.data = d;
        ctx.paint();
        toast('Saved offline, syncs when you are back');
      } else { toast(editing ? 'Subscription saved' : 'Subscription added'); buzz(12); await ctx.load(); }
    } catch (err) { formError(form, err, 'Save'); }
  });
}
