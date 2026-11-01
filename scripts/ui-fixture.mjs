// A throwaway Mint over invented data, for screenshots and UI passes. Starts the
// fake Redbark from test/fixtures, a real server.mjs on 127.0.0.1:<port> in a
// temp MINT_HOME (lock off, scheduler off, no .env read), runs one sync and seeds
// budgets, goals, assets, holdings, subscriptions and debts through the API.
//   node scripts/ui-fixture.mjs [port] [--empty] [--today now|YYYY-MM-DD] [--browse] [--home DIR]
// Open it with the headers `Remote-User: owner` and the `X-Mint-Gate` it prints, or pass --browse to get a small proxy on
// <port> that adds the header, so a plain browser works (the server itself then runs on a free port).
// Ctrl-C stops it and deletes the temp home (a --home DIR is kept).
// Nothing here is real account data. The dates below were written for 2026-10-20 and are
// shifted to --today (default 2026-10-20, so the docs shots reproduce; `now` is today in Perth).
// scripts/demo-seed.mjs is the same thing with the demo defaults.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const opt = (n) => (ARGV.includes(n) ? ARGV[ARGV.indexOf(n) + 1] : null);
const VALUE_FLAGS = ['--today', '--home'];
const PORT = ARGV.find((a, i) => /^\d+$/.test(a) && !VALUE_FLAGS.includes(ARGV[i - 1])) || '8991';
const BROWSE = ARGV.includes('--browse');
// Mint refuses any request without the gateway's shared secret, so the fixture makes one per run.
const GATE = randomBytes(24).toString('hex');
const { fakeRedbark, FAKE_KEY } = await import(join(ROOT, 'test/fixtures/fake-redbark.mjs'));
const fx = await import(join(ROOT, 'test/fixtures/data.mjs'));

const BASE = '2026-10-20'; // the day the dates below were written for
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayArg = opt('--today') || BASE;
const TODAY = todayArg === 'now' ? new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' }) : todayArg;
if (!/^\d{4}-\d{2}-\d{2}$/.test(TODAY)) { console.error('--today must be now or YYYY-MM-DD'); process.exit(1); }
const SHIFT = Math.round((Date.parse(TODAY) - Date.parse(BASE)) / 86400000);
const D = (iso) => addDays(iso, SHIFT); // a date written for BASE, moved to TODAY
let rnd = 7; const R = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(R() * a.length)];
const accounts = [
  { ...fx.accounts[0], name: 'Everyday Account', institution: { id: 'inst_cba', name: 'Commonwealth Bank', logo: null } },
  { ...fx.accounts[1], name: 'Smart Awards Card', institution: { id: 'inst_cba', name: 'Commonwealth Bank', logo: null } },
  { ...fx.accounts[2], name: 'Home Loan', institution: { id: 'inst_anz', name: 'ANZ', logo: null } },
  { ...fx.accounts[3], name: 'Offset Account', institution: { id: 'inst_anz', name: 'ANZ', logo: null } },
  { ...fx.accounts[0], id: 'acct_test_save', connection: 'conn_test_alpha', name: 'Goal Saver', institution: { id: 'inst_ing', name: 'ING', logo: null }, account_number: 'xxxx5555' },
];
const connections = [
  { ...fx.connections[0], institution: { id: 'inst_cba', name: 'Commonwealth Bank', logo: null }, account_count: 3 },
  // A fresh demo has no "consent ends soon" banner; the pinned docs date keeps the original expiry so the banner shots reproduce.
  { ...fx.connections[1], institution: { id: 'inst_anz', name: 'ANZ', logo: null }, account_count: 2, status: 'active', consent: { ...fx.connections[1].consent, status: 'active', ...(todayArg === 'now' ? { expires_at: `${addDays(TODAY, 300)}T00:00:00.000Z` } : { expires_at: `${D('2026-10-27')}T00:00:00.000Z` }) } },
];
const bal = (c) => ({ amount: c, currency: 'aud' });
const balances = {
  acct_test_everyday: { current: bal(342518), available: bal(342518) },
  acct_test_card: { current: bal(-128440), available: bal(871560) },
  acct_test_loan: { current: bal(-41250000), available: bal(0) },
  acct_test_offset: { current: bal(2845000), available: bal(2845000) },
  acct_test_save: { current: bal(1870000), available: bal(1870000) },
};
const T = [];
// The bank's own category per merchant, so the demo looks categorised the way a real feed is.
const PC = [[/NETFLIX|SPOTIFY|APPLE\.COM|ADOBE/, 'ENTERTAINMENT'], [/ANYTIME FITNESS/, 'PERSONAL_CARE'], [/TELSTRA|ORIGIN ENERGY|WATER CORP/, 'RENT_AND_UTILITIES'], [/RAC INSURANCE|DIGITALOCEAN/, 'SERVICES'],
  [/BUNNINGS|KMART|JB HI|AMAZON|OFFICEWORKS|CHEMIST|DAN MURPHY/, 'GENERAL_MERCHANDISE'], [/SHELL|BP EXPRESS|7-ELEVEN|TRANSPERTH/, 'TRANSPORTATION']];
const add = (a, d, amt, desc, x = {}) => T.push(fx.tx(a, d, amt, desc, amt < 0 && !x.provider_category && PC.find(([re]) => re.test(desc)) ? { ...x, provider_category: PC.find(([re]) => re.test(desc))[1] } : x));
const E = 'acct_test_everyday', C = 'acct_test_card', L = 'acct_test_loan', O = 'acct_test_offset', S = 'acct_test_save';
const start = addDays(TODAY, -240);
// salary fortnightly, last on 2026-10-14
for (let d = D('2026-10-14'); d >= start; d = addDays(d, -14)) {
  add(E, d, 264000, 'SALARY/WAGES ACME CONSULTING PTY LTD', { provider_category: 'INCOME' });
  add(E, d, -60000, 'TRANSFER TO GOAL SAVER NETBANK', { provider_category: 'TRANSFER_OUT' });
  add(S, d, 60000, 'TRANSFER FROM EVERYDAY NETBANK', { provider_category: 'TRANSFER_IN' });
}
const groceries = ['WOOLWORTHS 4821 PERTH WA', 'COLES 0443 SUBIACO WA', 'ALDI STORES 112 LEEDERVILLE', 'IGA X-PRESS NORTHBRIDGE'];
const eats = ['THE LITTLE BAKERY NORTHBRIDGE', 'MUMS CAFE LEEDERVILLE', 'GUZMAN Y GOMEZ PERTH', 'THE DUKE OF GEORGE', 'DOMINOS PIZZA 3312', 'UBER *EATS HELP.UBER.COM', 'MCDONALDS MORLEY'];
const fuel = ['SHELL COLES EXPRESS 4411', 'BP EXPRESS MORLEY', '7-ELEVEN 2201 PERTH'];
const shop = ['BUNNINGS 482000 BALCATTA', 'KMART PERTH CBD', 'JB HI-FI GARDEN CITY', 'AMAZON AU MARKETPLACE', 'OFFICEWORKS 018', 'CHEMIST WAREHOUSE PERTH', 'DAN MURPHYS 6021'];
for (let d = start; d <= TODAY; d = addDays(d, 1)) {
  if (R() < 0.55) add(C, d, -Math.round((1800 + R() * 14000)), pick(groceries));
  if (R() < 0.45) add(R() < 0.5 ? C : E, d, -Math.round(650 + R() * 4800), pick(eats));
  if (R() < 0.12) add(C, d, -Math.round(5500 + R() * 6000), pick(fuel));
  if (R() < 0.14) add(C, d, -Math.round(1900 + R() * 22000), pick(shop));
  if (R() < 0.10) add(E, d, -Math.round(450 + R() * 600), 'TRANSPERTH SMARTRIDER AUTOLOAD');
}
// monthly bills
for (let m = 0; m < 8; m++) {
  const f = (day, off = 0) => addDays(TODAY.slice(0, 7) + '-01', -30 * m + day + off);
  for (const [day, amt, desc, a] of [[2, -1599, 'NETFLIX.COM', C], [4, -1199, 'SPOTIFY P1A2B3', C], [5, -9500, 'TELSTRA POSTPAID', E], [7, -18900, 'ORIGIN ENERGY', E], [9, -7400, 'WATER CORPORATION', E], [11, -4950, 'ANYTIME FITNESS', E], [3, -1299, 'APPLE.COM/BILL', C], [14, -2999, 'ADOBE CREATIVE CLOUD', C], [16, -17500, 'RAC INSURANCE PREMIUM', E]]) {
    const d = f(day); if (d <= TODAY && d >= start) add(a, d, amt, desc);
  }
  const rep = addDays(TODAY.slice(0, 7) + '-01', -30 * m + 1);
  if (rep <= TODAY && rep >= start) { add(E, rep, -213000, 'LOAN REPAYMENT HOME LOAN', { provider_category: 'TRANSFER_OUT' }); add(L, rep, 213000, 'LOAN REPAYMENT FROM EVERYDAY', { provider_category: 'TRANSFER_IN' }); add(L, rep, -91500, 'INTEREST CHARGE', {}); }
  const cp = addDays(TODAY.slice(0, 7) + '-01', -30 * m + 12);
  if (cp <= TODAY && cp >= start) { add(E, cp, -120000, 'BPAY CARD REPAYMENT', { provider_category: 'TRANSFER_OUT' }); add(C, cp, 120000, 'PAYMENT THANK YOU', { provider_category: 'TRANSFER_IN' }); }
}
add(E, TODAY, -1450, 'THE LITTLE BAKERY NORTHBRIDGE', { id: 'txn_ui_pending1', status: 'pending' });
add(C, TODAY, -8920, 'WOOLWORTHS 4821 PERTH WA', { id: 'txn_ui_pending2', status: 'pending' });
add(E, addDays(TODAY, -3), 18000, 'INTEREST PAID', { provider_category: 'INCOME' });
for (let m = 0; m < 8; m++) { const d = addDays(D('2026-10-17'), -30 * m); add(E, d, 45000, 'FROM JORDAN SMITH RENT SHARE', { provider_category: 'INCOME' }); }
add(C, addDays(TODAY, -2), -49900, 'DIGITALOCEAN.COM', {});
add(C, addDays(TODAY, -9), -128000, 'OFFICEWORKS 018 DESK', {});
const by = {};
for (const t of T) (by[t.account] ??= []).push(t);

const E0 = process.argv.includes('--empty');
const fake = fakeRedbark({ connections: E0 ? [] : connections, accounts: E0 ? [] : accounts, balances, details: { acct_test_loan: fx.details.acct_test_loan }, transactions: E0 ? {} : by, today: TODAY });
const l = await fake.listen();
const keepHome = opt('--home');
const home = keepHome || mkdtempSync(join(tmpdir(), 'mint-ui-'));
if (keepHome) mkdirSync(home, { recursive: true });
// With --browse the server hides on a free port and a proxy on PORT adds the gateway's Remote-User header.
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(String(port))); }); });
const INNER = BROWSE ? await freePort() : PORT;
const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, MINT_HOME: home, MINT_PORT: INNER, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner', MINT_GATE_KEY: GATE, ...(BROWSE ? { MINT_ORIGIN: `http://127.0.0.1:${PORT}` } : {}), REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: l.base }, stdio: ['ignore', 'inherit', 'inherit'] });
let front = null;
if (BROWSE) {
  front = createServer((req, res) => {
    const up = httpRequest({ host: '127.0.0.1', port: INNER, path: req.url, method: req.method, headers: { ...req.headers, 'remote-user': 'owner', 'x-mint-gate': GATE } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end('Mint is not up yet'); });
    req.pipe(up);
  }).listen(Number(PORT), process.env.MINT_DEMO_HOST || '127.0.0.1');
}
process.on('SIGTERM', () => { p.kill(); front?.close(); fake && l.server.close(); if (!keepHome) rmSync(home, { recursive: true, force: true }); process.exit(0); });
process.on('SIGINT', () => process.emit('SIGTERM'));
console.log('fixture home', home);

// ---- seed through the API once the server is up
const B = `http://127.0.0.1:${INNER}`;
const call = async (m, path, body) => { const r = await fetch(B + path, { method: m, headers: { 'remote-user': 'owner', 'x-mint-gate': GATE, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); if (!r.ok) console.log('seed', m, path, r.status, t.slice(0, 120)); try { return JSON.parse(t); } catch { return t; } };
for (let i = 0; i < 50; i++) { try { await fetch(B + '/healthz'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
await call('POST', '/api/sync', {});
await new Promise((r) => setTimeout(r, 5000));
if (!E0) {
  await call('POST', '/api/budgets/starter', {});
  await call('POST', '/api/manual/accounts', { name: 'Cash Stash', institution: 'Manual', type: 'savings', currency: 'AUD', opening_balance: 120000 });
  const values = { 'Family car': 2150000, 'Super (AustralianSuper)': 8420000, 'Unit at Mount Lawley': 61000000, 'Car loan': 1180000 };
  for (const [name, kind, debt] of [['Family car', 'vehicle', false], ['Super (AustralianSuper)', 'super', false], ['Unit at Mount Lawley', 'property', false], ['Car loan', 'other', true]]) {
    const a = await call('POST', '/api/assets', { name, kind, is_liability: debt });
    for (const [d, f] of [[D('2026-05-01'), 0.96], [D('2026-08-01'), 0.98], [D('2026-10-01'), 1]]) await call('POST', `/api/assets/${a.id}/snapshots`, { date: d, value: Math.round(values[name] * f), contribution: kind === 'super' ? 90000 : null });
  }
  for (const [t, n, u, c, p] of [['VAS', 'Vanguard Australian Shares', 410, 94.2, 104.5], ['VGS', 'Vanguard Intl Shares', 220, 118.4, 131.9], ['NDQ', 'BetaShares Nasdaq 100', 95, 41.1, 38.7]]) await call('POST', '/api/holdings', { ticker: t, exchange: 'ASX', name: n, lots: [{ date: D('2025-03-10'), units: u, price: c, brokerage: 950 }], manual_price: p });
  const acc = await call('GET', '/api/accounts');
  const id = (n) => acc.accounts.find((a) => a.name.includes(n))?.id;
  await call('PUT', '/api/plan', { lines: [{ account_id: id('Goal Saver'), kind: 'saving', amount: 60000 }, { account_id: id('Home Loan'), kind: 'debt', amount: 20000 }, { account_id: id('Offset'), kind: 'saving', percent: 5 }] });
  await call('POST', '/api/goals', { name: 'House deposit', target_amount: 8000000, target_date: D('2028-06-01'), account_id: id('Goal Saver') });
  await call('POST', '/api/goals', { name: 'Japan trip', target_amount: 1200000, target_date: D('2027-03-01'), account_id: id('Cash Stash') });
  await call('POST', '/api/goals', { name: 'Emergency fund', target_amount: 2500000, target_date: null, account_id: id('Offset') });
  await call('POST', '/api/goals', { name: 'New laptop', target_amount: null });
  for (const [person, amount, note, lent, due, dir] of [['Jordan Smith', 32000, 'Concert tickets', D('2026-09-02'), D('2026-10-01'), 'owed_to_me'], ['Priya Nair', 18500, 'Dinner split', D('2026-10-09'), null, 'owed_to_me'], ['Sam Taylor', 60000, 'Bond share', D('2026-08-15'), D('2026-11-30'), 'owed_to_me'], ['Mum', 25000, 'Fuel money', D('2026-10-12'), null, 'i_owe']]) await call('POST', '/api/owed', { person, amount, note, lent_on: lent, due_on: due, direction: dir });
  for (const [name, amount, next] of [['Netflix', 1599, D('2026-11-02')], ['Spotify', 1199, D('2026-11-04')], ['Adobe Creative Cloud', 2999, D('2026-11-14')], ['Anytime Fitness', 4950, D('2026-11-11')], ['DigitalOcean', 49900, D('2026-11-18')]]) await call('POST', '/api/subscriptions', { name, amount, cadence: 'monthly', next_date: next });
  await call('POST', '/api/subscriptions', { name: 'Stan', amount: 1200, cadence: 'monthly', next_date: D('2026-10-25'), status: 'cancelled', cancelled_on: D('2026-09-25') });
}
console.log(BROWSE ? `ready: open http://127.0.0.1:${PORT}/ (Ctrl-C stops it)` : `ready on ${B} (send Remote-User: owner and X-Mint-Gate: ${GATE}, or use --browse)`);
