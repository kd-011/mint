// The declutter pass: no explanatory paragraphs on the screens, denser cards,
// and every chart after the numbers and lists on its screen. The page is vanilla
// scripts in one global scope with no DOM in the test runner, so these read the
// sources: banned hint copy, the slot orders, and the shared card CSS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const src = (f) => readFileSync(join(PUB, f), 'utf8');
const SCREENS = ['home.js', 'transactions.js', 'budgets.js', 'income.js', 'plan.js', 'save.js', 'tax.js', 'taxest.js', 'accounts.js', 'reports.js', 'subs.js', 'shares.js', 'more.js', 'owed.js', 'homesync.js'];

// Copy that explains how a number is computed or where else to look.
const HINTS = [
  'Only interest credits count',
  'Net saved over income, personal only',
  'The latest column is this month so far',
  'A goal tracks an account',
  'Interest is worked out on the balance less the offset',
  'Value is what the holdings were worth on the day',
  'Cash is your bank balances and super is its latest value',
  'Slide to see the new payoff date',
  'Slide to see the payoff date and interest',
  'Loan balance if the repayment and rate stay as they are',
  'Mint shows and plans; it never moves money',
  'Mint plans and checks; it never moves money',
  'Income is salary plus these regular payers',
  'Friends paying you back. They reduce',
  'Gifts, interest, cashback: shown here',
  'Re-runs the maths over your last 6 pay cycles',
  'Looking for a calendar month?',
  'Each cycle target counts as 26 / 12',
  'netted off and transfers left out, the same way the budget counts',
  'Per day is the safe amount over the days left',
  'Pulls the latest from every bank',
  'On the middle estimate, the balance goes under your floor',
  'A quick monthly value keeps net worth honest',
  'One zip: summary, deductions and business CSVs',
  'A tally of money owed to you, kept by hand',
  'Off your bills, forecast and alerts. Tap one to put it back',
  'Tap or hover a bar or the line for the exact figures',
  'Worked out from where your last paydays went',
];

test('no explanatory hint paragraphs are left on the screens', () => {
  const found = [];
  for (const f of SCREENS) for (const h of HINTS) if (src(f).includes(h)) found.push(`${f}: ${h}`);
  assert.deepEqual(found, []);
});

test('no em dashes in screen copy', () => {
  for (const f of [...SCREENS, 'style.css']) assert.ok(!src(f).includes('—'), f);
});

const listOf = (text, re) => [...re.exec(text)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('Home: no chart or card list below the accounts, only the cash-short nudge is last', () => {
  const slots = listOf(src('home.js'), /const slots = \[([^\]]+)\]/);
  assert.equal(slots.at(-1), 'cash');
  for (const gone of ['nwchart', 'cycle', 'bills', 'insights']) assert.ok(!slots.includes(gone), gone);
});

test('Income: stats, streams and deposits come before the charts', () => {
  const slots = listOf(src('income.js'), /const SLOTS = \[([^\]]+)\]/);
  assert.deepEqual(slots.slice(-3), ['salary', 'flow', 'fy']); // the income by financial year chart is the third chart
  assert.ok(slots.indexOf('streams') < slots.indexOf('salary'));
});

test('Save: one charts section, last, holds every chart', () => {
  const s = src('save.js');
  const first = s.indexOf('<section class="svsec" id="sv-savings"');
  const charts = s.indexOf('id="sv-charts"');
  assert.ok(first > -1 && charts > first);
  assert.ok(charts > s.indexOf('id="sv-loan"'), 'charts after the loan section');
  // No chart card is built inside a numbers section's innerHTML.
  assert.ok(!/<section class="card">[^`]*\$\{chartCard/.test(s));
});

test('Reports: the merchant list comes before the charts', () => {
  const r = src('reports.js');
  const box = r.slice(r.indexOf('box.innerHTML = ['));
  assert.ok(box.indexOf("id=\"c-merch\"") < box.indexOf("id: 'c-spend'"));
});

test('cards are dense: padding at most 16px, gaps at most 10px', () => {
  const css = src('style.css');
  const last = (re) => [...css.matchAll(re)].pop()?.[1];
  assert.ok(Number(last(/\.card\{[^}]*?padding:(\d+)px/g)) <= 16, 'card padding');
  assert.ok(Number(last(/\.card\+\.card\{margin-top:(\d+)px/g)) <= 10, 'card gap');
  assert.ok(Number(last(/\.stat\{[^}]*?padding:(\d+)px/g)) <= 10, 'stat padding');
});

test('tappable rows keep a 44px target', () => {
  const css = src('style.css');
  const mins = [...css.matchAll(/\.row\{[^}]*?min-height:(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(mins.length && Math.min(...mins) >= 44);
});
