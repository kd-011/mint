// Net worth: every visible account's balance (cash positive, card and loan
// negative) plus the latest manual snapshot of each asset Redbark cannot see
// (shares, super, property, a car), less manual liabilities. An offset account is listed
// against its loan. History comes from the daily balance snapshots, each
// account and asset carried forward from its last known value.
import { bad, notFound } from './errors.mjs';
import { isIsoDate, daysBetween, zoneDate, addDays } from './dates.mjs';
import { portfolio, holdingsCount } from './holdings.mjs';
import { holdingsSort } from './homeorder.mjs';

export const ASSET_KINDS = ['shares', 'super', 'property', 'vehicle', 'cash', 'other'];
export const NUDGE_DAYS = 35; // a manual value older than this is due for an update

const group = (type) => (type === 'credit-card' ? 'cards' : type === 'loan' ? 'loans' : 'cash');

// A manual 'shares' asset nobody has decided about is left out of net worth once
// holdings exist, so the same shares are not counted twice; 'keep' counts it again.
const supersededBy = (m, held) => held > 0 && m.kind === 'shares' && !m.is_liability && !m.archived && m.holdings_decision == null;

export function listAssets(db, { includeArchived = false, today = zoneDate() } = {}) {
  const held = holdingsCount(db);
  return db.prepare(`SELECT m.id, m.name, m.kind, m.is_liability, m.archived, m.created_at, m.holdings_decision, m.sort,
      (SELECT value FROM manual_snapshots s WHERE s.asset_id = m.id ORDER BY date DESC LIMIT 1) value,
      (SELECT max(date) FROM manual_snapshots s WHERE s.asset_id = m.id) as_of,
      (SELECT count(*) FROM manual_snapshots s WHERE s.asset_id = m.id) snapshots
    FROM manual_assets m ${includeArchived ? '' : 'WHERE m.archived = 0'} ORDER BY m.archived, m.is_liability, m.sort, m.name`).all()
    .map((a) => {
      const superseded = supersededBy(a, held);
      return { ...a, superseded, due: !a.archived && !superseded && (!a.as_of || daysBetween(a.as_of, today) > NUDGE_DAYS) };
    });
}

function checkAsset(body, partial) {
  const out = {};
  if (!partial || 'name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 60) throw bad('name must be 1 to 60 characters');
    out.name = body.name.trim();
  }
  if (!partial || 'kind' in body) {
    const kind = body.kind ?? 'other';
    if (!ASSET_KINDS.includes(kind)) throw bad(`kind must be one of ${ASSET_KINDS.join(', ')}`);
    out.kind = kind;
  }
  for (const k of ['is_liability', 'archived']) {
    if (!(k in body) || (k === 'archived' && !partial)) continue;
    if (typeof body[k] !== 'boolean') throw bad(`${k} must be true or false`);
    out[k] = body[k] ? 1 : 0;
  }
  return out;
}

const getAsset = (db, id) => {
  const a = Number.isInteger(id) ? db.prepare('SELECT id, name, kind, is_liability, archived, created_at, sort FROM manual_assets WHERE id = ?').get(id) : null;
  if (!a) throw notFound('no such asset');
  return a;
};

export function createAsset(db, body = {}) {
  const a = checkAsset(body, false);
  // Last place: after every asset and after the share portfolio, whose position is kept in settings on the same numbering.
  const last = Math.max(db.prepare('SELECT COALESCE(MAX(sort), 0) m FROM manual_assets').get().m, holdingsSort(db));
  const { lastInsertRowid } = db.prepare('INSERT INTO manual_assets (name, kind, is_liability, created_at, sort) VALUES (?, ?, ?, ?, ?)')
    .run(a.name, a.kind, a.is_liability ?? 0, new Date().toISOString(), last + 1);
  return getAsset(db, Number(lastInsertRowid));
}

export function updateAsset(db, id, body = {}) {
  getAsset(db, id);
  const a = checkAsset(body, true);
  const keys = Object.keys(a);
  if (!keys.length) throw bad('nothing to change');
  db.prepare(`UPDATE manual_assets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => a[k]), id);
  return getAsset(db, id);
}

// contribution (optional): what went in since the previous snapshot, so growth
// can be separated from contributions (super).
export function addSnapshot(db, assetId, { date, value, note = null, contribution = null } = {}) {
  getAsset(db, assetId);
  if (!isIsoDate(date)) throw bad('date must be YYYY-MM-DD');
  if (!Number.isInteger(value) || Math.abs(value) > 1e13) throw bad('value must be whole cents');
  if (note != null && (typeof note !== 'string' || note.length > 200)) throw bad('note must be up to 200 characters');
  if (contribution != null && (!Number.isInteger(contribution) || contribution < 0 || contribution > 1e13)) throw bad('contribution must be whole cents, zero or more');
  db.prepare(`INSERT INTO manual_snapshots (asset_id, date, value, note, contribution) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(asset_id, date) DO UPDATE SET value = excluded.value, note = excluded.note, contribution = excluded.contribution`).run(assetId, date, value, note?.trim() || null, contribution ?? null);
  return { asset_id: assetId, date, value, note: note?.trim() || null, contribution: contribution ?? null };
}

export function listSnapshots(db, assetId) {
  getAsset(db, assetId);
  return db.prepare('SELECT date, value, note, contribution FROM manual_snapshots WHERE asset_id = ? ORDER BY date DESC').all(assetId);
}

export function deleteSnapshot(db, assetId, date) {
  getAsset(db, assetId);
  if (!db.prepare('DELETE FROM manual_snapshots WHERE asset_id = ? AND date = ?').run(assetId, date).changes) throw notFound('no snapshot on that date');
  return { deleted: true };
}

const offsetOf = (a) => a.type !== 'loan' && a.type !== 'credit-card' && /offset/i.test(`${a.name} ${a.nickname ?? ''}`);

export function netWorth(db) {
  const accounts = db.prepare(`SELECT id, connection_id, name, nickname, type, institution, balance_current, balance_observed_at, details_json,
      currency, balance_native, manual, sort
    FROM accounts WHERE status IS NOT 'gone' AND hidden = 0 ORDER BY sort, name`).all();
  const manual = listAssets(db).filter((m) => m.value != null);
  const port = portfolio(db);
  const held = port.totals;
  // Every manual asset that is not a debt is an investment (shares, super, property, a car, anything else
  // the owner tracks by hand), so Home has no Other section. other_assets stays in the answer, always 0, for readers
  // of the old shape; other_liabilities is the manual debts.
  const groups = { cash: 0, cards: 0, loans: 0, investments: 0, other_assets: 0, other_liabilities: 0 };
  let assets = 0;
  let liabilities = 0;
  for (const a of accounts) {
    const b = a.balance_current ?? 0;
    groups[group(a.type)] += b;
    if (b > 0) assets += b; else liabilities -= b;
  }
  for (const m of manual) {
    if (m.superseded) continue;
    if (m.is_liability) { liabilities += m.value; groups.other_liabilities -= m.value; continue; }
    assets += m.value;
    groups.investments += m.value;
  }
  assets += held.value;
  groups.investments += held.value;
  const loanAccts = accounts.filter((a) => a.type === 'loan');
  const offsets = accounts.filter(offsetOf);
  const loans = loanAccts.map((l) => {
    let rate = null;
    try { rate = JSON.parse(l.details_json ?? 'null')?.lending_rate ?? null; } catch {}
    const mine = offsets.filter((o) => o.connection_id === l.connection_id || loanAccts.length === 1);
    const offsetTotal = mine.reduce((s, o) => s + Math.max(0, o.balance_current ?? 0), 0);
    const owing = -(l.balance_current ?? 0);
    return {
      id: l.id, name: l.nickname || l.name, institution: l.institution, owing, lending_rate: rate,
      offsets: mine.map((o) => ({ id: o.id, name: o.nickname || o.name, balance: o.balance_current })),
      offset_total: offsetTotal, net_owing: owing - offsetTotal,
    };
  });
  return {
    assets, liabilities, net_worth: assets - liabilities, groups,
    // balance is AUD; a manual account also carries its own currency and native balance (lib/manual.mjs).
    accounts: accounts.map((a) => ({
      id: a.id, name: a.nickname || a.name, type: a.type, institution: a.institution, group: group(a.type), balance: a.balance_current, as_of: a.balance_observed_at, offset: offsetOf(a),
      currency: a.currency, manual: !!a.manual, sort: a.sort, ...(a.manual ? { balance_native: a.balance_native } : {}),
    })),
    manual: manual.map(({ id, name, kind, is_liability, value, as_of, due, superseded, sort }) => ({ id, name, kind, is_liability, value, as_of, due, superseded, sort, counted: !superseded })),
    holdings: { count: held.count, value: held.value, cost: held.cost, gain: held.gain, day_change: held.day_change, sort: holdingsSort(db),
      list: port.holdings.map(({ id, ticker, exchange, name, units, value }) => ({ id, ticker, exchange, name, units, value })) },
    loans,
  };
}

export function netWorthHistory(db, { from = null, to = null } = {}) {
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) throw bad('from and to must be YYYY-MM-DD');
  const acct = db.prepare(`SELECT s.account_id k, s.date, s.current v FROM balance_snapshots s JOIN accounts a ON a.id = s.account_id
    WHERE a.hidden = 0 AND a.status IS NOT 'gone' AND s.current IS NOT NULL ${to ? 'AND s.date <= ?' : ''}`).all(...(to ? [to] : []));
  // Holdings take over from the first portfolio snapshot; a manual shares asset
  // that was converted (or never decided on) stops there so nothing counts twice.
  const port = db.prepare(`SELECT 'holdings' k, date, value v FROM portfolio_snapshots ${to ? 'WHERE date <= ?' : ''}`).all(...(to ? [to] : []));
  const first = port.length ? port.reduce((d, r) => (r.date < d ? r.date : d), port[0].date) : null;
  const last = port.length ? port.reduce((d, r) => (r.date > d ? r.date : d), port[0].date) : null;
  if (last && !holdingsCount(db)) port.push({ k: 'holdings', date: addDays(last, 1), v: 0 }); // everything was deleted: do not carry the value forward
  const man = [];
  const rows = db.prepare(`SELECT s.asset_id, s.date, m.kind, m.is_liability, m.archived, m.holdings_decision, s.value
    FROM manual_snapshots s JOIN manual_assets m ON m.id = s.asset_id WHERE (m.archived = 0 OR m.holdings_decision = 'convert') ${to ? 'AND s.date <= ?' : ''}`).all(...(to ? [to] : []));
  const replaced = new Set();
  for (const r of rows) {
    const shares = r.kind === 'shares' && !r.is_liability && r.holdings_decision !== 'keep';
    if (shares && first) replaced.add(r.asset_id);
    if (shares && first && r.date >= first) continue;
    if (r.archived && !(shares && first)) continue;
    man.push({ k: `m${r.asset_id}`, date: r.date, v: r.is_liability ? -r.value : r.value });
  }
  if (first) for (const id of replaced) man.push({ k: `m${id}`, date: first, v: 0 });
  const byDate = new Map();
  for (const r of [...acct, ...man, ...port]) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)).push(r);
  const state = new Map();
  const out = [];
  for (const date of [...byDate.keys()].sort()) {
    for (const r of byDate.get(date)) state.set(r.k, r.v);
    if (from && date < from) continue;
    let assets = 0;
    let liabilities = 0;
    for (const v of state.values()) if (v > 0) assets += v; else liabilities -= v;
    out.push({ date, assets, liabilities, net_worth: assets - liabilities });
  }
  return out;
}
