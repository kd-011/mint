// Transactions filters: one compact dropdown per filter, anchored under its
// chip. Category and account choices sit in named sections, so picking one is
// a tap or two rather than a scroll. The filter state itself (URL, API query,
// saved views) is unchanged: a dropdown only calls apply(nextFilters).
'use strict';

const FILTER_DROPDOWNS = [['account', 'Account'], ['category', 'Category'], ['dates', 'Dates'], ['direction', 'Money'], ['more', 'More']];
const DD_WIDE = 720; // from this viewport width the category sections sit side by side, all open

let ddOpen = null; // the open dropdown: { key, anchor, close, commit }

// The person dismisses the dropdown (tap outside, Escape, a second tap on its button, another dropdown opening):
// the half-made pick is applied. ddOpen is cleared before commit runs, so the commit can only ever run once.
function dismissDropdown(refocus = false) {
  const d = ddOpen;
  closeDropdown(refocus);
  d?.commit?.();
}

// Closes without applying. transactions.js calls this on teardown, from the render that a filter change triggers, so a
// pick applied there would be a stale snapshot written over the new filters. Pending picks are dropped on this path.
function closeDropdown(refocus = false) {
  const d = ddOpen;
  ddOpen = null;
  d?.close(refocus);
}

// Which dropdown buttons carry a filter right now (the button turns green).
function filterButtonsOn(f) {
  return {
    account: !!f.account,
    category: !!f.category,
    dates: !!(f.from || f.to),
    direction: !!f.direction,
    more: !!(f.business || f.tax || f.source),
  };
}

function filterBarHtml(f) {
  const on = filterButtonsOn(f);
  return FILTER_DROPDOWNS.map(([k, label]) => `<button class="fchip dd-b ${on[k] ? 'on' : ''}" type="button" data-dd="${k}" aria-haspopup="dialog" aria-expanded="false">${esc(label)}${I.chevDown}</button>`).join('');
}

// Clear all (a single tap) first, then one removable chip per active filter, in a row that scrolls sideways so the sticky bar stays short.
function filterSummaryHtml(f) {
  const all = filterChips(f);
  if (f.q) all.unshift(['q', `"${f.q}"`]);
  if (!all.length) return '';
  return `<button class="fchip clr" type="button" id="fclearall" title="Remove every filter and the search">${I.x}Clear all</button>${all.map(([k, label]) => `<button class="fchip act" type="button" data-rm="${k}" aria-label="Remove filter ${esc(label)}" title="Remove this filter">${esc(label)}${I.x}</button>`).join('')}`;
}

// the popover

function placeDropdown(pop, anchor, wide) {
  const vw = document.documentElement.clientWidth;
  const vh = innerHeight;
  const r = anchor.getBoundingClientRect();
  // A phone gets the full width under the buttons; a wider screen drops it under the button it came from.
  const w = vw < 480 ? vw - 16 : Math.min(wide ? 960 : 340, vw - 16);
  pop.style.width = `${w}px`;
  pop.style.left = `${vw < 480 ? 8 : Math.max(8, Math.min(r.left, vw - w - 8))}px`;
  const top = r.bottom + 6;
  pop.style.top = `${top}px`;
  pop.style.maxHeight = `${Math.max(220, vh - top - 12)}px`;
}

// commit: applies a half-made pick when the person dismisses the dropdown (see dismissDropdown).
function openDropdown(anchor, key, { title, html, wide = false, wire, commit }) {
  const again = ddOpen?.anchor === anchor;
  dismissDropdown(); // commits whatever was open first
  if (again) return null; // a second tap on the same button closes it, keeping any pick
  // That commit can re-render the screen, which replaces this anchor. Its filters are stale, so don't open on it; the next tap uses the fresh screen.
  if (!anchor.isConnected) return null;
  const pop = document.createElement('div');
  pop.className = `dd ${wide ? 'wide' : ''}`;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', title);
  pop.innerHTML = html;
  document.body.append(pop);
  anchor.setAttribute('aria-expanded', 'true');
  const place = () => placeDropdown(pop, anchor, wide);
  place();
  const onDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) dismissDropdown(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); dismissDropdown(true); } };
  // A phone's address bar fires resize while the person scrolls: move the popover, don't close it and lose the picks.
  const onResize = () => place();
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  addEventListener('scroll', place, { passive: true });
  addEventListener('resize', onResize);
  const close = (refocus) => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('scroll', place);
    removeEventListener('resize', onResize);
    anchor.setAttribute('aria-expanded', 'false');
    const done = () => pop.remove();
    if (reduceMotion.matches) done(); else { pop.classList.add('out'); setTimeout(done, 120); }
    if (refocus && anchor.isConnected) anchor.focus();
  };
  ddOpen = { key, anchor, close, commit };
  wire?.(pop);
  pop.querySelector('[autofocus-dd]')?.focus({ preventScroll: true });
  return pop;
}

// An option row. Reuses the category picker's row look.
const ddRow = (attr, value, label, { on = false, sub = '' } = {}) =>
  `<button class="crow ${on ? 'on' : ''}" type="button" role="option" aria-selected="${on}" data-${attr}="${esc(value)}"><span>${esc(label)}${sub ? `<small class="dd-sub">${esc(sub)}</small>` : ''}</span>${on ? I.check : ''}</button>`;

// each dropdown

function accountDropdown(anchor, f, apply) {
  const groups = UxModel.accountGroups(accountsData?.accounts ?? [], { selected: f.account, name: accountName });
  const body = groups.length
    ? `${ddRow('acct', '', 'All accounts', { on: !f.account })}${groups.map((g) => `<div class="cgroup">${esc(g.name)}</div>${g.items.map((a) => ddRow('acct', a.id, a.name, { on: a.id === f.account, sub: acctText(a.sub) })).join('')}`).join('')}`
    : `<p class="sub pad">No accounts yet. Connect a bank on the Accounts tab.</p>`;
  openDropdown(anchor, 'account', {
    title: 'Account', html: `<div class="dd-body" role="listbox" aria-label="Account">${body}</div>`,
    wire: (pop) => pop.addEventListener('click', (e) => {
      const b = e.target.closest('[data-acct]');
      if (!b) return;
      buzz(6);
      closeDropdown(true);
      apply({ ...f, account: b.dataset.acct || undefined });
    }),
  });
}

function categoryDropdown(anchor, f, apply) {
  const selected = f.category && f.category !== 'none' ? Number(f.category) : null;
  const wide = document.documentElement.clientWidth >= DD_WIDE;
  const have = !!categoriesData?.length;
  const html = `<div class="dd-head"><label class="search">${I.search}<input id="ddq" type="search" placeholder="Search categories" autocomplete="off" aria-label="Search categories" ${wide ? 'autofocus-dd' : ''}></label></div>
    <div class="dd-quick">${ddRow('cat', '', 'Any category', { on: !f.category })}${ddRow('cat', 'none', 'Uncategorised', { on: f.category === 'none' })}</div>
    <div class="dd-body" id="ddcats" role="listbox" aria-label="Category"></div>`;
  openDropdown(anchor, 'category', {
    title: 'Category', html, wide,
    wire: (pop) => {
      const box = $('#ddcats', pop);
      const flipped = new Set(); // sections the person tapped, against how they started
      const paint = (term = '') => {
        if (!have) {
          box.innerHTML = `<div class="error compact"><div class="h">Couldn't load the categories</div><div class="d">They load when you are online.</div><button class="btn ghost sm" type="button" id="ddretry">${I.refresh}Retry</button></div>`;
          return;
        }
        const groups = UxModel.categoryGroups(categoriesData, { term, selected });
        // Wide: every section open, side by side. Narrow: the section holding the pick (or every match) starts open.
        box.innerHTML = groups.length
          ? groups.map((g) => {
            const open = wide || g.open !== flipped.has(g.name);
            return `<section class="dgrp ${open ? 'open' : ''}"><button class="dgh" type="button" aria-expanded="${open}" data-g="${esc(g.name)}" ${wide ? 'tabindex="-1"' : ''}><span>${esc(g.name)}</span><small>${g.items.length}</small>${wide ? '' : I.chevDown}</button>
              <div class="dgi">${g.items.map((c) => ddRow('cat', c.id, c.name, { on: c.id === selected })).join('')}</div></section>`;
          }).join('')
          : `<p class="sub pad">No category matches "${esc(term)}".</p>`;
      };
      paint();
      $('#ddq', pop).addEventListener('input', (e) => { flipped.clear(); paint(e.target.value); });
      pop.addEventListener('click', async (e) => {
        if (e.target.closest('#ddretry')) {
          try { await loadCategories(); } catch (err) { toast(`Couldn't load categories: ${err.detail}`, { error: true }); }
          closeDropdown();
          return;
        }
        const h = e.target.closest('.dgh');
        if (h && !wide) {
          const g = h.dataset.g;
          if (!flipped.delete(g)) flipped.add(g);
          paint($('#ddq', pop).value);
          buzz(4);
          return;
        }
        const b = e.target.closest('[data-cat]');
        if (!b) return;
        buzz(6);
        closeDropdown(true);
        apply({ ...f, category: b.dataset.cat || undefined });
      });
    },
  });
}

function directionDropdown(anchor, f, apply) {
  const opts = [['', 'Any'], ['out', 'Money out'], ['in', 'Money in']];
  openDropdown(anchor, 'direction', {
    title: 'Money in or out', html: `<div class="dd-body" role="listbox" aria-label="Money in or out">${opts.map(([v, l]) => ddRow('dir', v, l, { on: (f.direction ?? '') === v })).join('')}</div>`,
    wire: (pop) => pop.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dir]');
      if (!b) return;
      buzz(6);
      closeDropdown(true);
      apply({ ...f, direction: b.dataset.dir || undefined });
    }),
  });
}

function datesDropdown(anchor, f, apply) {
  const t = todayIso();
  const monthStart = `${t.slice(0, 7)}-01`;
  const lastStart = `${addMonth(t.slice(0, 7), -1)}-01`;
  const fy = fyOfIso(t);
  const presets = [['This month', monthStart, t], ['Last month', lastStart, isoOffset(monthStart, -1)], ['Last 90 days', isoOffset(t, -90), t], [fyLabel(fy), `${fy - 1}-07-01`, `${fy}-06-30`]];
  const html = `<div class="dd-body"><form class="form" novalidate>
      <div class="chips wrap">${[['', '', 'Any time'], ...presets.map(([n, a, b]) => [`${a},${b}`, n, n])].map(([v, , n]) => `<button class="fchip ${v === `${f.from ?? ''},${f.to ?? ''}` || (!v && !f.from && !f.to) ? 'on' : ''}" type="button" data-range="${v}">${esc(n)}</button>`).join('')}</div>
      <div class="two"><div class="field"><label for="ffrom">From</label><input id="ffrom" type="date" name="from" value="${esc(f.from ?? '')}"></div><div class="field"><label for="fto">To</label><input id="fto" type="date" name="to" value="${esc(f.to ?? '')}"></div></div>
      <button class="btn wide" type="submit">Show results</button>
    </form></div>`;
  let done = false;
  let from;
  let to;
  openDropdown(anchor, 'dates', {
    title: 'Dates', html,
    wire: (pop) => {
      const form = $('form', pop);
      from = $('#ffrom', form);
      to = $('#fto', form);
      const check = () => fieldError(to, from.value && to.value && from.value > to.value ? 'The end date is before the start' : '');
      from.addEventListener('input', check);
      to.addEventListener('input', check);
      $$('[data-range]', form).forEach((b) => b.addEventListener('click', () => {
        buzz(6);
        const [a, z] = b.dataset.range ? b.dataset.range.split(',') : ['', ''];
        done = true;
        closeDropdown(true);
        apply({ ...f, from: a || undefined, to: z || undefined });
      }));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!check()) return;
        done = true;
        closeDropdown(true);
        apply({ ...f, from: from.value || undefined, to: to.value || undefined });
      });
    },
    commit: () => {
      if (done || !from || (from.value === (f.from ?? '') && to.value === (f.to ?? '')) || (from.value && to.value && from.value > to.value)) return;
      apply({ ...f, from: from.value || undefined, to: to.value || undefined });
    },
  });
}

// Counts as, deductible and filed by: three small choices, applied together.
function moreDropdown(anchor, f, apply) {
  const html = `<div class="dd-body"><form class="form" novalidate>
      <div class="field"><label>Counts as</label>${segmented('biz', [['', 'Any'], ['1', 'Business'], ['0', 'Personal']], f.business ?? '')}</div>
      <div class="field"><label>Deductible</label>${segmented('tax', [['', 'Any'], ['1', 'Tagged'], ['0', 'Not tagged']], f.tax ?? '')}</div>
      <div class="field"><label>Filed by</label>${segmented('src', [['', 'Any'], ['manual', 'You'], ['rule', 'Rule'], ['ai', 'Model'], ['provider', 'Bank']], f.source ?? '')}</div>
      <button class="btn wide" type="submit">Show results</button>
    </form></div>`;
  const next = { ...f };
  let done = false;
  openDropdown(anchor, 'more', {
    title: 'More filters', html,
    wire: (pop) => {
      const form = $('form', pop);
      wireSeg(form, 'biz', (v) => { next.business = v || undefined; });
      wireSeg(form, 'tax', (v) => { next.tax = v || undefined; });
      wireSeg(form, 'src', (v) => { next.source = v || undefined; });
      form.addEventListener('submit', (e) => { e.preventDefault(); done = true; closeDropdown(true); apply(next); });
    },
    commit: () => { if (!done && ['business', 'tax', 'source'].some((k) => next[k] !== f[k])) apply(next); },
  });
}

const FILTER_OPENERS = { account: accountDropdown, category: categoryDropdown, dates: datesDropdown, direction: directionDropdown, more: moreDropdown };
function openFilterDropdown(key, anchor, f, apply) { FILTER_OPENERS[key]?.(anchor, f, apply); }
