// Bank logos on Home: an institution resolves to a domain through a small map,
// the icon is fetched server side (larger source first) and cached under a
// `bank:` key that a merchant key can never equal. Every network call is a stub.
//
// Bank icons: the NAB icon Google serves has a "www" ribbon baked into its top
// left corner (NAB's own app icon carries it, so no domain gives a clean one).
// Mint ships a cleaned copy and uses it instead of fetching, so the stray mark
// is gone and the icon is the same on every run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { book } from './fixtures/book.mjs';
import {
  createLogos, domainForInstitution, bankLogoKey, validLogoKey, withBankLogos, INSTITUTION_DOMAINS, getLogo,
  checkIcon, BUNDLED_BANK_ICONS,
} from '../lib/logos.mjs';
import { merchantKey } from '../lib/merchant.mjs';

function png(w = 192, h = w, size = 900) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4); ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(Math.max(0, size - 33), 7)]);
}
const ok = (body) => ({ status: 200, headers: { 'content-type': 'image/png' }, body });
const miss = () => ({ status: 404, headers: {}, body: Buffer.alloc(0) });

function setup(institution) {
  const b = book();
  b.db.prepare("UPDATE accounts SET institution = ? WHERE id = 'acct_t_everyday'").run(institution);
  const calls = [];
  const hop = async (url) => { calls.push(url); return { status: 200, headers: {}, body: png() }; };
  const logos = createLogos({ db: b.db, hop, now: () => new Date('2026-10-17T02:00:00Z'), today: () => '2026-10-17', delayMs: 0, log: () => {} });
  return { ...b, logos, calls };
}

function bankSetup(routes) {
  const b = book({ accounts: [
    { id: 'a_bw1', name: 'Bankwest One', type: 'transaction', conn: 'conn_t_alpha', balance: 1 },
    { id: 'a_bw2', name: 'Bankwest Two', type: 'transaction', conn: 'conn_t_alpha', balance: 1 },
    { id: 'a_beta', name: 'Beta One', type: 'transaction', conn: 'conn_t_beta', balance: 1 },
  ] });
  b.db.prepare("UPDATE accounts SET institution = 'Bankwest' WHERE id IN ('a_bw1','a_bw2')").run();
  b.db.prepare("UPDATE accounts SET institution = 'Beta Mutual' WHERE id = 'a_beta'").run();
  const calls = [];
  const clock = { t: Date.parse('2026-10-19T02:00:00Z') };
  const hop = async (url) => { calls.push(url); const r = typeof routes === 'function' ? routes(url) : routes[url]; if (r instanceof Error) throw r; return r ?? miss(); };
  const logos = createLogos({ db: b.db, hop, now: () => new Date(clock.t), today: () => '2026-10-19', delayMs: 0, log: () => {} });
  const row = (k) => { const r = b.db.prepare('SELECT merchant_key, domain, source, status, content_type, length(image) bytes FROM merchant_logo WHERE merchant_key = ?').get(k); return r && { ...r }; };
  return { ...b, logos, calls, clock, row };
}

test('the three banks resolve, with the common AU banks and loose wording around the name', () => {
  assert.equal(domainForInstitution('Bankwest'), 'bankwest.com.au');
  assert.equal(domainForInstitution('ANZ'), 'anz.com.au');
  assert.equal(domainForInstitution('NAB'), 'nab.com.au');
  assert.equal(domainForInstitution('Australia and New Zealand Banking Group'), 'anz.com.au');
  assert.equal(domainForInstitution('National Australia Bank'), 'nab.com.au');
  assert.equal(domainForInstitution('Commonwealth Bank of Australia'), 'commbank.com.au');
  assert.equal(domainForInstitution('CommBank'), 'commbank.com.au');
  assert.equal(domainForInstitution('Westpac Banking Corporation'), 'westpac.com.au');
  assert.equal(domainForInstitution('ING'), 'ing.com.au');
  assert.equal(domainForInstitution('ING Bank (Australia)'), 'ing.com.au');
  assert.equal(domainForInstitution('Macquarie Bank'), 'macquarie.com.au');
  assert.equal(domainForInstitution('Up'), 'up.com.au');
  assert.equal(domainForInstitution('St. George Bank'), 'stgeorge.com.au');
  assert.ok(Object.keys(INSTITUTION_DOMAINS).length >= 15);
});

test('an unknown institution, a nameless one, and short names buried in other words do not resolve', () => {
  for (const n of ['Alpha Bank', 'Beta Mutual', '', null, undefined, 'Sign Up Credit Union', 'Springfield Building Society']) assert.equal(domainForInstitution(n), null, String(n));
});

test('the key is bank: plus a slug, null when there is no name, and never a possible merchant key', () => {
  assert.equal(bankLogoKey('Bankwest'), 'bank:bankwest');
  assert.equal(bankLogoKey('St. George Bank'), 'bank:st-george-bank');
  assert.equal(bankLogoKey('  '), null);
  assert.equal(bankLogoKey(null), null);
  for (const n of ['Bank Bankwest', 'bank:bankwest', 'Bankwest', 'bank bankwest']) assert.notEqual(merchantKey(n), bankLogoKey('Bankwest'));
});

test('validLogoKey takes a bank key, still refuses junk and a bank key that is not a plain slug', () => {
  assert.ok(validLogoKey('bank:anz'));
  assert.ok(validLogoKey('bank:st-george-bank'));
  assert.ok(validLogoKey('woolworths'));
  for (const k of ['bank:', 'bank:UPPER', 'bank:a b', 'bank:-x', 'bank:x-', 'bank:a:b', 'bank:../x', ':anz', 'x:anz']) assert.ok(!validLogoKey(k), k);
});

test('runBanks fetches one icon per known bank, asks for the large size first, and caches it under the bank key', async () => {
  const s = bankSetup((url) => (/256/.test(url) ? ok(png(192, 192)) : miss()));
  const out = await s.logos.runBanks();
  assert.equal(out.resolved, 1, 'two Bankwest accounts are one bank');
  assert.match(s.calls[0], /bankwest\.com\.au/);
  assert.match(s.calls[0], /256/);
  assert.equal(s.calls.filter((u) => /bankwest/.test(u)).length, 1);
  assert.deepEqual(s.row('bank:bankwest'), { merchant_key: 'bank:bankwest', domain: 'bankwest.com.au', source: 'map', status: 'ok', content_type: 'image/png', bytes: 900 });
  assert.ok(getLogo(s.db, 'bank:bankwest'));
  // Beta Mutual is not in the map: no row, no request, letter tile on the page.
  assert.equal(s.row('bank:beta-mutual'), undefined);
  assert.ok(!s.calls.some((u) => /beta/i.test(u)));
});

test('the large source missing falls back to the usual ones; nothing usable is a none row that is not retried at once', async () => {
  const s = bankSetup({});
  const out = await s.logos.runBanks();
  assert.equal(out.none, 1);
  assert.ok(s.calls.length >= 2, 'tried more than one source');
  assert.equal(s.row('bank:bankwest').status, 'none');
  const before = s.calls.length;
  await s.logos.runBanks();
  assert.equal(s.calls.length, before, 'a recent miss waits');
});

test('a cached bank logo is not fetched again, and a transient failure is recorded to retry', async () => {
  const s = bankSetup(() => ok(png()));
  await s.logos.runBanks();
  const n = s.calls.length;
  const again = await s.logos.runBanks();
  assert.equal(s.calls.length, n);
  assert.equal(again.considered, 0);
  const e = bankSetup(() => new Error('boom'));
  const out = await e.logos.runBanks();
  assert.equal(out.errors, 1);
  assert.equal(e.row('bank:bankwest').status, 'error');
});

test('run() does the banks first, so the normal logo pass after every sync covers them', async () => {
  const s = bankSetup((url) => (/256/.test(url) ? ok(png()) : miss()));
  await s.logos.run();
  assert.equal(s.row('bank:bankwest')?.status, 'ok');
});

test('withBankLogos adds a versioned logo URL for a cached bank and null for the rest', async () => {
  const s = bankSetup(() => ok(png()));
  await s.logos.runBanks();
  const out = withBankLogos(s.db, [{ id: 'x', institution: 'Bankwest' }, { id: 'y', institution: 'Beta Mutual' }, { id: 'z', institution: null }]);
  assert.match(out[0].logo, /^\/api\/logo\/bank%3Abankwest\?v=[0-9a-f]{8}$/);
  assert.equal(out[1].logo, null);
  assert.equal(out[2].logo, null);
});

test('the bundled NAB icon is a real icon that passes the same checks as a fetched one', () => {
  const file = BUNDLED_BANK_ICONS['nab.com.au'];
  assert.ok(file, 'nab.com.au has a bundled icon');
  const body = readFileSync(file);
  assert.equal(checkIcon(body).ok, true);
});

test('a bank with a bundled icon is served from it and never fetched', async () => {
  const s = setup('NATIONAL AUSTRALIA BANK');
  await s.logos.runBanks();
  assert.ok(!s.calls.some((u) => u.includes('nab.com.au')), `fetched: ${s.calls.join(' ')}`);
  const got = getLogo(s.db, 'bank:national-australia-bank');
  assert.ok(got);
  assert.deepEqual(got.body, readFileSync(BUNDLED_BANK_ICONS['nab.com.au']));
});

test('an icon already cached from Google (the one with the ribbon) is replaced on the next pass', async () => {
  const s = setup('NATIONAL AUSTRALIA BANK');
  s.db.prepare(`INSERT INTO merchant_logo (merchant_key, domain, source, status, attempts, fetched_at, image, content_type, etag)
    VALUES ('bank:national-australia-bank', 'nab.com.au', 'map', 'ok', 1, '2026-10-16T00:00:00Z', ?, 'image/png', 'oldetag')`).run(png(256));
  const before = withBankLogos(s.db, [{ institution: 'NATIONAL AUSTRALIA BANK' }])[0].logo;
  await s.logos.runBanks();
  const after = withBankLogos(s.db, [{ institution: 'NATIONAL AUSTRALIA BANK' }])[0].logo;
  assert.notEqual(after, before, 'the cache-busting version changed');
  const etag = createHash('sha256').update(readFileSync(BUNDLED_BANK_ICONS['nab.com.au'])).digest('hex').slice(0, 32);
  assert.equal(s.db.prepare("SELECT etag FROM merchant_logo WHERE merchant_key = 'bank:national-australia-bank'").get().etag, etag);
  const again = await s.logos.runBanks();
  assert.equal(again.considered, 0, 'once replaced it is left alone');
});

test('a bank without a bundled icon still goes through the fetch chain', async () => {
  const s = setup('Bankwest');
  await s.logos.runBanks();
  assert.ok(s.calls.some((u) => u.includes('bankwest.com.au')));
});

test('a bank logo set by hand is never replaced by the bundled icon', async () => {
  const s = setup('NATIONAL AUSTRALIA BANK');
  s.db.prepare(`INSERT INTO merchant_logo (merchant_key, domain, source, status, attempts, fetched_at, image, content_type, etag)
    VALUES ('bank:national-australia-bank', 'nab.com.au', 'manual', 'manual', 1, '2026-10-16T00:00:00Z', ?, 'image/png', 'mine')`).run(png(256));
  await s.logos.runBanks();
  assert.equal(s.db.prepare("SELECT etag FROM merchant_logo WHERE merchant_key = 'bank:national-australia-bank'").get().etag, 'mine');
});
