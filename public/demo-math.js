// Demo mode: the pure side. One random factor scales every dollar on screen so
// the owner can hand the phone round without showing his real money. One factor, not
// per-value noise, so the arithmetic stays true: tiles still sum to net worth,
// bars and percentages hold, chart shapes do not change. Also which writes a
// demo screen must refuse, and how account numbers are masked. No DOM and no
// storage here; core.js keeps the state in localStorage and applies it in the
// formatters. The same file runs in the page and in the tests.
'use strict';

// The factor lives in 0.35 to 2.6, never inside the gap around 1.0 (a screen that
// looks nearly real would defeat the point).
const DEMO_RANGE = { min: 0.35, max: 2.6, gapLo: 0.7, gapHi: 1.4 };
const DEMO_BLOCKED_MSG = 'Turn off demo mode to make changes';
// A shuffle must be visible, so the new factor is at least this far (as a ratio) from the old.
const DEMO_MIN_SHIFT = 1.15;

const demoFactorOk = (f) => typeof f === 'number' && Number.isFinite(f) && f >= DEMO_RANGE.min && f <= DEMO_RANGE.max && (f <= DEMO_RANGE.gapLo || f >= DEMO_RANGE.gapHi);

// A draw inside one band, evenly across its log width so 0.5x and 2x are as likely as each other.
function demoDraw(lo, hi, r) {
  const t = Math.min(0.999999, Math.max(0, r));
  const f = Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo)));
  return Math.min(hi, Math.max(lo, Math.round(f * 1000) / 1000));
}
const demoLowBand = (r) => demoDraw(DEMO_RANGE.min, DEMO_RANGE.gapLo, r);
const demoHighBand = (r) => demoDraw(DEMO_RANGE.gapHi, DEMO_RANGE.max, r);

// A new factor. With a previous one, it is never close to it: when the draw lands near,
// it is taken from the other side of 1.0 instead, which is always at least twice as far.
function demoPickFactor(prev = null, rand = Math.random) {
  const lowW = Math.log(DEMO_RANGE.gapLo / DEMO_RANGE.min);
  const highW = Math.log(DEMO_RANGE.max / DEMO_RANGE.gapHi);
  const pickLow = rand() * (lowW + highW) < lowW;
  let f = pickLow ? demoLowBand(rand()) : demoHighBand(rand());
  if (demoFactorOk(prev) && Math.max(f, prev) / Math.min(f, prev) < DEMO_MIN_SHIFT) f = prev < 1 ? demoHighBand(rand()) : demoLowBand(rand());
  return f;
}

// State is { on, factor }. Anything stored that is not a valid on-state reads as off,
// so a hand-edited value can never leave a near-1 factor on screen.
const DEMO_OFF = Object.freeze({ on: false, factor: null });
function demoParse(raw) {
  let v = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch { return { ...DEMO_OFF }; } }
  if (v && typeof v === 'object' && v.on === true && demoFactorOk(v.factor)) return { on: true, factor: v.factor };
  return { ...DEMO_OFF };
}
const demoTurnOn = (_state, rand = Math.random) => ({ on: true, factor: demoPickFactor(null, rand) });
const demoTurnOff = () => ({ ...DEMO_OFF });
const demoShuffle = (state, rand = Math.random) => (state?.on ? { on: true, factor: demoPickFactor(state.factor, rand) } : state);

// Cents in, cents out. Linear, and not rounded, so the sum of scaled values equals the
// scaled sum exactly; the formatter rounds once, when it prints.
const demoScale = (cents, state) => (state?.on && typeof cents === 'number' && Number.isFinite(cents) ? cents * state.factor : cents);

// The other way: an amount typed into a form on a scaled screen back to real cents, so the checks
// that compare it with real figures (over the payday, more than is owed) still agree with the screen.
const demoUnscale = (cents, state) => (state?.on && typeof cents === 'number' && Number.isFinite(cents) ? cents / state.factor : cents);

// A sentence the server wrote with dollars baked in ("$1,234.56 on 05/10/2026 ..."):
// every dollar amount is scaled and keeps its shape (cents or whole dollars, sign, commas).
function demoScaleText(text, state) {
  if (!state?.on || typeof text !== 'string' || !text) return text;
  return text.replace(/(-?)\$(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/g, (_m, sign, whole, frac) => {
    const digits = frac ? frac.length - 1 : 0;
    const v = Number(`${whole.replace(/,/g, '')}${frac ?? ''}`) * state.factor;
    return `${sign}$${v.toLocaleString('en-AU', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  });
}

// Account numbers, BSBs and last-4 digits become dots; the words around them stay.
function demoMask(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\b\d{3}[- ]\d{3}\b/g, '•••-•••').replace(/\d{4,}/g, '••••');
}

// made-up balances for empty cash accounts
// 0 x factor is still 0, so an empty account looks empty on a demo screen. A cash account (type transaction or
// savings, the effective type) with a real balance under $1 shows a believable made-up one instead. Display only:
// nothing is written and the real list is never touched; callers get copies. Never a loan, card, manual asset, or
// a foreign-currency manual account (its native balance is the figure, and the AUD one cannot stand in for it).
const DEMO_FAKE_BANDS = { transaction: [400, 6000], savings: [2000, 25000] };
const DEMO_EMPTY_BELOW = 100; // cents

// 32-bit FNV-1a with a final mix, so ids that differ by one character land far apart.
function demoHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const demoBalanceOf = (a) => (a && 'balance_current' in a ? a.balance_current : a?.balance);
const demoWantsFake = (a, state) => state?.on && demoFactorOk(state.factor) && a && typeof a.id === 'string' && DEMO_FAKE_BANDS[a.type]
  && !(a.manual && a.currency && a.currency !== 'AUD')
  && typeof demoBalanceOf(a) === 'number' && demoBalanceOf(a) >= 0 && demoBalanceOf(a) < DEMO_EMPTY_BELOW;

// The made-up balance for one account, in the real cents that demoScale turns into the figure on screen
// (so it lands in the band whatever the factor), or null when the account keeps what it has. Deterministic in the
// account id and the factor: stable across redraws, new on Shuffle numbers. The cents stay off 00 and the dollars
// off a round hundred so it never reads as a placeholder.
function demoFakeBalance(a, state) {
  if (!demoWantsFake(a, state)) return null;
  const [lo, hi] = DEMO_FAKE_BANDS[a.type];
  const key = `${a.id}|${state.factor}`;
  let dollars = lo + Math.floor(demoHash(`${key}|d`) * (hi - lo));
  if (dollars % 100 === 0) dollars += 7;
  const cents = 11 + Math.floor(demoHash(`${key}|c`) * 79);
  return Math.round((dollars * 100 + cents) / state.factor);
}

// The account list as a demo screen shows it: empty cash accounts carry a made-up balance (and available, when it
// was empty too). The same array comes back when nothing is faked, so callers can compare by identity.
function demoAccounts(list, state) {
  if (!state?.on || !Array.isArray(list)) return list;
  let changed = false;
  const out = list.map((a) => {
    const fake = demoFakeBalance(a, state);
    if (fake == null) return a;
    changed = true;
    const b = { ...a, balance_current: fake };
    if (typeof a.balance_available === 'number' && a.balance_available < DEMO_EMPTY_BELOW) b.balance_available = fake;
    if (a.manual && a.balance_native === a.balance_current) b.balance_native = fake;
    return b;
  });
  return changed ? out : list;
}

// /api/networth with the same made-up balances: its account rows, and the one-number totals the server summed
// (net worth, assets, the cash tile) by exactly what was added, so the tiles still add up. Loans, cards, manual
// assets, holdings and the loan/offset figures stay as the server gave them.
function demoNetWorth(nw, state) {
  if (!state?.on || !nw || !Array.isArray(nw.accounts)) return nw;
  let extra = 0;
  const accounts = nw.accounts.map((a) => {
    const fake = demoFakeBalance(a, state);
    if (fake == null) return a;
    extra += fake - a.balance;
    return { ...a, balance: fake };
  });
  if (!extra) return nw;
  return { ...nw, accounts, assets: nw.assets + extra, net_worth: nw.net_worth + extra, groups: { ...nw.groups, cash: nw.groups.cash + extra } };
}

// /api/accounts: the list as above, and the totals the server summed over the visible accounts, by what was added.
function demoAccountsData(d, state) {
  if (!state?.on || !d || !Array.isArray(d.accounts)) return d;
  const accounts = demoAccounts(d.accounts, state);
  if (accounts === d.accounts) return d;
  const extra = accounts.reduce((s, a, i) => (a === d.accounts[i] || a.hidden ? s : s + a.balance_current - d.accounts[i].balance_current), 0);
  const t = d.totals;
  return { ...d, accounts, ...(t ? { totals: { ...t, assets: t.assets + extra, net_worth: t.net_worth + extra } } : {}) };
}

// The made-up balance for an account id, looked up in the account list (the Save reads carry no type).
const demoFakeById = (id, accounts, state) => (state?.on && Array.isArray(accounts) ? demoFakeBalance(accounts.find((a) => a.id === id), state) : null);

// /api/savings: each listed account's balance and the total they make.
function demoSavings(sv, state, accounts) {
  if (!state?.on || !sv || !Array.isArray(sv.accounts)) return sv;
  let extra = 0;
  const list = sv.accounts.map((a) => {
    const fake = demoFakeById(a.id, accounts, state);
    if (fake == null) return a;
    extra += fake - a.balance;
    return { ...a, balance: fake };
  });
  return extra ? { ...sv, accounts: list, total_balance: sv.total_balance + extra } : sv;
}

// Goals: the balance of the account a goal is linked to. Progress is a goal figure and stays as it is.
function demoGoals(goals, state, accounts) {
  if (!state?.on || !Array.isArray(goals)) return goals;
  let changed = false;
  const out = goals.map((g) => {
    const fake = g.account_id ? demoFakeById(g.account_id, accounts, state) : null;
    if (fake == null) return g;
    changed = true;
    return { ...g, account_balance: fake };
  });
  return changed ? out : goals;
}

// Writes that carry nothing the page typed and change no figure, so a demo screen may send them.
const DEMO_SAFE_POSTS = new Set(['/api/rules/preview', '/api/income/sources/preview', '/api/sync']);
// Whether a request must be refused while demo is on: any POST, PUT, PATCH or DELETE
// except the read-only ones, so a scaled number can never be saved. Reads are never blocked.
function demoWriteBlocked({ method = 'GET', path = '', body } = {}, state) {
  if (!state?.on) return false;
  const m = String(method).toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  const p = String(path).split('?')[0];
  if (m === 'POST' && DEMO_SAFE_POSTS.has(p)) return false;
  if (m === 'POST' && p === '/api/budgets/starter' && body?.dry_run === true) return false;
  return true;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { DEMO_RANGE, DEMO_BLOCKED_MSG, demoFactorOk, demoPickFactor, demoParse, demoTurnOn, demoTurnOff, demoShuffle, demoScale, demoUnscale, demoScaleText, demoMask, demoWriteBlocked, demoFakeBalance, demoAccounts, demoNetWorth, demoAccountsData, demoSavings, demoGoals };
