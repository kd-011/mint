// Sync on Home: a strip that shows only when the last sync failed, and
// pull-to-refresh on a touch screen (drag the top of Home down, let go past
// the mark). Both go through startSync(), which the search palette's
// "Sync now" uses too.
'use strict';

async function startSync() {
  if (!online) { toast('Offline: sync needs a connection', { error: true }); return false; }
  if (syncState?.running) { watchSync(); return true; }
  try {
    const r = await api('/api/sync', { method: 'POST', body: {} });
    syncState = { ...r, elapsed: 0 };
    buzz();
    document.dispatchEvent(new CustomEvent('mint:syncstate'));
    watchSync();
    return true;
  } catch (e) {
    toast(`Couldn't start a sync: ${e.detail}`, { error: true, action: { label: 'Retry', fn: startSync } });
    return false;
  }
}

function homeSyncHtml() {
  const last = accountsData?.sync;
  // A running sync shows only as the Sync tile's spinner; this strip is for a failed sync.
  const err = syncState?.lastError || last?.lastError;
  if (!err) return '';
  return `<section class="card syncstrip bad">
    <div class="ss-top"><span class="card-ic">${I.alert}</span><div class="ss-t"><div class="t1">The last sync failed</div><div class="sub wrap">${esc(err)}</div></div>
      <button class="btn sm" type="button" id="hsyncnow" ${online ? '' : 'disabled'} title="${online ? 'Try the sync again' : 'Offline: sync needs a connection'}">${I.refresh}Retry</button></div>
  </section>`;
}

// Draws the strip into its slot and keeps it live while a sync runs and when it ends.
function mountHomeSync(slot, token) {
  const paint = () => {
    if (token !== renderToken) return;
    slot.innerHTML = homeSyncHtml();
    applyDims(slot);
  };
  paint();
  slot.addEventListener('click', (e) => { if (e.target.closest('#hsyncnow')) startSync(); });
  document.addEventListener('mint:syncstate', paint);
  document.addEventListener('mint:online', paint);
  accountsListeners.add(paint);
  cleanup.push(() => {
    document.removeEventListener('mint:syncstate', paint);
    document.removeEventListener('mint:online', paint);
    accountsListeners.delete(paint);
  });
}

// pull to refresh

function initPullToRefresh() {
  const el = document.createElement('div');
  el.className = 'ptr';
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<span class="ptr-c">${I.refresh}</span><span class="ptr-t">Pull to sync</span>`;
  document.body.append(el);
  const label = $('.ptr-t', el);
  const dial = $('.ptr-c', el);
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let dy = 0;
  let armed = false;
  const blocked = () => route.view !== 'home' || scrollY > 0 || !$('#sheet').hidden || !$('#modal').hidden || !$('#palette').hidden || syncState?.running || !online;
  const hide = () => { el.hidden = true; el.classList.remove('ready'); armed = false; };
  addEventListener('touchstart', (e) => {
    tracking = false;
    if (e.touches.length !== 1 || blocked()) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dy = 0;
    tracking = true;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const t = e.touches[0];
    dy = t.clientY - startY;
    if (Math.abs(t.clientX - startX) > Math.abs(dy) && Math.abs(dy) < 14) { tracking = false; return; }
    if (dy <= 0 || scrollY > 0) { if (dy <= 0) hide(); return; }
    if (e.cancelable) e.preventDefault();
    const p = UxModel.pull(dy);
    el.hidden = false;
    el.style.opacity = String(Math.min(1, p.pct / 70));
    el.style.transform = `translate(-50%, ${p.shown - 18}px)`;
    dial.style.transform = `rotate(${Math.round(p.pct * 2.7)}deg)`;
    el.classList.toggle('ready', p.ready);
    label.textContent = p.ready ? 'Release to sync' : 'Pull to sync';
    if (p.ready && !armed) { armed = true; buzz(10); }
    if (!p.ready) armed = false;
  }, { passive: false });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    const go = UxModel.pull(dy).ready;
    hide();
    if (go) startSync();
  };
  addEventListener('touchend', end);
  addEventListener('touchcancel', () => { tracking = false; hide(); });
}
