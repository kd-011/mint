// The chat panel's logic with no DOM in it: the event-stream parser, how stream
// events build up a reply and its cards, plain-English error text, a tiny and
// safe reply renderer, and the suggested prompts per tab. Plain script in the
// page and a CommonJS module in tests, like routes.js. One global, ChatModel.
'use strict';

const ChatModel = (() => {
  // ---------- the stream ----------

  // Incremental: hand back what was left over last time plus the new text, get
  // whole events and the new leftover. Comments (": ping") and blocks that are
  // not valid JSON are dropped rather than breaking the reply.
  function parseSse(rest, chunk) {
    const buf = `${rest}${chunk}`.replace(/\r\n/g, '\n');
    const parts = buf.split('\n\n');
    const left = parts.pop();
    const events = [];
    for (const block of parts) {
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      try { events.push({ event, data: JSON.parse(data.join('\n')) }); } catch { /* skip a mangled block */ }
    }
    return { events, rest: left };
  }

  // ---------- a reply ----------

  let seq = 0;
  const newReply = () => ({ id: `r${Date.now().toString(36)}${(seq += 1)}`, role: 'assistant', text: '', tool: null, cards: [], status: 'streaming', error: null });

  // known: undo tokens already on screen. A resend of a question Mint already
  // answered gets the same write back (same token), which is shown as a note
  // instead of a second card with a second Undo.
  function applyEvent(m, { event, data }, known = null) {
    if (m.status !== 'streaming') return m;
    const d = data ?? {};
    switch (event) {
      case 'tool': m.tool = d.label || d.name || null; break;
      case 'delta': m.text += String(d.text ?? ''); m.tool = null; break;
      case 'undo':
        if (known?.has(d.token)) { m.cards.push({ kind: 'note', op: d.op, summary: `Already done above, not repeated: ${d.summary}` }); break; }
        m.cards.push({ kind: 'change', op: d.op, summary: d.summary, token: d.token, expires_at: d.expires_at ?? null, state: 'applied' }); break;
      case 'confirm': m.cards.push({ kind: 'confirm', op: d.op, summary: d.summary, token: d.token, expires_at: d.expires_at ?? null, changes: d.changes ?? null, sample: Array.isArray(d.sample) ? d.sample : [], state: 'pending' }); break;
      case 'undone': {
        const hit = [...m.cards].reverse().find((c) => c.kind === 'change' && c.state === 'applied' && c.op === d.op);
        if (hit) hit.state = 'undone'; else m.cards.push({ kind: 'note', op: d.op, summary: d.summary });
        break;
      }
      case 'done': m.status = 'done'; m.tool = null; if (typeof d.reply === 'string' && d.reply) m.text = d.reply; break;
      case 'error': m.status = 'error'; m.tool = null; m.error = { message: String(d.error ?? 'Chat failed'), code: d.code ?? null }; break;
      default: break; // start and anything new: nothing to show
    }
    return m;
  }

  function endStream(m) {
    if (m.status === 'streaming') { m.status = 'error'; m.tool = null; m.error = { message: 'The reply stopped before it finished.', code: 'stream-broken' }; }
    return m;
  }

  // ---------- retry, restore and the queue ----------

  // One id per question, sent with every attempt at it, so Mint can tell a resend
  // from a new question. Same alphabet as the conversation id.
  function newRequestId() {
    let hex;
    try { hex = globalThis.crypto.randomUUID().replace(/-/g, ''); } catch {
      hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    }
    return `q_${hex}`;
  }

  const cardTokens = (msgs) => new Set(msgs.flatMap((m) => m.cards ?? []).filter((c) => c.kind === 'change' && c.token).map((c) => c.token));

  // Retrying the reply `id`: the question to resend (with its request id) and whether
  // the broken reply stays on screen. It stays when it holds an applied change, so
  // that change keeps its Undo; the retry's own reply goes below it.
  function planRetry(msgs, id) {
    const i = msgs.findIndex((m) => m.id === id);
    if (i < 1) return null;
    let q = null;
    for (let j = i - 1; j >= 0 && !q; j--) if (msgs[j].role === 'user') q = msgs[j];
    if (!q) return null;
    q.rid ??= newRequestId();
    return { i, question: q, rid: q.rid, keep: (msgs[i].cards ?? []).some((c) => c.kind === 'change') };
  }

  // A broken reply that stays: no error, no Retry button, only the changes it made.
  function shelve(m) {
    m.status = 'interrupted';
    m.error = null;
    m.tool = null;
    m.cards = (m.cards ?? []).filter((c) => c.kind === 'change');
    return m;
  }

  // The saved conversation, as the page starts up with it. A reply that was
  // streaming when the page went away will never finish.
  function restore(saved) {
    const msgs = Array.isArray(saved?.msgs) ? saved.msgs : [];
    for (const m of msgs) {
      if (m.status === 'streaming') { m.status = 'error'; m.error = { message: 'The page was closed or reloaded before the reply finished. The assistant may have finished it, so check your recent changes before asking again.', code: 'interrupted' }; }
    }
    return { id: saved?.id ?? newConversationId(), msgs, queue: Array.isArray(saved?.queue) ? saved.queue : [] };
  }

  // The queued message to send now, or null. One at a time: the caller sends it,
  // and the next goes when that turn ends. Held while a turn is in flight, while
  // offline, and after a failure that sending again would not fix (a limit, a
  // pause, a sign-out); a transient failure does not hold it.
  function nextQueued({ busy, online, queue, msgs }) {
    if (busy || !online || !queue.length) return null;
    const last = msgs.at(-1);
    if (last?.status === 'streaming') return null;
    if (last?.status === 'error') {
      const e = last.error ?? {};
      if (!errorText({ status: e.status ?? null, code: e.code, error: e.message, offline: !!e.offline }).retry) return null;
    }
    return queue[0];
  }

  // ---------- errors ----------

  const HEADS = {
    busy: ['The assistant is still answering your last message', true],
    'daily-limit': ['Daily chat limit reached', false],
    quota: ['The Claude quota is nearly used up', false],
    paused: ['The assistant is paused', false],
    'not-configured': ['Chat is not set up yet', false],
    'mint-not-configured': ['Chat is not set up yet', false],
    unreachable: ['The assistant is not reachable', true],
    'assistant-rejected': ["The assistant refused Mint's chat key", false],
    'rate-limited': ['Too many messages too quickly', true],
    'bad-request': ["Couldn't send that", false],
    timeout: ['The assistant took too long to answer', true],
    'stream-broken': ['The reply was cut off', true],
    'turn-failed': ["The assistant couldn't finish that reply", true],
    interrupted: ['The reply was interrupted', true],
  };

  // { status, code, error, offline } -> { head, detail, retry }. The detail is the
  // real server text, kept small under the plain headline.
  function errorText({ status = null, code = null, error = '', offline = false } = {}) {
    const label = [status, code].filter(Boolean).join(' ');
    const detail = label ? `${label}: ${error}` : String(error ?? '');
    if (offline) return { head: 'No connection', detail, retry: true };
    const known = code && HEADS[code];
    if (known) return { head: known[0], detail, retry: known[1] };
    if (status === 401) return { head: 'Signed out', detail, retry: false };
    return { head: 'Chat hit a problem', detail, retry: true };
  }

  // ---------- reply text ----------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = (s) => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');

  // Escape first, then add back only bold, code, bullet lists and line breaks.
  // No links and no attributes ever come out of the text.
  function renderMd(text) {
    const out = [];
    let para = [];
    let list = [];
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
    const flushList = () => { if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`); list = []; };
    for (const line of String(text ?? '').split('\n')) {
      const b = /^\s*[-*•]\s+(.*)$/.exec(line);
      if (b) { flushPara(); list.push(b[1]); } else if (!line.trim()) { flushPara(); flushList(); } else { flushList(); para.push(line); }
    }
    flushPara();
    flushList();
    return out.join('');
  }

  // ---------- prompts, ids, history ----------

  const PROMPTS = {
    home: ['How am I tracking this pay cycle?', 'What is my safe to spend?', 'Anything I should look at this week?'],
    transactions: ['What did I spend the most on this month?', 'Show me anything uncategorised', 'Which merchants cost me the most lately?'],
    budgets: ['Which budgets am I over?', 'Where am I ahead of pace?', 'Suggest budget targets from my last three months'],
    save: ['How are my savings goals going?', 'When will the home loan be paid off?', 'What would $200 extra a month do to the loan?'],
    tax: ['What is my estimated tax refund?', 'What deductions have I tagged this year?', 'Which deductions are missing a receipt?'],
    more: ['Are all my accounts syncing?', 'What needs reviewing?', 'What rules do I have for fuel?'],
    accounts: ['Are all my accounts syncing?', 'What is my net worth right now?', 'Which transfers need reviewing?'],
    reports: ['How did this month compare with last month?', 'Where is my money going this year?', 'What is my savings rate?'],
    income: ['When is my next pay?', 'What other money came in lately?', 'How steady is my income?'],
    plan: ['How is my pay split working out?', 'Which bills are coming up?', 'How fast can I clear my card debt?'],
  };
  const promptsFor = (view) => PROMPTS[view] ?? PROMPTS.home;

  // The assistant wants 1 to 100 of A-Z a-z 0-9 _ -.
  function newConversationId() {
    let hex;
    try { hex = globalThis.crypto.randomUUID().replace(/-/g, ''); } catch {
      hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    }
    return `m_${hex}`;
  }

  // Keep the newest messages; a reply with no question before it is dropped from the front.
  function trimHistory(msgs, max = 60) {
    const t = msgs.slice(-max);
    while (t.length && t[0].role !== 'user') t.shift();
    return t;
  }

  const cardLive = (card, now = Date.now()) => !card.expires_at || Date.parse(card.expires_at) > now;

  return { parseSse, newReply, applyEvent, endStream, errorText, renderMd, promptsFor, newConversationId, newRequestId, cardTokens, planRetry, shelve, restore, nextQueued, trimHistory, cardLive };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ChatModel };
