// Mint SPA core: helpers, formatting, icons, network with retry, the offline
// write queue, cached reads, toasts, sheets, undo, forms. Classic scripts share
// one scope, so every screen file below sees these names. No build step.
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const desktop = matchMedia('(min-width: 1024px)');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch {} };

// ---------- formatting ----------

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
const AUD0 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
// Every dollar on screen comes out of these. With demo mode on, demoCents scales
// it by the one global factor (public/demo-math.js), so no screen needs to know.
const money = (cents) => (cents == null ? 'No balance yet' : AUD.format(demoCents(cents) / 100));
const money0 = (cents) => AUD0.format(demoCents(cents ?? 0) / 100);
const signed = (cents) => (cents > 0 ? `+${AUD.format(demoCents(cents) / 100)}` : AUD.format(demoCents(cents) / 100));
// A manual account's own currency (hundredths of its unit, whatever its decimals): "USD 1,000.00",
// "€12.50", "JPY 1,200". AUD comes out as money() does. Scaled by demo mode like every other dollar.
const CUR_FMT = new Map();
const curFmt = (cur) => {
  if (!CUR_FMT.has(cur)) { try { CUR_FMT.set(cur, new Intl.NumberFormat('en-AU', { style: 'currency', currency: cur })); } catch { CUR_FMT.set(cur, null); } }
  return CUR_FMT.get(cur);
};
function moneyIn(cents, cur) {
  if (!cur || cur === 'AUD') return money(cents);
  if (cents == null) return 'No balance yet';
  const f = curFmt(cur);
  const v = demoCents(cents) / 100;
  return f ? f.format(v) : `${cur} ${v.toFixed(2)}`;
}
const signedIn = (cents, cur) => (cents > 0 ? `+${moneyIn(cents, cur)}` : moneyIn(cents, cur));
function compact(cents) {
  const shown = demoCents(cents);
  const d = Math.abs(shown) / 100;
  const s = d >= 1e6 ? `${(d / 1e6).toFixed(d >= 1e7 ? 0 : 1)}m` : d >= 1e4 ? `${Math.round(d / 1e3)}k` : d >= 1e3 ? `${(d / 1e3).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(d));
  return `${shown < 0 ? '-' : ''}$${s}`;
}
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
// The server's MINT_TZ zone, stamped into this file when the shell is served, so every date here is the server's day, not the
// device's, and the cached shell keeps the same zone offline. Unstamped (a raw checkout) it falls back to the device zone.
const MINT_TZ = '__TZ__';
const ZONE = MINT_TZ.startsWith('__') ? undefined : MINT_TZ;
const ZONE_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const zoneClock = (ts) => new Date(ts).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: ZONE });
const todayIso = () => ZONE_DATE.format(new Date());
const isoOffset = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthShort = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1];
const monthLabel = (ym) => `${MONTHS_LONG[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const addMonth = (ym, n) => { const t = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1)); return t.toISOString().slice(0, 7); };
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayLabel(iso) {
  const t = todayIso();
  if (iso === t) return 'Today';
  if (iso === isoOffset(t, -1)) return 'Yesterday';
  return `${WD[new Date(`${iso}T00:00:00Z`).getUTCDay()]} ${dmy(iso)}`;
}
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return dmy(ZONE_DATE.format(new Date(ts)));
}
function inDays(iso) {
  const n = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86400000);
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n > 0 ? `in ${n} days` : n === -1 ? 'yesterday' : `${-n} days ago`;
}
const titleCase = (s) => String(s ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const pct = (r) => (r == null || r === '' ? null : `${(Number(r) * 100).toFixed(2)}%`);
const TYPE_LABEL = { transaction: 'Transaction', 'credit-card': 'Credit card', loan: 'Loan', savings: 'Savings' };
const fyOfIso = (iso) => Number(iso.slice(0, 4)) + (Number(iso.slice(5, 7)) >= 7 ? 1 : 0);
const fyLabel = (fy) => `FY ${fy - 1}-${String(fy).slice(2)}`;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`;

// A typed dollar amount to whole cents; NaN when it is not a sensible amount.
function parseMoney(str) {
  const s = String(str ?? '').replace(/[\s$,]/g, '');
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) return NaN;
  return Math.round(demoUnscale(Number(s) * 100, demo));
}
// A dollar amount (not cents) prefilled into a field, scaled like everything else.
const dollarsIn = (d) => (demo.on && d != null && d !== '' ? String(Math.round(demoScale(Number(d), demo) * 10000) / 10000) : d ?? '');
const centsToInput = (c) => (c == null ? '' : (demoCents(c) / 100).toFixed(2));
// A price per unit in dollars (not cents), scaled like the value it multiplies into.
const unitPrice = (p, cur) => `${cur === 'USD' ? 'US$' : '$'}${Number(demoScale(Number(p), demo)).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

// ---------- icons ----------

const ic = (d, sw = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  home: ic('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>'),
  list: ic('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
  target: ic('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  receipt: ic('<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/>'),
  bank: ic('<path d="M3 10 12 4l9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 21h18"/>'),
  chart: ic('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  wallet: ic('<path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7V6a2 2 0 0 1 2-2h11"/><circle cx="16.5" cy="13.5" r="1.2"/>'),
  card: ic('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>'),
  house: ic('<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-5h4v5"/>'),
  refresh: ic('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  search: ic('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
  x: ic('<path d="M6 6l12 12M18 6 6 18"/>'),
  alert: ic('<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>'),
  off: ic('<path d="M2 2l20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4-2.3M19 13a10 10 0 0 0-2.6-1.8M2 8.8a15 15 0 0 1 5-2.8M22 8.8a15 15 0 0 0-10-3.8"/>'),
  tick: '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg>',
  leaf: ic('<path d="M12 3C7 7 5 11.5 6 15.5 7 19 9.3 20.6 12 21c2.7-.4 5-2 6-5.5 1-4-1-8.5-6-12.5z"/><path d="M12 7v14"/>'),
  lock: ic('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  fingerprint: ic('<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>'),
  compass: ic('<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>'),
  plus: ic('<path d="M12 5v14M5 12h14"/>'),
  reorder: ic('<path d="M8 4v16M8 4 4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5"/>'),
  filter: ic('<path d="M3 5h18l-7 8v6l-4-2v-4z"/>'),
  chat: ic('<path d="M21 12a8 8 0 0 1-11.7 7.1L4 20.5l1.4-4.7A8 8 0 1 1 21 12z"/><path d="M8.5 11.5h7M8.5 14.5h4"/>'),
  tag: ic('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/>'),
  camera: ic('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/>'),
  file: ic('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>'),
  chevron: ic('<path d="m9 6 6 6-6 6"/>'),
  grip: ic('<circle cx="9" cy="6" r="1.1"/><circle cx="15" cy="6" r="1.1"/><circle cx="9" cy="12" r="1.1"/><circle cx="15" cy="12" r="1.1"/><circle cx="9" cy="18" r="1.1"/><circle cx="15" cy="18" r="1.1"/>', 2.2),
  chevUp: ic('<path d="m6 15 6-6 6 6"/>', 2.2),
  chevDown: ic('<path d="m6 9 6 6 6-6"/>', 2.2),
  back: ic('<path d="m15 6-6 6 6 6"/>'),
  check: ic('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 2.4),
  swap: ic('<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>'),
  repeat: ic('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>'),
  download: ic('<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>'),
  trash: ic('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  edit: ic('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  rules: ic('<path d="M4 6h10M4 12h16M4 18h8"/><circle cx="18" cy="6" r="2"/><circle cx="16" cy="18" r="2"/>'),
  chartLine: ic('<path d="M3 17l5-6 4 3 8-9"/><path d="M3 21h18"/>'),
  table: ic('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>'),
  select: ic('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>'),
  briefcase: ic('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>'),
  piggy: ic('<path d="M5 11a7 7 0 0 1 12-3l3-1v5l-1.5 1.5L18 17h-3v-2H9v2H6z"/><circle cx="15" cy="10" r=".8"/>'),
  dots: ic('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>', 2.2),
  bell: ic('<path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4z"/><path d="M10 21h4"/>'),
  income: ic('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 18h16v3H4z"/>'),
  calendar: ic('<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  sliders: ic('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  flag: ic('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  user: ic('<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  more: ic('<path d="m6 9 6 6 6-6"/>'),
  cart: ic('<path d="M3 4h2.5l2 11h10l2-8H7"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>'),
  utensils: ic('<path d="M7 3v8M4.5 3v5a2.5 2.5 0 0 0 5 0V3M7 11v10M17 21V3c-2.2 1.6-3 4.5-3 8h3"/>'),
  car: ic('<path d="M5 16V12l1.7-4.6A2 2 0 0 1 8.6 6h6.8a2 2 0 0 1 1.9 1.4L19 12v4"/><path d="M3.5 16h17v3h-17zM5 12h14"/><circle cx="7.5" cy="14" r=".6"/><circle cx="16.5" cy="14" r=".6"/>'),
  bolt: ic('<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z"/>'),
  bag: ic('<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
  heart: ic('<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>'),
  plane: ic('<path d="M10.5 13.5 3 11l1.2-1.6 8 .6 4-5a1.7 1.7 0 0 1 2.7 2L15.6 13l.6 8-1.6 1.2-2.5-7.5-3.5 3.3-1.6-1z"/>'),
  film: ic('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5"/>'),
  gift: ic('<rect x="3.5" y="9" width="17" height="11" rx="2"/><path d="M3.5 13h17M12 9v11M12 9c-1.5-4-5.5-3.5-5-1 .3 1.5 2.5 1 5 1zM12 9c1.5-4 5.5-3.5 5-1-.3 1.5-2.5 1-5 1z"/>'),
  phone: ic('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.500h2"/>'),
  paw: ic('<circle cx="7" cy="10" r="1.8"/><circle cx="17" cy="10" r="1.8"/><circle cx="10" cy="6" r="1.8"/><circle cx="14" cy="6" r="1.8"/><path d="M12 12.500c-3 0-5 2.5-5 4.5 0 1.7 1.5 2.5 3 2.5 1 0 1.5-.5 2-.5s1 .5 2 .5c1.5 0 3-.8 3-2.5 0-2-2-4.5-5-4.500z"/>'),
  wrench: ic('<path d="M14.5 6.500a4 4 0 0 0-5.2 5.200L3.5 17.500a1.8 1.8 0 0 0 2.5 2.500l5.8-5.800a4 4 0 0 0 5.2-5.200l-2.5 2.5-2.3-.5-.5-2.300z"/>'),
  coffee: ic('<path d="M4 9h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M16 10h1.500a2.5 2.5 0 0 1 0 5H16M7 3v3M11 3v3"/>'),
  up: ic('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: ic('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  clock: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  keyboard: ic('<rect x="2.5" y="6" width="19" height="12" rx="3"/><path d="M6.500 10h.01M10 10h.01M14 10h.01M17.500 10h.01M7.500 14h9"/>'),
  bookmark: ic('<path d="M6.500 3h11v18l-5.500-4-5.500 4z"/>'),
  gear: ic('<circle cx="12" cy="12" r="3"/><path d="M12 2.500v3M12 18.500v3M2.500 12h3M18.500 12h3M5.300 5.300l2.100 2.100M16.600 16.600l2.100 2.100M18.700 5.300l-2.100 2.100M7.400 16.600l-2.100 2.100"/>'),
  grid: ic('<rect x="4" y="4" width="6.5" height="6.5" rx="2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2"/>'),
};
const TYPE_ICON = { transaction: I.wallet, 'credit-card': I.card, loan: I.house };

// A category's icon: by name first, then its group, else a neutral grid. Keys are tested in order.
const CAT_ICON = [
  [/grocer/i, 'cart'], [/eating|takeaway|alcohol|restaurant|cafe/i, 'utensils'], [/fuel|parking|toll|rego|car |transport|rideshare|taxi/i, 'car'],
  [/utilit|electric|energy|water|gas/i, 'bolt'], [/phone|internet|mobile/i, 'phone'], [/rent|home|insurance|mortgage/i, 'house'],
  [/shop|clothing|electronic/i, 'bag'], [/medic|pharm|fitness|health|personal care/i, 'heart'], [/travel|flight|holiday/i, 'plane'],
  [/entertain|subscri|games|stream/i, 'film'], [/gift|donat|charit/i, 'gift'], [/pet/i, 'paw'], [/educat|school|course/i, 'target'],
  [/debt|loan|interest|fee|card|bank/i, 'card'], [/business|work/i, 'briefcase'], [/cash/i, 'wallet'], [/government|tax/i, 'receipt'],
  [/service|maint|repair/i, 'wrench'], [/saving|invest/i, 'piggy'],
];
const catIcon = (name = '', grp = '') => {
  const hit = CAT_ICON.find(([re]) => re.test(name)) ?? CAT_ICON.find(([re]) => re.test(grp));
  return hit ? I[hit[1]] : I.grid;
};

// A card or section heading that folds its body away. State persists per id.
function collapsible(id, title, { meta = '', body = '', open = true } = {}) {
  const on = store.get(`sec:${id}`) ?? open;
  return `<section class="csec ${on ? 'open' : ''}" data-csec="${esc(id)}"><button class="sech" type="button" aria-expanded="${on}" aria-controls="csec-${esc(id)}"><span class="sech-t">${esc(title)}</span>${meta ? `<span class="sech-m">${meta}</span>` : ''}<span class="caret">${I.chevron}</span></button><div class="abody csec-body" id="csec-${esc(id)}"><div class="abody-in"><div class="csec-in">${body}</div></div></div></section>`;
}
function wireCollapsibles(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.sech');
    if (!b || !root.contains(b)) return;
    const sec = b.closest('[data-csec]');
    const on = !sec.classList.contains('open');
    sec.classList.toggle('open', on);
    b.setAttribute('aria-expanded', String(on));
    store.set(`sec:${sec.dataset.csec}`, on);
    buzz(6);
  });
}

// The header every summary card starts with: an icon tile, a title, and one small right-hand slot.
const cardHead = (icon, title, right = '') => `<div class="card-h"><span class="card-ic">${icon}</span><h3 class="card-t">${esc(title)}</h3>${right ? `<span class="card-r">${right}</span>` : ''}</div>`;

// ---------- storage ----------

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`mint:${k}`)); } catch { return null; } },
  set(k, v) {
    try { localStorage.setItem(`mint:${k}`, JSON.stringify(v)); return true; } catch {
      // Out of room: drop the cached reads (the queue and drafts matter more) and try once more.
      for (const key of Object.keys(localStorage)) if (key.startsWith('mint:c:') || key.startsWith('mint:tx:')) localStorage.removeItem(key);
      try { localStorage.setItem(`mint:${k}`, JSON.stringify(v)); return true; } catch { return false; }
    }
  },
  del(k) { try { localStorage.removeItem(`mint:${k}`); } catch {} },
};

// ---------- optional chat ----------
// The in-app chat talks to an external assistant server and is off unless the server has MINT_CHAT_KEY set.
// The server swaps the placeholder below for 'on' or 'off' when it serves this file; served raw it reads as off.
const CHAT_ON = '__CHAT__' === 'on';

// ---------- demo mode ----------

// Demo mode lives on this device only (localStorage, never sent anywhere): one
// factor that scales every dollar, account numbers masked, writes refused. See
// public/demo-math.js for the rules; Settings turns it on and shuffles the factor.
let demo = demoParse(store.get('demo'));
const demoActive = () => demo.on;
const demoCents = (cents) => demoScale(cents, demo);
// A sentence the server wrote with dollars in it, scaled so it agrees with the figures beside it.
const moneyText = (text) => demoScaleText(text, demo);
// An account name or number, with the digits that identify the account masked.
const acctText = (text) => (demo.on ? demoMask(text) : text);
// Balances as a demo screen shows them (public/demo-math.js): an empty cash account carries a made-up balance, and the
// one-number totals the server summed carry the same extra. Display only: accountsData and the saved reads stay real,
// and anything that writes or computes (interest saved on the loan, spend) keeps reading them.
const shownAccounts = () => demoAccounts(accountsData?.accounts ?? [], demo);
const shownAccount = (a) => (demo.on && a ? demoAccounts([a], demo)[0] : a);
const shownAccountsData = () => demoAccountsData(accountsData, demo);
const shownNw = (nw) => demoNetWorth(nw, demo);
const shownSavings = (sv) => demoSavings(sv, demo, accountsData?.accounts);
const shownGoals = (goals) => demoGoals(goals, demo, accountsData?.accounts);
function saveDemo() {
  store.set('demo', demo);
  document.dispatchEvent(new CustomEvent('mint:demo'));
}
function setDemo(on) { demo = on ? demoTurnOn(demo) : demoTurnOff(); saveDemo(); }
function shuffleDemo() { demo = demoShuffle(demo); saveDemo(); }
const demoError = () => new ApiError('Demo mode is on', DEMO_BLOCKED_MSG, { demo: true });
// Downloads (CSV, the accountant pack) carry the real figures, so demo mode keeps them shut.
const demoNoDownload = () => new ApiError('Downloads are off in demo mode', 'Turn off demo mode to download. The file would carry your real figures.', { demo: true });
let demoToastAt = 0;
function demoToast() {
  if (Date.now() - demoToastAt < 1500) return;
  demoToastAt = Date.now();
  toast(DEMO_BLOCKED_MSG, { error: true });
}
// True (with the toast) when this write must not go out because demo mode is on.
function demoGuard(op) {
  if (!demoWriteBlocked(op, demo)) return false;
  demoToast();
  return true;
}

// Form drafts: typed input survives navigation, refresh and a failed submit. Demo mode keeps
// none: a figure typed on a scaled screen would prefill the real form later, and a real draft
// would prefill a demo screen unscaled. Real drafts are left alone and come back when demo is off.
const drafts = {
  get: (k) => (demoActive() ? null : store.get(`draft:${k}`)),
  set: (k, v) => (demoActive() ? false : store.set(`draft:${k}`, v)),
  clear: (k) => store.del(`draft:${k}`),
};
function bindDraft(root, key, { skip = [] } = {}) {
  const fields = $$('input[name],textarea[name],select[name]', root).filter((f) => !skip.includes(f.name) && f.type !== 'file');
  const saved = drafts.get(key);
  let restored = false;
  if (saved) {
    for (const f of fields) {
      if (!(f.name in saved)) continue;
      if (f.type === 'checkbox') f.checked = !!saved[f.name]; else if (f.value !== saved[f.name]) { f.value = saved[f.name]; restored = true; }
    }
  }
  const save = () => drafts.set(key, Object.fromEntries(fields.map((f) => [f.name, f.type === 'checkbox' ? f.checked : f.value])));
  root.addEventListener('input', save);
  root.addEventListener('change', save);
  return { restored, clear: () => drafts.clear(key) };
}

// ---------- network ----------

class ApiError extends Error {
  constructor(headline, detail, extra = {}) { super(headline); this.detail = detail; Object.assign(this, extra); }
}

// A thin bar under the header while anything is loading, so a refresh behind
// cached content still shows that work is happening.
let inflight = 0;
let barSince = 0;
function loadBar(delta) {
  inflight += delta;
  const bar = $('#loadbar');
  if (!bar) return;
  if (inflight > 0) { barSince = Date.now(); bar.classList.add('on'); } else {
    // Stay up long enough to be seen.
    setTimeout(() => { if (inflight <= 0) bar.classList.remove('on'); }, Math.max(0, 450 - (Date.now() - barSince)));
  }
}

async function api(path, opts = {}) {
  loadBar(1);
  try { return await apiCall(path, opts); } finally { loadBar(-1); }
}

async function apiCall(path, { method = 'GET', body, raw, type, retries = method === 'GET' ? 2 : 1 } = {}) {
  // The one choke point for writes: with demo mode on nothing but a read-only request leaves the page.
  if (demoWriteBlocked({ method, path, body: raw ? undefined : body }, demo)) { demoToast(); throw demoError(); }
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(path, {
        method, credentials: 'same-origin', redirect: 'manual',
        headers: raw ? { 'Content-Type': type } : body ? { 'Content-Type': 'application/json' } : {},
        body: raw ?? (body ? JSON.stringify(body) : undefined),
      });
    } catch (e) {
      if (i < retries) { await sleep(400 * 3 ** i); continue; }
      setOnline(false);
      throw new ApiError('No connection', String(e?.message ?? e), { offline: true });
    }
    setOnline(true);
    if (res.type === 'opaqueredirect' || res.status === 401) {
      throw new ApiError('Signed out', 'The sign-in gate session expired. Sign in again to carry on.', { signedOut: true });
    }
    if (res.status >= 500 && i < retries) { await sleep(400 * 3 ** i); continue; }
    if (res.status === 404 && path.startsWith('/api/receipts/')) throw new ApiError('Not found', '404 receipt missing', { status: 404 });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError('Request failed', `${res.status} ${data?.error ?? res.statusText}${data?.id ? ` (ref ${data.id})` : ''}`, { status: res.status });
    return data;
  }
}

// Reads: paint the saved copy at once, then the fresh one. Rejects only when
// there is nothing saved and the network failed, so the caller can show the
// designed error state. `paint(data, stale)` runs once or twice.
async function swr(path, paint) {
  const key = `c:${path}`;
  // One transaction's detail is not worth a storage slot each.
  const keep = !path.startsWith('/api/transactions/');
  const saved = keep ? store.get(key) : null;
  if (saved) paint(saved.d, true);
  try {
    const d = await api(path);
    if (keep) store.set(key, { d, at: Date.now() });
    paint(d, false);
    return d;
  } catch (e) {
    if (!saved) throw e;
    return saved.d;
  }
}

// Queued writes: JSON writes live in localStorage, receipt photos in IndexedDB.
// Both flush in order when the connection returns.
const queue = {
  all: () => store.get('queue') ?? [],
  push(op) {
    if (demoActive()) return; // a change made in demo mode is never kept
    store.set('queue', [...queue.all(), { ...op, at: Date.now() }]);
    queueChanged();
  },
  async flush() {
    // Changes saved before demo mode went on wait here until it is off.
    if (queue.flushing || demoActive()) return;
    queue.flushing = true;
    try {
      let q = queue.all();
      let did = 0;
      while (q.length) {
        const op = q[0];
        try {
          await api(op.path, { method: op.method, body: op.body, retries: 1 });
          did += 1;
        } catch (e) {
          if (e.offline || e.signedOut || e.demo) return; // demo went on mid-flush: keep this and the rest, like offline
          if (e.status >= 500) return; // try again next time rather than lose it
          toast(`A saved change was refused: ${e.detail}`, { error: true });
        }
        q = queue.all().slice(1);
        store.set('queue', q);
      }
      await receiptQueue.flush();
      if (did) { toast(`${plural(did, 'saved change')} synced`); buzz(10); window.dispatchEvent(new CustomEvent('mint:synced')); }
    } finally { queue.flushing = false; queueChanged(); }
  },
};

// Every write goes through here: optimistic UI is the caller's job; this sends
// it, falling back to the queue when offline. Rejections come back as errors.
async function mutate(op, { retries } = {}) {
  if (demoGuard(op)) throw demoError();
  try {
    const data = await api(op.path, { method: op.method, body: op.body, retries });
    return { data, queued: false };
  } catch (e) {
    if (e.offline) { queue.push({ method: op.method, path: op.path, body: op.body }); return { data: null, queued: true }; }
    throw e;
  }
}

let online = navigator.onLine;
function setOnline(v) {
  if (v === online) return;
  online = v;
  $('#offline').hidden = v;
  document.dispatchEvent(new CustomEvent('mint:online', { detail: v }));
  if (v) queue.flush().then(() => refreshAccounts(true));
}
addEventListener('online', () => setOnline(true));
addEventListener('offline', () => setOnline(false));
function queueChanged() {
  const n = queue.all().length;
  const el = $('#offline');
  if (el) el.textContent = online ? '' : `Offline. Showing saved data${n ? `; ${plural(n, 'change')} waiting to sync` : '; changes sync when you are back'}.`;
}

// ---------- receipt queue (IndexedDB, photos are too big for localStorage) ----------

const receiptQueue = (() => {
  let dbp;
  const open = () => dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('mint', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('receipts', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('receipts', mode);
      const out = fn(t.objectStore('receipts'));
      t.oncomplete = () => resolve(out.result);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    add: (txId, file) => (demoActive() ? Promise.reject(demoError()) : run('readwrite', (s) => s.add({ txId, blob: file, type: file.type, name: file.name, at: Date.now() }))),
    all: () => run('readonly', (s) => s.getAll()).catch(() => []),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
    async count(txId) { return (await this.all()).filter((r) => !txId || r.txId === txId).length; },
    async flush() {
      if (demoActive()) return;
      for (const r of await this.all()) {
        try {
          await api(`/api/transactions/${encodeURIComponent(r.txId)}/receipts`, { method: 'POST', raw: r.blob, type: r.type, retries: 1 });
          await this.remove(r.id);
          toast('Receipt uploaded');
          window.dispatchEvent(new CustomEvent('mint:synced'));
        } catch (e) {
          if (e.offline || e.signedOut || e.status >= 500) return;
          await this.remove(r.id);
          toast(`A saved receipt was refused: ${e.detail}`, { error: true });
        }
      }
    },
  };
})();

// ---------- shared account state (Home, Accounts) ----------

let accountsData = store.get('accounts');
const accountsListeners = new Set();
let accountsInflight = null;
function refreshAccounts(quiet = false) {
  if (accountsInflight) return accountsInflight;
  accountsInflight = api('/api/accounts')
    .then((d) => { accountsData = d; store.set('accounts', d); accountsListeners.forEach((f) => f()); return d; })
    .catch((e) => { if (!quiet) throw e; return accountsData; })
    .finally(() => { accountsInflight = null; });
  return accountsInflight;
}
const accountName = (a) => acctText(a.nickname || a.name);
const acctById = (id) => accountsData?.accounts.find((a) => a.id === id);

// Categories are needed everywhere: kept in memory and cached.
let categoriesData = store.get('categories');
let categoriesInflight = null;
function loadCategories() {
  if (categoriesInflight) return categoriesInflight;
  categoriesInflight = api('/api/categories').then((d) => { categoriesData = d.items; store.set('categories', d.items); return d.items; })
    .catch((e) => { if (categoriesData) return categoriesData; throw e; })
    .finally(() => { categoriesInflight = null; });
  return categoriesInflight;
}
const catName = (id) => categoriesData?.find((c) => c.id === id)?.name ?? '';

// Sync progress: follow /api/sync while a run is going.
let syncState = null;
let syncWatch = null;
function watchSync() {
  if (syncWatch) return;
  syncWatch = (async () => {
    const started = Date.now();
    try {
      for (;;) {
        syncState = await api('/api/sync', { retries: 1 });
        syncState.elapsed = Date.now() - started;
        renderSyncCard();
        document.dispatchEvent(new CustomEvent('mint:syncstate'));
        if (!syncState.running && !syncState.queued) break;
        await sleep(900);
      }
      await refreshAccounts(true);
      renderSyncCard();
      document.dispatchEvent(new CustomEvent('mint:syncstate'));
      document.dispatchEvent(new CustomEvent('mint:data'));
      if (syncState.lastError) toast(`Sync failed: ${syncState.lastError}`, { error: true });
      else if (syncState.accountErrors) toast(`Synced, ${syncState.accountErrors} account(s) failed`, { error: true });
      else { toast('Synced'); buzz(12); }
    } catch (e) {
      // Contact lost mid-sync: stop showing it as running, and say so rather than hang.
      syncState = { ...syncState, running: false, queued: false, lastError: syncState?.lastError || `Lost contact with the server while syncing: ${e?.detail ?? e?.message ?? e}` };
    } finally { syncWatch = null; document.dispatchEvent(new CustomEvent('mint:syncstate')); }
  })();
}

// ---------- toasts ----------

// toast('Saved'), toast('Failed: why', { error: true, action: { label: 'Retry', fn } })
function toast(msg, { error = false, action = null, ms = null } = {}) {
  // The kit's toast: a tick on success, the real error text small underneath on failure ("Couldn't save: 503 busy" splits at the colon).
  if (window.kit) {
    const cut = error ? msg.indexOf(': ') : -1;
    const t = window.kit.toast(cut > 0 ? msg.slice(0, cut) : msg, {
      tone: error ? 'danger' : 'ok', detail: cut > 0 ? msg.slice(cut + 2) : undefined,
      action: action ? { label: action.label, onClick: action.fn } : undefined, duration: ms ?? (action ? 6500 : error ? 5200 : 2200),
    });
    return t.dismiss;
  }
  const t = document.createElement('div');
  t.className = `toast${error ? ' error' : ''}`;
  t.innerHTML = `${error ? I.alert : I.tick}<span>${esc(msg)}</span>${action ? `<button type="button" class="toast-act">${esc(action.label)}</button>` : ''}`;
  $('#toasts').append(t);
  const gone = () => { t.classList.add('leaving'); setTimeout(() => t.remove(), reduceMotion.matches ? 0 : 200); };
  const timer = setTimeout(gone, ms ?? (action ? 6500 : error ? 5200 : 2200));
  if (action) $('.toast-act', t).addEventListener('click', () => { clearTimeout(timer); gone(); action.fn(); });
  return gone;
}

// The destructive pattern: apply now, offer undo for a few seconds, commit
// after. Leaving the page commits straight away (into the offline queue).
const pendingCommits = new Set();
function undoable({ label, apply, revert, op, onError }) {
  if (demoGuard(op)) return; // refuse before anything changes on screen
  apply();
  const p = { op, done: false };
  const commit = async () => {
    if (p.done) return;
    p.done = true;
    pendingCommits.delete(p);
    try { const r = await mutate(op); if (r.queued) toast('Saved offline, syncs when you are back'); } catch (e) {
      revert();
      (onError ?? ((err) => toast(`Couldn't ${label.toLowerCase()}: ${err.detail}`, { error: true })))(e);
    }
  };
  pendingCommits.add(p);
  const timer = setTimeout(() => { commit(); dismiss?.(); }, 5200);
  // Undo is only real until the change is sent: once it has committed there is no server undo for it, so the button goes
  // with the commit (the kit toast can outlive the timer while hovered or in a hidden tab) and a late tap does nothing.
  const dismiss = toast(label, { ms: 5200, action: { label: 'Undo', fn: () => { if (p.done) return; clearTimeout(timer); p.done = true; pendingCommits.delete(p); revert(); buzz(6); } } });
  buzz(14);
}
function flushPending() {
  for (const p of pendingCommits) { p.done = true; queue.push({ method: p.op.method, path: p.op.path, body: p.op.body }); }
  pendingCommits.clear();
}
addEventListener('pagehide', flushPending);

// ---------- sheets ----------
// #sheet is the main editor (a bottom sheet on phones, the right pane on
// desktop); #modal sits above it for pickers and small forms on both.

let paneOwner = null;
let paneDefaultFn = null;
const setPaneDefault = (fn) => { paneDefaultFn = fn; if (!paneOwner) paneDefault(); };
function paneDefault() {
  if (!desktop.matches) return;
  $('#pane').innerHTML = `<div class="view-enter">${paneDefaultFn ? paneDefaultFn() : ''}</div>`;
}

// A drag leaves inline transform, transition and animation on the panel and scrim (the entry animation is held off so
// letting go does not replay it). Opening or closing from rest starts clean; a drag dismiss keeps them while it slides out.
function resetDrag(root) {
  const panel = $('.panel', root);
  const scrim = $('.scrim', root);
  for (const p of ['transform', 'transition', 'animation']) { panel.style.removeProperty(p); scrim.style.removeProperty(p); }
  scrim.style.removeProperty('opacity');
  delete panel.dataset.out;
}
function layer(id) {
  const root = $(`#${id}`);
  let gen = 0; // a close in flight must not hide a sheet opened right after it
  let opener = null; // what had focus when the layer opened, so closing hands focus back to it
  return {
    root,
    open(html) {
      gen += 1;
      if (root.hidden) opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : opener;
      root.classList.remove('closing');
      resetDrag(root);
      const panel = $('.panel', root);
      panel.innerHTML = `<div class="grab" data-grab></div>${html}`;
      // The dialog is named by its own title, so a screen reader says which sheet opened.
      const title = $('.sheet-head h3', panel);
      if (title) { title.id = `${root.id}-title`; panel.setAttribute('aria-labelledby', title.id); } else panel.removeAttribute('aria-labelledby');
      root.hidden = false;
      document.body.style.overflow = 'hidden';
      panel.scrollTop = 0;
      // The sheet rises on the kit's spring (it keeps its velocity if a drag takes it over), the scrim fades in with CSS.
      panel._enter?.cancel();
      panel._enter = window.kit ? window.kit.animate(panel, [{ opacity: 0.4, transform: 'translateY(100%)' }, { opacity: 1, transform: 'translateY(0)' }], window.kit.spring(window.kit.springs.sheet)) : null;
      panel.focus({ preventScroll: true });
      return panel;
    },
    close() {
      if (root.hidden) return;
      const g = gen;
      if (!$('.panel', root).dataset.out) resetDrag(root); // not already sliding out under a finger: play the exit from rest
      root.classList.add('closing');
      setTimeout(() => {
        if (g !== gen) return;
        root.hidden = true;
        root.classList.remove('closing');
        if ($('#sheet').hidden && $('#modal').hidden) document.body.style.overflow = '';
        const a = document.activeElement;
        if (opener?.isConnected && (!a || a === document.body || root.contains(a))) opener.focus({ preventScroll: true });
        opener = null;
      }, reduceMotion.matches ? 0 : 180);
    },
  };
}
const mainSheet = layer('sheet');
const modalSheet = layer('modal');
let onSheetClose = null;

function openSheet(html, owner = null, { onClose = null } = {}) {
  paneOwner = owner;
  onSheetClose = onClose;
  if (desktop.matches) {
    $('#pane').innerHTML = `<div class="view-enter" data-pane-body>${html}</div>`;
    $('#pane').scrollTop = 0;
    return $('#pane');
  }
  return mainSheet.open(html);
}
function closeSheet() {
  const cb = onSheetClose;
  onSheetClose = null;
  if (desktop.matches) {
    if (paneOwner) { paneOwner = null; paneDefault(); $$('.row.sel,.vrow.sel').forEach((r) => r.classList.remove('sel')); }
  } else mainSheet.close();
  cb?.();
}
const openModal = (html) => modalSheet.open(html);
const closeModal = () => modalSheet.close();

for (const [id, close] of [['sheet', () => closeSheet()], ['modal', () => closeModal()]]) {
  $(`#${id}`).addEventListener('click', (e) => { if (e.target.classList.contains('scrim') || e.target.closest('[data-close]')) close(); });
}
$('#pane').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#modal').hidden) closeModal(); else if (!$('#sheet').hidden || paneOwner) closeSheet();
});

// Drag the grab handle (or the sheet's title bar) down to dismiss a sheet. The scrim fades with
// the drag, a quick flick closes it, and a short drag springs back.
document.addEventListener('pointerdown', (e) => {
  const g = e.target.closest('[data-grab], .sheet-head');
  if (!g || e.pointerType === 'mouse' || e.target.closest('button, a, input')) return;
  const root = g.closest('#sheet,#modal');
  if (!root) return;
  const panel = $('.panel', root);
  const scrim = $('.scrim', root);
  const y0 = e.clientY;
  let dy = 0;
  let vel = 0;
  let lastY = y0;
  let lastT = performance.now();
  let moved = false;
  clearTimeout(panel._settle); // a settle from the last drag must not clear this one's transition
  const move = (ev) => {
    panel._enter?.cancel(); // a drag takes over from the entrance
    const now = performance.now();
    if (now - lastT > 24) { vel = (ev.clientY - lastY) / (now - lastT); lastY = ev.clientY; lastT = now; }
    const raw = ev.clientY - y0;
    dy = raw < 0 ? raw * 0.12 : raw;
    moved = true;
    panel.style.transition = 'none';
    scrim.style.transition = 'none';
    panel.style.transform = `translateY(${dy}px)`;
    panel.style.animation = 'none';
    scrim.style.animation = 'none';
    scrim.style.opacity = String(Math.max(0.15, 1 - Math.max(0, dy) / 420));
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    if (!moved) return;
    const ease = reduceMotion.matches ? '' : null;
    if (dy > 90 || vel > 0.6) {
      // Slide out from wherever the finger left it. The panel keeps its inline animation: none, so neither the entry nor the
      // exit keyframe restarts from rest; the next open clears it.
      panel.dataset.out = '1';
      panel.style.transition = ease ?? 'transform var(--dur-out) var(--ease-drawer)';
      panel.style.transform = 'translateY(100%)';
      scrim.style.transition = ease ?? 'opacity var(--dur-out) var(--spring)';
      scrim.style.opacity = '0';
      root.id === 'modal' ? closeModal() : closeSheet();
    } else {
      // Let go short of the mark: settle back on the spring, from wherever the finger left it. The inline animation: none
      // stays, so the slide-in is not replayed when the drag transform is cleared.
      panel.style.transition = ease ?? 'transform var(--dur-3) var(--ease-spring)';
      panel.style.transform = '';
      scrim.style.transition = ease ?? 'opacity var(--dur-3) var(--spring)';
      scrim.style.opacity = '';
      panel._settle = setTimeout(() => { panel.style.transition = ''; scrim.style.transition = ''; }, 420);
    }
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
});

const sheetHead = (sub, title, right = '') => `<div class="sheet-head"><div class="sh-t">${sub ? `<div class="sub">${esc(sub)}</div>` : ''}<h3 class="t1">${esc(title)}</h3></div>${right}<button class="x" type="button" data-close aria-label="Close" title="Close">${I.x}</button></div>`;

// ---------- view building blocks ----------

const skRow = '<div class="sk-row"><div class="sk sk-ic"></div><div class="main"><div class="sk sk-l"></div><div class="sk sk-s"></div></div><div class="sk sk-a"></div></div>';
const skeletonRows = (n) => `<div class="rows">${skRow.repeat(n)}</div>`;
const skeletonCard = (h = 120) => `<div class="sk sk-block" data-h="${h}"></div>`;

function emptyState({ icon, title, line, action, button }) {
  return `<div class="empty"><div class="art">${icon}</div><h3>${esc(title)}</h3><p>${esc(line)}</p>${action ? `<a class="btn ghost" href="${action.href}" data-nav>${esc(action.label)}</a>` : ''}${button ? `<button class="btn ghost" type="button" id="${button.id}">${button.icon ?? ''}${esc(button.label)}</button>` : ''}</div>`;
}

function errorCard(e, retryId, what = 'this') {
  if (e?.signedOut) {
    return `<div class="error"><div class="h">Signed out</div><div class="d">${esc(e.detail)}</div><button class="btn" type="button" data-signin>Sign in</button></div>`;
  }
  const head = e?.offline ? 'No connection and nothing saved yet' : `Couldn't load ${what}`;
  return `<div class="error"><div class="h">${esc(head)}</div><div class="d">${esc(e?.detail ?? e?.message ?? e)}</div><button class="btn ghost" type="button" id="${retryId}">${I.refresh}Retry</button></div>`;
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-signin]')) location.reload(); });

// Loader text that admits when it is slow.
function slowNote(el, after = 4000, text = 'Still working, the server may be busy.') {
  const t = setTimeout(() => { if (el.isConnected) el.insertAdjacentHTML('beforeend', `<p class="slow">${esc(text)}</p>`); }, after);
  return () => clearTimeout(t);
}

// Sizes that cannot be inline styles under the page CSP are applied after insert.
function applyDims(root) {
  const bars = $$('[data-w]', root);
  if (bars.length) void root.offsetWidth; // flush, so the fill animates from empty
  bars.forEach((n) => { n.style.transform = `scaleX(${Math.min(100, Number(n.dataset.w)) / 100})`; });
  $$('[data-h]', root).forEach((n) => { n.style.height = `${n.dataset.h}px`; });
  $$('[data-bg]', root).forEach((n) => { n.style.background = n.dataset.bg; });
  $$('[data-l]', root).forEach((n) => { n.style.left = `${n.dataset.l}%`; });
}

// A budget meter with a pace tick: the fill is spend against target, the tick is how far
// through the pay cycle today is, so being left of the tick means spending slower than the cycle.
function paceMeterHtml({ spent, target, cycle, label = 'Budget used', tone = '', tick = true }) {
  const pct = target > 0 ? Math.min(100, Math.round((spent / target) * 100)) : 0;
  const st = paceStatus({ spent, target, cycle });
  const t = tone || (st === 'over' ? 'over' : st === 'ahead' ? 'hot' : '');
  const mark = paceMarker(cycle);
  return `<div class="meter pace ${t}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(label)}"><i data-w="${pct}"></i>${cycle.open && tick ? `<b class="ptick" data-l="${mark}" title="Where you would be if you spent evenly across the cycle"></b>` : ''}</div>`;
}
// What the pace says, in words: dollars over or under the even-spend line.
function paceWords({ spent, target, cycle }) {
  const st = paceStatus({ spent, target, cycle });
  if (st === 'none') return '';
  if (st === 'over') return `${money0(spent - target)} over budget`;
  const diff = spent - Math.round((target * paceMarker(cycle)) / 100);
  if (!cycle.open) return `${money0(target - spent)} left over`;
  if (st === 'on') return 'On pace';
  return diff > 0 ? `${money0(diff)} ahead of pace` : `${money0(-diff)} under pace`;
}

// List reveal: the kit's focus pull, 30ms apart, capped at the 8th item so the whole run stays under 400ms.
function stagger(root, sel = ':scope > *') {
  $$(sel, root).forEach((n, i) => { n.style.animationDelay = `${Math.min(i, 7) * 30}ms`; n.classList.add('stag'); });
}

// A hero figure: counts up from zero the first time it is drawn in a session, then only ticks from the
// figure last shown under the same key (UxModel.tickPlan), so a tab revisit sits still.
const shownFigures = new Map();
function countUp(el, cents, fmt = money, key = null) {
  const plan = UxModel.tickPlan(key ? shownFigures.get(key) : undefined, cents);
  if (key && Number.isFinite(cents)) shownFigures.set(key, cents);
  if (!plan || reduceMotion.matches) { el.textContent = fmt(cents); return; }
  el.textContent = fmt(plan.from);
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / plan.ms);
    el.textContent = fmt(UxModel.tickValue(plan.from, plan.to, k));
    if (k < 1 && el.isConnected) requestAnimationFrame(step); else el.textContent = fmt(cents);
  };
  requestAnimationFrame(step);
}

// A button that shows a spinner and what it is doing while a promise runs.
async function withBusy(btn, busyText, fn) {
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.innerHTML = `<span class="spin"></span>${esc(busyText)}`;
  try { return await fn(); } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.innerHTML = html;
  }
}

// Inline field validation: shows the message under the field and returns ok.
function fieldError(input, msg) {
  const wrap = input.closest('.field') ?? input.parentElement;
  let el = $('.ferr', wrap);
  if (!msg) { el?.remove(); input.removeAttribute('aria-invalid'); wrap.classList.remove('bad'); return true; }
  if (!el) { el = document.createElement('div'); el.className = 'ferr'; el.setAttribute('role', 'alert'); wrap.append(el); }
  el.textContent = msg;
  input.setAttribute('aria-invalid', 'true');
  wrap.classList.add('bad');
  return false;
}
const formError = (form, e, retryLabel = 'Try again') => {
  let box = $('.form-err', form);
  if (!e) { box?.remove(); return; }
  if (!box) { box = document.createElement('div'); box.className = 'error form-err'; form.append(box); }
  box.innerHTML = `<div class="h">${esc(e.offline ? 'No connection' : "Couldn't save")}</div><div class="d">${esc(e.detail ?? e.message)}</div><div class="sub">${esc(retryLabel)} with the button above. Nothing you typed is lost.</div>`;
  box.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
};

const segmented = (name, opts, value) => `<div class="seg" role="radiogroup" data-seg="${name}">${opts.map(([v, label]) => `<button type="button" role="radio" aria-checked="${String(v) === String(value)}" data-v="${esc(v)}">${esc(label)}</button>`).join('')}</div>`;
function wireSeg(root, name, onPick) {
  const seg = $(`[data-seg="${name}"]`, root);
  seg?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    $$('button', seg).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    buzz(6);
    onPick(b.dataset.v);
  });
  return () => $('button[aria-checked="true"]', seg)?.dataset.v;
}

// ---------- category picker (modal) ----------

// Resolves to a category id, null (clear it), or undefined (dismissed).
function pickCategory({ title = 'Category', selected = null, kinds = null, allowClear = false, allowNew = true } = {}) {
  return new Promise(async (resolve) => {
    let cats;
    try { cats = categoriesData ?? await loadCategories(); } catch (e) { toast(`Couldn't load categories: ${e.detail}`, { error: true }); return resolve(undefined); }
    let done = false;
    const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
    const panel = openModal(`${sheetHead(null, title)}
      <label class="search">${I.search}<input id="catq" type="search" placeholder="Search categories" autocomplete="off" aria-label="Search categories"></label>
      <div id="catlist" class="catlist"></div>`);
    const list = $('#catlist', panel);
    const paint = (q = '') => {
      const term = q.trim().toLowerCase();
      const items = cats.filter((c) => !c.archived && (!kinds || kinds.includes(c.kind)) && (!term || c.name.toLowerCase().includes(term) || c.grp.toLowerCase().includes(term)));
      const groups = new Map();
      for (const c of items) (groups.get(c.grp) ?? groups.set(c.grp, []).get(c.grp)).push(c);
      list.innerHTML = `${allowClear && !term ? `<button class="crow" type="button" data-cat="none">${I.x}<span>No category</span></button>` : ''}${[...groups].map(([g, cs]) => `<div class="cgroup">${esc(g || 'Other')}</div>${cs.map((c) => `<button class="crow ${c.id === selected ? 'on' : ''}" type="button" data-cat="${c.id}"><span>${esc(c.name)}</span>${c.id === selected ? I.check : c.kind !== 'expense' ? `<small>${esc(titleCase(c.kind))}</small>` : ''}</button>`).join('')}`).join('')}
        ${!items.length ? `<p class="sub pad">No category matches "${esc(q)}".</p>` : ''}
        ${allowNew ? `<button class="crow add" type="button" data-cat="new">${I.plus}<span>${term ? `New category "${esc(q.trim())}"` : 'New category'}</span></button>` : ''}`;
    };
    paint();
    $('#catq', panel).addEventListener('input', (e) => paint(e.target.value));
    list.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      buzz(6);
      if (b.dataset.cat === 'none') return finish(null);
      if (b.dataset.cat === 'new') {
        const name = $('#catq', panel).value.trim();
        const made = await newCategoryForm(name);
        if (made) finish(made.id);
        return;
      }
      finish(Number(b.dataset.cat));
    });
    modalSheet.root.addEventListener('click', function h(e) { if (e.target.classList.contains('scrim') || e.target.closest('[data-close]')) { modalSheet.root.removeEventListener('click', h); finish(undefined); } });
  });
}

function newCategoryForm(prefill = '') {
  return new Promise((resolve) => {
    const groups = [...new Set((categoriesData ?? []).map((c) => c.grp).filter(Boolean))];
    const panel = openModal(`${sheetHead(null, 'New category')}
      <form class="form" novalidate>
        <div class="field"><label for="ncn">Name</label><input id="ncn" name="name" maxlength="40" autocomplete="off" value="${esc(prefill)}"></div>
        <div class="field"><label for="ncg">Group</label><select id="ncg" name="group">${groups.map((g) => `<option ${g === 'Other' ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
        <button class="btn wide" type="submit">${I.plus}Add category</button>
      </form>`);
    const form = $('form', panel);
    const name = $('#ncn', form);
    name.addEventListener('input', () => fieldError(name, name.value.trim() ? '' : 'Give it a name'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!name.value.trim()) return fieldError(name, 'Give it a name');
      const btn = $('button[type=submit]', form);
      try {
        const c = await withBusy(btn, 'Adding', () => api('/api/categories', { method: 'POST', body: { name: name.value.trim(), group: $('#ncg', form).value } }));
        categoriesData = [...(categoriesData ?? []), c];
        store.set('categories', categoriesData);
        toast(`Added ${c.name}`);
        buzz(12);
        resolve(c);
      } catch (err) {
        if (err.status === 409) return fieldError(name, 'That name is taken');
        formError(form, err, 'Add it again');
      }
    });
  });
}

// ---------- chips and small widgets ----------

const switchHtml = (attr, id, on, label, title) => `<button class="switch" type="button" role="switch" aria-checked="${on ? 'true' : 'false'}" ${attr}="${esc(id)}" aria-label="${esc(label)}" title="${esc(title)}"><span class="track"><span class="knob"></span></span></button>`;

// The right pane when nothing is open: where you stand this cycle (every screen but Home, which has it as the hero) and every account's balance.
function glanceHtml() {
  const s = store.get('c:/api/safe-to-spend')?.d;
  if (!s || s.safe == null || route.view === 'home') return '';
  const c = s.cycle;
  const neg = s.safe < 0;
  return `<a class="glance ${neg ? 'tight' : ''}" href="/" data-nav aria-label="Safe to spend ${esc(money(s.safe))}, open Home"><div class="k">${neg ? 'Over the plan until payday' : 'Safe to spend until payday'}</div><div class="v num">${esc(money(s.safe))}</div><div class="sub">${c.late ? `Payday is ${plural(c.days_late, 'day')} late` : `Payday ${esc(shortDay(c.next_payday))}, ${esc(inDays(c.next_payday))}`}</div></a>`;
}
function balancesPane() {
  if (route.view === 'home') return ''; // Home lists every account itself
  const d = accountsData;
  if (!d) return skeletonRows(4);
  return `${glanceHtml()}<h2>Balances</h2><div class="rows">${shownAccounts().filter((a) => !a.hidden).map((a) => `<a class="row" href="${esc(UxModel.accountHref(a.id))}" data-nav><div class="ic">${TYPE_ICON[a.type] ?? I.wallet}</div><div class="main"><div class="t1">${esc(accountName(a))}</div><div class="t2">${esc(a.institution)}${a.manual && a.currency !== 'AUD' ? ` · ${esc(moneyIn(a.balance_native, a.currency))}` : ''}</div></div><div class="amt num">${esc(money(a.balance_current))}</div></a>`).join('')}</div>`;
}
// Keeps the glance card fresh while a screen other than Home is open on a wide window.
function refreshGlance() {
  if (!desktop.matches || route.view === 'home' || !online) return;
  swr('/api/safe-to-spend', () => { if (!paneOwner && paneDefaultFn === balancesPane) paneDefault(); }).catch(() => {});
}
accountsListeners.add(() => { if (!paneOwner && paneDefaultFn === balancesPane) paneDefault(); });
