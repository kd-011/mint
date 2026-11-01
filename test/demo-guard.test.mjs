// Source-level guards for demo mode (pattern: home-no-cash-to-payday.test.mjs).
// The page is vanilla scripts with no DOM in the test runner, so these read the
// sources. Every dollar on screen must come out of core.js's formatters, which
// are the one place the demo factor is applied; a screen that formats currency
// itself would show a real figure with demo on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const scripts = readdirSync(PUB).filter((f) => f.endsWith('.js') && f !== 'sw.js');
// core.js owns the formatters; demo-math.js and ux-model.js hold pure text with no currency formatting of their own.
const OWNERS = new Set(['core.js', 'demo-math.js']);
const others = scripts.filter((f) => !OWNERS.has(f));

const code = (f) => read('public', f).split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

test('no screen formats currency itself: Intl currency, a literal $ before an interpolation, US$ and toLocaleString with money options are core.js only', () => {
  const bad = [];
  for (const f of others) {
    const s = code(f);
    for (const re of [/Intl\.NumberFormat/, /\bAUD0?\.format/, /style:\s*'currency'/, /currency:\s*'/, /\$\$\{/, /US\$/, /'\$'\s*\}/, /\/\s*100\)\.toFixed\(/, /toFixed\(2\)[^\n]*\$/]) {
      if (re.test(s)) bad.push(`${f}: ${re}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the shared formatters in core.js all go through the demo scaler', () => {
  const core = code('core.js');
  for (const name of ['money', 'money0', 'signed', 'compact', 'unitPrice', 'centsToInput']) {
    const line = core.split('\n').find((l) => new RegExp(`^(const|function) ${name}\\b`).test(l));
    assert.ok(line, `${name} exists in core.js`);
  }
  assert.match(core, /const money = .*demoCents/);
  assert.match(core, /const money0 = .*demoCents/);
  assert.match(core, /const signed = .*demoCents/);
  assert.match(core, /function compact\(cents\)[\s\S]{0,120}demoCents/);
  assert.match(core, /const centsToInput = .*demoCents/);
});

test('shares.js prices go through unitPrice, not a local currency formatter', () => {
  const sh = code('shares.js');
  assert.match(sh, /unitPrice\(/);
  assert.doesNotMatch(sh, /const shPrice = .*toLocaleString/);
});

test('every write has one choke point: fetch with a body or a non-GET method is in core.js, or guarded by demoActive()', () => {
  const bad = [];
  for (const f of others) {
    const s = code(f);
    for (const m of s.matchAll(/fetch\(([^)]*)\)/g)) {
      const call = m[0];
      const writes = /method:\s*'(POST|PUT|PATCH|DELETE)'/.test(call) || /method:\s*(?!'GET')\w/.test(call);
      if (writes && !/demoActive\(\)/.test(s)) bad.push(`${f}: ${call.slice(0, 60)}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.match(code('chat.js'), /demoActive\(\)/);
});

test('core.js blocks writes in apiCall, mutate, undoable, queue and the receipt queue', () => {
  const core = code('core.js');
  assert.match(core, /async function apiCall[\s\S]{0,400}demoWriteBlocked/);
  assert.match(core, /async function mutate[\s\S]{0,300}demoGuard/);
  assert.match(core, /function undoable[\s\S]{0,300}demoGuard/);
  assert.match(core, /push\(op\)[\s\S]{0,200}demoActive\(\)/);
  assert.match(core, /async flush\(\)[\s\S]{0,300}demoActive\(\)/);
  assert.match(core, /Turn off demo mode|DEMO_BLOCKED_MSG/);
});

test('server-written sentences with dollars in them are scaled where they are drawn', () => {
  assert.match(code('accounts.js'), /moneyText\(a\.(title|body)|moneyText\(/);
  assert.match(code('taxest.js'), /moneyText\(/);
  assert.match(code('plan.js'), /moneyText\(/);
});

test('account numbers and last-4 digits are masked where an account is drawn', () => {
  assert.match(code('accounts.js'), /acctText\(a\.number_masked/);
  assert.match(code('core.js'), /const accountName = .*acctText/);
  assert.match(code('transactions.js'), /acctText\(/);
});

test('search results show no amounts in demo mode, and chat is out of reach', () => {
  const s = code('search.js');
  assert.match(s, /demoActive\(\)/);
  assert.match(code('home.js'), /demoActive\(\)/);
  assert.match(code('chat.js'), /demoActive\(\)/);
  assert.match(code('app.js'), /mint:demo/);
});

test('demo-math.js has no DOM and no storage of its own, so it runs under node', () => {
  const s = code('demo-math.js');
  assert.doesNotMatch(s, /document\.|localStorage|window\./);
  assert.match(s, /module\.exports/);
});
