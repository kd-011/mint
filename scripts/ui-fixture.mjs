// A throwaway Mint over invented data, for screenshots and UI passes. Starts the
// fake Redbark from test/fixtures, a real server.mjs on 127.0.0.1:<port> in a
// temp MINT_HOME (lock off, scheduler off, no .env read), runs one sync and seeds
// budgets, goals, assets, holdings, subscriptions and debts through the API.
//   node scripts/ui-fixture.mjs [port] [--empty] [--no-redbark] [--today now|YYYY-MM-DD] [--browse] [--home DIR]
// Open it with the headers `Remote-User: owner` and the `X-Mint-Gate` it prints, or pass --browse to get a small proxy on
// <port> that adds the header, so a plain browser works (the server itself then runs on a free port).
// Ctrl-C stops it and deletes the temp home (a --home DIR is kept).
// Nothing here is real account data. The dates below were written for 2026-10-20 and are
// shifted to --today (default 2026-10-20; `now` is today in the MINT_TZ zone). The pay story (salary, split, bills) is
// built from --today itself: the salary landed yesterday, fortnightly before that.
// scripts/demo-seed.mjs is the same thing with the demo defaults.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
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
const { zoneDate } = await import(join(ROOT, 'lib/dates.mjs'));
const { createFront } = await import(join(ROOT, 'lib/localfront.mjs'));
const { fakeRedbark, FAKE_KEY } = await import(join(ROOT, 'test/fixtures/fake-redbark.mjs'));
const fx = await import(join(ROOT, 'test/fixtures/data.mjs'));

const BASE = '2026-10-20'; // the day the dates below were written for
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayArg = opt('--today') || BASE;
const TODAY = todayArg === 'now' ? zoneDate() : todayArg;
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
  acct_test_everyday: { current: bal(421560), available: bal(421560) },
  acct_test_card: { current: bal(-128440), available: bal(871560) },
  acct_test_loan: { current: bal(-41218450), available: bal(0) },
  acct_test_offset: { current: bal(2845000), available: bal(2845000) },
  acct_test_save: { current: bal(1870000), available: bal(1870000) },
};
const T = [];
// The bank's own category per merchant, so the demo looks categorised the way a real feed is.
const PC = [[/NETFLIX|SPOTIFY|APPLE\.COM|ADOBE/, 'ENTERTAINMENT'], [/ANYTIME FITNESS/, 'PERSONAL_CARE'], [/TELSTRA|ORIGIN ENERGY|WATER CORP/, 'RENT_AND_UTILITIES'], [/ALLIANZ INSURANCE|TAX SERVICES/, 'SERVICES'],
  [/BUNNINGS|KMART|JB HI|AMAZON|OFFICEWORKS|CHEMIST|DAN MURPHY/, 'GENERAL_MERCHANDISE'], [/SHELL|AMPOL|7-ELEVEN|TRANSPERTH/, 'TRANSPORTATION'], [/DONATION/, 'GENERAL_SERVICES']];
const add = (a, d, amt, desc, x = {}) => T.push(fx.tx(a, d, amt, desc, amt < 0 && !x.provider_category && PC.find(([re]) => re.test(desc)) ? { ...x, provider_category: PC.find(([re]) => re.test(desc))[1] } : x));
const E = 'acct_test_everyday', C = 'acct_test_card', L = 'acct_test_loan', O = 'acct_test_offset', S = 'acct_test_save';
const start = addDays(TODAY, -240);
// The story: one salary, fortnightly, that landed yesterday. Each payday the pay split moves $600 to the
// goal saver, a $1,150 fortnightly repayment into the home loan and 5% into the offset. Every past payday
// is done; this one has the saver and the loan done and the offset transfer still to run, so the plan is
// mostly done with one line pending.
const PAY = 340000, REPAY = 115000, OFFSET_PCT = 5, SAVE = 60000;
const LAST_PAY = addDays(TODAY, -1);
for (let d = LAST_PAY; d >= start; d = addDays(d, -14)) {
  add(E, d, PAY, 'SALARY/WAGES ACME CONSULTING PTY LTD', { provider_category: 'INCOME' });
  add(E, d, -SAVE, 'TRANSFER TO GOAL SAVER NETBANK', { provider_category: 'TRANSFER_OUT' });
  add(S, d, SAVE, 'TRANSFER FROM EVERYDAY NETBANK', { provider_category: 'TRANSFER_IN' });
  add(E, d, -REPAY, 'LOAN REPAYMENT HOME LOAN', { provider_category: 'TRANSFER_OUT' });
  add(L, d, REPAY, 'LOAN REPAYMENT FROM EVERYDAY', { provider_category: 'TRANSFER_IN' });
  if (d !== LAST_PAY) {
    const off = Math.round((PAY * OFFSET_PCT) / 100);
    add(E, d, -off, 'TRANSFER TO OFFSET ACCOUNT', { provider_category: 'TRANSFER_OUT' });
    add(O, d, off, 'TRANSFER FROM EVERYDAY', { provider_category: 'TRANSFER_IN' });
  }
}
// Groceries are mostly Woolworths so a search for it fills a screen with real spending.
const groceries = [...Array(6).fill('WOOLWORTHS'), 'COLES', 'COLES', 'ALDI', 'IGA'];
const eats = ['THE LITTLE BAKERY NORTHBRIDGE', 'MUMS CAFE LEEDERVILLE', 'GUZMAN Y GOMEZ', 'THE CORNER HOTEL', 'DOMINOS', 'UBER EATS', 'MCDONALDS'];
const fuel = ['SHELL SERVICE STATION', 'AMPOL', '7-ELEVEN'];
const shop = ['BUNNINGS', 'KMART', 'JB HI-FI', 'AMAZON AU', 'OFFICEWORKS', 'CHEMIST WAREHOUSE', 'DAN MURPHYS'];
for (let d = start; d <= TODAY; d = addDays(d, 1)) {
  if (R() < 0.42) add(C, d, -Math.round((2200 + R() * 10800)), pick(groceries));
  if (R() < 0.35) add(R() < 0.5 ? C : E, d, -Math.round(650 + R() * 3300), pick(eats));
  if (R() < 0.10) add(C, d, -Math.round(5500 + R() * 5000), pick(fuel));
  if (R() < 0.08) add(C, d, -Math.round(1900 + R() * 15000), pick(shop));
  if (R() < 0.08) add(E, d, -Math.round(450 + R() * 600), 'TRANSPERTH SMARTRIDER AUTOLOAD');
}
// monthly bills, on real calendar days. Netflix put its price up on the latest charge.
const monthStart = (m) => { const d = new Date(`${TODAY.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - m); return d.toISOString().slice(0, 10); };
const onDay = (m, day) => addDays(monthStart(m), day - 1);
const live = (d) => d <= TODAY && d >= start;
const bills = [[2, -1599, 'NETFLIX.COM', C, -1899], [4, -1199, 'SPOTIFY PREMIUM', C], [5, -9500, 'TELSTRA POSTPAID', E], [7, -18900, 'ORIGIN ENERGY', E], [9, -7400, 'WATER CORPORATION', E], [11, -4950, 'ANYTIME FITNESS', E], [3, -1299, 'APPLE.COM/BILL', C], [14, -2999, 'ADOBE CREATIVE CLOUD', C], [16, -17500, 'ALLIANZ INSURANCE', E]];
for (const [day, amt, desc, a, rise] of bills) {
  const latest = [0, 1].find((m) => live(onDay(m, day)));
  for (let m = 0; m < 9; m++) { const d = onDay(m, day); if (live(d)) add(a, d, m === latest && rise ? rise : amt, desc); }
}
for (let m = 0; m < 9; m++) {
  const cp = onDay(m, 12);
  if (live(cp)) { add(E, cp, -180000, 'BPAY CARD REPAYMENT', { provider_category: 'TRANSFER_OUT' }); add(C, cp, 180000, 'PAYMENT THANK YOU', { provider_category: 'TRANSFER_IN' }); }
  const rent = onDay(m, 17);
  if (live(rent)) add(E, rent, 45000, 'FROM JORDAN SMITH RENT SHARE', { provider_category: 'INCOME' });
}
add(E, TODAY, -1450, 'THE LITTLE BAKERY NORTHBRIDGE', { id: 'txn_ui_pending1', status: 'pending' });
add(C, TODAY, -8920, 'WOOLWORTHS', { id: 'txn_ui_pending2', status: 'pending' });
add(E, addDays(TODAY, -3), 18000, 'INTEREST PAID', { provider_category: 'INCOME' });
// the deductible spend that gets tagged below (work software and gear, donations, a tax agent)
// They are clamped to the current financial year (1 July) so the tax view is never empty in early July.
const fyStart = `${Number(TODAY.slice(5, 7)) >= 7 ? TODAY.slice(0, 4) : Number(TODAY.slice(0, 4)) - 1}-07-01`;
const inFy = (back) => { const d = addDays(TODAY, -back); return d < fyStart ? fyStart : d; };
add(C, inFy(9), -128000, 'OFFICEWORKS', { id: 'txn_ui_desk' });
add(E, inFy(6), -10000, 'RED CROSS AUSTRALIA DONATION', {});
add(E, inFy(13), -5000, 'SALVATION ARMY DONATION', {});
add(E, inFy(19), -22000, 'ACME TAX SERVICES', {});
const by = {};
for (const t of T) (by[t.account] ??= []).push(t);

const E0 = process.argv.includes('--empty');
const NO_RB = process.argv.includes('--no-redbark'); // a self-hoster with no Redbark key: no bank feed, no first sync
const fake = fakeRedbark({ connections: E0 ? [] : connections, accounts: E0 ? [] : accounts, balances, details: { acct_test_loan: { ...fx.details.acct_test_loan, loan_details: { ...fx.details.acct_test_loan.loan_details, repayment_frequency: 'P14D', next_instalment_date: addDays(LAST_PAY, 14), loan_end_date: addDays(TODAY, 9800), original_loan_amount: '435000.00', original_start_date: addDays(TODAY, -990) } } }, transactions: E0 ? {} : by, today: TODAY });
const l = await fake.listen();
const keepHome = opt('--home');
const home = keepHome || mkdtempSync(join(tmpdir(), 'mint-ui-'));
if (keepHome) mkdirSync(home, { recursive: true });
// With --browse the server hides on a free port and a proxy on PORT adds the gateway's Remote-User header.
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(String(port))); }); });
const INNER = BROWSE ? await freePort() : PORT;
const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, MINT_HOME: home, MINT_PORT: INNER, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner', MINT_GATE_KEY: GATE, ...(process.env.MINT_TZ ? { MINT_TZ: process.env.MINT_TZ } : {}), ...(BROWSE ? { MINT_ORIGIN: `http://127.0.0.1:${PORT}`, NODE_NO_WARNINGS: '1' } : {}), ...(NO_RB ? {} : { REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: l.base }) }, stdio: ['ignore', BROWSE ? 'ignore' : 'inherit', 'inherit'] });
let front = null;
let seeded = false;
if (BROWSE) {
  front = createFront({ innerPort: INNER, gate: GATE, upstreamOrigin: `http://127.0.0.1:${PORT}`, ready: () => seeded, loading: 'Loading the demo data. This takes about ten seconds.' })
    .listen(Number(PORT), process.env.MINT_DEMO_HOST || '127.0.0.1');
}
process.on('SIGTERM', () => { p.kill(); front?.close(); fake && l.server.close(); if (!keepHome) rmSync(home, { recursive: true, force: true }); process.exit(0); });
process.on('SIGINT', () => process.emit('SIGTERM'));
console.log(BROWSE ? 'Loading the demo data, about ten seconds...' : `fixture home ${home}`);

// ---- seed through the API once the server is up
const B = `http://127.0.0.1:${INNER}`;
const call = async (m, path, body) => { const r = await fetch(B + path, { method: m, headers: { 'remote-user': 'owner', 'x-mint-gate': GATE, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); if (!r.ok) console.log('seed', m, path, r.status, t.slice(0, 120)); try { return JSON.parse(t); } catch { return t; } };
for (let i = 0; i < 50; i++) { try { await fetch(B + '/healthz'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
if (!NO_RB) {
  await call('POST', '/api/sync', {});
  await new Promise((r) => setTimeout(r, 5000));
}
if (!E0) {
  await call('POST', '/api/budgets/starter', {});
  await call('POST', '/api/manual/accounts', { name: 'Cash Stash', institution: 'Manual', type: 'savings', currency: 'AUD', opening_balance: 450000 });
  const values = { 'Family car': 2150000, 'Super (AustralianSuper)': 8420000, 'Unit at Mount Lawley': 61000000, 'Car loan': 1180000 };
  for (const [name, kind, debt] of [['Family car', 'vehicle', false], ['Super (AustralianSuper)', 'super', false], ['Unit at Mount Lawley', 'property', false], ['Car loan', 'other', true]]) {
    const a = await call('POST', '/api/assets', { name, kind, is_liability: debt });
    for (const [d, f] of [[D('2026-05-01'), 0.96], [D('2026-08-01'), 0.98], [D('2026-10-01'), 1]]) await call('POST', `/api/assets/${a.id}/snapshots`, { date: d, value: Math.round(values[name] * f), contribution: kind === 'super' ? 90000 : null });
  }
  for (const [t, n, u, c, p] of [['VAS', 'Vanguard Australian Shares', 410, 94.2, 104.5], ['VGS', 'Vanguard Intl Shares', 220, 118.4, 131.9], ['NDQ', 'BetaShares Nasdaq 100', 95, 41.1, 38.7]]) await call('POST', '/api/holdings', { ticker: t, exchange: 'ASX', name: n, lots: [{ date: D('2025-03-10'), units: u, price: c, brokerage: 950 }], manual_price: p });
  const acc = await call('GET', '/api/accounts');
  const id = (n) => acc.accounts.find((a) => a.name.includes(n))?.id;
  await call('PUT', '/api/plan', { lines: [{ account_id: id('Goal Saver'), kind: 'saving', amount: SAVE }, { account_id: id('Home Loan'), kind: 'debt', amount: REPAY }, { account_id: id('Offset'), kind: 'saving', percent: OFFSET_PCT }] });
  // House deposit is behind its date at $600 a payday; the emergency fund is on pace for its date.
  await call('POST', '/api/goals', { name: 'House deposit', target_amount: 5000000, target_date: addDays(TODAY, 600), account_id: id('Goal Saver') });
  await call('POST', '/api/goals', { name: 'Emergency fund', target_amount: 3000000, target_date: addDays(TODAY, 160), account_id: id('Offset') });
  await call('POST', '/api/goals', { name: 'Japan trip', target_amount: 800000, target_date: addDays(TODAY, 130), account_id: id('Cash Stash') });
  for (const [person, amount, note, lent, due, dir] of [['Jordan Smith', 32000, 'Concert tickets', D('2026-09-02'), D('2026-10-01'), 'owed_to_me'], ['Priya Nair', 18500, 'Dinner split', D('2026-10-09'), null, 'owed_to_me'], ['Sam Taylor', 60000, 'Bond share', D('2026-08-15'), D('2026-11-30'), 'owed_to_me'], ['Mum', 25000, 'Fuel money', D('2026-10-12'), null, 'i_owe']]) await call('POST', '/api/owed', { person, amount, note, lent_on: lent, due_on: due, direction: dir });
  // Netflix, Spotify, Apple, Adobe and the gym are found from the bank feed; only a cancelled one is entered by hand.
  await call('POST', '/api/subscriptions', { name: 'Stan', amount: 1200, cadence: 'monthly', next_date: D('2026-10-25'), status: 'cancelled', cancelled_on: D('2026-09-25') });
  // ATO tags: work software and a desk (D5), half of the phone plan as work use (D5), donations (D9), the tax agent (D10).
  const tag = async (q, code, share = 1, note = null) => {
    const r = await call('GET', `/api/transactions?q=${encodeURIComponent(q)}&direction=out&limit=100`);
    for (const t of r.items ?? []) await call('PUT', `/api/transactions/${t.id}/tax`, { ato_category: code, deductible_amount: Math.round(-t.amount * share), note });
  };
  await tag('ADOBE CREATIVE', 'D5', 1, 'Work software');
  await call('PUT', '/api/transactions/txn_ui_desk/tax', { ato_category: 'D5', deductible_amount: 128000, note: 'Standing desk for the home office' });
  await tag('TELSTRA', 'D5', 0.5, '50% work use');
  await tag('RED CROSS', 'D9');
  await tag('SALVATION ARMY', 'D9');
  await tag('ACME TAX SERVICES', 'D10');
}
seeded = true;
console.log(BROWSE ? `ready: open http://127.0.0.1:${PORT}/ (Ctrl-C stops it)` : `ready on ${B} (send Remote-User: owner and X-Mint-Gate: ${GATE}, or use --browse)`);
