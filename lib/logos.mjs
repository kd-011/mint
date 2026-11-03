// Merchant logos. A merchant is resolved to a website domain once (a built-in
// map, a domain in its own name, then one batched question to the model),
// its icon is fetched server side from Google s2 or DuckDuckGo, and the image
// is cached in the book. The page only ever gets a hint and loads the image
// from /api/logo, so nothing leaks to a third party per view. The domain and
// the model's answer are an SSRF surface: nothing private, no IPs, https only.
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { zoneDate } from './dates.mjs';
import { fileURLToPath } from 'node:url';
import { HttpError, bad } from './errors.mjs';
import { merchantKey } from './merchant.mjs';
import { scrubForModel } from './categorise.mjs';
import { FROM, COUNTS } from './spend.mjs';

export const MAX_IMAGE_BYTES = 200 * 1024;
export const RETRY_NONE_MS = 30 * 24 * 3600_000;
export const RETRY_ERROR_MS = 6 * 3600_000;
const MIN_IMAGE_BYTES = 120;
const MIN_DIMENSION = 32; // below this it is a 16px favicon or the default globe
const MAX_REDIRECTS = 3;

// sha256 of the stand-in icons the two services return for a site they know
// nothing about. Size and dimensions catch most; this catches the rest.
export const DEFAULT_ICON_SHA256 = new Set([
  '59bfe9bc385ad69f50793ce4a53397316d7a875a7148a63c16df9b674c6cda64', // Google s2, 16px globe (image hash) scan-allow
  'e5db88ea2322863ca17817b99d60006c625a31cff0dad49cf05d3c6d16a75c17', // DuckDuckGo, 48px placeholder scan-allow
]);

// the built-in map

// Keys are merchant names as the bank shows them, matched on the grouping key
// with apostrophes dropped. A branch or suburb after the name still hits
// (longest leading words win), except for EXACT_ONLY names, which are too
// common as the first word of something else.
export const LOGO_DOMAINS = {
  // supermarkets and general retail
  Woolworths: 'woolworths.com.au', Coles: 'coles.com.au', Aldi: 'aldi.com.au', IGA: 'iga.com.au', Foodland: 'foodland.com.au',
  'Harris Farm': 'harrisfarm.com.au', Costco: 'costco.com.au', Bunnings: 'bunnings.com.au', Kmart: 'kmart.com.au', Target: 'target.com.au',
  'Big W': 'bigw.com.au', Officeworks: 'officeworks.com.au', 'JB Hi-Fi': 'jbhifi.com.au', 'Harvey Norman': 'harveynorman.com.au',
  'The Good Guys': 'thegoodguys.com.au', 'Rebel Sport': 'rebelsport.com.au', BCF: 'bcf.com.au', 'Supercheap Auto': 'supercheapauto.com.au',
  Repco: 'repco.com.au', Autobarn: 'autobarn.com.au', Ikea: 'ikea.com', Spotlight: 'spotlightstores.com', 'Mitre 10': 'mitre10.com.au',
  Kathmandu: 'kathmandu.com.au', 'Cotton On': 'cottonon.com', Uniqlo: 'uniqlo.com', Zara: 'zara.com', Myer: 'myer.com.au',
  'David Jones': 'davidjones.com', Dymocks: 'dymocks.com.au', Petbarn: 'petbarn.com.au', 'Pet Circle': 'petcircle.com.au',
  'Australia Post': 'auspost.com.au', Amazon: 'amazon.com.au', eBay: 'ebay.com.au', Temu: 'temu.com', Shein: 'shein.com',
  Kogan: 'kogan.com', Catch: 'catch.com.au', Typo: 'typo.com',
  // pharmacy and liquor
  'Chemist Warehouse': 'chemistwarehouse.com.au', Priceline: 'priceline.com.au', 'Terry White Chemmart': 'terrywhitechemmart.com.au',
  "Dan Murphy's": 'danmurphys.com.au', BWS: 'bws.com.au', Liquorland: 'liquorland.com.au', 'First Choice Liquor': 'firstchoiceliquor.com.au',
  // fuel
  BP: 'bp.com', Ampol: 'ampol.com.au', Caltex: 'ampol.com.au', Shell: 'shell.com.au', '7-Eleven': '7eleven.com.au',
  'Reddy Express': 'reddyexpress.com.au', 'United Petroleum': 'unitedpetroleum.com.au', 'Puma Energy': 'pumaenergy.com', 'Liberty Oil': 'libertyoil.com.au',
  // food and drink
  "Hungry Jack's": 'hungryjacks.com.au', "McDonald's": 'mcdonalds.com.au', KFC: 'kfc.com.au', Subway: 'subway.com', "Domino's": 'dominos.com.au',
  'Pizza Hut': 'pizzahut.com.au', 'Red Rooster': 'redrooster.com.au', Oporto: 'oporto.com.au', 'Guzman Y Gomez': 'guzmanygomez.com',
  "Nando's": 'nandos.com.au', Starbucks: 'starbucks.com.au', Zambrero: 'zambrero.com.au', 'Boost Juice': 'boostjuice.com.au',
  'Gloria Jeans': 'gloriajeans.com.au', "Grill'd": 'grilld.com.au',
  // delivery, transport and travel
  Uber: 'uber.com', 'Uber Eats': 'ubereats.com', Menulog: 'menulog.com.au', DoorDash: 'doordash.com', DiDi: 'didiglobal.com',
  Transperth: 'transperth.wa.gov.au', Linkt: 'linkt.com.au', Qantas: 'qantas.com', 'Virgin Australia': 'virginaustralia.com', Jetstar: 'jetstar.com',
  'Booking.com': 'booking.com', Airbnb: 'airbnb.com.au',
  // subscriptions, software and AI
  Netflix: 'netflix.com', Spotify: 'spotify.com', 'Disney Plus': 'disneyplus.com', Stan: 'stan.com.au', Binge: 'binge.com.au', YouTube: 'youtube.com',
  Apple: 'apple.com', Google: 'google.com', Microsoft: 'microsoft.com', PayPal: 'paypal.com', Afterpay: 'afterpay.com', Zip: 'zip.co',
  OpenAI: 'openai.com', Anthropic: 'anthropic.com', Claude: 'claude.ai', Tailscale: 'tailscale.com', GitHub: 'github.com', Cloudflare: 'cloudflare.com',
  DigitalOcean: 'digitalocean.com', Vercel: 'vercel.com', Namecheap: 'namecheap.com', Steam: 'steampowered.com', PlayStation: 'playstation.com',
  Nintendo: 'nintendo.com', Xbox: 'xbox.com', Dropbox: 'dropbox.com', Adobe: 'adobe.com', Canva: 'canva.com', Audible: 'audible.com.au',
  Facebook: 'facebook.com', Meta: 'meta.com', Instagram: 'instagram.com', Reddit: 'reddit.com', Etsy: 'etsy.com', GoDaddy: 'godaddy.com', Cursor: 'cursor.com',
  Twitch: 'twitch.tv', Patreon: 'patreon.com', Substack: 'substack.com', '1Password': '1password.com',
  // telco and utilities
  Telstra: 'telstra.com.au', Optus: 'optus.com.au', Vodafone: 'vodafone.com.au', 'Aussie Broadband': 'aussiebroadband.com.au', Belong: 'belong.com.au',
  Amaysim: 'amaysim.com.au', Synergy: 'synergy.net.au', 'Water Corporation': 'watercorporation.com.au', 'Alinta Energy': 'alintaenergy.com.au',
  'Origin Energy': 'originenergy.com.au', AGL: 'agl.com.au',
  // banks, money and insurance
  Bankwest: 'bankwest.com.au', ANZ: 'anz.com.au', NAB: 'nab.com.au', 'Commonwealth Bank': 'commbank.com.au', CommBank: 'commbank.com.au',
  Westpac: 'westpac.com.au', ING: 'ing.com.au', Macquarie: 'macquarie.com.au', Up: 'up.com.au', Redbark: 'redbark.com', Wise: 'wise.com',
  Revolut: 'revolut.com', 'Bendigo Bank': 'bendigobank.com.au', 'St George': 'stgeorge.com.au', Medibank: 'medibank.com.au', Bupa: 'bupa.com.au',
  HCF: 'hcf.com.au', NIB: 'nib.com.au', NRMA: 'nrma.com.au', 'Australian Taxation Office': 'ato.gov.au',
  // fitness and entertainment
  'Anytime Fitness': 'anytimefitness.com.au', Hoyts: 'hoyts.com.au', 'Event Cinemas': 'eventcinemas.com.au', Ticketek: 'ticketek.com.au',
  Ticketmaster: 'ticketmaster.com.au',
};
const EXACT_ONLY = new Set(['stan', 'zip', 'wise', 'catch', 'belong', 'typo', 'up', 'ing', 'target', 'claude', 'steam', 'spotlight', 'meta', 'cursor']);

// Same grouping key the rest of Mint uses, with apostrophes dropped first so
// "Dan Murphy's" and "Dan Murphys" are one merchant.
const logoKey = (s) => merchantKey(String(s ?? '').replace(/['’]/g, ''));
const BY_KEY = new Map(Object.entries(LOGO_DOMAINS).map(([name, d]) => [logoKey(name), d]));

export function domainForMerchant(name) {
  const words = logoKey(name).split(' ').filter(Boolean);
  for (let n = words.length; n >= 1; n--) {
    const k = words.slice(0, n).join(' ');
    const d = BY_KEY.get(k);
    if (d && (n === words.length || !EXACT_ONLY.has(k))) return d;
  }
  return null;
}

// banks

// Institution names as Redbark reports them, loosely: a phrase anywhere in the
// name, on word boundaries, picks the domain. A bank not
// listed simply has no logo and the page keeps its letter tile.
export const INSTITUTION_DOMAINS = {
  Bankwest: 'bankwest.com.au', ANZ: 'anz.com.au', 'Australia and New Zealand Banking Group': 'anz.com.au', NAB: 'nab.com.au',
  'National Australia Bank': 'nab.com.au', 'Commonwealth Bank': 'commbank.com.au', CommBank: 'commbank.com.au', CBA: 'commbank.com.au',
  Westpac: 'westpac.com.au', 'St George': 'stgeorge.com.au', 'Bank of Melbourne': 'bankofmelbourne.com.au', BankSA: 'banksa.com.au',
  'ING Bank': 'ing.com.au', 'ING Australia': 'ing.com.au', 'ING Direct': 'ing.com.au', ING: 'ing.com.au', Macquarie: 'macquarie.com.au', Up: 'up.com.au',
  Suncorp: 'suncorp.com.au', 'Bank of Queensland': 'boq.com.au', BOQ: 'boq.com.au', 'Bendigo Bank': 'bendigobank.com.au',
  'Bendigo and Adelaide Bank': 'bendigobank.com.au', HSBC: 'hsbc.com.au', Citibank: 'citibank.com.au', UBank: 'ubank.com.au', 'ME Bank': 'mebank.com.au',
  'AMP Bank': 'amp.com.au', 'Great Southern Bank': 'greatsouthernbank.com.au', 'Beyond Bank': 'beyondbank.com.au', 'Teachers Mutual Bank': 'tmbank.com.au',
  'Bank Australia': 'bankaust.com.au', Rabobank: 'rabobank.com.au', 'Judo Bank': 'judo.bank', Wise: 'wise.com', Revolut: 'revolut.com',
};
// Too short to trust inside other words: only the whole name counts.
const INSTITUTION_EXACT = new Set(['up', 'ing', 'cba', 'boq', 'wise']);

const words = (s) => String(s ?? '').toLowerCase().replace(/['’]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const BY_INSTITUTION = Object.entries(INSTITUTION_DOMAINS).map(([n, d]) => [words(n), d]).sort((a, b) => b[0].length - a[0].length);

export function domainForInstitution(name) {
  const w = words(name);
  if (!w) return null;
  let best = null;
  for (const [phrase, domain] of BY_INSTITUTION) {
    const at = INSTITUTION_EXACT.has(phrase) ? (w === phrase ? 0 : -1) : ` ${w} `.indexOf(` ${phrase} `);
    // The phrase that starts earliest wins ("ING Bank (Australia)" is ING, not Bank Australia), then the longer one.
    if (at >= 0 && (!best || at < best.at)) best = { at, domain };
  }
  return best?.domain ?? null;
}

// Icons shipped with Mint, for a bank whose own icon is not fit to show as fetched. NAB's app icon (what
// Google and the site both serve) has a grey "www" ribbon baked into its top left corner, so there is no clean
// copy to fetch from anywhere the logo fetch is allowed to go. lib/bank-icons/nab.png is that icon with the
// ribbon painted out and a little margin. Used instead of fetching, never fetched.
export const BUNDLED_BANK_ICONS = { 'nab.com.au': fileURLToPath(new URL('./bank-icons/nab.png', import.meta.url)) };
const bundledIcon = (domain) => {
  const file = BUNDLED_BANK_ICONS[domain];
  if (!file) return null;
  try {
    const image = readFileSync(file);
    const v = checkIcon(image);
    return v.ok ? { image, type: v.type, etag: hash(image) } : null;
  } catch { return null; }
};

// `bank:` plus a slug. merchantKey never produces a colon, so a merchant can
// never share a key with a bank.
export function bankLogoKey(name) {
  const slug = words(name).replace(/ /g, '-').slice(0, 60).replace(/-+$/, '');
  return slug ? `bank:${slug}` : null;
}

// domains

const BLOCKED_TLDS = new Set(['local', 'localhost', 'lan', 'internal', 'home', 'arpa', 'corp', 'intranet', 'invalid', 'test', 'onion', 'localdomain', 'private', 'gateway', 'router']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})$/;

// A bare host name or null. Strict on purpose: no scheme, port, path, user, IP
// literal or internal-looking suffix gets through.
export function validDomain(input) {
  if (typeof input !== 'string') return null;
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  if (!d || d.length > 253 || isIP(d)) return null;
  const labels = d.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  const tld = labels.at(-1);
  if (!TLD.test(tld) || BLOCKED_TLDS.has(tld)) return null;
  return d;
}

// What the owner typed into the Logo field: tolerate https://www.host/path, then be strict.
export function normaliseDomain(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/^https?:\/\//i, '');
  s = s.split(/[/?#]/)[0].replace(/^www\./i, '');
  return validDomain(s);
}

// Real top-level domains worth believing in free text ("invoice.pdf" is not one).
const TEXT_TLDS = new Set(['com', 'net', 'org', 'au', 'io', 'app', 'dev', 'ai', 'nz', 'uk', 'us', 'tv', 'me', 'gg', 'shop', 'store', 'online', 'co', 'biz', 'info', 'edu', 'gov', 'ca', 'eu', 'de', 'fm', 'to']);

export function domainInText(text) {
  const re = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/gi;
  for (const m of String(text ?? '').matchAll(re)) {
    const d = validDomain(m[1].replace(/^www\./i, ''));
    if (d && TEXT_TLDS.has(d.split('.').at(-1))) return d;
  }
  return null;
}

// SSRF guard

const v4 = (a) => a.split('.').map(Number);
function privateV4(a) {
  const [p, q, r] = v4(a);
  return p === 0 || p === 10 || p === 127 || p >= 224
    || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31)
    || (p === 192 && ((q === 0 && r === 0) || (q === 0 && r === 2) || q === 168)) || (p === 198 && (q === 18 || q === 19 || (q === 51 && r === 100)))
    || (p === 203 && q === 0 && r === 113);
}

export function isPrivateAddress(ip) {
  const a = String(ip ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  const kind = isIP(a);
  if (kind === 4) return privateV4(a);
  if (kind !== 6) return true; // not an address at all: refuse
  if (a === '::' || a === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return privateV4(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return privateV4([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')); }
  const first = parseInt(a.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 // ULA, link-local, multicast
    || a.startsWith('64:ff9b:') || a.startsWith('2002:') || a.startsWith('2001:0:') || a.startsWith('2001::') || a.startsWith('2001:db8');
}

// The check runs where the connection is made, so a name that resolves to a
// private address (or flips to one between a check and a connect) is refused.
function safeLookup(host, opts, cb) {
  dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((x) => isPrivateAddress(x.address))) return cb(new Error(`blocked address for ${host}`));
    if (opts?.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}

// One https GET, no redirects. Resolves { status, headers, body }; the body is
// cut at maxBytes + 1 so an oversize reply is recognisable without being read.
export function safeHop(url, { timeoutMs = 8000, maxBytes = MAX_IMAGE_BYTES + 1, readBody = true } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('bad url')); }
    if (u.protocol !== 'https:' || isIP(u.hostname.replace(/^\[|\]$/g, '')) || u.username || u.password) return reject(new Error('https hosts only'));
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    const req = httpsRequest({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', lookup: safeLookup,
      headers: { 'User-Agent': 'Mint/1 logo fetch', Accept: 'image/*,*/*;q=0.5', 'Accept-Encoding': 'identity' },
    }, (res) => {
      const head = { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) };
      if (!readBody) { clearTimeout(timer); res.destroy(); return resolve({ ...head, body: Buffer.alloc(0) }); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        chunks.push(c);
        if (size > maxBytes) { clearTimeout(timer); res.destroy(); resolve({ ...head, body: Buffer.concat(chunks).subarray(0, maxBytes) }); }
      });
      res.on('end', () => { clearTimeout(timer); resolve({ ...head, body: Buffer.concat(chunks) }); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// image validation

// By magic bytes only; the server's Content-Type is never trusted and SVG
// (which can carry script) is never accepted.
export function checkIcon(buf, { reject = DEFAULT_ICON_SHA256 } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, reason: 'empty' };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'too big' };
  if (buf.length < MIN_IMAGE_BYTES) return { ok: false, reason: 'too small' };
  let type = null;
  let size = Infinity;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    type = 'image/png';
    if (buf.length >= 24) size = Math.min(buf.readUInt32BE(16), buf.readUInt32BE(20));
  } else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) type = 'image/jpeg';
  else if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') type = 'image/webp';
  else if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0 && buf.readUInt16LE(4) >= 1) {
    type = 'image/x-icon';
    let best = 0;
    for (let i = 0; i < Math.min(buf.readUInt16LE(4), 32) && 6 + i * 16 + 2 <= buf.length; i++) {
      const w = buf[6 + i * 16] || 256;
      const h = buf[7 + i * 16] || 256;
      best = Math.max(best, Math.min(w, h));
    }
    size = best;
  }
  if (!type) return { ok: false, reason: 'not a PNG, ICO, JPEG or WebP' };
  if (size < MIN_DIMENSION) return { ok: false, reason: 'too small to be a logo' };
  if (reject.has(createHash('sha256').update(buf).digest('hex'))) return { ok: false, reason: 'default icon' };
  return { ok: true, type };
}

const ICON_SOURCES = [
  (d) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`,
  (d) => `https://icons.duckduckgo.com/ip3/${d}.ico`,
];
// Banks get the large favicon first (a 192px mark rather than a 32px blur), then the usual two.
const BANK_ICON_SOURCES = [
  (d) => `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${d}&size=256`,
  (d) => `https://www.google.com/s2/favicons?domain=${d}&sz=256`,
  ...ICON_SOURCES,
];
const ICON_HOST = /^(?:www\.google\.com|(?:[a-z0-9-]+\.)*gstatic\.com|icons\.duckduckgo\.com|external-content\.duckduckgo\.com)$/;
export const iconHostAllowed = (url) => {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ICON_HOST.test(u.hostname); } catch { return false; }
};

// the cache

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 32);

export function putLogo(db, key, { domain = null, source = null, status, image = null, type = null, fetchedAt = new Date().toISOString(), attempts = 1, aiDay = null, error = null }) {
  db.prepare(`INSERT INTO merchant_logo (merchant_key, domain, source, status, attempts, ai_day, error, fetched_at, image, content_type, etag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(merchant_key) DO UPDATE SET domain = excluded.domain, source = excluded.source, status = excluded.status, attempts = excluded.attempts,
      ai_day = COALESCE(excluded.ai_day, merchant_logo.ai_day), error = excluded.error, fetched_at = excluded.fetched_at,
      image = excluded.image, content_type = excluded.content_type, etag = excluded.etag`)
    .run(key, domain, source, status, attempts, aiDay, error ? String(error).slice(0, 200) : null, fetchedAt, image, image ? type : null, image ? hash(image) : null);
}

export function getLogo(db, key) {
  const r = db.prepare('SELECT image, content_type, etag FROM merchant_logo WHERE merchant_key = ? AND image IS NOT NULL').get(key);
  return r ? { body: Buffer.from(r.image), type: r.content_type, etag: `"${r.etag}"` } : null;
}

export const logoUrl = (key, etag) => `/api/logo/${encodeURIComponent(key)}?v=${String(etag).replace(/"/g, '').slice(0, 8)}`;

// Adds `logo` (a URL, or null) to each item, from the merchant name in `field`.
export function withLogos(db, items, field = 'merchant') {
  const have = new Map(db.prepare('SELECT merchant_key, etag FROM merchant_logo WHERE image IS NOT NULL').all().map((r) => [r.merchant_key, r.etag]));
  return items.map((it) => {
    const k = merchantKey(it[field]);
    return { ...it, logo: k && have.has(k) ? logoUrl(k, have.get(k)) : null };
  });
}

// Adds `logo` to each item from the bank named in `field` (an account's institution).
export function withBankLogos(db, items, field = 'institution') {
  const have = new Map(db.prepare("SELECT merchant_key, etag FROM merchant_logo WHERE merchant_key LIKE 'bank:%' AND image IS NOT NULL").all().map((r) => [r.merchant_key, r.etag]));
  return items.map((it) => {
    const k = bankLogoKey(it[field]);
    return { ...it, logo: k && have.has(k) ? logoUrl(k, have.get(k)) : null };
  });
}

// What the Logo control shows for a merchant: its key (the path to PUT to), the
// domain in use and where it came from. null for a nameless row.
export function logoInfo(db, merchant) {
  const key = merchantKey(merchant);
  if (!key) return null;
  const r = db.prepare('SELECT domain, source, status, etag FROM merchant_logo WHERE merchant_key = ?').get(key);
  return { key, domain: r?.domain ?? null, source: r?.source ?? null, status: r?.status ?? null, logo: r?.etag ? logoUrl(key, r.etag) : null };
}

// Letters, digits and spaces only, as merchantKey produces; anything else is not a key.
// A bank's key is `bank:` and a lower-case slug.
export const validLogoKey = (k) => typeof k === 'string' && k.length <= 80 && /^(?:bank:[a-z0-9]+(?:-[a-z0-9]+)*|[a-z0-9]+(?: [a-z0-9]+)*)$/.test(k);

// the runner

const SYSTEM = 'You help a personal finance app show brand logos. For each merchant name give the domain of its official website: just the domain, like woolworths.com.au, '
  + 'with no scheme and no path. Prefer the Australian site for an Australian business. If the merchant is a person, a generic payment, a transfer, or you are not reasonably sure, '
  + 'answer null. Reply with JSON only, in the form {"results":[{"i":0,"domain":"woolworths.com.au"},{"i":1,"domain":null}]}.';

export function createLogos({
  db, key = '', model = '', base = 'https://openrouter.ai/api/v1', fetchImpl = globalThis.fetch, hop = safeHop,
  dailyCap = 1500, logoDailyCap = 300, batchSize = 40, maxPerRun = 150, delayMs = 350, timeoutMs = 60_000,
  today = () => zoneDate(), now = () => new Date(), log = console.log,
}) {
  let running = false;
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);

  // One merchant per grouping key, biggest spenders first. Transfers are left out.
  function candidates() {
    const rows = db.prepare(`SELECT COALESCE(t.merchant_override, t.merchant) m, t.description d, COALESCE(-SUM(CASE WHEN t.amount < 0 THEN t.amount END), 0) spend, count(*) n
      FROM ${FROM} WHERE ${COUNTS} AND COALESCE(t.merchant_override, t.merchant) != '' GROUP BY lower(COALESCE(t.merchant_override, t.merchant))`).all();
    const byKey = new Map();
    for (const r of rows) {
      const k = merchantKey(r.m);
      if (!k) continue;
      const c = byKey.get(k);
      if (c) { c.spend += r.spend; c.n += r.n; } else byKey.set(k, { key: k, name: r.m, description: r.d, spend: r.spend, n: r.n });
    }
    return [...byKey.values()].sort((a, b) => b.spend - a.spend || b.n - a.n || (a.key < b.key ? -1 : 1));
  }

  const existing = () => new Map(db.prepare('SELECT merchant_key, domain, source, status, attempts, ai_day, fetched_at FROM merchant_logo').all().map((r) => [r.merchant_key, r]));

  function due(row, at) {
    if (!row) return true;
    if (row.status === 'ok' || row.status === 'manual') return false;
    const age = at - Date.parse(row.fetched_at);
    return age >= (row.status === 'error' ? RETRY_ERROR_MS : RETRY_NONE_MS);
  }

  // Follows redirects only to Google or DuckDuckGo hosts over https.
  async function fromSource(url) {
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      if (!iconHostAllowed(url)) return { kind: 'miss' };
      const res = await hop(url, { timeoutMs: 8000, maxBytes: MAX_IMAGE_BYTES + 1 });
      if (res.status >= 300 && res.status < 400 && res.headers?.location) {
        try { url = new URL(res.headers.location, url).href; } catch { return { kind: 'miss' }; }
        continue;
      }
      if (res.status === 200) {
        const v = checkIcon(res.body);
        return v.ok ? { kind: 'image', image: res.body, type: v.type } : { kind: 'miss' };
      }
      return res.status >= 500 || res.status === 429 || res.status === 408 ? { kind: 'error', error: `HTTP ${res.status}` } : { kind: 'miss' };
    }
    return { kind: 'miss' };
  }

  async function fetchIcon(domain, sources = ICON_SOURCES) {
    let error = null;
    for (const src of sources) {
      try {
        const r = await fromSource(src(domain));
        if (r.kind === 'image') return r;
        if (r.kind === 'error') error = r.error;
      } catch (e) { error = String(e?.message ?? e); }
    }
    return error ? { kind: 'error', error } : { kind: 'miss' };
  }

  // Does the site answer over https? Any HTTP reply counts; a refused or
  // unresolvable host, or a private address, does not.
  async function answers(domain) {
    try { await hop(`https://${domain}/`, { timeoutMs: 6000, readBody: false }); return true; } catch { return false; }
  }

  async function ask(batch) {
    const items = batch.map((m, i) => ({ i, merchant: scrubForModel(m.name) }));
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Mint' },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 40 + batch.length * 25, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Items: ${JSON.stringify(items)}` }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content ?? '');
    let parsed = null;
    try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch {}
    if (!Array.isArray(parsed?.results) || !parsed.results.length) throw new Error('model reply was not usable JSON');
    return { results: parsed.results, usage: data?.usage ?? {} };
  }

  const aiUsage = (d) => db.prepare('SELECT merchants FROM ai_usage WHERE date = ?').get(d)?.merchants ?? 0;

  // One icon per bank the owner banks with, from the map; nothing is asked of the model. A bank not in the
  // map leaves no row and no request. Cheap when nothing is due, so every pass and the boot run it.
  let banksRunning = false;
  async function runBanks() {
    const out = { considered: 0, resolved: 0, none: 0, errors: 0 };
    if (banksRunning) return out;
    banksRunning = true;
    try {
      const at = now().getTime();
      const have = existing();
      const etags = new Map(db.prepare("SELECT merchant_key, etag FROM merchant_logo WHERE merchant_key LIKE 'bank:%'").all().map((r) => [r.merchant_key, r.etag]));
      const banks = new Map();
      for (const r of db.prepare("SELECT DISTINCT institution FROM accounts WHERE status IS NOT 'gone' AND institution IS NOT NULL").all()) {
        const key = bankLogoKey(r.institution);
        const domain = domainForInstitution(r.institution);
        if (!key || !domain || banks.has(key)) continue;
        const own = bundledIcon(domain);
        // A bundled icon is put in once and replaces whatever was fetched before it (source stays 'map': the column's CHECK has no
        // room for another value, and the etag is what says it is the shipped copy); after that it is left alone.
        if (own) { if (have.get(key)?.status !== 'manual' && etags.get(key) !== own.etag) banks.set(key, { domain, own }); } else if (due(have.get(key), at)) banks.set(key, { domain });
      }
      out.considered = banks.size;
      for (const [key, { domain, own }] of banks) {
        if (own) {
          putLogo(db, key, { domain, source: 'map', status: 'ok', image: own.image, type: own.type, attempts: 1, fetchedAt: now().toISOString() });
          out.resolved += 1;
          continue;
        }
        const attempts = (have.get(key)?.attempts ?? 0) + 1;
        const base = { domain, source: 'map', attempts, fetchedAt: now().toISOString() };
        await sleep(delayMs);
        const r = await fetchIcon(domain, BANK_ICON_SOURCES);
        if (r.kind === 'image') { putLogo(db, key, { ...base, status: 'ok', image: r.image, type: r.type }); out.resolved += 1; }
        else if (r.kind === 'error') { putLogo(db, key, { ...base, status: 'error', error: r.error }); out.errors += 1; }
        else { putLogo(db, key, { ...base, status: 'none' }); out.none += 1; }
      }
      if (out.considered) log(`logos: ${out.considered} banks, ${out.resolved} logos, ${out.none} without, ${out.errors} to retry`);
      return out;
    } finally {
      banksRunning = false;
    }
  }

  async function run() {
    if (running) return { already: true, considered: 0, resolved: 0, none: 0, errors: 0, asked: 0 };
    running = true;
    const out = { considered: 0, resolved: 0, none: 0, errors: 0, asked: 0 };
    try {
      await runBanks().catch((e) => log(`logos: banks: ${e?.stack ?? e}`));
      const at = now().getTime();
      const have = existing();
      const todo = candidates().filter((c) => due(have.get(c.key), at)).slice(0, maxPerRun);
      out.considered = todo.length;
      if (!todo.length) return out;

      // 1. The map, then a domain in the name or the bank's text.
      const plan = new Map();
      const unknown = [];
      for (const c of todo) {
        const prev = have.get(c.key);
        const d = domainForMerchant(c.name);
        const t = d ? null : (domainInText(c.name) ?? domainInText(c.description));
        if (d || t) plan.set(c.key, { domain: d ?? t, source: d ? 'map' : 'desc' });
        else if (prev?.domain && prev.source === 'ai') plan.set(c.key, { domain: prev.domain, source: 'ai' });
        else unknown.push(c);
      }

      // 2. One question per merchant ever, batched, inside the daily caps.
      const aiDay = new Map();
      const failed = new Map();
      const toAsk = unknown.filter((c) => !have.get(c.key)?.ai_day);
      if (key && toAsk.length) {
        const d = today();
        const asked = db.prepare('SELECT count(*) n FROM merchant_logo WHERE ai_day = ?').get(d).n;
        const allowance = Math.max(0, Math.min(logoDailyCap - asked, dailyCap - aiUsage(d)));
        const take = toAsk.slice(0, allowance);
        for (let i = 0; i < take.length; i += batchSize) {
          const batch = take.slice(i, i + batchSize);
          let answer;
          try { answer = await ask(batch); } catch (e) {
            for (const c of batch) failed.set(c.key, String(e?.message ?? e));
            log(`logos: model call failed: ${String(e?.message ?? e).slice(0, 120)}`);
            break;
          }
          out.asked += batch.length;
          db.prepare(`INSERT INTO ai_usage (date, calls, merchants, prompt_tokens, completion_tokens) VALUES (?, 1, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET calls = calls + 1, merchants = merchants + excluded.merchants,
              prompt_tokens = prompt_tokens + excluded.prompt_tokens, completion_tokens = completion_tokens + excluded.completion_tokens`)
            .run(d, batch.length, Number(answer.usage.prompt_tokens) || 0, Number(answer.usage.completion_tokens) || 0);
          for (const [j, c] of batch.entries()) {
            const hit = answer.results.find((r) => Number(r?.i) === j);
            if (!hit) { failed.set(c.key, 'the model skipped this merchant'); continue; }
            aiDay.set(c.key, d);
            const dom = validDomain(hit.domain);
            if (!dom) continue;
            await sleep(delayMs);
            if (await answers(dom)) plan.set(c.key, { domain: dom, source: 'ai' });
          }
        }
      }

      // 3. Fetch the icons, a domain at a time.
      const memo = new Map();
      for (const c of todo) {
        const prev = have.get(c.key);
        const attempts = (prev?.attempts ?? 0) + 1;
        const base = { attempts, fetchedAt: now().toISOString(), aiDay: aiDay.get(c.key) ?? null };
        const p = plan.get(c.key);
        if (!p) {
          if (failed.has(c.key)) { putLogo(db, c.key, { ...base, status: 'error', source: 'ai', error: failed.get(c.key) }); out.errors += 1; }
          // Over the daily cap: leave it unrecorded so tomorrow's pass still gets to ask.
          else if (key && toAsk.includes(c) && !aiDay.has(c.key)) { out.considered -= 1; }
          else { putLogo(db, c.key, { ...base, status: 'none', source: prev?.source ?? null }); out.none += 1; }
          continue;
        }
        let r = memo.get(p.domain);
        if (!r) {
          const reuse = db.prepare('SELECT image, content_type FROM merchant_logo WHERE domain = ? AND image IS NOT NULL LIMIT 1').get(p.domain);
          if (reuse) r = { kind: 'image', image: Buffer.from(reuse.image), type: reuse.content_type };
          else { await sleep(delayMs); r = await fetchIcon(p.domain); }
          memo.set(p.domain, r);
        }
        if (r.kind === 'image') { putLogo(db, c.key, { ...base, domain: p.domain, source: p.source, status: 'ok', image: r.image, type: r.type }); out.resolved += 1; }
        else if (r.kind === 'error') { putLogo(db, c.key, { ...base, domain: p.domain, source: p.source, status: 'error', error: r.error }); out.errors += 1; }
        else { putLogo(db, c.key, { ...base, domain: p.domain, source: p.source, status: 'none' }); out.none += 1; }
      }
      log(`logos: ${out.considered} merchants, ${out.resolved} logos, ${out.none} without, ${out.errors} to retry, ${out.asked} asked the model`);
      return out;
    } finally {
      running = false;
    }
  }

  // the owner's own domain for a merchant, or null to clear it. Stored as manual,
  // which a pass never overwrites. A domain with no usable icon is refused and
  // the old row stays.
  async function setManual(merchant, input) {
    if (!validLogoKey(merchant)) throw new HttpError(404, 'no such merchant');
    const prev = db.prepare('SELECT attempts FROM merchant_logo WHERE merchant_key = ?').get(merchant);
    const attempts = (prev?.attempts ?? 0) + 1;
    if (input == null || (typeof input === 'string' && !input.trim())) {
      putLogo(db, merchant, { domain: null, source: 'manual', status: 'manual', attempts, fetchedAt: now().toISOString() });
      return { key: merchant, domain: null, logo: null, status: 'manual' };
    }
    const domain = normaliseDomain(input);
    if (!domain) throw bad('That does not look like a domain. Try something like example.com.au');
    const r = await fetchIcon(domain);
    if (r.kind === 'error') throw new HttpError(502, `Couldn't reach the icon service for ${domain}: ${r.error}`);
    if (r.kind !== 'image') throw new HttpError(422, `No usable icon found for ${domain}`);
    putLogo(db, merchant, { domain, source: 'manual', status: 'manual', attempts, image: r.image, type: r.type, fetchedAt: now().toISOString() });
    return { key: merchant, domain, logo: logoUrl(merchant, getLogo(db, merchant).etag), status: 'manual' };
  }

  return { run, runBanks, setManual, candidates };
}
