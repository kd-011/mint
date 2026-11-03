// Tax and business. Deductible spend is tagged with an ATO category (the
// individual return's D items, or a business expense label), receipts are
// the owner's own uploads kept under data/receipts, and the financial year runs
// 1 July to 30 June. the owner is not GST registered, so there is no GST anywhere.
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { bad, notFound, HttpError } from './errors.mjs';
import { COUNTS, BUSINESS, FROM } from './spend.mjs';
import { fmtDMY, isIsoDate } from './dates.mjs';
import { getSetting, setSetting } from './db.mjs';
import { LIVE } from './live.mjs';

export const ATO_CATEGORIES = [
  { code: 'D1', label: 'Work-related car expenses', group: 'Individual deductions' },
  { code: 'D2', label: 'Work-related travel expenses', group: 'Individual deductions' },
  { code: 'D3', label: 'Work-related clothing, laundry and dry-cleaning expenses', group: 'Individual deductions' },
  { code: 'D4', label: 'Work-related self-education expenses', group: 'Individual deductions' },
  { code: 'D5', label: 'Other work-related expenses', group: 'Individual deductions' },
  { code: 'D6', label: 'Low-value pool deduction', group: 'Individual deductions' },
  { code: 'D7', label: 'Interest deductions', group: 'Individual deductions' },
  { code: 'D8', label: 'Dividend deductions', group: 'Individual deductions' },
  { code: 'D9', label: 'Gifts or donations', group: 'Individual deductions' },
  { code: 'D10', label: 'Cost of managing tax affairs', group: 'Individual deductions' },
  { code: 'D12', label: 'Personal superannuation contributions', group: 'Individual deductions' },
  { code: 'D15', label: 'Other deductions', group: 'Individual deductions' },
  { code: 'BUS_COGS', label: 'Cost of sales', group: 'Business expenses' },
  { code: 'BUS_CONTRACTORS', label: 'Contractor, sub-contractor and commission expenses', group: 'Business expenses' },
  { code: 'BUS_SUPER', label: 'Superannuation expenses', group: 'Business expenses' },
  { code: 'BUS_RENT', label: 'Rent expenses', group: 'Business expenses' },
  { code: 'BUS_INTEREST', label: 'Interest expenses within Australia', group: 'Business expenses' },
  { code: 'BUS_MV', label: 'Motor vehicle expenses', group: 'Business expenses' },
  { code: 'BUS_REPAIRS', label: 'Repairs and maintenance', group: 'Business expenses' },
  { code: 'BUS_DEPRECIATION', label: 'Depreciation expenses', group: 'Business expenses' },
  { code: 'BUS_OTHER', label: 'All other expenses', group: 'Business expenses' },
];
const ATO = new Map(ATO_CATEGORIES.map((c, i) => [c.code, { ...c, sort: i }]));

const txRow = (db, id) => {
  const r = typeof id === 'string' ? db.prepare('SELECT t.id, t.amount, t.is_business, a.is_business account_business FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?').get(id) : null;
  if (!r) throw notFound('no such transaction');
  return r;
};

export function setTaxTag(db, txId, { ato_category, deductible_amount = null, note = null } = {}) {
  const t = txRow(db, txId);
  if (!ATO.has(ato_category)) throw bad('ato_category must be one of the ATO categories');
  if (t.amount >= 0) throw bad('only money out can be deductible');
  const full = -t.amount;
  const amount = deductible_amount ?? full;
  if (!Number.isInteger(amount) || amount < 1 || amount > full) throw bad('deductible_amount must be whole cents, more than zero and no more than the charge');
  if (note != null && (typeof note !== 'string' || note.length > 500)) throw bad('note must be up to 500 characters');
  db.prepare(`INSERT INTO tax_tags (transaction_id, ato_category, deductible_amount, note, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(transaction_id) DO UPDATE SET ato_category = excluded.ato_category, deductible_amount = excluded.deductible_amount, note = excluded.note`)
    .run(txId, ato_category, amount, note?.trim() || null, new Date().toISOString());
  return { transaction_id: txId, ato_category, label: ATO.get(ato_category).label, deductible_amount: amount, note: note?.trim() || null };
}

export function clearTaxTag(db, txId) {
  txRow(db, txId);
  return { cleared: db.prepare('DELETE FROM tax_tags WHERE transaction_id = ?').run(txId).changes > 0 };
}

// true or false overrides the account's flag for this one transaction; null
// goes back to inheriting it.
export function setBusiness(db, txId, value) {
  const t = txRow(db, txId);
  if (value !== null && typeof value !== 'boolean') throw bad('is_business must be true, false or null');
  db.prepare('UPDATE transactions SET is_business = ? WHERE id = ?').run(value === null ? null : value ? 1 : 0, txId);
  return { transaction_id: txId, is_business: value, business: value ?? !!t.account_business };
}

export function fyRange(fy) {
  if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) throw bad('fy must be the year the financial year ends, e.g. 2026');
  return { from: `${fy - 1}-07-01`, to: `${fy}-06-30` };
}

export const fyOf = (iso) => Number(iso.slice(0, 4)) + (Number(iso.slice(5, 7)) >= 7 ? 1 : 0);

export function fySummary(db, fy) {
  const { from, to } = fyRange(fy);
  const ded = db.prepare(`SELECT g.ato_category code, SUM(g.deductible_amount) amount, count(*) n,
      SUM(EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)) with_receipt
    FROM tax_tags g JOIN transactions t ON t.id = g.transaction_id WHERE t.date BETWEEN ? AND ? AND ${LIVE()} GROUP BY 1`).all(from, to)
    .map((r) => ({ code: r.code, label: ATO.get(r.code)?.label ?? r.code, group: ATO.get(r.code)?.group ?? '', amount: r.amount, count: r.n, with_receipt: r.with_receipt }))
    .sort((a, b) => (ATO.get(a.code)?.sort ?? 99) - (ATO.get(b.code)?.sort ?? 99));
  const biz = db.prepare(`SELECT COALESCE(c.name, 'Uncategorised') category,
      SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) income, -SUM(CASE WHEN t.amount < 0 THEN t.amount ELSE 0 END) expenses
    FROM ${FROM} WHERE ${BUSINESS} = 1 AND ${COUNTS} AND t.date BETWEEN ? AND ? GROUP BY 1 ORDER BY expenses DESC`).all(from, to);
  const income = biz.reduce((s, r) => s + r.income, 0);
  const expenses = biz.reduce((s, r) => s + r.expenses, 0);
  const tagged = ded.reduce((s, r) => s + r.count, 0);
  const withReceipt = ded.reduce((s, r) => s + r.with_receipt, 0);
  return {
    fy, from, to,
    deductions: { total: ded.reduce((s, r) => s + r.amount, 0), count: tagged, by_category: ded.map(({ with_receipt, ...r }) => r) },
    business: { income, expenses, net: income - expenses, by_category: biz },
    receipts: { attached: withReceipt, missing: tagged - withReceipt },
  };
}

// What the tax return estimate needs that the bank feed cannot tell Mint, per
// financial year, as the owner gives it (a payslip, or the income statement once it
// is tax ready). Cents, except as_at (a date in the year), has_help and
// private_health (a full year of hospital cover, for the Medicare levy
// surcharge). Unset is null, which the estimate treats as unknown. Stored in
// settings as tax_estimate_inputs:<fy>.
export const TAX_INPUTS = {
  gross_salary: 'cents', // year to date gross salary, as at as_at (the whole year once the year has ended)
  tax_withheld: 'cents', // PAYG withheld, year to date, from the same payslip or statement
  as_at: 'date', // the date those two figures run to; blank means today
  other_income: 'cents', // income Mint cannot see (interest elsewhere, dividends, side work)
  extra_deductions: 'cents', // deductions not tagged in Mint
  has_help: 'bool', // a HELP or other study loan: true, false, or unknown
  help_debt: 'cents', // its balance, which caps the repayment; a balance alone means yes
  private_health: 'bool',
};
const taxInputsKey = (fy) => `tax_estimate_inputs:${fy}`;

export function getTaxInputs(db, fy) {
  fyRange(fy);
  let saved = {};
  try { saved = JSON.parse(getSetting(db, taxInputsKey(fy)) ?? '{}') ?? {}; } catch {}
  return Object.fromEntries(Object.keys(TAX_INPUTS).map((k) => [k, saved[k] ?? null]));
}

// Only the keys given change; null clears one.
export function setTaxInputs(db, fy, body = {}) {
  const next = getTaxInputs(db, fy);
  const keys = Object.keys(body).filter((k) => k !== 'fy');
  if (!keys.length) throw bad(`nothing to change: give any of ${Object.keys(TAX_INPUTS).join(', ')}`);
  for (const k of keys) {
    const kind = TAX_INPUTS[k];
    if (!kind) throw bad(`${String(k).slice(0, 40)} is not a tax estimate input; they are ${Object.keys(TAX_INPUTS).join(', ')}`);
    const v = body[k];
    if (v !== null && kind === 'cents' && (!Number.isInteger(v) || v < 0 || v > 1e11)) throw bad(`${k} must be whole cents, zero or more, or null`);
    if (v !== null && kind === 'bool' && typeof v !== 'boolean') throw bad(`${k} must be true, false or null`);
    if (v !== null && kind === 'date') {
      const { from, to } = fyRange(fy);
      if (!isIsoDate(v) || v < from || v > to) throw bad(`${k} must be a date in FY${fy} (${from} to ${to}) as YYYY-MM-DD, or null`);
    }
    next[k] = v;
  }
  if (Object.values(next).every((v) => v == null)) db.prepare('DELETE FROM settings WHERE key = ?').run(taxInputsKey(fy));
  else setSetting(db, taxInputsKey(fy), JSON.stringify(next));
  return { fy, inputs: next };
}

// Every tagged deduction in a financial year, newest first, for the Tax screen.
export function fyDeductions(db, fy) {
  const { from, to } = fyRange(fy);
  return db.prepare(`SELECT t.id transaction_id, t.date, COALESCE(t.merchant_override, t.merchant) merchant, t.description,
      COALESCE(a.nickname, a.name) account_name, t.amount, g.deductible_amount, g.ato_category, g.note, ${BUSINESS} business,
      (SELECT count(*) FROM receipts r WHERE r.transaction_id = t.id) receipts
    FROM tax_tags g JOIN transactions t ON t.id = g.transaction_id JOIN accounts a ON a.id = t.account_id AND a.merged_into IS NULL
    WHERE t.date BETWEEN ? AND ? ORDER BY t.date DESC, t.id DESC`).all(from, to)
    .map((r) => ({ ...r, business: !!r.business, label: ATO.get(r.ato_category)?.label ?? r.ato_category }));
}

export const dollars = (c) => (c == null ? '' : (c / 100).toFixed(2));
// Spreadsheet formula injection: a text cell starting with = + - @ is quoted.
export function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// scope: 'all' is every tagged deduction plus every business row (the Tax
// screen export); 'deductions' and 'business' are the two halves, for the
// accountant pack.
const CSV_SCOPE = {
  all: `(g.transaction_id IS NOT NULL OR (${BUSINESS} = 1 AND ${COUNTS}))`,
  deductions: 'g.transaction_id IS NOT NULL',
  business: `(${BUSINESS} = 1 AND ${COUNTS})`,
};

export function fyCsv(db, fy, scope = 'all') {
  const { from, to } = fyRange(fy);
  if (!CSV_SCOPE[scope]) throw bad('unknown export scope');
  const rows = db.prepare(`SELECT t.id, t.date, t.description, COALESCE(t.merchant_override, t.merchant) merchant, COALESCE(a.nickname, a.name) account,
      t.amount, g.deductible_amount, g.ato_category, ${BUSINESS} business, c.name category, COALESCE(g.note, t.note) note,
      (SELECT count(*) FROM receipts r WHERE r.transaction_id = t.id) receipts
    FROM ${FROM} LEFT JOIN tax_tags g ON g.transaction_id = t.id
    WHERE t.date BETWEEN ? AND ? AND ${CSV_SCOPE[scope]}
    ORDER BY t.date, t.id`).all(from, to);
  const head = ['Date', 'Description', 'Merchant', 'Account', 'Amount', 'Deductible', 'ATO code', 'ATO category', 'Business', 'Category', 'Note', 'Receipts'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([fmtDMY(r.date), r.description.trim(), r.merchant, r.account, dollars(r.amount), dollars(r.deductible_amount), r.ato_category ?? '',
      r.ato_category ? ATO.get(r.ato_category)?.label ?? '' : '', r.business ? 'Business' : 'Personal', r.category ?? '', r.note ?? '', r.receipts].map(cell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// receipts

export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1', 'msf1']);
const FILE_NAME = /^[0-9a-f]{32}\.(png|jpg|webp|heic|pdf)$/;

// The real type from the first bytes, or null when it is not an allowed one.
export function sniffReceipt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.has(buf.toString('latin1', 8, 12))) return 'image/heic';
  if (buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

const normType = (t) => {
  const s = String(t ?? '').split(';')[0].trim().toLowerCase();
  return s === 'image/jpg' ? 'image/jpeg' : s === 'image/heif' ? 'image/heic' : s;
};

export function saveReceipt({ db, dir, transactionId, buf, declaredType }) {
  txRow(db, transactionId);
  if (!buf?.length) throw bad('the receipt is empty');
  if (buf.length > RECEIPT_MAX_BYTES) throw new HttpError(413, `receipts are capped at ${RECEIPT_MAX_BYTES / 1024 / 1024} MB`);
  const mime = sniffReceipt(buf);
  if (!mime) throw new HttpError(415, 'receipts must be a JPEG, PNG, WebP, HEIC or PDF');
  if (normType(declaredType) !== mime) throw new HttpError(415, 'the file does not match its declared type');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = `${randomBytes(16).toString('hex')}.${EXT[mime]}`;
  writeFileSync(join(dir, file), buf, { mode: 0o600, flag: 'wx' });
  const at = new Date().toISOString();
  const { lastInsertRowid } = db.prepare('INSERT INTO receipts (transaction_id, file, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(transactionId, file, mime, buf.length, at);
  return { id: Number(lastInsertRowid), transaction_id: transactionId, file, mime, bytes: buf.length, created_at: at };
}

export function getReceipt({ db, dir, id }) {
  const r = Number.isInteger(id) ? db.prepare('SELECT id, transaction_id, file, mime, bytes, created_at FROM receipts WHERE id = ?').get(id) : null;
  if (!r || !FILE_NAME.test(r.file)) throw notFound('no such receipt');
  return { ...r, path: join(dir, r.file) };
}

export function deleteReceipt({ db, dir, id }) {
  const r = getReceipt({ db, dir, id });
  try { unlinkSync(r.path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  db.prepare('DELETE FROM receipts WHERE id = ?').run(id);
  return { deleted: true };
}

export const listReceipts = (db, txId) =>
  db.prepare('SELECT id, mime, bytes, created_at FROM receipts WHERE transaction_id = ? ORDER BY id').all(txId);
