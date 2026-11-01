// Small fixes from the improvement pass that the page has no DOM test harness for:
// each reads the source the way declutter.test.mjs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', f), 'utf8');

test('a sheet is named by its own title, so a screen reader says which one opened', () => {
  assert.match(read('core.js'), /setAttribute\('aria-labelledby', title\.id\)/);
});

test('closing a sheet hands focus back to what opened it', () => {
  const core = read('core.js');
  assert.match(core, /if \(root\.hidden\) opener = /);
  assert.match(core, /opener\.focus\(\{ preventScroll: true \}\)/);
});

test('subscription rows carry no per-row origin chip and no cadence word the amount already says', () => {
  const subs = read('subs.js');
  assert.ok(!subs.includes('Added by you'));
  assert.match(subs, /it\.cadence === 'monthly' \? 'Next'/);
});

test('the transaction swipe actions leave a 44px target', () => {
  const m = /\.swipe-bg\{[^}]*padding:(\d+)px/.exec(read('style.css'));
  assert.ok(m && Number(m[1]) <= 2, 'the buttons fill the row, not a 36px strip of it');
});

test('code removed as unused stays removed', () => {
  assert.ok(!read('core.js').includes('const sourceChip'));
  assert.ok(!read('charts.js').includes('function sparkline'));
  assert.ok(!read('homesync.js').includes('coarsePointer'));
});

test('a day count reads as one day, not 1 days', async () => {
  const { default: vm } = await import('node:vm');
  const core = read('core.js');
  const ctx = { todayIso: () => '2026-10-20' };
  vm.createContext(ctx);
  vm.runInContext(core.slice(core.indexOf('function inDays('), core.indexOf('const titleCase')), ctx);
  const at = (iso) => vm.runInContext(`inDays('${iso}')`, ctx);
  assert.equal(at('2026-10-20'), 'today');
  assert.equal(at('2026-10-21'), 'tomorrow');
  assert.equal(at('2026-10-19'), 'yesterday');
  assert.equal(at('2026-10-17'), '3 days ago');
  assert.equal(at('2026-10-23'), 'in 3 days');
  const acc = read('accounts.js');
  assert.ok(!/consent_days\} days/.test(acc), 'consent days use plural()');
});

test('the Home tile that opens the ledger is called what the screen and the More list call it', () => {
  const tile = /\{ id: 'owed', label: '([^']+)'/.exec(read('ux-model.js'))[1];
  const route = /'\/owed': \{[^}]*title: '([^']+)'/.exec(read('routes.js'))[1];
  assert.equal(tile, route);
});
