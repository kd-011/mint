// One account's page (/account?id=): a header with the balance and a status line, the places to go from it
// (this account's Transactions, Rules and Config), the key facts Mint holds, and its latest transactions.
// Home's account rows open it. It reads only what Mint already stores (accountsData from /api/accounts, the
// rules and the transactions already served); what Mint does not hold is said plainly, never guessed.
// Each block loads and fails on its own. The pure parts (facts, status, gaps, hrefs) are in ux-model.js.
'use strict';

const ACCOUNT_FACT_FMT = {
  money: (v) => money(v),
  pct: (v) => pct(v),
  date: (v) => dmy(v),
  ago: (v) => ago(v),
  acct: (v) => acctText(v),
  native: (v) => `${moneyIn(v.cents, v.currency)}${v.date ? ` on ${dmy(v.date)}` : ''}`,
  offset: (v) => `${acctText(v.name)}: ${money(v.cents)}`,
  text: (v) => v,
};

function accountOffset(a) {
  if (a.type !== 'loan' || !a.loan?.offset_account_enabled) return null;
  const o = shownAccounts().find((x) => x.connection_id === a.connection_id && x.type !== 'loan' && /offset/i.test(x.name));
  return o ? { name: accountName(o), balance_current: o.balance_current } : null;
}

function accountHeadHtml(real) {
  const a = shownAccount(real);
  const st = UxModel.accountStatus(a, { ago });
  const foreignAcct = a.manual && a.currency && a.currency !== 'AUD' && typeof foreign === 'function' && foreign(a);
  const big = foreignAcct ? moneyIn(a.balance_native, a.currency) : money(a.balance_current);
  const icon = TYPE_ICON[a.type] ?? I.wallet;
  const inst = a.manual && (a.institution === 'Manual' || a.institution === a.name) ? 'Kept by hand' : UxModel.bankName(a.institution);
  return `<section class="card acct-head" aria-labelledby="ah-name">
    <div class="ah-top">${logoTile({ name: a.institution || a.name, logo: a.logo, icon, bank: true })}
      <div class="ah-t"><div class="sub">${esc(inst ?? '')}</div><h1 class="ah-name" id="ah-name">${esc(accountName(a))}</h1></div></div>
    <div class="ah-bal num ${a.balance_current < 0 ? 'neg-red' : ''}">${esc(big)}</div>
    ${foreignAcct && typeof audLine === 'function' ? `<div class="sub num">${esc(audLine(a))}</div>` : ''}
    <div class="ah-chips"><span class="chip">${esc(UxModel.accountTypeWord(a.type))}</span>${a.number_masked ? `<span class="chip num">${esc(acctText(a.number_masked))}</span>` : ''}<span class="chip ${a.is_business ? 'warn' : ''}">${a.is_business ? 'Business' : 'Personal'}</span>${a.hidden ? '<span class="chip warn" title="Hidden from Home and net worth">Hidden</span>' : ''}</div>
    <div class="ah-status ${st.tone}" role="status">${st.tone === 'ok' ? I.check : st.tone === 'bad' ? I.alert : I.clock}<span><b>${esc(st.text)}</b>${st.detail ? `<small>${esc(st.detail)}</small>` : ''}</span></div>
  </section>`;
}

function accountFactsHtml(real) {
  const a = shownAccount(real);
  const facts = UxModel.accountFacts(a, { offset: accountOffset(a) });
  return `<h2>Key facts</h2><section class="card acct-facts">
    <dl class="kv">${facts.map(([k, { t, v }]) => `<dt>${esc(k)}</dt><dd>${esc((ACCOUNT_FACT_FMT[t] ?? ACCOUNT_FACT_FMT.text)(v))}</dd>`).join('')}</dl>
    <p class="sub gapnote">${esc(UxModel.gapLine(UxModel.accountGaps(a)))}</p></section>`;
}

// Transactions, Rules and Config for this one account. rules is { status, data, err } from the rules read.
function accountGoHtml(a, rules) {
  const tx = a.tx_count == null ? 'Everything on this account' : a.tx_count ? `${plural(a.tx_count, 'transaction')}${a.pending_count ? `, ${a.pending_count} pending` : ''}` : 'None yet';
  const rl = rules.status === 'ok' ? esc(UxModel.rulesLine(UxModel.accountRules(rules.data, a.id)))
    : rules.status === 'error' ? '<span class="err-line">Couldn\'t count the rules</span>'
      : '<span class="sk sk-s ap-sk" aria-label="Counting rules"></span>';
  const cfg = a.manual ? 'Edit details, set the balance, import, archive' : [a.nickname ? `Nickname ${a.nickname}` : 'No nickname', a.is_business ? 'Business' : 'Personal'].join(' · ');
  return `<h2>Go to</h2><div class="rows">
    <a class="row" href="${esc(UxModel.accountTransactionsHref(a.id))}" data-nav><div class="ic">${I.list}</div><div class="main"><div class="t1">Transactions</div><div class="t2">${esc(tx)}</div></div>${I.chevron}</a>
    <a class="row" href="${esc(UxModel.accountRulesHref(a.id))}" data-nav><div class="ic">${I.rules}</div><div class="main"><div class="t1">Rules</div><div class="t2 wrap">${rl}</div></div>${I.chevron}</a>
    <button class="row" type="button" data-config><div class="ic">${I.sliders}</div><div class="main"><div class="t1">Config</div><div class="t2">${esc(acctText(cfg))}</div></div>${I.chevron}</button>
  </div>${rules.status === 'error' ? `<div class="error mt10"><div class="h">Couldn't load the rules</div><div class="d">${esc(rules.err?.detail ?? rules.err?.message ?? rules.err)}</div><button class="btn ghost" type="button" id="aprulesretry">${I.refresh}Retry</button></div>` : ''}`;
}

function accountRecentHtml(a, recent) {
  const more = `<a class="row" href="${esc(UxModel.accountTransactionsHref(a.id))}" data-nav><div class="ic">${I.list}</div><div class="main"><div class="t1">All transactions</div></div>${I.chevron}</a>`;
  if (recent.status === 'loading') return `<h2>Latest transactions</h2>${skeletonRows(3)}`;
  if (recent.status === 'error') return `<h2>Latest transactions</h2>${errorCard(recent.err, 'aprecentretry', 'the latest transactions')}`;
  if (!recent.data.length) {
    return `<h2>Latest transactions</h2><section class="card">${emptyState({
      icon: I.list, title: 'No transactions yet',
      line: a.manual ? 'Add one by hand or import a statement from the Transactions screen.' : 'Nothing has been pulled for this account yet. A sync brings its history in.',
      action: { href: UxModel.accountTransactionsHref(a.id), label: 'Open transactions' },
    })}</section>`;
  }
  return `<h2>Latest transactions</h2><div class="rows" role="list">${recent.data.map((t) => txRowButton(t, { showAccount: false })).join('')}${more}</div>`;
}

async function viewAccount(el, token) {
  const id = new URLSearchParams(location.search).get('id') ?? '';
  let fresh = false; // a read made on this visit has answered, so a missing id really is missing
  const rules = { status: 'loading', data: null, err: null };
  const recent = { status: 'loading', data: null, err: null };
  el.innerHTML = '<div id="ap-head"></div><div id="ap-go"></div><div id="ap-facts"></div><div id="ap-recent"></div>';
  const slot = (n) => $(`#ap-${n}`, el);
  wireLogoTiles(el);

  const skeletons = () => {
    slot('head').innerHTML = skeletonCard(190);
    slot('go').innerHTML = `<h2>Go to</h2>${skeletonRows(3)}`;
    slot('facts').innerHTML = `<h2>Key facts</h2>${skeletonCard(260)}`;
    applyDims(el);
  };
  const missing = () => {
    el.innerHTML = `<div class="card">${emptyState({ icon: I.bank, title: 'No account here', line: 'This account is not in Mint. It may have been archived, or the link is old.', action: { href: '/accounts', label: 'Open accounts' } })}</div>`;
  };
  const paintRecent = () => { if (token === renderToken && slot('recent') && acctById(id)) slot('recent').innerHTML = accountRecentHtml(acctById(id), recent); };
  const paintTop = () => {
    if (token !== renderToken) return;
    const a = acctById(id);
    if (!a) return fresh ? missing() : undefined;
    document.title = `${accountName(a)} · Mint`;
    if (!slot('head')) return;
    slot('head').innerHTML = accountHeadHtml(a);
    slot('go').innerHTML = accountGoHtml(a, rules);
    slot('facts').innerHTML = accountFactsHtml(a);
    wireLogoTiles(slot('head'));
    applyDims(el);
  };
  const paintAll = () => { paintTop(); paintRecent(); };

  const loadRules = () => {
    rules.status = 'loading';
    paintTop();
    return swr('/api/rules', (d) => { rules.status = 'ok'; rules.data = d.items; paintTop(); }).catch((e) => { rules.status = 'error'; rules.err = e; paintTop(); });
  };
  const loadRecent = () => {
    recent.status = 'loading';
    paintRecent();
    return swr(`/api/transactions?account=${encodeURIComponent(id)}&limit=5`, (d) => { recent.status = 'ok'; recent.data = d.items; paintRecent(); }).catch((e) => { recent.status = 'error'; recent.err = e; paintRecent(); });
  };

  skeletons();
  slot('recent').innerHTML = `<h2>Latest transactions</h2>${skeletonRows(3)}`;
  paintAll(); // the saved accounts, when this one is among them
  stagger(el);

  el.addEventListener('click', (e) => {
    const a = acctById(id);
    if (!a) return;
    if (e.target.closest('[data-config]')) return a.manual ? openManualAccount(id) : openAccountConfig(a);
    if (e.target.closest('#aprulesretry')) return loadRules();
    if (e.target.closest('#aprecentretry')) return loadRecent();
    const row = e.target.closest('[data-tx]');
    if (row) openTxById(row.dataset.tx);
  });
  const onAccounts = () => { if (token === renderToken) paintTop(); };
  accountsListeners.add(onAccounts);
  cleanup.push(() => accountsListeners.delete(onAccounts));

  loadRules();
  loadRecent();
  try { await refreshAccounts(!!acctById(id)); } catch (e) {
    if (token !== renderToken) return;
    el.innerHTML = errorCard(e, 'apretry', 'this account');
    $('#apretry', el)?.addEventListener('click', () => render());
    return;
  }
  if (token !== renderToken) return;
  fresh = true;
  if (!acctById(id)) return missing();
  paintAll();
}

// ---------- config: the account's own settings ----------

// Nickname, personal or business, and whether it counts as spendable cash. These are the owner's settings on the
// account (PATCH /api/accounts/:id); nothing here touches the bank connection or a balance.
function openAccountConfig(a) {
  const spendOf = (x) => (x.spendable == null ? 'auto' : x.spendable ? 'yes' : 'no');
  const canSpend = a.type !== 'credit-card' && a.type !== 'loan';
  // Type: Auto follows the bank (feed_type), the rest pin it. A manual account's type is edited with the account itself.
  const canType = !a.manual;
  const typeOf = (x) => x.type_override ?? 'auto';
  const TYPE_NAMES = { transaction: 'Everyday', savings: 'Savings', 'credit-card': 'Card', loan: 'Loan' };
  const feedName = (a.feed_type ?? a.type) ? (TYPE_NAMES[a.feed_type ?? a.type] ?? (a.feed_type ?? a.type)) : 'unknown';
  const panel = openSheet(`${sheetHead(a.institution, `Config: ${accountName(a)}`)}
    <form class="form" novalidate>
      <div class="field"><label for="acn">Nickname</label><input id="acn" name="nickname" maxlength="60" autocomplete="off" placeholder="${esc(a.name)}" value="${esc(a.nickname ?? '')}"><div class="sub">Shown instead of the bank's name for this account, everywhere in Mint.</div></div>
      <div class="field"><label>Counts as</label>${segmented('abiz', [['personal', 'Personal'], ['biz', 'Business']], a.is_business ? 'biz' : 'personal')}<div class="sub">Personal or business, the same flag as on the Accounts screen.</div></div>
      ${canType ? `<div class="field"><label>Type</label>${segmented('atype', [['auto', 'Auto'], ['transaction', 'Everyday'], ['savings', 'Savings'], ['credit-card', 'Card'], ['loan', 'Loan']], typeOf(a))}<div class="sub">Auto uses what the bank reports (${esc(feedName)}). Set it when the bank has it wrong: it decides the Home group, savings, income and transfers.</div></div>` : ''}
      ${canSpend ? `<div class="field"><label>Safe to spend cash</label>${segmented('aspend', [['auto', 'Auto'], ['yes', 'Counts'], ['no', 'Does not count']], spendOf(a))}<div class="sub">Auto lets Mint decide from the account type and name.</div></div>` : ''}
      <div class="sub" id="acwhy" aria-live="polite">Change something to save.</div>
      <button class="btn wide" type="submit" disabled>${I.check}Save</button>
    </form>
    <p><a class="btn ghost wide" href="/accounts" data-nav>${I.bank}Accounts and sync</a></p>`, 'acctconfig');
  const form = $('form', panel);
  const nick = $('#acn', form);
  const biz = wireSeg(form, 'abiz', () => sync());
  const kind = canType ? wireSeg(form, 'atype', () => sync()) : () => typeOf(a);
  const spend = canSpend ? wireSeg(form, 'aspend', () => sync()) : () => spendOf(a);
  const submit = $('button[type=submit]', form);
  const changes = () => {
    const body = {};
    const n = nick.value.trim();
    if (n !== (a.nickname ?? '')) body.nickname = n || null;
    if ((biz() === 'biz') !== !!a.is_business) body.is_business = biz() === 'biz';
    if (canType && kind() !== typeOf(a)) body.type_override = kind() === 'auto' ? null : kind();
    if (canSpend && spend() !== spendOf(a)) body.spendable = spend() === 'auto' ? null : spend() === 'yes';
    return body;
  };
  function sync() {
    const long = nick.value.trim().length > 60;
    fieldError(nick, long ? 'Keep it to 60 characters' : '');
    const n = Object.keys(changes()).length;
    submit.disabled = !n || long;
    $('#acwhy', form).textContent = long ? 'Shorten the nickname to save.' : n ? 'Ready to save.' : 'Change something to save.';
  }
  nick.addEventListener('input', sync);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = changes();
    if (!Object.keys(body).length) return;
    formError(form, null);
    const prev = { nickname: a.nickname, is_business: a.is_business, spendable: a.spendable, type: a.type, type_override: a.type_override };
    const apply = (v) => {
      if ('nickname' in v) a.nickname = v.nickname;
      if ('is_business' in v) a.is_business = v.is_business ? 1 : 0;
      if ('spendable' in v) a.spendable = v.spendable;
      if ('type_override' in v) a.type_override = v.type_override;
      if ('type' in v) a.type = v.type;
      else if ('type_override' in v) a.type = v.type_override ?? a.feed_type ?? a.type;
      store.set('accounts', accountsData);
      accountsListeners.forEach((f) => f());
    };
    apply(body);
    try {
      const r = await withBusy(submit, 'Saving', () => mutate({ method: 'PATCH', path: `/api/accounts/${encodeURIComponent(a.id)}`, body }));
      closeSheet();
      toast(r.queued ? 'Saved offline, syncs when you are back' : `${accountName(a)} saved`);
      buzz(12);
      refreshAccounts(true);
    } catch (err) {
      apply(prev);
      formError(form, err, 'Save');
    }
  });
}
