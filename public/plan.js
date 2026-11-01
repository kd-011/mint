// Plan: what to do with the money. Four sections in the URL (?s=): the pay
// split (where each payday should go, and whether it did), savings goals, debt
// and the offset (home loan payoff with an extra-per-cycle slider, card
// paydown planner) and the bills calendar for the next six weeks by cycle.
// Mint never moves money here; it plans, checks and nudges.
'use strict';

const PLAN_SECTIONS = [['split', 'Split'], ['goals', 'Goals'], ['debt', 'Debt'], ['bills', 'Bills'], ['subs', 'Subs']];
const PLAN_KINDS = [['spending', 'Spending'], ['saving', 'Saving'], ['debt', 'Debt'], ['business', 'Business']];
const kindIcon = (k) => (k === 'saving' ? I.piggy : k === 'debt' ? I.card : k === 'business' ? I.briefcase : I.wallet);

async function viewPlan(el, token) {
  const p = new URLSearchParams(location.search);
  const sec = PLAN_SECTIONS.some(([k]) => k === p.get('s')) ? p.get('s') : 'split';
  el.innerHTML = `<div class="rangebar">${segmented('plansec', PLAN_SECTIONS, sec).replace('role="radiogroup"', 'role="radiogroup" aria-label="Plan section"')}</div><div id="planbody"></div>`;
  wireSeg(el, 'plansec', (v) => { history.replaceState({}, '', v === 'split' ? '/plan' : `/plan?s=${v}`); render({ keepScroll: false }); });
  const box = $('#planbody', el);
  const sections = { split: planSplit, goals: planGoals, debt: planDebt, bills: planBills, subs: (box, t) => subsSection(box, t) };
  await sections[sec](box, token);
}

// A load-failure card in place of the section, with retry.
function sectionError(box, token, e, what, again) {
  if (token !== renderToken) return;
  box.innerHTML = errorCard(e, 'secretry', what);
  $('#secretry', box)?.addEventListener('click', again);
}

// ====================== split ======================

const SPLIT_STATE = { done: ['ok', 'Done'], partial: ['warn', 'Partial'], not_yet: ['', 'Not yet'], no_plan: ['', 'No plan'] };

async function planSplit(box, token) {
  let plan = null;
  let st = null;
  const payAmount = () => plan?.payday?.amount ?? st?.payday?.amount ?? 0;

  const paint = () => {
    if (token !== renderToken || !plan) return;
    const lines = plan.lines;
    if (!lines.length) {
      box.innerHTML = `<div class="card">${emptyState({ icon: I.sliders, title: 'No pay split yet', line: 'Set where each payday goes.', button: { id: 'editsplit', label: 'Set up a split', icon: I.plus } })}</div>`;
      return;
    }
    const status = new Map((st?.lines ?? []).map((l) => [l.account_id, l]));
    const [oc, ol] = SPLIT_STATE[st?.status ?? 'no_plan'];
    box.innerHTML = `<section class="card month">
        <div class="mtop"><div><div class="k">Each payday, from ${esc(acctText(plan.pay_account?.name ?? 'your pay account'))}</div><div class="big2 num">${esc(money0(plan.totals.planned))}</div></div>
          <div class="mr"><div class="k">of ${esc(money0(payAmount()))}</div><div class="v num ${plan.totals.left_in_pay_account < 0 ? 'neg-red' : ''}">${esc(money0(Math.abs(plan.totals.left_in_pay_account ?? 0)))} ${plan.totals.left_in_pay_account < 0 ? 'over' : 'stays'}</div></div></div>
        ${plan.suggested ? `<div class="nudge soft slim">${I.leaf}<div><small>Suggested from your last paydays</small></div></div>` : ''}
        <button class="btn wide" type="button" id="editsplit">${I.edit}${plan.suggested ? 'Review and save' : 'Edit split'}</button>
      </section>
      <div class="sec-head"><h2>This payday</h2>${st ? `<span class="chip ${oc}">${ol}</span>` : ''}</div>
      <div class="rows stagger">${lines.map((l) => {
        const s = status.get(l.account_id);
        const [c, t] = SPLIT_STATE[s?.status ?? 'not_yet'];
        const pct = s && s.planned > 0 ? Math.min(100, Math.round((s.moved / s.planned) * 100)) : 0;
        return `<div class="row bud"><div class="ic">${kindIcon(l.kind)}</div><div class="main"><div class="t1">${esc(acctText(l.account))}${l.kind !== 'spending' ? ` <span class="chip">${esc(titleCase(l.kind))}</span>` : ''}</div>
          ${s ? `<div class="meter ${s.status === 'done' ? '' : s.status === 'partial' ? 'warm' : 'hot'}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(acctText(l.account))} moved"><i data-w="${pct}"></i></div>` : ''}
          <div class="t2 num">${s ? `${esc(money0(s.moved))} moved of ` : ''}${esc(money0(l.planned))}${l.percent != null ? ` (${l.percent}%)` : ''}${s && s.short > 0 ? `, ${esc(money0(s.short))} short` : ''}</div></div>
          ${s ? `<span class="chip ${c}">${t}</span>` : ''}</div>`;
      }).join('')}</div>
      ${st?.other_moves?.length ? `<p class="sub pad num">Also moved: ${st.other_moves.map((m) => `${esc(acctText(m.account))} ${esc(money0(m.amount))}`).join(', ')}</p>` : ''}
      ${st?.history?.length > 1 ? `<h2>Recent paydays</h2><div class="rows">${st.history.slice(0, -1).reverse().map((h) => { const [c, t] = SPLIT_STATE[h.status]; return `<div class="row"><div class="main"><div class="t1">${esc(shortDay(h.start))}</div><div class="t2 num">${esc(money0(h.payday.amount))} paid</div></div><span class="chip ${c}">${t}</span></div>`; }).join('')}</div>` : ''}`;
    applyDims(box);
  };

  const load = () => Promise.all([
    swr('/api/plan', (d) => { plan = d; paint(); }),
    swr('/api/plan/status', (d) => { st = d; paint(); }),
  ]).catch((e) => sectionError(box, token, e, 'the pay split', () => { box.innerHTML = skeleton; applyDims(box); load(); }));
  const skeleton = `${skeletonCard(150)}<h2>This payday</h2>${skeletonRows(3)}`;
  if (!store.get('c:/api/plan')) { box.innerHTML = skeleton; applyDims(box); }
  load();

  box.addEventListener('click', (e) => { if (e.target.closest('#editsplit')) openSplitEditor(); });

  function openSplitEditor() {
    const pay = payAmount();
    const accts = (accountsData?.accounts ?? []).filter((a) => !a.hidden && a.id !== plan.pay_account?.id);
    // State: one entry per destination; value is dollars typed, or a percent.
    let L = plan.lines.map((l) => ({ account_id: l.account_id, kind: l.kind, mode: l.percent != null ? 'percent' : 'amount', value: l.percent != null ? String(l.percent) : centsToInput(l.amount), seen: null }));
    const panel = openModal(`${sheetHead('Pay split', 'Where each payday goes')}
      <p class="sub">Pay account: <b>${esc(acctText(plan.pay_account?.name ?? 'not found yet'))}</b>. Based on a payday of <span class="num">${esc(money0(pay))}</span>.</p>
      <div class="totals" id="stotals" aria-live="polite"></div>
      <div id="slines" class="slines"></div>
      <button class="btn ghost wide" type="button" id="sadd">${I.plus}Add a destination</button>
      <button class="btn ghost wide" type="button" id="ssugg">${I.leaf}Use my usual split from history</button>
      <div class="sticky-actions"><button class="btn" type="submit" id="ssave">${I.check}Save split</button><button class="btn ghost" type="button" data-close>Cancel</button></div>`);
    const linesEl = $('#slines', panel);
    const totEl = $('#stotals', panel);
    const saveBtn = $('#ssave', panel);

    const toLine = (l) => {
      const n = parseMoney(l.value);
      return l.mode === 'percent' ? { percent: Number.isFinite(Number(l.value)) && l.value.trim() ? Number(l.value) : NaN } : { amount: n };
    };
    const lineErr = (l, i) => {
      const v = toLine(l);
      if (!l.account_id) return 'Pick an account';
      if (L.some((o, j) => j !== i && o.account_id === l.account_id)) return 'Already in the split';
      if ('percent' in v) return Number.isNaN(v.percent) || v.percent < 0 || v.percent > 100 ? 'A percent from 0 to 100' : '';
      return Number.isNaN(v.amount) || v.amount < 0 ? 'An amount like 500 or 500.50' : '';
    };
    const drawTotals = () => {
      const errs = L.map(lineErr);
      const t = splitTotals(L.map((l, i) => (errs[i] ? { amount: 0 } : toLine(l))), pay);
      const bad = errs.some(Boolean);
      totEl.innerHTML = `<div class="trow2"><span>Planned</span><b class="num">${esc(money(t.planned))}</b></div>
        <div class="trow2"><span>${t.over ? 'Over the payday by' : `Stays in ${esc(acctText(plan.pay_account?.name ?? 'the pay account'))}`}</span><b class="num ${t.over ? 'neg-red' : ''}">${esc(money(Math.abs(t.left)))}</b></div>
        ${t.over ? `<div class="ferr">The split sends out more than a payday brings in. Lower an amount to save it.</div>` : ''}
        ${bad ? `<div class="ferr">Can't save yet: line ${errs.findIndex(Boolean) + 1} says "${esc(errs.find(Boolean))}".</div>` : ''}`;
      saveBtn.disabled = t.over || bad;
      saveBtn.title = t.over ? 'The split is over the payday' : bad ? errs.find(Boolean) : '';
    };
    const drawLines = () => {
      linesEl.innerHTML = L.length ? L.map((l, i) => `<div class="sline" data-i="${i}">
          <div class="field"><label for="sa${i}">Into</label><select id="sa${i}" data-f="account_id"><option value="">Choose an account</option>${accts.map((a) => `<option value="${esc(a.id)}" ${a.id === l.account_id ? 'selected' : ''}>${esc(accountName(a))}</option>`).join('')}</select></div>
          <div class="two"><div class="field"><label for="sk${i}">As</label><select id="sk${i}" data-f="kind">${PLAN_KINDS.map(([k, t]) => `<option value="${k}" ${k === l.kind ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
            <div class="field"><label for="sv${i}">${l.mode === 'percent' ? 'Percent of payday' : 'Amount'}</label><div class="money-in">${l.mode === 'percent' ? '' : '<span>$</span>'}<input id="sv${i}" data-f="value" inputmode="decimal" autocomplete="off" value="${esc(l.value)}">${l.mode === 'percent' ? '<span>%</span>' : ''}</div></div></div>
          <div class="sline-foot">${segmented(`sm${i}`, [['amount', '$'], ['percent', '%']], l.mode)}<span class="sub">${l.seen ? `Seen ${plural(l.seen, 'payday')} out of 4` : ''}</span><button class="x sm" type="button" data-rm aria-label="Remove this destination" title="Remove">${I.trash}</button></div>
          <div class="ferr-slot"></div></div>`).join('') : `<div class="empty small">${I.sliders}<p>No destinations. Saving like this clears the split.</p></div>`;
      L.forEach((_, i) => wireSeg(linesEl, `sm${i}`, (m) => {
        // Switching mode converts the typed value so the planned dollars stay put.
        const v = toLine(L[i]);
        if (m === 'percent' && 'amount' in v && Number.isFinite(v.amount)) L[i].value = String(toPercent(v.amount, pay));
        else if (m === 'amount' && 'percent' in v && Number.isFinite(v.percent)) L[i].value = centsToInput(fromPercent(v.percent, pay));
        L[i].mode = m;
        drawLines();
      }));
      showErrs();
      drawTotals();
    };
    const showErrs = () => $$('.sline', linesEl).forEach((row, i) => {
      const msg = row.dataset.touched ? lineErr(L[i], i) : '';
      const slot = $('.ferr-slot', row);
      slot.innerHTML = msg ? `<div class="ferr" role="alert">${esc(msg)}</div>` : '';
    });
    drawLines();
    linesEl.addEventListener('input', (e) => {
      const row = e.target.closest('.sline');
      if (!row) return;
      const l = L[Number(row.dataset.i)];
      l[e.target.dataset.f] = e.target.value;
      if (e.target.dataset.f === 'account_id' && !l.touchedKind) { const a = acctById(e.target.value); if (a) { l.kind = a.type === 'credit-card' || a.type === 'loan' ? 'debt' : a.is_business ? 'business' : /emergency|saving|offset|invest/i.test(`${a.name} ${a.nickname ?? ''}`) ? 'saving' : 'spending'; $('[data-f="kind"]', row).value = l.kind; } }
      if (e.target.dataset.f === 'kind') l.touchedKind = true;
      row.dataset.touched = '1';
      showErrs();
      drawTotals();
    });
    linesEl.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm]');
      if (!rm) return;
      L.splice(Number(rm.closest('.sline').dataset.i), 1);
      buzz(8);
      drawLines();
    });
    $('#sadd', panel).addEventListener('click', () => { L.push({ account_id: '', kind: 'saving', mode: 'amount', value: '' }); drawLines(); $$('select', linesEl).at(-2)?.focus(); });
    $('#ssugg', panel).addEventListener('click', async (e) => {
      try {
        const s = await withBusy(e.currentTarget, 'Looking at your last paydays', () => api('/api/plan/suggest'));
        if (!s.lines.length) { toast('Not enough history to suggest a split yet', { error: true }); return; }
        L = s.lines.map((l) => ({ account_id: l.account_id, kind: l.kind, mode: 'amount', value: centsToInput(l.amount), seen: l.seen }));
        drawLines();
        toast('Filled in from your last paydays');
      } catch (err) { toast(`Couldn't get a suggestion: ${err.detail ?? err.message}`, { error: true }); }
    });
    saveBtn.addEventListener('click', async () => {
      $$('.sline', linesEl).forEach((r) => { r.dataset.touched = '1'; });
      showErrs();
      if (L.some(lineErr)) return;
      const body = { lines: L.map((l) => ({ account_id: l.account_id, kind: l.kind, ...toLine(l) })) };
      try {
        const r = await withBusy(saveBtn, 'Saving the split', () => mutate({ method: 'PUT', path: '/api/plan', body }));
        closeModal();
        if (r.queued) {
          // Show the plan as saved straight away; the real numbers arrive when it syncs.
          plan = { ...plan, suggested: false, lines: body.lines.map((l, i) => ({ id: -i, account_id: l.account_id, account: accountName(acctById(l.account_id) ?? { name: l.account_id }), kind: l.kind, amount: l.amount ?? null, percent: l.percent ?? null, planned: l.amount ?? fromPercent(l.percent, pay) })) };
          const planned = plan.lines.reduce((s, l) => s + l.planned, 0);
          plan.totals = { planned, saving: 0, left_in_pay_account: pay - planned };
          paint();
          toast('Saved offline, syncs when you are back');
        } else { plan = r.data; store.set('c:/api/plan', { d: plan, at: Date.now() }); paint(); toast('Pay split saved'); buzz(12); swr('/api/plan/status', (d) => { st = d; paint(); }).catch(() => {}); }
      } catch (err) { formError(panel, err, 'Save'); }
    });
  }
}

// ====================== goals ======================

function planGoals(box, token) {
  return mountGoals(box, token, { title: '' });
}

// The goal sheets are shared with Save and Invest (save.js). ctx is { goals, paint, load }:
// the list on screen, a redraw of it, and a reload from the server.
function openGoalEditor(g, ctx) {
  const accts = (accountsData?.accounts ?? []).filter((a) => !a.hidden && a.type !== 'loan' && a.type !== 'credit-card');
  const panel = openModal(`${sheetHead(g ? 'Edit goal' : 'New goal', g?.name ?? 'Something to save for')}
    <form class="form" novalidate>
      <div class="field"><label for="gname">Name</label><input id="gname" name="name" maxlength="60" autocomplete="off" value="${esc(g?.name ?? '')}" ${g ? '' : 'autofocus'}></div>
      <div class="field"><label for="gamt">Target (optional)</label><div class="money-in"><span>$</span><input id="gamt" name="target" inputmode="decimal" autocomplete="off" value="${centsToInput(g?.target_amount)}"></div></div>
      <div class="gcalc" id="gcalc" hidden>
        ${segmented('freq', GoalCalc.FREQ_KEYS.map((k) => [k, GoalCalc.FREQS[k].label]), 'fortnightly')}
        <input type="hidden" name="freq" value="fortnightly"><input type="hidden" name="driver" value="${g?.target_date ? 'date' : ''}">
        <div class="field gctl" id="gdatef" data-state="idle"><div class="gctl-h"><label for="gdate">By</label><span class="gtag" hidden>calculated</span></div>
          <input id="gdate" name="date" type="date" value="${esc(g?.target_date ?? '')}">
          <input type="range" class="gslide" id="gdates" aria-label="Finish date"><div class="gcap" id="gdatecap"></div></div>
        <div class="field gctl" id="gperf" data-state="idle"><div class="gctl-h"><label for="gper" id="gperl">Each fortnight</label><span class="gtag" hidden>calculated</span></div>
          <div class="money-in"><span>$</span><input id="gper" name="per" inputmode="decimal" autocomplete="off"></div>
          <input type="range" class="gslide" id="gpers" aria-label="Amount each fortnight"></div>
        <p class="gres" id="gres" aria-live="polite"></p>
      </div>
      <div class="field"><label for="gacct">Track which account?</label><select id="gacct" name="account"><option value="">None, I will add money by hand</option>${accts.map((a) => `<option value="${esc(a.id)}" ${a.id === g?.account_id ? 'selected' : ''}>${esc(accountName(a))}</option>`).join('')}</select></div>
      <button class="btn wide" type="submit">${I.check}${g ? 'Save goal' : 'Add goal'}</button>
      ${g && !g.account_id ? `<button class="btn ghost wide" type="button" id="gcontrib">${I.plus}Add money to this goal</button>` : ''}
      ${g ? `<button class="btn danger wide" type="button" id="gdel">${I.trash}Delete goal</button>` : ''}
    </form>`);
  const form = $('form', panel);
  bindDraft(form, `goal:${g?.id ?? 'new'}`);
  const name = $('#gname', form);
  const amt = $('#gamt', form);
  const date = $('#gdate', form);
  const per = $('#gper', form);
  const dSlide = $('#gdates', form);
  const aSlide = $('#gpers', form);
  const GC = GoalCalc;
  const today = todayIso();
  const saved = g?.progress ?? 0;
  const driverEl = $('[name=driver]', form);
  const freqEl = $('[name=freq]', form);
  let cur = { status: 'none' };
  let ladder = [];
  let lastMonth = '';
  let lastRung = -1;
  const saveDraft = () => form.dispatchEvent(new Event('change'));
  const setDriver = (v) => { driverEl.value = v; };
  const moneyShort = (c) => (c % 100 === 0 ? money0(c) : money(c));
  const markSlider = (el, pos) => { el.style.setProperty('--p', String(pos)); };
  const setState = (id, state, tagged) => { const box = $(id, form); box.dataset.state = state; $('.gtag', box).hidden = !tagged; };
  // The calculator: whichever of date and amount was touched last drives, the other is worked out.
  const render = (typing) => {
    const t = amt.value.trim() ? parseMoney(amt.value) : null;
    const target = t > 0 ? t : null;
    const freq = GC.FREQS[freqEl.value] ? freqEl.value : 'fortnightly';
    const pc = per.value.trim() ? parseMoney(per.value) : null;
    const r = GC.solve({ freq, today, target, saved, driver: driverEl.value, date: date.value, amount: pc > 0 ? pc : null });
    cur = r;
    const calc = $('#gcalc', form);
    calc.hidden = r.status === 'none';
    calc.classList.toggle('met', r.status === 'met');
    $$('.seg button', calc).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === freq)));
    const unit = GC.FREQS[freq].per.slice(2);
    $('#gperl', form).textContent = `Each ${unit}`;
    aSlide.setAttribute('aria-label', `Amount each ${unit}`);
    if (r.status === 'ok' && driverEl.value === 'date' && typing !== per) per.value = centsToInput(r.amount);
    if (r.status !== 'ok' && driverEl.value === 'date' && typing !== per) per.value = '';
    if (driverEl.value === 'amount' && typing !== date) { const d = GC.dateFromAmount(r); if (d != null) date.value = d; }
    const d = GC.dateSlider(today);
    dSlide.min = d.min; dSlide.max = d.max;
    const dayOk = date.value && date.value > today;
    const day = dayOk ? GC.dayOfDate(today, date.value, d) : d.min;
    if (typing !== dSlide) dSlide.value = day;
    markSlider(dSlide, dayOk ? (day - d.min) / (d.max - d.min) : 0);
    dSlide.setAttribute('aria-valuetext', dayOk ? `${UxModel.dateWords(date.value)}, ${GC.untilWords(today, date.value)}` : 'No date yet');
    $('#gdatecap', form).textContent = dayOk ? GC.untilWords(today, date.value) : '';
    ladder = GC.amountLadder(freq, today, r.remaining ?? 0);
    aSlide.min = 0; aSlide.max = Math.max(0, ladder.length - 1);
    const amtNow = r.status === 'ok' || r.status === 'beyond' ? r.amount : null;
    const rung = amtNow ? GC.rungOf(ladder, amtNow) : 0;
    if (typing !== aSlide) aSlide.value = rung;
    markSlider(aSlide, amtNow && ladder.length > 1 ? rung / (ladder.length - 1) : 0);
    aSlide.setAttribute('aria-valuetext', amtNow ? `${moneyShort(amtNow)} ${GC.FREQS[freq].per}` : 'No amount yet');
    const ok = r.status === 'ok';
    setState('#gdatef', driverEl.value === 'date' ? 'driver' : ok && driverEl.value === 'amount' ? 'calc' : 'idle', ok && driverEl.value === 'amount');
    setState('#gperf', driverEl.value === 'amount' ? 'driver' : ok && driverEl.value === 'date' ? 'calc' : 'idle', ok && driverEl.value === 'date');
    const res = $('#gres', form);
    res.dataset.tone = r.status === 'beyond' ? 'warn' : '';
    res.replaceChildren(...GC.resultWords(r, moneyShort).map((s) => { const n = document.createElement(s.b ? 'b' : 'span'); n.textContent = s.t; return n; }));
  };
  const check = () => {
    let ok = true;
    ok = fieldError(name, name.value.trim() ? '' : 'Give it a name') && ok;
    const c = amt.value.trim() ? parseMoney(amt.value) : null;
    ok = fieldError(amt, Number.isNaN(c) ? 'An amount like 5000 or 5000.50' : c != null && c <= 0 ? 'Must be more than zero' : '') && ok;
    ok = fieldError(date, date.value && date.value <= today ? 'Pick a date in the future' : '') && ok;
    const p = per.value.trim() ? parseMoney(per.value) : null;
    ok = fieldError(per, Number.isNaN(p) ? 'An amount like 150 or 150.50' : p != null && p <= 0 ? 'Must be more than zero' : '') && ok;
    if (cur.status === 'beyond') { per.setAttribute('aria-invalid', 'true'); per.setAttribute('aria-describedby', 'gres'); per.closest('.field').classList.add('bad'); ok = false; }
    return ok;
  };
  const touch = (typing, driver) => { if (driver) setDriver(driver); render(typing); check(); saveDraft(); };
  form.addEventListener('input', (e) => {
    if (e.target === amt) touch(amt);
    else if (e.target === date) touch(date, 'date');
    else if (e.target === per) touch(per, 'amount');
    else if (e.target === dSlide) {
      date.value = GC.dateAtDay(today, Number(dSlide.value));
      const month = date.value.slice(0, 7);
      if (month !== lastMonth) { if (lastMonth) buzz(4); lastMonth = month; }
      touch(dSlide, 'date');
    } else if (e.target === aSlide) {
      const rung = Number(aSlide.value);
      per.value = centsToInput(ladder[rung] ?? 0);
      if (Math.floor(rung / 10) !== lastRung) { if (lastRung >= 0) buzz(4); lastRung = Math.floor(rung / 10); }
      touch(aSlide, 'amount');
    } else check();
  });
  $('.seg', form)?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || b.dataset.v === freqEl.value) return;
    // The same plan in another unit.
    const pc = per.value.trim() ? parseMoney(per.value) : null;
    const sw = GC.switchFreq({ freq: freqEl.value, to: b.dataset.v, today, target: amt.value.trim() ? parseMoney(amt.value) : null, saved, driver: driverEl.value, date: date.value, amount: pc > 0 ? pc : null });
    setDriver(sw.driver);
    if (sw.driver === 'amount' && sw.amount > 0) per.value = centsToInput(sw.amount);
    freqEl.value = b.dataset.v;
    buzz(6);
    touch(null);
  });
  render();
  if (g) check();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!check()) return;
    const body = { name: name.value.trim(), target_amount: amt.value.trim() ? parseMoney(amt.value) : null, target_date: date.value || null, account_id: $('#gacct', form).value || null };
    formError(form, null);
    const btn = $('button[type=submit]', form);
    try {
      const r = await withBusy(btn, 'Saving', () => mutate(g ? { method: 'PATCH', path: `/api/goals/${g.id}`, body } : { method: 'POST', path: '/api/goals', body }));
      drafts.clear(`goal:${g?.id ?? 'new'}`);
      closeModal();
      if (r.queued) {
        if (g) Object.assign(ctx.goals.find((x) => x.id === g.id), body);
        else ctx.goals = [...ctx.goals, { id: -Date.now(), ...body, account: null, progress: 0, pct: body.target_amount ? 0 : null, done: false, on_track: null }];
        ctx.paint();
        toast('Saved offline, syncs when you are back');
      } else { toast(g ? 'Goal saved' : 'Goal added'); buzz(12); await ctx.load(); }
    } catch (err) { formError(form, err, 'Save'); }
  });
  $('#gdel', form)?.addEventListener('click', () => deleteGoal(g, ctx));
  $('#gcontrib', form)?.addEventListener('click', () => { closeModal(); openContribution(g, ctx); });
}

function openContribution(g, ctx) {
  const panel = openModal(`${sheetHead(g.name, 'Add money')}
    <form class="form" novalidate>
      <div class="field"><label for="camt">Amount</label><div class="money-in"><span>$</span><input id="camt" name="amount" inputmode="decimal" autocomplete="off" autofocus></div><div class="sub">Use a minus sign to take money out.</div></div>
      <div class="field"><label for="cdate">Date</label><input id="cdate" name="date" type="date" value="${todayIso()}" max="${todayIso()}"></div>
      <button class="btn wide" type="submit">${I.check}Add to ${esc(g.name)}</button>
    </form>`);
  const form = $('form', panel);
  const amt = $('#camt', form);
  const check = () => { const c = parseMoney(amt.value); return fieldError(amt, !amt.value.trim() ? 'Enter an amount' : Number.isNaN(c) || c === 0 ? 'An amount like 250 or 250.50' : ''); };
  amt.addEventListener('input', check);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!check()) return;
    const body = { amount: parseMoney(amt.value), date: $('#cdate', form).value || todayIso() };
    try {
      const r = await withBusy($('button[type=submit]', form), 'Adding', () => mutate({ method: 'POST', path: `/api/goals/${g.id}/contributions`, body }));
      closeModal();
      if (r.queued) { const row = ctx.goals.find((x) => x.id === g.id); row.progress += body.amount; if (row.target_amount) row.pct = Math.max(0, Math.min(100, Math.round((row.progress / row.target_amount) * 100))); ctx.paint(); toast('Saved offline, syncs when you are back'); } else { toast('Added'); buzz(12); await ctx.load(); }
    } catch (err) { formError(form, err, 'Add'); }
  });
}

// ====================== debt ======================

const monthsWords = (m) => { const y = Math.floor(m / 12); const r = m % 12; return [y ? plural(y, 'year') : '', r ? plural(r, 'month') : ''].filter(Boolean).join(' ') || 'now'; };
const monthYear = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

function loanCard(l) {
  const pay = l.payoff;
  const ex = l.extra;
  const offsetWord = l.offset?.enabled ? (l.offset.balance > 0 ? `${money0(l.offset.balance)} in offset` : 'Offset is empty') : 'No offset';
  return `<section class="card loan" data-loan="${esc(l.id)}">
      ${cardHead(I.house, `${l.name}${l.institution ? `, ${l.institution}` : ''}`, `Rate <b class="num">${l.rate_known ? esc(pct(l.rate)) : '<span class="warnc">unknown</span>'}</b>`)}
      <div class="big2 num">${esc(money0(Math.abs(l.balance)))}</div>
      ${l.rate_known ? '' : '<p class="sub warnc">No rate, so interest is left out</p>'}
      <div class="kvs">
        <div><span>${l.repayment.source === 'repayments' ? 'What you pay' : 'Repayment'}</span><b class="num">${l.repayment.amount == null ? '<span class="warnc">None seen yet</span>' : `${esc(money(l.repayment.amount))} ${esc(l.repayment.frequency ?? '')}`}${l.repayment.type === 'INTEREST_ONLY' ? ' <i class="chip">Interest only</i>' : ''}</b></div>
        ${loanPaidRows(l, money).map((r) => `<div><span>${esc(r.label)}</span><b class="num ${r.tone}">${esc(r.value)}</b></div>`).join('')}
        <div><span>Offset</span><b class="num">${esc(offsetWord)}</b></div>
        ${l.rate_known ? `<div><span>Interest a year</span><b class="num">${esc(money0(l.interest.per_year.with_offset))}</b></div>
        <div><span>Without the offset</span><b class="num">${esc(money0(l.interest.per_year.without_offset))}</b></div>
        <div><span>Offset saves</span><b class="num ${l.interest.per_year.saved_by_offset > 0 ? 'pos' : ''}">${esc(money0(l.interest.per_year.saved_by_offset))} a year</b></div>` : ''}
      </div>
      <h3 class="sub-h">Payoff</h3>
      ${pay.amortising && pay.date ? `<p class="payoff"><b>${esc(monthYear(pay.date))}</b>, ${esc(monthsWords(pay.months))} away, ${esc(money0(pay.interest))} interest${pay.beyond_term ? `, past the ${esc(monthYear(l.loan_end_date))} end date` : ''}</p>`
        : `<p class="payoff warnc">${esc(moneyText(asSentence(pay.reason ?? 'The repayment does not get ahead of the interest, so the balance is not coming down.')))}</p>`}
      ${pay.principal_and_interest ? `<p class="sub num">Clear by ${esc(monthYear(l.loan_end_date))}: ${esc(money0(pay.principal_and_interest.repayment_per_month))} a month</p>` : ''}
      <h3 class="sub-h">Pay extra each pay cycle</h3>
      <div class="slider"><input type="range" class="range" id="extra" min="0" max="100000" step="2500" value="${ex ? ex.per_cycle : 0}" aria-label="Extra per pay cycle on the home loan" aria-describedby="extra-out"><output id="extra-val" class="num" for="extra">${esc(money0(ex ? ex.per_cycle : 0))}</output></div>
      <div id="extra-out" class="xout" aria-live="polite">${extraOut(l)}</div>
    </section>`;
}
function extraOut(l) {
  const ex = l.extra;
  if (!ex) return '';
  return `<div class="pv"><b>${esc(monthYear(ex.payoff_date))}</b>${ex.months_sooner > 0 ? `, ${esc(monthsWords(ex.months_sooner))} sooner` : ''}</div>
    <div class="pv pos">Saves <span class="num">${esc(money0(ex.interest_saved))}</span> interest</div>`;
}

function cardCard(c, plan) {
  const used = c.limit > 0 ? Math.min(100, Math.round((Math.abs(c.balance) / c.limit) * 100)) : 0;
  const bal = Math.abs(c.balance);
  return `<section class="card ccard" data-card="${esc(c.id)}">
      ${cardHead(I.card, c.name, `Rate <b class="num">${c.rate_known ? esc(pct(c.rate)) : '<span class="warnc">unknown</span>'}</b>`)}
      <div class="big2 num">${esc(money0(bal))}</div>
      ${c.limit ? `<div class="meter ${used >= 90 ? 'over' : used >= 75 ? 'warm' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}" aria-label="Card limit used"><i data-w="${used}"></i></div><div class="mline"><span class="num">${esc(money0(c.available))} available</span><span class="num">${esc(money0(c.limit))} limit</span></div>` : ''}
      ${c.rate_known ? '' : '<p class="sub warnc">No rate, so interest is left out</p>'}
      ${c.introductory?.some((x) => x.rate === 0) ? `<p class="sub">0% offer listed: ${esc(c.introductory.map((x) => x.info.replace(/\.$/, '')).join('; '))}</p>` : ''}
      <div class="cplan" data-out>${cardOut(c, plan)}</div>
    </section>`;
}
function cardOut(c, plan) {
  if (plan.mode === 'date' && plan.date) {
    const r = c.clear_by;
    return r ? `<div class="pv">To clear it by <b>${esc(dmy(plan.date))}</b>: <b class="num">${esc(money0(r.per_cycle))}</b> a pay cycle for ${plural(r.cycles, 'cycle')}.</div>${c.rate_known ? '' : '<div class="sub warnc">Interest left out: rate unknown.</div>'}` : '<span class="sub">Pick a later date</span>';
  }
  if (plan.mode === 'cycle' && plan.cycle > 0) {
    const r = c.at_amount;
    if (!r) return '<span class="sub">Enter an amount per cycle</span>';
    return r.clears ? `<div class="pv">At <b class="num">${esc(money0(r.per_cycle))}</b> a cycle it clears on <b>${esc(dmy(r.date))}</b>, ${plural(r.cycles, 'cycle')}${c.rate_known ? `, paying ${esc(money0(r.interest))} interest` : ''}.</div>${c.rate_known ? '' : '<div class="sub warnc">Interest left out: rate unknown.</div>'}` : '<div class="pv warnc">That amount does not get ahead of the interest. It never clears.</div>';
  }
  return '';
}

async function planDebt(box, token) {
  let debt = null;
  const p = new URLSearchParams(location.search);
  let extra = Math.max(0, Math.min(100000, Number(p.get('extra')) || 0));
  const cp = { mode: p.get('card_by') ? 'date' : p.get('card_per_cycle') ? 'cycle' : 'date', date: p.get('card_by') || '', cycle: Number(p.get('card_per_cycle')) || 0 };
  const qs = () => {
    const q = new URLSearchParams();
    if (extra) q.set('extra', extra);
    if (cp.mode === 'date' && cp.date) q.set('card_by', cp.date);
    if (cp.mode === 'cycle' && cp.cycle) q.set('card_per_cycle', cp.cycle);
    return q;
  };
  const url = () => { const q = qs(); return q.toString() ? `/api/debt?${q}` : '/api/debt'; };
  const remember = () => { const q = qs(); q.set('s', 'debt'); history.replaceState({}, '', `/plan?${q}`); };

  const paint = () => {
    if (token !== renderToken || !debt) return;
    const sliding = document.activeElement?.id === 'extra';
    if (sliding) return;
    box.innerHTML = `${debt.loans.length ? debt.loans.map(loanCard).join('') : ''}
      ${debt.cards.length ? `<h2>Credit cards</h2>
        <section class="card cp-ctl"><div class="field"><span class="lab">Plan a paydown</span>${segmented('cpmode', [['date', 'Clear by a date'], ['cycle', 'Pay per cycle']], cp.mode)}</div>
          ${cp.mode === 'date' ? `<div class="field"><label for="cpdate">Clear it by</label><input id="cpdate" type="date" min="${isoOffset(todayIso(), 1)}" value="${esc(cp.date)}"></div>`
            : `<div class="field"><label for="cpamt">Pay each pay cycle</label><div class="money-in"><span>$</span><input id="cpamt" inputmode="decimal" autocomplete="off" value="${cp.cycle ? centsToInput(cp.cycle) : ''}"></div></div>`}</section>
        ${debt.cards.map((c) => cardCard(c, cp)).join('')}` : ''}
      ${!debt.loans.length && !debt.cards.length ? `<div class="card">${emptyState({ icon: I.house, title: 'No loans or cards', line: 'Connect a loan or card in Redbark.', action: { href: '/accounts', label: 'Accounts and sync' } })}</div>` : ''}
`;
    applyDims(box);
    wire();
  };

  function wire() {
    const range = $('#extra', box);
    if (range) {
      const out = $('#extra-out', box);
      const val = $('#extra-val', box);
      range.disabled = !online;
      if (!online) val.title = 'Needs a connection: the payoff maths runs on the server';
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
            debt = d;
            out.innerHTML = extraOut(d.loans[0]);
          } catch (e) { out.innerHTML = `<span class="ferr">${esc(e.detail ?? e.message)}</span> <button class="btn ghost sm" type="button" id="exretry">${I.refresh}Retry</button>`; $('#exretry', out)?.addEventListener('click', () => range.dispatchEvent(new Event('input'))); }
        }, 260);
      });
      range.addEventListener('change', () => paint());
    }
    wireSeg(box, 'cpmode', (m) => { cp.mode = m; remember(); paint(); });
    const refreshCards = async () => {
      remember();
      $$('[data-out]', box).forEach((n) => { n.innerHTML = '<span class="spin dim"></span><span class="sub">Working out the paydown...</span>'; });
      try {
        const d = await api(url());
        if (token !== renderToken) return;
        debt = d;
        $$('[data-card]', box).forEach((n) => { const c = d.cards.find((x) => x.id === n.dataset.card); if (c) $('[data-out]', n).innerHTML = cardOut(c, cp); });
      } catch (e) { $$('[data-out]', box).forEach((n) => { n.innerHTML = `<span class="ferr">${esc(e.detail ?? e.message)}</span>`; }); }
    };
    let ct = 0;
    $('#cpdate', box)?.addEventListener('input', (e) => { cp.date = e.target.value > todayIso() ? e.target.value : ''; clearTimeout(ct); ct = setTimeout(refreshCards, 300); });
    $('#cpamt', box)?.addEventListener('input', (e) => {
      const c = e.target.value.trim() ? parseMoney(e.target.value) : 0;
      fieldError(e.target, Number.isNaN(c) || c < 0 ? 'An amount like 400 or 400.50' : '');
      cp.cycle = Number.isNaN(c) || c < 0 ? 0 : c;
      clearTimeout(ct); ct = setTimeout(refreshCards, 300);
    });
  }

  const load = () => swr(url(), (d) => { debt = d; paint(); }).catch((e) => sectionError(box, token, e, 'debt', () => { box.innerHTML = skeleton; applyDims(box); load(); }));
  const skeleton = `${skeletonCard(360)}<h2>Credit cards</h2>${skeletonCard(180)}`;
  if (!store.get(`c:${url()}`)) { box.innerHTML = skeleton; applyDims(box); }
  load();
}

// ====================== bills ======================

async function planBills(box, token) {
  let bills = null;
  const paint = () => {
    if (token !== renderToken || !bills) return;
    if (!bills.items.length) {
      box.innerHTML = `<div class="card">${emptyState({ icon: I.calendar, title: 'No bills found yet', line: 'Bills appear once charges repeat.', action: { href: '/transactions', label: 'See transactions' } })}</div>`;
      return;
    }
    const groups = bills.cycle ? groupByCycle(bills.items, bills.cycle) : [{ start: bills.from, end: bills.to, items: bills.items, current: true }];
    box.innerHTML = groups.map((g) => {
      const due = g.items.filter((b) => b.status === 'due').reduce((s, b) => s + b.amount, 0);
      return `<div class="sec-head"><h2>${g.current ? 'This cycle' : 'Next cycle'}, ${esc(cycleLabel(g))}</h2><span class="sub num">${due ? `${esc(money0(due))} due` : 'nothing due'}</span></div>
        ${g.items.length ? `<div class="rows stagger">${g.items.map(billRow).join('')}</div>` : `<div class="card quiet"><div class="quietline">${I.check}<span>No bills in this cycle.</span></div></div>`}`;
    }).join('');
    applyDims(box);
  };
  const load = () => swr('/api/bills?days=42', (d) => { bills = d; paint(); }).catch((e) => sectionError(box, token, e, 'the bills calendar', () => { box.innerHTML = skeletonRows(4); load(); }));
  if (!store.get('c:/api/bills?days=42')) box.innerHTML = `<h2>Bills</h2>${skeletonRows(4)}`;
  load();
}

function billRow(b) {
  const paid = b.status === 'paid';
  return `<a class="row" href="/transactions?q=${encodeURIComponent(b.merchant)}" data-nav><div class="ic">${b.kind === 'loan' ? I.house : b.kind === 'subscription' ? I.repeat : I.receipt}</div>
    <div class="main"><div class="t1">${esc(b.merchant)}</div><div class="t2">${paid && b.paid_on ? `Paid ${esc(shortDay(b.paid_on))}, covers ${esc(shortDay(b.date))}` : `${esc(shortDay(b.date))}, ${esc(inDays(b.date))}`} · ${esc(titleCase(b.cadence ?? b.kind))}${b.price_change ? ` · up from ${esc(money(b.price_change.from))}` : ''}</div></div>
    <div class="amt"><div class="num">${esc(money(b.amount))}</div><div class="t2">${paid ? 'Paid' : b.overdue ? 'Overdue' : 'Due'}</div></div></a>`;
}
