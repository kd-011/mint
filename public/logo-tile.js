// The icon tile on a merchant row: the merchant's logo when the server has one
// cached, otherwise a letter tile tinted from a hash of the name. Transfers and
// nameless rows keep the icon they had. The letter always sits under the
// image, so a logo that fails to load (or is offline and uncached) leaves a
// tile instead of a hole, and nothing moves while it loads. Pure string
// building, so the same file runs in the page and in tests. The page CSP
// forbids inline style and handlers, so the tint is a class and the load and
// error events are caught on the list (they do not bubble, so in the capture phase).
'use strict';

// The image class is `lgi`, not `lg`: `.lg` is the chart legend pill (min-height 44px, border, padding), which used to bleed onto logos and stretch them.
const HUES = 12;
const lgEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Logos already shown this session skip the fade, so a row scrolling back into view does not flicker.
const logoSeen = new Set();

// FNV-1a over the lower-cased, trimmed name: the same merchant always lands on the same tint.
function tileHue(name) {
  let h = 2166136261;
  for (const ch of String(name ?? '').trim().toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return (h >>> 0) % HUES;
}

function merchantInitial(name) {
  const m = /[\p{L}\p{N}]/u.exec(String(name ?? ''));
  return m ? m[0].toUpperCase() : '';
}

// bank: true is a bank's mark (Home's account rows): see wireLogoTiles for how it is fitted.
function logoTile({ name, logo, transfer = false, icon = '', bank = false }) {
  const letter = merchantInitial(name);
  if (transfer || !letter) return `<div class="ic">${icon}</div>`;
  const img = logo ? `<img class="lgi${logoSeen.has(logo) ? ' seen' : ''}" src="${lgEsc(logo)}" alt="" loading="lazy" decoding="async" draggable="false">` : '';
  return `<div class="ic lt lt${tileHue(name)}${bank ? ' bk' : ''}"><span class="lc" aria-hidden="true">${lgEsc(letter)}</span>${img}</div>`;
}

// A bank's icon is either a full-bleed square (Bankwest's orange, NAB's black) or a bare mark on nothing (ANZ).
// Left alone they sit at different sizes inset in a pale circle. The four corners say which it is: opaque in all
// four is full-bleed and fills the tile; anything else is a mark and sits inset on the neutral tile. Same-origin,
// so the canvas can be read; if it cannot (or there is no canvas), the mark treatment is the safe default.
function logoIsBleed(img) {
  try {
    const n = 16;
    const c = document.createElement('canvas');
    c.width = n; c.height = n;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, n, n);
    return [[0, 0], [n - 1, 0], [0, n - 1], [n - 1, n - 1]].every(([x, y]) => g.getImageData(x, y, 1, 1).data[3] > 200);
  } catch { return false; }
}

function wireLogoTiles(root) {
  root.addEventListener('load', (e) => {
    const img = e.target;
    if (img.tagName !== 'IMG' || !img.classList.contains('lgi')) return;
    if (img.closest('.bk')) img.classList.add(logoIsBleed(img) ? 'bleed' : 'mark');
    img.classList.add('on');
    logoSeen.add(img.getAttribute('src'));
  }, true);
  root.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.classList.contains('lgi')) img.remove();
  }, true);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { HUES, tileHue, merchantInitial, logoTile, logoIsBleed, wireLogoTiles };
