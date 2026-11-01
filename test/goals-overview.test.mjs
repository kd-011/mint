// The Save and Invest goal cards: status, monthly pace, months to target, the
// summary and the plain words. Pure helpers in public/ux-model.js over the
// items GET /api/goals returns (cents, ISO dates), plus the one field the API
// gained for them (account_balance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { book } from './fixtures/book.mjs';
import { listGoals, createGoal } from '../lib/goals.mjs';

const require = createRequire(import.meta.url);
const { UxModel: M } = require('../public/ux-model.js');

const TODAY = '2026-10-20';
const fmt = (c) => `$${Math.round(c / 100).toLocaleString('en-AU')}`;
// A goal as the API returns it, with the fields the helpers read.
const goal = (o = {}) => ({
  id: 1, name: 'Goal', target_amount: 1000000, target_date: null, account_id: 'a1', account: 'Savings', account_balance: 0,
  progress_basis: 'account_balance', progress: 0, remaining: 1000000, pct: 0, cycles_left: null, per_cycle_needed: null, planned_per_cycle: null, on_track: null, done: false, ...o,
});
const one = (o) => M.goalsOverview([goal(o)], { today: TODAY }).goals[0];

test('no target is its own state, whatever is saved', () => {
  const v = one({ target_amount: null, progress: 12345 });
  assert.equal(v.status, 'no_target');
  assert.equal(v.label, 'No target set');
  assert.equal(v.pct, null);
  assert.equal(v.saved, 12345);
  assert.match(M.goalWords(v, fmt).headline, /No target yet/);
});

test('saved at or past the target is reached, and nothing more is asked of it', () => {
  const v = one({ target_amount: 50000, progress: 60000, remaining: 0, pct: 100, done: true, target_date: '2026-12-01', per_cycle_needed: 0, planned_per_cycle: 0 });
  assert.equal(v.status, 'reached');
  assert.equal(v.pct, 100);
  assert.match(M.goalWords(v, fmt).headline, /\$100 past the target/);
  assert.equal(M.goalWords(v, fmt).monthlyNote, 'Goal reached, so nothing more is needed.');
});

test('a pay split amount that covers the date is on track, one that does not is behind', () => {
  // 20,000 a cycle needed, 26 / 12 a month.
  const base = { target_amount: 60000, target_date: '2026-12-01', progress: 10000, remaining: 50000, pct: 17, cycles_left: 3, per_cycle_needed: 20000 };
  const ok = one({ ...base, planned_per_cycle: 20000 });
  assert.equal(ok.status, 'on_track');
  assert.equal(ok.monthly.month, Math.round(20000 * 26 / 12));
  assert.equal(ok.needMonth, Math.round(20000 * 26 / 12));
  const short = one({ ...base, planned_per_cycle: 15000 });
  assert.equal(short.status, 'behind');
  assert.match(M.goalWords(short, fmt).headline, /Needs about \$433 a month to reach it by 1 Dec 2026, \$108 more than the pay split puts in/);
  // The same call the API makes with on_track.
  assert.equal(ok.status === 'on_track', true);
});

test('a date that has passed is behind, with or without a monthly amount', () => {
  const v = one({ target_date: '2026-10-01', progress: 5000, remaining: 995000, pct: 1, cycles_left: 0, per_cycle_needed: 995000, planned_per_cycle: null });
  assert.equal(v.status, 'behind');
  assert.equal(v.overdue, true);
  assert.match(M.goalWords(v, fmt).headline, /1 Oct 2026, has passed/);
});

test('no date and a monthly amount above zero is on track, with months to the target', () => {
  const v = one({ target_amount: 1000000, progress: 400000, remaining: 600000, pct: 40, planned_per_cycle: 50000 });
  assert.equal(v.status, 'on_track');
  const month = Math.round(50000 * 26 / 12);
  assert.equal(v.monthsToTarget, Math.ceil(600000 / month));
  assert.equal(v.reachDate, M.addMonthsIso(TODAY, v.monthsToTarget));
  assert.match(M.goalWords(v, fmt).monthlyNote, /About \d+ months? to the target, around [A-Z][a-z]{2} \d{4}/);
});

test('nothing saved and no monthly amount is not funded yet, saved but no monthly amount is no_pace', () => {
  assert.equal(one({ progress: 32, remaining: 999968, pct: 0 }).status, 'not_funded');
  const v = one({ progress: 300000, remaining: 700000, pct: 30, target_date: '2027-10-18', cycles_left: 26, per_cycle_needed: 26923 });
  assert.equal(v.status, 'no_pace');
  assert.equal(v.monthly.kind, 'unset');
  assert.equal(M.goalWords(v, fmt).monthly, 'Not set');
  assert.match(M.goalWords(v, fmt).headline, /Set a monthly amount to see if you are on track/);
});

test('a pay split of zero is a known amount, so a dated goal on it is behind', () => {
  const v = one({ target_date: '2027-10-18', per_cycle_needed: 4999, cycles_left: 26, progress: 50000, remaining: 950000, pct: 5, planned_per_cycle: 0 });
  assert.equal(v.status, 'behind');
  assert.equal(M.goalWords(v, fmt).monthly, '$0 a month');
});

test('a manual goal has no account and says so', () => {
  const v = one({ account_id: null, account: null, account_balance: null, progress_basis: 'contributions', progress: 20000, remaining: 980000, pct: 2 });
  assert.equal(v.account, null);
  assert.equal(v.manual, true);
  assert.equal(v.monthly.kind, 'no_account');
  assert.equal(M.goalWords(v, fmt).account, 'No account linked');
  assert.match(M.goalWords(v, fmt).monthlyNote, /Link an account/);
});

test('the account name and its balance come from the linked account', () => {
  const v = one({ account: 'Bills', account_balance: 123456, progress: 123456 });
  assert.deepEqual({ ...v.account }, { id: 'a1', name: 'Bills', balance: 123456, sharedWith: 0 });
  assert.equal(M.goalWords(v, fmt).account, 'Bills, $1,235');
  // A negative balance reads as nothing saved, as the progress does.
  assert.equal(one({ account_balance: -500 }).account.balance, 0);
  // Data saved before the API sent the balance falls back to the progress.
  assert.equal(one({ account_balance: undefined, progress: 777 }).account.balance, 777);
});

test('goals sharing an account split nothing, count the balance once and compare the line with what they need together', () => {
  const mk = (id, extra) => goal({ id, account_balance: 100000, progress: 100000, planned_per_cycle: 25000, ...extra });
  const items = [
    mk(1, { target_amount: 1000000 }),
    mk(2, { target_amount: 600000, target_date: '2026-12-01', per_cycle_needed: 10000 }),
    mk(3, { target_amount: 1300000, target_date: '2027-10-18', per_cycle_needed: 5000 }),
  ];
  const o = M.goalsOverview(items, { today: TODAY });
  assert.equal(o.summary.saved, 100000); // not 300000
  assert.equal(o.summary.monthly, Math.round(25000 * 26 / 12)); // the line once
  assert.equal(o.goals[1].account.sharedWith, 2);
  assert.equal(o.goals[1].monthly.kind, 'shared');
  assert.equal(o.goals[1].monthsToTarget, null); // the line is not divided between goals
  // 25,000 a cycle covers 10,000 + 5,000 together.
  assert.deepEqual(o.goals.map((v) => v.status), ['on_track', 'on_track', 'on_track']);
  items[1].planned_per_cycle = items[2].planned_per_cycle = items[0].planned_per_cycle = 12000;
  const short = M.goalsOverview(items, { today: TODAY });
  assert.deepEqual(short.goals.map((v) => v.status), ['on_track', 'behind', 'behind']);
  assert.match(M.goalWords(short.goals[1], fmt).headline, /Together the dated goals on this account need about \$325 a month, \$65 more/);
});

test('the goal that needs a look first is the nearest dated one that is behind or unfunded', () => {
  const items = [
    goal({ id: 1, name: 'Done', target_amount: 100, progress: 100, done: true, account_id: null }),
    goal({ id: 2, name: 'Far', target_date: '2027-10-18', per_cycle_needed: 4999, cycles_left: 26, account_id: 'b' }),
    goal({ id: 3, name: 'Near', target_date: '2026-12-01', per_cycle_needed: 19990, cycles_left: 3, account_id: 'c' }),
    goal({ id: 4, name: 'Open', account_id: 'd' }),
    goal({ id: 5, name: 'Late', target_date: '2026-10-01', per_cycle_needed: 900000, account_id: 'e' }),
  ];
  const o = M.goalsOverview(items, { today: TODAY });
  assert.equal(o.focusId, 5); // behind beats not funded
  assert.deepEqual(o.order, [5, 3, 2, 4, 1]);
  // Nothing needing attention: no featured card.
  const calm = M.goalsOverview([goal({ id: 1, target_amount: null }), goal({ id: 2, target_amount: 100, progress: 100, done: true, account_id: 'z' })], { today: TODAY });
  assert.equal(calm.focusId, null);
});

test('the summary counts each status and says it kindly', () => {
  const o = M.goalsOverview([
    goal({ id: 1, account_id: 'a', target_date: '2027-10-18', per_cycle_needed: 5000, planned_per_cycle: 6000, progress: 50000 }),
    goal({ id: 2, account_id: 'b', target_date: '2027-10-18', per_cycle_needed: 5000, planned_per_cycle: 100, progress: 50000 }),
    goal({ id: 3, account_id: 'c', target_amount: null }),
  ], { today: TODAY });
  const s = o.summary;
  assert.equal(s.total, 3);
  assert.equal(s.counts.on_track, 1);
  assert.equal(s.counts.behind, 1);
  assert.equal(s.counts.no_target, 1);
  assert.equal(s.saved, 100000);
  assert.equal(s.monthly, Math.round(6000 * 26 / 12) + Math.round(100 * 26 / 12));
  assert.equal(s.headline, '1 goal is behind plan, 1 on track. Goal is the one to look at first.');
  assert.ok(!/[—–]/.test(s.headline));
});

test('no monthly amount anywhere is null, never zero', () => {
  const s = M.goalsOverview([goal({ id: 1 }), goal({ id: 2, account_id: null })], { today: TODAY }).summary;
  assert.equal(s.monthly, null);
  assert.equal(M.goalsOverview([], { today: TODAY }).summary.total, 0);
  assert.equal(M.goalsOverview(undefined, { today: TODAY }).goals.length, 0);
});

test('headlines for every mix, and no dash in any word the cards use', () => {
  const sum = (items) => M.goalsOverview(items, { today: TODAY }).summary.headline;
  assert.equal(sum([goal({ target_amount: 100, progress: 100, done: true })]), 'Goal reached. Nicely done.');
  assert.equal(sum([goal({ id: 1 }), goal({ id: 2, account_id: 'q' })]), 'Nothing is behind. Goal is a good one to get moving first.');
  assert.equal(sum([goal({ target_amount: null })]), 'Set a target on a goal and Mint will track the pace.');
  const words = [];
  for (const o of [{}, { target_amount: null }, { planned_per_cycle: 100 }, { account_id: null, account: null }, { target_date: '2026-10-01' }]) words.push(...Object.values(M.goalWords(one(o), fmt)));
  assert.ok(words.every((w) => !/[—–]/.test(w)));
});

test('months on a calendar clamp to the end of the month', () => {
  assert.equal(M.addMonthsIso('2026-01-31', 1), '2026-02-28');
  assert.equal(M.addMonthsIso('2026-11-15', 3), '2027-02-15');
  assert.equal(M.addMonthsIso('2026-10-20', 0), '2026-10-20');
  assert.equal(M.monthsWords(14), '1 year 2 months');
  assert.equal(M.monthsWords(0), 'under a month');
});

test('GET /api/goals carries the linked account balance, and null with no account', () => {
  const b = book();
  const linked = createGoal(b.db, { name: 'Linked', target_amount: 500000, account_id: 'acct_t_savings' });
  const manual = createGoal(b.db, { name: 'Manual', target_amount: 500000 });
  const items = listGoals(b.db, { today: TODAY });
  const bal = b.db.prepare("SELECT balance_current FROM accounts WHERE id = 'acct_t_savings'").get().balance_current;
  assert.equal(items.find((g) => g.id === linked.id).account_balance, bal ?? null);
  assert.equal(items.find((g) => g.id === manual.id).account_balance, null);
});
