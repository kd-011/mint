// Transactions filter dropdowns: the pure grouping behind the Category and
// Account dropdowns (public/ux-model.js), and that the screen script is served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { UxModel: M } = require('../public/ux-model.js');

const cats = [
  { id: 1, name: 'Groceries', grp: 'Food', kind: 'expense' },
  { id: 2, name: 'Takeaway and delivery', grp: 'Food', kind: 'expense' },
  { id: 3, name: 'Fuel', grp: 'Transport', kind: 'expense' },
  { id: 4, name: 'Old thing', grp: 'Transport', kind: 'expense', archived: 1 },
  { id: 5, name: 'Salary', grp: 'Income', kind: 'income' },
  { id: 6, name: 'Misc', grp: '', kind: 'expense' },
];

test('categories come as named sections in list order, archived ones left out', () => {
  const g = M.categoryGroups(cats);
  assert.deepEqual(g.map((x) => x.name), ['Food', 'Transport', 'Income', 'Other']);
  assert.deepEqual(g[1].items.map((c) => c.id), [3]);
  assert.ok(g.every((x) => !x.open));
});

test('the section holding the current pick starts open, and an archived pick still shows', () => {
  const g = M.categoryGroups(cats, { selected: 4 });
  assert.deepEqual(g.filter((x) => x.open).map((x) => x.name), ['Transport']);
  assert.deepEqual(g.find((x) => x.name === 'Transport').items.map((c) => c.id), [3, 4]);
});

test('a search matches category names, or a whole section by its name, and opens what it finds', () => {
  const byName = M.categoryGroups(cats, { term: 'take' });
  assert.deepEqual(byName.map((x) => [x.name, x.items.map((c) => c.id), x.open]), [['Food', [2], true]]);
  const byGroup = M.categoryGroups(cats, { term: 'transp' });
  assert.deepEqual(byGroup[0].items.map((c) => c.id), [3]);
  assert.deepEqual(M.categoryGroups(cats, { term: 'zzz' }), []);
  assert.deepEqual(M.categoryGroups(null), []);
});

test('accounts group by what they are; hidden and merged ones only show while picked', () => {
  const accts = [
    { id: 'a', name: 'Everyday', type: 'transaction', institution: 'NATIONAL AUSTRALIA BANK', number_masked: 'xxxx1334' },
    { id: 'b', name: 'Card', type: 'credit-card', institution: 'Bankwest', number_masked: 'xxxx9671' },
    { id: 'c', name: 'Home loan', type: 'loan', institution: 'ANZ' },
    { id: 'd', name: 'Hidden', type: 'transaction', institution: 'ANZ', hidden: 1 },
    { id: 'e', name: 'Old', type: 'transaction', institution: 'ANZ', merged_into: 'a', status: 'gone' },
  ];
  const g = M.accountGroups(accts);
  assert.deepEqual(g.map((x) => x.name), ['Cash', 'Cards', 'Loans']);
  assert.deepEqual(g[0].items.map((a) => a.id), ['a']);
  assert.equal(g[0].items[0].sub, 'NAB · xxxx1334');
  assert.deepEqual(M.accountGroups(accts, { selected: 'd' })[0].items.map((a) => a.id), ['a', 'd']);
  assert.deepEqual(M.accountGroups([]), []);
});

test('the filters script is part of the served shell, after the screen it extends', () => {
  const scripts = /const SCRIPTS = \[([^\]]+)\]/.exec(readFileSync(new URL('../server.mjs', import.meta.url), 'utf8'))[1];
  assert.ok(scripts.indexOf("'transactions.js'") < scripts.indexOf("'filters.js'"));
});

// The I icon object once defined `down` and `up` twice (chevron, then arrow); the later one won silently.
test('every icon in core.js has one definition, and the dropdowns use the chevron', () => {
  const src = readFileSync(new URL('../public/core.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('const I = {'), src.indexOf('\n};', src.indexOf('const I = {')));
  const names = [...body.matchAll(/^ {2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
  assert.ok(names.length > 20);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  const filters = readFileSync(new URL('../public/filters.js', import.meta.url), 'utf8');
  assert.ok(!/\bI\.(down|up)\b/.test(filters));
  assert.ok(/I\.chevDown/.test(filters));
});
