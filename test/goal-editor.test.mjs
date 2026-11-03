// The goal sheets live at the top level of plan.js and are shared with Save and
// Invest. They once lost their closure and called a bare paint() on the offline
// path (ReferenceError). Everything they touch must come through ctx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'plan.js'), 'utf8');
const body = src.slice(src.indexOf('function openGoalEditor('), src.indexOf('\n// debt\n'));

test('shared goal editor and contribution sheet reach paint, load and the list only through ctx', () => {
  assert.ok(body.includes('function openContribution('), 'both sheets are in the slice');
  assert.doesNotMatch(body, /(^|[^.\w])(paint|load)\(/m, 'a bare paint() or load() has no closure here');
  assert.doesNotMatch(body, /(^|[^.\w])goals(\s*=[^=]|\.)/m, 'a bare goals list has no closure here');
  assert.match(body, /ctx\.paint\(\);\s*toast\('Saved offline/, 'the offline branch repaints through ctx');
});
