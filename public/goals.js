// Goals, one plain list shared by Save and Invest and by Plan. A row is the name,
// one short line and a small ring; a status word shows only when something needs a
// look. Tapping a row opens the detail sheet, which holds what the old cards held:
// status and headline, the monthly amount, the account and the actions. The editor
// and the add-money sheet are in plan.js (openGoalEditor, openContribution). All the
// wording and maths is UxModel.goalsOverview / goalWords / goalRowWords.
'use strict';

const RING_C = 175.93; // circumference of the r=28 ring below
// Whole dollars, except a balance under a dollar, which would read as $0 while the ring says it has started.
const savedMoney = (c) => (c > 0 && c < 100 ? money(c) : money0(c));

// The ring is small in a row (no figure inside) and full size in the sheet.
function goalRingHtml(v, small = false) {
  if (!v.hasTarget) return `<div class="gring none ${small ? 'sm' : ''}" aria-hidden="true">${I.target}</div>`;
  const label = v.done ? 'Goal reached' : `${v.pct} percent saved`;
  const mid = v.done ? I.check : small ? '' : `${v.pct}%`;
  return `<div class="gring ${v.tone} ${small ? 'sm' : ''}" role="img" aria-label="${esc(label)}"><svg class="gr" viewBox="0 0 64 64" aria-hidden="true"><circle class="gr-bg" cx="32" cy="32" r="28"/><circle class="gr-fg" cx="32" cy="32" r="28" transform="rotate(-90 32 32)" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}" data-ring="${v.pct}"/></svg><span class="num">${mid}</span></div>`;
}

// Rings fill from empty once they are in the page (the stroke offset is set here, the page CSP bans inline styles).
function drawRings(root) {
  const rings = $$('[data-ring]', root);
  if (rings.length) void root.offsetWidth;
  rings.forEach((n) => { n.style.strokeDashoffset = String(RING_C * (1 - Number(n.dataset.ring) / 100)); });
}

function goalRowHtml(v) {
  const w = UxModel.goalRowWords(v, savedMoney);
  const tag = v.pending ? '<span class="chip">Saving...</span>' : w.word ? `<span class="chip warn">${esc(w.word)}</span>` : '';
  return `<button class="row goal ${v.status}" type="button" data-goal="${v.id}" ${v.pending ? 'disabled' : ''}>${goalRingHtml(v, true)}<div class="main"><div class="t1">${esc(v.name)}</div><div class="t2 num">${esc(w.line)}</div></div>${tag}${I.chevron}</button>`;
}

function goalActions(v) {
  if (v.pending) return '';
  const acts = [`<button class="btn sm" type="button" data-gact="edit">${v.hasTarget ? `${I.edit}Edit` : `${I.target}Set a target`}</button>`];
  if (v.manual) {
    acts.push(`<button class="btn ghost sm" type="button" data-gact="contrib">${I.plus}Add money</button>`);
    acts.push(`<button class="btn ghost sm" type="button" data-gact="edit">${I.bank}Link an account</button>`);
  } else if (v.monthly.kind === 'unset' && !v.done) acts.push(`<a class="btn ghost sm" href="/plan?s=split" data-nav>${I.sliders}Set in pay split</a>`);
  return `<div class="gd-acts">${acts.join('')}</div><button class="btn danger wide" type="button" data-gact="delete">${I.trash}Delete goal</button>`;
}

function goalSheetHtml(v) {
  const w = UxModel.goalWords(v, money0);
  const a = v.account;
  const accNote = a?.sharedWith ? `Shared with ${plural(a.sharedWith, 'other goal')}, so each shows the whole balance.` : '';
  const unset = v.monthly.kind === 'unset' || v.monthly.kind === 'no_account';
  return `${sheetHead(v.label, v.name)}<div class="gd">
      <div class="gd-top">${goalRingHtml(v)}<div class="gd-saved num">${esc(savedMoney(v.saved))}<span>${v.hasTarget ? ` of ${esc(money0(v.target))} saved` : ' saved'}</span></div></div>
      <p class="gd-line">${esc(moneyText(v.pending ? 'Waiting to sync, you can change it once it has.' : w.headline))}</p>
      <dl class="gd-facts">
        <div><dt>Saving each month</dt><dd class="num ${unset ? 'unset' : ''}">${esc(moneyText(w.monthly))}</dd>${w.monthlyNote ? `<small>${esc(moneyText(w.monthlyNote))}</small>` : ''}</div>
        <div><dt>Account</dt><dd class="${a ? '' : 'unset'}">${a ? `${esc(acctText(a.name ?? 'Linked account'))}${v.pending ? '' : `, <span class="num">${esc(money(a.balance))}</span>`}` : 'No account linked'}</dd>${accNote ? `<small>${esc(accNote)}</small>` : a ? '' : '<small>Progress counts money you add by hand.</small>'}</div>
        ${v.targetDate ? `<div><dt>Aiming for</dt><dd>${esc(UxModel.dateWords(v.targetDate))}</dd></div>` : ''}
      </dl>
      ${goalActions(v)}
    </div>`;
}

// ctx is { goals, paint, load }: the list on screen, a redraw of it and a reload from the server.
function openGoalSheet(id, ctx) {
  const v = UxModel.goalsOverview(shownGoals(ctx.goals), { today: todayIso() }).goals.find((x) => x.id === id);
  if (!v) return;
  const panel = openModal(goalSheetHtml(v));
  drawRings(panel);
  $('.gd', panel).addEventListener('click', (e) => {
    if (e.target.closest('a[data-nav]')) return closeModal();
    const act = e.target.closest('[data-gact]')?.dataset.gact;
    const g = act && ctx.goals.find((x) => x.id === id);
    if (!g) return;
    if (act === 'delete') return deleteGoal(g, ctx);
    closeModal();
    if (act === 'contrib') openContribution(g, ctx); else openGoalEditor(g, ctx);
  });
}

// Out of the list now, gone from the server after a few seconds unless Undo is tapped.
function deleteGoal(g, ctx) {
  closeModal();
  const keep = ctx.goals;
  undoable({
    label: `${g.name} deleted`,
    apply: () => { ctx.goals = ctx.goals.filter((x) => x.id !== g.id); ctx.paint(); },
    revert: () => { ctx.goals = keep; ctx.paint(); },
    op: { method: 'DELETE', path: `/api/goals/${g.id}` },
  });
}

// title is empty on Plan, where the Goals tab already says it.
function goalsPanelHtml(goals, err, title = 'Your goals') {
  const head = (ready) => `<div class="sec-head gsec-head">${title ? `<h2>${esc(title)}</h2>` : ''}<button class="btn ghost sm ibtn gadd" type="button" id="addgoal" aria-label="Add a goal" title="${ready ? 'Add a goal' : 'Goals are still loading'}" ${ready ? '' : 'disabled'}>${I.plus}</button></div>`;
  if (err && !goals) return `${head(false)}${errorCard(err, 'svr-goals', 'goals')}`;
  if (!goals) return `${head(false)}<div aria-busy="true" aria-label="Loading goals">${skeletonRows(3)}</div>`;
  if (!goals.length) {
    return `${head(true)}<div class="card gempty">${emptyState({ icon: I.target, title: 'Give your savings a purpose', line: 'Add a goal, say an emergency fund or a trip, and Mint shows what to put away each month to get there.', button: { id: 'addgoal2', label: 'Add your first goal', icon: I.plus } })}</div>`;
  }
  const o = UxModel.goalsOverview(shownGoals(goals), { today: todayIso() });
  const byId = new Map(o.goals.map((v) => [v.id, v]));
  return `${head(true)}${o.goals.length > 1 ? `<p class="gtotal num">${esc(savedMoney(o.summary.saved))} saved toward goals</p>` : ''}<div class="rows">${o.order.map((id) => goalRowHtml(byId.get(id))).join('')}</div>`;
}

// Loads and draws the list into box, and wires it. Loading, error with retry, empty and the
// list are all in goalsPanelHtml. Resolves when the first load settles.
function mountGoals(box, token, { title } = {}) {
  let goals = null;
  let err = null;
  let first = true;
  const paint = () => {
    if (token !== renderToken || !box.isConnected || (!goals && !err)) return;
    box.innerHTML = goalsPanelHtml(goals, err, title);
    applyDims(box);
    drawRings(box);
    if (first && goals) { first = false; stagger($('.rows', box) ?? box); }
  };
  const load = () => swr('/api/goals', (d) => { goals = d.items; err = null; paint(); }).catch((e) => { err = e; paint(); });
  const ctx = { get goals() { return goals; }, set goals(v) { goals = v; }, paint, load };
  box.innerHTML = goalsPanelHtml(null, null, title);
  applyDims(box);
  box.addEventListener('click', (e) => {
    if (e.target.closest('#svr-goals')) { err = null; box.innerHTML = goalsPanelHtml(null, null, title); applyDims(box); return load(); }
    if (e.target.closest('#addgoal, #addgoal2')) return goals ? openGoalEditor(null, ctx) : undefined;
    const row = e.target.closest('[data-goal]');
    if (row && goals) openGoalSheet(Number(row.dataset.goal), ctx);
  });
  return load();
}
