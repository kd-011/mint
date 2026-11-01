// The Tax return estimate card at the top of the Tax tab: refund or owing as
// the headline, the working underneath (each line marked entered, estimated,
// from the bank feed or calculated), a confidence note, the assumptions with
// what they would swing, and an edit sheet for the figures the bank feed
// cannot show (payslip gross and tax withheld, as at a date, hospital cover,
// HELP). An estimate, not tax advice. The maths is on the server.
'use strict';

const EST_SRC = { entered: ['Entered', 'ok'], estimated: ['Estimated', 'warn'], feed: ['Bank feed', ''], calculated: ['Calculated', 'dim'] };
const estChip = (s) => { const [t, c] = EST_SRC[s] ?? [s, '']; return `<span class="chip ${c}">${esc(t)}</span>`; };
const estPendingKey = (fy) => `taxest-pending:${fy}`;
const estLevel = { high: ['High confidence', 'ok'], medium: ['Medium confidence', 'warn'], low: ['Low confidence', 'bad'] };

function estRow(l, { neg = false, strong = false } = {}) {
  return `<div class="row wr ${strong ? 'strong' : ''}"><div class="main"><div class="t1">${esc(l.label)}</div>${l.note ? `<div class="t2 wrap">${esc(moneyText(l.note))}</div>` : ''}</div>
    <div class="amt"><div class="num">${neg && l.amount ? '−' : ''}${esc(money0(l.amount))}</div>${estChip(l.source)}</div></div>`;
}

function estWorking(est) {
  const by = Object.fromEntries(est.lines.map((l) => [l.key, l]));
  const codes = est.deductions.by_code.map((d) => `<div class="row wr sub-row"><div class="main"><div class="t1">${esc(d.code)} · ${esc(d.label)}</div></div><div class="amt num">−${esc(money0(d.amount))}</div></div>`).join('');
  const show = (k) => by[k] && (by[k].amount || ['salary', 'interest', 'business', 'other', 'income_tax', 'medicare'].includes(k));
  const tax = ['income_tax', 'lito', 'medicare', 'mls', 'help'].filter((k) => show(k) || (k === 'mls' && est.inputs.private_health === false) || (k === 'help' && (est.inputs.has_help || est.inputs.help_debt)));
  const assume = est.assumptions.filter((a) => !['private_health', 'has_help'].includes(a.key));
  return `<div class="wgroup"><h4>Income</h4>${['salary', 'interest', 'business', 'other'].map((k) => estRow(by[k])).join('')}${estRow(by.income_total, { strong: true })}</div>
    <div class="wgroup"><h4>Deductions</h4>${estRow(by.deductions, { neg: true })}${codes}${estRow(by.taxable_income, { strong: true })}</div>
    <div class="wgroup"><h4>Tax</h4>${tax.map((k) => estRow(by[k], { neg: k === 'lito' })).join('')}${estRow(by.tax_payable, { strong: true })}</div>
    <div class="wgroup"><h4>Result</h4>${estRow(by.withheld, { neg: true })}${estRow({ ...by.result, label: est.result >= 0 ? 'Estimated refund' : 'Estimated amount owing' }, { strong: true })}</div>
    <div class="wgroup"><h4>Assumptions</h4><ul class="est-why">${assume.map((a) => `<li>${esc(moneyText(a.text))}</li>`).join('')}</ul>
    <p class="sub pad0"><a href="${esc(est.rates.income_tax.source)}" target="_blank" rel="noopener noreferrer">ATO ${esc(est.rates.label)} rates</a></p></div>`;
}

function estimateCardHtml(est, { open, pending }) {
  const head = (sub) => `<div class="est-top"><span class="card-ic">${I.receipt}</span><div class="est-tt"><h3 class="card-t">Tax return estimate</h3><div class="sub">${esc(sub)}</div></div>
    <button class="x" type="button" data-estedit aria-label="Edit the figures behind the estimate" title="Edit the figures">${I.edit}</button></div>`;
  if (est.status === 'unsupported') {
    return `<section class="card est">${head(fyLabel(est.fy))}<p class="sub">${esc(est.message)}</p></section>`;
  }
  const sub = `${fyLabel(est.fy)} · ${est.final ? 'full year' : `projected to 30 June from ${dmy(est.salary.as_at)}`}`;
  if (est.status === 'no_data') {
    return `<section class="card est">${head(sub)}<div class="empty slim"><div class="art">${I.receipt}</div><h3>Nothing to estimate yet</h3><p>${esc(est.message)}</p>
      <button class="btn" type="button" data-estedit>${I.edit}Enter payslip figures</button></div></section>`;
  }
  const kind = est.headline.kind;
  const [levelText, levelCls] = estLevel[est.confidence.level] ?? estLevel.low;
  const swings = est.swings.map((s) => `<div class="row swing"><div class="main"><div class="t1 wrapt">${esc(s.label)}</div><div class="t2 wrap">Not set, left out</div></div>
      <div class="amt neg-red num">+${esc(money0(s.amount))}</div><button class="btn ghost sm" type="button" data-estedit>Set</button></div>`).join('');
  return `<section class="card est" id="estcard">${head(sub)}
    <div class="est-hero"><div class="est-kind ${kind}">${kind === 'refund' ? 'Estimated refund' : kind === 'owing' ? 'Estimated amount owing' : 'Estimated to break even'}</div>
      <div class="est-big num ${kind}" id="estbig">${esc(money0(est.headline.amount))}</div></div>
    ${pending ? `<div class="est-pending" role="status">${I.tick}Saved offline. The estimate updates when you are back online.</div>` : ''}
    <div class="est-conf"><span class="chip ${levelCls}">${esc(levelText)}</span></div>
    ${swings ? `<div class="rows swings" aria-label="Open questions that could change the estimate">${swings}</div>` : ''}
    <section class="agroup ${open ? 'open' : ''}" id="estwork"><button class="row" type="button" data-esttoggle aria-expanded="${open}"><div class="main"><div class="t1">The working</div></div><span class="caret">${I.chevron}</span></button>
      <div class="abody"><div class="abody-in"><ul class="est-why wgroup-why">${est.confidence.reasons.map((r) => `<li>${esc(moneyText(r))}</li>`).join('')}</ul>${estWorking(est)}</div></div></section>
    <p class="sub est-foot">Estimate, not tax advice</p></section>`;
}

// Mount the card in `host`. Loads with a skeleton, shows a saved copy at once, retries with a real error.
function taxEstimateCard(host, { fy, token }) {
  let est = null;
  let open = store.get('tax-est-open') ?? false;
  const key = `/api/tax/estimate?fy=${fy}`;
  const paint = () => {
    if (token !== renderToken || !est) return;
    const pending = !!store.get(estPendingKey(fy));
    host.innerHTML = `<div class="stagger">${estimateCardHtml(est, { open, pending })}</div>`;
    const big = $('#estbig', host);
    if (big) countUp(big, est.headline.amount, money0, `tax:${fy}`);
  };
  const load = () => swr(key, (d) => { est = d; paint(); }).catch((e) => {
    if (token !== renderToken) return;
    host.innerHTML = errorCard(e, 'estretry', 'the tax return estimate');
    $('#estretry', host)?.addEventListener('click', () => { host.innerHTML = skeletonCard(220); applyDims(host); load(); });
  });
  if (!store.get(`c:${key}`)) { host.innerHTML = skeletonCard(220); applyDims(host); }
  load();

  host.addEventListener('click', (e) => {
    if (e.target.closest('[data-estedit]')) { buzz(6); openTaxInputs({ fy, est, reload: load }); return; }
    const t = e.target.closest('[data-esttoggle]');
    if (t) {
      open = !open;
      const g = t.closest('.agroup');
      g.classList.toggle('open', open);
      t.setAttribute('aria-expanded', String(open));
      store.set('tax-est-open', open);
      buzz(5);
    }
  });

  // A change made offline waits in the write queue; look again once it has gone.
  const onOnline = (ev) => {
    if (!ev.detail || !store.get(estPendingKey(fy))) return;
    let tries = 0;
    const poll = setInterval(() => {
      if (token !== renderToken || ++tries > 24) { clearInterval(poll); return; }
      if (queue.all().length) return;
      clearInterval(poll);
      store.del(estPendingKey(fy));
      store.del(`c:${key}`);
      load();
    }, 500);
  };
  document.addEventListener('mint:online', onOnline);
  cleanup.push(() => document.removeEventListener('mint:online', onOnline));
  return { reload: load };
}

// ---------- the edit sheet ----------

const triSeg = (name, value) => segmented(name, [['yes', 'Yes'], ['no', 'No'], ['unknown', 'Not sure']], value === true ? 'yes' : value === false ? 'no' : 'unknown');
const triValue = (v) => (v === 'yes' ? true : v === 'no' ? false : null);

function openTaxInputs({ fy, est, reload }) {
  const saved = store.get(estPendingKey(fy)) ?? est?.inputs ?? {};
  const range = { from: `${fy - 1}-07-01`, to: `${fy}-06-30` };
  const maxDate = todayIso() < range.to ? todayIso() : range.to;
  const hint = (v) => (v ? `Estimated ${money0(v)}` : '');
  const moneyField = (name, label, id, help, ph) => `<div class="field"><label for="${id}">${esc(label)}</label><div class="money-in"><span>$</span><input id="${id}" name="${name}" inputmode="decimal" autocomplete="off" placeholder="${esc(ph ?? '0.00')}" value="${saved[name] != null ? centsToInput(saved[name]) : ''}"></div>${help ? `<div class="sub">${esc(help)}</div>` : ''}</div>`;
  const panel = openModal(`${sheetHead(fyLabel(fy), 'Tax return figures')}
    <form class="form" novalidate>
      <p class="sub">The bank feed only shows net pay. Your latest payslip, or the myGov income statement once it is tax ready, has the real figures. Anything left blank stays an estimate.</p>
      ${moneyField('gross_salary', 'Gross salary so far', 'tg', 'Year to date, before tax. From a payslip.', hint(est?.salary?.ytd?.gross))}
      ${moneyField('tax_withheld', 'Tax withheld so far', 'tw', 'Year to date PAYG withheld, from the same payslip.', hint(est?.salary?.ytd?.withheld))}
      <div class="field"><label for="tad">Those figures run to</label><input id="tad" name="as_at" type="date" min="${range.from}" max="${maxDate}" value="${esc(saved.as_at ?? '')}"><div class="sub">Leave blank for today. For a finished year, use 30 June.</div></div>
      ${moneyField('other_income', 'Other income Mint cannot see', 'to', 'Interest at other banks, dividends, side work.')}
      ${moneyField('extra_deductions', 'Deductions not tagged in Mint', 'te', 'Added to the D items you have tagged.')}
      <div class="field"><span class="lab">Private hospital cover for the whole year</span>${triSeg('tph', saved.private_health)}<input type="hidden" name="private_health" value="${saved.private_health == null ? 'unknown' : saved.private_health ? 'yes' : 'no'}"><div class="sub">Decides the Medicare levy surcharge. Not sure means it is assumed you have cover.</div></div>
      <div class="field"><span class="lab">HELP or other study loan</span>${triSeg('thl', saved.has_help ?? (saved.help_debt != null ? saved.help_debt > 0 : null))}<input type="hidden" name="has_help" value="${(saved.has_help ?? (saved.help_debt != null ? saved.help_debt > 0 : null)) == null ? 'unknown' : (saved.has_help ?? saved.help_debt > 0) ? 'yes' : 'no'}"></div>
      <div id="helpbal">${moneyField('help_debt', 'Loan balance', 'tb', 'Optional. Caps the repayment at what you owe.')}</div>
      <button class="btn wide" type="submit">${I.check}Save figures</button>
    </form>`);
  const form = $('form', panel);
  const d = bindDraft(form, `taxest:${fy}`);
  const ph = $('[name=private_health]', form);
  const hh = $('[name=has_help]', form);
  const sync = () => { $('#helpbal', form).hidden = hh.value !== 'yes'; };
  const pick = (input, name) => wireSeg(form, name, (v) => { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); sync(); });
  pick(ph, 'tph');
  pick(hh, 'thl');
  // A restored draft decides the segments, not the saved values.
  for (const [input, name] of [[ph, 'tph'], [hh, 'thl']]) $$(`[data-seg="${name}"] button`, form).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === input.value)));
  sync();

  const cents = (name) => { const v = $(`[name=${name}]`, form).value.trim(); return v ? parseMoney(v) : null; };
  const check = () => {
    let ok = true;
    for (const [name, what] of [['gross_salary', 'An amount like 48250.00'], ['tax_withheld', 'An amount like 9120.00'], ['other_income', 'An amount like 300.00'], ['extra_deductions', 'An amount like 150.00'], ['help_debt', 'An amount like 12000.00']]) {
      const input = $(`[name=${name}]`, form);
      const c = cents(name);
      ok = fieldError(input, c != null && (Number.isNaN(c) || c < 0) ? what : '') && ok;
    }
    const at = $('[name=as_at]', form);
    ok = fieldError(at, at.value && (at.value < range.from || at.value > maxDate) ? `Pick a date between ${dmy(range.from)} and ${dmy(maxDate)}` : '') && ok;
    const g = cents('gross_salary');
    const w = cents('tax_withheld');
    if (g != null && w != null && !Number.isNaN(g) && !Number.isNaN(w)) ok = fieldError($('[name=tax_withheld]', form), w > g ? 'Tax withheld cannot be more than the gross salary' : '') && ok;
    return ok;
  };
  form.addEventListener('input', check);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!check()) return;
    const body = {
      fy, gross_salary: cents('gross_salary'), tax_withheld: cents('tax_withheld'), as_at: $('[name=as_at]', form).value || null,
      other_income: cents('other_income'), extra_deductions: cents('extra_deductions'),
      private_health: triValue(ph.value), has_help: triValue(hh.value), help_debt: hh.value === 'yes' ? cents('help_debt') : null,
    };
    formError(form, null);
    try {
      const r = await withBusy($('button[type=submit]', form), 'Saving', () => mutate({ method: 'PUT', path: '/api/tax/estimate/inputs', body }));
      d.clear();
      closeModal();
      if (r.queued) {
        store.set(estPendingKey(fy), (({ fy: _f, ...rest }) => rest)(body));
        toast('Saved offline, syncs when you are back');
        reload();
      } else {
        store.del(estPendingKey(fy));
        store.set(`c:/api/tax/estimate?fy=${fy}`, { d: r.data.estimate, at: Date.now() });
        toast('Tax figures saved');
        buzz(12);
        reload();
      }
    } catch (err) { formError(form, err, 'Save'); }
  });
}
