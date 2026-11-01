// Exchange rates for manual foreign-currency accounts (lib/fx.mjs): daily AUD
// rates per currency from Frankfurter (ECB), cached in fx_rates, a whole date
// range in one call for an import, the nearest earlier rate for a date, the
// last known rate when offline (with its date), and a refusal when there is no
// rate at all. The currency list comes from Frankfurter, never a typed list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createFx, createFrankfurter, rateOn, toAud } from '../lib/fx.mjs';
import { fakeFrankfurter } from './fixtures/fake-frankfurter.mjs';

const NOW = new Date('2026-10-17T02:00:00Z'); // Saturday 10:00 in Perth

function setup(opts = {}) {
  const ff = fakeFrankfurter(opts);
  const db = openDb(':memory:');
  const fx = createFx({ db, client: createFrankfurter({ fetch: ff.fetch, base: 'http://fx.test/v1' }), now: () => NOW, log: () => {} });
  return { ff, db, fx };
}

test('the currency list comes from Frankfurter, is cached, and validates codes', async () => {
  const { ff, fx } = setup();
  const list = await fx.currencies();
  assert.ok(list.items.some((c) => c.code === 'THB' && c.name === 'Thai Baht'));
  assert.ok(list.items.some((c) => c.code === 'AUD'));
  assert.equal(await fx.checkCurrency('usd'), 'USD');
  await assert.rejects(fx.checkCurrency('XYZ'), /XYZ.*not a currency Frankfurter/i);
  await assert.rejects(fx.checkCurrency('US'), /three letter/i);
  const n = ff.state.calls.filter((c) => c.startsWith('/v1/currencies')).length;
  ff.state.offline = true;
  await fx.currencies();
  assert.equal(await fx.checkCurrency('GBP'), 'GBP');
  assert.equal(ff.state.calls.filter((c) => c.startsWith('/v1/currencies')).length, n, 'cached, not fetched again');
});

test('with no cached list and no connection the currency check says so instead of guessing', async () => {
  const { ff, fx } = setup();
  ff.state.offline = true;
  await assert.rejects(fx.checkCurrency('USD'), /couldn't load the currency list/i);
});

test('one range call covers every date of an import, and a weekend date takes the Friday rate', async () => {
  const { ff, db, fx } = setup();
  ff.setRate('USD', '2026-09-04', 1.42);
  const dates = ['2026-09-06', '2026-09-30', '2026-09-01', '2026-10-15'];
  const r = await fx.ensure('USD', dates);
  assert.equal(r.error, null);
  assert.equal(ff.state.calls.filter((c) => c.includes('..')).length, 1, 'one range call');
  assert.deepEqual(rateOn(db, 'USD', '2026-09-06'), { rate: 1.42, date: '2026-09-04' });
  assert.equal(rateOn(db, 'USD', '2026-10-15').rate, 1.5);
  // Already covered: no second call.
  await fx.ensure('USD', ['2026-09-10']);
  assert.equal(ff.state.calls.filter((c) => c.includes('..')).length, 1);
});

test('AUD needs no rate, and conversion rounds to whole cents', async () => {
  const { db } = setup();
  assert.deepEqual(rateOn(db, 'AUD', '2026-10-01'), { rate: 1, date: '2026-10-01' });
  assert.equal(toAud(10001, 1.5), 15002);
  assert.equal(toAud(-333, 0.045), -15);
  assert.equal(toAud(10000000, 0.045), 450000);
});

test('no rate at all and no connection: nothing to convert with, so the caller is told and nothing is guessed', async () => {
  const { ff, db, fx } = setup();
  ff.state.offline = true;
  const r = await fx.ensure('THB', ['2026-10-01']);
  assert.match(r.error, /Frankfurter/);
  assert.equal(rateOn(db, 'THB', '2026-10-01'), null);
});

test('a date older than anything Frankfurter has gets no rate', async () => {
  const { db, fx } = setup();
  await fx.ensure('USD', ['2001-03-01']);
  assert.equal(rateOn(db, 'USD', '2001-03-01'), null);
});

test('offline, the last known rate stands in and its date is reported as stale', async () => {
  const { ff, db, fx } = setup();
  db.prepare(`INSERT INTO accounts (id, name, type, institution, currency, manual, status, created_at, updated_at)
    VALUES ('man_cccccccccccccccc', 'Wise USD', 'transaction', 'Wise', 'USD', 1, 'open', ?, ?)`).run(NOW.toISOString(), NOW.toISOString());
  await fx.ensure('USD', ['2026-10-01']);
  ff.state.offline = true;
  ff.state.latestDate = '2026-10-16';
  const s0 = fx.status('USD');
  assert.equal(s0.date, '2026-10-16');
  assert.equal(s0.stale, false);
  // A week later with no refresh: still the 16th, now stale.
  const later = createFx({ db, client: createFrankfurter({ fetch: ff.fetch, base: 'http://fx.test/v1' }), now: () => new Date('2026-10-24T02:00:00Z'), log: () => {} });
  const r = await later.refreshLatest({ force: true });
  assert.equal(r.failed, 1);
  const s = later.status('USD');
  assert.equal(s.rate, 1.5);
  assert.equal(s.date, '2026-10-16');
  assert.equal(s.stale, true);
  assert.match(s.error, /Frankfurter/);
});

test('the daily refresh fetches only the currencies manual accounts use, at most every 6 hours', async () => {
  const { ff, db, fx } = setup();
  const at = NOW.toISOString();
  db.prepare(`INSERT INTO accounts (id, name, type, institution, currency, manual, status, created_at, updated_at)
    VALUES ('man_aaaaaaaaaaaaaaaa', 'Wise USD', 'transaction', 'Wise', 'USD', 1, 'open', ?, ?),
           ('man_bbbbbbbbbbbbbbbb', 'Cash AUD', 'transaction', 'Wallet', 'AUD', 1, 'open', ?, ?)`).run(at, at, at, at);
  const r = await fx.refreshLatest();
  assert.deepEqual(r.currencies, ['USD']);
  assert.equal(r.fetched, 1);
  assert.equal(rateOn(db, 'USD', '2026-10-17').date, '2026-10-16');
  const again = await fx.refreshLatest();
  assert.equal(again.fetched, 0);
  assert.equal(ff.state.calls.filter((c) => c.startsWith('/v1/latest')).length, 1);
});
