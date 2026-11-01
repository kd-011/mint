// The chat panel: a floating button on every tab that opens a bottom sheet on
// phones and a right-hand panel on desktop. It talks only to Mint (/api/chat,
// /api/chat/undo, /api/chat/confirm); Mint talks to the assistant. The conversation
// lives in localStorage, so it survives a refresh, and is cleared with a confirm.
// Logic that needs no DOM is in chat-model.js.
'use strict';

const chatUi = (() => {
  const M = ChatModel;
  const CI = {
    chat: ic('<path d="M21 12a8 8 0 0 1-11.7 7.1L4 20.5l1.4-4.7A8 8 0 1 1 21 12z"/><path d="M8.5 11.5h7M8.5 14.5h4"/>'),
    send: ic('<path d="M12 19V5M6 11l6-6 6 6"/>', 2.3),
    stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/></svg>',
    undo: ic('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
    clear: ic('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  };
  const SLOW_MS = 20_000;
  const SLASH = [
    { cmd: '/clear', desc: 'Clear this conversation' },
    { cmd: '/undo', desc: 'Undo the last change' },
  ];

  // ---------- state ----------

  // A reply that was streaming when the page went away will never finish: restore() marks it.
  const S = {
    ...M.restore(store.get('chat')),
    open: false, busy: false, ac: null, view: 'home', slowTimer: 0, opener: null,
  };
  let uid = 0;
  const nextId = () => `u${Date.now().toString(36)}${(uid += 1)}`;

  function persist() {
    const keep = M.trimHistory(S.msgs.map((m) => (m.role === 'assistant' ? { ...m, tool: null, slow: false } : m)));
    store.set('chat', { id: S.id, msgs: keep, queue: S.queue });
  }

  // ---------- elements ----------

  let root, panel, log, ta, sendBtn, chips, slashEl, queueEl, noteEl;

  function build() {
    root = document.createElement('div');
    root.id = 'chat';
    root.hidden = true;
    root.innerHTML = `<div class="scrim" data-chat-close></div>
      <section class="cpanel" role="dialog" aria-label="Chat about your money" tabindex="-1">
        <div class="cgrab" aria-hidden="true"></div>
        <header class="chead">
          <div class="chtitle"><b>Ask Mint</b></div>
          <button class="x" type="button" id="chatclear" aria-label="Clear conversation" title="Clear conversation">${CI.clear}</button>
          <button class="x" type="button" data-chat-close aria-label="Close chat" title="Close chat">${I.x}</button>
        </header>
        <div class="clog" role="log" aria-live="polite" aria-label="Conversation" tabindex="0"></div>
        <div class="cfoot">
          <div class="cqueue"></div>
          <div class="chchips chips" aria-label="Suggested questions"></div>
          <div class="cslash" role="listbox" aria-label="Commands" hidden></div>
          <div class="cbox">
            <textarea id="chatin" name="chat" rows="1" maxlength="8000" enterkeyhint="send" autocomplete="off" aria-label="Message"></textarea>
            <div class="cbar">
              <span class="cpill" title="Runs through the assistant on this server">Assistant</span>
              <span class="cflex"></span>
              <button class="csend" type="button" aria-label="Send" title="Send">${CI.send}</button>
            </div>
          </div>
          <p class="chnote" role="status"></p>
        </div>
      </section>`;
    document.body.append(root);
    panel = $('.cpanel', root);
    log = $('.clog', root);
    ta = $('#chatin', root);
    sendBtn = $('.csend', root);
    chips = $('.chchips', root);
    slashEl = $('.cslash', root);
    queueEl = $('.cqueue', root);
    noteEl = $('.chnote', root);
  }

  // ---------- rendering ----------

  const sampleRow = (r) => `<li><span class="cs-d">${esc(dmy(r.date))}</span><span class="cs-m">${esc(r.merchant ?? '')}</span><span class="cs-a num">${esc(money(r.amount))}</span><span class="cs-c">${esc(r.from ?? '')} ${I.chevron}${esc(r.to ?? '')}</span></li>`;
  const countsLine = (c) => (c ? Object.entries(c).filter(([, n]) => n).map(([t, n]) => `${n.toLocaleString('en-AU')} ${t.replace(/_/g, ' ').replace(n === 1 ? /s$/ : /$^/, '')}`).join(', ') : '');

  function cardHtml(card, id, ci) {
    const at = `data-id="${esc(id)}" data-c="${ci}"`;
    const live = M.cardLive(card);
    const off = !online;
    if (card.kind === 'note') return `<div class="chcard note">${I.tick}<div class="cc-t">${esc(card.summary)}</div></div>`;
    if (card.kind === 'change') {
      const st = card.state === 'applied' && !live ? 'expired' : card.state;
      const err = card.err ? `<div class="cc-err" role="alert">${esc(card.err)}</div>` : '';
      let right = '';
      if (st === 'applied' || st === 'error') right = `<button class="btn ghost sm" type="button" data-act="undo" ${at} ${off ? 'disabled' : ''} title="${off ? 'Offline, undo needs a connection' : 'Undo this change'}">${CI.undo}${st === 'error' ? 'Try again' : 'Undo'}</button>`;
      else if (st === 'undoing') right = '<span class="cc-st"><span class="spin dim"></span>Undoing</span>';
      else if (st === 'undone') right = '<span class="cc-st ok">Undone</span>';
      else if (st === 'expired') right = '<span class="cc-st">Undo expired</span>';
      else if (st === 'blocked') right = '<span class="cc-st">Can\'t undo</span>';
      return `<div class="chcard change ${st}">${st === 'undone' ? CI.undo : I.tick}<div class="cc-t">${esc(card.summary)}${st === 'applied' ? '<small>Applied. Undo is open for 24 hours.</small>' : ''}${off && (st === 'applied' || st === 'error') ? '<small>Offline. Undo needs a connection.</small>' : ''}${err}</div>${right}</div>`;
    }
    // confirm
    const st = card.state === 'pending' && !live ? 'expired' : card.state;
    const del = /delete/i.test(card.op ?? '');
    const sample = card.sample?.length ? `<ul class="cc-sample">${card.sample.map(sampleRow).join('')}</ul>` : '';
    const cl = countsLine(card.changes);
    const err = card.err ? `<div class="cc-err" role="alert">${esc(card.err)}</div>` : '';
    const note = card.note ? `<div class="cc-note">${esc(card.note)}</div>` : '';
    let actions = '';
    if (st === 'pending') actions = `<div class="cc-act"><button class="btn ${del ? 'danger' : ''} sm" type="button" data-act="confirm" ${at} ${off ? 'disabled' : ''} title="${off ? 'Offline, confirming needs a connection' : 'Apply this change'}">${del ? CI.clear : I.check}Confirm</button><button class="btn ghost sm" type="button" data-act="cancel" ${at}>Cancel</button></div>${off ? '<div class="cc-note">Offline. Confirming needs a connection.</div>' : ''}`;
    else if (st === 'confirming') actions = '<div class="cc-act"><span class="cc-st"><span class="spin dim"></span>Applying</span></div>';
    else if (st === 'cancelled') actions = '<div class="cc-act"><span class="cc-st">Cancelled, nothing changed</span></div>';
    else if (st === 'expired') actions = '<div class="cc-act"><span class="cc-st">This confirmation expired. Ask again to get a fresh one.</span></div>';
    return `<div class="chcard confirm ${st}">${I.alert}<div class="cc-t">${esc(card.summary)}${cl ? `<small>${esc(cl)}</small>` : ''}${sample}${note}${err}${actions}</div></div>`;
  }

  function errorHtml(m) {
    const e = M.errorText({ status: m.error.status ?? null, code: m.error.code, error: m.error.message, offline: !!m.error.offline });
    const btn = m.error.status === 401 ? '<button class="btn" type="button" data-signin>Sign in</button>' : e.retry ? `<button class="btn ghost sm" type="button" data-act="retry" data-id="${esc(m.id)}">${I.refresh}Retry</button>` : '';
    return `<div class="error cerr" role="alert"><div class="h">${esc(e.head)}</div><div class="d">${esc(e.detail)}</div>${btn}</div>`;
  }

  function msgHtml(m) {
    if (m.role === 'user') return `<div class="cmsg me" data-id="${esc(m.id)}"><div class="cbub">${esc(m.text)}</div></div>`;
    const streaming = m.status === 'streaming';
    const body = m.text ? `<div class="cbody">${M.renderMd(m.text)}${streaming ? '<span class="ccaret" aria-hidden="true"></span>' : ''}</div>` : '';
    const stat = streaming && (!m.text || m.tool) ? `<div class="cstat"><span class="cdots" aria-hidden="true"><i></i><i></i><i></i></span><span>${esc(m.tool ?? 'Thinking')}</span></div>` : '';
    const slow = streaming && m.slow ? '<p class="slow">Still working. This one is taking longer than usual, the assistant may be busy.</p>' : '';
    const stopped = m.status === 'stopped' ? '<div class="cstopped">Stopped</div>' : m.status === 'interrupted' ? '<div class="cstopped">The connection dropped here. Sent again below; what it changed is kept.</div>' : '';
    const cards = m.cards.map((c, i) => cardHtml(c, m.id, i)).join('');
    const err = m.status === 'error' ? errorHtml(m) : '';
    return `<div class="cmsg ai" data-id="${esc(m.id)}"><div class="cbub">${body}${stat}${slow}${stopped}${cards}${err}</div></div>`;
  }

  function emptyHtml() {
    return emptyState({ icon: CI.chat, title: 'Ask about your money', line: 'Spending, budgets, tax and savings. Small edits apply straight away with an Undo; bigger ones ask first.' });
  }

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 90;
  const toBottom = (smooth = false) => { log.scrollTo({ top: log.scrollHeight, behavior: smooth && !reduceMotion.matches ? 'smooth' : 'auto' }); };

  function renderLog({ stick = true } = {}) {
    const stuck = stick && (nearBottom() || !log.childElementCount);
    log.innerHTML = S.msgs.length ? S.msgs.map(msgHtml).join('') : emptyHtml();
    log.setAttribute('aria-busy', String(S.busy));
    if (stuck) toBottom();
  }

  let frame = 0;
  const pending = new Set();
  function renderMsg(m) {
    pending.add(m);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const stuck = nearBottom();
      for (const x of pending) {
        const el = log.querySelector(`.cmsg[data-id="${CSS.escape(x.id)}"]`);
        if (el) el.outerHTML = msgHtml(x); else { renderLog(); break; }
      }
      pending.clear();
      if (stuck) toBottom();
    });
  }

  function renderChips() {
    const show = !S.busy && !ta.value.trim() && online;
    chips.hidden = !show;
    chips.innerHTML = show ? M.promptsFor(S.view).map((p) => `<button class="chip-btn" type="button" data-prompt="${esc(p)}">${esc(p)}</button>`).join('') : '';
  }

  function renderQueue() {
    const why = S.msgs.at(-1)?.status === 'error' ? 'held, the last reply failed' : !online ? 'sends when you are back online' : S.busy ? 'sends after this turn' : 'sending next';
    queueEl.innerHTML = S.queue.map((q, i) => `<div class="cqcard"><div><small>${why}</small><span>${esc(q)}</span></div><button class="x sm" type="button" data-unqueue="${i}" aria-label="Remove queued message" title="Remove">${I.x}</button></div>`).join('');
  }

  function grow() {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function syncComposer() {
    const text = ta.value.trim();
    ta.disabled = !online;
    ta.placeholder = !online ? 'Offline · chat needs a connection' : S.busy ? 'Queue it · sends after this reply' : 'Ask about your money · "/" for commands';
    const stop = S.busy && !text;
    sendBtn.innerHTML = stop ? CI.stop : CI.send;
    sendBtn.classList.toggle('stop', stop);
    sendBtn.disabled = !stop && (!text || !online);
    const label = stop ? 'Stop' : !online ? 'Offline, chat needs a connection' : !text ? 'Type a message to send' : S.busy ? 'Queue' : 'Send';
    sendBtn.setAttribute('aria-label', stop ? 'Stop' : S.busy ? 'Queue' : 'Send');
    sendBtn.title = label;
    noteEl.textContent = !online ? 'You are offline. Chat needs the assistant, so it cannot be queued; what you typed is kept until you are back.' : '';
    noteEl.hidden = online;
    renderChips();
  }

  function renderAll() {
    renderLog();
    renderQueue();
    syncComposer();
  }

  // ---------- slash commands ----------

  function slashList() {
    const v = ta.value;
    const hits = /^\/\S*$/.test(v) ? SLASH.filter((s) => s.cmd.startsWith(v.toLowerCase())) : [];
    slashEl.hidden = !hits.length;
    slashEl.innerHTML = hits.map((s) => `<button class="cs-row" type="button" role="option" data-cmd="${s.cmd}"><b>${s.cmd}</b><span>${esc(s.desc)}</span></button>`).join('');
  }

  function runCommand(cmd) {
    ta.value = '';
    drafts.clear('chat');
    grow();
    slashList();
    syncComposer();
    if (cmd === '/clear') askClear();
    else if (cmd === '/undo') {
      const card = latestChange();
      if (card) undoCard(card.card, card.msg); else toast('Nothing to undo');
    }
  }

  function latestChange() {
    for (const m of [...S.msgs].reverse()) {
      for (const c of [...(m.cards ?? [])].reverse()) if (c.kind === 'change' && c.state === 'applied' && M.cardLive(c)) return { card: c, msg: m };
    }
    return null;
  }

  // ---------- talking to Mint ----------

  async function postChat(body, signal) {
    if (demoActive()) { demoToast(); throw demoError(); } // chat answers carry real figures
    for (let i = 0; ; i++) {
      try {
        return await fetch('/api/chat', { method: 'POST', credentials: 'same-origin', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
      } catch (e) {
        if (signal.aborted) throw e;
        if (i < 2) { await sleep(400 * 3 ** i); continue; } // silent retries before anything shows
        throw e;
      }
    }
  }

  function fail(reply, err) {
    reply.status = 'error';
    reply.tool = null;
    reply.error = err;
  }

  async function runTurn(reply, text, rid) {
    S.busy = true;
    S.ac = new AbortController();
    const { signal } = S.ac;
    reply.slow = false;
    clearTimeout(S.slowTimer);
    S.slowTimer = setTimeout(() => { if (reply.status === 'streaming') { reply.slow = true; renderMsg(reply); } }, SLOW_MS);
    syncComposer();
    try {
      const res = await postChat({ conversation_id: S.id, message: text, request_id: rid }, signal);
      setOnline(true);
      if (res.type === 'opaqueredirect' || res.status === 401) fail(reply, { status: 401, code: null, message: 'The sign-in gate session expired. Sign in again to carry on.' });
      else if (!res.ok) {
        const b = await res.json().catch(() => null);
        fail(reply, { status: res.status, code: b?.code ?? null, message: b?.error ?? res.statusText ?? 'no detail' });
      } else {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let rest = '';
        const known = M.cardTokens(S.msgs);
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const r = M.parseSse(rest, dec.decode(value, { stream: true }));
          rest = r.rest;
          for (const ev of r.events) {
            if (ev.event === 'undone') {
              // The undone change may be on an earlier reply ("undo that").
              const hit = S.msgs.flatMap((m) => m.cards ?? []).reverse().find((c) => c.kind === 'change' && c.state === 'applied' && c.op === ev.data?.op);
              if (hit) { hit.state = 'undone'; continue; }
            }
            M.applyEvent(reply, ev, known);
          }
          renderMsg(reply);
        }
        M.endStream(reply);
      }
    } catch (e) {
      if (signal.aborted) { if (reply.status === 'streaming') reply.status = 'stopped'; reply.tool = null; } else {
        const wasOnline = navigator.onLine;
        setOnline(false);
        if (reply.text) fail(reply, { code: 'stream-broken', message: `The connection dropped mid-reply (${e?.message ?? e}).` });
        else fail(reply, { offline: !wasOnline, message: String(e?.message ?? e) || 'Failed to reach Mint' });
      }
    } finally {
      clearTimeout(S.slowTimer);
      reply.slow = false;
      S.busy = false;
      S.ac = null;
    }
    if (reply.status === 'done') buzz(8);
    persist();
    renderAll();
    // Nothing marks a closed panel any more, so a reply that lands behind it says so.
    if (!S.open && reply.status === 'done') toast('Reply from the assistant is ready', { action: { label: 'Read', fn: open } });
    if (reply.cards.some((c) => c.kind === 'change')) refreshAppData();
    // A failed reply holds the queue (the label says so); done and stopped let it go.
    if (reply.status === 'done' || reply.status === 'stopped') flushQueue();
  }

  // Sends the next queued message if nothing is in flight. Called when a turn ends,
  // on load (the queue is saved, a reload loses the turn that would have sent it)
  // and when the connection comes back. One at a time: the next goes when this ends.
  function flushQueue() {
    const next = M.nextQueued({ busy: S.busy, online, queue: S.queue, msgs: S.msgs });
    if (next == null) return;
    S.queue.shift();
    persist();
    startTurn(next);
  }

  // rid ties every attempt at one question together, so Mint can tell a resend from a new question.
  function startTurn(text, { rid = M.newRequestId(), resend = false } = {}) {
    if (!resend) S.msgs.push({ id: nextId(), role: 'user', text, rid, at: Date.now() });
    const reply = M.newReply();
    S.msgs.push(reply);
    persist();
    renderAll();
    toBottom(true);
    return runTurn(reply, text, rid);
  }

  function send(text) {
    const t = text.trim();
    if (!t || !online) return;
    if (S.busy) { S.queue.push(t); persist(); renderQueue(); buzz(6); return; }
    startTurn(t);
  }

  function retry(id) {
    if (S.busy) return;
    const p = M.planRetry(S.msgs, id);
    if (!p) return;
    // A reply that already changed something stays, with its Undo, so a resend cannot hide it.
    if (p.keep) M.shelve(S.msgs[p.i]); else S.msgs.splice(p.i, 1);
    startTurn(p.question.text, { rid: p.rid, resend: true });
  }

  // After a change the screens behind the panel are stale: redraw them quietly.
  function refreshAppData() {
    loadCategories().catch(() => {});
    refreshAccounts(true);
    document.dispatchEvent(new CustomEvent('mint:data'));
  }

  // ---------- undo and confirm ----------

  async function act(kind, token, body = {}) {
    if (demoActive()) { demoToast(); return { status: 0, error: DEMO_BLOCKED_MSG }; }
    let res;
    try {
      res = await fetch(`/api/chat/${kind}/${encodeURIComponent(token)}`, { method: 'POST', credentials: 'same-origin', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      setOnline(false);
      return { offline: true, error: String(e?.message ?? e) };
    }
    setOnline(true);
    if (res.type === 'opaqueredirect' || res.status === 401) return { status: 401, error: 'The sign-in gate session expired. Sign in again to carry on.' };
    const b = await res.json().catch(() => null);
    return { status: res.status, body: b, error: b?.error ?? res.statusText };
  }

  async function undoCard(card, msg) {
    if (card.state === 'undoing') return;
    card.state = 'undoing';
    card.err = null;
    renderMsg(msg);
    const r = await act('undo', card.token);
    if (r.status === 200) {
      card.state = 'undone';
      toast(`Undone: ${card.summary}`);
      buzz(10);
      refreshAppData();
    } else if (r.status === 404 || r.status === 410) {
      card.state = 'expired';
      card.err = `${r.status}: ${r.error}`;
    } else if (r.status === 409) {
      card.state = 'blocked';
      card.err = `${r.status}: ${r.error}`;
    } else {
      card.state = 'error';
      card.err = r.offline ? `No connection: ${r.error}` : `${r.status ?? ''} ${r.error}`.trim();
    }
    persist();
    renderMsg(msg);
  }

  async function confirmCard(card, msg) {
    if (card.state === 'confirming') return;
    card.state = 'confirming';
    card.err = null;
    renderMsg(msg);
    const r = await act('confirm', card.token, { op: card.op });
    if (r.status === 200) {
      const u = r.body?.undo;
      const summary = r.body?.summary ?? card.summary;
      // A confirmed write that changed nothing has no undo, so it is just a note.
      if (u) Object.assign(card, { kind: 'change', summary, token: u.token, expires_at: u.expires_at ?? null, state: 'applied', err: null, note: null });
      else Object.assign(card, { kind: 'note', summary });
      toast('Done');
      buzz(12);
      refreshAppData();
    } else if (r.status === 409 && r.body?.needs_confirm) {
      Object.assign(card, { token: r.body.token, summary: r.body.summary, changes: r.body.changes, sample: r.body.sample ?? [], expires_at: r.body.expires_at, state: 'pending', note: 'Things changed since the first preview. Check the new summary before you confirm.' });
    } else if (r.status === 404 || r.status === 409 || r.status === 410) {
      card.state = 'expired';
      card.err = `${r.status}: ${r.error}`;
    } else {
      card.state = 'pending';
      card.err = r.offline ? `No connection: ${r.error}` : `${r.status ?? ''} ${r.error}`.trim();
    }
    persist();
    renderMsg(msg);
  }

  // ---------- clearing ----------

  function askClear() {
    const p = openModal(`${sheetHead(null, 'Clear this chat?')}
      <p class="sub">This removes the conversation from this device and gives the assistant a fresh start. Changes already made stay made.</p>
      <div class="cbtns"><button class="btn ghost" type="button" data-close>Keep it</button><button class="btn danger" type="button" id="chatclear-ok">${CI.clear}Clear chat</button></div>`);
    $('#chatclear-ok', p).addEventListener('click', () => {
      S.ac?.abort();
      S.id = M.newConversationId();
      S.msgs = [];
      S.queue = [];
      persist();
      closeModal();
      renderAll();
      toast('Chat cleared');
      buzz(12);
    });
  }

  // ---------- open and close ----------

  function fit() {
    const vv = window.visualViewport;
    if (!vv || desktop.matches) { panel.style.maxHeight = ''; panel.style.bottom = ''; return; }
    panel.style.maxHeight = `${Math.floor(vv.height - 20)}px`;
    panel.style.bottom = `${Math.max(8, Math.round(innerHeight - vv.height - vv.offsetTop) + 8)}px`;
  }

  // Chat answers are written by the server with real dollars in them, so demo mode keeps it shut.
  const DEMO_NO_CHAT = 'Chat is off in demo mode';

  function open() {
    if (demoActive()) { toast(DEMO_NO_CHAT, { error: true }); return; }
    if (S.open) return;
    S.open = true;
    S.opener = document.activeElement;
    root.classList.remove('closing');
    root.hidden = false;
    document.body.classList.add('chat-open');
    fit();
    renderAll();
    toBottom();
    if (desktop.matches) ta.focus({ preventScroll: true }); else panel.focus({ preventScroll: true });
    buzz(6);
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    root.classList.add('closing');
    document.body.classList.remove('chat-open');
    setTimeout(() => { if (!S.open) { root.hidden = true; root.classList.remove('closing'); } }, reduceMotion.matches ? 0 : 190);
    const back = S.opener;
    S.opener = null;
    if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
  }

  // ---------- wiring ----------

  function wire() {
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-chat-close]')) return close();
      if (e.target.closest('#chatclear')) return askClear();
      const chip = e.target.closest('[data-prompt]');
      if (chip) { buzz(6); return send(chip.dataset.prompt); }
      const cmd = e.target.closest('[data-cmd]');
      if (cmd) return runCommand(cmd.dataset.cmd);
      const un = e.target.closest('[data-unqueue]');
      if (un) { S.queue.splice(Number(un.dataset.unqueue), 1); persist(); renderQueue(); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const msg = S.msgs.find((m) => m.id === b.dataset.id);
      const card = msg?.cards?.[Number(b.dataset.c)];
      buzz(6);
      switch (b.dataset.act) {
        case 'retry': retry(b.dataset.id); break;
        case 'undo': if (card) undoCard(card, msg); break;
        case 'confirm': if (card) confirmCard(card, msg); break;
        case 'cancel': if (card) { card.state = 'cancelled'; persist(); renderMsg(msg); } break;
        default: break;
      }
    });
    sendBtn.addEventListener('click', () => {
      if (S.busy && !ta.value.trim()) { S.ac?.abort(); buzz(10); return; }
      submit();
    });
    ta.addEventListener('input', () => {
      drafts.set('chat', ta.value);
      grow();
      slashList();
      syncComposer();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
    });
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S.open && $('#modal').hidden && $('#sheet').hidden) close();
    });
    // Turning demo on puts away a panel that was open.
    document.addEventListener('mint:demo', () => { if (demoActive() && S.open) close(); });
    document.addEventListener('mint:online', (e) => { syncComposer(); renderQueue(); if (S.open) renderLog({ stick: false }); if (e.detail) flushQueue(); });
    desktop.addEventListener('change', fit);
    window.visualViewport?.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('scroll', fit);
    ta.value = drafts.get('chat') ?? '';
  }

  function submit() {
    const v = ta.value.trim();
    const exact = SLASH.find((s) => s.cmd === v.toLowerCase());
    if (exact) return runCommand(exact.cmd);
    if (!v || !online) return;
    ta.value = '';
    drafts.clear('chat');
    grow();
    slashList();
    send(v);
    syncComposer();
  }

  return {
    init() {
      if (!CHAT_ON) return;
      build();
      wire();
      grow();
      renderAll();
      flushQueue();
    },
    open() { if (!S.open) open(); },
    // Called on every route change: the suggested prompts follow the screen.
    setView(view) {
      S.view = view;
      if (root && S.open) renderChips();
    },
  };
})();
