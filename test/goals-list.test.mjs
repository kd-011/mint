// Goals as one plain list, shared by Save and Plan (public/goals.js): a row per
// goal with the name, a short saved-of-target line, a small ring and a status
// word only when something needs a look; everything else lives in the detail
// sheet a tap opens. goals.js is a classic script, so it is loaded into a vm
// context with stub helpers, the way demo-core.test.mjs loads core.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

const money0 = (c) => `$${Math.round(c / 100).toLocaleString('en-AU')}`;
const money = (c) => `$${(c / 100).toLocaleString('en-AU', { minimumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function boot() {
  const opened = [];
  const ctx = {
    console, Intl, Date, Math, JSON, Number, String, Object, Array, Map, Set, Promise,
    esc, money, money0, moneyText: (s) => s, plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`, acctText: (s) => s,
    I: new Proxy({}, { get: (_, k) => `<svg data-i="${String(k)}"></svg>` }),
    todayIso: () => '2026-10-20', shownGoals: (g) => g,
    sheetHead: (sub, title) => `<div class="sheet-head">${esc(sub)}<h3>${esc(title)}</h3></div>`,
    skeletonCard: (h) => `<div class="sk" data-h="${h}"></div>`,
    skeletonRows: (n) => `<div class="rows sk-rows" data-n="${n}"></div>`,
    errorCard: (e, id) => `<div class="error"><div class="d">${esc(e.detail ?? e.message)}</div><button id="${id}">Retry</button></div>`,
    emptyState: ({ title, button }) => `<div class="empty"><h3>${esc(title)}</h3><button id="${button.id}">${esc(button.label)}</button></div>`,
    openModal: (html) => { opened.push(html); return { querySelector: () => null, querySelectorAll: () => [] }; },
    closeModal() {}, document: {}, addEventListener() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/ux-model.js'), ctx, { filename: 'ux-model.js' });
  vm.runInContext('this.UxModel = UxModel;', ctx);
  vm.runInContext(read('public/goals.js'), ctx, { filename: 'goals.js' });
  return { ctx, opened, run: (c) => vm.runInContext(c, ctx) };
}

// Goals as GET /api/goals returns them, shaped like the fixture book: a dated goal on a
// linked savings account that is behind the pay split, a trip that is on pace, a reached
// emergency fund, an undated no-target one, and a goal with nothing in it yet.
const goal = (o) => ({ id: 1, name: 'Goal', target_amount: 1000000, target_date: null, account_id: null, account: null, account_balance: null, progress_basis: 'contributions', progress: 0, remaining: 1000000, pct: 0, cycles_left: null, per_cycle_needed: null, planned_per_cycle: null, on_track: null, done: false, ...o });
const GOALS = [
  goal({ id: 1, name: 'House deposit', target_amount: 8000000, target_date: '2028-06-01', account_id: 'a_save', account: 'Goal Saver', account_balance: 1870000, progress_basis: 'account_balance', progress: 1870000, pct: 23, cycles_left: 44, per_cycle_needed: 140000, planned_per_cycle: 60000 }),
  goal({ id: 2, name: 'Japan trip', target_amount: 1200000, target_date: '2027-03-01', account_id: 'a_cash', account: 'Cash Stash', account_balance: 120000, progress_basis: 'account_balance', progress: 120000, pct: 10, cycles_left: 11, per_cycle_needed: 90000, planned_per_cycle: 90000 }),
  goal({ id: 3, name: 'Emergency fund', target_amount: 2500000, account_id: 'a_off', account: 'Offset', account_balance: 2845000, progress_basis: 'account_balance', progress: 2845000, pct: 100, done: true }),
  goal({ id: 4, name: 'New laptop', target_amount: null, progress: 12000 }),
  goal({ id: 5, name: 'Bond', target_amount: 500000, progress: 0 }),
];

test('a row is one button with a name, one short line and nothing else', () => {
  const { run } = boot();
  run(`globalThis.o = UxModel.goalsOverview(${JSON.stringify(GOALS)}, { today: '2026-10-20' })`);
  const row = (id) => run(`goalRowHtml(o.goals.find((v) => v.id === ${id}))`);
  const house = row(1);
  assert.match(house, /^<button class="row goal/);
  assert.match(house, /data-goal="1"/);
  assert.match(house, /House deposit/);
  assert.match(house, /\$18,700 of \$80,000/);
  assert.match(house, /<span class="chip warn">Behind<\/span>/);
  for (const dropped of ['Start here', 'gcard', 'gc-facts', 'Saving each month', 'Link an account', 'Add money', 'Aiming for']) assert.ok(!house.includes(dropped), `${dropped} belongs in the sheet`);
  assert.equal((house.match(/class="chip/g) ?? []).length, 1, 'one status word at most');
});

test('a status word shows only for behind and not funded', () => {
  const { run } = boot();
  run(`globalThis.o = UxModel.goalsOverview(${JSON.stringify(GOALS)}, { today: '2026-10-20' })`);
  const chips = (id) => run(`goalRowHtml(o.goals.find((v) => v.id === ${id}))`).match(/class="chip[^>]*>([^<]*)</g) ?? [];
  assert.deepEqual(chips(1), ['class="chip warn">Behind<']);
  assert.deepEqual(chips(5), ['class="chip warn">Not funded<']);
  assert.deepEqual(chips(3), [], 'reached says nothing');
  assert.deepEqual(chips(4), [], 'no target says nothing');
  assert.deepEqual(chips(2), [], 'on pace says nothing');
});

test('a goal with no target reads as just what is saved, and has no ring', () => {
  const { run } = boot();
  run(`globalThis.o = UxModel.goalsOverview(${JSON.stringify(GOALS)}, { today: '2026-10-20' })`);
  const r = run(`goalRowHtml(o.goals.find((v) => v.id === 4))`);
  assert.match(r, /\$120 saved/);
  assert.ok(!/ of \$/.test(r));
  assert.ok(!r.includes('data-ring'));
});

test('goalRowWords gives the line and the word, from the same view the sheet reads', () => {
  const { run } = boot();
  run(`globalThis.o = UxModel.goalsOverview(${JSON.stringify(GOALS)}, { today: '2026-10-20' })`);
  assert.deepEqual(JSON.parse(run(`JSON.stringify(UxModel.goalRowWords(o.goals[0], money0))`)), { line: '$18,700 of $80,000', word: 'Behind' });
  assert.equal(run(`UxModel.goalRowWords(o.goals.find((v) => v.id === 4), money0).line`), '$120 saved');
});

test('a goal still waiting to sync is a disabled row that says so', () => {
  const { run } = boot();
  run(`globalThis.o = UxModel.goalsOverview([${JSON.stringify(goal({ id: -5, name: 'Boat', target_amount: 100000 }))}], { today: '2026-10-20' })`);
  const r = run('goalRowHtml(o.goals[0])');
  assert.match(r, /disabled/);
  assert.match(r, /Saving\.\.\./);
});

test('the panel is a plain list, needs-a-look first, with at most one quiet total line', () => {
  const { run } = boot();
  const html = run(`goalsPanelHtml(${JSON.stringify(GOALS)}, null)`);
  const names = [...html.matchAll(/class="t1">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(names, ['House deposit', 'Bond', 'New laptop', 'Japan trip', 'Emergency fund'], 'behind first, reached last');
  for (const gone of ['gsum', 'gcard', 'gcards', 'Goals by status', 'is the one to look at first']) assert.ok(!html.includes(gone), gone);
  assert.equal((html.match(/toward goals/g) ?? []).length, 1, 'one total line');
  assert.match(html, /id="addgoal"/);
});

test('loading, error and empty keep their designed states', () => {
  const { run } = boot();
  assert.match(run('goalsPanelHtml(null, null)'), /aria-busy="true"/);
  assert.match(run('goalsPanelHtml(null, null)'), /sk-rows/, 'skeleton rows, the shape of the list');
  const err = run(`goalsPanelHtml(null, { detail: 'HTTP 500 boom' })`);
  assert.match(err, /HTTP 500 boom/);
  assert.match(err, /id="svr-goals"/);
  const empty = run('goalsPanelHtml([], null)');
  assert.match(empty, /Add your first goal/);
  assert.match(empty, /id="addgoal2"/);
});

test('the sheet holds the headline, the facts and every action for a goal with no account', () => {
  const { run } = boot();
  run(`globalThis.o = UxModel.goalsOverview(${JSON.stringify(GOALS)}, { today: '2026-10-20' })`);
  const s = run(`goalSheetHtml(o.goals.find((v) => v.id === 5))`);
  for (const want of ['Bond', 'Saving each month', 'No account linked', 'Add money', 'Link an account', 'Edit', 'Delete goal']) assert.ok(s.includes(want), want);
  assert.match(s, /data-gact="contrib"/);
  assert.match(s, /data-gact="edit"/);
  assert.match(s, /class="btn danger[^"]*"[^>]*data-gact="delete"/);
});

test('the sheet for a linked goal shows its account, balance, pay split amount and date', () => {
  const { run } = boot();
  run(`globalThis.o = UxModel.goalsOverview(${JSON.stringify(GOALS)}, { today: '2026-10-20' })`);
  const s = run(`goalSheetHtml(o.goals.find((v) => v.id === 1))`);
  assert.match(s, /Behind plan/);
  assert.match(s, /\$18,700/);
  assert.match(s, /\$80,000/);
  assert.match(s, /Goal Saver, <span class="num">\$18,700\.00<\/span>/);
  assert.match(s, /\$1,300 a month/, '60000 a cycle x 26 / 12');
  assert.match(s, /Needs about \$3,033 a month to reach it by 1 Jun 2028/);
  assert.match(s, /1 Jun 2028/);
  assert.ok(!s.includes('data-gact="contrib"'), 'money lands in a linked account, not by hand');
  assert.ok(!s.includes('Set in pay split'), 'it is already in the pay split');
});

test('a linked goal with no pay split line offers to set it', () => {
  const { run } = boot();
  const car = goal({ id: 6, name: 'Car', target_amount: 3000000, account_id: 'a_car', account: 'Car Saver', account_balance: 100000, progress_basis: 'account_balance', progress: 100000 });
  run(`globalThis.o = UxModel.goalsOverview([${JSON.stringify(car)}], { today: '2026-10-20' })`);
  const s = run(`goalSheetHtml(o.goals[0])`);
  assert.match(s, /href="\/plan\?s=split"/);
  assert.match(s, /Set in pay split/);
  run(`globalThis.o = UxModel.goalsOverview(${JSON.stringify(GOALS)}, { today: '2026-10-20' })`);
  assert.ok(!run(`goalSheetHtml(o.goals.find((v) => v.id === 3))`).includes('Set in pay split'), 'a reached goal needs nothing more');
});

test('Save and Plan share one list: both mount it, neither keeps its own card or row', () => {
  const save = read('public/save.js');
  const plan = read('public/plan.js');
  assert.match(save, /mountGoals\(/);
  assert.match(plan, /mountGoals\(/);
  for (const [name, src] of [['save.js', save], ['plan.js', plan]]) {
    for (const gone of ['goalCardHtml', 'goalsSummaryHtml', 'goalRow(', 'goalActions', 'goalRingHtml', 'gcard', 'gsum']) assert.ok(!src.includes(gone), `${name} still has ${gone}`);
  }
  const css = read('public/style.css');
  for (const gone of ['.gcard', '.gsum', '.gc-top', '.gc-saved']) assert.ok(!css.includes(gone), `style.css still has ${gone}`);
});

test('goals.js ships in the shell, before the screens that mount it', () => {
  const scripts = /const SCRIPTS = \[([^\]]+)\]/.exec(read('server.mjs'))[1];
  assert.ok(scripts.includes("'goals.js'"));
  assert.ok(scripts.indexOf("'goals.js'") < scripts.indexOf("'plan.js'"));
});

test('rows are at least 56px, keyboard-activatable buttons, with no motion when reduced', () => {
  const css = read('public/style.css');
  const m = /\.row\.goal\{[^}]*min-height:(\d+)px/.exec(css);
  assert.ok(m && Number(m[1]) >= 56, 'row.goal min-height');
  assert.match(read('public/goals.js'), /<button class="row goal/);
  assert.match(css, /prefers-reduced-motion/);
});
