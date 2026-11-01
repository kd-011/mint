// Budgets run on the pay cycle: a target per category per cycle, fixed bills
// apart from flexible spend, progress with a pace marker, optional rollover,
// starter budgets Mint made from history (clearly marked, editable, and
// regenerable with undo). The cycle is in the URL (?cycle=YYYY-MM-DD, the
// cycle's first day); ?month=YYYY-MM is the read-only monthly roll-up that
// Reports links to.
'use strict';

const tone = (b) => (b.over ? 'over' : b.pct >= 90 ? 'hot' : b.pct >= 75 ? 'warm' : '');

// Tapping a budget opens its category: /budgets?cat=ID[&cycle=YYYY-MM-DD | &month=YYYY-MM],
// a screen of its own so Back, the address bar and the scroll position all work.
// budgetOpened remembers the list pushed it, so Back goes back rather than forward.
let budgetOpened = false;
function budgetHref(catId, { cycle = null, month = null } = {}) {
  const q = new URLSearchParams();
  if (month) q.set('month', month); else if (cycle) q.set('cycle', cycle);
  q.set('cat', String(catId));
  return `/budgets?${q}`;
}
function openBudgetCategory(catId, period) {
  budgetOpened = true;
  navigate(budgetHref(catId, period));
}

function budgetRow(b, cyc) {
  const st = paceStatus({ spent: b.spent, target: b.available, cycle: cyc });
  const words = st === 'ahead' || st === 'under' || st === 'on' ? paceWords({ spent: b.spent, target: b.available, cycle: cyc }) : '';
  const t = tone(b);
  const starter = b.source === 'starter' ? ' · <span class="tag-s" title="Made by Mint from your last pay cycles. Open it, then Edit budget, to change it.">Starter</span>' : '';
  return `<button class="row bud ${b.over ? 'over' : t}" type="button" data-bud="${b.category_id}">
    <div class="ic">${catIcon(b.name, b.group)}</div>
    <div class="main"><div class="t1">${esc(b.name)}${b.rollover ? ` <span class="chip" title="Unspent money carries to the next cycle">${I.repeat}Rollover</span>` : ''}</div>
      ${paceMeterHtml({ spent: b.spent, target: b.available, cycle: cyc, label: `${b.name} budget used`, tone: t })}
      <div class="t2"><span class="num">${esc(money(b.spent))}</span> of <span class="num">${esc(money(b.available))}</span>${b.carried ? ` (${esc(signed(b.carried))} carried)` : ''}${words ? ` · ${esc(words)}` : ''}${starter}</div></div>
    <div class="amt"><div class="num ${b.over ? 'neg-red' : ''}">${b.over ? esc(money(b.spent - b.available)) : esc(money(b.remaining))}</div><div class="t2">${b.over ? 'over' : 'left'}</div></div></button>`;
}

function budgetSection(title, items, cyc, totals) {
  if (!items.length) return '';
  return `<div class="sec-head"><h2>${esc(title)}</h2></div>
    <div class="rows stagger">${items.map((b) => budgetRow(b, cyc)).join('')}</div>`;
}

// Zero-based: Ready to assign is the figure that reads zero when every dollar of the cycle's pay has a job.
function readyCard(z) {
  const zero = z.state === 'zero';
  const lines = [['Income', z.income], ['Set aside by your pay split', z.set_aside], ['Assigned to budgets', z.assigned], ["Last cycle's overspend", z.carried_overspend.total]].filter(([k, v]) => v || k === 'Income' || k === 'Assigned to budgets');
  return `<section class="card month" id="ready">
      <div class="mtop"><div><div class="k">Ready to assign</div><div class="big2 num ${z.ready < 0 ? 'neg-red' : zero ? 'pos' : ''}">${esc(money(z.ready))}</div></div>
        ${zero ? `<span class="chip ok">${I.check}Every dollar has a job</span>` : ''}</div>
      ${lines.map(([k, v]) => `<div class="mline"><span>${esc(k)}</span><span class="num">${esc(money0(v))}</span></div>`).join('')}
    </section>
    ${z.state === 'unassigned' ? `<div class="nudge">${I.target}<div><b>Some of it has no job yet</b><small>Give it to a budget so none of it goes missing.</small></div><button class="btn sm" type="button" id="assignready">Assign</button></div>` : ''}
    ${z.state === 'over_assigned' ? `<div class="nudge bad">${I.alert}<div><b>Assigned more than this cycle brings in</b><small>${z.carried_overspend.total ? `Last cycle's overspend is taken off first (${esc(z.carried_overspend.items.map((o) => o.name).join(', '))}). ` : ''}Lower a budget below.</small></div></div>` : ''}
    ${z.overspent.count ? `<div class="nudge bad">${I.alert}<div><b>${esc(plural(z.overspent.count, 'budget'))} overspent by ${esc(money(z.overspent.total))}</b><small>${esc(z.overspent.items.map((o) => `${o.name} ${money(o.amount)}`).join(', '))}. It comes off next cycle: Ready to assign, or the category's own budget where it rolls over.</small></div></div>` : ''}`;
}

const cycleChips = (c) => `<span class="chip ${c.open ? 'ok' : ''}">${c.open ? `This cycle, day ${c.day} of ${c.days}` : 'Closed'}</span>${c.late ? `<span class="chip warn">Payday ${plural(c.days_late, 'day')} late</span>` : ''}`;

async function viewBudgets(el, token) {
  el.innerHTML = `${skeletonCard(130)}<h2>Flexible</h2>${skeletonRows(5)}`;
  applyDims(el);
  await loadCategories().catch(() => {});
  if (token !== renderToken) return;
  const p = new URLSearchParams(location.search);
  if (/^\d+$/.test(p.get('cat') ?? '')) return viewBudgetCategory(el, token, Number(p.get('cat')), p);
  if (/^\d{4}-\d{2}$/.test(p.get('month') ?? '')) return viewBudgetMonth(el, token, p.get('month'));

  let cycles = store.get('c:/api/cycles')?.d?.items ?? null;
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(p.get('cycle') ?? '') ? p.get('cycle') : null;
  let data = null;

  el.innerHTML = `<div class="mnav"><button class="x" type="button" id="cprev" aria-label="Previous pay cycle" title="Previous pay cycle">${I.back}</button><div class="mname" id="cname" aria-live="polite"><span class="sk sk-l"></span></div><button class="x" type="button" id="cnext" aria-label="Next pay cycle" title="Next pay cycle">${I.chevron}</button></div><div class="cchips" id="cchips"></div><div id="bud"></div>`;
  const box = $('#bud', el);
  const cur = () => cycles?.[cycles.length - 1];
  const pick = () => cycles?.find((c) => c.start === wanted) ?? cur();
  const go = (c) => { history.replaceState({}, '', c.start === cur().start ? '/budgets' : `/budgets?cycle=${c.start}`); render({ keepScroll: false }); };

  const head = () => {
    const c = pick();
    if (!c) return;
    const i = cycles.indexOf(c);
    $('#cname', el).textContent = cycleLabel(c);
    $('#cchips', el).innerHTML = cycleChips({ ...c, day: data?.cycle?.day ?? c.day, days: c.days });
    const prev = $('#cprev', el);
    const next = $('#cnext', el);
    prev.disabled = i <= 0;
    prev.title = i <= 0 ? 'No earlier pay cycles' : 'Previous pay cycle';
    next.disabled = i >= cycles.length - 1;
    next.title = next.disabled ? 'This is the current pay cycle' : 'Next pay cycle';
    prev.onclick = () => { buzz(6); go(cycles[i - 1]); };
    next.onclick = () => { buzz(6); go(cycles[i + 1]); };
  };

  const paint = () => {
    if (token !== renderToken || !data) return;
    const cyc = { ...data.cycle, open: data.cycle.open };
    const items = [...data.items].sort((a, b) => Number(b.over) - Number(a.over) || b.pct - a.pct);
    const fixed = items.filter((i) => i.fixed);
    const flex = items.filter((i) => !i.fixed);
    const t = data.totals;
    const left = t.flexible.available - t.flexible.spent;
    const starters = items.filter((i) => i.source === 'starter').length;
    const hideNote = store.get('starter-note');
    const unb = data.unbudgeted ?? [];
    box.innerHTML = `${data.zero_based ? readyCard(data.zero_based) : ''}${items.length ? `<section class="card month">
        <div class="k">${left >= 0 ? 'Flexible left' : 'Flexible over'}</div><div class="big2 num ${left < 0 ? 'neg-red' : 'pos'}" id="flexleft">${esc(money(Math.abs(left)))}</div>
        <div class="sub num">${esc(money(t.flexible.spent))} spent of ${esc(money0(t.flexible.available))}</div>
        ${paceMeterHtml({ spent: t.flexible.spent, target: t.flexible.available, cycle: cyc, label: 'Flexible budget used' })}
        <div class="mline"><span class="num">${esc(paceWords({ spent: t.flexible.spent, target: t.flexible.available, cycle: cyc }))}</span><span class="num">${cyc.open && cyc.days_left && left > 0 ? `${esc(money0(Math.round(left / cyc.days_left)))} a day` : ''}</span></div>
        ${t.fixed.target ? `<div class="mline"><span>Fixed bills</span><span class="num">${esc(money0(t.fixed.spent))} of ${esc(money0(t.fixed.target))}</span></div>` : ''}
      </section>
      ${starters && !hideNote ? `<div class="nudge soft">${I.leaf}<div><b>${plural(starters, 'starter budget')}</b></div><button class="x sm" type="button" id="hidenote" aria-label="Hide this note" title="Hide this note">${I.x}</button></div>` : ''}
      ${budgetSection('Flexible', flex, cyc, { spent: t.flexible.spent, target: t.flexible.target })}
      ${budgetSection('Fixed bills', fixed, cyc, t.fixed)}
      <div class="sec-head"><h2>Add</h2><button class="btn ghost sm" type="button" id="addbud">${I.plus}Add a budget</button></div>`
      : `<div class="card">${emptyState({ icon: I.target, title: 'No budgets yet', line: 'Pick a category and an amount per pay cycle.', button: { id: 'addbud', label: 'Add a budget', icon: I.plus } })}</div>`}
      ${unb.length ? `<h2>Spending with no budget</h2><div class="rows">${unb.map((c) => `<button class="row" type="button" data-unb="${c.category_id}"><div class="ic">${catIcon(c.name, c.group)}</div><div class="main"><div class="t1">${esc(c.name)}</div><div class="t2">${esc(c.group)}</div></div><div class="amt num">${esc(money(c.spent))}</div><span class="chip ok">${I.plus}Budget</span></button>`).join('')}</div>` : ''}
      <div class="regen"><button class="btn ghost wide" type="button" id="regen" ${online ? '' : 'disabled'} title="${online ? 'Redo the starter budgets from your last 6 cycles' : 'Needs a connection'}">${I.refresh}Regenerate starter budgets</button></div>
      <a class="lnk rollup" href="/budgets?month=${esc(todayIso().slice(0, 7))}" data-nav>Monthly roll-up</a>`;
    applyDims(box);
    const bigLeft = $('#flexleft', box);
    if (bigLeft) countUp(bigLeft, Math.abs(left), money, `budgets:flex${location.search}`);
    head();
    // "Add budget" from search lands here and opens the category picker once the screen has drawn.
    if (jumpIntent.take('add-budget')) setTimeout(() => $('#addbud', box)?.click(), 0);
  };

  const fail = (e) => {
    if (token !== renderToken) return;
    box.innerHTML = errorCard(e, 'budretry', 'budgets');
    $('#budretry', box)?.addEventListener('click', () => { started = null; box.innerHTML = skeleton(); applyDims(box); boot(); });
  };
  const skeleton = () => `${skeletonCard(130)}<h2>Flexible</h2>${skeletonRows(5)}`;
  const loadBudgets = () => {
    const c = pick();
    return swr(`/api/budgets?cycle=${c.start}`, (d) => { if (pick().start === c.start) { data = d; paint(); } }).catch(fail);
  };
  // The saved copy of everything paints at once (so a scroll position can be restored on Back);
  // the cycle list and the budgets then refresh behind it.
  let started = null;
  const start = () => {
    if (token !== renderToken) return;
    const c = pick();
    if (started === c.start) return;
    started = c.start;
    head();
    if (!store.get(`c:/api/budgets?cycle=${c.start}`)) { box.innerHTML = skeleton(); applyDims(box); }
    loadBudgets();
  };
  const boot = async () => {
    if (cycles?.length) start();
    try {
      await swr('/api/cycles', (d) => { cycles = d.items; if (!data && cycles.length) { head(); } });
    } catch (e) { if (!cycles?.length) return fail(e); }
    if (token !== renderToken) return;
    if (!cycles?.length) { box.innerHTML = `<div class="card">${emptyState({ icon: I.calendar, title: 'No pay cycles yet', line: 'Starts with your first salary deposit.', action: { href: '/income', label: 'See income' } })}</div>`; $('#cname', el).textContent = 'No pay cycle yet'; return; }
    start();
  };
  head();
  if (!cycles) { box.innerHTML = skeleton(); applyDims(box); }
  boot();

  // What the shared budget sheet needs from this screen.
  const hooks = {
    reload: () => loadBudgets(),
    queued: (catId, body) => {
      const row = data.items.find((i) => i.category_id === catId);
      if (!row) return;
      const was = row.target;
      Object.assign(row, { target: body.cycle_target, available: body.cycle_target + row.carried, rollover: body.rollover, fixed: body.fixed, source: 'manual' });
      row.remaining = row.available - row.spent;
      row.pct = row.available > 0 ? Math.round((row.spent / row.available) * 100) : 0;
      row.over = row.spent > row.available;
      data.zero_based = zeroAfterEdit(data.zero_based, was, body.cycle_target);
      paint();
    },
    remove: (catId, name) => {
      const keep = data;
      undoable({
        label: `${name} budget deleted`,
        apply: () => { data = { ...data, items: data.items.filter((i) => i.category_id !== catId), zero_based: zeroAfterEdit(data.zero_based, keep.items.find((i) => i.category_id === catId)?.target, null) }; paint(); },
        revert: () => { data = keep; paint(); },
        op: { method: 'DELETE', path: `/api/budgets/${catId}` },
      });
    },
  };

  box.addEventListener('click', async (e) => {
    if (e.target.closest('#hidenote')) { store.set('starter-note', true); paint(); return; }
    if (e.target.closest('#regen')) return regenerate();
    if (e.target.closest('#assignready')) return assignReady();
    if (e.target.closest('#addbud')) {
      const have = new Set((data?.items ?? []).map((i) => i.category_id));
      const id = await pickCategory({ title: 'Budget for', kinds: ['expense'], allowNew: true });
      if (id == null) return;
      if (have.has(id)) { toast(`${catName(id)} already has a budget`, { error: true }); return; }
      openBudgetEditor(id, null, null, hooks);
      return;
    }
    const b = e.target.closest('[data-bud]');
    if (b) { buzz(6); openBudgetCategory(Number(b.dataset.bud), { cycle: pick().start === cur()?.start ? null : pick().start }); return; }
    const u = e.target.closest('[data-unb]');
    if (u) {
      const row = data.unbudgeted.find((c) => c.category_id === Number(u.dataset.unb));
      openBudgetEditor(Number(u.dataset.unb), null, Math.ceil(row.spent / 1000) * 1000, hooks);
    }
  });

  // Assign what is left: pick a budget (or a category with spending and none), and the editor opens
  // with the target already raised by Ready to assign. The server does the sums when it is saved.
  function assignReady() {
    const z = data.zero_based;
    const rows = [...data.items].sort((a, b) => Number(b.over) - Number(a.over) || b.pct - a.pct);
    const unb = data.unbudgeted ?? [];
    const open = (id) => {
      closeModal();
      const row = data.items.find((i) => i.category_id === id);
      openBudgetEditor(id, row ? { ...row, target: row.target + z.ready } : null, row ? null : z.ready, hooks);
    };
    const panel = openModal(`${sheetHead(`Assign ${money(z.ready)}`, 'Pick where it goes')}
      <div class="rows">${rows.map((b) => `<button class="row" type="button" data-pick="${b.category_id}"><div class="ic">${catIcon(b.name, b.group)}</div><div class="main"><div class="t1">${esc(b.name)}</div><div class="t2 num">${b.over ? `${esc(money(b.spent - b.available))} over` : `${esc(money0(b.target))} a cycle`}</div></div></button>`).join('')}
        ${unb.map((c) => `<button class="row" type="button" data-pick="${c.category_id}"><div class="ic">${catIcon(c.name, c.group)}</div><div class="main"><div class="t1">${esc(c.name)}</div><div class="t2 num">${esc(money0(c.spent))} spent, no budget</div></div></button>`).join('')}</div>
      <div class="sticky-actions"><button class="btn ghost" type="button" id="pickother">${I.plus}Another category</button><button class="btn ghost" type="button" data-close>Cancel</button></div>`);
    panel.addEventListener('click', async (e) => {
      const r = e.target.closest('[data-pick]');
      if (r) { buzz(6); open(Number(r.dataset.pick)); return; }
      if (e.target.closest('#pickother')) {
        closeModal();
        const have = new Set(data.items.map((i) => i.category_id));
        const id = await pickCategory({ title: 'Budget for', kinds: ['expense'], allowNew: true });
        if (id == null) return;
        if (have.has(id)) { toast(`${catName(id)} already has a budget`, { error: true }); return; }
        openBudgetEditor(id, null, z.ready, hooks);
      }
    });
  }

  // Regenerate: preview on the server (nothing written), confirm, apply, offer undo.
  async function regenerate() {
    const btn = $('#regen', box);
    let preview;
    try { preview = await withBusy(btn, 'Working out starter budgets from your last 6 cycles', () => api('/api/budgets/starter', { method: 'POST', body: { dry_run: true, replace: 'starter' } })); } catch (err) {
      toast(`Couldn't work out starter budgets: ${err.detail ?? err.message}`, { error: true, action: { label: 'Retry', fn: regenerate } });
      return;
    }
    const changed = preview.created.filter((c) => !c.before || c.before.cycle_target !== c.cycle_target || c.before.fixed !== c.fixed);
    const kept = preview.skipped.filter((s) => /hand/.test(s.reason)).length;
    const panel = openModal(`${sheetHead('Starter budgets', 'Regenerate from history')}
      ${preview.reason ? `<p class="sub pad">${esc(moneyText(preview.reason[0].toUpperCase() + preview.reason.slice(1)))}.</p>` : changed.length ? `<p class="sub">From your last ${plural(preview.cycles_used, 'complete pay cycle')}. ${kept ? `${plural(kept, 'budget')} you set yourself stay as they are.` : ''}</p>
        <div class="rows regen-list">${changed.map((c) => `<div class="row"><div class="main"><div class="t1">${esc(c.name)}${c.before ? '' : ' <span class="chip ok">New</span>'}</div><div class="t2 num">${c.before ? `${esc(money0(c.before.cycle_target))} to ${esc(money0(c.cycle_target))}` : `${esc(money0(c.cycle_target))} a cycle`}</div></div></div>`).join('')}</div>`
        : `<div class="empty small">${I.check}<p>Your starter budgets already match your history. Nothing to change.</p></div>`}
      <div class="sticky-actions">${changed.length ? `<button class="btn danger" type="button" id="regen-go">${I.refresh}Apply ${plural(changed.length, 'change')}</button>` : ''}<button class="btn ghost" type="button" data-close>${changed.length ? 'Cancel' : 'Close'}</button></div>`);
    $('#regen-go', panel)?.addEventListener('click', async (ev) => {
      let r;
      try { r = await withBusy(ev.currentTarget, 'Applying', () => api('/api/budgets/starter', { method: 'POST', body: { replace: 'starter' } })); } catch (err) {
        formError($('.sticky-actions', panel).parentElement, err, 'Replace');
        return;
      }
      closeModal();
      buzz(14);
      const done = r.created;
      await loadBudgets();
      toast(`${plural(done.length, 'starter budget')} regenerated`, { ms: 7000, action: { label: 'Undo', fn: () => undoRegenerate(done) } });
    });
  }
  async function undoRegenerate(done) {
    try {
      for (const c of done) {
        if (!c.before) await mutate({ method: 'DELETE', path: `/api/budgets/${c.category_id}` });
        else await mutate({ method: 'PUT', path: `/api/budgets/${c.category_id}`, body: { cycle_target: c.before.cycle_target, fixed: c.before.fixed, rollover: c.before.rollover, source: c.before.source } });
      }
      toast('Starter budgets put back');
      buzz(10);
      await loadBudgets();
    } catch (err) { toast(`Couldn't put them back: ${err.detail ?? err.message}`, { error: true, action: { label: 'Retry', fn: () => undoRegenerate(done) } }); }
  }
}

// The budget sheet. `hooks` is what differs between the list and a category's detail:
// reload() redraws from the server, queued(catId, body) patches the screen when the save
// went into the offline queue, remove(catId, name) deletes with undo.
function openBudgetEditor(catId, existing, suggest, hooks) {
  const name = catName(catId) || existing?.name || 'Category';
  const panel = openModal(`${sheetHead(existing ? 'Edit budget' : 'New budget', name)}
    <form class="form" novalidate>
      <div class="field"><label for="btarget">Target per pay cycle</label><div class="money-in"><span>$</span><input id="btarget" name="target" inputmode="decimal" autocomplete="off" value="${existing ? centsToInput(existing.target) : suggest ? centsToInput(suggest) : ''}" ${existing ? '' : 'autofocus'}></div><div class="sub" id="bmonthly"></div></div>
      <div class="field row-field"><label id="fixlab">A fixed bill</label>${switchHtml('data-fix', 'f', existing?.fixed, 'A fixed bill', 'Fixed bills are paid on a schedule and sit outside flexible spend')}</div>
      <div class="field row-field"><label id="rolllab">Roll unspent money over</label>${switchHtml('data-roll', 'r', existing?.rollover, 'Roll unspent money over', 'Unspent money (or overspend) carries into the next cycle')}</div>
      <button class="btn wide" type="submit">${I.check}${existing ? 'Save budget' : 'Add budget'}</button>
      ${existing ? `<button class="btn danger wide" type="button" id="buddel">${I.trash}Delete budget</button>` : ''}
    </form>`);
  const form = $('form', panel);
  bindDraft(form, `budget:${catId}`, { skip: [] });
  const input = $('#btarget', form);
  const monthly = $('#bmonthly', form);
  const sws = $$('.switch', form);
  sws.forEach((sw) => sw.addEventListener('click', () => { sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true')); buzz(6); }));
  const check = () => {
    const c = parseMoney(input.value);
    monthly.textContent = Number.isFinite(c) && c > 0 ? `About ${money0(Math.round((c * 26) / 12))} a month` : '';
    if (!input.value.trim()) return fieldError(input, 'Enter an amount per pay cycle');
    if (Number.isNaN(c)) return fieldError(input, 'Enter an amount like 450 or 450.50');
    if (c < 0) return fieldError(input, 'Cannot be negative');
    return fieldError(input, '');
  };
  input.addEventListener('input', check);
  check();
  if (!existing && !input.value) fieldError(input, '');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!check()) return;
    const body = { cycle_target: parseMoney(input.value), fixed: $('[data-fix]', form).getAttribute('aria-checked') === 'true', rollover: $('[data-roll]', form).getAttribute('aria-checked') === 'true' };
    formError(form, null);
    const btn = $('button[type=submit]', form);
    try {
      const r = await withBusy(btn, 'Saving', () => mutate({ method: 'PUT', path: `/api/budgets/${catId}`, body }));
      drafts.clear(`budget:${catId}`);
      closeModal();
      if (r.queued) {
        hooks.queued(catId, body);
        toast('Saved offline, syncs when you are back');
      } else { toast(existing ? 'Budget saved' : 'Budget added'); buzz(12); await hooks.reload(); }
    } catch (err) { formError(form, err, 'Save'); }
  });
  $('#buddel', form)?.addEventListener('click', () => {
    closeModal();
    hooks.remove(catId, name);
  });
}

// ?month=YYYY-MM: the calendar-month roll-up, read only. A cycle target is
// shown x 26 / 12 as a month's worth.
async function viewBudgetMonth(el, token, month) {
  const cur = todayIso().slice(0, 7);
  let data = null;
  el.innerHTML = `<a class="btn ghost sm mback" href="/budgets" data-nav>${I.back}Pay cycle budgets</a>
    <div class="mnav"><button class="x" type="button" id="mprev" aria-label="Previous month" title="Previous month">${I.back}</button><div class="mname" id="mname" aria-live="polite"></div><button class="x" type="button" id="mnext" aria-label="Next month" title="Next month">${I.chevron}</button></div><div id="bud"></div>`;
  const box = $('#bud', el);
  const go = (m) => { history.replaceState({}, '', `/budgets?month=${m}`); render({ keepScroll: false }); };
  $('#mprev', el).addEventListener('click', () => { buzz(6); go(addMonth(month, -1)); });
  $('#mnext', el).addEventListener('click', () => { buzz(6); go(addMonth(month, 1)); });
  $('#mnext', el).disabled = month >= cur;
  $('#mnext', el).title = month >= cur ? 'No later months' : 'Next month';
  $('#mname', el).textContent = month === cur ? `${monthLabel(month)} · this month` : monthLabel(month);
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bud]');
    if (b) { buzz(6); openBudgetCategory(Number(b.dataset.bud), { month }); }
  });
  const paint = () => {
    if (token !== renderToken || !data) return;
    const items = [...data.items].sort((a, b) => b.pct - a.pct);
    if (!items.length) { box.innerHTML = `<div class="card">${emptyState({ icon: I.target, title: 'No budgets', line: 'Nothing is budgeted yet.', action: { href: '/budgets', label: 'Open budgets' } })}</div>`; return; }
    const left = data.totals.target - data.totals.spent;
    box.innerHTML = `<section class="card month"><div class="mtop"><div><div class="k">Spent of ${esc(money0(data.totals.target))}</div><div class="big2 num">${esc(money(data.totals.spent))}</div></div>
        <div class="mr"><div class="k">${left >= 0 ? 'Left' : 'Over'}</div><div class="v num ${left < 0 ? 'neg-red' : 'pos'}">${esc(money(Math.abs(left)))}</div></div></div>
        <div class="meter ${data.totals.spent > data.totals.target ? 'over' : ''}"><i data-w="${data.totals.target > 0 ? Math.min(100, Math.round((data.totals.spent / data.totals.target) * 100)) : 0}"></i></div></section>
      <div class="sec-head"><h2>By category</h2></div>
      <div class="rows stagger">${items.map((b) => `<button class="row bud ${b.over ? 'over' : tone(b)}" type="button" data-bud="${b.category_id}"><div class="ic">${catIcon(b.name, b.group)}</div><div class="main"><div class="t1">${esc(b.name)}</div><div class="meter ${tone(b)}"><i data-w="${Math.min(100, b.pct)}"></i></div><div class="t2"><span class="num">${esc(money(b.spent))}</span> of <span class="num">${esc(money(b.available))}</span></div></div><div class="amt"><div class="num ${b.over ? 'neg-red' : ''}">${b.over ? esc(money(b.spent - b.available)) : esc(money(b.remaining))}</div><div class="t2">${b.over ? 'over' : 'left'}</div></div></button>`).join('')}</div>`;
    applyDims(box);
  };
  const load = () => swr(`/api/budgets?month=${month}`, (d) => { data = d; paint(); }).catch((e) => {
    if (token !== renderToken) return;
    box.innerHTML = errorCard(e, 'budretry', 'the monthly roll-up');
    $('#budretry', box)?.addEventListener('click', () => { box.innerHTML = skeletonRows(5); load(); });
  });
  if (!store.get(`c:/api/budgets?month=${month}`)) { box.innerHTML = `${skeletonCard(110)}<h2>By category</h2>${skeletonRows(5)}`; applyDims(box); }
  load();
}

// ?cat=ID: one budget's category for a pay cycle (?cycle=YYYY-MM-DD, the current one
// by default) or a calendar month (?month=YYYY-MM). The header is the budget (spent of
// target, pace, an Edit budget button), then the transactions that make up the spent
// figure, drawn like the Transactions list. For the Subscriptions category the
// subscriptions list sits above them. Back goes back to the list at the same place.
async function viewBudgetCategory(el, token, catId, p) {
  await loadCategories().catch(() => {});
  if (token !== renderToken) return;
  const month = /^\d{4}-\d{2}$/.test(p.get('month') ?? '') ? p.get('month') : null;
  const wanted = !month && /^\d{4}-\d{2}-\d{2}$/.test(p.get('cycle') ?? '') ? p.get('cycle') : null;
  const CHUNK = 100;
  let cycles = month ? [] : (store.get('c:/api/cycles')?.d?.items ?? null);
  let data = null;
  let shown = CHUNK;
  const cur = () => cycles?.[cycles.length - 1];
  const pick = () => cycles?.find((c) => c.start === wanted) ?? cur();
  const listHref = () => (month ? `/budgets?month=${month}` : wanted ? `/budgets?cycle=${wanted}` : '/budgets');
  const pathFor = () => {
    const base = `/api/budgets/${catId}/transactions`;
    if (month) return `${base}?month=${month}`;
    const c = pick();
    return c && c.start !== cur().start ? `${base}?cycle=${c.start}` : base;
  };
  const name = () => catName(catId) || data?.category?.name || 'Category';

  el.innerHTML = `<button class="btn ghost sm mback" type="button" id="bback">${I.back}Budgets</button>
    <div class="mnav"><button class="x" type="button" id="pprev" aria-label="Earlier" title="Earlier">${I.back}</button><div class="mname" id="pname" aria-live="polite"><span class="sk sk-l"></span></div><button class="x" type="button" id="pnext" aria-label="Later" title="Later">${I.chevron}</button></div>
    <div id="bsum"></div><div id="bsubs"></div><div id="btx"></div>`;
  const sum = $('#bsum', el);
  const tx = $('#btx', el);
  wireLogoTiles(tx);
  $('#bback', el).addEventListener('click', () => {
    if (budgetOpened) { budgetOpened = false; history.back(); } else navigate(listHref());
  });

  const periodNav = () => {
    const prev = $('#pprev', el);
    const next = $('#pnext', el);
    if (month) {
      const now = todayIso().slice(0, 7);
      $('#pname', el).textContent = month === now ? `${monthLabel(month)} · this month` : monthLabel(month);
      prev.title = 'Previous month'; next.title = month >= now ? 'No later months' : 'Next month';
      next.disabled = month >= now;
      prev.onclick = () => { buzz(6); history.replaceState({}, '', budgetHref(catId, { month: addMonth(month, -1) })); render({ keepScroll: false }); };
      next.onclick = () => { buzz(6); history.replaceState({}, '', budgetHref(catId, { month: addMonth(month, 1) })); render({ keepScroll: false }); };
      return;
    }
    const c = pick();
    if (!c) { $('#pname', el).textContent = data?.month ? monthLabel(data.month) : 'This month'; prev.disabled = true; next.disabled = true; return; }
    const i = cycles.indexOf(c);
    $('#pname', el).textContent = cycleLabel(c);
    prev.disabled = i <= 0;
    prev.title = i <= 0 ? 'No earlier pay cycles' : 'Previous pay cycle';
    next.disabled = i >= cycles.length - 1;
    next.title = next.disabled ? 'This is the current pay cycle' : 'Next pay cycle';
    const go = (t) => { history.replaceState({}, '', budgetHref(catId, { cycle: t.start === cur().start ? null : t.start })); render({ keepScroll: false }); };
    prev.onclick = () => { buzz(6); go(cycles[i - 1]); };
    next.onclick = () => { buzz(6); go(cycles[i + 1]); };
  };

  const hooks = {
    reload: () => load(),
    queued: (id, body) => {
      const b = data?.budget;
      if (!b) { load(); return; }
      Object.assign(b, budgetAfterEdit(b, data.basis, body));
      paint();
    },
    remove: (id, nm) => {
      const keep = data;
      undoable({
        label: `${nm} budget deleted`,
        apply: () => { data = { ...data, budget: null }; paint(); },
        revert: () => { data = keep; paint(); },
        op: { method: 'DELETE', path: `/api/budgets/${id}` },
      });
    },
  };

  const header = () => {
    const b = data.budget;
    const cyc = data.cycle;
    if (!b) {
      return `<section class="card month"><div class="mtop"><div><div class="k">${esc(name())} spent</div><div class="big2 num">${esc(money(data.spent))}</div></div></div>
        <div class="mline"><span>No budget for this category yet.</span></div>
        <button class="btn" type="button" id="bedit">${I.plus}Add a budget</button></section>`;
    }
    const left = b.available - b.spent;
    const meter = cyc
      ? paceMeterHtml({ spent: b.spent, target: b.available, cycle: cyc, label: `${name()} budget used`, tone: tone(b) })
      : `<div class="meter ${tone(b)}"><i data-w="${Math.min(100, b.pct)}"></i></div>`;
    const words = cyc ? paceWords({ spent: b.spent, target: b.available, cycle: cyc }) : '';
    return `<section class="card month">
      <div class="mtop"><div><div class="k">${esc(name())}, spent of ${esc(money0(b.available))}</div><div class="big2 num">${esc(money(b.spent))}</div></div>
        <div class="mr"><div class="k">${left >= 0 ? 'Left' : 'Over'}</div><div class="v num ${left < 0 ? 'neg-red' : 'pos'}">${esc(money(Math.abs(left)))}</div></div></div>
      ${meter}
      <div class="mline"><span class="num">${esc(words)}</span><span class="num">${b.carried ? `${esc(signed(b.carried))} carried` : ''}</span></div>
      <button class="btn ghost" type="button" id="bedit">${I.edit}Edit budget</button></section>`;
  };

  const txList = () => {
    const items = data.items;
    if (!items.length) {
      return `<div class="sec-head"><h2>Transactions</h2></div><div class="card">${emptyState({ icon: I.list, title: 'Nothing spent here', line: `No ${name()} spending in ${month ? monthLabel(month) : cycleLabel({ start: data.from, end: data.to })}.`, action: { href: '/transactions', label: 'See all transactions' } })}</div>`;
    }
    const visible = items.slice(0, shown);
    const days = [];
    for (const t of visible) {
      if (days.at(-1)?.day !== t.date) days.push({ day: t.date, rows: [] });
      days.at(-1).rows.push(t);
    }
    const note = data.net < 0 ? `<p class="sub pad">Refunds exceed spend, counted as ${esc(money(0))}</p>` : '';
    return `<div class="sec-head"><h2>Transactions</h2><span class="sub num">${esc(plural(data.count, 'transaction'))} · ${esc(money(data.net))}</span></div>
      ${days.map((d) => `<div class="dayhd"><span>${esc(dayLabel(d.day))}</span><span class="num">${esc(signed(d.rows.reduce((s, t) => s + t.amount, 0)))}</span></div><div class="rows" role="list">${d.rows.map((t) => txRowButton(t)).join('')}</div>`).join('')}
      ${items.length > shown ? `<button class="btn ghost wide mt10" type="button" id="bmore">Show ${Math.min(CHUNK, items.length - shown)} more</button>` : ''}
      ${data.truncated ? `<p class="sub pad">Latest ${items.length} of ${data.count}</p>` : ''}
      ${note}`;
  };

  function paint() {
    if (token !== renderToken || !data) return;
    sum.innerHTML = header();
    tx.innerHTML = txList();
    applyDims(el);
    periodNav();
  }
  const fail = (e) => {
    if (token !== renderToken) return;
    sum.innerHTML = errorCard(e, 'catretry', `${name()} transactions`);
    $('#catretry', sum)?.addEventListener('click', () => { sum.innerHTML = skeletonCard(150); tx.innerHTML = skeletonRows(6); applyDims(el); boot(); });
  };
  let loadedPath = null;
  function load() {
    loadedPath = pathFor();
    return swr(pathFor(), (d) => { data = d; paint(); }).catch((e) => { if (!data) fail(e); else toast(`Showing saved transactions: ${e.detail ?? e.message}`, { error: true }); });
  }
  async function boot() {
    const begin = () => {
      periodNav();
      if (!store.get(`c:${pathFor()}`)) { sum.innerHTML = skeletonCard(150); tx.innerHTML = `<div class="sec-head"><h2>Transactions</h2></div>${skeletonRows(6)}`; applyDims(el); }
      return load();
    };
    // Saved copies paint at once; the cycle list and the transactions refresh behind them.
    let first = null;
    if (month || cycles?.length) first = begin();
    if (!month) {
      try { await swr('/api/cycles', (d) => { cycles = d.items; periodNav(); }); } catch (e) { if (!cycles?.length) return fail(e); }
      if (token !== renderToken) return;
      if (!first || pathFor() !== loadedPath) first = begin();
    }
    await first;
  }
  el.addEventListener('click', (e) => {
    if (e.target.closest('#bedit')) { openBudgetEditor(catId, budgetForEditor(data.budget, data.basis), null, hooks); return; }
    if (e.target.closest('#bmore')) { shown += CHUNK; paint(); return; }
    const row = e.target.closest('[data-tx]');
    if (row && tx.contains(row)) {
      const t = data.items.find((x) => x.id === row.dataset.tx);
      if (t) openTx(t);
    }
  });
  // A category change from the sheet moves the row out of here: reload.
  const onTxChanged = () => { if (data) load(); };
  document.addEventListener('mint:txchanged', onTxChanged);
  cleanup.push(() => document.removeEventListener('mint:txchanged', onTxChanged));

  if (name() === 'Subscriptions') subsSection($('#bsubs', el), token, { embedded: true });
  boot();
}
