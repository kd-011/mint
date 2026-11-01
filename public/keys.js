// Desktop keyboard shortcuts: / or Ctrl/Cmd K opens search, g then h s v t m
// jumps between the tabs, j and k move down the Transactions list, e edits the
// highlighted row, ? lists them. They only act with a mouse and keyboard
// (a fine pointer), never on a touch screen, and never while typing in a field
// or with a sheet open. What each key means is UxModel.keyAction.
'use strict';

const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
let listKeys = null; // set by the Transactions list: { move(delta), edit() }
let keyState = { pending: null, at: 0 };
let keyHintTimer = 0;

const isTypingTarget = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

function keyHint(text) {
  let el = $('#keyhint');
  if (!el) { el = document.createElement('div'); el.id = 'keyhint'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(keyHintTimer);
  keyHintTimer = setTimeout(() => el.classList.remove('on'), 1500);
}

function goTab(id) {
  const tab = MINT_TABS.find((t) => t.id === id);
  if (!tab) return;
  const href = id === 'spending' ? spendMem.tabHref() : tab.href;
  if (route.tab === id && href === location.pathname + location.search) { scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' }); return; }
  navigate(href);
}

function openShortcuts() {
  openModal(`${sheetHead(null, 'Keyboard shortcuts')}
    <div class="keys">${UxModel.SHORTCUTS.map(([title, rows]) => `<h2>${esc(title)}</h2><div class="rows">${rows.map(([k, what]) => `<div class="row static"><div class="main"><div class="t1">${esc(what)}</div></div><span class="kbds">${k.split(' ').map((x) => `<kbd>${esc(x)}</kbd>`).join('<i>then</i>')}</span></div>`).join('')}</div>`).join('')}</div>
    `);
}

function initKeys() {
  addEventListener('keydown', (e) => {
    if (!finePointer.matches || e.isComposing || (e.repeat && e.key !== 'j' && e.key !== 'k')) return;
    // Search handles its own keys while it is open; a sheet or picker owns the keyboard until it closes.
    if (palState.open || !$('#modal').hidden || !$('#sheet').hidden) return;
    const r = UxModel.keyAction(keyState, { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: isTypingTarget(e.target) }, Date.now());
    keyState = r.state;
    const a = r.action;
    if (!a) return;
    if (a.type === 'move' && !listKeys) return;
    if (a.type === 'edit' && !listKeys) return;
    if (r.prevent) e.preventDefault();
    if (a.type === 'palette') openPalette({ instant: true });
    else if (a.type === 'help') openShortcuts();
    else if (a.type === 'go') goTab(a.tab);
    else if (a.type === 'chord') keyHint('g, then h s v t or m');
    else if (a.type === 'move') listKeys.move(a.delta);
    else if (a.type === 'edit') listKeys.edit();
  });
}
