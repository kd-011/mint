// Home lists the individual shares under the Share portfolio row. The expansion is pure (public/ux-model.js
// accountRows with { expandHoldings: true }), so it is tested here without a page; /api/networth carries the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { book } from './fixtures/book.mjs';
import { netWorth } from '../lib/networth.mjs';
import { createHolding, portfolio } from '../lib/holdings.mjs';
import { recordQuote } from '../lib/quotes.mjs';

const require = createRequire(import.meta.url);
const { UxModel: M } = require('../public/ux-model.js');

const nameOf = (a) => a.nickname || a.name;
const h = (id, ticker, units, value, extra = {}) => ({ id, ticker, exchange: 'ASX', name: null, units, value, ...extra });
const holdings = (list, extra = {}) => ({ count: list.length, value: 5000000, list, ...extra });
const invIds = (r) => r.sections.find((s) => s.id === 'investments').rows.map((x) => x.id);
const manual = [{ id: 1, name: 'Super fund', kind: 'super', is_liability: 0, value: 9000000, counted: true, sort: 1 }];

test('with expandHoldings each holding follows the Share portfolio row, biggest value first, ticker and units and AUD value', () => {
  const list = [h(1, 'BHP', 10, 150000), h(2, 'VAS', 100.5, 1088600), h(3, 'CBA', 0.25, 40000)];
  const r = M.accountRows({ accounts: [], manual, holdings: holdings(list, { sort: 2 }) }, { name: nameOf }, { expandHoldings: true });
  assert.deepEqual(invIds(r), ['asset_1', 'holdings', 'holding_2', 'holding_1', 'holding_3']);
  const rows = r.sections[0].rows.filter((x) => x.kind === 'holding');
  assert.deepEqual(rows.map((x) => [x.name, x.sub, x.balance, x.href]), [
    ['VAS', '100.5 units', 1088600, '/save'],
    ['BHP', '10 units', 150000, '/save'],
    ['CBA', '0.25 units', 40000, '/save'],
  ]);
  assert.equal(r.count, 5);
});

test('units drop trailing zeros and one unit is singular', () => {
  const r = M.accountRows({ accounts: [], holdings: holdings([h(1, 'A', 12.500000, 3), h(2, 'B', 1, 2), h(3, 'C', 1234.123457, 1)]) }, {}, { expandHoldings: true });
  assert.deepEqual(r.sections[0].rows.filter((x) => x.kind === 'holding').map((x) => x.sub), ['12.5 units', '1 unit', '1,234.123457 units']);
});

test('more than eight holdings show the eight largest and a last quiet +N more row to /save', () => {
  const list = Array.from({ length: 11 }, (_, i) => h(i + 1, `T${i + 1}`, 1, (i + 1) * 1000));
  const r = M.accountRows({ accounts: [], holdings: holdings(list) }, {}, { expandHoldings: true });
  const rows = r.sections[0].rows;
  assert.equal(rows.filter((x) => x.kind === 'holding').length, 8);
  assert.deepEqual(rows.filter((x) => x.kind === 'holding').map((x) => x.name), ['T11', 'T10', 'T9', 'T8', 'T7', 'T6', 'T5', 'T4']);
  const last = rows.at(-1);
  assert.equal(last.kind, 'holding-more');
  assert.equal(last.name, '+3 more');
  assert.equal(last.href, '/save');
  assert.equal(rows.filter((x) => x.kind === 'holding-more').length, 1);
});

test('exactly eight holdings have no +N more row', () => {
  const list = Array.from({ length: 8 }, (_, i) => h(i + 1, `T${i + 1}`, 1, 100 + i));
  const r = M.accountRows({ accounts: [], holdings: holdings(list) }, {}, { expandHoldings: true });
  assert.ok(!r.sections[0].rows.some((x) => x.kind === 'holding-more'));
});

test('a holding with no value is flagged noPrice, carries a null balance, and sorts after the valued ones', () => {
  const list = [h(1, 'USD1', 5, null), h(2, 'ZERO', 5, 0), h(3, 'VAS', 2, 500)];
  const r = M.accountRows({ accounts: [], holdings: holdings(list) }, {}, { expandHoldings: true });
  const rows = r.sections[0].rows.filter((x) => x.kind === 'holding');
  assert.deepEqual(rows.map((x) => [x.name, x.balance, !!x.noPrice]), [['VAS', 500, false], ['USD1', null, true], ['ZERO', null, true]]);
});

test('without the option, or without a list, the output is identical to today', () => {
  const list = [h(1, 'VAS', 100, 1088600)];
  const plain = M.accountRows({ accounts: [], manual, holdings: { count: 1, value: 1088600 } }, { name: nameOf });
  assert.deepEqual(M.accountRows({ accounts: [], manual, holdings: holdings(list, { value: 1088600 }) }, { name: nameOf }), plain);
  assert.deepEqual(M.accountRows({ accounts: [], manual, holdings: { count: 1, value: 1088600 } }, { name: nameOf }, { expandHoldings: true }), plain);
  assert.deepEqual(M.accountRows({ accounts: [], manual, holdings: { count: 1, value: 1088600, list: null } }, { name: nameOf }, { expandHoldings: true }), plain);
  assert.ok(!plain.sections[0].rows.some((x) => x.kind === 'holding'));
});

test('holding rows never reach the order ids Home sends', () => {
  const r = M.accountRows({ accounts: [], manual, holdings: holdings([h(1, 'VAS', 1, 5)]) }, { name: nameOf }, { expandHoldings: true });
  assert.ok(!M.orderIds(r).some((id) => String(id).startsWith('holding_')));
});

test('/api/networth holdings.list matches portfolio(): id, ticker, exchange, name, units and AUD value', () => {
  const { db } = book();
  const a = createHolding(db, { ticker: 'VAS', exchange: 'ASX', name: 'Vanguard AU', units: 100, avg_cost: 90, asset_class: 'etf' });
  const b = createHolding(db, { ticker: 'NVDA', exchange: 'US', units: 3.5, avg_cost: 100 });
  recordQuote(db, { ticker: 'VAS', exchange: 'ASX', price: 108.86, prevClose: 107.78, currency: 'AUD', source: 'fake', fetchedAt: new Date().toISOString() });
  const nw = netWorth(db);
  const p = portfolio(db);
  assert.equal(nw.holdings.count, 2);
  assert.deepEqual(nw.holdings.list, p.holdings.map((x) => ({ id: x.id, ticker: x.ticker, exchange: x.exchange, name: x.name, units: x.units, value: x.value })));
  const vas = nw.holdings.list.find((x) => x.id === a.id);
  assert.equal(vas.value, 1088600);
  assert.equal(nw.holdings.list.find((x) => x.id === b.id).value, null, 'USD with no rate has no AUD value');
  for (const k of ['count', 'value', 'cost', 'gain', 'day_change', 'sort']) assert.ok(k in nw.holdings, k);
});
