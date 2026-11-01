// Ledger (/owed, under More): a manual two-sided ledger of money other people
// owe the owner and money he owes them. A big total, a card per person (net
// balance, open debts, oldest date, overdue), and a sheet per person with
// each debt and its repayments. Debts and repayments are added by hand; a
// repayment can name the bank deposit (or payment, for money the owner owes) it was. Standalone: nothing here feeds net worth, safe to spend or
// budgets. Maths comes from owed-math.js so the offline screen agrees with
// the server. Writes apply at once and roll back with the real error.
'use strict';

const OWED_STATUS = { open: ['', 'Open'], settled: ['ok', 'Settled'], written_off: ['warn', 'Written off'] };
const owedInitial = (name) => (String(name).trim()[0] ?? '?').toUpperCase();
const owesYou = (d) => owedDir(d) === 'owed_to_me';

async function viewOwed(el, token) {
  let data = null; // the /api/owed answer, kept in step with the screen
  let openKey = null; // the person whose sheet is open
  let first = true;
  const live = () => token === renderToken;

  // ----- state -----
  const cacheIt = () => store.set('c:/api/owed', { d: data, at: Date.now() });
  const setItems = (items) => {
    const today = todayIso();
    const rows = items.map((d) => owedView(d, today));
    data = { ...data, as_of: today, ...owedTally(rows, today), items: rows.filter((d) => !d.archived), names: owedNames(rows) };
    cacheIt();
  };
  const patchItem = (id, fn) => setItems(data.items.map((d) => (d.id === id ? fn(d) : d)));
  const debtsOf = (key) => data.items.filter((d) => owedKey(d.person) === key)
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (a.lent_on < b.lent_on ? 1 : a.lent_on > b.lent_on ? -1 : b.id - a.id));
  const find = (id) => data.items.find((d) => d.id === id);
  const usedOf = (txId) => data.items.reduce((s, d) => s + d.payments.filter((p) => p.transaction_id === txId).reduce((t, p) => t + p.amount, 0), 0);

  // ----- drawing -----
  // What is left between the owner and this person: net above zero they owe him.
  const personOpen = (p) => p.open_count + p.owe_open_count;
  const personRow = (p) => {
    const settled = personOpen(p) === 0;
    const pend = debtsOf(p.key).some((d) => d.id < 0);
    const both = p.outstanding > 0 && p.i_owe > 0;
    const line = settled ? `${plural(p.debts, 'debt')}, all paid back`
      : both ? `Owes you ${money(p.outstanding)}, you owe ${money(p.i_owe)}`
        : `${plural(personOpen(p), 'debt')} open, oldest ${dmy(p.oldest_open)}`;
    const amt = settled ? 'Settled' : p.net === 0 ? 'Even' : money(Math.abs(p.net));
    const tone = p.net < 0 ? 'neg-red' : settled || p.net === 0 ? 'dim' : '';
    return `<button class="row owed-person" type="button" data-person="${esc(p.key)}"><div class="ic lt">${esc(owedInitial(p.name))}</div>
      <div class="main"><div class="t1">${esc(p.name)} ${p.overdue_count ? '<span class="chip bad">Overdue</span>' : ''}${pend ? '<span class="chip">Saving...</span>' : ''}</div>
        <div class="t2 wrap">${esc(line)}</div></div>
      <div class="amt num ${tone}">${esc(amt)}${!settled && p.net !== 0 ? `<div class="t2">${p.net < 0 ? 'you owe' : 'owes you'}</div>` : ''}</div>${I.chevron}</button>`;
  };

  function heroHtml() {
    const owing = data.people.filter((p) => p.outstanding > 0);
    const owed = data.people.filter((p) => p.i_owe > 0);
    const open = data.people.reduce((s, p) => s + personOpen(p), 0);
    const net = data.net;
    return `<section class="hero owed-hero" id="owedhero"><div class="label">${net < 0 ? 'Net, you owe' : 'Net, owed to you'}</div><div class="big num" id="owedbig">${esc(money(Math.abs(net)))}</div>
      <div class="split"><div><b class="num">${esc(money(data.total_outstanding))}</b>owed to you (${owing.length})</div><div><b class="num">${esc(money(data.total_i_owe))}</b>you owe (${owed.length})</div><div><b>${open}</b>${open === 1 ? 'debt' : 'debts'} open</div>${data.overdue_total ? `<div class="owed-over"><b class="num">${esc(money(data.overdue_total))}</b>overdue</div>` : ''}</div></section>`;
  }

  function paint() {
    if (!live() || !data) return;
    const owing = data.people.filter((p) => personOpen(p) > 0);
    const done = data.people.filter((p) => personOpen(p) === 0);
    if (!data.items.length) {
      el.innerHTML = `<div class="card">${emptyState({ icon: I.user, title: 'Nothing owed either way.', line: 'Add a debt, either someone who owes you or someone you owe, and tick off repayments.', button: { id: 'owedadd', label: 'Add a debt', icon: I.plus } })}</div>`;
      return;
    }
    el.innerHTML = `${heroHtml()}
      <div class="sec-head"><h2>People</h2><button class="btn ghost sm" type="button" id="owedadd">${I.plus}Add a debt</button></div>
      ${owing.length ? `<div class="rows" id="owedlist">${owing.map(personRow).join('')}</div>` : `<div class="card">${emptyState({ icon: I.check, title: 'All square.', line: 'Nothing is outstanding either way right now.' })}</div>`}
      ${done.length ? collapsible('owed-settled', 'Settled up', { meta: String(done.length), open: false, body: `<div class="rows owed-done">${done.map(personRow).join('')}</div>` }) : ''}`;
    countUp($('#owedbig', el), Math.abs(data.net), money, 'owed:net');
    if (first) { first = false; stagger($('#owedlist', el) ?? el, ':scope > .row'); }
    if (openKey) sheetRefresh();
  }

  // ----- the person sheet -----
  function debtCard(d) {
    const pend = d.id < 0;
    const pct = Math.min(100, Math.round((d.repaid / d.amount) * 100));
    const [tone, label] = OWED_STATUS[d.status];
    const mine = !owesYou(d);
    const chip = `${mine ? '<span class="chip warn">You owe</span> ' : ''}${d.status === 'open' && d.overdue ? '<span class="chip bad">Overdue</span>' : `<span class="chip ${tone}">${label}</span>`}`;
    const pays = d.payments.map((p) => `<div class="mline owed-pay"><span>${esc(dmy(p.date))}${p.note ? `, ${esc(moneyText(p.note))}` : ''}${p.transaction_id ? ` <span class="chip ok">${I.bank}Bank</span>` : ''}</span>
        <span class="num">${esc(money(p.amount))}<button class="x sm" type="button" data-delpay="${d.id}:${p.id}" aria-label="Delete this ${mine ? 'payment' : 'repayment'}" title="${p.id < 0 ? 'Waiting to sync' : `Delete this ${mine ? 'payment' : 'repayment'}`}" ${p.id < 0 ? 'disabled' : ''}>${I.trash}</button></span></div>`).join('');
    return `<section class="card owed-debt" data-debt="${d.id}">
      ${cardHead(I.user, moneyText(d.note) || 'No note', chip)}
      <div class="big2 num">${esc(money(d.status === 'open' ? d.outstanding : d.amount))}</div>
      <div class="sub">${d.status === 'open' ? `left of ${esc(money(d.amount))}` : d.status === 'written_off' ? `written off, ${esc(money(d.written_off))} let go` : mine ? 'paid in full' : 'paid back in full'}</div>
      <div class="meter ${d.status === 'written_off' ? 'warm' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Paid back"><i data-w="${pct}"></i></div>
      <div class="kvs"><div><span>${mine ? 'Since' : 'Lent'}</span><b class="num">${esc(dmy(d.lent_on))}</b></div>${d.due_on ? `<div><span>Due</span><b class="num ${d.overdue ? 'neg-red' : ''}">${esc(dmy(d.due_on))}</b></div>` : ''}<div><span>${mine ? 'Paid' : 'Paid back'}</span><b class="num ${d.repaid ? 'pos' : ''}">${esc(money(d.repaid))}</b></div></div>
      ${pays ? `<h3 class="sub-h">${mine ? 'Payments' : 'Repayments'}</h3>${pays}` : ''}
      <div class="xact">${d.status === 'open' ? `<button class="btn sm" type="button" data-pay="${d.id}" ${pend ? 'disabled title="Waiting to sync"' : ''}>${I.plus}${mine ? 'Payment' : 'Repayment'}</button>` : `<button class="btn ghost sm" type="button" data-act="reopen:${d.id}" ${pend ? 'disabled' : ''}>${I.refresh}Reopen</button>`}
        <button class="x sm" type="button" data-menu="${d.id}" aria-label="More actions for this debt" title="${pend ? 'Waiting to sync' : 'More'}" ${pend ? 'disabled' : ''}>${I.dots}</button></div>
      ${pend ? '<div class="sub">Saved on this device, it syncs when you are back online.</div>' : ''}
    </section>`;
  }

  function sheetInner() {
    const p = data.people.find((x) => x.key === openKey);
    if (!p) return null;
    const both = p.outstanding > 0 && p.i_owe > 0;
    const head = personOpen(p) === 0 ? 'All paid back' : p.net === 0 ? 'Even' : p.net > 0 ? 'Owes you' : 'You owe';
    return `${sheetHead(head, p.name)}
      <div class="owed-sum"><div class="big2 num">${esc(money(Math.abs(p.net)))}</div><div class="sub">${personOpen(p) ? `${plural(personOpen(p), 'open debt')}, oldest ${esc(dmy(p.oldest_open))}${both ? `. Owes you ${esc(money(p.outstanding))}, you owe ${esc(money(p.i_owe))}` : ''}${p.overdue_count ? `, ${esc(money(p.overdue_amount))} overdue` : ''}` : 'All paid back'}</div></div>
      ${debtsOf(openKey).map(debtCard).join('')}
      <button class="btn ghost wide" type="button" data-adddebt>${I.plus}Add another debt for ${esc(p.name)}</button>`;
  }
  function sheetRefresh() {
    const body = $('#owedbody');
    const inner = sheetInner();
    if (!body) return;
    if (inner == null) { openKey = null; closeSheet(); return; }
    body.innerHTML = inner;
    applyDims(body);
  }
  function openPerson(key) {
    openKey = key;
    const panel = openSheet(`<div id="owedbody">${sheetInner()}</div>`, 'owed', { onClose: () => { openKey = null; paneOwner = null; } });
    applyDims(panel);
    wireSheet($('#owedbody'));
  }

  // ----- sending a write -----
  // Applies the change on screen, sends it (or queues it offline), and puts the
  // screen back with the real error if the server says no. Resolves true on success.
  async function send(form, btn, busy, { apply, op, done }) {
    const before = data;
    apply();
    paint();
    try {
      const r = await withBusy(btn, busy, () => mutate(op));
      closeModal();
      if (r.queued) toast('Saved offline, syncs when you are back'); else { toast(done); buzz(12); await load(); }
      return true;
    } catch (err) {
      data = before;
      cacheIt();
      paint();
      formError(form, err, 'Save');
      return false;
    }
  }

  // ----- add or edit a debt -----
  function openDebtForm(d, preset = {}) {
    const key = `owed:${d ? `edit:${d.id}` : 'new'}`;
    const names = data.names.slice(0, 8);
    const lockDir = !!d?.repaid; // a debt with repayments keeps its direction
    const panel = openModal(`${sheetHead(d ? 'Edit debt' : 'New debt', d ? d.person : 'Money owed either way')}
      <form class="form" novalidate>
        <div class="field"><label>Which way</label>${segmented('dir', [['owed_to_me', 'They owe me'], ['i_owe', 'I owe them']], d ? owedDir(d) : preset.dir ?? 'owed_to_me')}${lockDir ? '<div class="sub">Fixed while it has repayments</div>' : ''}</div>
        <div class="field"><label for="opn" id="opnl">Who owes you</label><input id="opn" name="person" maxlength="60" autocomplete="off" list="opnames" value="${esc(d?.person ?? preset.person ?? '')}" ${d ? '' : 'autofocus'}><datalist id="opnames">${names.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
          ${names.length && !d ? `<div class="chips wrap" id="opchips">${names.slice(0, 6).map((n) => `<button class="chip-btn" type="button" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}</div>
        <div class="field"><label for="opa">Amount</label><div class="money-in"><span>$</span><input id="opa" name="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${centsToInput(d?.amount)}"></div></div>
        <div class="field"><label for="opw">What for (optional)</label><input id="opw" name="note" maxlength="200" autocomplete="off" placeholder="Dinner at Sosta" value="${esc(d?.note ?? '')}"></div>
        <div class="two"><div class="field"><label for="opl">Date</label><input id="opl" name="lent_on" type="date" max="${todayIso()}" value="${esc(d?.lent_on ?? todayIso())}"></div>
          <div class="field"><label for="opd">Due (optional)</label><input id="opd" name="due_on" type="date" value="${esc(d?.due_on ?? '')}"></div></div>
        <button class="btn wide" type="submit">${I.check}${d ? 'Save changes' : 'Add debt'}</button>
      </form>`);
    const form = $('form', panel);
    bindDraft(form, key);
    const person = $('#opn', form);
    if (preset.person && !d) person.value = preset.person;
    const dir = wireSeg(form, 'dir', () => relabel());
    if (lockDir) $$('[data-seg="dir"] button', form).forEach((b) => { b.disabled = true; });
    const relabel = () => { $('#opnl', form).textContent = dir() === 'i_owe' ? 'Who you owe' : 'Who owes you'; };
    relabel();
    const amt = $('#opa', form);
    const lent = $('#opl', form);
    const due = $('#opd', form);
    const repaid = d?.repaid ?? 0;
    const check = () => {
      let ok = true;
      const c = parseMoney(amt.value);
      ok = fieldError(person, person.value.trim() ? '' : dir() === 'i_owe' ? 'Say who you owe' : 'Say who owes you') && ok;
      ok = fieldError(amt, !amt.value.trim() ? 'Enter an amount' : Number.isNaN(c) || c <= 0 ? 'An amount like 40 or 40.50' : c < repaid ? `Already paid back ${money(repaid)}, so it cannot be less` : '') && ok;
      ok = fieldError(lent, !lent.value ? 'Pick the day' : lent.value > todayIso() ? 'It cannot be in the future' : '') && ok;
      ok = fieldError(due, due.value && due.value < lent.value ? 'Due cannot be before it was lent' : '') && ok;
      return ok;
    };
    form.addEventListener('input', check);
    $('#opchips', form)?.addEventListener('click', (e) => { const b = e.target.closest('[data-name]'); if (b) { person.value = b.dataset.name; person.dispatchEvent(new Event('input', { bubbles: true })); buzz(6); amt.focus(); } });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!check()) return;
      formError(form, null);
      const body = { person: person.value.trim().replace(/\s+/g, ' '), amount: parseMoney(amt.value), note: $('#opw', form).value.trim() || null, direction: dir(), lent_on: lent.value, due_on: due.value || null };
      const at = new Date().toISOString();
      const ok = await send(form, $('button[type=submit]', form), d ? 'Saving' : 'Adding', {
        apply: () => { if (d && owedKey(d.person) === openKey) openKey = owedKey(body.person); setItems(d ? data.items.map((x) => (x.id === d.id ? { ...x, ...body } : x)) : [{ id: -Date.now(), ...body, closed: null, archived: false, repaid: 0, payments: [], created_at: at, updated_at: at }, ...data.items]); },
        op: d ? { method: 'PATCH', path: `/api/owed/${d.id}`, body } : { method: 'POST', path: '/api/owed', body },
        done: d ? 'Debt saved' : body.direction === 'i_owe' ? `You owe ${body.person} ${money(body.amount)}` : `${body.person} owes you ${money(body.amount)}`,
      });
      if (ok) drafts.clear(key);
    });
  }

  // ----- a repayment, optionally linked to a bank deposit -----
  function openPayForm(d, linked = null) {
    const key = `owed:pay:${d.id}`;
    const mine = !owesYou(d);
    const panel = openModal(`${sheetHead(`${d.person}${d.note ? `, ${moneyText(d.note)}` : ''}`, mine ? 'Add a payment' : 'Add a repayment')}
      <form class="form" novalidate>
        <div class="field"><label for="opp">Amount</label><div class="money-in"><span>$</span><input id="opp" name="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" autofocus></div>
          <div class="chips wrap"><button class="chip-btn" type="button" id="opall">All ${esc(money(d.outstanding))}</button></div></div>
        <div class="field"><label for="opdt">Date</label><input id="opdt" name="date" type="date" min="${esc(d.lent_on)}" max="${todayIso()}" value="${todayIso()}"></div>
        <div class="field"><label for="opnote">Note (optional)</label><input id="opnote" name="note" maxlength="200" autocomplete="off" placeholder="Cash, bank transfer"></div>
        <div class="field"><span class="lab">${mine ? 'Bank payment' : 'Bank deposit'} (optional)</span>${linked
    ? `<div class="owed-linked"><div class="main"><div class="t1">${esc(linked.merchant ?? linked.description)}</div><div class="t2">${esc(dmy(linked.date))}, ${esc(acctText(linked.account_name))}, ${esc(money(Math.abs(linked.amount)))}</div></div><button class="x sm" type="button" id="oplinkx" aria-label="Unlink the bank deposit" title="Unlink">${I.x}</button></div>`
    : `<button class="btn ghost" type="button" id="oplink">${I.bank}Link to a bank ${mine ? 'payment' : 'deposit'}</button><div class="sub">${mine ? 'Pick the payment this went out as.' : 'Pick the deposit this repayment arrived as.'} Nothing about the transaction changes.</div>`}</div>
        <button class="btn wide" type="submit">${I.check}${mine ? 'Add payment' : 'Add repayment'}</button>
      </form>`);
    const form = $('form', panel);
    bindDraft(form, key);
    const amt = $('#opp', form);
    const date = $('#opdt', form);
    const room = linked ? Math.min(d.outstanding, linked.available) : 0;
    if (linked && !(parseMoney(amt.value) > 0 && parseMoney(amt.value) <= room)) {
      amt.value = centsToInput(room);
      date.value = linked.date < d.lent_on ? d.lent_on : linked.date > todayIso() ? todayIso() : linked.date;
      form.dispatchEvent(new Event('input'));
    }
    const check = () => {
      const c = parseMoney(amt.value);
      let ok = fieldError(amt, !amt.value.trim() ? 'Enter an amount' : Number.isNaN(c) || c <= 0 ? 'An amount like 20 or 20.50' : c > d.outstanding ? `Only ${money(d.outstanding)} left to repay` : linked && c > linked.available ? `Only ${money(linked.available)} of that deposit is left to link` : '');
      ok = fieldError(date, !date.value ? 'Pick the day' : date.value > todayIso() ? 'It cannot be in the future' : date.value < d.lent_on ? `Not before it was lent (${dmy(d.lent_on)})` : '') && ok;
      return ok;
    };
    form.addEventListener('input', check);
    $('#opall', form).addEventListener('click', () => { amt.value = centsToInput(d.outstanding); amt.dispatchEvent(new Event('input', { bubbles: true })); buzz(6); });
    $('#oplink', form)?.addEventListener('click', () => openDepositPicker(d));
    $('#oplinkx', form)?.addEventListener('click', () => openPayForm(d, null));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!check()) return;
      formError(form, null);
      const body = { amount: parseMoney(amt.value), date: date.value, note: $('#opnote', form).value.trim() || null, ...(linked ? { transaction_id: linked.id } : {}) };
      const ok = await send(form, $('button[type=submit]', form), 'Adding', {
        apply: () => patchItem(d.id, (x) => owedWithPayment(x, { id: -Date.now(), owed_id: d.id, date: body.date, amount: body.amount, note: body.note, transaction_id: body.transaction_id ?? null })),
        op: { method: 'POST', path: `/api/owed/${d.id}/payments`, body },
        done: mine ? (body.amount >= d.outstanding ? `${d.person} is paid up` : `${money(body.amount)} paid to ${d.person}`) : body.amount >= d.outstanding ? `${d.person} is paid up` : `${money(body.amount)} paid back`,
      });
      if (ok) drafts.clear(key);
    });
  }

  // Recent money in, searchable, to link a repayment to. Offline it says so and the repayment can still be saved without a link.
  function openDepositPicker(d) {
    const mine = !owesYou(d);
    const panel = openModal(`${sheetHead(mine ? 'Link a payment' : 'Link a repayment', mine ? 'Pick the bank payment' : 'Pick the bank deposit')}
      <div class="field"><input id="oppq" type="search" placeholder="${mine ? 'Search money out, like the payee' : "Search money in, like the payer's name"}" aria-label="${mine ? 'Search payments' : 'Search deposits'}" autocomplete="off"></div>
      <div id="oppl">${skeletonRows(4)}</div>
      <button class="btn ghost wide mt10" type="button" id="oppback">Back without linking</button>`);
    const list = $('#oppl', panel);
    const back = (tx = null) => openPayForm(d, tx);
    let seq = 0;
    const draw = (res) => {
      const rows = res.items.map((t) => ({ ...t, available: Math.abs(t.amount) - usedOf(t.id) }));
      list.innerHTML = rows.length
        ? `<div class="rows">${rows.map((t) => `<button class="row" type="button" data-tx="${esc(t.id)}" ${t.available <= 0 ? 'disabled' : ''}><div class="main"><div class="t1">${esc(t.merchant ?? t.description)}</div><div class="t2">${esc(dmy(t.date))}, ${esc(acctText(t.account_name))}${t.available <= 0 ? ', already linked' : t.available < Math.abs(t.amount) ? `, ${esc(money(t.available))} left to link` : ''}</div></div><div class="amt num ${mine ? '' : 'pos'}">${esc(money(Math.abs(t.amount)))}</div></button>`).join('')}</div>`
        : emptyState({ icon: I.search, title: mine ? 'No payments found' : 'No deposits found', line: `Only money going ${mine ? 'out' : 'in'} shows here. Try a different search.` });
      list.onclick = (e) => { const b = e.target.closest('[data-tx]'); if (b) { buzz(8); back(rows.find((t) => t.id === b.dataset.tx)); } };
    };
    const load2 = (q) => {
      const n = ++seq;
      list.innerHTML = skeletonRows(4);
      const url = `/api/transactions?direction=${mine ? 'out' : 'in'}&limit=40${q ? `&q=${encodeURIComponent(q)}` : ''}`;
      (q ? api(url) : swr(url, (r) => { if (n === seq) draw(r); })).then((r) => { if (n === seq) draw(r); }).catch((e) => {
        if (n !== seq) return;
        list.innerHTML = errorCard(e, 'oppretry', mine ? 'payments' : 'deposits');
        $('#oppretry', list)?.addEventListener('click', () => load2(q));
      });
    };
    let timer = 0;
    $('#oppq', panel).addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => load2(e.target.value.trim()), 250); });
    $('#oppback', panel).addEventListener('click', () => back(null));
    load2('');
  }

  // ----- actions on a debt -----
  function setClosed(d, closed, label) {
    const was = data;
    undoable({
      label,
      apply: () => { patchItem(d.id, (x) => ({ ...x, closed })); paint(); },
      revert: () => { data = was; cacheIt(); paint(); },
      op: { method: 'PATCH', path: `/api/owed/${d.id}`, body: { closed } },
    });
  }
  function removeDebt(d) {
    const was = data;
    undoable({
      label: `${d.person}'s ${money(d.amount)} deleted`,
      apply: () => { setItems(data.items.filter((x) => x.id !== d.id)); paint(); },
      revert: () => { data = was; cacheIt(); paint(); },
      op: { method: 'DELETE', path: `/api/owed/${d.id}` },
    });
  }
  function removePayment(d, p) {
    const was = data;
    undoable({
      label: `${money(p.amount)} repayment removed`,
      apply: () => { patchItem(d.id, (x) => ({ ...x, repaid: x.repaid - p.amount, payments: x.payments.filter((y) => y.id !== p.id) })); paint(); },
      revert: () => { data = was; cacheIt(); paint(); },
      op: { method: 'DELETE', path: `/api/owed/${d.id}/payments/${p.id}` },
    });
  }
  function openMenu(d) {
    const panel = openModal(`${sheetHead(d.person, moneyText(d.note) || 'This debt')}
      <div class="sheet-actions" id="owedmenu">
        <button class="btn ghost wide" type="button" data-m="edit">${I.edit}Edit details</button>
        ${d.status === 'open' ? `<button class="btn ghost wide" type="button" data-m="settle">${I.check}Mark as settled</button><button class="btn ghost wide" type="button" data-m="writeoff">${I.flag}Write off ${esc(money(d.outstanding))}</button>` : `<button class="btn ghost wide" type="button" data-m="reopen">${I.refresh}Reopen</button>`}
        <button class="btn danger wide" type="button" data-m="delete">${I.trash}Delete debt</button>
      </div>`);
    $('#owedmenu', panel).addEventListener('click', (e) => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      closeModal();
      if (m === 'edit') openDebtForm(d);
      else if (m === 'settle') setClosed(d, 'settled', `${d.person}'s ${money(d.outstanding)} marked settled`);
      else if (m === 'writeoff') setClosed(d, 'written_off', `${money(d.outstanding)} written off`);
      else if (m === 'reopen') setClosed(d, null, 'Debt reopened');
      else if (m === 'delete') removeDebt(d);
    });
  }

  function wireSheet(body) {
    body.addEventListener('click', (e) => {
      const t = e.target;
      const pay = t.closest('[data-pay]');
      const menu = t.closest('[data-menu]');
      const act = t.closest('[data-act]');
      const del = t.closest('[data-delpay]');
      if (pay) return openPayForm(find(Number(pay.dataset.pay)));
      if (menu) return openMenu(find(Number(menu.dataset.menu)));
      if (act) { const [a, id] = act.dataset.act.split(':'); if (a === 'reopen') setClosed(find(Number(id)), null, 'Debt reopened'); return undefined; }
      if (del) { const [id, pid] = del.dataset.delpay.split(':').map(Number); const d = find(id); return removePayment(d, d.payments.find((p) => p.id === pid)); }
      if (t.closest('[data-adddebt]')) return openDebtForm(null, { person: data.people.find((p) => p.key === openKey)?.name ?? '' });
      return undefined;
    });
  }

  // ----- loading -----
  const load = () => swr('/api/owed', (d) => { if (!live()) return; data = d; paint(); }).catch((e) => {
    if (!live()) return;
    el.innerHTML = errorCard(e, 'owedretry', 'the ledger');
    $('#owedretry', el)?.addEventListener('click', () => { el.innerHTML = `${skeletonCard(150)}<div class="mt10">${skeletonRows(3)}</div>`; load(); });
  });

  wireCollapsibles(el);
  el.addEventListener('click', (e) => {
    if (!data) return;
    if (e.target.closest('#owedadd')) return openDebtForm(null);
    const row = e.target.closest('[data-person]');
    if (row) { buzz(6); return openPerson(row.dataset.person); }
    return undefined;
  });
  if (!store.get('c:/api/owed')) el.innerHTML = `${skeletonCard(150)}<div class="mt10">${skeletonRows(3)}</div>`;
  await load();
  // Home's "Ledger" tile lands here with the add form already open.
  if (live() && data && new URLSearchParams(location.search).get('add')) {
    history.replaceState({}, '', '/owed');
    openDebtForm(null);
  }
}
