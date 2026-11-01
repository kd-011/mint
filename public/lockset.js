// Settings: the fingerprint lock card. Lists the fingerprints (passkeys) Mint
// accepts, adds another through lock.js, removes one (never the last: the web
// side cannot leave Mint with none, scripts/lock-reset.mjs is the way for a lost
// phone) and has Lock now. settings.js draws it first in SETTINGS_SECTIONS.
'use strict';

// null while loading, then { credentials } or { error }.
let lockList = null;
let lockBusy = '';
let lockErr = null;

function lockRowsHtml() {
  if (!lockList) return skeletonRows(1);
  if (lockList.error) return errorCard(lockList.error, 'set-lock-retry', 'your fingerprints');
  const list = lockList.credentials;
  if (!list.length) return '<p class="sub">No fingerprint is set up. The next time Mint locks it will offer to set one up.</p>';
  const only = list.length === 1;
  const why = 'Mint keeps at least one fingerprint. Add another first, then remove this one.';
  return list.map((c) => `<div class="set-row lk-row">
      <div class="main"><div class="t1">${esc(c.label)}</div><div class="t2">Added ${esc(dmy(c.created_at.slice(0, 10)))}${c.last_used_at ? ` · last used ${esc(ago(c.last_used_at))}` : ' · not used yet'}</div></div>
      <button class="btn danger sm" type="button" data-lock-rm="${esc(c.id)}" data-label="${esc(c.label)}" ${only || lockBusy ? 'disabled' : ''} title="${only ? why : `Remove ${esc(c.label)}`}" aria-label="Remove ${esc(c.label)}">${I.trash}Remove</button>
    </div>`).join('') + (only ? `<p class="sub set-note">${esc(why)}</p>` : '');
}

const lockCard = () => {
  const off = store.get('lock')?.on === false;
  const err = lockErr ? `<div class="error compact" role="alert"><div class="h">${esc(lockErr.head)}</div><div class="d">${esc(lockErr.detail)}</div><button class="btn ghost sm" type="button" id="set-lock-again">${I.refresh}Try again</button></div>` : '';
  const adding = lockBusy === 'add';
  return `<section class="card set-card" id="set-lock">
    ${cardHead(I.fingerprint, 'Fingerprint lock', `<span class="chip ${off ? 'warn' : ''}">${off ? 'Off' : 'On'}</span>`)}
    <div id="set-lock-list">${lockRowsHtml()}</div>
    ${off ? '' : `<div class="set-acts">
      <button class="btn ghost sm" type="button" id="set-lock-add" ${lockBusy ? 'disabled' : ''} ${adding ? 'aria-busy="true"' : ''} title="${lockBusy ? 'Wait for the current step to finish' : 'Set up a fingerprint on this or another device'}">${adding ? '<span class="spin"></span>Waiting for your fingerprint...' : `${I.plus}Add a fingerprint`}</button>
      <button class="btn sm" type="button" id="set-lock-now">${I.lock}Lock now</button>
    </div>`}
    ${err}
    <p class="sub set-note">Lost the phone? On the server run <code>node scripts/lock-reset.mjs --yes</code> to clear every fingerprint, then set one up again when Mint next opens.</p>
  </section>`;
};

async function loadLockList(repaint) {
  try { lockList = await api('/api/lock/credentials'); } catch (e) { lockList = { error: e }; }
  repaint();
}

// Loads the list and handles the card's buttons for one Settings render.
function wireLockCard(el) {
  const paintLock = () => { const box = $('#set-lock', el); if (box) box.outerHTML = lockCard(); };
  lockList = null;
  lockErr = null;
  lockBusy = '';
  loadLockList(paintLock);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('#set-lock-retry')) { lockList = null; paintLock(); loadLockList(paintLock); return; }
    if (e.target.closest('#set-lock-now')) { buzz(10); lockUi.lock(); return; }
    if (e.target.closest('#set-lock-add, #set-lock-again') && !lockBusy) {
      lockBusy = 'add';
      lockErr = null;
      paintLock();
      try {
        await lockUi.enrol();
        buzz(12);
        toast('Fingerprint added');
        lockBusy = '';
        await loadLockList(paintLock);
      } catch (err) {
        lockBusy = '';
        lockErr = err?.head ? err : { head: "Couldn't add the fingerprint", detail: String(err?.detail ?? err?.message ?? err) };
        paintLock();
      }
      return;
    }
    const rm = e.target.closest('[data-lock-rm]');
    if (rm && !rm.disabled) {
      const id = rm.dataset.lockRm;
      openModal(`${sheetHead('Fingerprint lock', `Remove ${rm.dataset.label}?`)}
        <p class="sub">Mint will stop accepting this fingerprint. You can set it up again from here.</p>
        <div class="cbtns"><button class="btn ghost" type="button" data-close>Keep it</button><button class="btn danger" type="button" id="set-lock-rm-ok">${I.trash}Remove</button></div>`);
      $('#set-lock-rm-ok').addEventListener('click', async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        b.innerHTML = '<span class="spin"></span>Removing...';
        try {
          await api(`/api/lock/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
          closeModal();
          buzz(14);
          toast('Fingerprint removed');
          lockList = { credentials: lockList.credentials.filter((c) => c.id !== id) };
          paintLock();
          loadLockList(paintLock);
        } catch (err) {
          b.disabled = false;
          b.innerHTML = `${I.trash}Remove`;
          b.closest('.panel').insertAdjacentHTML('beforeend', `<div class="error compact" role="alert"><div class="h">Couldn't remove the fingerprint</div><div class="d">${esc(err?.detail ?? err?.message ?? err)}</div></div>`);
        }
      });
      return;
    }
  });
}
