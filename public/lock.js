// The fingerprint lock, page side. The server is the lock (no unlock cookie, no
// data: every /api/ call answers 423); this file is the screen in front of it.
// The cover is in index.html from the first paint, so nothing behind it shows
// before the lock has been checked. The SPA stays mounted underneath: a fetch
// that meets the lock (a 423, or the page knowing it is locked) waits here and
// is sent again after the fingerprint, so a half-typed form or a queued write
// carries on exactly where it was.
// Locks again after 15 minutes without a touch, after a minute in the
// background, on Lock now, and whenever the server says so.
'use strict';

const lockUi = (() => {
  const rawFetch = window.fetch.bind(window);
  const AWAY_MS = 60_000;
  const PING_MS = 4 * 60_000;
  let idleMs = 15 * 60_000;
  // checking | setup | locked | unlocked | local (opened offline on this device's word only)
  let state = 'checking';
  let waiters = [];
  let busy = false;
  let autoPrompted = false;
  let hiddenAt = 0;
  let lastTouch = Date.now();
  let lastPing = Date.now();
  let touchedSincePing = false;

  const el = (id) => document.getElementById(id);
  const open = () => state === 'unlocked' || state === 'local';
  const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const saved = {
    get: () => store.get('lock') ?? {},
    set: (v) => store.set('lock', { ...saved.get(), ...v }),
  };

  // the cover

  const COPY = {
    checking: { t: 'Mint', line: 'Checking the lock...' },
    setup: { t: 'Set up your fingerprint', line: 'Mint asks for your fingerprint every time it opens. Set it up once on this device and it unlocks with a touch.', btn: 'Set up fingerprint' },
    locked: { t: 'Mint is locked', line: 'Touch the sensor to open your money.', btn: 'Unlock with fingerprint' },
    offline: { t: 'Mint is locked', line: 'You are offline. Your fingerprint opens the copy saved on this device; changes sync once you are back and unlocked.', btn: 'Unlock with fingerprint' },
    nooffline: { t: 'Mint is locked', line: 'You are offline and this device has no fingerprint set up for Mint yet, so it cannot open. Connect and try again.', btn: 'Try again' },
  };
  let mode = 'checking';

  function paint(next = mode, { error = null, working = '' } = {}) {
    mode = next;
    const c = COPY[mode];
    const root = el('lock');
    root.dataset.state = working ? 'working' : error ? 'error' : mode;
    el('lock-t').textContent = c.t;
    el('lock-line').textContent = working || c.line;
    const btn = el('lock-go');
    btn.hidden = !c.btn || mode === 'checking';
    btn.disabled = !!working;
    btn.setAttribute('aria-busy', working ? 'true' : 'false');
    el('lock-go-l').textContent = working ? 'Waiting...' : error ? 'Try again' : c.btn ?? '';
    el('lock-go').title = working ? 'Waiting for the fingerprint prompt to finish' : '';
    const err = el('lock-err');
    err.hidden = !error;
    if (error) { $('.h', err).textContent = error.head; $('.d', err).textContent = error.detail; }
  }

  function cover(on) {
    const root = el('lock');
    for (const id of ['shell', 'loadbar', 'offline', 'sheet', 'modal', 'palette', 'toasts', 'chat']) {
      const n = el(id);
      if (!n) continue;
      if (on) { n.setAttribute('inert', ''); n.setAttribute('aria-hidden', 'true'); } else { n.removeAttribute('inert'); n.removeAttribute('aria-hidden'); }
    }
    document.body.classList.toggle('locked', on);
    if (on) {
      root.hidden = false;
      root.classList.remove('lock-out', 'lock-done');
    } else if (!root.hidden) {
      root.classList.add('lock-done');
      // The tick shows, then the cover lifts. Reduced motion: it just goes.
      const ms = reduceMotion.matches ? 0 : 520;
      setTimeout(() => { root.classList.add('lock-out'); setTimeout(() => { if (open()) root.hidden = true; }, reduceMotion.matches ? 0 : 260); }, ms);
    }
  }

  function setOpen(how) {
    state = how;
    lastTouch = Date.now();
    lastPing = Date.now();
    cover(false);
    const w = waiters;
    waiters = [];
    w.forEach((f) => f());
    document.dispatchEvent(new CustomEvent('mint:unlocked'));
  }

  // Lock the page at once; revoke tells the server to end the session too (and
  // is done before the status check, so the check cannot see the old session).
  async function lock({ revoke = true, prompt = false } = {}) {
    if (!open()) return;
    state = saved.get().enrolled === 0 ? 'setup' : 'locked';
    autoPrompted = !prompt;
    cover(true);
    paint(state);
    if (revoke) await rawFetch('/api/lock/lock', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    check({ prompt });
  }

  // talking to the server (silent retries before any error shows)

  async function call(path, body) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      let res;
      try {
        res = await rawFetch(path, {
          method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'manual',
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        lastErr = { offline: true, head: 'No connection', detail: String(e?.message ?? e) };
        if (i < 2) { await sleep(400 * 3 ** i); continue; }
        throw lastErr;
      }
      if (res.type === 'opaqueredirect' || res.status === 401 && path === '/api/lock/status') {
        throw { signedOut: true, head: 'Signed out', detail: 'The sign-in gate session expired. Reload to sign in again.' };
      }
      if (res.status >= 500 && i < 2) { await sleep(400 * 3 ** i); continue; }
      const data = await res.json().catch(() => null);
      if (!res.ok) throw { status: res.status, head: res.status === 429 ? 'Too many tries' : 'Fingerprint not accepted', detail: `${res.status} ${data?.error ?? res.statusText}` };
      return data;
    }
    throw lastErr;
  }

  // Ask the server where things stand and paint the cover to match.
  async function check({ prompt = true } = {}) {
    if (busy) return;
    try {
      const s = await call('/api/lock/status');
      idleMs = s.idleMs || idleMs;
      saved.set({ on: s.on, enrolled: s.enrolled });
      document.dispatchEvent(new CustomEvent('mint:lockstate', { detail: { on: s.on } }));
      if (!s.on || !s.locked) { setOpen('unlocked'); return; }
      state = s.setup ? 'setup' : 'locked';
      cover(true);
      paint(state);
      // One automatic prompt per lock; after that the button.
      if (prompt && !autoPrompted && state === 'locked' && document.visibilityState === 'visible') { autoPrompted = true; go({ auto: true }); }
    } catch (e) {
      if (e.offline) {
        const s = saved.get();
        if (s.on === false) { setOpen('local'); return; }
        state = 'locked';
        cover(true);
        paint(s.creds?.length ? 'offline' : 'nooffline');
        return;
      }
      state = 'locked';
      cover(true);
      paint('locked', { error: e.head ? e : { head: "Couldn't check the lock", detail: String(e?.message ?? e) } });
    }
  }

  const deviceLabel = () => {
    const ua = navigator.userAgent;
    const p = navigator.userAgentData?.platform || '';
    if (/Android/i.test(p + ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Mac/i.test(p + ua)) return 'Mac';
    if (/Win/i.test(p + ua)) return 'Windows PC';
    if (/Linux|CrOS/i.test(p + ua)) return 'Linux';
    return 'This device';
  };

  // The browser's own prompt failed: a plain line for the owner, the real error underneath.
  function promptError(e, what) {
    const name = e?.name ?? 'Error';
    const head = name === 'NotAllowedError' ? `${what} was cancelled or timed out`
      : name === 'InvalidStateError' ? 'This device already has a Mint fingerprint'
      : name === 'NotSupportedError' ? 'This device cannot do a fingerprint for Mint'
      : name === 'SecurityError' ? 'The browser refused the fingerprint request'
      : `${what} failed`;
    return { head, detail: `${name}: ${e?.message ?? e}`, name };
  }

  async function enrol({ fromSettings = false } = {}) {
    const o = await call('/api/lock/register-challenge', {});
    const publicKey = {
      ...o,
      challenge: fromB64u(o.challenge),
      user: { ...o.user, id: fromB64u(o.user.id) },
      excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ ...c, id: fromB64u(c.id) })),
    };
    let cred;
    try { cred = await navigator.credentials.create({ publicKey }); } catch (e) { throw promptError(e, 'Setting up the fingerprint'); }
    if (!fromSettings) paint('setup', { working: 'Saving your fingerprint...' });
    const r = cred.response;
    const out = await call('/api/lock/register-verify', {
      id: cred.id, attestationObject: toB64u(r.attestationObject), clientDataJSON: toB64u(r.clientDataJSON), label: deviceLabel(),
    });
    saved.set({ creds: [...new Set([...(saved.get().creds ?? []), cred.id])] });
    return out;
  }

  async function unlock() {
    const o = await call('/api/lock/challenge', {});
    const publicKey = { ...o, challenge: fromB64u(o.challenge), allowCredentials: o.allowCredentials.map((c) => ({ ...c, id: fromB64u(c.id) })) };
    let a;
    try { a = await navigator.credentials.get({ publicKey }); } catch (e) { throw promptError(e, 'The fingerprint check'); }
    paint(mode, { working: 'Checking with Mint...' });
    const r = a.response;
    await call('/api/lock/verify', { id: a.id, authenticatorData: toB64u(r.authenticatorData), clientDataJSON: toB64u(r.clientDataJSON), signature: toB64u(r.signature) });
    saved.set({ creds: o.allowCredentials.map((c) => c.id) });
  }

  // Offline: the device's own fingerprint check opens the copy saved here. The
  // server has not seen it, so the first call that reaches it locks again.
  async function unlockLocal() {
    const ids = saved.get().creds ?? [];
    const publicKey = { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: 'required', timeout: 60_000, allowCredentials: ids.map((id) => ({ type: 'public-key', id: fromB64u(id) })) };
    try { await navigator.credentials.get({ publicKey }); } catch (e) { throw promptError(e, 'The fingerprint check'); }
  }

  async function go({ auto = false } = {}) {
    if (busy) return;
    if (mode === 'nooffline' || mode === 'checking') { check(); return; }
    if (!window.PublicKeyCredential || !navigator.credentials) {
      paint(mode, { error: { head: 'This browser cannot do fingerprints', detail: 'WebAuthn (PublicKeyCredential) is not available here. Open Mint in Chrome or Safari.' } });
      return;
    }
    busy = true;
    const slow = setTimeout(() => { if (busy && el('lock').dataset.state === 'working') el('lock-line').textContent = 'Still waiting. Touch the sensor, or cancel the prompt and try again.'; }, 8000);
    try {
      if (mode === 'setup') { paint('setup', { working: 'Waiting for your fingerprint...' }); await enrol(); } else if (mode === 'offline') { paint('offline', { working: 'Waiting for your fingerprint...' }); await unlockLocal(); } else { paint('locked', { working: 'Waiting for your fingerprint...' }); await unlock(); }
      buzz(12);
      busy = false;
      setOpen(mode === 'offline' ? 'local' : 'unlocked');
      if (online && queue.all().length) queue.flush();
    } catch (e) {
      busy = false;
      if (e?.offline && mode !== 'offline' && saved.get().creds?.length) { paint('offline', { error: e }); return; }
      if (e?.status === 423 || e?.status === 409) { check({ prompt: false }); return; } // the lock changed under us (enrolled elsewhere, or reset)
      // Some browsers (Safari) refuse a prompt nobody tapped for: the button is the way, no error.
      if (auto && e?.name === 'NotAllowedError') { paint(mode); return; }
      paint(mode, { error: e?.head ? e : { head: "Couldn't unlock", detail: String(e?.message ?? e) } });
    } finally { clearTimeout(slow); busy = false; }
  }

  // every /api/ call goes past the lock

  // The lock's own endpoints, which the server answers while locked (Settings' list is not one).
  const LOCK_FREE = /^\/api\/lock\/(status|challenge|verify|register-challenge|register-verify|lock)$/;
  const wait = () => (open() ? Promise.resolve() : new Promise((r) => waiters.push(r)));
  window.fetch = async (input, init) => {
    let u;
    try { u = new URL(typeof input === 'string' ? input : input.url, location.href); } catch { return rawFetch(input, init); }
    if (u.origin !== location.origin || !u.pathname.startsWith('/api/') || LOCK_FREE.test(u.pathname)) return rawFetch(input, init);
    for (;;) {
      await wait();
      const res = await rawFetch(input, init);
      if (res.status !== 423) return res;
      lock({ revoke: false });
    }
  };

  // idle, background, keepalive

  const touch = () => { lastTouch = Date.now(); touchedSincePing = true; };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, touch, { passive: true, capture: true });
  addEventListener('scroll', touch, { passive: true });
  setInterval(() => {
    if (!open() || document.visibilityState !== 'visible') return;
    if (Date.now() - lastTouch > idleMs) { lock(); return; }
    // Reading without loading anything still counts as using Mint: keep the server's window sliding.
    if (state === 'unlocked' && touchedSincePing && Date.now() - lastPing > PING_MS) {
      lastPing = Date.now();
      touchedSincePing = false;
      call('/api/lock/status').then((s) => { if (s.on && s.locked) lock({ revoke: false }); }).catch(() => {});
    }
  }, 10_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (open() && (away > AWAY_MS || Date.now() - lastTouch > idleMs)) lock({ prompt: true });
    else if (!open() && !busy && mode !== 'checking') check({ prompt: true });
  });

  function init() {
    el('lock-go').addEventListener('click', () => { autoPrompted = true; go(); });
    cover(true);
    paint('checking');
    check();
  }

  return { init, lock: () => lock({ revoke: true }), enrol: () => enrol({ fromSettings: true }), isOpen: open, state: () => state };
})();
