// v2 screens added Income, Plan, cycle budgets and the pay-cycle Home. The nav
// itself follows the owner's plan-hll10n decision: Home, Spending, Save and Invest,
// Tax, More. Income and Plan keep their screens and sit under More.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const { MINT_TABS, MORE_ITEMS, SHELL_PATHS, resolveRoute } = createRequire(import.meta.url)(join(PUB, 'routes.js'));

test('the dock is Home, Spending, Save and Invest, Tax, More', () => {
  assert.deepEqual(MINT_TABS.map((t) => t.id), ['home', 'spending', 'save', 'more']);
  assert.deepEqual(MINT_TABS.map((t) => t.label), ['Home', 'Spending', 'Save and Invest', 'More']);
  for (const t of MINT_TABS) assert.ok(resolveRoute(t.href).view, t.id);
});

test('Income and Plan keep their routes and titles, under More', () => {
  assert.equal(resolveRoute('/income').tab, 'more');
  assert.equal(resolveRoute('/income').view, 'income');
  assert.equal(resolveRoute('/plan').tab, 'more');
  assert.equal(resolveRoute('/plan').view, 'plan');
  assert.equal(resolveRoute('/income').title, 'Income');
  assert.equal(resolveRoute('/plan', '?s=debt').redirect, undefined);
  assert.ok(MORE_ITEMS.some((i) => i.href === '/income'));
  assert.ok(MORE_ITEMS.some((i) => i.href === '/plan'));
});

test('Tax sits under More, still at /tax with its fy param', () => {
  const r = resolveRoute('/tax', '?fy=2026');
  assert.equal(r.view, 'tax');
  assert.equal(r.tab, 'more');
  assert.equal(r.parent, '/more');
  assert.ok(MORE_ITEMS.some((i) => i.href === '/tax'));
  for (const i of MORE_ITEMS) assert.equal(resolveRoute(i.href.split('?')[0], i.href.includes('?') ? `?${i.href.split('?')[1]}` : '').tab, 'more', i.label);
});

test('Save and Invest is /save with its sections; the old names redirect to it', () => {
  assert.equal(resolveRoute('/save').view, 'save');
  assert.equal(resolveRoute('/save', '?s=loan').redirect, undefined);
  assert.equal(resolveRoute('/invest').redirect, '/save');
  assert.equal(resolveRoute('/savings').redirect, '/save');
  assert.equal(resolveRoute('/', '', '#/save').redirect, '/save');
});

test('budgets keep the cycle and the monthly roll-up in the URL', () => {
  const c = resolveRoute('/budgets', '?cycle=2026-10-07');
  assert.equal(c.view, 'budgets');
  assert.equal(c.redirect, undefined);
  assert.equal(resolveRoute('/budgets', '?month=2026-09').view, 'budgets');
});

test('every path is in the shell list the server and worker use', () => {
  for (const p of ['/', '/transactions', '/budgets', '/income', '/plan', '/save', '/tax', '/more', '/accounts', '/reports']) assert.ok(SHELL_PATHS.includes(p), p);
});

test('the server lists the new screen scripts and the worker caches them', () => {
  const server = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const scripts = /const SCRIPTS = \[([^\]]+)\]/.exec(server)[1];
  for (const f of ['income.js', 'plan.js', 'cycle-math.js', 'save.js']) {
    assert.ok(scripts.includes(`'${f}'`), f);
    assert.ok(readdirSync(PUB).includes(f), `public/${f} exists`);
  }
  assert.ok(scripts.indexOf("'cycle-math.js'") < scripts.indexOf("'home.js'"), 'helpers load before the screens');
  assert.ok(scripts.indexOf("'plan.js'") < scripts.indexOf("'save.js'"), 'Save and Invest reuses the goal editor from plan.js');
});

test('front end guard rails: no inline styles in markup, no em dashes anywhere in public/', () => {
  for (const f of readdirSync(PUB).filter((n) => /\.(js|css|html)$/.test(n))) {
    const src = readFileSync(join(PUB, f), 'utf8');
    assert.ok(!src.includes('—'), `${f} has an em dash`);
    if (f.endsWith('.js')) assert.ok(!/\bstyle="/.test(src), `${f} has an inline style attribute (CSP forbids it)`);
  }
});
