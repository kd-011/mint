// Reports and charts: spend by category over time, cash flow, top merchants,
// year on year, and net worth history. Inline SVG, no library. The range is in
// the URL (?range=), and every chart has a table view.
'use strict';

const REPORT_RANGES = [['3M', '3M'], ['6M', '6M'], ['12M', '12M'], ['FY', 'This FY']];

function rangeMonths(range, cur) {
  if (range === 'FY') {
    const fy = fyOfIso(todayIso());
    return { from: `${fy - 1}-07`, to: cur };
  }
  const n = { '3M': 3, '6M': 6, '12M': 12 }[range] ?? 6;
  return { from: addMonth(cur, -(n - 1)), to: cur };
}
function emptyPlot(card, html) {
  const l = $('.legend-slot', card);
  if (l) l.innerHTML = '';
  $('.cnote', card)?.remove();
  const plot = $('.plot', card);
  plot.hidden = false;
  plot.innerHTML = html;
  card._table = () => '';
}
const monthsBetween = (from, to) => { const out = []; for (let m = from; m <= to; m = addMonth(m, 1)) out.push(m); return out; };

async function viewReports(el, token) {
  const cur = todayIso().slice(0, 7);
  const p = new URLSearchParams(location.search);
  let range = REPORT_RANGES.some(([k]) => k === p.get('range')) ? p.get('range') : '6M';
  const hidden = new Set(store.get('rep-hidden') ?? ['nw-a', 'nw-l']);
  const data = { monthly: null, merchants: null, nw: null };

  el.innerHTML = `<div class="rangebar">${segmented('range', REPORT_RANGES, range)}</div>
    <div class="rows rollup-link"><a class="row" href="/budgets?month=${cur}" data-nav><div class="ic">${I.target}</div><div class="main"><div class="t1">Budgets by month</div></div>${I.chevron}</a></div>
    <div id="repbox"></div>`;
  wireSeg(el, 'range', (v) => { history.replaceState({}, '', v === '6M' ? '/reports' : `/reports?range=${v}`); render({ keepScroll: false }); });
  const box = $('#repbox', el);
  // The merchant list is numbers you can tap, so it leads; the charts follow.
  box.innerHTML = [`<section class="card chart" id="c-merch"><div class="chart-head card-h"><span class="card-ic">${I.bag}</span><h3 class="card-t ct">Top merchants</h3></div><div class="plot">${skeletonRows(4)}</div></section>`, chartCard({ id: 'c-spend', title: 'Spend by category', icon: I.chart }), chartCard({ id: 'c-flow', title: 'Income and spend', icon: I.swap }), chartCard({ id: 'c-yoy', title: 'Year on year', icon: I.calendar }), chartCard({ id: 'c-nw', title: 'Net worth', icon: I.bank })].join('');
  $$('.plot', box).forEach((n) => { if (!n.innerHTML) { n.innerHTML = skeletonCard(200); applyDims(n); } });

  const fromWin = rangeMonths(range, cur);
  const monthKeys = monthsBetween(fromWin.from, fromWin.to);
  const nwDays = range === 'FY' ? 366 : { '3M': 92, '6M': 183, '12M': 366 }[range];
  const fail = (id, what, again) => (e) => {
    if (token !== renderToken) return;
    const card = $(`#${id}`, box);
    card.innerHTML = `<div class="chart-head card-h"><span class="card-ic">${I.alert}</span><h3 class="card-t ct">${esc(what)}</h3></div>${errorCard(e, `${id}-retry`, what.toLowerCase())}`;
    $(`#${id}-retry`, card)?.addEventListener('click', again);
  };

  // Stable colours: by overall 24 month spend, so changing the range never repaints a category.
  const catOrder = (all) => {
    const tot = new Map();
    for (const c of all.categories) tot.set(c.category_id, { id: c.category_id, name: c.name, total: (tot.get(c.category_id)?.total ?? 0) + c.spent });
    return [...tot.values()].sort((a, b) => b.total - a.total).slice(0, VIZ.length).map((c, i) => ({ key: String(c.id), name: c.name, color: VIZ[i] }));
  };

  function paintSpend() {
    const card = $('#c-spend', box);
    const m = data.monthly;
    if (token !== renderToken || !m) return;
    const keys = catOrder(m);
    const inKeys = new Set(keys.map((k) => k.key));
    const allKeys = [...keys, { key: 'other', name: 'Other', color: VIZ_OTHER }];
    const shown = allKeys.filter((k) => !hidden.has(k.key));
    const cols = monthKeys.map((mo) => {
      const values = {};
      for (const c of m.categories) if (c.month === mo) { const k = inKeys.has(String(c.category_id)) ? String(c.category_id) : 'other'; if (!hidden.has(k)) values[k] = (values[k] ?? 0) + c.spent; }
      return { label: monthShort(mo), tip: monthLabel(mo), values };
    });
    const total = cols.reduce((s, c) => s + Object.values(c.values).reduce((a, b) => a + b, 0), 0);
    if (!total) { emptyPlot(card, emptyState({ icon: I.chart, title: 'No spending in this range', line: 'Nothing categorised yet.' })); return; }
    $('.legend-slot', card).innerHTML = legendHtml(allKeys, hidden);
    applyDims(card);
    $('.plot', card).innerHTML = '';
    mountBars($('.plot', card), { cols, keys: shown, mode: 'stack', label: `Monthly spend by category, ${money0(total)} in total`, onPick: null });
    const avg = Math.round(total / monthKeys.length);
    let note = $('.cnote', card);
    if (!note) { note = document.createElement('div'); note.className = 'cnote sub'; $('.chart-head', card).after(note); }
    note.innerHTML = `<b class="num">${esc(money0(total))}</b> over ${plural(monthKeys.length, 'month')}, <span class="num">${esc(money0(avg))}</span> a month`;
    card._table = () => tableHtml(['Month', ...shown.map((k) => k.name), 'Total'], cols.map((c, i) => [monthShort(monthKeys[i]) + ' ' + monthKeys[i].slice(2, 4), ...shown.map((k) => money0(c.values[k.key] ?? 0)), money0(shown.reduce((s, k) => s + (c.values[k.key] ?? 0), 0))]));
  }
  function paintFlow() {
    const card = $('#c-flow', box);
    const m = data.monthly;
    if (token !== renderToken || !m) return;
    const rows = m.months.filter((x) => x.month >= fromWin.from && x.month <= fromWin.to);
    const keys = [{ key: 'income', name: 'Income', color: VIZ_ACCENT }, { key: 'spent', name: 'Spend', color: VIZ[1] }];
    $('.legend-slot', card).innerHTML = legendHtml(keys);
    applyDims(card);
    const inc = rows.reduce((s, r) => s + r.income, 0);
    const sp = rows.reduce((s, r) => s + r.spent, 0);
    let note = $('.cnote', card);
    if (!note) { note = document.createElement('div'); note.className = 'cnote sub'; $('.chart-head', card).after(note); }
    note.innerHTML = `Saved <b class="num ${inc - sp >= 0 ? 'pos' : 'neg-red'}">${esc(money0(inc - sp))}</b> of <span class="num">${esc(money0(inc))}</span> earned`;
    $('.plot', card).innerHTML = '';
    mountBars($('.plot', card), { cols: rows.map((r) => ({ label: monthShort(r.month), tip: monthLabel(r.month), values: { income: r.income, spent: r.spent } })), keys, mode: 'group', height: 200, label: 'Income against spend per month' });
    card._table = () => tableHtml(['Month', 'Income', 'Spend', 'Net'], rows.map((r) => [`${monthShort(r.month)} ${r.month.slice(2, 4)}`, money0(r.income), money0(r.spent), money0(r.net)]));
  }
  function paintYoy() {
    const card = $('#c-yoy', box);
    const m = data.monthly;
    if (token !== renderToken || !m) return;
    const last12 = monthsBetween(addMonth(cur, -11), cur);
    const by = new Map(m.months.map((x) => [x.month, x.spent]));
    const rows = last12.map((mo) => ({ mo, now: by.get(mo) ?? 0, before: by.get(addMonth(mo, -12)) ?? 0 }));
    const nowT = rows.reduce((s, r) => s + r.now, 0);
    const prevT = rows.reduce((s, r) => s + r.before, 0);
    const keys = [{ key: 'before', name: 'A year earlier', color: VIZ_MUTED }, { key: 'now', name: 'Last 12 months', color: VIZ_ACCENT }];
    // Two years of history or nothing: a short book would read as a fake spike.
    if (rows.filter((r) => r.before > 0).length < 6) { emptyPlot(card, emptyState({ icon: I.chart, title: 'Needs a second year', line: 'Needs 12 months before.' })); return; }
    $('.legend-slot', card).innerHTML = legendHtml(keys);
    applyDims(card);
    const diff = nowT - prevT;
    let note = $('.cnote', card);
    if (!note) { note = document.createElement('div'); note.className = 'cnote sub'; $('.chart-head', card).after(note); }
    note.innerHTML = `<b class="num ${diff > 0 ? 'neg-red' : 'pos'}">${diff > 0 ? '+' : ''}${esc(money0(diff))}</b> (${diff > 0 ? '+' : ''}${Math.round((diff / prevT) * 100)}%) on the year before`;
    $('.plot', card).innerHTML = '';
    mountBars($('.plot', card), { cols: rows.map((r) => ({ label: monthShort(r.mo), tip: `${monthLabel(r.mo)} against ${monthLabel(addMonth(r.mo, -12))}`, values: { before: r.before, now: r.now } })), keys, mode: 'group', height: 200, label: 'Spend by month against the same month a year earlier' });
    card._table = () => tableHtml(['Month', 'This year', 'Year before', 'Change'], rows.map((r) => [`${monthShort(r.mo)} ${r.mo.slice(2, 4)}`, money0(r.now), money0(r.before), money0(r.now - r.before)]));
  }
  function paintMerchants() {
    const card = $('#c-merch', box);
    const d = data.merchants;
    if (token !== renderToken || !d) return;
    const max = Math.max(1, ...d.items.map((x) => x.spent));
    const from = `${fromWin.from}-01`;
    card.innerHTML = `<div class="chart-head card-h"><span class="card-ic">${I.bag}</span><h3 class="card-t ct">Top merchants</h3></div>${d.items.length
      ? `<div class="hbars stagger">${d.items.map((x, i) => `<a class="hbar" href="/transactions?q=${encodeURIComponent(x.merchant)}&from=${from}&direction=out" data-nav><span class="hn"><span class="hr num">${i + 1}</span>${esc(x.merchant)}</span><span class="hv num">${esc(money0(x.spent))}</span><span class="meter sm"><i data-w="${Math.max(2, Math.round((x.spent / max) * 100))}"></i></span><span class="hc">${plural(x.count, 'charge')}</span></a>`).join('')}</div>`
      : emptyState({ icon: I.chart, title: 'No merchants yet', line: 'Nothing filed yet.' })}`;
    applyDims(card);
    stagger($('.hbars', card) ?? card);
  }
  function paintNw() {
    const card = $('#c-nw', box);
    const d = data.nw;
    if (token !== renderToken || !d) return;
    const pts = d.items.map((x) => [x.date, x.net_worth]);
    if (pts.length < 2) { emptyPlot(card, emptyState({ icon: I.chartLine, title: 'History is just starting', line: 'The line appears after two days.' })); return; }
    const a = d.items.map((x) => [x.date, x.assets]);
    const l = d.items.map((x) => [x.date, -x.liabilities]);
    const keys = [{ key: 'nw', name: 'Net worth', color: VIZ_ACCENT }, { key: 'a', name: 'Assets', color: VIZ[0] }, { key: 'l', name: 'Owed', color: VIZ[1] }];
    const delta = pts.at(-1)[1] - pts[0][1];
    let note = $('.cnote', card);
    if (!note) { note = document.createElement('div'); note.className = 'cnote sub'; $('.chart-head', card).after(note); }
    note.innerHTML = `<b class="num ${delta >= 0 ? 'pos' : 'neg-red'}">${delta >= 0 ? '+' : ''}${esc(money0(delta))}</b> since ${esc(dmy(pts[0][0]))}`;
    const draw = () => {
      const on = keys.filter((k) => !hidden.has(`nw-${k.key}`));
      const ser = { nw: { name: 'Net worth', color: VIZ_ACCENT, area: true, points: pts }, a: { name: 'Assets', color: VIZ[0], points: a }, l: { name: 'Owed', color: VIZ[1], points: l } };
      $('.plot', card).innerHTML = '';
      mountLine($('.plot', card), { series: on.map((k) => ser[k.key]), height: 220, fmt: compact, tipFmt: money, label: 'Net worth, assets and amount owed over time', zero: false });
    };
    $('.legend-slot', card).innerHTML = legendHtml(keys.map((k) => ({ ...k, key: `nw-${k.key}` })), hidden);
    applyDims(card);
    draw();
    card._redraw = draw;
    const step = Math.max(1, Math.floor(pts.length / 12));
    card._table = () => tableHtml(['Date', 'Net worth', 'Assets', 'Owed'], d.items.filter((_, i) => i % step === 0 || i === d.items.length - 1).map((x) => [dmy(x.date), money0(x.net_worth), money0(x.assets), money0(-x.liabilities)]));
  }

  const load = {
    monthly: () => swr(`/api/reports/monthly?from=${addMonth(cur, -23)}&to=${cur}`, (d) => { data.monthly = d; paintSpend(); paintFlow(); paintYoy(); wireTables(); }).catch((e) => { fail('c-spend', 'Spend by category', load.monthly)(e); fail('c-flow', 'Income and spend', load.monthly)(e); fail('c-yoy', 'Year on year', load.monthly)(e); }),
    merchants: () => swr(`/api/reports/merchants?from=${fromWin.from}-01&to=${todayIso()}&limit=10`, (d) => { data.merchants = d; paintMerchants(); }).catch(fail('c-merch', 'Top merchants', load.merchants)),
    nw: () => swr(`/api/networth/history?from=${isoOffset(todayIso(), -nwDays)}`, (d) => { data.nw = d; paintNw(); wireTables(); }).catch(fail('c-nw', 'Net worth', load.nw)),
  };
  Object.values(load).forEach((f) => f());

  // Table toggles read whatever the card last drew.
  function wireTables() {
    for (const card of $$('.chart', box)) {
      if (card._wired || !$('[data-tbl]', card)) continue;
      card._wired = true;
      wireChartCard(card, { tableFn: () => card._table?.() ?? '' });
    }
  }
  box.addEventListener('click', (e) => {
    const lg = e.target.closest('.lg');
    if (!lg) return;
    const card = lg.closest('.chart');
    const key = lg.dataset.key;
    const group = [...$$('.lg', card)].length;
    if (hidden.has(key)) hidden.delete(key);
    else if (group - $$('.lg.off', card).length > 1) hidden.add(key);
    else { toast('Keep at least one series on', { error: false }); return; }
    store.set('rep-hidden', [...hidden]);
    buzz(6);
    if (card.id === 'c-spend') paintSpend();
    if (card.id === 'c-nw') paintNw();
  });

}
