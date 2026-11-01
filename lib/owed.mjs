// Owed to me: a manual two-sided ledger. Mostly money other people owe the owner,
// and since the ledger grew a direction, money he owes them too. A debt is a row
// (who, how much, what for, when lent, when due); repayments are separate rows
// so part-payments work, and a repayment may name the incoming bank
// transaction it was (never matched automatically, the transaction is never
// touched). Standalone: net worth, safe to spend, budgets and the forecast do
// not read these tables. Tally maths lives in public/owed-math.js so the page
// computes the same numbers offline.
import { createRequire } from 'node:module';
import { bad, notFound } from './errors.mjs';
import { isIsoDate, zoneDate } from './dates.mjs';

const { owedKey, owedDir, owedState, owedView, owedTally, owedNames } = createRequire(import.meta.url)('../public/owed-math.js');

const COLS = 'id, person, amount, note, direction, lent_on, due_on, closed, archived, created_at, updated_at';
const DIRECTIONS = ['owed_to_me', 'i_owe'];
const MAX_CENTS = 1e11;

export const fmtCents = (c) => `$${(Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

const getRow = (db, id) => {
  const r = Number.isInteger(id) ? db.prepare(`SELECT ${COLS} FROM owed WHERE id = ?`).get(id) : null;
  if (!r) throw notFound('no such debt');
  return r;
};

const paymentsOf = (db, id) => db.prepare('SELECT id, owed_id, date, amount, note, transaction_id FROM owed_payments WHERE owed_id = ? ORDER BY date DESC, id DESC').all(id);
const repaidOf = (db, id) => db.prepare('SELECT COALESCE(SUM(amount), 0) n FROM owed_payments WHERE owed_id = ?').get(id).n;

function view(db, row, today, payments = paymentsOf(db, row.id)) {
  const repaid = payments.reduce((s, p) => s + p.amount, 0);
  const { archived, ...rest } = row;
  return owedView({ ...rest, archived: !!archived, repaid, payments }, today);
}

const cleanNote = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string' || v.length > 200) throw bad('note must be up to 200 characters');
  return v.trim() || null;
};

function check(body, partial, today) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('debt must be an object');
  const out = {};
  if (!partial || 'person' in body) {
    if (typeof body.person !== 'string') throw bad('person must be 1 to 60 characters');
    const name = body.person.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 60) throw bad('person must be 1 to 60 characters');
    out.person = name;
  }
  if (!partial || 'amount' in body) {
    if (!Number.isInteger(body.amount) || body.amount <= 0 || body.amount > MAX_CENTS) throw bad('amount must be whole cents, more than zero');
    out.amount = body.amount;
  }
  if ('note' in body) out.note = cleanNote(body.note);
  if ('direction' in body) {
    if (!DIRECTIONS.includes(body.direction)) throw bad("direction must be 'owed_to_me' or 'i_owe'");
    out.direction = body.direction;
  }
  if ('lent_on' in body) {
    if (!isIsoDate(body.lent_on)) throw bad('lent_on must be a real date as YYYY-MM-DD');
    if (body.lent_on > today) throw bad('lent_on cannot be in the future');
    out.lent_on = body.lent_on;
  }
  if ('due_on' in body) {
    if (body.due_on !== null && !isIsoDate(body.due_on)) throw bad('due_on must be a real date as YYYY-MM-DD, or null');
    out.due_on = body.due_on;
  }
  if ('closed' in body) {
    if (body.closed !== null && body.closed !== 'settled' && body.closed !== 'written_off') throw bad("closed must be 'settled', 'written_off' or null");
    out.closed = body.closed;
  }
  if ('archived' in body) {
    if (typeof body.archived !== 'boolean') throw bad('archived must be true or false');
    out.archived = body.archived ? 1 : 0;
  }
  return out;
}

export function createOwed(db, body = {}, { today = zoneDate() } = {}) {
  const d = check(body, false, today);
  const lent = d.lent_on ?? today;
  const due = d.due_on ?? null;
  if (due && due < lent) throw bad('due_on cannot be before the day it was lent');
  const at = new Date().toISOString();
  const { lastInsertRowid } = db.prepare('INSERT INTO owed (person, amount, note, direction, lent_on, due_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(d.person, d.amount, d.note ?? null, d.direction ?? 'owed_to_me', lent, due, at, at);
  return getOwed(db, Number(lastInsertRowid), { today });
}

export function updateOwed(db, id, body = {}, { today = zoneDate() } = {}) {
  const row = getRow(db, id);
  const d = check(body, true, today);
  const keys = Object.keys(d);
  if (!keys.length) throw bad('nothing to change');
  const repaid = repaidOf(db, id);
  if ('direction' in d && d.direction !== owedDir(row) && paymentsOf(db, id).length) throw bad('a debt with repayments cannot switch direction, delete the repayments first');
  if ('amount' in d && d.amount < repaid) throw bad(`amount cannot be less than the ${fmtCents(repaid)} already repaid`);
  const lent = d.lent_on ?? row.lent_on;
  const due = 'due_on' in d ? d.due_on : row.due_on;
  if (due && due < lent) throw bad('due_on cannot be before the day it was lent');
  const first = db.prepare('SELECT min(date) d FROM owed_payments WHERE owed_id = ?').get(id).d;
  if (first && lent > first) throw bad(`lent_on cannot be after the first repayment (${first})`);
  const next = { ...row, ...d };
  if ('closed' in d && d.closed === null) d.archived = next.archived = 0; // reopening brings it back to the list
  if (next.archived && owedState({ ...next, repaid }, today).status === 'open') throw bad('settle or write off a debt before archiving it');
  const cols = Object.keys(d);
  db.prepare(`UPDATE owed SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((k) => d[k]), new Date().toISOString(), id);
  return getOwed(db, id, { today });
}

export function deleteOwed(db, id) {
  getRow(db, id);
  db.prepare('DELETE FROM owed WHERE id = ?').run(id);
  return { deleted: true };
}

export function getOwed(db, id, { today = zoneDate() } = {}) {
  return view(db, getRow(db, id), today);
}

export function addOwedPayment(db, id, body = {}, { today = zoneDate() } = {}) {
  const row = getRow(db, id);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('repayment must be an object');
  const date = body.date ?? today;
  if (!isIsoDate(date)) throw bad('date must be a real date as YYYY-MM-DD');
  if (date > today) throw bad('date cannot be in the future');
  if (date < row.lent_on) throw bad(`date cannot be before it was lent (${row.lent_on})`);
  if (!Number.isInteger(body.amount) || body.amount <= 0 || body.amount > MAX_CENTS) throw bad('amount must be whole cents, more than zero');
  const note = cleanNote(body.note);
  const s = owedState({ ...row, repaid: repaidOf(db, id) }, today);
  if (row.closed === 'written_off') throw bad('this debt is written off; reopen it to record a repayment');
  if (s.status !== 'open') throw bad('this debt is settled, nothing left to repay');
  if (body.amount > s.outstanding) throw bad(`that is more than is owed: only ${fmtCents(s.outstanding)} left to ${owedDir(row) === 'i_owe' ? 'pay' : 'repay'}`);
  let tid = null;
  if (body.transaction_id != null) {
    const t = typeof body.transaction_id === 'string' ? db.prepare('SELECT id, amount FROM transactions WHERE id = ?').get(body.transaction_id) : null;
    if (!t) throw notFound('no such transaction');
    // Money owed to the owner arrives as a deposit; money he owes leaves as a payment.
    const owes = owedDir(row) === 'i_owe';
    if (owes ? t.amount >= 0 : t.amount <= 0) throw bad(owes ? 'link a payment to an outgoing transaction (money out), not a deposit' : 'link a repayment to an incoming transaction (money in), not a payment out');
    const used = db.prepare('SELECT COALESCE(SUM(amount), 0) n FROM owed_payments WHERE transaction_id = ?').get(t.id).n;
    const size = Math.abs(t.amount);
    if (body.amount > size - used) throw bad(`only ${fmtCents(Math.max(0, size - used))} of that transaction is left to link to a repayment`);
    tid = t.id;
  }
  const { lastInsertRowid } = db.prepare('INSERT INTO owed_payments (owed_id, date, amount, note, transaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, date, body.amount, note, tid, new Date().toISOString());
  const p = db.prepare('SELECT id, owed_id, date, amount, note, transaction_id FROM owed_payments WHERE id = ?').get(Number(lastInsertRowid));
  return { ...p, outstanding: owedState({ ...row, repaid: repaidOf(db, id) }, today).outstanding };
}

export function deleteOwedPayment(db, id, paymentId) {
  getRow(db, id);
  if (!db.prepare('DELETE FROM owed_payments WHERE id = ? AND owed_id = ?').run(paymentId, id).changes) throw notFound('no such repayment');
  return { deleted: true };
}

// The whole ledger: every debt with its repayments, the tally, the names used.
export function listOwed(db, { today = zoneDate(), includeArchived = false } = {}) {
  const rows = db.prepare(`SELECT ${COLS} FROM owed ORDER BY lent_on DESC, id DESC`).all();
  const pays = new Map();
  for (const p of db.prepare('SELECT id, owed_id, date, amount, note, transaction_id FROM owed_payments ORDER BY date DESC, id DESC').all()) {
    if (!pays.has(p.owed_id)) pays.set(p.owed_id, []);
    pays.get(p.owed_id).push(p);
  }
  const all = rows.map((r) => view(db, r, today, pays.get(r.id) ?? []));
  const tally = owedTally(all, today);
  return { as_of: today, ...tally, items: includeArchived ? all : all.filter((d) => !d.archived), names: owedNames(all) };
}

// ---------- by person (the chat door speaks in names) ----------
// These talk about money owed to the owner; a debt he owes is reached by its id.

function peopleOwing(db, today) {
  return listOwed(db, { today }).people.filter((p) => p.outstanding > 0);
}

// "liam" -> the one person with open debts it points at, else a plain error.
export function findDebtor(db, ref, { today = zoneDate() } = {}) {
  const people = peopleOwing(db, today);
  const key = owedKey(ref);
  const exact = people.filter((p) => p.key === key);
  if (exact.length === 1) return exact[0];
  const part = key ? people.filter((p) => p.key.includes(key)) : [];
  if (part.length === 1) return part[0];
  const names = people.map((p) => p.name).join(', ') || 'nobody';
  if (part.length > 1) throw bad(`"${String(ref).trim().slice(0, 40)}" matches more than one person: ${part.map((p) => p.name).join(', ')}`);
  throw notFound(`nobody called "${String(ref).trim().slice(0, 40)}" owes you anything. Owed by: ${names}`);
}

const openDebtsOf = (db, key, today) => listOwed(db, { today }).items
  .filter((d) => owedKey(d.person) === key && d.status === 'open' && owedDir(d) === 'owed_to_me')
  .sort((x, y) => (x.lent_on < y.lent_on ? -1 : x.lent_on > y.lent_on ? 1 : x.id - y.id));

// A repayment from a person, oldest debt first, spilling onto the next. More
// than they owe in all is refused.
export function repayPerson(db, ref, { amount, date, note, transaction_id } = {}, { today = zoneDate() } = {}) {
  const person = findDebtor(db, ref, { today });
  if (!Number.isInteger(amount) || amount <= 0) throw bad('amount must be whole cents, more than zero');
  if (amount > person.outstanding) throw bad(`${person.name} only owes you ${fmtCents(person.outstanding)} in all, so ${fmtCents(amount)} is too much`);
  let left = amount;
  const payments = [];
  for (const d of openDebtsOf(db, person.key, today)) {
    if (left <= 0) break;
    const part = Math.min(left, d.outstanding);
    const { outstanding, ...p } = addOwedPayment(db, d.id, { amount: part, date, note, transaction_id }, { today });
    payments.push(p);
    left -= part;
  }
  return { person: person.name, payments, outstanding: person.outstanding - amount };
}

// Settle or write off everything a person has open.
export function closePerson(db, ref, status, { today = zoneDate() } = {}) {
  if (status !== 'settled' && status !== 'written_off') throw bad("status must be 'settled' or 'written_off'");
  const person = findDebtor(db, ref, { today });
  const debts = openDebtsOf(db, person.key, today);
  for (const d of debts) updateOwed(db, d.id, { closed: status }, { today });
  return { person: person.name, closed: status, debts: debts.map((d) => d.id), amount: person.outstanding };
}
