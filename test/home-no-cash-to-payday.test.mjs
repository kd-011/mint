// Owner, 2026-10-19: "remove cash to payday, it's stupid". The Home card, its
// chart and its sheet are gone from the page; the server-side forecast stays
// because the assistant mint_forecast tool reads it. The page is vanilla scripts
// with no DOM in the test runner, so these read the sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const require = createRequire(import.meta.url);

test('Home no longer renders, loads or opens the Cash to payday card', () => {
  const home = read('public', 'home.js');
  assert.doesNotMatch(home, /Cash to payday/i);
  assert.doesNotMatch(home, /forecastBlock|forecastChartBlock|openForecastSheet|fcChart|data-fc-open/);
  assert.doesNotMatch(home, /\/api\/forecast/);
  assert.doesNotMatch(home, /'forecast'|'fcchart'/);
});

test('the card and sheet script is gone from the shell, and so is its styling and sentence builder', () => {
  assert.equal(existsSync(join(ROOT, 'public', 'forecast.js')), false);
  assert.doesNotMatch(read('server.mjs'), /forecast\.js/);
  assert.doesNotMatch(read('public', 'style.css'), /cash to payday forecast|\.fc-head|\.fc-sent|\.fc-est|\.fcplot|\.fc-warn|\.fc-floor|\.fc-assume/);
  const { UxModel: M } = require('../public/ux-model.js');
  assert.equal(M.cashToPayday, undefined);
  assert.equal(typeof M.cycleSummary, 'function'); // the rest of the Home sentences stay
});

test('days to payday shows on the net worth card', () => {
  assert.match(read('public', 'home.js'), /to payday/);
});

test('the server-side forecast and its routes are kept for the assistant mint_forecast tool', () => {
  for (const f of ['lib/forecast.mjs', 'lib/forecastmath.mjs']) assert.ok(existsSync(join(ROOT, f)), f);
  assert.match(read('server.mjs') + read('lib', 'api.mjs'), /\/api\/forecast|forecast/);
  assert.match(read('lib', 'assistant.mjs'), /forecast/);
});

test('Home keeps its remaining slots in order with no orphan heading', () => {
  const home = read('public', 'home.js');
  const slots = /const slots = \[([^\]]+)\]/.exec(home)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(slots, ['health', 'nw', 'accts', 'bals', 'actions', 'sync', 'cash']);
  // The This cycle card is gone, so is the two-column flow that started at it.
  assert.doesNotMatch(home, /slots\.indexOf\('cycle'\)/);
});

// Owner, 2026-10-19: "remove needs a look from home". Review items and alerts
// still live on Accounts, Review; Home only keeps the review count for the
// Categorise quick action badge.
test('Home no longer renders the Needs a look card, alerts or review rows', () => {
  const home = read('public', 'home.js');
  assert.doesNotMatch(home, /Needs a look|reviewBlock|paintReview|data-adismiss|\/api\/alerts|\/api\/assets/);
  assert.match(home, /\/api\/review/);
});

// Owner, 2026-10-19: "make this screen look better, remove unnecessary hints".
test('Home carries no pace sentence, key or explainer paragraph', () => {
  const home = read('public', 'home.js');
  assert.doesNotMatch(home, /pkey|pk-tick|pk-mark|even pace|categoryWhy|sum\.pace/);
  assert.match(read('public', 'style.css'), /\.bals \.stat:last-child:nth-child\(odd\)/);
});

// Owner, 2026-10-19: "Remove these three but keep days till payday somewhere".
test('Home drops the safe to spend cockpit, Pay split and Last week, keeps the cash-short nudge and days to payday', () => {
  const home = read('public', 'home.js');
  assert.doesNotMatch(home, /cockpitBlock|emptyCockpit|splitBlock|SPLIT_CHIP|paintWeekly|paintSplit|cp-open|payLine/);
  assert.doesNotMatch(home, /\/api\/plan\/status|\/api\/summary\/weekly/);
  assert.match(home, /\/api\/safe-to-spend/);
  assert.match(home, /cash: \(\) => swr/);
  assert.match(home, /loads\.cash\(\)/);
  assert.match(home, /paydayText/);
  assert.match(home, /to payday/);
  assert.doesNotMatch(read('public', 'style.css'), /\.cp-(top|ring|pills|toggle)|\.hero\.cockpit|\.spill/);
});
