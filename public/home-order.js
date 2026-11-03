// Edit order on Home's Accounts block. the owner sets the order of the rows within each
// section (Cash, Cards, Loans, Investments, Debts); the section grouping never changes.
// Touch or mouse: drag the handle. Everyone else: the up and down buttons (the handle is
// hidden from assistive tech, the buttons are the accessible way). Every change applies at
// once, saves a moment later as one PUT /api/home/order of the whole list (idempotent, so a
// replayed offline write is harmless), and says what happened inline: saving, saved, or the
// real error with a retry. A saved order offers a 5 second Undo. A refused save rolls back.
// The scripts share one global scope, so every top-level name here starts with `ho`.
'use strict';

const HO_SAVE_DELAY = 600;
const HO_SLOW_MS = 4000;
const hoReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const hoIds = (root) => $$('.ro[data-id]', root).map((r) => r.dataset.id);

// Run `change`, then slide every row from where it was to where it is (skipped for reduced motion).
function hoFlip(root, change) {
  const before = new Map($$('.ro[data-id]', root).map((r) => [r.dataset.id, r.getBoundingClientRect().top]));
  change();
  if (hoReduced()) return;
  for (const r of $$('.ro[data-id]', root)) {
    const from = before.get(r.dataset.id);
    if (from == null || r.classList.contains('drag')) continue;
    const d = from - r.getBoundingClientRect().top;
    if (d) r.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.16,1,.3,1)' });
  }
}

// After a drop the rows moved but were not redrawn: bring each button's disabled state and title in line.
function hoSyncEdges(root) {
  for (const sec of $$('.ro-sec', root)) {
    const rows = $$('.ro', sec);
    rows.forEach((r, i) => {
      for (const [dir, edge, word] of [[-1, i === 0, 'up'], [1, i === rows.length - 1, 'down']]) {
        const b = $(`[data-move="${dir}"]`, r);
        if (!b) continue;
        b.disabled = edge;
        b.title = edge ? `Already ${dir < 0 ? 'first' : 'last'} in ${sec.dataset.label}` : `Move ${word}`;
      }
    });
  }
}

// One row in order mode: handle, the row's own tile and name, up and down.
function hoRowHtml(r, tile, { first, last }) {
  const nm = esc(r.name);
  const mv = (dir, icon, edge, word) => `<button type="button" class="ro-b" data-move="${dir}" aria-label="Move ${nm} ${word}" title="${edge ? `Already ${dir < 0 ? 'first' : 'last'} in ${esc(r.section)}` : `Move ${word}`}" ${edge ? 'disabled' : ''}>${icon}</button>`;
  return `<div class="row ro" data-id="${esc(r.id)}"><span class="ro-grip" data-grip aria-hidden="true">${I.grip}</span>${tile}<div class="main"><div class="t1">${nm}</div>${r.sub ? `<div class="t2">${esc(acctText(r.sub))}</div>` : ''}</div><div class="ro-mv">${mv(-1, I.up, first, 'up')}${mv(1, I.down, last, 'down')}</div></div>`;
}

// The line under the Accounts heading while ordering: what to do, then what is happening.
function hoNoteHtml(st) {
  if (st.status === 'saving') return `<span class="spin" aria-hidden="true"></span><span>${st.slow ? 'Still saving, the server may be cold-starting' : 'Saving the new order'}</span>`;
  if (st.status === 'saved') return `${I.tick}<span>${st.offline ? 'Saved on this device, syncs when you are back' : 'Order saved'}</span>`;
  if (st.status === 'error') return `${I.alert}<span class="ro-err"><b>Couldn't save the order</b><small>${esc(st.err ?? '')}</small></span><button type="button" class="ro-retry" data-retry>Retry</button>`;
  return `<span>Drag the handle or use the arrows. Changes save as you go.</span>`;
}

// Wire the Accounts slot. getList() is the current UxModel.accountRows; applyLocal(ids) puts an order on the
// data the page holds (and its saved copies); repaint() redraws the block. Returns the state accountsBlock reads.
function hoMount(box, { getList, applyLocal, repaint, alive }) {
  const st = { on: false, status: 'idle', err: null, offline: false, slow: false, failed: null };
  let timer = 0;
  let saving = 0;
  let hold = 0; // a refresh asked for before our PUT landed can arrive after it; keep the local order until this time
  let prev = null; // the order before the first unsaved change
  let chain = Promise.resolve();

  const note = () => { const n = $('.ro-note', box); if (n) n.innerHTML = hoNoteHtml(st); };
  const current = () => hoIds(box).length ? hoIds(box) : UxModel.orderIds(getList());

  function save(ids, before) {
    chain = chain.then(async () => {
      saving += 1;
      st.status = 'saving'; st.slow = false; st.err = null; st.failed = null; note();
      const slow = setTimeout(() => { st.slow = true; note(); }, HO_SLOW_MS);
      try {
        const r = await mutate({ method: 'PUT', path: '/api/home/order', body: { ids } }, { retries: 2 });
        st.status = 'saved'; st.offline = r.queued;
        if (alive()) {
          note();
          toast(r.queued ? 'Order saved offline, syncs when you are back' : 'Order saved', { ms: 5200, action: before ? { label: 'Undo', fn: () => change(before) } : null });
          buzz(10);
        }
      } catch (e) {
        applyLocal(before ?? ids);
        st.status = 'error'; st.err = e.detail ?? e.message ?? String(e); st.failed = ids;
        if (alive()) { repaint(); buzz([20, 40, 20]); }
      } finally { clearTimeout(slow); saving -= 1; hold = Date.now() + 10_000; }
    });
    return chain;
  }

  const flush = () => {
    if (!timer) return Promise.resolve();
    clearTimeout(timer);
    timer = 0;
    const before = prev;
    prev = null;
    return save(current(), before);
  };

  // Put `ids` on screen now (optimistic) and schedule the save.
  function change(ids) {
    prev ??= current();
    applyLocal(ids);
    st.status = 'idle';
    hoFlip(box, repaint);
    clearTimeout(timer);
    timer = setTimeout(flush, HO_SAVE_DELAY);
  }

  const secIds = (sec) => hoIds(sec);
  const withSection = (sec, nextSec) => current().map((id) => (secIds(sec).includes(id) ? nextSec.shift() : id));

  // buttons
  box.addEventListener('click', (e) => {
    const t = e.target.closest('[data-reorder], [data-move], [data-retry]');
    if (!t) return;
    if (t.dataset.reorder !== undefined) {
      if (t.getAttribute('aria-disabled') === 'true') { demoToast(); return; }
      if (st.on) { flush(); st.on = false; st.status = 'idle'; } else { st.on = true; st.status = 'idle'; }
      buzz(6);
      repaint();
      $('[data-reorder]', box)?.focus({ preventScroll: true });
      return;
    }
    if (t.dataset.retry !== undefined) {
      const ids = st.failed;
      if (ids) { prev ??= current(); applyLocal(ids); repaint(); clearTimeout(timer); timer = 0; const before = prev; prev = null; save(ids, before); }
      return;
    }
    const row = t.closest('.ro');
    const sec = row?.parentElement;
    if (!row || !sec) return;
    const dir = Number(t.dataset.move);
    const id = row.dataset.id;
    const next = UxModel.moveRow(secIds(sec), id, dir);
    if (next.join() === secIds(sec).join()) return;
    change(withSection(sec, [...next]));
    buzz(6);
    // The block was redrawn: put focus back on the same button so the keyboard can keep going.
    const again = $(`.ro[data-id="${CSS.escape(id)}"] [data-move="${dir}"]:not(:disabled)`, box) ?? $(`.ro[data-id="${CSS.escape(id)}"] [data-move]:not(:disabled)`, box);
    again?.focus({ preventScroll: true });
    const moved = $(`.ro[data-id="${CSS.escape(id)}"]`, box);
    if (moved && !hoReduced()) { moved.classList.remove('moved'); void moved.offsetWidth; moved.classList.add('moved'); }
  });

  // drag
  box.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const row = grip.closest('.ro');
    const sec = row.parentElement;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch {}
    const grab = e.clientY - row.getBoundingClientRect().top;
    const before = current();
    let y = e.clientY;
    let raf = 0;
    row.style.transition = 'none';
    row.classList.add('drag');
    buzz(8);

    const step = () => {
      row.style.transform = '';
      const h = row.offsetHeight;
      const top = y - grab;
      for (let guard = 0; guard < 4; guard++) {
        const p = row.previousElementSibling;
        const n = row.nextElementSibling;
        const pr = p?.classList.contains('ro') ? p.getBoundingClientRect() : null;
        const nr = n?.classList.contains('ro') ? n.getBoundingClientRect() : null;
        if (pr && top < pr.top + pr.height / 2) { hoFlip(sec, () => sec.insertBefore(row, p)); buzz(4); }
        else if (nr && top + h > nr.top + nr.height / 2) { hoFlip(sec, () => sec.insertBefore(row, n.nextElementSibling)); buzz(4); }
        else break;
      }
      row.style.transform = `translateY(${top - row.getBoundingClientRect().top}px)`;
    };
    const edge = () => {
      const dy = y < 96 ? -14 : y > innerHeight - 120 ? 14 : 0;
      if (dy) { scrollBy(0, dy); step(); }
      raf = dy ? requestAnimationFrame(edge) : 0;
    };
    const move = (ev) => { y = ev.clientY; step(); if (!raf) raf = requestAnimationFrame(edge); };
    const end = (ev) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      cancelAnimationFrame(raf);
      row.style.transition = hoReduced() ? 'none' : 'transform .18s cubic-bezier(.16,1,.3,1)';
      row.style.transform = '';
      setTimeout(() => { row.classList.remove('drag'); row.style.transition = ''; }, hoReduced() ? 0 : 200);
      const after = hoIds(box);
      if (ev?.type === 'pointercancel') { repaint(); return; } // a cancelled gesture is not a drop: back to where it was
      if (after.join() !== before.join()) {
        hoSyncEdges(box);
        prev ??= before;
        applyLocal(after);
        st.status = 'idle'; note();
        clearTimeout(timer);
        timer = setTimeout(flush, HO_SAVE_DELAY);
        buzz(10);
      }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    step();
  });

  // Leaving the page with a change not yet sent: keep it in the offline queue so it still goes.
  addEventListener('pagehide', () => {
    if (!timer) return;
    clearTimeout(timer); timer = 0;
    queue.push({ method: 'PUT', path: '/api/home/order', body: { ids: current() } });
    prev = null;
  });

  // True while the order on screen is newer than whatever a background refresh could bring back.
  st.busy = () => !!timer || saving > 0 || Date.now() < hold;
  return st;
}
