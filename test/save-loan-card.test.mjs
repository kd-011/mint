// The Save tab's home loan card is two things: what the offset saves, and the
// Pay extra each month calculator. The page is vanilla scripts with no DOM in
// the test runner, so these read save.js the way declutter.test.mjs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const save = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'save.js'), 'utf8');
const start = save.indexOf('function homeLoanCard(');
const card = save.slice(start, save.indexOf('async function saveLoan(', start));

test('card is cut down: no balance, kvs rows or payoff block', () => {
  assert.ok(start > 0 && card.length > 100, 'homeLoanCard found');
  for (const gone of ['Effective balance after offset', 'Interest a month', 'Interest a year', 'Interest the offset saves', 'What you pay', 'loanPaidRows', 'loanPayoffHtml', 'cardHead(', 'big2 num">${esc(money0(l.balance))', '>Payoff<', 'class="kvs"']) {
    assert.ok(!card.includes(gone), `card must not contain ${gone}`);
  }
  assert.ok(!save.includes('function loanPayoffHtml'), 'loanPayoffHtml is deleted');
});

test('pay extra calculator is intact, first loan only', () => {
  assert.match(card, /first \? `<h3 class="sub-h">Pay extra each month<\/h3>/);
  for (const needle of ['id="extra"', 'id="extra-val"', 'id="extra-out"', 'aria-describedby="extra-out"', 'loanExtraHtml(l)']) assert.ok(card.includes(needle), needle);
});

test('offset saving block: yearly lead figure, monthly, balance, per-$10,000 rule', () => {
  assert.ok(card.includes('saved_by_offset_per_year') && card.includes('saved_by_offset_per_month'));
  assert.ok(card.includes('in your offset'));
  assert.ok(card.includes('Every $10,000 in offset saves'));
  assert.ok(card.includes('1000000 * l.rate.value'), 'rule is computed from the rate (cents)');
  assert.ok(card.includes('a year') && card.includes('a month'));
});

test('offset edge cases still shown, missing-details prompt only when something is missing', () => {
  assert.ok(card.includes('No offset on this loan') && card.includes('No offset account found'));
  assert.match(card, /l\.missing\.length\s*\?/);
  assert.ok(!card.includes('Details you entered'));
  assert.ok(save.includes('const MISSING_WORDS') && card.includes('MISSING_WORDS'));
});
