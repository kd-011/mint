// The page loads every public script as a classic script into one global
// scope, so two files declaring the same top-level name silently override each
// other (save.js once redefined plan.js's loanCard and broke the debt card).
// Reads the script list the server serves and asserts no top-level name is
// declared twice across them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = /const SCRIPTS = \[([^\]]+)\]/.exec(readFileSync(join(ROOT, 'server.mjs'), 'utf8'))[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));

// Names declared at column 0: functions, classes, const/let/var (including destructured).
function topLevelNames(src) {
  const names = [];
  for (const line of src.split('\n')) {
    let m = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line) ?? /^class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) { names.push(m[1]); continue; }
    m = /^(?:const|let|var)\s+(.+?)(?:=|$)/.exec(line);
    if (!m) continue;
    const lhs = m[1].trim();
    if (/^[{[]/.test(lhs)) names.push(...(lhs.match(/[A-Za-z_$][\w$]*/g) ?? []));
    else names.push(/^[A-Za-z_$][\w$]*/.exec(lhs)?.[0]);
  }
  return names.filter(Boolean);
}

test('no top-level name is declared in two of the public scripts', () => {
  assert.ok(scripts.length > 10 && scripts.includes('save.js') && scripts.includes('plan.js'));
  const seen = new Map();
  const clashes = [];
  for (const f of scripts) {
    for (const n of new Set(topLevelNames(readFileSync(join(ROOT, 'public', f), 'utf8')))) {
      if (seen.has(n)) clashes.push(`${n} in ${seen.get(n)} and ${f}`);
      else seen.set(n, f);
    }
  }
  assert.deepEqual(clashes, []);
});

test('the checker itself catches a clash', () => {
  assert.deepEqual(topLevelNames('function a() {}\nconst b = 1;\nlet { c, d } = x;\n  function inner() {}\nasync function e() {}'), ['a', 'b', 'c', 'd', 'e']);
});
