// Manual accounts: accounts Redbark cannot see (Wise, an overseas bank, a
// travel card), kept by hand in any currency Frankfurter publishes, with a
// balance and transactions entered one by one or imported from CSV
// (lib/csvimport.mjs).
//
// The rule that keeps every AUD figure honest: columns that existed before
// keep meaning AUD cents. A manual row's transactions.amount is its AUD value
// at the rate for its date, with the native amount in amount_native (and the
// rate used in fx_rate, fx_date); an account's balance_current is its native
// balance at the latest rate, with the native figure in balance_native. So
// spend, budgets, income, tax, safe to spend and net worth read AUD without
// knowing manual accounts exist. Native amounts are hundredths of the unit
// whatever the currency's decimals.
//
// The balance is the opening balance (as at the start of its date) plus every
// transaction from that date on. Older rows are history already inside the
// opening balance. Each write rebuilds the account's daily snapshots (one per
// day something changed, each at that day's rate) so net worth history works.
//
// Sync never touches these: lib/ingest.mjs leaves manual = 1 accounts out of
// every Redbark call and the gone-marking. Writes here are synchronous and use
// rates already in fx_rates; the API fetches any it needs first (lib/fx.mjs).
import { randomBytes } from 'node:crypto';
import { HttpError, bad, notFound } from './errors.mjs';
import { tx } from './db.mjs';
import { isIsoDate, fmtDMY } from './dates.mjs';
import { deriveMerchant } from './merchant.mjs';
import { rateOn, toAud } from './fx.mjs';

export const MANUAL_TYPES = ['transaction', 'savings', 'credit-card', 'loan'];
export const MANUAL_ID = /^man_[a-f0-9]{16}$/;
export const MANUAL_TX_ID = /^mtx_[a-f0-9]{16}$/;
export const ADJUSTMENT = 'Balance adjustment';
const MAX = 1e13;
const newId = (prefix) => `${prefix}_${randomBytes(8).toString('hex')}`;

const noRate = (currency, date) => new HttpError(422, `No exchange rate for ${currency} on ${fmtDMY(date)}: Mint needs one from Frankfurter (ECB) to show it in AUD and has none for that date. Nothing was saved. Try again when you are online.`);

// The AUD amount and the rate used, or a 422 when there is no rate for that date.
export function convert(db, currency, date, native) {
  if (currency === 'AUD') return { amount: native, fx_rate: null, fx_date: null };
  const r = rateOn(db, currency, date);
  if (!r) throw noRate(currency, date);
  return { amount: toAud(native, r.rate), fx_rate: r.rate, fx_date: r.date };
}

export function getManual(db, id) {
  const a = typeof id === 'string' ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) : null;
  if (!a) throw notFound('no such account');
  if (!a.manual) throw bad(`${a.nickname || a.name} is not a manual account: its balance and rows come from the bank`);
  return a;
}

const text = (v, name, max, { required = true } = {}) => {
  if (v == null && !required) return null;
  if (typeof v !== 'string' || (required && !v.trim()) || v.trim().length > max) throw bad(`${name} must be ${required ? 1 : 0} to ${max} characters`);
  return v.trim() || null;
};
const cents = (v, name, { zero = true } = {}) => {
  if (!Number.isInteger(v) || Math.abs(v) > MAX || (!zero && v === 0)) throw bad(`${name} must be whole cents${zero ? '' : ', not zero'}`);
  return v;
};
const pastDate = (v, name, today) => {
  if (!isIsoDate(v)) throw bad(`${name} must be YYYY-MM-DD`);
  if (v > today) throw bad(`${name} cannot be in the future`);
  return v;
};
const currencyCode = (v) => {
  const s = String(v ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) throw bad('currency must be a three letter code like USD');
  return s;
};

// Native balance on a date: the opening balance plus rows from the opening date to it.
function nativeAt(db, a, date) {
  const s = db.prepare('SELECT COALESCE(SUM(amount_native), 0) s FROM transactions WHERE account_id = ? AND date >= ? AND date <= ?').get(a.id, a.opening_date, date).s;
  return (a.opening_balance ?? 0) + s;
}

// The balance (native and AUD at the latest rate) and the daily snapshots, from the rows.
export function recomputeAccount(db, id, { today, now = new Date() }) {
  const a = db.prepare('SELECT * FROM accounts WHERE id = ? AND manual = 1').get(id);
  if (!a) return null;
  const days = db.prepare(`SELECT date, SUM(amount_native) s FROM transactions WHERE account_id = ? AND date >= ? AND date <= ?
    GROUP BY date ORDER BY date`).all(id, a.opening_date, today);
  const aud = (native, date) => {
    const r = rateOn(db, a.currency, date);
    return r ? toAud(native, r.rate) : null;
  };
  const at = now.toISOString();
  return tx(db, () => {
    // The rows the account should have; only the ones that differ are written,
    // so a rebuild that changes nothing leaves the table (and a chat undo) alone.
    const want = new Map();
    let run = a.opening_balance ?? 0;
    want.set(a.opening_date, run);
    for (const d of days) { run += d.s; want.set(d.date, run); }
    if (a.opening_date <= today) want.set(today, run);
    const have = new Map(db.prepare('SELECT date, current, native FROM balance_snapshots WHERE account_id = ?').all(id).map((r) => [r.date, r]));
    const del = db.prepare('DELETE FROM balance_snapshots WHERE account_id = ? AND date = ?');
    for (const d of have.keys()) if (!want.has(d)) del.run(id, d);
    const snap = db.prepare(`INSERT INTO balance_snapshots (account_id, date, current, native, observed_at, freshness) VALUES (?, ?, ?, ?, ?, 'manual')
      ON CONFLICT(account_id, date) DO UPDATE SET current = excluded.current, native = excluded.native, observed_at = excluded.observed_at`);
    for (const [d, n] of want) {
      const cur = aud(n, d);
      const h = have.get(d);
      if (!h || h.current !== cur || h.native !== n) snap.run(id, d, cur, n, at);
    }
    // Rows from after today (a clock edge) still count in the balance itself.
    const later = db.prepare('SELECT COALESCE(SUM(amount_native), 0) s FROM transactions WHERE account_id = ? AND date > ?').get(id, today).s;
    const native = run + (a.opening_date > today ? 0 : later);
    db.prepare(`UPDATE accounts SET balance_native = ?, balance_current = ?, balance_available = NULL, balance_observed_at = ?, balance_freshness = 'manual',
      earliest_date = (SELECT MIN(date) FROM transactions WHERE account_id = ?), latest_date = (SELECT MAX(date) FROM transactions WHERE account_id = ?), updated_at = ? WHERE id = ?`)
      .run(native, aud(native, today), at, id, id, at, id);
    return native;
  });
}

// Every live manual account: today's snapshot row and the AUD balance at the latest rate.
export function recomputeAll(db, { today, now = new Date(), currency = null } = {}) {
  const ids = db.prepare(`SELECT id FROM accounts WHERE manual = 1 ${currency ? 'AND currency = ?' : ''}`).all(...(currency ? [currency] : [])).map((r) => r.id);
  for (const id of ids) recomputeAccount(db, id, { today, now });
  return ids.length;
}

// After new rates land: rows converted at a stand-in rate (the one before an
// offline gap) move to the rate for their own date, then balances follow.
export function revalueManual(db, currency, { today, now = new Date() }) {
  if (currency === 'AUD') return 0;
  const rows = db.prepare(`SELECT t.id, t.date, t.amount_native, t.fx_date FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.manual = 1 AND a.currency = ? AND t.amount_native IS NOT NULL`).all(currency);
  const upd = db.prepare('UPDATE transactions SET amount = ?, fx_rate = ?, fx_date = ?, updated_at = ? WHERE id = ?');
  let n = 0;
  tx(db, () => {
    for (const r of rows) {
      const rate = rateOn(db, currency, r.date);
      if (!rate || rate.date === r.fx_date) continue;
      upd.run(toAud(r.amount_native, rate.rate), rate.rate, rate.date, now.toISOString(), r.id);
      n += 1;
    }
  });
  recomputeAll(db, { today, now, currency });
  return n;
}

export function createManualAccount(db, body = {}, { today, now = new Date() }) {
  if (body.id != null) {
    if (typeof body.id !== 'string' || !MANUAL_ID.test(body.id)) throw bad('id must be man_ and 16 lowercase hex characters');
    const had = db.prepare('SELECT * FROM accounts WHERE id = ?').get(body.id);
    if (had) return had; // a replayed create from the offline queue
  }
  const name = text(body.name, 'name', 60);
  const institution = text(body.institution ?? null, 'institution', 60, { required: false }) ?? 'Manual';
  const type = body.type ?? 'transaction';
  if (!MANUAL_TYPES.includes(type)) throw bad(`type must be one of ${MANUAL_TYPES.join(', ')}`);
  const currency = currencyCode(body.currency);
  const opening = cents(body.opening_balance ?? 0, 'opening_balance');
  const date = pastDate(body.opening_date ?? today, 'opening date', today);
  if ('is_business' in body && typeof body.is_business !== 'boolean') throw bad('is_business must be true or false');
  convert(db, currency, date, opening); // refuses with no rate for the opening date
  const id = body.id ?? newId('man');
  const at = now.toISOString();
  db.prepare(`INSERT INTO accounts (id, connection_id, name, type, institution, currency, status, is_business, manual, opening_balance, opening_date,
      balance_freshness, sort, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?, ?, 'open', ?, 1, ?, ?, 'manual', (SELECT COALESCE(MAX(sort), 0) + 1 FROM accounts), ?, ?)`)
    .run(id, name, type, institution, currency, body.is_business ? 1 : 0, opening, date, at, at);
  recomputeAccount(db, id, { today, now });
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

// name, institution, type, opening_balance, opening_date and archived. Nickname,
// hidden, business and spendable go through lib/accounts.mjs as for any account.
export function updateManualAccount(db, id, body = {}, { today, now = new Date() }) {
  const a = getManual(db, id);
  if ('currency' in body && currencyCode(body.currency) !== a.currency) throw bad('currency cannot change once the account exists: add a new account in the other currency');
  const sets = {};
  if ('name' in body) sets.name = text(body.name, 'name', 60);
  if ('institution' in body) sets.institution = text(body.institution, 'institution', 60, { required: false }) ?? 'Manual';
  if ('type' in body) {
    if (!MANUAL_TYPES.includes(body.type)) throw bad(`type must be one of ${MANUAL_TYPES.join(', ')}`);
    sets.type = body.type;
  }
  if ('opening_balance' in body) sets.opening_balance = cents(body.opening_balance, 'opening_balance');
  if ('opening_date' in body) {
    sets.opening_date = pastDate(body.opening_date, 'opening date', today);
    convert(db, a.currency, sets.opening_date, 0);
  }
  if ('archived' in body) {
    if (typeof body.archived !== 'boolean') throw bad('archived must be true or false');
    sets.status = body.archived ? 'gone' : 'open';
  }
  const keys = Object.keys(sets);
  if (!keys.length && !('currency' in body)) throw bad('nothing to change: give name, institution, type, opening_balance, opening_date or archived');
  if (keys.length) {
    db.prepare(`UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => sets[k]), now.toISOString(), id);
  }
  recomputeAccount(db, id, { today, now });
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

export function manualSummary(db, id) {
  getManual(db, id);
  const t = db.prepare('SELECT count(*) n, MIN(date) lo, MAX(date) hi FROM transactions WHERE account_id = ?').get(id);
  const i = db.prepare('SELECT count(*) n FROM manual_imports WHERE account_id = ? AND undone_at IS NULL').get(id);
  return { transactions: t.n, earliest: t.lo, latest: t.hi, imports: i.n };
}

// Only its own rows go with it (tax tags and transfer links on them cascade;
// receipts and owed repayments are kept, unlinked).
export function deleteManualAccount(db, id) {
  getManual(db, id);
  return tx(db, () => {
    const n = db.prepare('DELETE FROM transactions WHERE account_id = ?').run(id).changes;
    db.prepare('DELETE FROM balance_snapshots WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return { deleted: true, transactions: Number(n) };
  });
}

const checkCategory = (db, v) => {
  if (v == null) return null;
  if (!Number.isInteger(v) || !db.prepare('SELECT 1 FROM categories WHERE id = ? AND archived = 0').get(v)) throw bad('no such category');
  return v;
};

function txFields(db, body, today, { partial }) {
  const out = {};
  if (!partial || 'date' in body) out.date = pastDate(body.date, 'date', today);
  if (!partial || 'amount' in body) out.amount_native = cents(body.amount, 'amount', { zero: false });
  if (!partial || 'description' in body) out.description = text(body.description, 'description', 200);
  if ('reference' in body) out.reference = text(body.reference, 'reference', 100, { required: false });
  if ('category_id' in body) out.category_id = checkCategory(db, body.category_id);
  if ('note' in body) out.note = text(body.note, 'note', 500, { required: false });
  if ('is_business' in body) {
    if (body.is_business !== null && typeof body.is_business !== 'boolean') throw bad('is_business must be true, false or null');
    out.is_business = body.is_business === null ? null : body.is_business ? 1 : 0;
  }
  return out;
}

// One row added by hand (or by an import, which passes import_id and import_hash).
export function insertManualRow(db, a, f, { id = newId('mtx'), now = new Date(), importId = null, importHash = null } = {}) {
  const c = convert(db, a.currency, f.date, f.amount_native);
  const at = now.toISOString();
  db.prepare(`INSERT INTO transactions (id, account_id, status, date, post_date, description, reference, amount, currency, direction, merchant,
      category_id, category_source, is_business, note, amount_native, fx_rate, fx_date, import_id, import_hash, first_seen_at, updated_at)
    VALUES (?, ?, 'posted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, a.id, f.date, f.date, f.description, f.reference ?? null, c.amount, a.currency, f.amount_native < 0 ? 'debit' : 'credit',
      deriveMerchant(f.description, null), f.category_id ?? null, f.category_id != null ? 'manual' : null, f.is_business ?? null, f.note ?? null,
      f.amount_native, c.fx_rate, c.fx_date, importId, importHash, at, at);
  return id;
}

export function addManualTransaction(db, accountId, body = {}, { today, now = new Date() }) {
  const a = getManual(db, accountId);
  if (body.id != null) {
    if (typeof body.id !== 'string' || !MANUAL_TX_ID.test(body.id)) throw bad('id must be mtx_ and 16 lowercase hex characters');
    const had = db.prepare('SELECT * FROM transactions WHERE id = ?').get(body.id);
    if (had) {
      if (had.account_id !== a.id) throw bad('that transaction id belongs to another account');
      return had; // a replayed add from the offline queue
    }
  }
  if (a.status === 'gone') throw bad(`${a.nickname || a.name} is archived: bring it back before adding to it`);
  const f = txFields(db, body, today, { partial: false });
  const id = tx(db, () => insertManualRow(db, a, f, { id: body.id ?? undefined, now }));
  recomputeAccount(db, a.id, { today, now });
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}

function getManualTx(db, id) {
  const t = typeof id === 'string' ? db.prepare('SELECT t.*, a.manual, a.currency account_currency FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?').get(id) : null;
  if (!t) throw notFound('no such transaction');
  if (!t.manual || t.amount_native == null) throw bad("not a manual transaction: the bank's rows are read only");
  return t;
}

export function updateManualTransaction(db, id, body = {}, { today, now = new Date() }) {
  const t = getManualTx(db, id);
  const f = txFields(db, body, today, { partial: true });
  if (!Object.keys(f).length) throw bad('nothing to change: give date, amount, description, reference, category_id, note or is_business');
  const date = f.date ?? t.date;
  const native = f.amount_native ?? t.amount_native;
  const sets = { ...f };
  if ('date' in f || 'amount_native' in f) {
    Object.assign(sets, convert(db, t.account_currency, date, native));
    sets.post_date = date;
    sets.direction = native < 0 ? 'debit' : 'credit';
  }
  if ('description' in f) sets.merchant = deriveMerchant(f.description, null);
  if ('category_id' in f) sets.category_source = f.category_id == null ? null : 'manual';
  const keys = Object.keys(sets);
  db.prepare(`UPDATE transactions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => sets[k]), now.toISOString(), id);
  recomputeAccount(db, t.account_id, { today, now });
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}

export function deleteManualTransaction(db, id, { today = new Date().toISOString().slice(0, 10), now = new Date() } = {}) {
  const t = getManualTx(db, id);
  db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  recomputeAccount(db, t.account_id, { today, now });
  return { deleted: true, id, account_id: t.account_id };
}

// "The balance is X": one adjustment row for the difference, filed under a
// transfer-kind category so it is never spend or income.
export function setManualBalance(db, accountId, { balance, date = null, note = 'Recorded by Set balance' } = {}, { today, now = new Date() }) {
  const a = getManual(db, accountId);
  const on = date == null ? today : pastDate(date, 'date', today);
  cents(balance, 'balance');
  if (on < a.opening_date) throw bad(`the date must be on or after the opening date, ${fmtDMY(a.opening_date)}`);
  const diff = balance - nativeAt(db, a, on);
  if (diff === 0) throw bad(`the balance on ${fmtDMY(on)} is already that`);
  const cat = db.prepare('SELECT id FROM categories WHERE name = ?').get(ADJUSTMENT)?.id ?? null;
  return addManualTransaction(db, accountId, { date: on, amount: diff, description: ADJUSTMENT, category_id: cat, note }, { today, now });
}
