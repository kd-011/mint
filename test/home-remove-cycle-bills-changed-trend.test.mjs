// Owner, 2026-10-20: "Remove all these cards". Home is net worth, the accounts card, the totals, the quick actions
// and the sync strip (plus the cash-short nudge, which only shows when cash will not cover the bills). The This
// cycle, Bills still due, What changed and Net worth trend cards are gone from the page; their screens and APIs
// stay. Days to payday stays on Home ("keep days till payday somewhere"). The page is vanilla scripts with no DOM
// in the test runner, so these read the sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const home = read('public', 'home.js');
const slots = /const slots = \[([^\]]+)\]/.exec(home)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));

test('Home no longer renders cycleBlock, billsBlock, insightsBlock or nwChartBlock', () => {
  assert.doesNotMatch(home, /cycleBlock|billsBlock|insightsBlock|nwChartBlock|catRowHtml|paintCycle|paintBills|paintInsights|NW_RANGES|nwrange|nwplot|wireSeg|mountLine/);
});

test('Home no longer loads /api/insights/cycle, /api/bills or /api/networth/history', () => {
  assert.doesNotMatch(home, /\/api\/insights\/cycle|\/api\/bills|\/api\/networth\/history/);
  assert.match(home, /\/api\/networth'/);
});

test('Home keeps net worth, the accounts card, the totals, quick actions, the sync strip and the cash-short nudge', () => {
  assert.deepEqual(slots, ['health', 'nw', 'accts', 'bals', 'actions', 'sync', 'cash']);
  assert.match(home, /\/api\/safe-to-spend/);
  assert.match(home, /cashBlock/);
});

test('the two-column split keyed on the cycle slot is gone', () => {
  assert.doesNotMatch(home, /indexOf\('cycle'\)|hcols|hcol-b/);
  assert.doesNotMatch(read('public', 'style.css'), /#view\.is-home\{/);
});

test('days to payday still shows on Home, from a light /api/budgets read', () => {
  assert.match(home, /to payday/);
  assert.match(home, /Payday today/);
  assert.match(home, /days_late/);
  assert.match(home, /\/api\/budgets/);
});

test('the pages and APIs behind the removed cards stay', () => {
  for (const f of ['public/budgets.js', 'public/plan.js', 'lib/insights.mjs']) assert.ok(existsSync(join(ROOT, f)), f);
  const api = read('server.mjs') + read('lib', 'api.mjs');
  for (const r of ['/api/budgets', '/api/bills', '/api/insights/cycle', '/api/networth/history']) assert.ok(api.includes(r), r);
});

test('the Home-only insights card script and its row styles are gone, nothing else loses them', () => {
  assert.equal(existsSync(join(ROOT, 'public', 'insights.js')), false);
  assert.doesNotMatch(read('server.mjs'), /'insights\.js'/);
  assert.doesNotMatch(read('public', 'style.css'), /\.ins-(row|ic|v|new|pills|list|more|sub)\b/);
});
