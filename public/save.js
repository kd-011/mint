// Save and Invest: goals and savings, super, and the home loan with its offset.
// One page, three sections in order, each loading and failing on its own. It
// only reads what Mint holds; a loan detail the bank did not send is asked for
// inline, never guessed. Mint plans and shows; it never moves money. The goals
// list is goals.js, the same one Plan shows, so a goal behaves the same on both.
'use strict';

const ratePct = (r) => (r == null ? 'n/a' : `${(r * 100).toFixed(1)}%`);
const monthYearOf = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const yearsMonths = (m) => { const y = Math.floor(m / 12); const r = m % 12; return [y ? plural(y, 'year') : '', r ? plural(r, 'month') : ''].filter(Boolean).join(' ') || 'now'; };
const signedMoney = (c) => `${c > 0 ? '+' : c < 0 ? '-' : ''}${money0(Math.abs(c))}`;

// Wire the table toggle on any chart card that has one and has not been wired.
function wireCharts(root) {
  for (const card of $$('.chart', root)) {
    if (card._wired || !$('[data-tbl]', card)) continue;
    card._wired = true;
    wireChartCard(card, { tableFn: () => card._table?.() ?? '' });
  }
}
function chartNote(card, html) {
  let note = $('.cnote', card);
  if (!note) { note = document.createElement('div'); note.className = 'cnote sub'; $('.chart-head', card).after(note); }
  note.innerHTML = html;
}

async function viewSave(el, token) {
  el.innerHTML = `<section class="svsec" id="sv-savings" aria-label="Goals and savings"><div class="svbody">${skeletonCard(150)}${skeletonRows(2)}</div></section>
    <section class="svsec" id="sv-shares" aria-labelledby="sv-shares-h"><h2 id="sv-shares-h">Shares and ETFs</h2><div class="svbody">${skeletonCard(150)}${skeletonRows(2)}</div></section>
    <section class="svsec" id="sv-super" aria-labelledby="sv-super-h"><h2 id="sv-super-h">Super</h2><div class="svbody">${skeletonCard(140)}</div></section>
    <section class="svsec" id="sv-loan" aria-labelledby="sv-loan-h"><h2 id="sv-loan-h">Home loan and offset</h2><div class="svbody">${skeletonCard(260)}</div></section>
    <section class="svsec chartsec" id="sv-charts" aria-labelledby="sv-charts-h"><h2 id="sv-charts-h">Charts</h2><div class="svbody svc"><div id="svc-savings"></div><div id="svc-shares"></div><div id="svc-super"></div><div id="svc-loan"></div></div></section>`;
  applyDims(el);
  await Promise.all([
    saveSavings($('#sv-savings .svbody', el), token, $('#svc-savings', el)),
    saveShares($('#sv-shares .svbody', el), token, $('#svc-shares', el)),
    saveSuper($('#sv-super .svbody', el), token, $('#svc-super', el)),
    saveLoan($('#sv-loan .svbody', el), token, $('#svc-loan', el)),
  ]);
}

// ====================== savings and goals ======================

function acctRow(a) {
  const offset = a.role === 'offset';
  return `<div class="row"><div class="ic">${offset ? I.house : I.piggy}</div><div class="main"><div class="t1">${esc(acctText(a.name))} <span class="chip">${offset ? 'Offset' : 'Savings'}</span></div>
    ${offset ? '' : `<div class="t2 num">Interest ${esc(money(a.interest.month))} this month · ${esc(money(a.interest.fy))} this FY</div>`}</div><div class="amt num">${esc(money(a.balance))}</div></div>`;
}

function ratePanel(r) {
  const cell = (label, m, when) => {
    const rate = m.rate;
    const tone = rate == null ? '' : rate >= 0 ? 'pos' : 'neg-red';
    const line = m.income <= 0 ? `${when}, no income` : m.net >= 0 ? `${when}, ${money0(m.net)} saved` : `${when}, ${money0(-m.net)} over`;
    return `<div class="stat"><div class="k">${esc(label)}</div><div class="v num ${tone}">${esc(ratePct(rate))}</div><div class="sub num">${esc(line)}</div></div>`;
  };
  return `<div class="grid2">${cell('This month', r.this_month, monthShort(`${r.this_month.month}-01`))}${cell('Last 3 months', r.trailing_3, `${monthShort(`${r.trailing_3.from}-01`)} to ${monthShort(`${r.trailing_3.to}-01`)}`)}</div>`;
}

async function saveSavings(box, token, charts) {
  let sv = null;
  // Goals come first and load on their own (goals.js), so they show (or fail with a retry) whatever the savings read does.
  box.innerHTML = `<div id="goalbox"></div><div id="savbody" class="savbody">${skeletonCard(150)}${skeletonRows(2)}</div>`;
  applyDims(box);
  const goalsLoaded = mountGoals($('#goalbox', box), token);
  const sbox = $('#savbody', box);
  const paint = () => {
    if (token !== renderToken || !sv) return;
    const r = sv.savings_rate;
    const shown = shownSavings(sv); // empty accounts carry a made-up balance in demo mode; the total follows
    sbox.innerHTML = `<div class="sec-head"><h2>Savings accounts</h2></div>${sv.accounts.length
      ? `<section class="card">
          ${cardHead(I.piggy, 'Savings and offset')}
          <div class="big2 num">${esc(money(shown.total_balance))}</div>
          <div class="sub num">Interest ${esc(money(sv.interest.month))} this month · ${esc(money(sv.interest.fy))} ${esc(sv.interest.fy_label)}</div>
        </section>
        <div class="rows stagger">${shown.accounts.map(acctRow).join('')}</div>`
      : `<div class="card">${emptyState({ icon: I.piggy, title: 'No savings accounts found', line: 'No account is marked as savings.', action: { href: '/accounts', label: 'Open Accounts' } })}</div>`}
      <section class="card">${cardHead(I.chartLine, 'Savings rate')}${ratePanel(r)}</section>`;
    applyDims(sbox);
    stagger($('.rows.stagger', sbox) ?? sbox);
    charts.innerHTML = `${chartCard({ id: 'sv-flow', title: 'Income and spend', icon: I.swap })}${sv.accounts.length ? chartCard({ id: 'sv-hist', title: 'Savings balance', icon: I.piggy }) : ''}`;
    paintFlow();
    paintHist();
    wireCharts(charts);
  };
  function paintFlow() {
    const card = $('#sv-flow', charts);
    const m = sv.savings_rate.months;
    const keys = [{ key: 'income', name: 'Income', color: VIZ_ACCENT }, { key: 'spent', name: 'Spend', color: VIZ[1] }];
    $('.legend-slot', card).innerHTML = legendHtml(keys);
    $('.legend-slot', card).classList.add('static');
    applyDims(card);
    mountBars($('.plot', card), { cols: m.map((x) => ({ label: monthShort(`${x.month}-01`), tip: monthLabel(x.month), values: { income: x.income, spent: x.spent } })), keys, mode: 'group', height: 200, label: 'Income against spend for the last four months' });
    card._table = () => tableHtml(['Month', 'Income', 'Spend', 'Saved', 'Rate'], m.map((x) => [monthLabel(x.month), money0(x.income), money0(x.spent), money0(x.net), ratePct(x.rate)]));
  }
  function paintHist() {
    const card = $('#sv-hist', charts);
    if (!card) return;
    const h = sv.history;
    if (h.length < 2) {
      $('.plot', card).innerHTML = emptyState({ icon: I.chartLine, title: 'History builds from here', line: 'The line appears after two days.' });
      card._table = () => '';
      $('[data-tbl]', card)?.setAttribute('hidden', '');
      return;
    }
    mountLine($('.plot', card), { series: [{ name: 'Savings and offset', color: VIZ_ACCENT, area: true, points: h }], height: 200, fmt: compact, tipFmt: money, label: 'Total in savings and offset accounts over time', zero: false });
    const step = Math.max(1, Math.floor(h.length / 12));
    card._table = () => tableHtml(['Date', 'Balance'], h.filter((_, i) => i % step === 0 || i === h.length - 1).map((p) => [dmy(p[0]), money(p[1])]));
  }
  const loadSv = () => swr('/api/savings', (d) => { sv = d; paint(); }).catch((e) => {
    if (token !== renderToken) return;
    charts.innerHTML = '';
    sbox.innerHTML = errorCard(e, 'svr-savings', 'your savings');
    $('#svr-savings', sbox)?.addEventListener('click', () => { sbox.innerHTML = `${skeletonCard(150)}${skeletonRows(2)}`; applyDims(sbox); loadSv(); });
  });
  await Promise.all([loadSv(), goalsLoaded]);
}

// ====================== super ======================

// Mirrors lib/superfund.mjs, for a value saved while offline.
function superChange(history) {
  const last = history.at(-1);
  const prev = history.at(-2);
  if (!last || !prev) return null;
  const amount = last.value - prev.value;
  return { since: prev.date, amount, pct: prev.value > 0 ? Math.round((amount / prev.value) * 10000) / 10000 : null, contribution: last.contribution ?? null, growth: amount - (last.contribution ?? 0) };
}

function superCard(it) {
  const c = it.change;
  const nudge = it.due
    ? `<div class="nudge">${I.bell}<div><b>${it.as_of ? `Updated ${plural(it.days_since, 'day')} ago` : 'No value yet'}</b></div></div>`
    : '';
  const growth = c
    ? `<div class="kvs">
        <div><span>Change since ${esc(dmy(c.since))}</span><b class="num ${c.amount >= 0 ? 'pos' : 'neg-red'}">${esc(signedMoney(c.amount))}${c.pct != null ? ` (${esc((c.pct * 100).toFixed(1))}%)` : ''}</b></div>
        <div><span>Contributions you logged</span><b class="num">${c.contribution == null ? 'None logged' : esc(money0(c.contribution))}</b></div>
        <div><span>Growth</span><b class="num ${c.growth >= 0 ? 'pos' : 'neg-red'}">${esc(signedMoney(c.growth))}</b></div>
      </div>`
    : '';
  return `<section class="card sv-super" data-super="${it.id}">
      ${cardHead(I.briefcase, it.name, `Updated ${it.as_of ? esc(dmy(it.as_of)) : 'never'}`)}
      <div class="big2 num">${it.value == null ? 'Not set' : esc(money0(it.value))}</div>
      ${nudge}${growth}
      <button class="btn wide" type="button" data-superupd="${it.id}">${I.edit}Update balance</button>
    </section>`;
}

async function saveSuper(box, token, charts) {
  let d = null;
  const paint = () => {
    if (token !== renderToken || !d) return;
    box.innerHTML = d.items.length
      ? `${d.items.map(superCard).join('')}<button class="btn ghost wide mt10" type="button" id="addsuper">${I.plus}Add another super fund</button>`
      : `<div class="card">${emptyState({ icon: I.briefcase, title: 'No super yet', line: 'Add your fund and its balance.', button: { id: 'addsuper', label: 'Add your super', icon: I.plus } })}</div>`;
    applyDims(box);
    charts.innerHTML = d.items.map((it) => (it.history.length > 1 ? chartCard({ id: `sv-sh-${it.id}`, title: `${it.name} over time` }) : '')).join('');
    for (const it of d.items) {
      const card = $(`#sv-sh-${it.id}`, charts);
      if (!card) continue;
      const h = it.history;
      const contribs = h.reduce((s, x) => s + (x.contribution ?? 0), 0);
      const first = h[0];
      const last = h.at(-1);
      chartNote(card, `${esc(money0(last.value - first.value))} since ${esc(dmy(first.date))}${contribs ? `, of which ${esc(money0(contribs))} is contributions you logged` : ''}`);
      mountLine($('.plot', card), { series: [{ name: it.name, color: VIZ_ACCENT, area: true, points: h.map((x) => [x.date, x.value]) }], height: 200, fmt: compact, tipFmt: money, label: `${it.name} balance over time`, zero: false });
      card._table = () => tableHtml(['Date', 'Balance', 'Contribution'], [...h].reverse().map((x) => [dmy(x.date), money0(x.value), x.contribution == null ? '' : money0(x.contribution)]));
    }
    wireCharts(charts);
  };
  const reload = () => { store.del('c:/api/super'); store.del('c:/api/review'); return load(); };
  const load = () => swr('/api/super', (r) => { d = r; paint(); }).catch((e) => {
    if (token !== renderToken) return;
    charts.innerHTML = '';
    box.innerHTML = errorCard(e, 'svr-super', 'your super');
    $('#svr-super', box)?.addEventListener('click', () => { box.innerHTML = skeletonCard(140); load(); });
  });
  box.addEventListener('click', (e) => {
    if (e.target.closest('#addsuper')) return openSuperAdd(reload);
    const b = e.target.closest('[data-superupd]');
    if (b) openSuperUpdate(d.items.find((x) => x.id === Number(b.dataset.superupd)), { reload, patch: (it, body) => {
      it.history = [...it.history.filter((x) => x.date !== body.date), { date: body.date, value: body.value, contribution: body.contribution, note: body.note }].sort((x, y) => (x.date < y.date ? -1 : 1));
      const last = it.history.at(-1);
      Object.assign(it, { value: last.value, as_of: last.date, days_since: 0, due: false, snapshots: it.history.length, change: superChange(it.history) });
      paint();
    } });
  });
  await load();
}

function openSuperUpdate(it, { reload, patch }) {
  const panel = openModal(`${sheetHead(it.name, 'Update balance')}
    <form class="form" novalidate>
      <div class="field"><label for="spv">Balance now</label><div class="money-in"><span>$</span><input id="spv" name="value" inputmode="decimal" autocomplete="off" value="${esc(it.value != null ? centsToInput(it.value) : '')}"></div></div>
      <div class="field"><label for="spc">Contributions since the last update (optional)</label><div class="money-in"><span>$</span><input id="spc" name="contribution" inputmode="decimal" autocomplete="off" placeholder="0.00"></div><div class="sub">Employer and personal money that went in. Leave blank if you are not sure; the whole change then counts as growth.</div></div>
      <div class="two"><div class="field"><label for="spd">Date</label><input id="spd" name="date" type="date" value="${todayIso()}" max="${todayIso()}"></div><div class="field"><label for="spn">Note</label><input id="spn" name="note" maxlength="200" autocomplete="off"></div></div>
      <button class="btn wide" type="submit">${I.check}Save balance</button>
    </form>`);
  const form = $('form', panel);
  const d = bindDraft(form, `super:${it.id}`, { skip: ['date'] });
  const val = $('#spv', form);
  const con = $('#spc', form);
  const check = () => {
    const v = parseMoney(val.value);
    const c = con.value.trim() ? parseMoney(con.value) : 0;
    return [
      fieldError(val, !val.value.trim() ? 'Enter the balance' : Number.isNaN(v) || v < 0 ? 'An amount like 45043.00' : ''),
      fieldError(con, Number.isNaN(c) || c < 0 ? 'An amount like 1500.00, zero or more' : ''),
    ].every(Boolean);
  };
  form.addEventListener('input', check);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!check()) return;
    const body = { date: $('#spd', form).value || todayIso(), value: parseMoney(val.value), contribution: con.value.trim() ? parseMoney(con.value) : null, note: $('#spn', form).value.trim() || null };
    formError(form, null);
    try {
      const r = await withBusy($('button[type=submit]', form), 'Saving', () => mutate({ method: 'POST', path: `/api/assets/${it.id}/snapshots`, body }));
      d.clear();
      closeModal();
      if (r.queued) { patch(it, body); toast('Saved offline, syncs when you are back'); } else { toast(`${it.name} saved`); buzz(12); await reload(); }
    } catch (err) { formError(form, err, 'Save'); }
  });
}

function openSuperAdd(done) {
  const panel = openModal(`${sheetHead(null, 'Add your super')}
    <form class="form" novalidate>
      <div class="field"><label for="san">Fund name</label><input id="san" name="name" maxlength="60" autocomplete="off" placeholder="Spaceship Voyager"></div>
      <div class="field"><label for="sav">Balance now</label><div class="money-in"><span>$</span><input id="sav" name="value" inputmode="decimal" autocomplete="off"></div></div>
      <button class="btn wide" type="submit">${I.plus}Add super</button>
    </form>`);
  const form = $('form', panel);
  const d = bindDraft(form, 'super:new');
  const name = $('#san', form);
  const val = $('#sav', form);
  const check = () => [
    fieldError(name, name.value.trim() ? '' : 'Give it a name'),
    fieldError(val, !val.value.trim() ? 'Enter the balance' : Number.isNaN(parseMoney(val.value)) || parseMoney(val.value) < 0 ? 'An amount like 45043.00' : ''),
  ].every(Boolean);
  form.addEventListener('input', check);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!check()) return;
    formError(form, null);
    try {
      await withBusy($('button[type=submit]', form), 'Adding', async () => {
        const a = await api('/api/assets', { method: 'POST', body: { name: name.value.trim(), kind: 'super' } });
        await api(`/api/assets/${a.id}/snapshots`, { method: 'POST', body: { date: todayIso(), value: parseMoney(val.value) } });
      });
      d.clear();
      closeModal();
      toast('Super added');
      buzz(12);
      done();
    } catch (err) { formError(form, err, 'Add it'); }
  });
}

// ====================== home loan ======================

const MISSING_WORDS = { rate: 'the interest rate', repayment: 'the repayment', end_date: 'the loan end date' };

function loanExtraHtml(l) {
  const e = l.extra;
  if (!l.interest || !l.payoff) return '<span class="sub">Needs the rate and repayment</span>';
  if (!e) return '';
  if (!e.amortising) return `<div class="pv warnc">Still not ahead of the interest at ${esc(money0(e.extra_per_month))} more a month.</div>`;
  return `<div class="pv"><b>${esc(monthYearOf(e.payoff_date))}</b>${e.months_sooner > 0 ? `, ${esc(yearsMonths(e.months_sooner))} sooner` : ''}.</div>
    ${e.interest_saved != null ? `<div class="pv pos">Saves <span class="num">${esc(money0(e.interest_saved))}</span> interest.</div>` : ''}`;
}

function homeLoanCard(l, extra, first) {
  const i = l.interest;
  let saving = '';
  if (i) {
    const o = l.offset;
    const noOffset = o.enabled === false || (!o.accounts.length && o.enabled != null);
    const line = o.enabled === false ? 'No offset on this loan' : noOffset ? 'No offset account found' : `${money0(i.saved_by_offset_per_month)} a month, on ${money0(o.balance)} in your offset`;
    const rule = !noOffset && !o.balance && l.rate.value != null ? `<div class="sub num">Every $10,000 in offset saves ${esc(money0(Math.round(1000000 * l.rate.value)))} a year</div>` : '';
    saving = `<div class="big2 num ${i.saved_by_offset_per_year > 0 ? 'pos' : ''}">${esc(money0(i.saved_by_offset_per_year))} <span class="sub">a year</span></div>
      <div class="sub num">${esc(line)}</div>${rule}`;
  }
  const prompts = l.missing.length
    ? `<div class="prompt need"><div><b>Needs ${esc(l.missing.map((k) => MISSING_WORDS[k]).join(' and '))}</b></div>
      <button class="btn ghost sm" type="button" data-loaninputs="${esc(l.id)}">${I.edit}Enter details</button></div>`
    : '';
  const can = l.interest && l.payoff;
  return `<section class="card loan" data-loan="${esc(l.id)}">
      ${prompts}
      ${saving}
      ${first ? `<h3 class="sub-h">Pay extra each month</h3>
      <div class="slider"><input type="range" class="range" id="extra" min="0" max="200000" step="5000" value="${extra}" ${can ? '' : 'disabled'} aria-label="Extra per month on the home loan" aria-describedby="extra-out"><output id="extra-val" class="num" for="extra">${esc(money0(extra))}</output></div>
      <div id="extra-out" class="xout" aria-live="polite">${loanExtraHtml(l)}</div>` : ''}
    </section>`;
}

async function saveLoan(box, token, charts) {
  const p = new URLSearchParams(location.search);
  let extra = Math.max(0, Math.min(200000, Math.round((Number(p.get('extra_month')) || 0) / 5000) * 5000));
  let data = null;
  const url = () => (extra ? `/api/homeloan?extra_month=${extra}` : '/api/homeloan');
  const remember = () => history.replaceState({}, '', extra ? `/save?extra_month=${extra}` : '/save');

  function drawChart(l) {
    const card = $('#sv-loanchart', charts);
    if (!card) return;
    const cur = l.chart.current;
    if (!cur.length) { card.hidden = true; return; }
    card.hidden = false;
    const withEx = l.chart.with_extra;
    const series = [{ name: l.chart.basis === 'current_repayment' ? 'Current repayment' : 'Principal and interest to term', color: VIZ[0], area: !withEx.length, points: cur }];
    if (withEx.length) series.push({ name: `With ${money0(extra)} extra a month`, color: VIZ_ACCENT, points: withEx });
    $('.legend-slot', card).innerHTML = series.length > 1 ? legendHtml(series.map((s, i) => ({ key: String(i), name: s.name, color: s.color }))) : '';
    $('.legend-slot', card).classList.add('static');
    applyDims(card);
    $('.plot', card).innerHTML = '';
    mountLine($('.plot', card), { series, height: 220, fmt: compact, tipFmt: money, label: 'Home loan balance over time', zero: true });
    const ex = new Map(withEx);
    const lastEx = withEx.at(-1)?.[0];
    card._table = () => tableHtml(withEx.length ? ['Date', 'Balance', 'With extra'] : ['Date', 'Balance'], cur.map((pt) => (withEx.length ? [dmy(pt[0]), money0(pt[1]), ex.has(pt[0]) ? money0(ex.get(pt[0])) : (pt[0] > lastEx ? money0(0) : '')] : [dmy(pt[0]), money0(pt[1])])));
  }

  const paint = () => {
    if (token !== renderToken || !data) return;
    box.innerHTML = data.items.length
      ? data.items.map((l, i) => homeLoanCard(l, extra, i === 0)).join('')
      : `<div class="card">${emptyState({ icon: I.house, title: 'No home loan connected', line: accountsData?.sync?.redbark ? 'Connect your loan in Redbark.' : 'Add your loan as an account.', action: accountsData?.sync?.redbark ? { href: '/accounts', label: 'Accounts and sync' } : { href: '/accounts?add=1', label: 'Add an account' } })}</div>`;
    applyDims(box);
    charts.innerHTML = data.items.length ? chartCard({ id: 'sv-loanchart', title: 'Loan balance over time' }) : '';
    if (data.items.length) { drawChart(data.items[0]); wireCharts(charts); wire(); }
  };

  function wire() {
    const range = $('#extra', box);
    if (!range) return;
    const out = $('#extra-out', box);
    const val = $('#extra-val', box);
    if (!online && !range.disabled) { range.disabled = true; val.title = 'Needs a connection: the payoff maths runs on the server'; out.innerHTML = '<span class="sub">Needs a connection: the payoff maths runs on the server.</span>'; }
    let timer = 0;
    range.addEventListener('input', () => {
      extra = Number(range.value);
      val.textContent = money0(extra);
      buzz(2);
      remember();
      clearTimeout(timer);
      out.innerHTML = '<span class="spin dim"></span><span class="sub">Working out the payoff...</span>';
      timer = setTimeout(async () => {
        try {
          const d = await api(url());
          if (token !== renderToken) return;
          data = d;
          out.innerHTML = loanExtraHtml(d.items[0]);
          drawChart(d.items[0]);
          wireCharts(charts);
        } catch (e) { out.innerHTML = `<span class="ferr">${esc(e.detail ?? e.message)}</span> <button class="btn ghost sm" type="button" id="exretry">${I.refresh}Retry</button>`; $('#exretry', out)?.addEventListener('click', () => range.dispatchEvent(new Event('input'))); }
      }, 260);
    });
  }

  const load = () => swr(url(), (d) => { if (document.activeElement?.id === 'extra') return; data = d; paint(); }).catch((e) => {
    if (token !== renderToken) return;
    charts.innerHTML = '';
    box.innerHTML = errorCard(e, 'svr-loan', 'the home loan');
    $('#svr-loan', box)?.addEventListener('click', () => { box.innerHTML = skeletonCard(260); load(); });
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-loaninputs]');
    if (b) openLoanInputs(data.items.find((x) => x.id === b.dataset.loaninputs), load);
  });
  await load();
}

function openLoanInputs(l, reload) {
  if (!l) return;
  const fromBank = (s) => s === 'bank';
  const freq = l.inputs.frequency ?? 'monthly';
  const panel = openModal(`${sheetHead(l.name, 'Loan details')}
    <form class="form" novalidate>
      ${fromBank(l.rate.source) ? `<div class="field"><span class="lab">Interest rate</span><div class="sub">From your bank: ${esc(pct(l.rate.value))}</div></div>`
        : `<div class="field"><label for="lrate">Interest rate a year</label><div class="money-in"><input id="lrate" name="rate" inputmode="decimal" autocomplete="off" placeholder="6.56" value="${l.inputs.rate != null ? esc(String(Math.round(l.inputs.rate * 1e6) / 1e4)) : ''}"><span>%</span></div></div>`}
      ${fromBank(l.repayment.source) ? `<div class="field"><span class="lab">Repayment</span><div class="sub">Seen going in: ${esc(money0(l.repayment.amount))} ${esc(l.repayment.frequency)}</div></div>`
        : `<div class="field"><label for="lrep">Repayment</label><div class="money-in"><span>$</span><input id="lrep" name="repayment" inputmode="decimal" autocomplete="off" value="${l.inputs.repayment != null ? centsToInput(l.inputs.repayment) : ''}"></div></div>
           <div class="field"><span class="lab">How often</span>${segmented('lfreq', [['monthly', 'Monthly'], ['fortnightly', 'Fortnightly'], ['weekly', 'Weekly']], freq)}</div>`}
      ${fromBank(l.end_date.source) ? `<div class="field"><span class="lab">Loan end date</span><div class="sub">From your bank: ${esc(dmy(l.end_date.value))}</div></div>`
        : `<div class="field"><label for="lend">Loan end date</label><input id="lend" name="end_date" type="date" min="${isoOffset(todayIso(), 1)}" value="${esc(l.inputs.end_date ?? '')}"></div>`}
      <button class="btn wide" type="submit">${I.check}Save details</button>
    </form>`);
  const form = $('form', panel);
  const d = bindDraft(form, `loan:${l.id}`);
  const rate = $('#lrate', form);
  const rep = $('#lrep', form);
  const end = $('#lend', form);
  const pick = wireSeg(form, 'lfreq', () => {});
  const check = () => {
    let ok = true;
    if (rate) {
      const r = rate.value.trim() ? Number(rate.value.replace('%', '')) : null;
      ok = fieldError(rate, r != null && (!Number.isFinite(r) || r < 0 || r > 50) ? 'A rate like 6.56' : '') && ok;
    }
    if (rep) {
      const c = rep.value.trim() ? parseMoney(rep.value) : null;
      ok = fieldError(rep, c != null && (Number.isNaN(c) || c <= 0) ? 'An amount like 2500.00' : '') && ok;
    }
    if (end) ok = fieldError(end, end.value && end.value <= todayIso() ? 'Pick a date in the future' : '') && ok;
    return ok;
  };
  form.addEventListener('input', check);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!check()) return;
    const body = {};
    if (rate) body.rate = rate.value.trim() ? Math.round(Number(rate.value.replace('%', '')) * 1e4) / 1e6 : null;
    if (rep) { body.repayment = rep.value.trim() ? parseMoney(rep.value) : null; body.frequency = body.repayment == null ? null : pick() ?? 'monthly'; }
    if (end) body.end_date = end.value || null;
    if (!Object.keys(body).length) { closeModal(); return; }
    formError(form, null);
    try {
      const r = await withBusy($('button[type=submit]', form), 'Saving', () => mutate({ method: 'PUT', path: `/api/homeloan/${encodeURIComponent(l.id)}/inputs`, body }));
      d.clear();
      closeModal();
      if (r.queued) toast('Saved offline, syncs when you are back'); else { toast('Loan details saved'); buzz(12); await reload(); }
    } catch (err) { formError(form, err, 'Save'); }
  });
}
