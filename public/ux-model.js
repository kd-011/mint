// The logic behind search, shortcuts, the Home sync strip and the cycle insights
// card, with no DOM in it. Plain script in the page and a CommonJS module in
// tests, like chat-model.js. One global, UxModel.
'use strict';

const UxModel = (() => {
  // the palette: screens and jump-to actions

  // href is a real route (a test resolves every one); words are extra things to type.
  const SCREENS = [
    { id: 'home', label: 'Home', hint: 'Safe to spend, this cycle, net worth', href: '/', icon: 'home', words: 'dashboard overview cockpit' },
    { id: 'transactions', label: 'Transactions', hint: 'Every charge, search and filters', href: '/transactions', icon: 'list', words: 'spending payments purchases' },
    { id: 'budgets', label: 'Budgets', hint: 'Targets for this pay cycle', href: '/budgets', icon: 'target', words: 'spending limits pace' },
    { id: 'save', label: 'Save and Invest', hint: 'Savings, super, shares, home loan', href: '/save', icon: 'piggy', words: 'savings investing shares super holdings' },
    { id: 'tax', label: 'Tax', hint: 'Deductions, receipts, estimate', href: '/tax', icon: 'receipt', words: 'ato deductions refund return' },
    { id: 'more', label: 'More', hint: 'Everything else', href: '/more', icon: 'dots', words: 'menu' },
    { id: 'accounts', label: 'Accounts and sync', hint: 'Banks, balances, consent', href: '/accounts', icon: 'bank', words: 'banks connections balances' },
    { id: 'income', label: 'Income', hint: 'Pay cycles, salary, regular payers', href: '/income', icon: 'income', words: 'salary pay payday wages' },
    { id: 'plan', label: 'Plan', hint: 'Pay split, goals, debt and bills', href: '/plan', icon: 'target', words: 'split money plan' },
    { id: 'goals', label: 'Goals', hint: 'What you are saving for', href: '/plan?s=goals', icon: 'flag', words: 'saving target' },
    { id: 'debt', label: 'Debt and home loan', hint: 'Payoff, offset, extra repayments', href: '/plan?s=debt', icon: 'house', words: 'mortgage loan offset card' },
    { id: 'bills', label: 'Bills', hint: 'What is due in the next six weeks', href: '/plan?s=bills', icon: 'calendar', words: 'upcoming due calendar' },
    { id: 'subs', label: 'Subscriptions', hint: 'Recurring charges and what they cost', href: '/plan?s=subs', icon: 'repeat', words: 'recurring netflix cancel' },
    { id: 'reports', label: 'Reports', hint: 'Spend, cash flow, net worth', href: '/reports', icon: 'chart', words: 'charts monthly trends' },
    { id: 'assets', label: 'Assets', hint: 'Shares, super and other things you own', href: '/accounts?s=assets', icon: 'piggy', words: 'net worth manual' },
    { id: 'rules', label: 'Rules', hint: 'How merchants get filed', href: '/accounts?s=rules', icon: 'rules', words: 'categorise merchants' },
    { id: 'review', label: 'Review', hint: 'Transfers and guesses to check', href: '/accounts?s=review', icon: 'check', words: 'transfers guesses uncategorised' },
  ];

  const ACTIONS = [
    { id: 'sync', label: 'Sync now', hint: 'Pull the latest from every bank', icon: 'refresh', words: 'refresh update pull banks' },
    { id: 'add-budget', label: 'Add budget', hint: 'Pick a category and a target per pay cycle', icon: 'plus', words: 'new budget target limit' },
    { id: 'add-sub', label: 'Add subscription', hint: 'Something you pay for on a schedule', icon: 'plus', words: 'new subscription recurring' },
    { id: 'shortcuts', label: 'Keyboard shortcuts', hint: 'Desktop only', icon: 'keyboard', words: 'keys help hotkeys', desktopOnly: true },
  ];

  const tokens = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9$.]+/).filter(Boolean);

  // 0 = no match. Every typed word must match; a label that starts with the query wins.
  function score(entry, q) {
    const want = tokens(q);
    if (!want.length) return 1;
    const label = entry.label.toLowerCase();
    const labelWords = tokens(entry.label);
    const extra = tokens(entry.words);
    let total = 0;
    for (const w of want) {
      let s = 0;
      if (label.startsWith(w)) s = 5;
      else if (labelWords.some((x) => x.startsWith(w))) s = 4;
      else if (extra.some((x) => x.startsWith(w))) s = 2;
      else if (label.includes(w)) s = 1;
      if (!s) return 0;
      total += s;
    }
    return total + (label === String(q).trim().toLowerCase() ? 5 : 0);
  }

  function rank(list, q, limit) {
    const scored = list.map((e, i) => ({ e, i, s: score(e, q) })).filter((x) => x.s > 0);
    scored.sort((a, b) => b.s - a.s || a.i - b.i);
    return scored.slice(0, limit).map((x) => x.e);
  }

  // What the palette shows without the server: actions and screens that match. A touch screen has no shortcuts to list.
  function matchStatic(q, { desktop = true, screens = 6, feed = true } = {}) {
    const actions = ACTIONS.filter((a) => (desktop || !a.desktopOnly) && (feed || a.id !== 'sync'));
    const empty = !tokens(q).length;
    return { actions: rank(actions, q, 6), screens: rank(SCREENS, q, empty ? screens : 6) };
  }

  // recent searches

  function pushRecent(list, q, max = 6) {
    const t = String(q ?? '').trim().replace(/\s+/g, ' ');
    if (t.length < 2 || t.length > 60) return list;
    return [t, ...list.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, max);
  }

  // saved views

  const FILTER_KEYS = ['q', 'account', 'category', 'from', 'to', 'business', 'tax', 'direction', 'source'];
  const clean = (f) => Object.fromEntries(FILTER_KEYS.filter((k) => f?.[k]).map((k) => [k, String(f[k])]));
  const hasFilters = (f) => Object.keys(clean(f)).length > 0;
  function sameFilters(a, b) {
    const x = clean(a);
    const y = clean(b);
    const kx = Object.keys(x);
    return kx.length === Object.keys(y).length && kx.every((k) => x[k] === y[k]);
  }

  // Transactions filter dropdowns

  // Categories for the Category dropdown: named sections in the order the list gives them, never one long list.
  // A search term keeps the categories whose name matches, or all of a section whose name matches. `open` says
  // which sections start expanded when the dropdown is narrow: the one holding the pick, or every one while searching.
  function categoryGroups(cats, { term = '', selected = null } = {}) {
    const t = String(term).trim().toLowerCase();
    const groups = new Map();
    for (const c of cats ?? []) {
      if (c.archived && c.id !== selected) continue;
      const name = c.grp || 'Other';
      if (t && !c.name.toLowerCase().includes(t) && !name.toLowerCase().includes(t)) continue;
      (groups.get(name) ?? groups.set(name, []).get(name)).push({ id: c.id, name: c.name, kind: c.kind });
    }
    return [...groups].map(([name, items]) => ({ name, items, open: !!t || items.some((c) => c.id === selected) }));
  }

  // Accounts for the Account dropdown, by what they are. Hidden and merged-away ones only show while picked.
  const ACCOUNT_KINDS = [['cash', 'Cash'], ['card', 'Cards'], ['loan', 'Loans']];
  function accountGroups(accounts, { selected = null, name = (a) => a.nickname || a.name } = {}) {
    const by = { cash: [], card: [], loan: [] };
    for (const a of accounts ?? []) {
      if ((a.hidden || a.status === 'gone' || a.merged_into) && a.id !== selected) continue;
      by[a.type === 'credit-card' ? 'card' : a.type === 'loan' ? 'loan' : 'cash'].push({ id: a.id, name: name(a), sub: [a.manual && (a.institution === a.name || a.institution === 'Manual') ? '' : bankName(a.institution), a.number_masked].filter(Boolean).join(' · ') });
    }
    return ACCOUNT_KINDS.filter(([k]) => by[k].length).map(([k, title]) => ({ name: title, items: by[k] }));
  }

  // keyboard

  const GO = { h: 'home', s: 'spending', v: 'save', t: 'tax', m: 'more' };
  const CHORD_MS = 1500;

  // One key press in, what to do out. `typing` is true in an input, textarea, select or editable.
  // state is { pending, at } between presses. Returns { state, action, prevent }.
  function keyAction(state, ev, now) {
    const idle = { pending: null, at: 0 };
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key;
    if (mod && !ev.altKey && key.toLowerCase() === 'k') return { state: idle, action: { type: 'palette' }, prevent: true };
    if (ev.typing || mod || ev.altKey) return { state: idle, action: null, prevent: false };
    const pending = state?.pending && now - state.at <= CHORD_MS ? state.pending : null;
    if (pending === 'g') {
      const tab = GO[key.toLowerCase()];
      if (tab && !ev.shiftKey) return { state: idle, action: { type: 'go', tab }, prevent: true };
      if (key !== 'g') return { state: idle, action: null, prevent: false };
    }
    if (key === 'g' && !ev.shiftKey) return { state: { pending: 'g', at: now }, action: { type: 'chord', pending: 'g' }, prevent: true };
    if (key === '/') return { state: idle, action: { type: 'palette' }, prevent: true };
    if (key === '?') return { state: idle, action: { type: 'help' }, prevent: true };
    if (!ev.shiftKey && key === 'j') return { state: idle, action: { type: 'move', delta: 1 }, prevent: true };
    if (!ev.shiftKey && key === 'k') return { state: idle, action: { type: 'move', delta: -1 }, prevent: true };
    if (!ev.shiftKey && key === 'e') return { state: idle, action: { type: 'edit' }, prevent: true };
    return { state: idle, action: null, prevent: false };
  }

  // The row j or k lands on: the first row when nothing is focused, otherwise one step, held at the ends.
  const nextIndex = (i, delta, n) => (n <= 0 ? -1 : i < 0 ? 0 : Math.max(0, Math.min(n - 1, i + delta)));

  const SHORTCUTS = [
    ['Search and jump', [['/', 'Open search'], ['Ctrl+K', 'Open search from anywhere, Cmd+K on a Mac']]],
    ['Go to', [['g h', 'Home'], ['g s', 'Spending'], ['g v', 'Save and Invest'], ['g t', 'Tax'], ['g m', 'More']]],
    ['Transactions list', [['j', 'Next transaction'], ['k', 'Previous transaction'], ['e', 'Edit the highlighted one']]],
    ['Anywhere', [['?', 'This list'], ['Esc', 'Close a sheet or search']]],
  ];

  // the Home sync strip

  const SYNC_PHASES = ['Connecting to your banks', 'Reading balances', 'Pulling transactions', 'Categorising'];

  // The ingest state as stepped progress: four named steps, which are done, the one running, and a bar.
  // Null when no sync is running.
  function syncSteps(s) {
    if (!s?.running) return null;
    const label = String(s.label ?? '');
    const now = /^categoris/i.test(label) ? 3 : /^(fetching|backfilling)/i.test(label) ? 2 : /^reading/i.test(label) ? 1 : 0;
    const accounts = /\((\d+) of (\d+)\)/.exec(label);
    let frac = [0.04, 0.16, 0.2, 0.94][now];
    if (now === 2 && accounts) frac = 0.2 + 0.7 * ((Number(accounts[1]) - 1) / Math.max(1, Number(accounts[2])));
    return {
      now,
      pct: Math.round(frac * 100),
      text: now === 2 && accounts ? `${SYNC_PHASES[2]}, account ${accounts[1]} of ${accounts[2]}` : SYNC_PHASES[now],
      phases: SYNC_PHASES.map((name, i) => ({ name, state: i < now ? 'done' : i === now ? 'now' : 'todo' })),
    };
  }

  // Pull to refresh: the finger moves dy, the indicator moves less, and past the mark a release syncs.
  const PULL_MARK = 64;
  const pull = (dy) => {
    const shown = Math.max(0, Math.min(110, dy * 0.5));
    return { shown, ready: shown >= PULL_MARK, pct: Math.min(100, Math.round((shown / PULL_MARK) * 100)) };
  };

  // the cycle insights card

  const changeWord = (m) => (m.before === 0 ? 'new this cycle' : m.percent == null ? '' : `${m.percent > 0 ? '+' : ''}${m.percent}%`);
  // "Up $250" / "Down $85", with the percent where there is one.
  function moverText(m, fmt) {
    const amount = fmt(Math.abs(m.change));
    const pct = m.percent == null ? '' : ` (${m.percent > 0 ? '+' : ''}${m.percent}%)`;
    return `${m.change > 0 ? 'Up' : 'Down'} ${amount}${pct}`;
  }
  // Tap through to the rows behind a mover or a new merchant, for the cycle so far.
  function moverHref(ins, m) {
    const p = new URLSearchParams({ category: m.category_id == null ? 'none' : String(m.category_id), direction: 'out', business: '0', from: ins.cycle.start, to: ins.cycle.to });
    return `/transactions?${p}`;
  }
  function merchantHref(ins, merchant) {
    const p = new URLSearchParams({ q: merchant, direction: 'out', business: '0', from: ins.cycle.start, to: ins.cycle.to });
    return `/transactions?${p}`;
  }

  // Home quick actions, short labels, deep links

  // 1,049 -> "1k", 4,502 -> "4.5k": a count that has to fit a badge.
  function compactCount(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v < 1000) return String(v);
    const k = Math.floor(v / 100) / 10;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }

  // "now", "5m", "3h", "2d": the sync time where a whole phrase will not fit.
  function shortAgo(iso, now = Date.now()) {
    if (!iso) return 'never';
    const s = Math.max(0, (now - Date.parse(iso)) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }

  // A budget's own page: one tap from Home instead of Spending, Budgets, the row.
  const budgetHref = (categoryId, cycle = null) => `/budgets?cat=${encodeURIComponent(categoryId)}${cycle ? `&cycle=${encodeURIComponent(cycle)}` : ''}`;

  // The tiles under the Home hero: the jobs done most. href tiles navigate, act tiles are run by the page.
  // A bank feed is Redbark (a key is set on the server) or Wise. Without either there is nothing to sync, so nothing offers to.
  const hasFeed = (sync) => !sync || !!sync.redbark || !!sync.wise?.enabled;

  // What Home offers when there is not one account yet. Without a bank feed that is two choices: the paid CDR route, or an
  // account of your own and a CSV statement. With the key set the banks arrive on the first sync, so the one choice is to run it.
  const REDBARK_DOCS = 'https://github.com/kd-011/mint/blob/main/docs/redbark-setup.md';
  function firstRun({ redbark = false } = {}) {
    if (redbark) return { title: 'No accounts yet', choices: [{ id: 'sync', label: 'Sync now', act: 'sync' }] };
    return {
      title: 'Add your first account',
      choices: [
        { id: 'redbark', label: 'Connect banks with Redbark', line: 'A paid CDR service', href: REDBARK_DOCS, external: true, icon: 'bank' },
        { id: 'csv', label: 'Add an account and import a CSV', href: '/accounts?add=1', icon: 'file' },
      ],
    };
  }

  function homeActions({ uncategorised = 0, online = true, syncRunning = false, feed = true } = {}) {
    const fix = { id: 'fix', label: 'Sort', icon: 'tag', href: uncategorised ? '/transactions?category=none' : '/transactions' };
    if (uncategorised > 0) fix.badge = compactCount(uncategorised);
    const sync = { id: 'sync', label: syncRunning ? 'Syncing' : 'Sync', icon: 'refresh', act: 'sync' };
    if (syncRunning) Object.assign(sync, { disabled: true, why: 'A sync is already running' });
    else if (!online) Object.assign(sync, { disabled: true, why: 'Offline: sync needs a connection' });
    return [
      fix,
      { id: 'budgets', label: 'Budgets', icon: 'target', href: '/budgets' },
      { id: 'owed', label: 'Ledger', icon: 'user', href: '/owed?add=1' },
      { id: 'ask', label: 'Ask', icon: 'chat', act: 'chat' },
      ...(feed ? [sync] : []),
    ];
  }

  // The saved views row sits under the filters. Empty, it only costs a line of the fold.
  const showViewsRow = ({ views = 0, loaded = true, canSave = false, error = false } = {}) => !error && (!loaded || views > 0 || canSave);

  // one-tap recategorising

  // The categories just used, newest first, so the next pick is a tap on a chip.
  function pushRecentCat(list, id, max = 8) {
    const base = Array.isArray(list) ? list : [];
    if (id == null) return base.slice(0, max);
    return [id, ...base.filter((x) => x !== id)].slice(0, max);
  }

  // What to offer on a transaction: how the same merchant is filed elsewhere (most common first), then recent picks.
  function suggestCategories({ merchant, current = null, items = [], recent = [], max = 4 } = {}) {
    if (!merchant && !recent?.length) return [];
    const counts = new Map();
    if (merchant) for (const t of items) if (t.merchant === merchant && t.category_id != null) counts.set(t.category_id, (counts.get(t.category_id) ?? 0) + 1);
    const byMerchant = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const out = [];
    for (const id of [...byMerchant, ...(recent ?? [])]) if (id != null && id !== current && !out.includes(id)) out.push(id);
    return out.slice(0, max);
  }

  // plain-English Home cards

  const plainPlural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
  const evenMark = (c) => (c.open ? Math.max(0, Math.min(100, Math.round((c.day / c.days) * 100))) : 100);

  // The pay-cycle card's summary: one sentence, then how that compares with spending evenly across the cycle.
  // below is cents under the even line (0 when level or over); status is the pace word the card colours by.
  function cycleSummary({ spent, target, cycle }, { money0 }) {
    const left = target - spent;
    const over = target > 0 && spent > target;
    const dl = cycle.days_left ?? Math.max(0, cycle.days - cycle.day);
    const tail = cycle.open ? (dl > 0 ? `, ${plainPlural(dl, 'day')} to go` : ', last day') : '';
    const line = `${money0(spent)} of ${money0(target)} spent, ${over ? `${money0(spent - target)} over budget` : `${money0(left)} left`}${tail}`;
    const mark = evenMark(cycle);
    const even = Math.round((target * mark) / 100);
    const diff = spent - even;
    const pct = target > 0 ? (spent / target) * 100 : 0;
    const status = !(target > 0) ? 'none' : over ? 'over' : pct > mark + 10 ? 'ahead' : pct < mark - 10 ? 'under' : 'on';
    let pace = '';
    if (cycle.open && !over && status !== 'none') pace = status === 'on' ? 'About an even daily spend' : diff < 0 ? `${money0(-diff)} less than an even daily spend` : `${money0(diff)} more than an even daily spend`;
    return { line, pace, status, below: status === 'under' ? -diff : 0, tone: over ? 'bad' : status === 'ahead' ? 'warn' : '' };
  }

  // The category rows under the pay-cycle card. Over budget rows (if any) are the list; otherwise the closest to budget.
  // Over rows share one track scaled to the worst of them: the budget mark sits at markAt, and the red overflow
  // runs overW more, so 225% and 141% no longer look the same. more counts only over budget rows left off the list. The even-pace tick means nothing past budget, so tick is false.
  function categoryRows(items, { money0, max = 4 }) {
    const ratio = (i) => (i.available > 0 ? i.spent / i.available : i.spent > 0 ? Infinity : 0);
    const sorted = [...items].sort((a, b) => ratio(b) - ratio(a));
    const overs = sorted.filter((i) => ratio(i) > 1);
    const shown = (overs.length ? overs : sorted).slice(0, max);
    const worst = Math.max(1.0001, ...shown.map(ratio).filter(Number.isFinite));
    const markAt = Math.round(100 / worst);
    const rows = shown.map((i) => {
      const r = ratio(i);
      const base = { category_id: i.category_id, name: i.name, spent: i.spent, available: i.available };
      if (r > 1) {
        const finite = Number.isFinite(r);
        const at = finite ? markAt : 0;
        return { ...base, over: true, tick: false, label: `${money0(i.spent - i.available)} over`, markAt: at, overW: finite ? Math.min(100 - at, Math.round(((r - 1) / worst) * 100)) : 100 };
      }
      return { ...base, over: false, tick: true, label: `${money0(i.spent)} of ${money0(i.available)}`, fillPct: Math.min(100, Math.round(r * 100)) };
    });
    return { heading: overs.length ? 'Over budget' : 'Closest to budget', rows, more: Math.max(0, overs.length - shown.length), overCount: overs.length };
  }

  // The tiles under the Home net worth hero: the totals that make it up, each a link to where they are kept.
  // groups is /api/networth groups; zero ones are left out. Property, a car and every other manual asset count in
  // investments, so there is no Other assets tile (groups.other_assets stays 0 for readers of the old shape).
  const BALANCE_TILES = [['cash', 'Cash', '/accounts'], ['cards', 'Cards', '/accounts'], ['loans', 'Loans', '/plan?s=debt'], ['investments', 'Investments', '/save'], ['other_liabilities', 'Debts', '/accounts?s=assets']];
  const balanceTiles = (groups = {}) => BALANCE_TILES.filter(([id]) => groups[id]).map(([id, label, href]) => ({ id, label, value: groups[id], href }));

  // The account list under the Home net worth hero: every visible bank account, then the manual assets and
  // the share portfolio, grouped Cash, Cards, Loans, Investments. Property is an investment, and so is a car or any
  // other manual asset the owner tracks, so there is no Other section; a manual debt gets a small Debts section, only
  // when one exists. Hidden and gone accounts are left out, as are manual assets net worth does not count.
  // { accounts, manual, holdings } are the /api/accounts accounts, the /api/networth manual list and its holdings;
  // fmt.name is how an account is named (nickname, demo masking). Within a section rows follow their `sort` (the
  // order the owner set, PUT /api/home/order); rows with equal sort keep accounts, assets, portfolio order.
  const ACCOUNT_SECTIONS = [['cash', 'Cash'], ['cards', 'Cards'], ['loans', 'Loans'], ['investments', 'Investments'], ['debts', 'Debts']];
  const ASSET_WORD = { shares: 'Shares', super: 'Super', property: 'Property', vehicle: 'Vehicle', cash: 'Cash', other: 'Other' };

  // Institutions arrive as the bank writes them ("NATIONAL AUSTRALIA BANK"); known banks show short. Display only:
  // the logo is keyed off the real institution.
  const BANK_NAMES = { 'national australia bank': 'NAB', nab: 'NAB', 'australia and new zealand banking group': 'ANZ', anz: 'ANZ', 'commonwealth bank of australia': 'CommBank', 'westpac banking corporation': 'Westpac' };
  const bankName = (inst) => (inst == null ? inst : BANK_NAMES[String(inst).trim().toLowerCase().replace(/\s+/g, ' ')] ?? inst);

  // The units under a share on Home: trailing zeros trimmed ("100.5 units"), "1 unit" for one.
  const unitsText = (n) => { const u = Number(n); return `${u.toLocaleString('en-AU', { maximumFractionDigits: 6 })} ${u === 1 ? 'unit' : 'units'}`; };
  const HOME_SHARES = 8;

  // opts.expandHoldings (Home, not edit order) adds the individual shares as 'holding' rows right under the
  // Share portfolio row: biggest value first, the HOME_SHARES largest, then a quiet '+N more'. A share with no
  // AUD value (no price and no cost, or no exchange rate) keeps balance null and noPrice, never a zero. Without
  // the option, or without holdings.list (an older cached /api/networth), the rows are exactly the old ones.
  function accountRows({ accounts = [], manual = [], holdings = null } = {}, fmt = {}, opts = {}) {
    const name = fmt.name ?? ((a) => a.nickname || a.name);
    const by = { cash: [], cards: [], loans: [], investments: [], debts: [] };
    for (const a of accounts) {
      if (a.hidden || a.status === 'gone') continue;
      by[a.type === 'credit-card' ? 'cards' : a.type === 'loan' ? 'loans' : 'cash'].push({
        id: a.id, kind: 'account', type: a.type, name: name(a), sub: [a.manual && (a.institution === a.name || a.institution === 'Manual') ? '' : bankName(a.institution), a.number_masked].filter(Boolean).join(' · '),
        institution: a.institution ?? null, balance: a.balance_current ?? null, href: accountHref(a.id), logo: a.logo ?? null, sort: a.sort ?? 0,
        // A manual account in another currency: balance stays AUD (it is what the totals add up), native beside it.
        ...(a.manual && a.currency && a.currency !== 'AUD' ? { currency: a.currency, native: a.balance_native ?? null } : {}),
      });
    }
    for (const m of manual) {
      if (m.counted === false || m.value == null) continue;
      by[m.is_liability ? 'debts' : 'investments'].push({
        id: `asset_${m.id}`, kind: 'asset', type: m.kind, name: m.name, sub: m.is_liability ? 'Debt' : ASSET_WORD[m.kind] ?? '',
        institution: null, balance: m.is_liability ? -m.value : m.value, href: '/accounts?s=assets', logo: null, sort: m.sort ?? 0,
      });
    }
    if (holdings?.count > 0) {
      by.investments.push({
        id: 'holdings', kind: 'holdings', type: 'shares', name: 'Share portfolio', sub: `${holdings.count} ${holdings.count === 1 ? 'holding' : 'holdings'}`,
        institution: null, balance: holdings.value ?? 0, href: '/save', logo: null, sort: holdings.sort ?? 0,
      });
    }
    for (const rows of Object.values(by)) rows.sort((x, y) => x.sort - y.sort); // stable, so ties keep their natural order
    if (opts.expandHoldings && Array.isArray(holdings?.list)) {
      const at = by.investments.findIndex((r) => r.id === 'holdings');
      if (at >= 0) {
        const worth = (x) => (x.value > 0 ? x.value : null);
        const sorted = [...holdings.list].sort((x, y) => (worth(y) ?? -1) - (worth(x) ?? -1) || String(x.ticker).localeCompare(String(y.ticker)));
        const rows = sorted.slice(0, HOME_SHARES).map((x) => ({
          id: `holding_${x.id}`, kind: 'holding', type: 'shares', name: x.ticker, sub: unitsText(x.units), institution: null,
          balance: worth(x), noPrice: worth(x) == null, href: '/save', logo: null, sort: 0,
        }));
        if (sorted.length > HOME_SHARES) rows.push({ id: 'holding_more', kind: 'holding-more', type: 'shares', name: `+${sorted.length - HOME_SHARES} more`, sub: '', institution: null, balance: null, href: '/save', logo: null, sort: 0 });
        by.investments.splice(at + 1, 0, ...rows);
      }
    }
    const sections = ACCOUNT_SECTIONS.filter(([id]) => by[id].length).map(([id, label]) => ({ id, label, rows: by[id] }));
    return { sections, count: sections.reduce((n, s) => n + s.rows.length, 0) };
  }

  // the account page (/account?id=)

  // Where an account row goes: its page, which opens that account's transactions, rules and config.
  const accountHref = (id) => `/account?id=${encodeURIComponent(id)}`;
  const accountTransactionsHref = (id) => `/transactions?account=${encodeURIComponent(id)}`;
  const accountRulesHref = (id) => `/accounts?s=rules&account=${encodeURIComponent(id)}`;

  const ACCOUNT_TYPE_WORD = { transaction: 'Transaction', 'credit-card': 'Credit card', loan: 'Loan', savings: 'Savings' };
  const wordy = (s) => String(s ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const accountTypeWord = (type) => ACCOUNT_TYPE_WORD[type] ?? wordy(type);

  // The short status line under the account name: one tone and one sentence. fmt.ago turns a timestamp into
  // "5 minutes ago". A failed sync keeps the bank's own error text, because that is what the owner debugs from.
  function accountStatus(a, fmt = {}) {
    const ago = fmt.ago ?? ((t) => String(t));
    const n = a.tx_count != null ? `${a.tx_count.toLocaleString('en-AU')} ${a.tx_count === 1 ? 'transaction' : 'transactions'}` : null;
    if (a.status === 'gone') return { tone: 'bad', text: 'No longer in the bank feed', detail: 'Its history stays; nothing new will arrive.' };
    if (a.last_sync_error) return { tone: 'bad', text: 'Last sync failed', detail: a.last_sync_error };
    if (a.manual) return { tone: 'ok', text: ['Kept by hand', n].filter(Boolean).join(' · '), detail: null };
    if (!a.last_synced_at) return { tone: 'warn', text: 'Not synced yet', detail: 'The first sync pulls the balance and history.' };
    return { tone: 'ok', text: [`Synced ${ago(a.last_synced_at)}`, n, a.pending_count ? `${a.pending_count} pending` : null].filter(Boolean).join(' · '), detail: null };
  }

  // The key-facts block, as [label, { t, v }] pairs where t is how the page formats v: money, cents (native
  // currency), pct, date, ago, acct (an identifier, masked in demo mode) or text. Only fields Mint holds;
  // anything it does not is reported by accountGaps and never guessed. offset is the loan's offset account.
  function accountFacts(a, { offset = null } = {}) {
    const f = [];
    const add = (k, t, v) => { if (v != null && v !== '') f.push([k, { t, v }]); };
    add('Institution', 'text', a.manual && a.institution === 'Manual' ? null : bankName(a.institution));
    add('Account name', 'text', a.name);
    if (a.nickname) add('Nickname', 'text', a.nickname);
    add('Type', 'text', accountTypeWord(a.type));
    add('Account number', 'acct', a.number_masked);
    add('Counts as', 'text', a.is_business ? 'Business' : 'Personal');
    if (a.manual) {
      add('Currency', 'text', a.currency);
      add('Opening balance', 'native', a.opening_balance != null ? { cents: a.opening_balance, currency: a.currency, date: a.opening_date } : null);
    }
    add('Balance', 'money', a.balance_current);
    if (a.manual && a.currency && a.currency !== 'AUD') add('Balance in ' + a.currency, 'native', a.balance_native != null ? { cents: a.balance_native, currency: a.currency } : null);
    add(a.type === 'credit-card' ? 'Available credit' : 'Available', 'money', a.balance_available);
    add('Balance read', 'ago', a.balance_observed_at);
    add('Product', 'text', a.rates?.product_name);
    const lending = a.rates?.lending_rate;
    const deposit = a.rates?.deposit_rate;
    add(lending != null ? 'Interest rate' : 'Deposit rate', 'pct', lending ?? deposit);
    if (a.loan) {
      add('Repayments', 'text', [wordy(a.loan.repayment_type), a.loan.repayment_frequency === 'P1M' ? 'monthly' : a.loan.repayment_frequency].filter((x) => x && x !== '').join(', '));
      add('Next instalment', 'date', a.loan.next_instalment_date);
      add('Loan ends', 'date', a.loan.loan_end_date);
      add('Original amount', 'money', a.loan.original_loan_amount ? Math.round(Number(a.loan.original_loan_amount) * 100) : null);
      if (offset) {
        add('Offset', 'offset', { name: offset.name, cents: offset.balance_current });
        add('Owed net of offset', 'money', (a.balance_current ?? 0) + (offset.balance_current ?? 0));
      }
    }
    add('History held from', 'date', a.earliest_date);
    add('Latest transaction', 'date', a.latest_date);
    if (!a.manual) add('Full backfill', 'text', a.backfill_done_at ? 'Done' : 'Not yet');
    add('Last synced', 'ago', a.manual ? null : a.last_synced_at);
    return f;
  }

  // What Mint does not hold for this account, so the page says so instead of leaving a blank. Mint stores one
  // masked number, no BSB, no credit limit and no per-account notes.
  function accountGaps(a) {
    const g = [];
    if (!a.number_masked) g.push('an account number');
    g.push('a BSB');
    if (a.type === 'credit-card') g.push('a credit limit');
    if (!a.manual && !a.rates && a.type !== 'transaction') g.push('an interest rate');
    g.push('notes');
    return g;
  }
  const gapLine = (gaps) => `Mint does not hold ${gaps.length > 1 ? `${gaps.slice(0, -1).join(', ')} or ${gaps.at(-1)}` : gaps[0]} for this account, so none is shown.`;

  // The scoped rules for one account: the rules limited to it, and how many apply to every account.
  function accountRules(rules, id) {
    const mine = rules.filter((r) => r.account_id === id);
    const everywhere = rules.filter((r) => r.account_id == null).length;
    return { mine, everywhere };
  }
  const rulesLine = ({ mine, everywhere }) => {
    const m = `${mine.length.toLocaleString('en-AU')} ${mine.length === 1 ? 'rule' : 'rules'} for this account`;
    return everywhere ? `${m} · ${everywhere.toLocaleString('en-AU')} for every account` : m;
  };

  // Move a row one place inside its list (dir -1 up, +1 down); a row at the end or an unknown id leaves it as it was.
  function moveRow(ids, id, dir) {
    const out = [...ids];
    const i = out.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= out.length) return out;
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  }

  // Every row id in the order shown, sections top to bottom: the body of PUT /api/home/order.
  const orderIds = (list) => list.sections.flatMap((s) => s.rows.filter((r) => r.kind !== 'holding' && r.kind !== 'holding-more').map((r) => r.id)); // the share rows under the portfolio are not orderable

  // the Transactions list: row, subline, summary strip

  // A settled transfer leg, or a row filed as a transfer.
  const isTransferLeg = (t) => (!!t.transfer && t.transfer.status !== 'review') || t.category_kind === 'transfer';

  // Day nets and the summary leave transfers out across all accounts, where the two legs cancel. On one account
  // (account set) a transfer is real money in or out of it, so every row counts.
  const countsInTotals = (t, { account = false } = {}) => !!account || !isTransferLeg(t);

  // Long product names ("Bankwest Zero Platinum Mastercard") shrink to bank and last four; short ones and nicknames stay.
  const ACCOUNT_SHORT_MAX = 20;
  function accountShort(a) {
    if (!a) return '';
    if (a.nickname) return a.nickname;
    const name = a.name ?? '';
    const last4 = String(a.number_masked ?? '').replace(/\D/g, '').slice(-4);
    const bank = String(a.institution ?? '').trim().split(/\s+/)[0];
    if (name.length <= ACCOUNT_SHORT_MAX || !last4 || !bank || bank.length > 12) return name;
    return `${bank} ${last4}`;
  }

  const TRANSFER_WORD = { card_repayment: 'Card repayment', loan_repayment: 'Loan repayment' };
  // The second line of a row: what it is first, then the account when the list is not already about one account.
  // A settled transfer says so and always names its account, since which two accounts it moved between is the point.
  function txSubline(t, { account = '', showAccount = true } = {}) {
    if (t.transfer && t.transfer.status !== 'review') return { lead: TRANSFER_WORD[t.transfer.kind] ?? 'Transfer', account };
    return { lead: t.category ?? 'Not filed', account: showAccount ? account : '' };
  }

  // What a row marks beyond its text. Pending dims the amount; a settled transfer mutes the row; chips are icons
  // (review is the only one with words, because it asks something of you).
  function txRowFlags(t) {
    const settled = !!t.transfer && t.transfer.status !== 'review';
    const chips = [];
    if (t.transfer && !settled) chips.push('review');
    if (t.business && !t.transfer) chips.push('business');
    if (t.tax) chips.push('tax');
    if (t.receipts) chips.push('receipt');
    return { pending: t.status === 'pending', muted: settled, chips };
  }

  // Money in and out over the rows given, counted as the day nets count them. count is every row. On one account
  // movedOutCents is the part of Out that left as a transfer (savings, spending accounts); it is 0 otherwise.
  function txSummary(items, { account = false } = {}) {
    const s = { count: 0, inCents: 0, outCents: 0, net: 0, transfers: 0, movedOutCents: 0 };
    for (const t of items) {
      s.count += 1;
      if (!countsInTotals(t, { account })) { s.transfers += 1; continue; }
      if (t.amount > 0) s.inCents += t.amount; else s.outCents -= t.amount;
      if (t.amount < 0 && isTransferLeg(t)) s.movedOutCents -= t.amount;
      s.net += t.amount;
    }
    return s;
  }

  // The strip's words. While more pages are still to arrive the count is a floor and says the rest is loading.
  function summaryParts(s, { more = false, capped = false, fmt } = {}) {
    const n = `${s.count}${more ? '+' : ''} ${s.count === 1 && !more ? 'transaction' : 'transactions'}`;
    const xf = s.transfers ? `${s.transfers} ${s.transfers === 1 ? 'transfer' : 'transfers'} not counted` : '';
    const tail = more ? (capped ? 'totals cover the rows loaded so far' : 'loading the rest') : '';
    return { count: n, in: fmt(s.inCents), out: fmt(s.outCents), moved: s.movedOutCents ? fmt(s.movedOutCents) : '', note: [xf, tail].filter(Boolean).join(', ') };
  }

  // Save and Invest goals

  // The words and numbers behind each goal card and the summary above them. The
  // input is the `items` of GET /api/goals (cents, ISO dates); `fmt` turns cents
  // into dollars so demo mode still scales every figure.
  //
  // Nothing here is stored per goal except the target, date and linked account.
  // The monthly amount comes from the pay split (pay_plan): a line sends a set
  // amount to an account each pay cycle, and a pay cycle is 14 days
  // (lib/goals.mjs CYCLE_DAYS), so a cycle's amount is x 26 / 12 a month, the same
  // convention the home loan extra uses. A goal on an account with no pay split
  // line, or with no account, has no monthly amount, and that is said, not guessed.
  //
  // A pay split line belongs to the account, not to a goal. When several goals
  // share one account the line is not split between them (that would be made up);
  // instead the account's monthly amount is compared with what the dated goals on
  // it need together.
  const CYCLES_PER_MONTH = 26 / 12;
  const monthlyOf = (perCycle) => (perCycle == null ? null : Math.round(perCycle * CYCLES_PER_MONTH));
  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dateWords = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${SHORT_MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');
  const monthYearWords = (iso) => (iso ? `${SHORT_MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');
  const countWord = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  function monthsWords(m) {
    const y = Math.floor(m / 12);
    const r = m % 12;
    return [y ? countWord(y, 'year') : '', r ? countWord(r, 'month') : ''].filter(Boolean).join(' ') || 'under a month';
  }
  // Whole months on a calendar, clamped to the month's last day (31 Jan + 1 = 28 Feb).
  function addMonthsIso(iso, n) {
    const y = Number(iso.slice(0, 4));
    const mo = Number(iso.slice(5, 7)) - 1 + n;
    const ny = y + Math.floor(mo / 12);
    const nm = ((mo % 12) + 12) % 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    const d = Math.min(Number(iso.slice(8, 10)), last);
    return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // Lower rank = needs a look sooner.
  const GOAL_STATUS = {
    behind: { label: 'Behind plan', tone: 'warn', rank: 0 },
    not_funded: { label: 'Not funded yet', tone: 'warn', rank: 1 },
    no_pace: { label: 'No monthly amount', tone: 'warn', rank: 2 },
    no_target: { label: 'No target set', tone: 'dim', rank: 3 },
    on_track: { label: 'On track', tone: 'ok', rank: 4 },
    reached: { label: 'Goal reached', tone: 'ok', rank: 5 },
  };
  const ATTENTION_RANK = 2; // behind, not funded and no monthly amount get the featured card

  // One status per goal, first match wins:
  //  1 no target                      -> no_target
  //  2 saved >= target                -> reached
  //  3 date has passed, not reached   -> behind
  //  4 monthly amount known:
  //      dated   -> on_track when it covers what the date needs, else behind
  //      undated -> on_track when it is above zero (there is no date to miss)
  //  5 saved rounds to 0% of target   -> not_funded (under half a percent)
  //  6 anything else                  -> no_pace (money in, but no monthly amount to judge by)
  // A pace of zero in the pay split counts as known: it is a decision, not a gap.
  function goalStatus({ hasTarget, done, overdue, pace, need, pct }) {
    if (!hasTarget) return 'no_target';
    if (done) return 'reached';
    if (overdue) return 'behind';
    if (pace != null) {
      if (need != null) return pace >= need ? 'on_track' : 'behind';
      if (pace > 0) return 'on_track';
    }
    if (pct === 0) return 'not_funded';
    return 'no_pace';
  }

  function goalsOverview(items, { today }) {
    const list = Array.isArray(items) ? items : [];
    const groups = new Map();
    for (const g of list) if (g.account_id) groups.set(g.account_id, [...(groups.get(g.account_id) ?? []), g]);
    const views = list.map((g, index) => {
      const target = g.target_amount ?? null;
      const hasTarget = target != null && target > 0;
      const saved = g.progress ?? 0;
      const pct = hasTarget ? Math.min(100, Math.round((saved / target) * 100)) : null;
      const done = hasTarget && saved >= target;
      const pending = g.id < 0;
      const mates = g.account_id ? groups.get(g.account_id) : null;
      const shared = mates && mates.length > 1;
      const hasDate = hasTarget && !!g.target_date;
      const overdue = hasDate && !done && g.target_date <= today;
      const ownNeed = hasDate && !done ? monthlyOf(g.per_cycle_needed) : null;
      const planMonth = g.account_id ? monthlyOf(g.planned_per_cycle ?? null) : null;
      let pace = planMonth;
      let need = ownNeed;
      let sharedNeed = null;
      if (shared) {
        // Money for every dated, unfinished goal on the account, together.
        sharedNeed = mates.reduce((s, m) => s + (m.target_amount > 0 && m.target_date && (m.progress ?? 0) < m.target_amount ? monthlyOf(m.per_cycle_needed) ?? 0 : 0), 0);
        need = ownNeed != null ? sharedNeed : null;
      }
      const status = goalStatus({ hasTarget, done, overdue, pace, need, pct });
      const remaining = hasTarget ? Math.max(0, target - saved) : null;
      // Months to target only when the whole monthly amount is this goal's alone.
      const monthsToTarget = !shared && hasTarget && !done && pace != null && pace > 0 ? Math.ceil(remaining / pace) : null;
      const bal = g.account_id ? Math.max(0, g.account_balance ?? (g.progress_basis === 'account_balance' ? saved : 0)) : null;
      return {
        id: g.id, name: g.name, index, pending, status, ...GOAL_STATUS[status],
        hasTarget, target, saved, pct, remaining, done,
        targetDate: hasTarget ? g.target_date ?? null : null, overdue,
        needMonth: ownNeed,
        monthly: !g.account_id ? { kind: 'no_account' } : planMonth == null ? { kind: 'unset' } : shared ? { kind: 'shared', month: planMonth, goals: mates.length, goalsNeed: sharedNeed } : { kind: 'own', month: planMonth },
        monthsToTarget, reachDate: monthsToTarget != null ? addMonthsIso(today, monthsToTarget) : null,
        account: g.account_id ? { id: g.account_id, name: g.account ?? null, balance: bal, sharedWith: shared ? mates.length - 1 : 0 } : null,
        manual: !g.account_id,
      };
    });

    // Who needs a look first: status, then the nearest date, then the biggest gap.
    const order = [...views].sort((a, b) => a.rank - b.rank
      || (a.targetDate && b.targetDate ? (a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : 0) : a.targetDate ? -1 : b.targetDate ? 1 : 0)
      || (b.remaining ?? 0) - (a.remaining ?? 0) || a.index - b.index);
    const focus = order[0] && order[0].rank <= ATTENTION_RANK ? order[0].id : null;

    // Saved counts each linked account once, whatever number of goals sit on it.
    const counted = new Set();
    let savedTotal = 0;
    for (const v of views) {
      if (v.account) {
        if (counted.has(v.account.id)) continue;
        counted.add(v.account.id);
      }
      savedTotal += v.saved;
    }
    const planned = new Map();
    for (const g of list) if (g.account_id && g.planned_per_cycle != null && !planned.has(g.account_id)) planned.set(g.account_id, monthlyOf(g.planned_per_cycle));
    const counts = Object.fromEntries(Object.keys(GOAL_STATUS).map((k) => [k, 0]));
    for (const v of views) counts[v.status] += 1;
    const summary = {
      total: views.length, saved: savedTotal,
      monthly: planned.size ? [...planned.values()].reduce((s, v) => s + v, 0) : null,
      counts, accounts: groups.size, focusId: focus,
    };
    summary.headline = summaryHeadline(summary, order[0]);
    return { goals: views, order: order.map((v) => v.id), focusId: focus, summary };
  }

  // One encouraging sentence over the cards. Never scolds.
  function summaryHeadline(s, first) {
    const c = s.counts;
    if (!s.total) return '';
    if (c.reached === s.total) return s.total === 1 ? 'Goal reached. Nicely done.' : `All ${s.total} goals reached. Nicely done.`;
    if (c.behind) return `${countWord(c.behind, 'goal is', 'goals are')} behind plan${c.on_track ? `, ${c.on_track} on track` : ''}. ${first.name} is the one to look at first.`;
    if (c.not_funded || c.no_pace) {
      const open = c.not_funded + c.no_pace;
      return c.on_track ? `${c.on_track} on track. ${countWord(open, 'goal still needs', 'goals still need')} a first step, starting with ${first.name}.` : `Nothing is behind. ${first.name} is a good one to get moving first.`;
    }
    if (c.on_track) return c.no_target ? `${c.on_track} on track. Set a target on the rest to track them too.` : `Everything with a target is on track. Keep going.`;
    return 'Set a target on a goal and Mint will track the pace.';
  }

  // The plain-words lines on one goal card, from a goalsOverview view.
  function goalWords(v, fmt) {
    const date = v.targetDate ? dateWords(v.targetDate) : '';
    const need = v.needMonth != null ? fmt(v.needMonth) : '';
    const out = { saved: '', headline: '', monthly: '', monthlyNote: '', account: '' };
    if (v.hasTarget) out.saved = `${fmt(v.saved)} of ${fmt(v.target)} saved`;
    else out.saved = `${fmt(v.saved)} saved`;
    switch (v.status) {
      case 'reached': {
        const over = v.saved - v.target;
        out.headline = over > 0 ? `Goal reached, ${fmt(over)} past the target. Nicely done.` : 'Goal reached. Nicely done.';
        break;
      }
      case 'on_track':
        out.headline = v.targetDate ? (v.monthly.kind === 'shared' ? `On pace for ${date}: the pay split covers every dated goal on this account.` : `On pace to reach it by ${date}.`)
          : v.monthsToTarget != null ? `Steady progress, about ${monthsWords(v.monthsToTarget)} to go at this pace.` : 'Steady progress, no date to hit.';
        break;
      case 'behind':
        if (v.overdue) out.headline = `The date, ${date}, has passed. Pick a new one and Mint will work out the monthly amount.`;
        else if (v.monthly.kind === 'shared') out.headline = `Together the dated goals on this account need about ${fmt(v.monthly.goalsNeed)} a month, ${fmt(Math.max(0, v.monthly.goalsNeed - v.monthly.month))} more than the pay split puts in.`;
        else out.headline = `Needs about ${need} a month to reach it by ${date}, ${fmt(Math.max(0, v.needMonth - v.monthly.month))} more than the pay split puts in.`;
        break;
      case 'not_funded':
        out.headline = v.targetDate ? `Nothing in yet. About ${need} a month gets it there by ${date}.` : 'Nothing in yet. Add a date and Mint will work out the monthly amount.';
        break;
      case 'no_pace':
        out.headline = v.targetDate ? `Needs about ${need} a month to reach it by ${date}. Set a monthly amount to see if you are on track.` : 'Set a monthly amount to see when you will get there.';
        break;
      default:
        out.headline = 'No target yet. Pick a number to aim for and Mint will track the pace.';
    }
    const m = v.monthly;
    if (m.kind === 'own') {
      out.monthly = `${fmt(m.month)} a month`;
      out.monthlyNote = v.done ? 'Goal reached, so nothing more is needed.'
        : v.monthsToTarget != null ? `About ${monthsWords(v.monthsToTarget)} to the target, around ${monthYearWords(v.reachDate)}.`
          : m.month <= 0 ? 'The pay split sends nothing here.' : '';
    } else if (m.kind === 'shared') {
      out.monthly = `${fmt(m.month)} a month, shared`;
      out.monthlyNote = `One pay split line feeds ${m.goals} goals, so it is not divided between them.`;
    } else {
      out.monthly = 'Not set';
      out.monthlyNote = m.kind === 'no_account' ? 'Link an account, then add it to the pay split.' : 'This account is not in the pay split yet.';
    }
    const a = v.account;
    out.account = a ? `${a.name ?? 'Linked account'}, ${fmt(a.balance)}` : 'No account linked';
    return out;
  }

  // The one short line and the one status word on a goal's row in the list. A word shows only
  // when something needs a look; everything else is in the detail sheet (goalWords).
  const ROW_WORD = { behind: 'Behind', not_funded: 'Not funded' };
  function goalRowWords(v, fmt) {
    return { line: v.hasTarget ? `${fmt(v.saved)} of ${fmt(v.target)}` : `${fmt(v.saved)} saved`, word: ROW_WORD[v.status] ?? '' };
  }

  // number ticker

  // A hero figure counts up from zero the first time it is drawn in a session, and after that only ticks
  // from the figure last shown to the new one (a sync landing, a budget edited). The same figure drawn
  // again, which is every revisit of a tab, does not move at all.
  const TICK_FIRST_MS = 650;
  const TICK_MS = 400;
  function tickValue(from, to, k) {
    const t = Math.min(1, Math.max(0, k));
    return Math.round(from + (to - from) * (1 - (1 - t) ** 4));
  }
  function tickPlan(prev, next) {
    if (typeof next !== 'number' || !Number.isFinite(next)) return null;
    if (typeof prev !== 'number' || !Number.isFinite(prev)) return { from: 0, to: next, ms: TICK_FIRST_MS };
    return prev === next ? null : { from: prev, to: next, ms: TICK_MS };
  }

  // downloads

  function filenameFrom(disposition, fallback = 'mint-transactions.csv') {
    const m = /filename="?([^";]+)"?/i.exec(disposition ?? '');
    const name = m?.[1]?.replace(/[^\w.\- ]/g, '');
    return name || fallback;
  }

  return { TICK_FIRST_MS, TICK_MS, tickValue, tickPlan, SCREENS, ACTIONS, SHORTCUTS, SYNC_PHASES, PULL_MARK, FILTER_KEYS, score, matchStatic, pushRecent, sameFilters, hasFilters, categoryGroups, accountGroups, keyAction, nextIndex, syncSteps, pull, changeWord, moverText, moverHref, merchantHref, filenameFrom, compactCount, shortAgo, budgetHref, hasFeed, firstRun, homeActions, cycleSummary, categoryRows, balanceTiles, accountRows, bankName, accountHref, accountTransactionsHref, accountRulesHref, accountTypeWord, accountStatus, accountFacts, accountGaps, gapLine, accountRules, rulesLine, moveRow, orderIds, showViewsRow, pushRecentCat, suggestCategories, countsInTotals, accountShort, txSubline, txRowFlags, txSummary, summaryParts, goalsOverview, goalStatus, goalWords, goalRowWords, GOAL_STATUS, addMonthsIso, monthsWords, dateWords };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { UxModel };
