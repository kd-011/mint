// Save and Invest, shares and ETFs. Holdings are typed in (no brokerage feed);
// prices come from the server's cache, never from this page, and each row says
// when a price is old, failed, or entered by hand. Mint shows; it does not
// trade and gives no advice. Names here are prefixed sh so they cannot clash
// with the other scripts that share one global scope.
'use strict';

const SH_CLASS = { au_shares: 'AU shares', international: 'International', etf: 'ETF' };
const shPct = (r, d = 1) => (r == null ? 'n/a' : `${r > 0 ? '+' : ''}${(r * 100).toFixed(d)}%`);
const shTone = (c) => (c > 0 ? 'pos' : c < 0 ? 'neg-red' : '');
const shUnits = (u) => Number(u).toLocaleString('en-AU', { maximumFractionDigits: 6 });
const shNum = (s) => (String(s ?? '').trim() === '' ? NaN : Number(String(s).replace(/[$,\s]/g, '')));
const shSigned = (c) => `${c > 0 ? '+' : c < 0 ? '-' : ''}${money(Math.abs(c))}`;

function shChips(h) {
  const out = [`<span class="chip">${esc(h.exchange)}</span>`];
  if (h.fx_missing) out.push('<span class="chip bad" title="No AUD exchange rate yet, so this is left out of the totals">No FX rate</span>');
  else if (h.price.source === 'manual') out.push('<span class="chip" title="You entered this price">Manual</span>');
  else if (!h.priced) out.push('<span class="chip warn" title="Valued at cost until a price arrives">No price</span>');
  else if (h.price.stale) out.push(`<span class="chip warn" title="${esc(h.price.note ?? '')}">Stale</span>`);
  return out.join(' ');
}

function shRow(h) {
  const day = h.day_change == null ? '' : `Today ${shSigned(h.day_change)} (${shPct(h.day_change_pct)}) · `;
  const gain = h.gain == null ? '' : `${shSigned(h.gain)}${h.gain_pct == null ? '' : ` (${shPct(h.gain_pct)})`}`;
  const price = h.price.value == null ? 'no price yet' : unitPrice(h.price.value, h.currency);
  return `<button class="row" type="button" data-hold="${h.id}"><div class="ic">${I.chartLine}</div>
    <div class="main"><div class="t1">${esc(h.ticker)} ${shChips(h)}</div>
      <div class="t2 num">${esc(shUnits(h.units))} units · ${esc(price)}</div>
      <div class="t2 num"><span class="${shTone(h.day_change ?? 0)}">${esc(day)}</span><span class="${shTone(h.gain ?? 0)}">${esc(gain)}</span></div></div>
    <div class="amt num">${h.value == null ? 'n/a' : esc(money0(h.value))}</div></button>`;
}

function shPricesLine(p) {
  if (!p.configured) return '<p class="sub warnc">No price source, enter prices by hand</p>';
  const when = p.last_ok_at ? `Prices updated ${esc(ago(p.last_ok_at))}` : 'Waiting for the first price';
  const err = p.last_error ? ` <span class="warnc">Last fetch failed: ${esc(p.last_error)}</span>` : '';
  const note = p.note ? `<p class="sub warnc">${esc(p.note)}</p>` : '';
  return `<p class="sub">${when}${err}</p>${note}<p class="sub">ASX prices from Yahoo Finance (unofficial, personal use only), US prices from Alpha Vantage.</p>`;
}

function shAllocation(d) {
  const t = d.totals;
  if (!t.count) return '';
  const rows = (items, label) => items.filter((x) => x.value > 0).map((x) => `<div class="hbar"><span class="hn">${esc(label(x))}</span><span class="hv num">${esc((x.pct * 100).toFixed(1))}% · ${esc(money0(x.value))}</span><span class="meter sm"><i data-w="${Math.max(2, Math.round(x.pct * 100))}"></i></span></div>`).join('');
  const top = d.allocation.by_holding.slice(0, 8);
  const rest = d.allocation.by_holding.slice(8);
  const holdings = top.concat(rest.length ? [{ ticker: `${rest.length} more`, value: rest.reduce((s, x) => s + x.value, 0), pct: rest.reduce((s, x) => s + x.pct, 0) }] : []);
  return `<section class="card">${cardHead(I.grid, 'By asset class')}<div class="hbars">${rows(d.allocation.by_class, (x) => x.label)}</div></section>
    <section class="card">${cardHead(I.list, 'By holding')}<div class="hbars">${rows(holdings, (x) => x.ticker)}</div></section>`;
}

async function saveShares(box, token, charts) {
  let d = null;
  const paint = () => {
    if (token !== renderToken || !d) return;
    const t = d.totals;
    const prompts = d.prompts.map((p) => `<div class="nudge" data-prompt="${p.asset_id}">${I.bell}<div><b>${esc(p.name)} is no longer counted in net worth</b><small>Manual value ${esc(money0(p.value))}${p.as_of ? `, ${esc(dmy(p.as_of))}` : ''}</small>
      <div class="two shp"><button class="btn sm" type="button" data-decide="convert" data-asset="${p.asset_id}">${I.check}Convert</button><button class="btn ghost sm" type="button" data-decide="keep" data-asset="${p.asset_id}">Keep counting it</button></div></div></div>`).join('');
    box.innerHTML = `${prompts}${t.count
      ? `<section class="card">${cardHead(I.chartLine, 'Shares and ETFs', `Today <b class="num ${shTone(t.day_change)}">${esc(shSigned(t.day_change))}</b>`)}
        <div class="big2 num">${esc(money0(t.value))}</div>
        <div class="grid2 shsum"><div class="stat"><div class="k">Gain or loss</div><div class="v num ${shTone(t.gain)}">${esc(shSigned(t.gain))}</div><div class="sub num">${esc(shPct(t.gain_pct))} on ${esc(money0(t.cost))} cost</div></div>
          <div class="stat"><div class="k">Holdings</div><div class="v num">${t.count}</div><div class="sub">${t.stale_count ? `${plural(t.stale_count, 'old price')}` : 'Prices current'}${t.unpriced_count ? ` · ${t.unpriced_count} at cost` : ''}</div></div></div>
        ${shPricesLine(d.prices)}
        <button class="btn ghost wide" type="button" id="shrefresh">${I.refresh}Refresh prices</button></section>
        <div class="rows stagger" id="shrows">${d.holdings.map(shRow).join('')}</div>
        <button class="btn ghost wide mt10" type="button" id="shadd">${I.plus}Add a holding</button>`
      : `<div class="card">${emptyState({ icon: I.chartLine, title: 'No shares or ETFs yet', line: 'Add a holding by hand: ticker, units, average cost.', button: { id: 'shadd', label: 'Add a holding', icon: I.plus } })}${shPricesLine(d.prices)}</div>`}`;
    applyDims(box);
    stagger($('#shrows', box) ?? box);
    charts.innerHTML = t.count ? `${chartCard({ id: 'sh-hist', title: 'Portfolio value', icon: I.chartLine })}${shAllocation(d)}` : '';
    applyDims(charts);
    paintHist();
    wireCharts(charts);
  };
  function paintHist() {
    const card = $('#sh-hist', charts);
    if (!card) return;
    const h = d.history;
    if (h.length < 2) {
      $('.plot', card).innerHTML = emptyState({ icon: I.chartLine, title: 'History builds from here', line: 'The line appears after two days.' });
      card._table = () => '';
      $('[data-tbl]', card)?.setAttribute('hidden', '');
      return;
    }
    $('.legend-slot', card).innerHTML = legendHtml([{ key: 'value', name: 'Value', color: VIZ_ACCENT }, { key: 'cost', name: 'Cost', color: VIZ[1] }]);
    $('.legend-slot', card).classList.add('static');
    mountLine($('.plot', card), { series: [{ name: 'Value', color: VIZ_ACCENT, area: true, points: h.map((r) => [r.date, r.value]) }, { name: 'Cost', color: VIZ[1], points: h.map((r) => [r.date, r.cost]) }], height: 200, fmt: compact, tipFmt: money, label: 'Portfolio value and cost over time', zero: false });
    const step = Math.max(1, Math.floor(h.length / 12));
    card._table = () => tableHtml(['Date', 'Value', 'Cost'], h.filter((_, i) => i % step === 0 || i === h.length - 1).map((r) => [dmy(r.date), money(r.value), money(r.cost)]));
  }
  const load = () => swr('/api/holdings', (r) => { d = r; paint(); if (sheetCtx.id != null) sheetCtx.render?.(); }).catch((e) => {
    if (token !== renderToken) return;
    charts.innerHTML = '';
    box.innerHTML = errorCard(e, 'shr-retry', 'your shares and ETFs');
    $('#shr-retry', box)?.addEventListener('click', () => { box.innerHTML = `${skeletonCard(150)}${skeletonRows(2)}`; applyDims(box); load(); });
  });
  const reload = () => { store.del('c:/api/holdings'); store.del('c:/api/networth'); return load(); };
  const sheetCtx = { id: null, render: null, find: (id) => d?.holdings.find((h) => h.id === id) ?? null, reload, get data() { return d; } };
  box.addEventListener('click', async (e) => {
    if (e.target.closest('#shadd')) return openHoldingAdd(reload);
    const row = e.target.closest('[data-hold]');
    if (row && d) return openHolding(Number(row.dataset.hold), sheetCtx);
    const dec = e.target.closest('[data-decide]');
    if (dec) {
      try {
        await withBusy(dec, 'Saving', () => api(`/api/assets/${dec.dataset.asset}/shares-decision`, { method: 'POST', body: { decision: dec.dataset.decide } }));
        toast(dec.dataset.decide === 'convert' ? 'Converted, its history is kept' : 'Still counted in net worth');
        buzz(12);
        store.del('c:/api/assets');
        reload();
      } catch (err) { toast(`Couldn't save that: ${err.detail ?? err.message}`, { error: true }); }
      return;
    }
    if (e.target.closest('#shrefresh')) {
      const btn = e.target.closest('#shrefresh');
      const stop = slowNote(btn.parentElement, 5000, 'Still fetching, the price source can be slow.');
      try {
        const r = await withBusy(btn, 'Fetching prices', () => api('/api/holdings/refresh', { method: 'POST' }));
        if (r.skipped === 'not configured') toast(r.prices.note ?? 'No price source is set up', { error: true });
        else if (r.capped) toast('Daily price limit reached, showing the last prices', { error: true });
        else if (r.failed) toast(`${plural(r.failed, 'price')} could not be fetched: ${r.prices.last_error ?? 'see the row'}`, { error: true });
        else toast(r.fetched ? `${plural(r.fetched, 'price')} updated` : 'Nothing needed fetching');
        buzz(10);
        reload();
      } catch (err) { toast(`Couldn't refresh prices: ${err.detail ?? err.message}`, { error: true }); } finally { stop(); }
    }
  });
  await load();
}

// ====================== add a holding ======================

function openHoldingAdd(done) {
  const panel = openModal(`${sheetHead(null, 'Add a holding')}
    <form class="form" novalidate>
      <div class="field"><label for="hat">Ticker</label><input id="hat" name="ticker" maxlength="10" autocomplete="off" autocapitalize="characters" placeholder="VAS"></div>
      <div class="field"><label>Exchange</label>${segmented('exchange', [['ASX', 'ASX'], ['US', 'US']], 'ASX')}</div>
      <div class="field"><label for="hac">Type</label><select id="hac" name="asset_class"><option value="">Shares (by exchange)</option><option value="etf">ETF</option><option value="au_shares">AU shares</option><option value="international">International</option></select></div>
      <div class="two"><div class="field"><label for="hau">Units</label><input id="hau" name="units" inputmode="decimal" autocomplete="off" placeholder="100"></div>
        <div class="field"><label for="hap">Average cost per unit</label><div class="money-in"><span>$</span><input id="hap" name="avg_cost" inputmode="decimal" autocomplete="off" placeholder="90.00"></div></div></div>
      <p class="sub">US holdings are priced in US dollars, so enter the cost in US dollars too. You can add purchase lots (date, units, price, brokerage) afterwards for an exact cost base.</p>
      <button class="btn wide" type="submit">${I.plus}Add holding</button>
    </form>`);
  const form = $('form', panel);
  const draft = bindDraft(form, 'holding:new');
  const ex = wireSeg(form, 'exchange', () => {});
  const f = { t: $('#hat', form), c: $('#hac', form), u: $('#hau', form), p: $('#hap', form) };
  const check = () => [
    fieldError(f.t, /^[A-Za-z0-9][A-Za-z0-9.\-]{0,9}$/.test(f.t.value.trim()) ? '' : 'A ticker like VAS or BHP'),
    fieldError(f.u, shNum(f.u.value) > 0 ? '' : 'How many units, above zero'),
    fieldError(f.p, shNum(f.p.value) >= 0 ? '' : 'The average price paid, like 90.25'),
  ].every(Boolean);
  form.addEventListener('input', (e) => { if (e.target.closest('.field.bad')) check(); });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!check()) return;
    const body = { ticker: f.t.value.trim().toUpperCase(), exchange: ex() ?? 'ASX', units: shNum(f.u.value), avg_cost: shNum(f.p.value) };
    if (f.c.value) body.asset_class = f.c.value;
    formError(form, null);
    try {
      const r = await withBusy($('button[type=submit]', form), 'Adding', () => mutate({ method: 'POST', path: '/api/holdings', body }));
      draft.clear();
      closeModal();
      if (r.queued) toast('Saved offline, it is added when you are back');
      else { toast(`${body.ticker} added`); buzz(12); }
      done();
    } catch (err) { formError(form, err, 'Add it'); }
  });
}

// ====================== one holding ======================

function openHolding(id, ctx) {
  const h0 = ctx.find(id);
  if (!h0) return;
  ctx.id = id;
  const panel = openSheet('<div id="hbody"></div>', 'holding', { onClose: () => { ctx.id = null; ctx.render = null; } });
  const render = () => {
    const h = ctx.find(id);
    if (!h) { closeSheet(); return; }
    const hasLots = h.lots.length > 0;
    const body = $('#hbody', panel);
    body.innerHTML = `${sheetHead(`${h.exchange} · ${SH_CLASS[h.asset_class]}`, h.ticker)}
      <div class="stat hsum"><div class="k">Value</div><div class="big2 num">${h.value == null ? 'n/a' : esc(money(h.value))}</div>
        <div class="sub num">Cost ${h.cost == null ? 'n/a' : esc(money(h.cost))}${h.gain == null ? '' : ` · <span class="${shTone(h.gain)}">${esc(shSigned(h.gain))} (${esc(shPct(h.gain_pct))})</span>`}</div>
        ${h.day_change == null ? '' : `<div class="sub num ${shTone(h.day_change)}">Today ${esc(shSigned(h.day_change))} (${esc(shPct(h.day_change_pct))})</div>`}</div>
      <p class="sub ${h.price.stale || h.fx_missing ? 'warnc' : ''}">${h.price.value == null ? '' : `${esc(unitPrice(h.price.value, h.currency))} per unit. `}${esc(h.fx_missing ? 'There is no AUD exchange rate yet, so this is left out of the totals until one arrives.' : h.price.note ?? (h.price.source ? `From ${h.price.source}${h.price.fetched_at ? `, ${ago(h.price.fetched_at)}` : ''}.` : ''))}${h.currency === 'USD' && h.fx_rate ? ` Converted at ${esc(h.fx_rate.toFixed(4))} AUD per USD.` : ''}</p>
      <form class="form" id="hpf" novalidate>
        <div class="field"><label for="hmp">Price override (${esc(h.currency)} per unit)</label><div class="money-in"><span>$</span><input id="hmp" name="manual_price" inputmode="decimal" autocomplete="off" value="${esc(dollarsIn(h.manual_price))}" placeholder="Use the live price"></div>
          <div class="sub">Wins over the live price until cleared</div></div>
        <div class="two"><button class="btn" type="submit">${I.check}Use this price</button><button class="btn ghost" type="button" id="hmclear" ${h.manual_price == null ? 'disabled title="No override set"' : ''}>Use live price</button></div>
      </form>
      <form class="form" id="huf" novalidate>
        <div class="two"><div class="field"><label for="hun">Units</label><input id="hun" name="units" inputmode="decimal" autocomplete="off" value="${esc(h.units)}" ${hasLots ? 'disabled' : ''}></div>
          <div class="field"><label for="hca">Average cost per unit</label><div class="money-in"><span>$</span><input id="hca" name="avg_cost" inputmode="decimal" autocomplete="off" value="${esc(dollarsIn(h.avg_cost))}" ${hasLots ? 'disabled' : ''}></div></div></div>
        <div class="field"><label for="hcl">Type</label><select id="hcl" name="asset_class">${Object.entries(SH_CLASS).map(([k, v]) => `<option value="${k}" ${k === h.asset_class ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
        ${hasLots ? '<p class="sub">Units and cost come from the lots below</p>' : ''}
        <button class="btn wide" type="submit">${I.check}Save changes</button>
      </form>
      <div class="sec-head"><h2>Purchase lots</h2></div>
      ${hasLots ? `<div class="rows">${h.lots.map((l) => `<div class="row"><div class="main"><div class="t1 num">${esc(shUnits(l.units))} at ${esc(unitPrice(l.price, h.currency))}</div><div class="t2">${esc(dmy(l.date))}${l.brokerage ? ` · ${esc(money(l.brokerage))} brokerage` : ''}</div></div><button class="x sm" type="button" data-lotdel="${l.id}" aria-label="Remove the ${esc(dmy(l.date))} lot" title="Remove this lot">${I.trash}</button></div>`).join('')}</div>`
        : '<p class="sub pad">No lots</p>'}
      <form class="form" id="hlf" novalidate>
        ${hasLots ? '' : '<p class="sub warnc">The first lot replaces the units and cost above</p>'}
        <div class="two"><div class="field"><label for="hld">Date</label><input id="hld" name="date" type="date" value="${todayIso()}" max="${todayIso()}"></div>
          <div class="field"><label for="hlu">Units</label><input id="hlu" name="units" inputmode="decimal" autocomplete="off"></div></div>
        <div class="two"><div class="field"><label for="hlp">Price per unit</label><div class="money-in"><span>$</span><input id="hlp" name="price" inputmode="decimal" autocomplete="off"></div></div>
          <div class="field"><label for="hlb">Brokerage (optional)</label><div class="money-in"><span>$</span><input id="hlb" name="brokerage" inputmode="decimal" autocomplete="off" placeholder="0.00"></div></div></div>
        <button class="btn ghost wide" type="submit">${I.plus}Add lot</button>
      </form>
      <button class="btn danger wide mt10" type="button" id="hdel">${I.trash}Delete this holding</button>`;
    wire(h);
  };

  const patch = async (h, patchBody, busyBtn, okMsg) => {
    try {
      const r = await withBusy(busyBtn, 'Saving', () => mutate({ method: 'PATCH', path: `/api/holdings/${h.id}`, body: patchBody }));
      toast(r.queued ? 'Saved offline, syncs when you are back' : okMsg);
      buzz(12);
      await ctx.reload();
    } catch (err) { formError(busyBtn.closest('form') ?? $('#hbody', panel), err, 'Save'); }
  };

  function wire(h) {
    const pf = $('#hpf', panel);
    pf.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#hmp', pf);
      const v = shNum(input.value);
      if (!fieldError(input, v > 0 ? '' : 'A price above zero, like 108.86')) return;
      formError(pf, null);
      patch(h, { manual_price: v }, $('button[type=submit]', pf), 'Price override saved');
    });
    $('#hmclear', pf).addEventListener('click', (e) => patch(h, { manual_price: null }, e.currentTarget, 'Back on the live price'));
    const uf = $('#huf', panel);
    uf.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = { asset_class: $('#hcl', uf).value };
      if (!h.lots.length) {
        const u = shNum($('#hun', uf).value);
        const c = shNum($('#hca', uf).value);
        const ok = [fieldError($('#hun', uf), u > 0 ? '' : 'How many units, above zero'), fieldError($('#hca', uf), c >= 0 ? '' : 'The average price paid')].every(Boolean);
        if (!ok) return;
        Object.assign(body, { units: u, avg_cost: c });
      }
      formError(uf, null);
      patch(h, body, $('button[type=submit]', uf), `${h.ticker} saved`);
    });
    const lf = $('#hlf', panel);
    lf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = shNum($('#hlu', lf).value);
      const p = shNum($('#hlp', lf).value);
      const bRaw = $('#hlb', lf).value.trim();
      const b = bRaw ? parseMoney(bRaw) : 0;
      const ok = [fieldError($('#hlu', lf), u > 0 ? '' : 'How many units, above zero'), fieldError($('#hlp', lf), p >= 0 ? '' : 'The price paid per unit'), fieldError($('#hlb', lf), Number.isNaN(b) || b < 0 ? 'An amount like 9.95' : '')].every(Boolean);
      if (!ok) return;
      formError(lf, null);
      try {
        await withBusy($('button[type=submit]', lf), 'Adding', () => api(`/api/holdings/${h.id}/lots`, { method: 'POST', body: { date: $('#hld', lf).value || todayIso(), units: u, price: p, brokerage: b } }));
        toast('Lot added');
        buzz(12);
        await ctx.reload();
      } catch (err) { formError(lf, err, 'Add it'); }
    });
    for (const del of $$('[data-lotdel]', panel)) {
      del.addEventListener('click', async () => {
        const lot = h.lots.find((l) => l.id === Number(del.dataset.lotdel));
        try {
          await api(`/api/holdings/${h.id}/lots/${lot.id}`, { method: 'DELETE' });
          await ctx.reload();
          toast('Lot removed', { ms: 6000, action: { label: 'Undo', fn: async () => {
            try { await api(`/api/holdings/${h.id}/lots`, { method: 'POST', body: { date: lot.date, units: lot.units, price: lot.price, brokerage: lot.brokerage } }); await ctx.reload(); buzz(6); } catch (err) { toast(`Couldn't undo: ${err.detail ?? err.message}`, { error: true }); }
          } } });
          buzz(14);
        } catch (err) { toast(`Couldn't remove the lot: ${err.detail ?? err.message}`, { error: true }); }
      });
    }
    $('#hdel', panel).addEventListener('click', async (e) => {
      try {
        const r = await withBusy(e.currentTarget, 'Deleting', () => api(`/api/holdings/${h.id}`, { method: 'DELETE' }));
        closeSheet();
        await ctx.reload();
        toast(`${h.ticker} deleted`, { ms: 6500, action: { label: 'Undo', fn: async () => {
          try { await api('/api/holdings/restore', { method: 'POST', body: { record: r.record } }); await ctx.reload(); buzz(6); } catch (err) { toast(`Couldn't undo: ${err.detail ?? err.message}`, { error: true }); }
        } } });
        buzz(14);
      } catch (err) { toast(`Couldn't delete ${h.ticker}: ${err.detail ?? err.message}`, { error: true }); }
    });
  }
  ctx.render = render;
  render();
}
