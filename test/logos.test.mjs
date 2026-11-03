// Merchant logos: resolve a merchant to a domain once, fetch its icon server
// side, cache it in the book, and hand the page only a hint. Every network
// call here is a stub; nothing in this file reaches the internet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { book } from './fixtures/book.mjs';
import {
  createLogos, domainForMerchant, domainInText, validDomain, normaliseDomain, isPrivateAddress, checkIcon, getLogo, withLogos,
  logoUrl, putLogo, LOGO_DOMAINS, MAX_IMAGE_BYTES, RETRY_NONE_MS, RETRY_ERROR_MS,
} from '../lib/logos.mjs';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// fixtures

// A PNG signature and IHDR (width x height) padded to `size` bytes. Enough for
// the magic-byte and dimension checks; never decoded.
function png(w = 128, h = 128, size = 900) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4); ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(Math.max(0, size - 33), 7)]);
}
const webp = (size = 900) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x80, 0x03, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(size - 16, 3)]);
const jpeg = (size = 900) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, 5)]);
// ICO header: reserved 0, type 1, one image 64x64.
const ico = (size = 900) => Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 64, 64, 0, 0, 1, 0, 32, 0]), Buffer.alloc(size - 14, 9)]);
const ok = (body, extra = {}) => ({ status: 200, headers: { 'content-type': 'image/png', ...extra }, body });
const miss = () => ({ status: 404, headers: {}, body: Buffer.alloc(0) });

const G = (d) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;
const D = (d) => `https://icons.duckduckgo.com/ip3/${d}.ico`;

// A scripted network: routes maps a URL to a response, a thrown Error, or
// undefined (a 404). Every URL asked for is recorded.
function net(routes = {}) {
  const calls = [];
  const state = { routes };
  const hop = async (url) => {
    calls.push(url);
    const r = typeof state.routes === 'function' ? state.routes(url) : state.routes[url];
    if (r instanceof Error) throw r;
    return r ?? miss();
  };
  return { hop, calls, state };
}

function setup({ spends = {}, routes = {}, ai = null, now = Date.parse('2026-10-17T02:00:00Z'), ...opts } = {}) {
  const b = book();
  for (const [desc, cents] of Object.entries(spends)) for (let i = 0; i < 3; i++) b.add('acct_t_everyday', '2026-10-10', -cents, desc);
  const n = net(routes);
  const clock = { t: now };
  const aiCalls = [];
  const logos = createLogos({
    db: b.db, hop: n.hop, now: () => new Date(clock.t), today: () => '2026-10-17', delayMs: 0, log: () => {},
    key: ai ? 'k' : '', model: 'test/model', base: 'http://ai.invalid',
    fetchImpl: ai ? async (url, init) => {
      const body = JSON.parse(init.body);
      aiCalls.push({ url, body, raw: init.body });
      const out = ai(body);
      if (out instanceof Error) throw out;
      if (typeof out === 'number') return { ok: false, status: out, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
    } : undefined,
    ...opts,
  });
  const row = (key) => { const r = b.db.prepare('SELECT merchant_key, domain, source, status, attempts, ai_day, content_type, length(image) bytes FROM merchant_logo WHERE merchant_key = ?').get(key); return r && { ...r }; };
  return { ...b, logos, net: n, clock, aiCalls, row };
}

// domain resolution

test('the built-in map covers 80+ AU merchants and resolves on the derived merchant, with or without a branch', () => {
  assert.ok(Object.keys(LOGO_DOMAINS).length >= 80, `only ${Object.keys(LOGO_DOMAINS).length} entries`);
  const cases = {
    Woolworths: 'woolworths.com.au', 'Woolworths 1234 Perth': 'woolworths.com.au', Coles: 'coles.com.au', Aldi: 'aldi.com.au',
    Bunnings: 'bunnings.com.au', "Dan Murphy's": 'danmurphys.com.au', 'Hungry Jacks': 'hungryjacks.com.au', 'Uber Eats': 'ubereats.com',
    'Uber Eats Sydney': 'ubereats.com', Uber: 'uber.com', 'Jb Hi-Fi': 'jbhifi.com.au', 'Chemist Warehouse': 'chemistwarehouse.com.au',
    Netflix: 'netflix.com', Anthropic: 'anthropic.com', Bankwest: 'bankwest.com.au', Redbark: 'redbark.com', Bp: 'bp.com',
  };
  for (const [m, d] of Object.entries(cases)) assert.equal(domainForMerchant(m), d, m);
  assert.equal(domainForMerchant('Totally Unknown Cafe'), null);
  assert.equal(domainForMerchant(''), null);
  for (const d of Object.values(LOGO_DOMAINS)) assert.equal(validDomain(d), d, `map entry ${d} must be a valid domain`);
});

test('a domain written in the description is picked up', () => {
  assert.equal(domainInText('Redbark.com Finance'), 'redbark.com');
  assert.equal(domainInText('PAYPAL *NETFLIX.COM 4029357733'), 'netflix.com');
  assert.equal(domainInText('www.example.com.au/pay now'), 'example.com.au');
  assert.equal(domainInText('Bakery'), null);
  assert.equal(domainInText('invoice.pdf'), null);
});

test('private, IP, loopback and non-http hosts are never accepted as a domain', () => {
  for (const bad of ['127.0.0.1', 'localhost', 'a.localhost', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '0.0.0.0', '[::1]', '::1', '2130706433', '0x7f000001',
    'foo.local', 'printer.lan', 'svc.internal', 'intranet', 'x.home.arpa', 'a..b.com', '-bad.com', 'bad-.com', 'exa mple.com', 'user@evil.com', 'evil.com:8080', 'evil.com/path',
    'http://127.0.0.1', 'ftp://example.com', `${'a'.repeat(64)}.com`, `${'x.'.repeat(130)}com`, '', null, undefined, 42]) {
    assert.equal(validDomain(bad), null, String(bad));
  }
  assert.equal(domainInText('pay 10.0.0.1 now'), null);
  assert.equal(domainInText('http://192.168.1.1/login'), null);
  assert.equal(validDomain('Woolworths.COM.au'), 'woolworths.com.au');
  assert.equal(normaliseDomain('https://www.Bunnings.com.au/path?x=1'), 'bunnings.com.au');
  assert.equal(normaliseDomain('  netflix.com  '), 'netflix.com');
  assert.equal(normaliseDomain('http://127.0.0.1/'), null);
  assert.equal(normaliseDomain('javascript:alert(1)'), null);
});

test('isPrivateAddress flags every private, loopback and link-local range', () => {
  for (const a of ['10.0.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:10.0.0.1', '::']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '142.250.1.1', '2001:4860:4860::8888', '172.32.0.1']) assert.equal(isPrivateAddress(a), false, a);
});

// image validation

test('image validation goes by magic bytes: PNG, ICO, JPEG and WebP pass', () => {
  assert.deepEqual(checkIcon(png()), { ok: true, type: 'image/png' });
  assert.deepEqual(checkIcon(webp()), { ok: true, type: 'image/webp' });
  assert.deepEqual(checkIcon(jpeg()), { ok: true, type: 'image/jpeg' });
  assert.deepEqual(checkIcon(ico()), { ok: true, type: 'image/x-icon' });
});

test('image validation rejects wrong bytes, SVG, GIF, oversize, tiny, 8px and known default icons', () => {
  const html = Buffer.from(`<!doctype html><html><body>${'x'.repeat(900)}</body></html>`);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>${' '.repeat(900)}</svg>`);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(900)]);
  for (const [name, buf] of Object.entries({ html, svg, gif, text: Buffer.from('hello'.repeat(300)) })) assert.equal(checkIcon(buf).ok, false, name);
  assert.equal(checkIcon(png(128, 128, MAX_IMAGE_BYTES + 1)).ok, false, 'oversize');
  assert.equal(checkIcon(png(128, 128, MAX_IMAGE_BYTES)).ok, true, 'exactly the cap');
  assert.equal(checkIcon(png(128, 128, 60)).ok, false, 'tiny');
  assert.equal(checkIcon(png(8, 8, 900)).ok, false, '8px');
  const globe = png(16, 16, 700);
  assert.equal(checkIcon(globe).ok, false, '16px is a favicon the size of the default globe');
  const known = png(64, 64, 650);
  assert.equal(checkIcon(known).ok, true);
  assert.equal(checkIcon(known, { reject: new Set([createHash('sha256').update(known).digest('hex')]) }).ok, false, 'a known default icon');
  assert.equal(checkIcon(Buffer.alloc(0)).ok, false);
  assert.equal(checkIcon(null).ok, false);
});

// the run: resolve, fetch, cache

test('a map hit is fetched from Google s2 and cached; no model call is made', async () => {
  const t = setup({ spends: { WOOLWORTHS: 12000 }, routes: { [G('woolworths.com.au')]: ok(png()) } });
  const r = await t.logos.run();
  assert.equal(r.resolved, 1);
  assert.deepEqual(t.row('woolworths'), { merchant_key: 'woolworths', domain: 'woolworths.com.au', source: 'map', status: 'ok', attempts: 1, ai_day: null, content_type: 'image/png', bytes: png().length });
  assert.deepEqual(t.net.calls, [G('woolworths.com.au')]);
  const got = getLogo(t.db, 'woolworths');
  assert.equal(got.type, 'image/png');
  assert.ok(Buffer.compare(got.body, png()) === 0);
  assert.match(got.etag, /^"[0-9a-f]{16,}"$/);
});

test('a domain in the description wins over asking anyone', async () => {
  const t = setup({ spends: { 'QUIRKYSHOP.COM.AU': 4000 }, routes: { [G('quirkyshop.com.au')]: ok(png()) } });
  await t.logos.run();
  assert.equal(t.row('quirkyshop com au').domain, 'quirkyshop.com.au');
  assert.equal(t.row('quirkyshop com au').source, 'desc');
  assert.equal(t.row('quirkyshop com au').status, 'ok');
});

test('DuckDuckGo is the second try when Google has nothing usable', async () => {
  const t = setup({ spends: { COLES: 9000 }, routes: { [G('coles.com.au')]: ok(Buffer.from('<html>nope</html>'.repeat(80))), [D('coles.com.au')]: ok(ico()) } });
  await t.logos.run();
  assert.equal(t.row('coles').status, 'ok');
  assert.equal(t.row('coles').content_type, 'image/x-icon');
  assert.deepEqual(t.net.calls, [G('coles.com.au'), D('coles.com.au')]);
});

test('tiny, wrong-type, oversize and 404 responses from both sources are a miss, kept as none', async () => {
  const t = setup({
    spends: { COLES: 9000 },
    routes: { [G('coles.com.au')]: ok(png(128, 128, 60)), [D('coles.com.au')]: ok(png(128, 128, MAX_IMAGE_BYTES + 5)) },
  });
  await t.logos.run();
  assert.equal(t.row('coles').status, 'none');
  assert.equal(t.row('coles').domain, 'coles.com.au');
  assert.equal(t.row('coles').bytes, null);
  assert.equal(getLogo(t.db, 'coles'), null);
});

test('a redirect is followed only to Google or DuckDuckGo hosts over https', async () => {
  const t = setup({
    spends: { COLES: 9000, ALDI: 8000, KMART: 7000 },
    routes: {
      [G('coles.com.au')]: { status: 302, headers: { location: 'https://t1.gstatic.com/faviconV2?url=coles.com.au' }, body: Buffer.alloc(0) },
      'https://t1.gstatic.com/faviconV2?url=coles.com.au': ok(png()),
      [G('aldi.com.au')]: { status: 302, headers: { location: 'http://evil.example/x.png' }, body: Buffer.alloc(0) },
      [G('kmart.com.au')]: { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' }, body: Buffer.alloc(0) },
      'http://evil.example/x.png': ok(png()), 'https://169.254.169.254/latest/meta-data': ok(png()),
    },
  });
  await t.logos.run();
  assert.equal(t.row('coles').status, 'ok');
  assert.equal(t.row('aldi').status, 'none');
  assert.equal(t.row('kmart').status, 'none');
  assert.ok(!t.net.calls.includes('http://evil.example/x.png'));
  assert.ok(!t.net.calls.includes('https://169.254.169.254/latest/meta-data'));
});

test('a miss is retried after 30 days, not before; an error after 6 hours, not before', async () => {
  const t = setup({ spends: { COLES: 9000, ALDI: 8000 }, routes: { [G('aldi.com.au')]: new Error('socket hang up') } });
  await t.logos.run();
  assert.equal(t.row('coles').status, 'none');
  assert.equal(t.row('aldi').status, 'error');
  assert.equal(t.row('aldi').attempts, 1);
  const base = t.net.calls.length;

  t.clock.t += 5 * HOUR;
  await t.logos.run();
  assert.equal(t.net.calls.length, base, 'nothing is due after 5 hours');
  t.clock.t += 2 * HOUR; // 7 hours: the error is due, the miss is not
  t.net.state.routes = { [G('aldi.com.au')]: ok(png()) };
  await t.logos.run();
  assert.equal(t.row('aldi').status, 'ok');
  assert.equal(t.row('aldi').attempts, 2);
  assert.equal(t.row('coles').attempts, 1);

  t.clock.t += 29 * DAY;
  await t.logos.run();
  assert.equal(t.row('coles').attempts, 1, 'a miss waits 30 days');
  t.clock.t += 2 * DAY;
  t.net.state.routes = { [G('coles.com.au')]: ok(png()) };
  await t.logos.run();
  assert.equal(t.row('coles').status, 'ok');
  assert.equal(t.row('coles').attempts, 2);
  assert.equal(RETRY_NONE_MS, 30 * DAY);
  assert.equal(RETRY_ERROR_MS, 6 * HOUR);
});

test('a 5xx is an error to retry soon; an ok logo is never fetched again', async () => {
  const t = setup({ spends: { COLES: 9000 }, routes: { [G('coles.com.au')]: { status: 503, headers: {}, body: Buffer.alloc(0) }, [D('coles.com.au')]: { status: 503, headers: {}, body: Buffer.alloc(0) } } });
  await t.logos.run();
  assert.equal(t.row('coles').status, 'error');
  t.clock.t += 7 * HOUR;
  t.net.state.routes = { [G('coles.com.au')]: ok(png()) };
  await t.logos.run();
  assert.equal(t.row('coles').status, 'ok');
  const n = t.net.calls.length;
  t.clock.t += 400 * DAY;
  await t.logos.run();
  assert.equal(t.net.calls.length, n);
});

test('the backfill goes in spend order, so the common merchants fill first', async () => {
  const t = setup({
    spends: { COLES: 900, WOOLWORTHS: 30000, ALDI: 5000, KMART: 100 },
    routes: (u) => (u.startsWith('https://www.google.com') ? ok(png()) : undefined), maxPerRun: 2,
  });
  const r1 = await t.logos.run();
  assert.equal(r1.considered, 2);
  assert.deepEqual(t.net.calls.map((u) => /domain=([^&]+)/.exec(u)[1]), ['woolworths.com.au', 'aldi.com.au']);
  assert.equal(t.row('coles'), undefined);
  await t.logos.run();
  assert.equal(t.row('coles').status, 'ok');
  await t.logos.run();
  assert.equal(t.row('kmart').status, 'ok');
});

test('the same domain is fetched once and reused for another merchant key', async () => {
  const t = setup({ spends: { WOOLWORTHS: 9000, 'WOOLWORTHS METRO': 500 }, routes: { [G('woolworths.com.au')]: ok(png()) } });
  await t.logos.run();
  assert.equal(t.row('woolworths').status, 'ok');
  assert.equal(t.row('woolworths metro').status, 'ok');
  assert.equal(t.net.calls.length, 1);
});

// the model pass

const aiRoutes = { 'https://obscurebakery.com.au/': { status: 200, headers: {}, body: Buffer.alloc(0) }, [G('obscurebakery.com.au')]: ok(png()) };

test('an unknown merchant is asked about once, in a batch, by name only; the answer must answer over HTTPS', async () => {
  const t = setup({
    spends: { 'OBSCURE BAKERY 98765432': 3000, 'QUIET FIXERS': 2000 }, routes: aiRoutes,
    ai: (body) => ({ results: JSON.parse(body.messages[1].content.split('Items: ')[1]).map((x) => ({ i: x.i, domain: x.merchant.startsWith('Obscure') ? 'obscurebakery.com.au' : null })) }),
  });
  await t.logos.run();
  assert.equal(t.aiCalls.length, 1, 'one batched call');
  const sent = t.aiCalls[0].raw;
  assert.match(sent, /Obscure Bakery/);
  assert.doesNotMatch(sent, /\d{5,}/, 'no account or reference numbers');
  assert.doesNotMatch(sent, /description|redbark|acct_|balance/i);
  assert.equal(t.row('obscure bakery').status, 'ok');
  assert.equal(t.row('obscure bakery').source, 'ai');
  assert.equal(t.row('obscure bakery').domain, 'obscurebakery.com.au');
  assert.equal(t.row('quiet fixers').status, 'none');
  assert.equal(t.row('quiet fixers').ai_day, '2026-10-17');
  assert.ok(t.net.calls.includes('https://obscurebakery.com.au/'), 'probed over https');

  t.clock.t += 40 * DAY;
  await t.logos.run();
  assert.equal(t.aiCalls.length, 1, 'one question per merchant ever');
});

test('a model answer that is an IP, localhost, a private name or not https-reachable is thrown away without a request', async () => {
  const answers = { 'Bad One': '127.0.0.1', 'Bad Two': 'localhost', 'Bad Three': 'http://evil.example', 'Bad Four': '192.168.1.1', 'Bad Five': 'intranet.local', 'Bad Six': 'dead-host.example.com' };
  const t = setup({
    spends: Object.fromEntries(Object.keys(answers).map((k) => [k.toUpperCase(), 1000])),
    routes: { 'https://dead-host.example.com/': new Error('ENOTFOUND') },
    ai: (body) => ({ results: JSON.parse(body.messages[1].content.split('Items: ')[1]).map((x) => ({ i: x.i, domain: answers[x.merchant] })) }),
  });
  await t.logos.run();
  for (const k of Object.keys(answers)) assert.equal(t.row(k.toLowerCase()).status, 'none', k);
  assert.deepEqual(t.net.calls, ['https://dead-host.example.com/'], 'only the syntactically valid host was probed');
});

test('a failed model call is an error to retry later and is not counted as the one question', async () => {
  let fail = true;
  const t = setup({
    spends: { 'OBSCURE BAKERY': 3000 }, routes: aiRoutes,
    ai: (body) => (fail ? 500 : { results: JSON.parse(body.messages[1].content.split('Items: ')[1]).map((x) => ({ i: x.i, domain: 'obscurebakery.com.au' })) }),
  });
  await t.logos.run();
  assert.equal(t.row('obscure bakery').status, 'error');
  assert.equal(t.row('obscure bakery').ai_day, null);
  t.clock.t += 7 * HOUR;
  fail = false;
  await t.logos.run();
  assert.equal(t.aiCalls.length, 2);
  assert.equal(t.row('obscure bakery').status, 'ok');
});

test('the model pass respects the daily cap and does nothing without a key', async () => {
  const spends = { 'ALPHA ONE': 3000, 'BETA TWO': 2000, 'GAMMA THREE': 1000 };
  const t = setup({ spends, logoDailyCap: 2, ai: (body) => ({ results: JSON.parse(body.messages[1].content.split('Items: ')[1]).map((x) => ({ i: x.i, domain: null })) }) });
  await t.logos.run();
  assert.equal(t.aiCalls.reduce((n, c) => n + JSON.parse(c.body.messages[1].content.split('Items: ')[1]).length, 0), 2);
  const none = setup({ spends });
  const r = await none.logos.run();
  assert.equal(none.aiCalls.length, 0);
  assert.equal(none.row('alpha one').status, 'none');
  assert.equal(r.error ?? null, null);
});

// manual override

test('a manual domain is validated, fetched and kept; a sync pass never overwrites it', async () => {
  const t = setup({ spends: { WOOLWORTHS: 9000 }, routes: { [G('example.org')]: ok(png()), [G('woolworths.com.au')]: ok(png(64, 64)) } });
  await assert.rejects(() => t.logos.setManual('woolworths', '127.0.0.1'), (e) => e.status === 400);
  await assert.rejects(() => t.logos.setManual('woolworths', 'localhost'), (e) => e.status === 400);
  assert.equal(t.row('woolworths'), undefined, 'a rejected domain stores nothing');
  assert.deepEqual(t.net.calls, [], 'and makes no request');
  const r = await t.logos.setManual('woolworths', 'https://www.Example.org/some/path');
  assert.equal(r.domain, 'example.org');
  assert.equal(t.row('woolworths').status, 'manual');
  assert.equal(t.row('woolworths').source, 'manual');
  assert.ok(getLogo(t.db, 'woolworths'));
  await t.logos.run();
  t.clock.t += 400 * DAY;
  await t.logos.run();
  assert.equal(t.row('woolworths').domain, 'example.org');
  assert.equal(t.row('woolworths').status, 'manual');
});

test('a manual domain with no usable icon is refused with 422 and the old row stays', async () => {
  const t = setup({ spends: { WOOLWORTHS: 9000 }, routes: { [G('woolworths.com.au')]: ok(png()) } });
  await t.logos.run();
  await assert.rejects(() => t.logos.setManual('woolworths', 'noicon.example.org'), (e) => e.status === 422);
  assert.equal(t.row('woolworths').domain, 'woolworths.com.au');
});

test('clearing a manual logo keeps the merchant on a letter tile for good', async () => {
  const t = setup({ spends: { WOOLWORTHS: 9000 }, routes: { [G('woolworths.com.au')]: ok(png()) } });
  await t.logos.run();
  const r = await t.logos.setManual('woolworths', null);
  assert.equal(r.domain, null);
  assert.equal(r.logo, null);
  assert.equal(t.row('woolworths').status, 'manual');
  assert.equal(t.row('woolworths').domain, null);
  assert.equal(getLogo(t.db, 'woolworths'), null);
  const n = t.net.calls.length;
  t.clock.t += 400 * DAY;
  await t.logos.run();
  assert.equal(t.net.calls.length, n);
  assert.equal(t.row('woolworths').domain, null);
});

// the payload hint

test('the page gets a logo hint only for merchants with a cached image', async () => {
  const t = setup({ spends: { WOOLWORTHS: 9000, COLES: 5000, 'QUIET FIXERS': 100 }, routes: { [G('woolworths.com.au')]: ok(png()), [G('coles.com.au')]: ok(Buffer.from('nope')) } });
  await t.logos.run();
  const items = withLogos(t.db, [{ merchant: 'Woolworths' }, { merchant: 'Coles' }, { merchant: 'Quiet Fixers' }, { merchant: 'Never Seen' }, { merchant: '' }]);
  assert.match(items[0].logo, /^\/api\/logo\/woolworths\?v=[0-9a-f]{8}$/);
  assert.deepEqual(items.slice(1).map((i) => i.logo), [null, null, null, null]);
  assert.equal(items[0].logo, logoUrl('woolworths', getLogo(t.db, 'woolworths').etag));
});

test('a manual clear and a row with no image never produce a hint; a key with spaces is encoded', () => {
  const b = book();
  putLogo(b.db, 'quiet fixers', { domain: null, source: 'manual', status: 'manual', fetchedAt: '2026-10-17T00:00:00Z' });
  putLogo(b.db, 'redbark com finance', { domain: 'redbark.com', source: 'desc', status: 'ok', image: png(), type: 'image/png', fetchedAt: '2026-10-17T00:00:00Z' });
  const [a, c] = withLogos(b.db, [{ merchant: 'Quiet Fixers' }, { merchant: 'Redbark.com Finance' }]);
  assert.equal(a.logo, null);
  assert.match(c.logo, /^\/api\/logo\/redbark%20com%20finance\?v=[0-9a-f]{8}$/);
});

test('the transfer legs of the book are not looked up', async () => {
  const t = setup({ routes: (u) => ok(png()) });
  const out = t.add('acct_t_everyday', '2026-10-10', -50000, 'TRANSFER TO SAVINGS', { provider_category: 'TRANSFER_OUT' });
  const inn = t.add('acct_t_savings', '2026-10-10', 50000, 'TRANSFER FROM EVERYDAY', { provider_category: 'TRANSFER_IN' });
  t.db.prepare("INSERT INTO transfers (out_tx, in_tx, kind, status, created_at) VALUES (?, ?, 'transfer', 'auto', '2026-10-10T00:00:00Z')").run(out, inn);
  await t.logos.run();
  assert.equal(t.net.calls.length, 0);
});

// the real fetcher's guards (no internet: these never leave the box)

test('the real fetcher refuses a name that resolves to loopback, an IP literal, a non-https URL and credentials', async () => {
  const { safeHop } = await import('../lib/logos.mjs');
  await assert.rejects(() => safeHop('https://localhost/'), /blocked address/);
  await assert.rejects(() => safeHop('https://127.0.0.1/'), /https hosts only/);
  await assert.rejects(() => safeHop('https://[::1]/'), /https hosts only/);
  await assert.rejects(() => safeHop('http://example.com/'), /https hosts only/);
  await assert.rejects(() => safeHop('https://user:pw@example.com/'), /https hosts only/);
});

test('logoInfo names the key to PUT to and what is in use', async () => {
  const { logoInfo } = await import('../lib/logos.mjs');
  const t = setup({ spends: { WOOLWORTHS: 9000 }, routes: { [G('woolworths.com.au')]: ok(png()) } });
  await t.logos.run();
  const info = logoInfo(t.db, 'Woolworths');
  assert.equal(info.key, 'woolworths');
  assert.equal(info.domain, 'woolworths.com.au');
  assert.equal(info.status, 'ok');
  assert.match(info.logo, /^\/api\/logo\/woolworths\?v=/);
  assert.deepEqual({ ...logoInfo(t.db, 'Never Seen') }, { key: 'never seen', domain: null, source: null, status: null, logo: null });
  assert.equal(logoInfo(t.db, ''), null);
});
