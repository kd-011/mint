// First run on Home: no accounts and no bank feed shows two clear choices
// (Redbark, or add an account and import a CSV), no hint paragraphs. The page is
// plain scripts with no DOM here, so the choices are a pure model
// (UxModel.firstRun) and the page is checked against the sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const { UxModel: M } = createRequire(import.meta.url)('../public/ux-model.js');

test('first run without a bank feed offers exactly two choices: Redbark, or an account and a CSV', () => {
  const f = M.firstRun({ redbark: false });
  assert.equal(f.choices.length, 2);
  const [rb, csv] = f.choices;
  assert.equal(rb.label, 'Connect banks with Redbark');
  assert.match(rb.href, /^https:\/\/github\.com\/kd-011\/mint\/blob\/main\/docs\/redbark-setup\.md$/);
  assert.equal(rb.external, true);
  assert.match(rb.line, /paid/i);
  assert.match(rb.line, /CDR/);
  assert.equal(csv.label, 'Add an account and import a CSV');
  assert.equal(csv.href, '/accounts?add=1');
  assert.ok(!csv.external);
  assert.ok(!('hint' in f) && !('paragraphs' in f), 'no hint paragraphs');
});

test('first run with the Redbark key set waits for the first sync instead of offering setup', () => {
  const f = M.firstRun({ redbark: true });
  assert.equal(f.choices.length, 1);
  assert.match(f.choices[0].label, /sync/i);
  assert.ok(!/redbark setup|paid/i.test(JSON.stringify(f)));
});

test('Home draws the empty state from that model, and the add link opens the account form', () => {
  const home = read('public', 'home.js');
  assert.match(home, /UxModel\.firstRun\(/);
  assert.doesNotMatch(home, /Connect a bank in Redbark and every account shows up here/);
  assert.match(read('public', 'accounts.js'), /get\('add'\)/);
});

test('screens that name Redbark in an empty state say something useful when there is no feed', () => {
  for (const f of ['plan.js', 'save.js']) {
    const s = read('public', f);
    assert.match(s, /sync\?\.redbark/, `${f} branches on the feed`);
  }
  const accounts = read('public', 'accounts.js');
  assert.match(accounts, /sync\?\.redbark|sync\.redbark/, 'the sync card and bank-accounts empty state follow the feed');
  const manual = read('public', 'manual.js');
  assert.match(manual, /sync\?\.redbark/);
});
