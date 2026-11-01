// CSV statement import into a manual account (lib/manual.mjs).
//
// The file is untrusted text: decoded strictly (UTF-8, else Windows-1252,
// binary refused), capped at 2 MB and 20,000 rows, parsed by the small RFC 4180
// parser below (quoted fields, doubled quotes, embedded commas and newlines),
// and stored as plain text (a cell that looks like a formula stays text; the
// CSV export quotes it, the page escapes it).
//
// readStatement finds the delimiter, the header row (past any lines of bank
// preamble), a column mapping (date, description, amount or debit and credit,
// optional balance and reference) and the date order, then parses every row
// or says why it cannot, by row number. previewImport adds which rows are
// already in the book; runImport writes the rest in one transaction as one
// manual_imports row, so an import undoes as one (undoImport).
//
// Re-importing is safe: each row's import_hash is account + date + amount +
// description (case and spacing ignored) + how many times that same row came
// before it in the file, so the same or an overlapping statement adds nothing
// twice, while two identical coffees on one day stay two rows.
import { createHash } from 'node:crypto';
import { HttpError, bad, notFound } from './errors.mjs';
import { tx } from './db.mjs';
import { fmtDMY } from './dates.mjs';
import { getManual, insertManualRow, recomputeAccount } from './manual.mjs';
import { rateOn } from './fx.mjs';

export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_ROWS = 20_000;
export const DATE_FORMATS = ['DMY', 'MDY', 'YMD'];
const DATE_LABEL = { DMY: 'DD/MM/YYYY', MDY: 'MM/DD/YYYY', YMD: 'YYYY-MM-DD' };
const ROLES = ['date', 'description', 'amount', 'debit', 'credit', 'balance', 'reference'];
const MAX_CENTS = 1e13;

// ---------- bytes to text ----------

export function decodeCsv(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input ?? []);
  if (buf.length > CSV_MAX_BYTES) throw bad('The file is over 2 MB. Split the statement into smaller date ranges and import each one.');
  const head = buf.subarray(0, 8192);
  let control = 0;
  for (const b of head) {
    if (b === 0) throw bad('This looks like a binary file, not a CSV. Export the statement as CSV and try again.');
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) control += 1;
  }
  if (head.length && control / head.length > 0.02) throw bad('This looks like a binary file, not a CSV. Export the statement as CSV and try again.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
  return text.replace(/^﻿/, '');
}

// ---------- RFC 4180 ----------

export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let atStart = true; // at the start of a field, where an opening quote counts
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && atStart) { quoted = true; atStart = false; continue; }
    if (ch === delimiter) { row.push(field); field = ''; atStart = true; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      atStart = true;
      continue;
    }
    field += ch;
    atStart = false;
  }
  if (quoted) throw bad('A quoted field is never closed (an unmatched " in the file), so the rows cannot be told apart.');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const CANDIDATES = [',', ';', '\t', '|'];
export function sniffDelimiter(text) {
  const sample = text.split(/\r\n|\n|\r/).slice(0, 60).join('\n');
  let best = ',';
  let bestScore = 0;
  for (const d of CANDIDATES) {
    let rows;
    try { rows = parseCsv(sample, d); } catch { continue; }
    const counts = new Map();
    for (const r of rows) if (r.length > 1) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    const score = Math.max(0, ...counts.values());
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

// ---------- cells ----------

// A money cell to whole cents, or null. Handles thousands separators either way
// round (1,234.56 and 1.234,56), spaces and apostrophes as grouping, brackets
// and a trailing minus as negative, DR and CR, and currency marks or codes.
// The longest amount or date cell worth reading.
const CELL_MAX = 64;

export function parseAmount(raw) {
  let s = String(raw ?? '').trim();
  // No real amount is this long, and the patterns below are quadratic on a huge cell.
  if (!s || s.length > CELL_MAX) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  const drcr = /\s*\b(DR|CR)\.?$/i.exec(s);
  if (drcr) { if (drcr[1].toUpperCase() === 'DR') neg = !neg; s = s.slice(0, drcr.index).trim(); }
  s = s.replace(/^[A-Za-z]{1,3}(?=[^A-Za-z]|$)/, '').replace(/(?<=[^A-Za-z]|^)[A-Za-z]{1,3}$/, '');
  s = s.replace(/[$€£¥฿₩₹₱₫\s  ']/g, '');
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); } else if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let num;
  const groupsOk = (str, sep) => str.split(sep).slice(1).every((g) => g.length === 3);
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    const [int, frac, extra] = s.split(dec);
    if (extra !== undefined || !groupsOk(int, thou)) return null;
    num = `${int.replaceAll(thou, '')}.${frac}`;
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 2) num = `${parts[0]}.${parts[1]}`;
    else if (groupsOk(s, ',') && parts[0].length >= 1 && parts[0].length <= 3) num = parts.join('');
    else return null;
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    if (parts.length === 2 && !(parts[1].length === 3 && /^[1-9]\d{0,2}$/.test(parts[0]))) num = s;
    else if (groupsOk(s, '.') && parts[0].length >= 1 && parts[0].length <= 3 && /^[1-9]/.test(parts[0])) num = parts.join('');
    else return null;
  } else num = s;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(num);
  if (!m) return null;
  const v = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(v) || v > MAX_CENTS) return null;
  return neg && v ? -v : v;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthOf = (name) => {
  const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return i < 0 ? null : i + 1;
};
const fullYear = (y) => (y.length === 2 ? 2000 + Number(y) : y.length === 4 ? Number(y) : NaN);
function iso(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1900 || y > 2999) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

// A date cell in the given order to YYYY-MM-DD, or null. Strict about the
// order, so guessDateFormat can tell DD/MM from MM/DD. A trailing time is dropped.
export function parseDate(raw, format = 'DMY') {
  let s = String(raw ?? '').trim();
  if (!s || s.length > CELL_MAX) return null;
  s = s.replace(/(?:T|\s+)\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:am|pm)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/i, '').trim();
  let m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-./]+([A-Za-z]{3,9})\.?,?[\s\-./]+(\d{2}|\d{4})$/.exec(s);
  if (m) return format === 'DMY' ? iso(fullYear(m[3]), monthOf(m[2]), Number(m[1])) : null;
  m = /^([A-Za-z]{3,9})\.?[\s\-./]+(\d{1,2})(?:st|nd|rd|th)?,?[\s\-./]+(\d{2}|\d{4})$/.exec(s);
  if (m) return format === 'MDY' ? iso(fullYear(m[3]), monthOf(m[1]), Number(m[2])) : null;
  if (/^\d{8}$/.test(s)) return format === 'YMD' ? iso(Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6))) : null;
  m = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/.exec(s);
  if (!m) return null;
  const [, a, b, c] = m;
  if (format === 'YMD') return a.length === 4 ? iso(Number(a), Number(b), Number(c)) : null;
  if (a.length > 2 || (c.length !== 2 && c.length !== 4)) return null;
  return format === 'DMY' ? iso(fullYear(c), Number(b), Number(a)) : iso(fullYear(c), Number(a), Number(b));
}

// Which orders read every date in the column. Australian order wins a tie, and
// the tie is reported so the page can ask.
export function guessDateFormat(values) {
  const vals = values.map((v) => String(v ?? '').trim()).filter((v) => v && DATE_FORMATS.some((f) => parseDate(v, f)));
  const possible = DATE_FORMATS.filter((f) => vals.length && vals.every((v) => parseDate(v, f)));
  return { format: possible[0] ?? 'DMY', ambiguous: possible.length > 1, possible };
}

// ---------- the statement ----------

const NAMES = {
  date: /^(transaction |posted |posting |value |booking |trans\.? )?date\b|^date|^when$|^created( on)?$|^completed( on)?$|^finished( on)?$/i,
  debit: /debit|withdrawal|paid out|money out|^out$|outflow|^spent$/i,
  credit: /credit|deposit|paid in|money in|^in$|inflow|^received$/i,
  balance: /balance/i,
  reference: /reference|^ref\b|transaction id|^id$|receipt|cheque/i,
  amount: /^amount|^value$|^net amount|^sum$|^total$/i,
  description: /description|details|narrative|merchant|payee|particulars|memo|^what$|^name$|^transaction$|^payment$|^text$/i,
};
const isAmount = (v) => parseAmount(v) != null;
const BARE_NUMBER = /^[\s(+\-$€£¥]*\d[\d.,\s']*\)?-?$/;
const isDate = (v) => DATE_FORMATS.some((f) => parseDate(v, f));

function guessMapping(columns, data, hasHeader) {
  const map = Object.fromEntries(ROLES.map((r) => [r, null]));
  const used = new Set();
  if (hasHeader) {
    for (const role of ['date', 'debit', 'credit', 'balance', 'reference', 'amount', 'description']) {
      const i = columns.findIndex((c, idx) => !used.has(idx) && NAMES[role].test(String(c).trim()));
      if (i >= 0) { map[role] = i; used.add(i); }
    }
    if (map.amount != null && (map.debit != null || map.credit != null)) {
      // An Amount column says it all; debit and credit headers beside it are usually flags.
      for (const r of ['debit', 'credit']) { if (map[r] != null) used.delete(map[r]); map[r] = null; }
    }
  }
  // Fill the gaps from what the cells hold.
  const share = (i, test) => {
    const cells = data.map((r) => r[i] ?? '').filter((v) => String(v).trim());
    return cells.length ? cells.filter(test).length / cells.length : 0;
  };
  const free = () => columns.map((_, i) => i).filter((i) => !used.has(i));
  if (map.date == null) {
    const i = free().find((c) => share(c, isDate) >= 0.8);
    if (i != null) { map.date = i; used.add(i); }
  }
  if (map.amount == null && map.debit == null && map.credit == null) {
    const i = free().find((c) => share(c, isAmount) >= 0.8);
    if (i != null) { map.amount = i; used.add(i); }
  }
  if (!hasHeader && map.amount != null && map.balance == null) {
    // No header row: a statement that carries a balance puts it after the amount (CommBank does).
    const i = free().find((c) => c > map.amount && share(c, isAmount) >= 0.8);
    if (i != null) { map.balance = i; used.add(i); }
  }
  if (map.description == null) {
    const avg = (i) => data.reduce((s, r) => s + String(r[i] ?? '').trim().length, 0) / Math.max(1, data.length);
    const i = free().filter((c) => share(c, isAmount) < 0.5 && share(c, isDate) < 0.5).sort((x, y) => avg(y) - avg(x))[0];
    if (i != null) { map.description = i; used.add(i); }
  }
  return map;
}

function checkMapping(m, width) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('mapping must name the columns: { date, description, amount } or debit and credit');
  const out = {};
  for (const r of ROLES) {
    const v = m[r] ?? null;
    if (v !== null && (!Number.isInteger(v) || v < 0 || v >= width)) throw bad(`mapping.${r} must be a column number from 0 to ${width - 1}, or null`);
    out[r] = v;
  }
  if (out.date == null) throw bad('pick the column that holds the date');
  if (out.description == null) throw bad('pick the column that holds the description');
  if (out.amount == null && out.debit == null && out.credit == null) throw bad('pick the amount column, or the debit and credit columns');
  if (out.amount != null) { out.debit = null; out.credit = null; }
  return out;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function readStatement(text, { mapping = null, date_format = null, today = '2999-12-31' } = {}) {
  if (typeof text !== 'string') throw bad('text must be the CSV file as text');
  const delimiter = sniffDelimiter(text);
  const records = parseCsv(text, delimiter);
  const filled = (r) => r.some((c) => c.trim());
  const counts = new Map();
  for (const r of records.slice(0, 300)) if (r.length > 1) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
  if (!counts.size) throw bad("Couldn't find the columns: the file needs at least a date, a description and an amount column");
  const width = [...counts].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0][0];
  const first = records.findIndex((r) => r.length >= width && filled(r));
  // A header can hold a word that parseAmount would take for money ("Ref2" reads as 2), so only a bare number counts here.
  const looksData = (r) => r.some((c) => isDate(c) || (BARE_NUMBER.test(c.trim()) && isAmount(c)));
  const hasHeader = first >= 0 && !looksData(records[first]);
  const start = hasHeader ? first + 1 : first;
  const columns = hasHeader ? records[first].map((c, i) => c.trim() || `Column ${i + 1}`) : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const data = [];
  for (let i = start; i < records.length; i++) if (filled(records[i])) data.push({ row: i + 1, cells: records[i] });
  if (data.length > CSV_MAX_ROWS) throw bad(`The file has ${data.length.toLocaleString('en-AU')} rows; an import takes up to 20,000 rows. Split the statement and import each part.`);
  if (!data.length) throw bad('The file has no rows to import under its header');
  const map = mapping ? checkMapping(mapping, columns.length) : guessMapping(columns, data.slice(0, 200).map((d) => d.cells), hasHeader);
  if (!mapping && (map.date == null || map.description == null || (map.amount == null && map.debit == null && map.credit == null))) {
    // The page shows the mapper; nothing parses until it is complete.
    return { delimiter, header_row: hasHeader ? first : null, columns, mapping: map, date_format: date_format ?? 'DMY', date_guess: null, rows: [], failures: [], total: data.length, raw: data.slice(0, 6).map((d) => d.cells), incomplete: true };
  }
  const date_guess = guessDateFormat(data.map((d) => d.cells[map.date]));
  const fmt = date_format ?? date_guess.format;
  if (!DATE_FORMATS.includes(fmt)) throw bad(`date_format must be one of ${DATE_FORMATS.join(', ')}`);
  const rows = [];
  const failures = [];
  const cell = (d, i) => (i == null ? '' : String(d.cells[i] ?? '').trim());
  for (const d of data) {
    const fail = (reason) => failures.push({ row: d.row, reason });
    const rawDate = cell(d, map.date);
    const date = parseDate(rawDate, fmt);
    if (!rawDate) { fail('no date'); continue; }
    if (!date) { fail(`date "${clip(rawDate, 40)}" is not ${DATE_LABEL[fmt]}`); continue; }
    if (date > today) { fail(`date ${fmtDMY(date)} is in the future`); continue; }
    let amount;
    if (map.amount != null) {
      const raw = cell(d, map.amount);
      if (!raw) { fail('no amount'); continue; }
      amount = parseAmount(raw);
      if (amount == null) { fail(`amount "${clip(raw, 40)}" is not a number`); continue; }
    } else {
      const rd = cell(d, map.debit);
      const rc = cell(d, map.credit);
      if (!rd && !rc) { fail(`no amount in ${[map.debit, map.credit].filter((x) => x != null).map((x) => columns[x]).join(' or ')}`); continue; }
      const dv = rd ? parseAmount(rd) : 0;
      const cv = rc ? parseAmount(rc) : 0;
      if (dv == null) { fail(`amount "${clip(rd, 40)}" is not a number`); continue; }
      if (cv == null) { fail(`amount "${clip(rc, 40)}" is not a number`); continue; }
      amount = Math.abs(cv) - Math.abs(dv);
    }
    if (amount === 0) { fail('amount is zero'); continue; }
    const reference = map.reference != null ? clip(cell(d, map.reference), 100) || null : null;
    const description = clip(cell(d, map.description).replace(/\s+/g, ' '), 200) || reference || 'No description';
    const balance = map.balance != null ? parseAmount(cell(d, map.balance)) : null;
    rows.push({ row: d.row, date, amount, description, reference, balance });
  }
  return { delimiter, header_row: hasHeader ? first : null, columns, mapping: map, date_format: fmt, date_guess, rows, failures, total: data.length, raw: data.slice(0, 6).map((d) => d.cells) };
}

// ---------- against the book ----------

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
function hashRows(accountId, rows) {
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.date}|${r.amount}|${norm(r.description)}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    r.hash = createHash('sha256').update(`${accountId}|${k}|${n}`).digest('hex').slice(0, 32);
  }
  return rows;
}

function remembered(a) {
  try { return JSON.parse(a.csv_mapping ?? 'null'); } catch { return null; }
}

function plan(db, a, body, today) {
  if (typeof body.text !== 'string' || !body.text) throw bad('text must be the CSV file as text');
  if (Buffer.byteLength(body.text, 'utf8') > CSV_MAX_BYTES) throw bad('The file is over 2 MB. Split the statement into smaller date ranges and import each one.');
  let st = readStatement(body.text, { mapping: body.mapping ?? null, date_format: body.date_format ?? null, today });
  let usedMemory = false;
  const mem = remembered(a);
  if (!body.mapping && mem && JSON.stringify(mem.columns) === JSON.stringify(st.columns)) {
    st = readStatement(body.text, { mapping: mem.mapping, date_format: body.date_format ?? mem.date_format ?? null, today });
    usedMemory = true;
  }
  hashRows(a.id, st.rows);
  const have = new Set(db.prepare('SELECT import_hash FROM transactions WHERE account_id = ? AND import_hash IS NOT NULL').all(a.id).map((r) => r.import_hash));
  for (const r of st.rows) r.duplicate = have.has(r.hash);
  return { st, usedMemory };
}

// The statement's own closing balance: the balance on its latest row.
function closing(rows) {
  let best = null;
  for (const r of rows) if (r.balance != null && (!best || r.date >= best.date)) best = r;
  return best ? { date: best.date, balance: best.balance } : null;
}

export function previewImport(db, accountId, body = {}, { today }) {
  const a = getManual(db, accountId);
  const { st, usedMemory } = plan(db, a, body, today);
  const fresh = st.rows.filter((r) => !r.duplicate);
  const warnings = [];
  if (st.date_guess?.ambiguous && !body.date_format && !usedMemory) {
    warnings.push(`Every date in this file could be read either way (${st.date_guess.possible.map((f) => DATE_LABEL[f]).join(' or ')}). Check the dates below and pick the order if they are wrong.`);
  }
  const noRate = a.currency === 'AUD' ? [] : fresh.filter((r) => !rateOn(db, a.currency, r.date));
  if (noRate.length) warnings.push(`No exchange rate for ${a.currency} on ${fmtDMY(noRate[0].date)}${noRate.length > 1 ? ` and ${noRate.length - 1} more` : ''}, so the import would be refused. Connect and try again.`);
  const dates = st.rows.map((r) => r.date).sort();
  const sum = fresh.filter((r) => r.date >= a.opening_date).reduce((s, r) => s + r.amount, 0);
  return {
    account_id: a.id, currency: a.currency, file_name: body.file_name ?? null,
    delimiter: st.delimiter, header_row: st.header_row, columns: st.columns, raw: st.raw,
    mapping: st.mapping, date_format: st.date_format, date_guess: st.date_guess, remembered: usedMemory, incomplete: !!st.incomplete,
    counts: { total: st.total, import: fresh.length, duplicate: st.rows.length - fresh.length, failed: st.failures.length },
    failures: st.failures.slice(0, 100),
    sample: st.rows.slice(0, 12).map(({ row, date, amount, description, reference, balance, duplicate }) => ({ row, date, amount, description, reference, balance, duplicate })),
    from: dates[0] ?? null, to: dates.at(-1) ?? null,
    balance_now: a.balance_native ?? 0, balance_after: (a.balance_native ?? 0) + sum,
    statement_balance: closing(st.rows),
    warnings,
  };
}

// The dates an import would need rates for, so the API can fetch them first.
export function importDates(db, accountId, body = {}, { today }) {
  const a = getManual(db, accountId);
  if (a.currency === 'AUD') return { currency: 'AUD', dates: [] };
  const { st } = plan(db, a, body, today);
  return { currency: a.currency, dates: [...new Set(st.rows.filter((r) => !r.duplicate).map((r) => r.date))] };
}

// set_balance: also record an adjustment so the balance matches the
// statement's closing balance (part of the same import, so it undoes with it).
export function runImport(db, accountId, body = {}, { today, now = new Date() }) {
  const a = getManual(db, accountId);
  if (a.status === 'gone') throw bad(`${a.nickname || a.name} is archived: bring it back before importing into it`);
  const { st } = plan(db, a, body, today);
  if (st.incomplete) throw bad('pick the date, description and amount columns first');
  const fresh = st.rows.filter((r) => !r.duplicate);
  const dates = fresh.map((r) => r.date).sort();
  const close = body.set_balance === true ? closing(st.rows) : null;
  const out = { import_id: null, imported: 0, duplicates: st.rows.length - fresh.length, failed: st.failures.length, failures: st.failures.slice(0, 100), from: dates[0] ?? null, to: dates.at(-1) ?? null, adjustment: null };
  tx(db, () => {
    db.prepare('UPDATE accounts SET csv_mapping = ? WHERE id = ?').run(JSON.stringify({ columns: st.columns, mapping: st.mapping, date_format: st.date_format }), a.id);
    if (!fresh.length && !close) return;
    const at = now.toISOString();
    const { lastInsertRowid } = db.prepare(`INSERT INTO manual_imports (account_id, file_name, rows, duplicates, failed, from_date, to_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(a.id, typeof body.file_name === 'string' ? body.file_name.slice(0, 120) : null, fresh.length, out.duplicates, out.failed, out.from, out.to, at);
    const importId = Number(lastInsertRowid);
    for (const r of fresh) insertManualRow(db, a, { date: r.date, amount_native: r.amount, description: r.description, reference: r.reference }, { now, importId, importHash: r.hash });
    if (close && close.date >= a.opening_date) {
      const have = (a.opening_balance ?? 0) + db.prepare('SELECT COALESCE(SUM(amount_native), 0) s FROM transactions WHERE account_id = ? AND date >= ? AND date <= ?').get(a.id, a.opening_date, close.date).s;
      const diff = close.balance - have;
      if (diff) {
        const cat = db.prepare("SELECT id FROM categories WHERE name = 'Balance adjustment'").get()?.id ?? null;
        insertManualRow(db, a, { date: close.date, amount_native: diff, description: 'Balance adjustment', category_id: cat, note: 'Matches the statement balance' }, { now, importId });
        out.adjustment = diff;
      }
    }
    out.import_id = importId;
    out.imported = fresh.length;
  });
  recomputeAccount(db, a.id, { today, now });
  return out;
}

export function undoImport(db, importId, { today, now = new Date() }) {
  const imp = Number.isInteger(importId) ? db.prepare('SELECT * FROM manual_imports WHERE id = ?').get(importId) : null;
  if (!imp) throw notFound('no such import');
  if (imp.undone_at) throw new HttpError(409, 'this import was already undone');
  const removed = tx(db, () => {
    const n = db.prepare('DELETE FROM transactions WHERE import_id = ?').run(importId).changes;
    db.prepare('UPDATE manual_imports SET undone_at = ? WHERE id = ?').run(now.toISOString(), importId);
    return Number(n);
  });
  recomputeAccount(db, imp.account_id, { today, now });
  return { undone: true, import_id: importId, account_id: imp.account_id, removed };
}

export function listImports(db, accountId) {
  return db.prepare(`SELECT id, file_name, rows, duplicates, failed, from_date, to_date, created_at, undone_at
    FROM manual_imports WHERE account_id = ? ORDER BY id DESC`).all(accountId);
}
