// Inline SVG charts, no library. Form follows the dataviz rules: one axis,
// thin marks, rounded bar ends on the baseline, a 2px gap between fills,
// categorical colours in fixed order (validated on the dark surface, six slots,
// no magenta), a legend for more than one series, a tap/hover tooltip, and a
// table view for every chart. Sizes are attributes, never inline styles (CSP).
'use strict';

// Fixed order, never cycled; a seventh category folds into Other.
const VIZ = ['#3987e5', '#d95926', '#199e70', '#c98500', '#9085e9', '#e66767'];
const VIZ_OTHER = '#6a746f';
const VIZ_ACCENT = '#3ddc97';
const VIZ_MUTED = '#4a5550';
const VIZ_GRID = '#232927';
const VIZ_INK = '#9ba6a0';

const chartKills = [];
function clearCharts() { chartKills.splice(0).forEach((f) => f()); }

// Round limits up to something a reader can count in: 1, 2, 2.5, 5 times a power of ten.
// Whole-dollar axis labels on a tiny range would repeat ($1, $1): keep the first of each.
function distinctTicks(ticks, fmt) {
  const seen = new Set();
  return ticks.filter((v) => { const l = fmt(v); if (seen.has(l)) return false; seen.add(l); return true; });
}

function niceRange(lo, hi, n = 4, zero = true) {
  if (zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); } else {
    // A trend, not a magnitude: frame the data instead of dragging zero into view.
    const pad = Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.002, 100);
    lo -= pad; hi += pad;
  }
  if (hi === lo) hi = lo + 100;
  const raw = (hi - lo) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v));
  return { min, max, ticks };
}

const fx = (n) => (Math.round(n * 10) / 10).toString();
// Rounds the top corners only, so the bar sits flat on its baseline.
// A bar is a rounded rectangle on every corner; r is capped so a thin bar becomes a capsule.
function barPath(x, y, w, h, r) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h / 2);
  return `M${fx(x + r)} ${fx(y)}H${fx(x + w - r)}A${fx(r)} ${fx(r)} 0 0 1 ${fx(x + w)} ${fx(y + r)}V${fx(y + h - r)}A${fx(r)} ${fx(r)} 0 0 1 ${fx(x + w - r)} ${fx(y + h)}H${fx(x + r)}A${fx(r)} ${fx(r)} 0 0 1 ${fx(x)} ${fx(y + h - r)}V${fx(y + r)}A${fx(r)} ${fx(r)} 0 0 1 ${fx(x + r)} ${fx(y)}Z`;
}

function tipBox(wrap) {
  let tip = $('.viz-tip', wrap);
  if (!tip) { tip = document.createElement('div'); tip.className = 'viz-tip'; tip.hidden = true; wrap.append(tip); }
  return tip;
}
function placeTip(wrap, tip, x, y) {
  tip.hidden = false;
  const w = wrap.clientWidth;
  const tw = tip.offsetWidth;
  tip.style.left = `${Math.max(4, Math.min(w - tw - 4, x - tw / 2))}px`;
  tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
}

// The width a chart draws at. It is remembered on the element, so a chart first drawn before
// layout (width 0) is redrawn at the real width once the observer reports one.
function chartW(el) {
  el._cw = Math.max(240, el.clientWidth || 340);
  return el._cw;
}
// Charts animate in on first draw only: a resize redraw (or a legend toggle) lands still.
function seenDraw(el) {
  const again = el.classList.contains('seen');
  el.classList.add('seen');
  return again;
}
function watchWidth(el, redraw) {
  const ro = new ResizeObserver(() => { const w = el.clientWidth; if (w > 0 && Math.abs(w - (el._cw ?? 0)) > 2) redraw(); });
  ro.observe(el);
  chartKills.push(() => ro.disconnect());
}

// A bar or area fill that is a touch lighter at the top, so flat colours get some body.
function lighten(hex, k = 0.22) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * k));
  return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
const gradId = (pre, color) => `${pre}-${color.slice(1)}`;
const barDefs = (pre, colors) => `<defs>${[...new Set(colors)].map((c) => `<linearGradient id="${gradId(pre, c)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lighten(c)}"/><stop offset="1" stop-color="${c}"/></linearGradient>`).join('')}</defs>`;
let chartUid = 0;

// line / area over dates
// series: [{ name, color, area, points: [[isoDate, cents], ...] }]

function mountLine(el, { series, fmt = money, tipFmt = fmt, height = 220, axes = true, label = 'Chart', zero = true, today = null }) {
  const uid = `l${++chartUid}`;
  const draw = () => {
    const again = seenDraw(el);
    const W = chartW(el);
    const H = height;
    const L = axes ? 46 : 4;
    const R = 10;
    const T = 10;
    const B = axes ? 24 : 4;
    const all = series.flatMap((s) => s.points);
    if (!all.length) { el.innerHTML = ''; return; }
    const ts = all.map((p) => Date.parse(p[0]));
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts);
    const vals = all.map((p) => p[1]);
    const { min, max, ticks } = niceRange(Math.min(...vals), Math.max(...vals), axes ? 4 : 2, zero);
    const x = (iso) => L + (t1 === t0 ? (W - L - R) / 2 : ((Date.parse(iso) - t0) / (t1 - t0)) * (W - L - R));
    const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
    const grid = axes ? distinctTicks(ticks, fmt).map((v) => `<line x1="${L}" x2="${W - R}" y1="${fx(y(v))}" y2="${fx(y(v))}" stroke="${v === 0 ? '#34403a' : VIZ_GRID}" stroke-width="1"/><text x="${L - 6}" y="${fx(y(v) + 4)}" text-anchor="end" class="vt">${fmt(v)}</text>`).join('') : '';
    // Three date labels: first, middle, last.
    const seenLbl = new Set();
    const xl = axes ? [0, 0.5, 1].map((k, i) => {
      const t = new Date(t0 + (t1 - t0) * k).toISOString().slice(0, 10);
      const text = `${Number(t.slice(8, 10))} ${monthShort(t)}${t0 + 31536e6 < t1 ? ` ${t.slice(2, 4)}` : ''}`;
      if (seenLbl.has(text)) return '';
      seenLbl.add(text);
      return `<text x="${fx(x(t))}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}" class="vt">${esc(text)}</text>`;
    }).join('') : '';
    const tm = today && Date.parse(today) >= t0 && Date.parse(today) <= t1 ? `<line x1="${fx(x(today))}" x2="${fx(x(today))}" y1="${T}" y2="${H - B}" stroke="${VIZ_MUTED}" stroke-width="1" stroke-dasharray="2 4"/>` : '';
    const paths = series.map((s, si) => {
      const pts = s.points.map((p) => `${fx(x(p[0]))} ${fx(y(p[1]))}`);
      const d = `M${pts.join('L')}`;
      const base = zero ? fx(y(Math.max(min, 0))) : fx(H - B);
      const area = s.area ? `<path d="${d}L${fx(x(s.points.at(-1)[0]))} ${base}L${fx(x(s.points[0][0]))} ${base}Z" fill="url(#${uid}g${si})" class="vfade"/>` : '';
      const last = s.points.at(-1);
      const end = s.endDot === false ? '' : `<circle cx="${fx(x(last[0]))}" cy="${fx(y(last[1]))}" r="3.5" fill="${s.color}" stroke="#131615" stroke-width="2" class="vfade"/>`;
      return `<defs><linearGradient id="${uid}g${si}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".34"/><stop offset=".7" stop-color="${s.color}" stop-opacity=".06"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" class="vline" pathLength="1"/>${end}`;
    }).join('');
    el.innerHTML = `<div class="viz"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${grid}${xl}${tm}${paths}<g class="vhover" hidden><line y1="${T}" y2="${H - B}" stroke="${VIZ_INK}" stroke-width="1" stroke-dasharray="3 3"/>${series.map((s) => `<circle r="4.5" fill="${s.color}" stroke="#131615" stroke-width="2"/>`).join('')}</g><rect class="vhit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg></div>`;
    const svg = $('svg', el);
    const hover = $('.vhover', svg);
    const tip = tipBox($('.viz', el));
    const flat = series[0].points;
    $('.viz', el).classList.toggle('still', again);
    const show = (clientX) => {
      const r = svg.getBoundingClientRect();
      const px = clientX - r.left;
      const t = t0 + ((px - L) / (W - L - R)) * (t1 - t0);
      let best = 0;
      flat.forEach((p, i) => { if (Math.abs(Date.parse(p[0]) - t) < Math.abs(Date.parse(flat[best][0]) - t)) best = i; });
      const date = flat[best][0];
      const hx = x(date);
      $('line', hover).setAttribute('x1', fx(hx));
      $('line', hover).setAttribute('x2', fx(hx));
      const dots = $$('circle', hover);
      const rows = series.map((s, si) => {
        const p = s.points.reduce((a, b) => (Math.abs(Date.parse(b[0]) - Date.parse(date)) < Math.abs(Date.parse(a[0]) - Date.parse(date)) ? b : a));
        dots[si].setAttribute('cx', fx(x(p[0])));
        dots[si].setAttribute('cy', fx(y(p[1])));
        return `<div class="tr"><i class="sw" data-bg="${s.color}"></i><span>${esc(s.name)}</span><b class="num">${esc(tipFmt(p[1]))}</b></div>`;
      }).join('');
      hover.hidden = false;
      tip.innerHTML = `<div class="th">${esc(dmy(date))}</div>${rows}`;
      applyDims(tip);
      placeTip($('.viz', el), tip, hx, y(flat[best][1]));
    };
    const hit = $('.vhit', svg);
    hit.addEventListener('pointermove', (e) => show(e.clientX));
    hit.addEventListener('pointerdown', (e) => show(e.clientX));
    hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { hover.hidden = true; tip.hidden = true; } });
    document.addEventListener('pointerdown', function away(e) { if (!el.isConnected) return document.removeEventListener('pointerdown', away); if (!el.contains(e.target)) { hover.hidden = true; tip.hidden = true; } });
  };
  draw();
  watchWidth(el, draw);
}

// bars
// cols: [{ label, tip, values: { key: cents } }]; keys: [{ key, name, color }]
// mode 'stack' stacks the keys; 'group' puts them side by side.
// Optional: a column's `dim` fades its bars (data that only part covers) and `notes` adds
// plain lines to its tooltip; `markers` ({ name, color, values: [cents | null per column] })
// lays a short tick across each column at a value (a figure to compare the bars with);
// `total: false` drops the tooltip's Total row; `every` forces the label spacing.

function mountBars(el, { cols, keys, mode = 'stack', fmt = compact, tipFmt = money, height = 230, label = 'Chart', onPick = null, ref = null, markers = null, total = true, every: everyOpt = null }) {
  const uid = `b${++chartUid}`;
  const draw = () => {
    const again = seenDraw(el);
    const W = chartW(el);
    const H = height;
    const L = 46;
    const R = 6;
    const T = 10;
    const B = 24;
    const sum = (c) => keys.reduce((s, k) => s + Math.max(0, c.values[k.key] ?? 0), 0);
    const top = Math.max(1, ref?.value ?? 0, ...(markers?.values ?? []).map((v) => v ?? 0), ...cols.map((c) => (mode === 'stack' ? sum(c) : Math.max(...keys.map((k) => c.values[k.key] ?? 0)))));
    const { max, ticks } = niceRange(0, top, 4);
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const slot = (W - L - R) / cols.length;
    const bw = Math.max(4, Math.min(mode === 'stack' ? 36 : 22, slot * (mode === 'stack' ? 0.62 : 0.78)));
    const grid = distinctTicks(ticks, fmt).map((v) => `<line x1="${L}" x2="${W - R}" y1="${fx(y(v))}" y2="${fx(y(v))}" stroke="${v === 0 ? '#34403a' : VIZ_GRID}" stroke-width="1"/><text x="${L - 6}" y="${fx(y(v) + 4)}" text-anchor="end" class="vt">${fmt(v)}</text>`).join('');
    const every = everyOpt ?? Math.ceil(cols.length / Math.max(2, Math.floor((W - L) / 44)));
    let marks = '';
    cols.forEach((c, i) => {
      const cx = L + slot * i + slot / 2;
      if ((i % every === 0 && cols.length - 1 - i >= every * 0.75) || i === cols.length - 1) marks += `<text x="${fx(cx)}" y="${H - 6}" text-anchor="middle" class="vt">${esc(c.label)}</text>`;
      if (mode === 'stack') {
        let acc = 0;
        const segs = keys.filter((k) => (c.values[k.key] ?? 0) > 0);
        segs.forEach((k, si) => {
          const v = c.values[k.key];
          const y1 = y(acc + v);
          const y0 = y(acc) - (si > 0 ? 2 : 0); // 2px surface gap between fills
          const h = y0 - y1;
          acc += v;
          marks += `<path d="${barPath(cx - bw / 2, y1, bw, h, 5)}" fill="url(#${gradId(uid, k.color)})" class="bar" data-i="${i}"${c.dim ? ' fill-opacity=".4"' : ''}/>`;
        });
      } else {
        const gw = (bw * keys.length + 2 * (keys.length - 1));
        keys.forEach((k, ki) => {
          const v = c.values[k.key] ?? 0;
          if (v <= 0) return;
          marks += `<path d="${barPath(cx - gw / 2 + ki * (bw + 2), y(v), bw, y(0) - y(v), 5)}" fill="url(#${gradId(uid, k.color)})" class="bar" data-i="${i}"/>`;
        });
      }
      const mv = markers?.values[i];
      if (mv != null) marks += `<line x1="${fx(cx - bw / 2 - 5)}" x2="${fx(cx + bw / 2 + 5)}" y1="${fx(y(mv))}" y2="${fx(y(mv))}" stroke="${markers.color}" stroke-width="2.5" stroke-linecap="round" class="vmark" data-i="${i}"/>`;
      marks += `<rect x="${fx(L + slot * i)}" y="${T}" width="${fx(slot)}" height="${H - T - B}" fill="transparent" class="vcol" data-c="${i}"/>`;
    });
    // A dashed reference line (an average), drawn over the bars with its label at the right edge.
    if (ref) marks += `<line x1="${L}" x2="${W - R}" y1="${fx(y(ref.value))}" y2="${fx(y(ref.value))}" stroke="${VIZ_INK}" stroke-width="1.25" stroke-dasharray="5 4" class="vrefl"/><text x="${W - R}" y="${fx(y(ref.value) - 5)}" text-anchor="end" class="vt vref">${esc(ref.label)}</text>`;
    el.innerHTML = `<div class="viz"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${barDefs(uid, keys.map((k) => k.color))}${grid}${marks}<rect class="vsel" hidden y="${T}" height="${H - T - B}" fill="#ffffff" fill-opacity=".05" rx="10"/></svg></div>`;
    const svg = $('svg', el);
    const tip = tipBox($('.viz', el));
    const sel = $('.vsel', svg);
    $('.viz', el).classList.toggle('still', again);
    const show = (i) => {
      const c = cols[i];
      const rows = keys.map((k) => ({ k, v: c.values[k.key] ?? 0 })).filter((r) => r.v !== 0).sort((a, b) => b.v - a.v);
      const totalRow = mode === 'stack' && total ? `<div class="tr tot"><span>Total</span><b class="num">${esc(tipFmt(rows.reduce((s, r) => s + r.v, 0)))}</b></div>` : '';
      const mv = markers?.values[i];
      const markRow = mv != null ? `<div class="tr"><i class="sw" data-bg="${markers.color}"></i><span>${esc(markers.name)}</span><b class="num">${esc(tipFmt(mv))}</b></div>` : '';
      const notes = (c.notes ?? []).map((n) => `<div class="tr dim"><span>${esc(n)}</span></div>`).join('');
      tip.innerHTML = `<div class="th">${esc(c.tip ?? c.label)}</div>${rows.map((r) => `<div class="tr"><i class="sw" data-bg="${r.k.color}"></i><span>${esc(r.k.name)}</span><b class="num">${esc(tipFmt(r.v))}</b></div>`).join('')}${markRow}${totalRow}${notes}${!rows.length && mv == null && !notes ? '<div class="tr"><span>Nothing</span></div>' : ''}`;
      applyDims(tip);
      const cx = L + slot * i + slot / 2;
      sel.setAttribute('x', fx(L + slot * i + 1));
      sel.setAttribute('width', fx(slot - 2));
      sel.hidden = false;
      placeTip($('.viz', el), tip, cx, T + 30);
    };
    svg.addEventListener('pointerdown', (e) => { const c = e.target.closest('.vcol'); if (c) show(Number(c.dataset.c)); });
    svg.addEventListener('pointermove', (e) => { const c = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.vcol'); if (c && svg.contains(c)) show(Number(c.dataset.c)); });
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { sel.hidden = true; tip.hidden = true; } });
    if (onPick) svg.addEventListener('click', (e) => { const c = e.target.closest('.vcol'); if (c) onPick(Number(c.dataset.c)); });
    document.addEventListener('pointerdown', function away(e) { if (!el.isConnected) return document.removeEventListener('pointerdown', away); if (!el.contains(e.target)) { sel.hidden = true; tip.hidden = true; } });
  };
  draw();
  watchWidth(el, draw);
}

// Legend: a chip per series. Click isolates it through onToggle(key).
function legendHtml(keys, hidden = new Set()) {
  return `<div class="legend" role="group" aria-label="Series">${keys.map((k) => `<button type="button" class="lg ${hidden.has(k.key) ? 'off' : ''}" data-key="${esc(k.key)}" aria-pressed="${!hidden.has(k.key)}"><i class="sw" data-bg="${k.color}"></i>${esc(k.name)}</button>`).join('')}</div>`;
}

// Every chart has a table view for reading the numbers (and for screen readers).
function tableHtml(head, rows) {
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head.map((h, i) => `<th scope="col" class="${i ? 'r' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'r num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// A card with a title, the chart, and a switch between chart and table.
function chartCard({ id, title, note = '', icon = I.chartLine }) {
  return `<section class="card chart" id="${id}"><div class="chart-head card-h"><span class="card-ic">${icon}</span><h3 class="card-t ct">${esc(title)}</h3><button class="x sm" type="button" data-tbl aria-label="Show as table" aria-pressed="false" title="Show as table">${I.table}</button></div>${note}<div class="legend-slot"></div><div class="plot"></div><div class="tbl-slot" hidden></div></section>`;
}
function wireChartCard(card, { tableFn }) {
  const btn = $('[data-tbl]', card);
  btn?.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Show as chart' : 'Show as table';
    btn.setAttribute('aria-label', btn.title);
    $('.plot', card).hidden = on;
    $('.legend-slot', card).hidden = on;
    const slot = $('.tbl-slot', card);
    slot.hidden = !on;
    if (on) slot.innerHTML = tableFn();
    buzz(6);
  });
}
