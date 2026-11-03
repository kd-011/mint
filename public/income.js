// Income: the next payday and what to expect, salary per pay cycle with its
// average and swing, income against spend and the savings rate, then where the
// money comes from, kept apart: income streams (salary and regular payers),
// reimbursements (they net off spend) and other money in (outside income and
// safe to spend). Any stream or single deposit can be re-classified, with a
// live preview of what a stream edit would move before it is saved. The last
// card is income by financial year beside the ATO Notices of Assessment (what
// landed in the bank, after tax, against what was assessed); tapping a year
// shows the reconciliation and edits that year's NoA.
'use strict';

const KIND_LABEL = { salary: 'Salary', regular: 'Regular payer', reimbursement: 'Reimbursement', other: 'Other money in' };
const KIND_ICON = { salary: 'briefcase', regular: 'repeat', reimbursement: 'swap', other: 'tag' };
const KIND_OPTS = Object.entries(KIND_LABEL);
const cycleTick = (iso) => `${Number(iso.slice(8, 10))} ${monthShort(iso)}`;

function nextPaydayCard(inc) {
  const np = inc.next_payday;
  const cur = inc.current;
  if (!np) {
    return `<section class="card">${emptyState({ icon: I.calendar, title: 'No pay cycle yet', line: 'Starts when a salary deposit lands.' })}</section>`;
  }
  const reg = (cur?.regular ?? []).filter((r) => r.status !== 'received');
  return `<section class="card next">
      ${cardHead(I.calendar, `Next payday${np.late ? ', late' : ''}`, `Expected <b class="num">${esc(money(np.expected_amount))}</b>`)}
      <div class="mtop"><div><div class="big2">${esc(shortDay(np.date))}</div><div class="sub">${esc(inDays(np.date))}</div></div>
        <div class="mr"><div class="sub">median of last ${inc.salary.median_of}</div></div></div>
      ${np.late ? `<div class="nudge warn slim">${I.alert}<div><small>Salary is ${plural(np.days_late, 'day')} late</small></div></div>` : ''}
      ${cur ? `<div class="mline"><span>This cycle so far</span><span class="num">${esc(money0(cur.received.total))} of ${esc(money0(cur.expected.total))}</span></div>
        <div class="meter"><i data-w="${cur.expected.total > 0 ? Math.round((cur.received.total / cur.expected.total) * 100) : 0}"></i></div>` : ''}
      ${reg.map((r) => `<div class="mline"><span>${esc(r.name)}, ${esc(shortDay(r.date))}</span><span class="num">${esc(money0(r.amount))} <span class="chip ${r.status === 'expected' ? '' : 'warn'}">${r.status === 'expected' ? 'Expected' : r.status === 'late' ? 'Late' : 'Missed'}</span></span></div>`).join('')}
    </section>`;
}

function salaryStatsHtml(s) {
  if (!s.count) return '';
  const trend = s.last && s.average ? s.last.amount - s.average : 0;
  return `<div class="grid2 mt10 stagger">
    <div class="stat"><div class="k">Average pay</div><div class="v num">${esc(money0(s.average))}</div></div>
    <div class="stat"><div class="k">Last pay</div><div class="v num">${esc(money0(s.last.amount))}</div><div class="k num ${trend >= 0 ? 'pos' : 'neg-red'}">${trend >= 0 ? '+' : '-'}${esc(money0(Math.abs(trend)))} on average</div></div>
    <div class="stat"><div class="k">Usual swing</div><div class="v num">&plusmn;${esc(money0(s.stddev))}</div></div>
    <div class="stat"><div class="k">Range</div><div class="v num">${esc(money0(s.min))} to ${esc(money0(s.max))}</div></div></div>`;
}

function streamRow(s) {
  const bits = [KIND_LABEL[s.kind]];
  if (s.cadence_days) bits.push(`every ${s.cadence_days} days`);
  if (s.last_date) bits.push(`last ${dmy(s.last_date)}`);
  return `<button class="row" type="button" data-src="${s.id}"><div class="ic">${I[KIND_ICON[s.kind]]}</div><div class="main"><div class="t1">${esc(s.name)}${s.anchor ? ' <span class="chip ok">Starts the cycle</span>' : ''}</div><div class="t2">${esc(bits.join(' · '))}</div></div><div class="amt"><div class="num">${esc(money0(s.last_90_days))}</div><div class="t2">90 days</div></div></button>`;
}
function depositRow(r) {
  return `<button class="row" type="button" data-dep="${esc(r.id)}"><div class="ic">${I.income}</div><div class="main"><div class="t1">${esc(r.description)}</div><div class="t2">${esc(dmy(r.date))} · ${esc(acctText(r.account))}</div></div><div class="amt num">${esc(money(r.amount))}</div></button>`;
}

async function viewIncome(el, token) {
  // The categories can be slow on a first visit: show the shape of the screen meanwhile.
  el.innerHTML = `${skeletonCard(150)}<h2>Income streams</h2>${skeletonRows(2)}${skeletonCard(200)}`;
  applyDims(el);
  await loadCategories().catch(() => {});
  let inc = null;
  // Numbers and lists first; the two charts are always the last slots.
  const SLOTS = ['next', 'stats', 'streams', 'reimb', 'other', 'salary', 'flow', 'fy'];
  el.innerHTML = SLOTS.map((s) => `<div id="i-${s}" class="hslot"></div>`).join('');
  const slot = (s) => $(`#i-${s}`, el);
  slot('next').innerHTML = skeletonCard(150);
  slot('streams').innerHTML = `<h2>Income streams</h2>${skeletonRows(2)}`;
  slot('salary').innerHTML = skeletonCard(200);
  slot('flow').innerHTML = skeletonCard(200);
  slot('fy').innerHTML = skeletonCard(260);
  applyDims(el);

  const closed = () => (inc?.by_cycle ?? []).filter((c) => !c.open);

  function paintNext() { slot('next').innerHTML = nextPaydayCard(inc); applyDims(slot('next')); }

  function paintSalary() {
    const cyc = inc.by_cycle.filter((c) => c.salary > 0);
    const s = inc.salary;
    if (!cyc.length) { slot('salary').innerHTML = ''; slot('stats').innerHTML = ''; return; }
    slot('stats').innerHTML = salaryStatsHtml(s);
    slot('salary').innerHTML = chartCard({ id: 'c-sal', title: 'What each payday paid' });
    const card = $('#c-sal', slot('salary'));
    const keys = [{ key: 'salary', name: 'Salary', color: VIZ[2] }];
    $('.plot', card).innerHTML = '';
    mountBars($('.plot', card), { cols: cyc.map((c) => ({ label: cycleTick(c.start), tip: cycleLabel(c), values: { salary: c.salary } })), keys, mode: 'group', height: 210, label: `Salary per pay cycle, average ${money0(s.average)}`, ref: s.average ? { value: s.average, label: `avg ${compact(s.average)}` } : null });
    card._table = () => tableHtml(['Pay cycle', 'Salary', 'vs average'], cyc.map((c) => [cycleLabel(c), money0(c.salary), `${c.salary - s.average >= 0 ? '+' : '-'}${money0(Math.abs(c.salary - s.average))}`]));
    wireChartCard(card, { tableFn: () => card._table() });
  }

  function paintFlow() {
    const cyc = inc.by_cycle;
    const done = closed();
    if (!cyc.some((c) => c.income || c.spent)) { slot('flow').innerHTML = ''; return; }
    const tIn = done.reduce((s, c) => s + c.income, 0);
    const tSp = done.reduce((s, c) => s + c.spent, 0);
    const rate = savingsRate(done);
    const now = cyc.find((c) => c.open);
    const nowRate = now && now.income > 0 ? Math.round(((now.income - now.spent) / now.income) * 100) : null;
    slot('flow').innerHTML = chartCard({ id: 'c-flow', title: 'Income and spend per pay cycle', note: rate == null ? '' : `<div class="cnote sub">Saving <b class="num ${rate >= 0 ? 'pos' : 'neg-red'}">${rate}%</b> of income, ${esc(money0(tIn - tSp))} over ${plural(done.length, 'closed cycle')}${nowRate != null ? `, <span class="num">${nowRate}%</span> this cycle` : ''}</div>` });
    const card = $('#c-flow', slot('flow'));
    const keys = [{ key: 'income', name: 'Income', color: VIZ_ACCENT }, { key: 'spent', name: 'Spend', color: VIZ[1] }];
    $('.legend-slot', card).innerHTML = legendHtml(keys);
    applyDims(card);
    $('.plot', card).innerHTML = '';
    mountBars($('.plot', card), { cols: cyc.map((c) => ({ label: cycleTick(c.start), tip: `${cycleLabel(c)}${c.open ? ' (so far)' : ''}`, values: { income: c.income, spent: c.spent } })), keys, mode: 'group', height: 220, label: 'Income against spend per pay cycle' });
    card._table = () => tableHtml(['Pay cycle', 'Income', 'Spend', 'Saved', 'Rate'], cyc.map((c) => [cycleLabel(c) + (c.open ? ' (open)' : ''), money0(c.income), money0(c.spent), money0(c.income - c.spent), c.income > 0 ? `${Math.round(((c.income - c.spent) / c.income) * 100)}%` : '']));
    wireChartCard(card, { tableFn: () => card._table() });
  }

  function paintStreams() {
    const inStreams = inc.streams.filter((s) => s.kind === 'salary' || s.kind === 'regular');
    slot('streams').innerHTML = `<div class="sec-head"><h2>Income streams</h2><button class="btn ghost sm" type="button" id="addsrc">${I.plus}Add</button></div>
      ${inStreams.length ? `<div class="rows stagger">${inStreams.map(streamRow).join('')}</div>`
        : `<div class="card">${emptyState({ icon: I.income, title: 'No income streams', line: 'Add the one that pays you.', button: { id: 'addsrc2', label: 'Add a stream', icon: I.plus } })}</div>`}`;
    const reimb = inc.streams.filter((s) => s.kind === 'reimbursement');
    const rr = inc.reimbursed_recent ?? [];
    slot('reimb').innerHTML = `<h2>Reimbursements</h2>
      ${reimb.length || rr.length ? `<div class="rows">${reimb.map(streamRow).join('')}${rr.slice(0, 5).map(depositRow).join('')}</div>`
        : `<div class="card quiet"><div class="quietline">${I.swap}<span>No one has paid you back lately.</span></div></div>`}`;
    const oth = inc.other_recent ?? [];
    slot('other').innerHTML = `<h2>Other money in</h2>
      ${oth.length ? `<div class="rows">${oth.map(depositRow).join('')}</div>
        <p class="sub pad num">${esc(money0(inc.other_unmatched_90_days.total))} in ${plural(inc.other_unmatched_90_days.count, 'deposit')} over 90 days</p>`
        : `<div class="card quiet"><div class="quietline">${I.check}<span>Nothing else has come in lately.</span></div></div>`}`;
  }

  // income by financial year, against the NoAs
  let fyData = null;
  const noaFmt = (c) => (c == null ? '\u2013' : money0(c));
  const signed = (c) => `${c < 0 ? '-' : '+'}${money0(Math.abs(c))}`;
  const fyShort = (y) => (y.current ? 'YTD' : `FY${String(y.fy).slice(2)}`);
  const fyNotes = (y) => [y.partial_bank && 'Partial bank data', !y.noa && (y.current ? 'Not assessed yet' : 'No NoA yet')].filter(Boolean);

  function paintFy() {
    const yrs = fyData.years;
    const hasRegular = yrs.some((y) => y.regular > 0);
    slot('fy').innerHTML = chartCard({ id: 'c-fy', title: 'Income by financial year' });
    const card = $('#c-fy', slot('fy'));
    const keys = [{ key: 'salary', name: 'Salary', color: VIZ[2] }, { key: 'payg', name: 'Tax withheld', color: VIZ_OTHER }, ...(hasRegular ? [{ key: 'regular', name: 'Regular', color: VIZ[0] }] : [])];
    const markers = { name: 'NoA taxable', color: '#eef3f0', values: yrs.map((y) => y.noa?.taxable_income ?? null) };
    $('.legend-slot', card).innerHTML = legendHtml([...keys, { key: 'noa', name: markers.name, color: markers.color }]);
    applyDims(card);
    $('.plot', card).innerHTML = '';
    mountBars($('.plot', card), {
      cols: yrs.map((y) => ({ label: fyShort(y), tip: `${fyLabel(y.fy)}${y.current ? ', year to date' : ''}`, dim: y.partial_bank, notes: fyNotes(y), values: { salary: y.salary, payg: y.noa?.tax_withheld_payg ?? 0, regular: y.regular } })),
      keys, markers, total: false, every: 1, mode: 'stack', height: 240, label: 'Income by financial year against the ATO Notice of Assessment',
      onPick: (i) => openFySheet(yrs[i]),
    });
    card._table = () => tableHtml(['Year', 'Net salary', 'Tax withheld', 'Est. gross', 'NoA taxable', 'Gap'], yrs.map((y) => [`${fyLabel(y.fy)}${y.current ? ' (so far)' : ''}`, money0(y.salary), noaFmt(y.noa?.tax_withheld_payg), noaFmt(y.est_gross), noaFmt(y.noa?.taxable_income), y.gap == null || y.partial_bank ? '' : `${signed(y.gap)}${y.gap_pct == null ? '' : ` (${y.gap_pct}%)`}`]));
    wireChartCard(card, { tableFn: () => card._table() });
  }

  function loadFy() {
    slot('fy').innerHTML = skeletonCard(260);
    applyDims(slot('fy'));
    swr('/api/income/fy', (d) => { fyData = d; if (token === renderToken) paintFy(); }).catch((e) => {
      if (token !== renderToken) return;
      slot('fy').innerHTML = errorCard(e, 'fyretry', 'income by year');
      $('#fyretry', slot('fy'))?.addEventListener('click', loadFy);
    });
  }

  // A year: Mint's net salary plus the PAYG on the NoA is an estimated gross, set against the taxable income.
  function openFySheet(y) {
    const sub = y.current ? 'Year to date' : y.partial_bank ? 'Partial bank data' : null;
    const rows = (list) => `<div class="recon">${list.map(([k, v, cls]) => `<div class="mline ${cls ?? ''}"><span>${esc(k)}</span><span class="num">${esc(v)}</span></div>`).join('')}</div>`;
    let body;
    if (y.noa) {
      const dir = y.gap === 0 ? 'matches' : y.gap < 0 ? 'below' : 'above';
      // Half a year of bank history would make the gap look like a finding, so a partial year shows the rows and no gap.
      const gap = y.partial_bank ? '' : `<div class="big2 num">${y.gap === 0 ? money0(0) : esc(signed(y.gap))}</div>
        <div class="sub">${y.gap === 0 ? 'Estimated gross matches taxable income' : `${y.gap_pct == null ? dir[0].toUpperCase() + dir.slice(1) : `${esc(String(Math.abs(y.gap_pct)))}% ${dir}`} taxable income`}</div>`;
      body = `${gap}
        ${rows([['Mint net salary', money0(y.salary)], ['PAYG withheld, from the NoA', `+ ${money0(y.noa.tax_withheld_payg)}`], ['Estimated gross', money0(y.est_gross), 'tot'], ['NoA taxable income', money0(y.noa.taxable_income)]])}
        <button class="btn ghost wide" type="button" id="noaedit">${I.edit}Edit NoA</button>`;
    } else {
      body = `${emptyState({ icon: I.receipt, title: y.current ? 'Not assessed yet' : 'No NoA yet', line: y.current ? 'The ATO assesses a year after it ends.' : 'Add the figures from the Notice of Assessment.', button: y.current ? null : { id: 'noaedit', label: 'Add NoA', icon: I.plus } })}
        ${rows([['Mint net salary', money0(y.salary)]])}`;
    }
    const panel = openModal(`${sheetHead(sub, fyLabel(y.fy))}${body}`);
    $('#noaedit', panel)?.addEventListener('click', () => { closeModal(); openNoaEditor(y); });
  }

  // one year's NoA: the figures off the Notice of Assessment
  const NOA_FIELDS = [
    ['taxable_income', 'Taxable income', true], ['tax_withheld_payg', 'Tax withheld (PAYG)', true], ['assessed_tax', 'Tax assessed'], ['medicare', 'Medicare levy'],
    ['vet_repayment', 'Study loan repayment'], ['refund', 'Refund (minus if owing)'], ['capital_gains', 'Capital gains'],
  ];
  function openNoaEditor(y) {
    const cur = y.noa;
    const panel = openModal(`${sheetHead(cur ? 'Edit NoA' : 'Add NoA', fyLabel(y.fy))}
      <form class="form" novalidate>
        <div class="two">${NOA_FIELDS.map(([k, label, req]) => `<div class="field"><label for="noa-${k}">${esc(label)}</label><div class="money-in"><span>$</span><input id="noa-${k}" name="${k}" inputmode="decimal" autocomplete="off" ${req ? 'required' : ''} value="${centsToInput(cur?.[k])}"></div></div>`).join('')}</div>
        <button class="btn wide" type="submit">${I.check}${cur ? 'Save NoA' : 'Add NoA'}</button>
        ${cur ? `<button class="btn danger wide" type="button" id="noadel">${I.trash}Remove NoA</button>` : ''}
      </form>`);
    const form = $('form', panel);
    const d = bindDraft(form, `noa:${y.fy}`);
    const val = (k) => { const t = $(`[name=${k}]`, form).value.trim(); return t ? parseMoney(t) : null; };
    const check = () => NOA_FIELDS.reduce((ok, [k, , req]) => {
      const c = val(k);
      const msg = c == null ? (req ? 'Enter an amount like 58018.00' : '') : Number.isNaN(c) ? 'An amount like 58018.00' : c < 0 && k !== 'refund' ? 'Cannot be negative' : '';
      return fieldError($(`[name=${k}]`, form), msg) && ok;
    }, true);
    form.addEventListener('input', check);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!check()) return;
      const body = Object.fromEntries(NOA_FIELDS.map(([k]) => [k, val(k)]));
      formError(form, null);
      try {
        const r = await withBusy($('button[type=submit]', form), 'Saving', () => mutate({ method: 'PUT', path: `/api/income/assessments/${y.fy}`, body }));
        d.clear();
        closeModal();
        if (r.queued) {
          // Show it at once from what was typed; the server recomputes the gap when it syncs.
          const yr = fyData.years.find((x) => x.fy === y.fy);
          yr.noa = { ...(yr.noa ?? {}), fy: y.fy, ...body };
          Object.assign(yr, { est_gross: yr.salary + body.tax_withheld_payg, gap: yr.salary + body.tax_withheld_payg - body.taxable_income, gap_pct: body.taxable_income > 0 ? Math.round(((yr.salary + body.tax_withheld_payg - body.taxable_income) / body.taxable_income) * 1000) / 10 : null });
          paintFy();
          toast('Saved offline, syncs when you are back');
        } else { toast(cur ? 'NoA saved' : 'NoA added'); buzz(12); loadFy(); }
      } catch (err) { formError(form, err, 'Save'); }
    });
    $('#noadel', form)?.addEventListener('click', () => {
      closeModal();
      const keep = fyData;
      undoable({
        label: `${fyLabel(y.fy)} NoA removed`,
        apply: () => { fyData = { ...fyData, years: fyData.years.map((x) => (x.fy === y.fy ? { ...x, noa: null, est_gross: null, gap: null, gap_pct: null } : x)) }; paintFy(); },
        revert: () => { fyData = keep; paintFy(); },
        op: { method: 'DELETE', path: `/api/income/assessments/${y.fy}` },
      });
    });
  }

  function paintAll() {
    if (token !== renderToken || !inc) return;
    paintNext(); paintSalary(); paintFlow(); paintStreams();
  }

  const load = () => swr('/api/income?cycles=12', (d) => { inc = d; paintAll(); }).catch((e) => {
    if (token !== renderToken) return;
    el.innerHTML = errorCard(e, 'incretry', 'income');
    $('#incretry', el)?.addEventListener('click', () => render({ keepScroll: false }));
  });
  load();
  loadFy();

  el.addEventListener('click', (e) => {
    if (e.target.closest('#addsrc, #addsrc2')) return openStreamEditor(null);
    const s = e.target.closest('[data-src]');
    if (s) return openStreamEditor(inc.streams.find((x) => x.id === Number(s.dataset.src)));
    const d = e.target.closest('[data-dep]');
    if (d) {
      const row = [...(inc.other_recent ?? []), ...(inc.reimbursed_recent ?? [])].find((x) => x.id === d.dataset.dep);
      if (row) openDepositSheet(row);
    }
  });

  // one deposit: what kind of money is it?
  function openDepositSheet(row) {
    const isReimb = (inc.reimbursed_recent ?? []).some((x) => x.id === row.id);
    const now = isReimb ? 'reimbursement' : 'other';
    const panel = openModal(`${sheetHead(`${dmy(row.date)} · ${acctText(row.account)}`, money(row.amount))}
      <p class="sub">${esc(row.description)}</p>
      <div class="field"><span class="lab">This deposit is</span>${segmented('depkind', KIND_OPTS.map(([k, l]) => [k, k === 'regular' ? 'Regular' : k === 'reimbursement' ? 'Paid back' : k === 'other' ? 'Other' : l]), now)}</div>
      <p class="sub" id="depnote">Only this deposit changes</p>
      <button class="btn ghost wide" type="button" id="mkstream">${I.plus}Make a stream from this payer</button>
      <button class="btn ghost wide" type="button" id="depauto">${I.refresh}Let Mint decide again</button>`);
    const apply = async (body, msg) => {
      const lists = ['other_recent', 'reimbursed_recent'];
      const keep = { other_recent: inc.other_recent, reimbursed_recent: inc.reimbursed_recent };
      if (body.kind) {
        // Optimistic: move it to the list for its new kind straight away.
        for (const l of lists) inc[l] = (inc[l] ?? []).filter((x) => x.id !== row.id);
        const target = body.kind === 'reimbursement' ? 'reimbursed_recent' : body.kind === 'other' ? 'other_recent' : null;
        if (target) inc[target] = [row, ...inc[target]].sort((a, b) => (a.date < b.date ? 1 : -1));
        paintStreams();
      }
      closeModal();
      try {
        const r = await mutate({ method: 'PATCH', path: `/api/income/transactions/${encodeURIComponent(row.id)}`, body });
        toast(r.queued ? 'Saved offline, syncs when you are back' : msg);
        buzz(12);
        if (!r.queued) load();
      } catch (err) {
        Object.assign(inc, keep);
        paintStreams();
        toast(`Couldn't change it: ${err.detail ?? err.message}`, { error: true, action: { label: 'Retry', fn: () => { openDepositSheet(row); } } });
      }
    };
    wireSeg(panel, 'depkind', (k) => { if (k !== now) apply({ kind: k }, `Filed as ${KIND_LABEL[k].toLowerCase()}`); });
    $('#depauto', panel).addEventListener('click', () => apply({ auto: true }, 'Mint will decide'));
    $('#mkstream', panel).addEventListener('click', () => {
      closeModal();
      const words = row.description.replace(/[0-9]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
      openStreamEditor(null, { name: words.slice(0, 40), pattern: words, match: 'starts', kind: 'regular', amount_min: Math.round(row.amount * 0.9), amount_max: Math.round(row.amount * 1.1), account: row.account });
    });
  }

  // a stream: edit it, with a live preview of what the edit moves
  function openStreamEditor(src, seed = null) {
    const accts = (accountsData?.accounts ?? []).filter((a) => !a.hidden);
    const v = src ?? seed ?? { name: '', kind: 'regular', match: 'contains', pattern: '', amount_min: null, amount_max: null, cadence_days: 14 };
    const acctId = src ? src.account_id : (accts.find((a) => a.name === seed?.account)?.id ?? null);
    const anchor = !!src?.anchor;
    const panel = openModal(`${sheetHead(src ? 'Edit stream' : 'New stream', src?.name ?? 'Where money comes from')}
      <form class="form" novalidate>
        <div class="field"><label for="sname">Name</label><input id="sname" name="name" maxlength="60" autocomplete="off" value="${esc(v.name)}"></div>
        <div class="field"><span class="lab">Counts as</span>${segmented('skind', KIND_OPTS.map(([k, l]) => [k, k === 'regular' ? 'Regular' : k === 'reimbursement' ? 'Paid back' : k === 'other' ? 'Other' : l]), v.kind)}
          ${anchor ? '<div class="sub">Starts your pay cycles, so it stays salary</div>' : ''}</div>
        <div class="two"><div class="field"><label for="smatch">Description</label><select id="smatch" name="match">${[['contains', 'contains'], ['starts', 'starts with'], ['exact', 'is exactly'], ['person', 'a person paying (auto)']].map(([k, l]) => `<option value="${k}" ${v.match === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label for="spat">Text</label><input id="spat" name="pattern" maxlength="200" autocomplete="off" value="${esc(v.pattern ?? '')}"></div></div>
        <div class="two"><div class="field"><label for="smin">At least</label><div class="money-in"><span>$</span><input id="smin" name="min" inputmode="decimal" autocomplete="off" value="${centsToInput(v.amount_min)}"></div></div>
          <div class="field"><label for="smax">At most</label><div class="money-in"><span>$</span><input id="smax" name="max" inputmode="decimal" autocomplete="off" value="${centsToInput(v.amount_max)}"></div></div></div>
        <div class="two"><div class="field"><label for="sacct">Into account</label><select id="sacct" name="account"><option value="">Any account</option>${accts.map((a) => `<option value="${esc(a.id)}" ${a.id === acctId ? 'selected' : ''}>${esc(accountName(a))}</option>`).join('')}</select></div>
          <div class="field"><label for="scad">Every (days)</label><input id="scad" name="cadence" inputmode="numeric" autocomplete="off" value="${v.cadence_days ?? ''}" placeholder="Not regular"></div></div>
        <div class="preview-box" id="spreview" aria-live="polite"></div>
        <button class="btn wide" type="submit">${I.check}${src ? 'Save stream' : 'Add stream'}</button>
        ${src && !anchor ? `<button class="btn danger wide" type="button" id="sdel">${I.trash}Delete stream</button>` : ''}
      </form>`);
    const form = $('form', panel);
    bindDraft(form, `income-src:${src?.id ?? 'new'}`);
    const getKind = wireSeg(panel, 'skind', () => { sync(); });
    if (anchor) $$('[data-seg="skind"] button', panel).forEach((b) => { b.disabled = true; });
    const num = (id) => { const t = $(id, form).value.trim(); return t ? parseMoney(t) : null; };
    const body = () => {
      const min = num('#smin');
      const max = num('#smax');
      const cad = $('#scad', form).value.trim();
      return {
        name: $('#sname', form).value.trim() || 'New stream', kind: getKind(), match: $('#smatch', form).value, pattern: $('#spat', form).value.trim(),
        account_id: $('#sacct', form).value || null, amount_min: min, amount_max: max, cadence_days: cad ? Number(cad) : null,
        bad: Number.isNaN(min) || Number.isNaN(max) || (cad && !/^\d{1,3}$/.test(cad)),
      };
    };
    const prev = $('#spreview', form);
    let seq = 0;
    let timer = 0;
    const sync = () => {
      clearTimeout(timer);
      const b = body();
      const pat = $('#spat', form);
      fieldError(pat, b.match !== 'person' && !b.pattern ? 'Enter the text to match' : '');
      if (b.bad) { prev.innerHTML = '<span class="sub">Fix the amounts to see the preview.</span>'; return; }
      if (!online) { prev.innerHTML = '<span class="sub">The preview needs a connection. You can still save; it will sync later.</span>'; return; }
      prev.innerHTML = '<span class="spin dim"></span><span class="sub">Checking your deposits...</span>';
      const mine = ++seq;
      timer = setTimeout(async () => {
        const { bad, ...send } = b;
        try {
          const r = await api('/api/income/sources/preview', { method: 'POST', body: src ? { id: src.id, ...send } : send });
          if (mine !== seq || !prev.isConnected) return;
          prev.innerHTML = previewHtml(r);
        } catch (err) {
          if (mine !== seq || !prev.isConnected) return;
          prev.innerHTML = `<span class="ferr">${esc(err.detail ?? err.message)}</span>`;
        }
      }, 320);
    };
    form.addEventListener('input', sync);
    form.addEventListener('change', sync);
    sync();

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const b = body();
      if (b.bad) return;
      if (b.match !== 'person' && !b.pattern) return fieldError($('#spat', form), 'Enter the text to match');
      const { bad, ...send } = b;
      formError(form, null);
      const btn = $('button[type=submit]', form);
      try {
        const r = await withBusy(btn, 'Saving', () => mutate(src ? { method: 'PATCH', path: `/api/income/sources/${src.id}`, body: send } : { method: 'POST', path: '/api/income/sources', body: send }));
        drafts.clear(`income-src:${src?.id ?? 'new'}`);
        closeModal();
        if (r.queued) {
          if (src) Object.assign(inc.streams.find((x) => x.id === src.id), send);
          paintAll();
          toast('Saved offline, syncs when you are back');
        } else { toast(src ? 'Stream saved' : 'Stream added'); buzz(12); await load(); }
      } catch (err) { formError(form, err, 'Save'); }
    });
    $('#sdel', form)?.addEventListener('click', () => {
      closeModal();
      const keep = inc;
      undoable({
        label: `${src.name} deleted`,
        apply: () => { inc = { ...inc, streams: inc.streams.filter((x) => x.id !== src.id) }; paintAll(); },
        revert: () => { inc = keep; paintAll(); },
        op: { method: 'DELETE', path: `/api/income/sources/${src.id}` },
      });
    });
  }
}

// The preview, in words: what it matches and what would change kind.
function previewHtml(r) {
  const dollar = (c) => money(c);
  const toIncome = r.moves.filter((m) => ['salary', 'regular'].includes(m.to) && !['salary', 'regular'].includes(m.from)).reduce((s, m) => s + m.total, 0);
  const fromIncome = r.moves.filter((m) => ['salary', 'regular'].includes(m.from) && !['salary', 'regular'].includes(m.to)).reduce((s, m) => s + m.total, 0);
  const delta = toIncome - fromIncome;
  return `<div class="pv"><b>${plural(r.matches, 'deposit')} match</b>${r.matches ? `, ${esc(dollar(r.total))} in all, latest ${esc(dmy(r.last_date))}` : ''}.</div>
    ${r.moves.length ? `<ul class="pvl">${r.moves.map((m) => `<li><span class="num">${m.count}</span> would move from ${esc(KIND_LABEL[m.from].toLowerCase())} to ${esc(KIND_LABEL[m.to].toLowerCase())} <span class="dim num">(${esc(dollar(m.total))})</span></li>`).join('')}</ul>` : r.matches ? '<div class="sub">None of them change: they are already filed this way.</div>' : ''}
    ${delta ? `<div class="pv ${delta > 0 ? 'pos' : 'neg-red'}">Counted as income: <span class="num">${delta > 0 ? '+' : '-'}${esc(dollar(Math.abs(delta)))}</span> over your history.</div>` : ''}
    ${r.pinned ? `<div class="sub">${plural(r.pinned, 'deposit')} you filed by hand stay as you set them.</div>` : ''}`;
}
