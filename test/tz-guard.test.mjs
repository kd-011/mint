// lib/dates.mjs is the only module allowed to name a timezone or a fixed UTC offset. Everything
// else asks it for the configured zone (MINT_TZ), so a Sydney user is never silently on Perth time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['lib/dates.mjs']);
const SKIP_DIRS = new Set(['node_modules', 'kit', 'vendor', 'android-shell', 'data', 'backups', '.git']);

// A zone name (Region/City), a fixed offset such as +08:00 or UTC+8, or a Perth-named helper.
export const PATTERNS = [
  [/\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Z][A-Za-z_]+/, 'zone name'],
  [/[+-](?:0[0-9]|1[0-4]):[0-5]\d(?![\d:])(?=['"`\s)\]}]|$)/, 'fixed offset'],
  [/UTC ?[+-] ?\d/, 'UTC offset'],
  [/\b8\s*\*\s*3600\b|\b28800\b/, 'eight hour assumption'],
  [/\bperth[A-Z]\w*|\bPERTH(?:_[A-Z]+)?(?=\s*(?:=|\.|\(|,|;|\)|\]|\}))/, 'Perth-named identifier'],
];

export function scan(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const [re, what] of PATTERNS) if (re.test(line)) hits.push(`line ${i + 1}: ${what}: ${line.trim().slice(0, 100)}`);
  });
  return hits;
}

function files(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(mjs|js|html|webmanifest)$/.test(n)) out.push(p);
  }
  return out;
}

test('the scanner flags a zone name, an offset, a UTC offset and a Perth-named helper', () => {
  assert.equal(scan("new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth' })").length, 1);
  assert.equal(scan("new Date(`${d}T00:00:00.000+08:00`)").length, 1);
  assert.equal(scan('// UTC+8 all year').length, 1);
  assert.equal(scan('const PERTH = fmt;').length, 1);
  assert.equal(scan('const t = perthDate();').length, 1);
  assert.equal(scan('const ms = 8 * 3600 * 1000;').length, 1);
  assert.deepEqual(scan("const d = '2026-10-04T00:00:00Z'; // WOOLWORTHS PERTH WA"), []);
});

test('no module other than lib/dates.mjs names a zone or a fixed offset', () => {
  const bad = [];
  for (const dir of ['lib', 'scripts', 'public', 'server.mjs']) {
    const p = join(ROOT, dir);
    for (const f of statSync(p).isDirectory() ? files(p) : [p]) {
      const rel = relative(ROOT, f);
      if (ALLOWED.has(rel)) continue;
      for (const h of scan(readFileSync(f, 'utf8'))) bad.push(`${rel} ${h}`);
    }
  }
  assert.deepEqual(bad, []);
});
