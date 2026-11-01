/*
  ui-kit motion and behaviour helper. ES module, no dependencies.

    import { init, toast, haptic } from '/kit/kit.js';
    init();                       // wires everything with data-k-* hooks

  Every animation runs on the Web Animations API, so it is off the main thread,
  can be seeked (document.getAnimations()), and yields to input: a tap during
  an entrance finishes it at once. Springs are turned into CSS linear() easings
  by spring(). Entrances stay under 400ms. Reduced motion (the OS setting or
  data-motion="reduce" on <html>) keeps fades and drops movement, blur, scale,
  overshoot and stagger.
*/

const ENTRANCE_MAX = 400;
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const STAGGER_CAP = 8;

/* Reduced motion ------------------------------------------------------- */

const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

export function reducedMotion() {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce') return true;
  return !!motionQuery?.matches;
}

/* Springs -------------------------------------------------------------- */

const springCache = new Map();

/**
 * A damped spring from 0 to 1 as a CSS linear() easing plus its duration.
 * Give either { stiffness, damping, mass } or Apple-style { duration, bounce }
 * (seconds). velocity is the starting speed in "distances per second", which
 * is how a released drag hands its momentum to the spring.
 */
export function spring(opts = {}) {
  let { stiffness, damping, mass = 1, velocity = 0, threshold = 0.004 } = opts;
  if (opts.duration != null) {
    const d = opts.duration;
    const b = Math.max(0, Math.min(0.9, opts.bounce ?? 0));
    stiffness = (2 * Math.PI / d) ** 2;
    damping = ((1 - b) * 4 * Math.PI) / d;
  }
  stiffness ??= 400;
  damping ??= 30;
  const key = [stiffness, damping, mass, velocity.toFixed(2), threshold].join('|');
  if (springCache.has(key)) return springCache.get(key);

  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  let x;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    x = (t) => 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0 - velocity) / wd) * Math.sin(wd * t));
  } else {
    x = (t) => 1 - Math.exp(-w0 * t) * (1 + (w0 - velocity) * t);
  }
  let end = 0;
  for (let t = 0; t < 2; t += 1 / 240) if (Math.abs(1 - x(t)) > threshold) end = t;
  const duration = Math.max(1, Math.round((end + 1 / 240) * 1000));
  const points = [];
  const n = 40;
  for (let i = 0; i <= n; i++) points.push(+x(((i / n) * duration) / 1000).toFixed(4));
  points[n] = 1;
  const out = { easing: `linear(${points.join(', ')})`, duration };
  springCache.set(key, out);
  return out;
}

export const springs = {
  sheet: { duration: 0.34, bounce: 0.12 },
  hero: { duration: 0.34, bounce: 0.1 },
  snappy: { stiffness: 400, damping: 30 },
};

/* animate(): WAAPI with the reduced-motion rule applied ------------------ */

const MOVING = ['transform', 'translate', 'scale', 'rotate', 'filter'];

/**
 * element.animate() that respects reduced motion: moving properties are
 * stripped and the rest plays as a 150ms fade. Returns the Animation.
 */
export function animate(el, keyframes, options = {}) {
  if (!el?.animate) return null;
  if (reducedMotion()) {
    const frames = keyframes.map((f) => {
      const g = { ...f };
      for (const p of MOVING) delete g[p];
      return g;
    });
    const hasAny = frames.some((f) => Object.keys(f).some((k) => k !== 'offset' && k !== 'easing'));
    if (!hasAny) return null;
    return el.animate(frames, { ...options, duration: 150, delay: 0, easing: 'ease' });
  }
  return el.animate(keyframes, options);
}

/* Haptics -------------------------------------------------------------- */

const PATTERNS = { light: 8, select: 6, success: [10, 40, 12], warn: 18, danger: [20, 60, 20], long: 14 };

/** Light vibration on supported phones, silent everywhere else. */
export function haptic(kind = 'light') {
  try {
    if (navigator.vibrate) navigator.vibrate(PATTERNS[kind] ?? PATTERNS.light);
  } catch {
    /* not allowed before a user gesture; fine */
  }
}

/* Staggered reveal ----------------------------------------------------- */

const REVEAL_DUR = 190;
const revealed = new WeakSet();

/**
 * Children of every [data-k-stagger] container enter with the focus pull
 * (blur 4px and 6px below, to sharp) when the container first scrolls into
 * view. 30 to 50ms apart, capped at 8 so the whole run stays under 400ms.
 * Once per container per page load; content is visible if this never runs.
 */
export function reveal(root = document) {
  const containers = [...root.querySelectorAll('[data-k-stagger]')].filter((c) => !revealed.has(c));
  if (!containers.length) return;
  const run = (c) => {
    if (revealed.has(c)) return;
    revealed.add(c);
    const items = [...c.children].filter((el) => !el.hidden);
    const n = Math.min(items.length, STAGGER_CAP);
    const gap = n > 1 ? Math.max(30, Math.min(50, (ENTRANCE_MAX - REVEAL_DUR) / (n - 1))) : 0;
    const anims = items.map((el, i) =>
      animate(
        el,
        [
          { opacity: 0, transform: 'translateY(6px)', filter: 'blur(4px)' },
          { opacity: 1, transform: 'none', filter: 'blur(0)' },
        ],
        { duration: REVEAL_DUR, delay: Math.min(i, n - 1) * gap, easing: EASE_OUT, fill: 'backwards' },
      ),
    );
    // Never block input: the first touch finishes the entrance.
    const finish = () => anims.forEach((a) => a?.playState === 'running' && a.finish());
    c.addEventListener('pointerdown', finish, { once: true, capture: true });
    c.addEventListener('focusin', finish, { once: true });
  };
  if (!('IntersectionObserver' in window)) return containers.forEach(run);
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          io.unobserve(e.target);
          run(e.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  containers.forEach((c) => io.observe(c));
}

/* Sheets and dialogs --------------------------------------------------- */

const state = new WeakMap();

function currentY(el) {
  const m = getComputedStyle(el).transform;
  if (!m || m === 'none') return 0;
  return new DOMMatrixReadOnly(m).m42;
}

function fadeBackdrop(el, from, to, duration) {
  // ::backdrop can be animated through pseudoElement in WAAPI.
  try {
    return el.animate([{ opacity: from }, { opacity: to }], {
      duration,
      easing: 'ease',
      pseudoElement: '::backdrop',
      fill: 'forwards',
    });
  } catch {
    return null;
  }
}

/** Open a <dialog class="k-sheet"> with a spring from below. */
export function openSheet(el, { velocity = 0 } = {}) {
  if (!el) return;
  const s = state.get(el) || {};
  state.set(el, s);
  const wasOpen = el.open;
  // Reopening mid-close starts from where the sheet is, not from the bottom.
  const midway = wasOpen && s.anim ? currentY(el) : null;
  s.anim?.cancel();
  s.closing = false;
  if (!wasOpen) {
    s.returnFocus = document.activeElement;
    el.showModal();
    syncLayers();
    haptic('light');
  }
  const h = el.getBoundingClientRect().height || 400;
  const startY = s.dragY ?? midway ?? h;
  const sp = spring({ ...springs.sheet, velocity });
  s.anim = animate(el, [{ transform: `translateY(${startY}px)` }, { transform: 'translateY(0)' }], {
    duration: Math.min(sp.duration, ENTRANCE_MAX),
    easing: sp.easing,
  });
  if (startY >= h) fadeBackdrop(el, 0, 1, 220);
  s.dragY = null;
}

/** Close a sheet: slides down from wherever it is, then closes the dialog. */
export function closeSheet(el, { velocity = 0 } = {}) {
  if (!el?.open) return;
  const s = state.get(el) || {};
  state.set(el, s);
  if (s.closing) return;
  s.closing = true;
  const from = s.dragY ?? currentY(el);
  s.anim?.cancel();
  const h = el.getBoundingClientRect().height || 400;
  const remaining = Math.max(1, h - from);
  // A fling keeps its speed: shorter close the faster it was thrown.
  const dur = Math.max(140, Math.min(260, velocity > 0 ? (remaining / velocity) * 1000 : 220));
  s.anim = animate(el, [{ transform: `translateY(${from}px)` }, { transform: `translateY(${h}px)` }], {
    duration: dur,
    easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
    fill: 'forwards',
  });
  fadeBackdrop(el, 1, 0, dur);
  const done = () => {
    s.anim?.cancel();
    s.closing = false;
    s.dragY = null;
    el.close();
    syncLayers();
    el.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    s.returnFocus?.focus?.({ preventScroll: true });
  };
  if (s.anim) s.anim.finished.then(done, () => {});
  else done();
}

function bindSheet(el) {
  if (el.dataset.kBound) return;
  el.dataset.kBound = '1';
  el.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeSheet(el);
  });
  el.addEventListener('click', (e) => {
    if (e.target === el) {
      // Click on the backdrop area (outside the box).
      const r = el.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) closeSheet(el);
    }
  });
  const grips = el.querySelectorAll('.k-sheet-handle, .k-sheet-head');
  grips.forEach((grip) => {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, a, input, select, textarea')) return;
      const s = state.get(el) || {};
      state.set(el, s);
      if (s.drag) return; // ignore a second finger
      s.anim?.cancel();
      const startY = e.clientY;
      const base = currentY(el);
      let last = { y: e.clientY, t: e.timeStamp };
      let prev = last;
      s.drag = true;
      grip.setPointerCapture(e.pointerId);
      el.setAttribute('data-k-dragging', '');
      const move = (ev) => {
        let dy = base + ev.clientY - startY;
        if (dy < 0) dy = -Math.sqrt(-dy) * 2; // friction above the resting point
        s.dragY = dy;
        el.style.transform = `translateY(${dy}px)`;
        prev = last;
        last = { y: ev.clientY, t: ev.timeStamp };
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        s.drag = false;
        el.removeAttribute('data-k-dragging');
        const dt = Math.max(1, last.t - prev.t);
        const v = (last.y - prev.y) / dt; // px per ms
        const h = el.getBoundingClientRect().height;
        const y = s.dragY ?? 0;
        el.style.transform = '';
        if (y > h * 0.3 || v > 0.11) {
          closeSheet(el, { velocity: Math.max(0, v * 1000) });
        } else {
          // Spring home, keeping the release speed (in sheet-distances per second).
          openSheet(el, { velocity: (-v * 1000) / Math.max(1, Math.abs(y)) });
        }
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  });
}

/** Open a centred <dialog class="k-dialog">: focus pull plus a slight scale. */
export function openDialog(el) {
  if (!el) return;
  const s = state.get(el) || {};
  state.set(el, s);
  s.anim?.cancel();
  s.closing = false;
  if (!el.open) {
    s.returnFocus = document.activeElement;
    el.showModal();
    syncLayers();
  }
  s.anim = animate(
    el,
    [
      { opacity: 0, transform: 'scale(0.96)', filter: 'blur(3px)' },
      { opacity: 1, transform: 'none', filter: 'blur(0)' },
    ],
    { duration: 220, easing: EASE_OUT },
  );
  fadeBackdrop(el, 0, 1, 180);
}

export function closeDialog(el, returnValue) {
  if (!el?.open) return;
  const s = state.get(el) || {};
  state.set(el, s);
  if (s.closing) return;
  s.closing = true;
  s.anim?.cancel();
  s.anim = animate(el, [{ opacity: 1 }, { opacity: 0, transform: 'scale(0.98)' }], {
    duration: 140,
    easing: 'ease',
    fill: 'forwards',
  });
  fadeBackdrop(el, 1, 0, 140);
  const done = () => {
    s.closing = false;
    el.close(returnValue);
    syncLayers();
    el.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    s.returnFocus?.focus?.({ preventScroll: true });
  };
  if (s.anim) s.anim.finished.then(done, () => {});
  else done();
}

function bindDialog(el) {
  if (el.dataset.kBound) return;
  el.dataset.kBound = '1';
  el.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeDialog(el);
  });
}

/* Toasts --------------------------------------------------------------- */

const ICONS = {
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  'chev-down': '<path d="m6 9.5 6 6 6-6"/>',
};
const svg = (name, cls = 'k-icon') =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const TICK =
  '<svg class="k-tick" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/></svg>';

let toastHost;
const MAX_TOASTS = 3;
const live = {};

// While a modal dialog is open everything outside it is inert, so toasts,
// announcements and popovers mount inside the topmost one that is not closing.
function layer() {
  const open = [...document.querySelectorAll('dialog[open].k-sheet, dialog[open].k-dialog')].filter((d) => !state.get(d)?.closing);
  return open[open.length - 1] || document.body;
}

// The toast host is a manual popover, so it lives in the top layer: above the
// dialog and its backdrop, and free of the dialog's transform, clipping and
// scroll. Moving a popover out of the DOM hides it, so it is shown again here.
function raiseToasts() {
  if (!toastHost) return;
  const parent = layer();
  if (toastHost.parentElement !== parent) parent.append(toastHost);
  if (toastHost.showPopover && !toastHost.matches(':popover-open')) toastHost.showPopover();
}

// Called whenever a dialog opens or finishes closing: the host follows the
// topmost dialog, and live regions go with it.
function syncLayers() {
  for (const kind in live) liveNode(kind);
  if (toastHost?.childElementCount) raiseToasts();
}

function liveNode(kind) {
  let n = live[kind];
  if (!n) {
    n = live[kind] = document.createElement('div');
    n.className = 'k-sr-only';
    n.setAttribute('aria-live', kind);
    n.setAttribute('aria-atomic', 'true');
  }
  const parent = layer();
  if (n.parentElement !== parent) parent.append(n);
  return n;
}

/** Tell screen readers something happened. Created at init so the region exists before it speaks. */
export function announce(text, { assertive = false } = {}) {
  const n = liveNode(assertive ? 'assertive' : 'polite');
  n.textContent = '';
  // A fresh text node in a later frame is what screen readers reliably pick up.
  requestAnimationFrame(() => (n.textContent = text));
}

function host() {
  if (!toastHost) {
    toastHost = document.createElement('ol');
    toastHost.className = 'k-toasts';
    toastHost.setAttribute('aria-label', 'Notifications');
    toastHost.setAttribute('popover', 'manual');
  }
  raiseToasts();
  return toastHost;
}

function flipSiblings(container, mutate) {
  const kids = [...container.children];
  const before = new Map(kids.map((k) => [k, k.getBoundingClientRect().top]));
  mutate();
  for (const k of kids) {
    if (!k.isConnected) continue;
    const dy = before.get(k) - k.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) animate(k, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 220, easing: EASE_OUT });
  }
}

/**
 * Show a toast. tone: 'ok' (ticks), 'danger', 'info'. action: { label, onClick }
 * for Undo or Retry. detail: the real error text, shown small in mono.
 * Timers pause while hovered or while the tab is hidden. Returns { dismiss }.
 */
export function toast(message, { tone = 'info', action, detail, duration } = {}) {
  const h = host();
  const li = document.createElement('li');
  li.className = 'k-toast';
  li.dataset.tone = tone;
  const icon = tone === 'ok' ? TICK : svg(tone === 'danger' ? 'alert' : 'info');
  li.innerHTML = `${icon}<div class="k-toast-msg"></div>`;
  li.querySelector('.k-toast-msg').textContent = message;
  if (detail) {
    const d = document.createElement('span');
    d.className = 'k-toast-detail';
    d.textContent = detail;
    li.querySelector('.k-toast-msg').append(d);
  }
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'k-btn k-btn-sm k-btn-ghost';
    b.textContent = action.label;
    b.style.color = 'var(--k-accent-fg)';
    b.addEventListener('click', () => {
      action.onClick?.();
      dismiss();
    });
    li.append(b);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'k-iconbtn';
  close.setAttribute('aria-label', 'Dismiss');
  close.title = 'Dismiss';
  close.innerHTML = svg('x', 'k-icon k-icon-sm');
  close.addEventListener('click', () => dismiss());
  li.append(close);

  // Oldest out first when the stack is full.
  const live = [...h.children].filter((c) => !c.dataset.leaving);
  for (let i = 0; i <= live.length - MAX_TOASTS; i++) live[i].__kDismiss?.();
  flipSiblings(h, () => h.append(li));
  const sp = spring({ duration: 0.3, bounce: 0.12 });
  animate(
    li,
    [
      { opacity: 0, transform: 'translateY(12px) scale(0.98)', filter: 'blur(4px)' },
      { opacity: 1, transform: 'none', filter: 'blur(0)' },
    ],
    { duration: Math.min(sp.duration, 360), easing: sp.easing },
  );
  announce(detail ? `${message}. ${detail}` : message, { assertive: tone === 'danger' });
  if (tone === 'ok') haptic('success');
  else if (tone === 'danger') haptic('warn');

  // Undo and Retry stay longer, and every timer pauses on hover, focus and a hidden tab.
  let remaining = duration ?? (action ? 8000 : tone === 'danger' ? 8000 : 4000);
  let started = performance.now();
  let timer = setTimeout(dismiss, remaining);
  const pause = () => {
    clearTimeout(timer);
    remaining -= performance.now() - started;
  };
  const resume = () => {
    started = performance.now();
    clearTimeout(timer);
    timer = setTimeout(dismiss, Math.max(800, remaining));
  };
  li.addEventListener('pointerenter', pause);
  li.addEventListener('pointerleave', resume);
  li.addEventListener('focusin', pause);
  li.addEventListener('focusout', resume);
  const onVis = () => (document.hidden ? pause() : resume());
  document.addEventListener('visibilitychange', onVis);

  let gone = false;
  function dismiss() {
    if (gone) return;
    gone = true;
    li.dataset.leaving = '1';
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVis);
    const a = animate(li, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(6px) scale(0.98)' }], {
      duration: 140,
      easing: 'ease',
      fill: 'forwards',
    });
    const remove = () => flipSiblings(h, () => li.remove());
    if (a) a.finished.then(remove, remove);
    else remove();
  }
  li.__kDismiss = dismiss;
  return { dismiss, el: li };
}

/* Swipe rows ----------------------------------------------------------- */

let openSwipe = null;

function settleRow(row, to, velocity = 0) {
  const from = currentX(row);
  row.__kAnim?.cancel();
  const dist = to - from;
  const sp = spring({ ...springs.snappy, velocity: dist ? velocity / dist : 0 });
  row.style.transform = `translateX(${to}px)`;
  row.__kAnim = animate(row, [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], {
    duration: sp.duration,
    easing: sp.easing,
  });
  row.closest('.k-swipe').dataset.open = to === 0 ? '' : to > 0 ? 'start' : 'end';
}

function currentX(el) {
  const m = getComputedStyle(el).transform;
  if (!m || m === 'none') return 0;
  return new DOMMatrixReadOnly(m).m41;
}

function actionsWidth(wrap, side) {
  const a = wrap.querySelector(`.k-swipe-actions[data-side="${side}"]`) ||
    (side === 'end' ? wrap.querySelector('.k-swipe-actions:not([data-side])') : null);
  if (!a) return 0;
  return [...a.children].reduce((w, c) => w + c.getBoundingClientRect().width, 0);
}

/** Drag-to-reveal row actions on every .k-swipe. Flick or drag past half. */
export function swipeRows(root = document) {
  root.querySelectorAll('.k-swipe').forEach((wrap) => {
    if (wrap.dataset.kBound) return;
    wrap.dataset.kBound = '1';
    const row = wrap.querySelector(':scope > .k-row');
    if (!row) return;
    wrap.style.setProperty('--k-end-n', wrap.querySelectorAll('.k-swipe-actions:not([data-side="start"]) .k-swipe-action').length);
    // Back on the row itself: close the actions it opened.
    row.addEventListener('focusin', () => currentX(row) && settleRow(row, 0));
    // Keyboard users reach the actions by tabbing; reveal them on focus.
    wrap.querySelectorAll('.k-swipe-action').forEach((btn) => {
      btn.addEventListener('focus', () => {
        const side = btn.closest('.k-swipe-actions').dataset.side === 'start' ? 'start' : 'end';
        settleRow(row, side === 'start' ? actionsWidth(wrap, 'start') : -actionsWidth(wrap, 'end'));
      });
      btn.addEventListener('blur', (e) => {
        if (!wrap.contains(e.relatedTarget)) settleRow(row, 0);
      });
    });
    // The click that ends a drag is not a tap on the row.
    row.addEventListener(
      'click',
      (ce) => {
        if (performance.now() - (row.__kDragEnd || -1e9) < 350) {
          ce.preventDefault();
          ce.stopPropagation();
        }
      },
      true,
    );
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (openSwipe && openSwipe !== row) settleRow(openSwipe, 0);
      const startX = e.clientX;
      const startY = e.clientY;
      const base = currentX(row);
      const maxStart = actionsWidth(wrap, 'start');
      const maxEnd = actionsWidth(wrap, 'end');
      let locked = null;
      let last = { x: e.clientX, t: e.timeStamp };
      let prev = last;
      // Long-press opens the actions without dragging (WCAG 2.5.7).
      const press =
        e.pointerType === 'touch'
          ? setTimeout(() => {
              locked = 'press';
              const to = maxEnd ? -maxEnd : maxStart;
              if (!to) return;
              settleRow(row, to);
              openSwipe = row;
              haptic('long');
              row.__kDragEnd = performance.now() + 400;
            }, 480)
          : null;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!locked) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          clearTimeout(press);
          locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
          if (locked === 'x') {
            row.setPointerCapture(ev.pointerId);
            wrap.setAttribute('data-k-dragging', '');
            row.__kAnim?.cancel();
          }
        }
        if (locked !== 'x') return;
        let x = base + dx;
        // Friction past the action width, and none at all where there are no actions.
        if (x > maxStart) x = maxStart + (maxStart ? Math.sqrt(x - maxStart) * 3 : 0);
        if (x < -maxEnd) x = -maxEnd - (maxEnd ? Math.sqrt(-maxEnd - x) * 3 : 0);
        row.style.transform = `translateX(${x}px)`;
        prev = last;
        last = { x: ev.clientX, t: ev.timeStamp };
      };
      const up = () => {
        clearTimeout(press);
        row.removeEventListener('pointermove', move);
        row.removeEventListener('pointerup', up);
        row.removeEventListener('pointercancel', up);
        wrap.removeAttribute('data-k-dragging');
        if (locked !== 'x') return;
        const v = (last.x - prev.x) / Math.max(1, last.t - prev.t); // px/ms
        const x = currentX(row);
        // A flick decides by direction; a slow drag by how far it got.
        const fast = Math.abs(v) > 0.11;
        let to = 0;
        if (x > 0 && maxStart) to = (fast ? v > 0 : x > maxStart / 2) ? maxStart : 0;
        if (x < 0 && maxEnd) to = (fast ? v < 0 : -x > maxEnd / 2) ? -maxEnd : 0;
        settleRow(row, to, v * 1000);
        openSwipe = to ? row : null;
        if (to) haptic('select');
        row.__kDragEnd = performance.now();
      };
      row.addEventListener('pointermove', move);
      row.addEventListener('pointerup', up);
      row.addEventListener('pointercancel', up);
    });
  });
  if (!document.__kSwipeDoc) {
    document.__kSwipeDoc = true;
    document.addEventListener('pointerdown', (e) => {
      if (openSwipe && !openSwipe.closest('.k-swipe').contains(e.target)) {
        settleRow(openSwipe, 0);
        openSwipe = null;
      }
    });
  }
}

/* Segmented control and tabs: a sliding thumb or ink ------------------- */

function place(indicator, target, container) {
  const c = container.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  indicator.style.setProperty('--x', `${r.left - c.left + container.scrollLeft - container.clientLeft}px`);
  indicator.style.setProperty('--w', `${r.width}px`);
}

export function segmented(root = document) {
  root.querySelectorAll('.k-seg').forEach((seg) => {
    if (seg.dataset.kReady) return;
    let thumb = seg.querySelector('.k-seg-thumb');
    if (!thumb) {
      thumb = document.createElement('span');
      thumb.className = 'k-seg-thumb';
      thumb.setAttribute('aria-hidden', 'true');
      seg.prepend(thumb);
    }
    const sync = () => {
      const checked = seg.querySelector('input:checked')?.closest('label');
      if (checked) place(thumb, checked, seg);
    };
    sync();
    seg.dataset.kReady = '1';
    seg.addEventListener('change', () => {
      seg.dataset.kMoved = '1';
      sync();
      haptic('select');
    });
    new ResizeObserver(sync).observe(seg);
  });
}

export function tabs(root = document) {
  root.querySelectorAll('.k-tabs').forEach((list) => {
    if (list.dataset.kReady) return;
    let ink = list.querySelector('.k-tabs-ink');
    if (!ink) {
      ink = document.createElement('span');
      ink.className = 'k-tabs-ink';
      ink.setAttribute('aria-hidden', 'true');
      list.append(ink);
    }
    const all = () => [...list.querySelectorAll('[role="tab"]')];
    const sync = () => {
      const sel = list.querySelector('[role="tab"][aria-selected="true"]');
      if (sel) place(ink, sel, list);
    };
    const select = (tab, focus) => {
      for (const t of all()) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = t.getAttribute('aria-controls') && document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      }
      if (focus) tab.focus();
      list.dataset.kMoved = '1';
      sync();
      list.dispatchEvent(new CustomEvent('k-tab', { detail: { tab }, bubbles: true }));
    };
    all().forEach((t) => {
      t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1;
      const panel = t.getAttribute('aria-controls') && document.getElementById(t.getAttribute('aria-controls'));
      if (panel && !panel.hasAttribute('tabindex')) panel.tabIndex = 0;
    });
    list.addEventListener('click', (e) => {
      const t = e.target.closest('[role="tab"]');
      if (t) select(t);
    });
    list.addEventListener('keydown', (e) => {
      const ts = all();
      const i = ts.indexOf(document.activeElement);
      if (i < 0) return;
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % ts.length;
      if (e.key === 'ArrowLeft') j = (i - 1 + ts.length) % ts.length;
      if (e.key === 'Home') j = 0;
      if (e.key === 'End') j = ts.length - 1;
      if (j != null) {
        e.preventDefault();
        select(ts[j], true); // keyboard: no animation needed, it is instant anyway
      }
    });
    sync();
    list.dataset.kReady = '1';
    new ResizeObserver(sync).observe(list);
  });
}

/* Disabled controls that say why --------------------------------------- */

let whyEl;
let whyTimer;
let whyN = 0;
const WHY = '[aria-disabled="true"][data-why]';

function hideWhy() {
  clearTimeout(whyTimer);
  whyEl?.remove();
  whyEl = null;
}

/**
 * aria-disabled="true" plus data-why="Add an amount first": the reason is the
 * control's description for screen readers, and shows as a popover on tap
 * (3s) or on keyboard focus (until focus leaves or Esc).
 */
export function disabledWhy(root = document) {
  // Describe every reason, including ones rendered since the last call.
  root.querySelectorAll(WHY).forEach((ctl) => {
    let d = ctl.__kWhyNode;
    if (!d) {
      d = ctl.__kWhyNode = document.createElement('span');
      d.id = `k-why-${++whyN}`;
      d.hidden = true;
      ctl.after(d);
      ctl.setAttribute('aria-describedby', [ctl.getAttribute('aria-describedby'), d.id].filter(Boolean).join(' '));
    }
    d.textContent = ctl.dataset.why;
  });
  if (document.__kWhy) return;
  document.__kWhy = true;
  const show = (ctl, sticky) => {
    hideWhy();
    whyEl = document.createElement('div');
    whyEl.className = 'k-why';
    whyEl.textContent = ctl.dataset.why;
    const parent = layer();
    parent.append(whyEl);
    const r = ctl.getBoundingClientRect();
    const w = whyEl.getBoundingClientRect();
    const box = parent === document.body ? { left: -scrollX, top: -scrollY } : parent.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - w.width - 8, r.left + r.width / 2 - w.width / 2));
    whyEl.style.left = `${left - box.left}px`;
    whyEl.style.top = `${r.bottom + 8 - box.top}px`;
    animate(whyEl, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], {
      duration: 160,
      easing: EASE_OUT,
    });
    if (!sticky) whyTimer = setTimeout(hideWhy, 3200);
  };
  document.addEventListener(
    'click',
    (e) => {
      const ctl = e.target.closest?.(WHY);
      if (!ctl) return;
      e.preventDefault();
      e.stopPropagation();
      haptic('warn');
      show(ctl, false);
      announce(ctl.dataset.why);
    },
    true,
  );
  document.addEventListener('focusin', (e) => {
    const ctl = e.target.closest?.(WHY);
    if (ctl && ctl.matches(':focus-visible')) show(ctl, true);
  });
  document.addEventListener('focusout', (e) => e.target.closest?.(WHY) && hideWhy());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && whyEl && hideWhy());
}

/* Count-up for a freshly written number -------------------------------- */

/**
 * Count an element's number up to `to` in under 600ms. Only for a value the
 * user just changed, never for live-refreshing values. format(n) -> string.
 */
export function countUp(el, to, { from = 0, duration = 520, format = (n) => Math.round(n).toLocaleString('en-AU') } = {}) {
  if (!el) return;
  if (reducedMotion()) {
    el.textContent = format(to);
    return;
  }
  // A keyframe-less animation is the clock, so the count can be seeked or
  // finished like every other animation in the kit.
  const clock = el.animate([], { duration });
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  const step = () => {
    const t = clock.playState === 'finished' ? 1 : Math.min(1, (clock.currentTime || 0) / duration);
    el.textContent = format(from + (to - from) * ease(t));
    if (t < 1) requestAnimationFrame(step);
  };
  step();
  clock.finished.then(step, () => {});
  return clock;
}

/* Hero: shared-element move between two states ------------------------- */

/**
 * FLIP an element from a previous rect to where it is now.
 *   const first = card.getBoundingClientRect();
 *   ...swap to the detail view...
 *   hero(detailHeader, first);
 * Under 350ms, spring with a little give; a crossfade under reduced motion.
 */
export function hero(el, firstRect) {
  if (!el || !firstRect) return null;
  const last = el.getBoundingClientRect();
  const dx = firstRect.left - last.left;
  const dy = firstRect.top - last.top;
  const sx = firstRect.width / Math.max(1, last.width);
  const sy = firstRect.height / Math.max(1, last.height);
  const sp = spring(springs.hero);
  return animate(
    el,
    [
      { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.6 },
      { transformOrigin: 'top left', transform: 'none', opacity: 1 },
    ],
    { duration: Math.min(sp.duration, 350), easing: sp.easing },
  );
}

/* Composer: Enter sends, Shift+Enter newlines, IME safe ----------------- */

/**
 * Wire a .k-composer. onSend(text) is called on Enter or the send button.
 * The send button is disabled while there is nothing to send.
 */
export function composer(el, { onSend } = {}) {
  if (!el || el.dataset.kBound) return;
  el.dataset.kBound = '1';
  const input = el.querySelector('.k-composer-input');
  const send = el.querySelector('.k-send');
  const sync = () => {
    if (send && send.dataset.mode !== 'stop') send.disabled = !input.value.trim();
  };
  input?.addEventListener('input', sync);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (input.value.trim()) submit();
    }
  });
  send?.addEventListener('click', () => {
    if (send.dataset.mode === 'stop') return;
    submit();
  });
  function submit() {
    const text = input.value.trim();
    if (!text) return;
    onSend?.(text);
    input.value = '';
    sync();
    haptic('light');
  }
  sync();
}

/* Density ---------------------------------------------------------------- */

const phoneQuery = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse), (max-width: 699.98px)') : null;

/**
 * 'phone' or 'desktop': the density kit.css is using for an element (the page
 * by default). data-density on it or an ancestor wins; otherwise a coarse
 * pointer or a viewport under 700px means phone.
 */
export function density(el) {
  const forced = (el ?? document.documentElement)?.closest?.('[data-density]')?.dataset.density;
  if (forced === 'phone' || forced === 'desktop') return forced;
  return phoneQuery?.matches ? 'phone' : 'desktop';
}

/* Progressive disclosure: animated details, show more ------------------- */

const DISCLOSE_DUR = 260;

// Height from its current value to a target, interruptible: a running
// animation is read where it is and replaced, so a second tap reverses it.
function slideHeight(el, from, to, done) {
  el.__kSlide?.cancel();
  if (reducedMotion()) {
    const a = el.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 150, easing: 'ease' });
    done?.();
    return a;
  }
  const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration: Math.min(DISCLOSE_DUR, 140 + Math.abs(to - from) * 0.5),
    easing: EASE_OUT,
  });
  el.__kSlide = a;
  el.style.overflow = 'clip';
  a.onfinish = () => {
    el.style.overflow = '';
    el.__kSlide = null;
    done?.();
  };
  a.oncancel = () => {
    el.style.overflow = '';
  };
  return a;
}

/**
 * details.k-disclosure open and close with a height animation instead of a
 * jump. Native details stays in charge of state, keyboard (Enter, Space on
 * the summary) and what screen readers announce.
 */
export function disclosure(root = document) {
  root.querySelectorAll('details.k-disclosure').forEach((d) => {
    if (d.__kDisclosure) return;
    d.__kDisclosure = true;
    const head = d.querySelector(':scope > summary');
    if (!head) return;
    head.addEventListener('click', (e) => {
      e.preventDefault();
      const closing = d.open && !d.hasAttribute('data-k-closing');
      const from = d.getBoundingClientRect().height;
      if (closing) {
        d.setAttribute('data-k-closing', '');
        const to = head.getBoundingClientRect().height + (parseFloat(getComputedStyle(d).borderTopWidth) || 0) * 2;
        slideHeight(d, from, to, () => {
          d.removeAttribute('data-k-closing');
          d.open = false;
        });
      } else {
        d.removeAttribute('data-k-closing');
        d.open = true;
        const to = d.getBoundingClientRect().height;
        slideHeight(d, from, to);
        haptic('select');
      }
    });
  });
}

/**
 * .k-more blocks: clamp the text to --k-more-lines only when it overflows,
 * with a Show more button that expands it in place. Never hides text with no
 * way to read it: no JS means no clamp.
 */
export function more(root = document) {
  root.querySelectorAll('.k-more').forEach((box) => {
    if (box.__kMore) return;
    const text = box.querySelector('.k-more-text');
    if (!text) return;
    box.__kMore = true;
    let btn = box.querySelector('.k-more-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'k-more-btn';
      btn.innerHTML = `<span>Show more</span>${svg('chev-down')}`;
      box.append(btn);
    }
    if (!text.id) text.id = `k-more-${++moreN}`;
    btn.setAttribute('aria-controls', text.id);
    const label = btn.querySelector('span') ?? btn;
    const sync = () => {
      if (btn.getAttribute('aria-expanded') === 'true') return;
      box.setAttribute('data-k-clamped', '');
      const overflows = text.scrollHeight > text.clientHeight + 1;
      if (!overflows) box.removeAttribute('data-k-clamped');
      btn.hidden = !overflows;
      btn.setAttribute('aria-expanded', 'false');
    };
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      const from = text.getBoundingClientRect().height;
      if (open) {
        box.removeAttribute('data-k-clamped');
        btn.setAttribute('aria-expanded', 'true');
        label.textContent = 'Show less';
        slideHeight(text, from, text.getBoundingClientRect().height);
      } else {
        box.setAttribute('data-k-clamped', '');
        const to = text.getBoundingClientRect().height;
        box.removeAttribute('data-k-clamped');
        btn.setAttribute('aria-expanded', 'false');
        label.textContent = 'Show more';
        // Stay unclamped while the height closes over the text, clamp at the end.
        slideHeight(text, from, to, () => box.setAttribute('data-k-clamped', ''));
      }
    });
    box.setAttribute('data-k-ready', '');
    sync();
    new ResizeObserver(sync).observe(text);
  });
}
let moreN = 0;

/* Top bar hairline once the page scrolls -------------------------------- */

export function topbar(root = document) {
  const bars = root.querySelectorAll('.k-topbar');
  if (!bars.length || document.__kTopbar) return;
  document.__kTopbar = true;
  const sync = () => bars.forEach((b) => b.toggleAttribute('data-scrolled', scrollY > 2));
  addEventListener('scroll', sync, { passive: true });
  sync();
}

/* Offline banner -------------------------------------------------------- */

/** Show [data-k-offline] elements only while the browser is offline. */
export function offline(root = document) {
  const els = root.querySelectorAll('[data-k-offline]');
  if (!els.length) return;
  const sync = () =>
    els.forEach((el) => {
      const was = el.hidden;
      el.hidden = navigator.onLine;
      if (was && !el.hidden) animate(el, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE_OUT });
    });
  // Hidden content is not announced, so the change is spoken separately.
  addEventListener('online', () => {
    sync();
    announce('Back online');
  });
  addEventListener('offline', () => {
    sync();
    announce(els[0].textContent.trim().replace(/\s+/g, ' '));
  });
  sync();
}

/**
 * True when a click lands on a control that is itself busy: a button (or
 * role=button) with aria-busy="true", or a submit control inside a form with
 * aria-busy="true". Ancestors that are merely busy regions do not count, and
 * neither do links.
 */
function isBusyActivation(target) {
  const control = target?.closest?.('button, [role="button"]:not(a), input[type="submit"], input[type="image"], input[type="button"]');
  if (control?.getAttribute('aria-busy') === 'true') return true;
  const form = target?.closest?.('form');
  if (form?.getAttribute('aria-busy') !== 'true') return false;
  // Enter in a field arrives as a click on the form's default submit button.
  return !!control && control.matches('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]') && control.form === form;
}

/* init: wire every data hook -------------------------------------------- */

/**
 * Wire the page. Safe to call again after rendering new content.
 *   [data-k-open="id"]   opens the sheet or dialog with that id
 *   [data-k-close]       closes the sheet or dialog it is inside
 *   [data-k-stagger]     staggers its children in once
 *   .k-swipe, .k-seg, .k-tabs, .k-topbar, [data-k-offline], data-why,
 *   details.k-disclosure, .k-more
 */
export function init(root = document) {
  root.querySelectorAll('dialog.k-sheet').forEach(bindSheet);
  root.querySelectorAll('dialog.k-dialog').forEach(bindDialog);
  liveNode('polite');
  liveNode('assertive');
  if (!document.__kClicks) {
    document.__kClicks = true;
    // A busy button or form ignores clicks and Enter until its request settles.
    // Only the busy control itself: a busy region (a chat log mid-stream) stays
    // clickable, and links and scrolling are never touched.
    document.addEventListener(
      'click',
      (e) => {
        if (isBusyActivation(e.target)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
    document.addEventListener('click', (e) => {
      const opener = e.target.closest?.('[data-k-open]');
      if (opener && opener.getAttribute('aria-disabled') !== 'true') {
        const target = document.getElementById(opener.dataset.kOpen);
        if (target?.classList.contains('k-sheet')) {
          bindSheet(target);
          openSheet(target);
        } else if (target?.classList.contains('k-dialog')) {
          bindDialog(target);
          openDialog(target);
        }
        return;
      }
      const closer = e.target.closest?.('[data-k-close]');
      if (closer) {
        const d = closer.closest('dialog');
        if (d?.classList.contains('k-sheet')) closeSheet(d);
        else if (d?.classList.contains('k-dialog')) closeDialog(d, closer.value || closer.dataset.kClose || '');
      }
    });
  }
  reveal(root);
  swipeRows(root);
  segmented(root);
  tabs(root);
  disabledWhy(root);
  disclosure(root);
  more(root);
  topbar(root);
  offline(root);
}

export default { init, toast, announce, haptic, spring, animate, reveal, openSheet, closeSheet, openDialog, closeDialog, swipeRows, segmented, tabs, disclosure, more, density, countUp, hero, composer, reducedMotion };
