// Transactions filter dropdowns: every close path commits the open dropdown's
// pending picks, and a resize repositions the popover instead of closing it.
// filters.js is a classic script, so it is loaded into a vm context with a stub DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/filters.js', import.meta.url), 'utf8');

// Just enough element for openDropdown to mount, place, and remove a popover.
const el = () => ({
  attrs: {}, style: {}, dataset: {}, className: '', innerHTML: '', isConnected: true,
  classList: { add() {}, remove() {} },
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k]; },
  contains(t) { return t === this; },
  querySelector() { return null; },
  focus() {},
  remove() { this.isConnected = false; },
  getBoundingClientRect() { return { left: 40, bottom: 60 }; },
});

function boot() {
  const handlers = (into) => ({
    add: (type, fn) => { (into[type] ??= []).push(fn); },
    remove: (type, fn) => { into[type] = (into[type] ?? []).filter((g) => g !== fn); },
  });
  const docL = {};
  const winL = {};
  const docH = handlers(docL);
  const winH = handlers(winL);
  const ctx = {
    document: {
      createElement: el, body: { append(n) { n.isConnected = true; } }, documentElement: { clientWidth: 400 },
      addEventListener: docH.add, removeEventListener: docH.remove,
    },
    addEventListener: winH.add,
    removeEventListener: winH.remove,
    reduceMotion: { matches: true }, // closes synchronously, no timer
    innerHeight: 800,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'filters.js' });
  const fire = (map, type, evt = {}) => { for (const fn of [...(map[type] ?? [])]) fn({ target: {}, preventDefault() {}, stopPropagation() {}, ...evt }); };
  return {
    ctx,
    open: (...a) => ctx.openDropdown(...a),
    ddOpen: () => vm.runInContext('ddOpen', ctx),
    pointerDownOutside: () => fire(docL, 'pointerdown'),
    escape: () => fire(docL, 'keydown', { key: 'Escape' }),
    resize: () => fire(winL, 'resize'),
    closeDropdown: () => vm.runInContext('closeDropdown()', ctx), // what transactions.js calls on teardown
  };
}

const anchor = () => el();
const opts = (log, name, extra = {}) => ({ title: name, html: '', commit: () => log.push(name), ...extra });

test('a keyboard move from More to Dates commits the More picks before Dates opens', () => {
  const { open, ddOpen } = boot();
  const log = [];
  open(anchor(), 'more', opts(log, 'more'));
  open(anchor(), 'dates', opts(log, 'dates'));
  assert.deepEqual(log, ['more']);
  assert.equal(ddOpen().key, 'dates');
});

test('a second tap on the same button closes it and commits once', () => {
  const { open, ddOpen } = boot();
  const log = [];
  const btn = anchor();
  open(btn, 'more', opts(log, 'more'));
  assert.equal(open(btn, 'more', opts(log, 'more')), null);
  assert.deepEqual(log, ['more']);
  assert.equal(ddOpen(), null);
});

test('a tap outside and Escape each commit, and a later close does not commit again', () => {
  const { open, pointerDownOutside, escape, ddOpen } = boot();
  const log = [];
  open(anchor(), 'more', opts(log, 'tap-out'));
  pointerDownOutside();
  pointerDownOutside();
  escape();
  assert.deepEqual(log, ['tap-out']);
  assert.equal(ddOpen(), null);

  open(anchor(), 'more', opts(log, 'escape'));
  escape();
  assert.deepEqual(log, ['tap-out', 'escape']);
});

test('a resize repositions the open dropdown, keeps it open, and keeps its picks pending', () => {
  const { ctx, open, resize, ddOpen, pointerDownOutside } = boot();
  const log = [];
  const pop = open(anchor(), 'more', opts(log, 'more'));
  assert.equal(pop.style.width, '384px'); // under 480px it takes the full width less the margins
  ctx.document.documentElement.clientWidth = 360; // the address bar showed or hid
  ctx.innerHeight = 500;
  resize();
  assert.equal(pop.isConnected, true);
  assert.equal(pop.style.width, '344px');
  assert.equal(ddOpen().key, 'more');
  assert.deepEqual(log, []);
  pointerDownOutside();
  assert.deepEqual(log, ['more']);
});

test('a dropdown whose anchor the commit re-rendered away does not open on stale filters', () => {
  const { open, ddOpen } = boot();
  const log = [];
  const dates = anchor();
  open(anchor(), 'more', opts(log, 'more', { commit: () => { log.push('more'); dates.isConnected = false; } }));
  assert.equal(open(dates, 'dates', opts(log, 'dates')), null);
  assert.deepEqual(log, ['more']);
  assert.equal(ddOpen(), null);
});

test('a render that happens while a pick is pending drops it, so a stale pick cannot overwrite newer filters', () => {
  const { open, closeDropdown, ddOpen } = boot();
  // Models the setFilters snapshot: the More pick is built from the filters as they were when the dropdown opened.
  const filtersApplied = [];
  let current = { q: 'coffee' };
  const staleNext = { ...current, business: '1' };
  open(anchor(), 'more', { title: 'More', html: '', commit: () => filtersApplied.push(staleNext) });
  // A summary chip removes the search, which renders and runs the teardown cleanup.
  current = { ...current, q: undefined };
  closeDropdown();
  assert.deepEqual(filtersApplied, []);
  assert.equal(ddOpen(), null);
  assert.equal(current.q, undefined);
});
