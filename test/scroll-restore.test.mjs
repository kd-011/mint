// Back-navigation on a screen whose data arrives late: the page is short when it
// first draws, so the saved scroll position is held while it grows, and the
// scroll saver does not write the clamped position over the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
const body = src.slice(src.indexOf('let restoring = false;'), src.indexOf('function navigate('));

function boot() {
  const page = { height: 800, y: 0 };
  const listeners = new Map();
  let observer = null;
  const ctx = {
    renderToken: 1, scrollY: 0,
    scrollTo: (_x, y) => { page.y = Math.min(y, page.height - 800); ctx.scrollY = page.y; },
    ResizeObserver: class { constructor(cb) { this.cb = cb; observer = this; } observe() {} disconnect() { this.gone = true; } },
    setTimeout: () => 0, clearTimeout() {},
    addEventListener: (ev, fn) => listeners.set(ev, fn), removeEventListener: (ev) => listeners.delete(ev),
  };
  vm.createContext(ctx);
  vm.runInContext(body, ctx);
  return { ctx, page, listeners, grow: (h) => { page.height = h; observer.cb(); }, observer: () => observer };
}

test('a short page keeps the saved position until it is tall enough', () => {
  const t = boot();
  vm.runInContext('restoreScroll({}, 700, 1)', t.ctx);
  assert.equal(t.ctx.scrollY, 0, 'clamped while the page is short');
  assert.equal(vm.runInContext('restoring', t.ctx), true, 'the scroll saver is held off');
  t.grow(1200);
  assert.equal(t.ctx.scrollY, 400, 'still short of 700 on a 1200 page, holds on');
  t.grow(1800);
  assert.equal(t.ctx.scrollY, 700);
  assert.equal(vm.runInContext('restoring', t.ctx), false, 'done, the saver is back');
  assert.equal(t.observer().gone, true);
});

test('a touch lets go at once, and so does leaving the screen', () => {
  const t = boot();
  vm.runInContext('restoreScroll({}, 700, 1)', t.ctx);
  t.listeners.get('touchstart')();
  assert.equal(vm.runInContext('restoring', t.ctx), false);
  assert.equal(t.listeners.size, 0);
  const u = boot();
  vm.runInContext('restoreScroll({}, 700, 1)', u.ctx);
  u.ctx.renderToken = 2;
  u.grow(2000);
  assert.equal(u.ctx.scrollY, 0, 'a newer screen is not scrolled');
  assert.equal(vm.runInContext('restoring', u.ctx), false);
});

test('nothing to hold when the page is already tall enough, or the position is the top', () => {
  const t = boot();
  t.page.height = 2000;
  vm.runInContext('restoreScroll({}, 700, 1)', t.ctx);
  assert.equal(t.ctx.scrollY, 700);
  assert.equal(vm.runInContext('restoring', t.ctx), false);
  vm.runInContext('restoreScroll({}, 0, 1)', t.ctx);
  assert.equal(vm.runInContext('restoring', t.ctx), false);
});
