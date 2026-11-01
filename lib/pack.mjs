// The accountant year-end pack for one financial year: a single zip holding a
// summary page, the deductions and business CSVs (the existing formula-neutral
// exports), the receipts grouped by ATO category and named date_merchant_amount,
// and a manifest of deductions with no receipt. Written entry by entry to a
// writable, so memory stays at one stream chunk however many receipts there are.
// the owner is not GST registered, so there is no GST anywhere.
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { HttpError } from './errors.mjs';
import { createZipWriter } from './zip.mjs';
import { fyRange, fySummary, fyDeductions, fyCsv, getReceipt } from './tax.mjs';
import { COUNTS, BUSINESS, FROM, KIND } from './spend.mjs';
import { fmtDMY, perthDate } from './dates.mjs';
import { LIVE } from './live.mjs';

export const MAX_RECEIPT_BYTES = 1024 * 1024 * 1024;

export const packFileName = (fy) => `mint-fy${fy}-accountant-pack.zip`;
const fyName = (fy) => `FY ${fy - 1}-${String(fy).slice(2)}`;
const fmtMoney = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plain = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (v) => plain(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slug = (v) => plain(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'unnamed';
const folderOf = (d) => `${d.ato_category.replace(/_/g, '-')} ${d.label}`.replace(/[^A-Za-z0-9 ,()-]+/g, '-').slice(0, 80).trim();

// Salary and regular payers by source, and other money in apart. Business rows
// are left to the business section, reimbursements are not income.
function incomeBySource(db, from, to) {
  const rows = db.prepare(`SELECT COALESCE(s.name, t.merchant_override, t.merchant, t.description) source, COALESCE(t.income_kind, 'salary') kind,
      SUM(t.amount) total, count(*) n
    FROM ${FROM} LEFT JOIN income_sources s ON s.id = t.income_source_id
    WHERE t.amount > 0 AND ${KIND} = 'income' AND COALESCE(t.income_kind, 'salary') != 'reimbursement' AND ${COUNTS}
      AND ${BUSINESS} = 0 AND t.date BETWEEN ? AND ?
    GROUP BY 1, 2 ORDER BY total DESC`).all(from, to).map((r) => ({ ...r, source: plain(r.source) || 'Unlabelled' }));
  return { income: rows.filter((r) => r.kind !== 'other'), other: rows.filter((r) => r.kind === 'other') };
}

function receiptsByTx(db, from, to) {
  const m = new Map();
  for (const r of db.prepare(`SELECT r.id, r.transaction_id, r.bytes FROM receipts r JOIN tax_tags g ON g.transaction_id = r.transaction_id
      JOIN transactions t ON t.id = r.transaction_id WHERE t.date BETWEEN ? AND ? AND ${LIVE()} ORDER BY r.id`).all(from, to)) {
    if (!m.has(r.transaction_id)) m.set(r.transaction_id, []);
    m.get(r.transaction_id).push(r);
  }
  return m;
}

const table = (head, rows, right = []) => `<table><thead><tr>${head.map((h, i) => `<th${right.includes(i) ? ' class="r"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${right.includes(i) ? ' class="r"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

function summaryHtml({ fy, from, to, sum, inc, estimate, generated, stats }) {
  const nothing = !inc.income.length && !inc.other.length && !sum.deductions.count && !sum.business.by_category.length;
  const incTotal = inc.income.reduce((s, r) => s + r.total, 0);
  const d = sum.deductions;
  const b = sum.business;
  const sections = [];
  if (nothing) sections.push(`<p>Nothing recorded for ${esc(fyName(fy))}. No income, deductions or business transactions fall in this financial year.</p>`);
  else {
    sections.push(`<h2>Income by source</h2>${inc.income.length
      ? `${table(['Source', 'Payments', 'Total'], inc.income.map((r) => [esc(r.source), r.n, esc(fmtMoney(r.total))]), [1, 2])}<p class="tot">Total income <strong>${esc(fmtMoney(incTotal))}</strong></p>`
      : '<p>No salary or regular income recorded.</p>'}
      ${inc.other.length ? `<h3>Other money in (interest, gifts, cashback)</h3>${table(['Source', 'Payments', 'Total'], inc.other.map((r) => [esc(r.source), r.n, esc(fmtMoney(r.total))]), [1, 2])}` : ''}
      <p class="small">Business takings are under Business below. Friends paying you back are not income and are left out.</p>`);
    sections.push(`<h2>Deductions by ATO category</h2>${d.count
      ? `${table(['Code', 'Category', 'Items', 'With receipt', 'Deductible'], d.by_category.map((c) => {
        const have = stats.byCode.get(c.code) ?? 0;
        return [esc(c.code.replace(/_/g, ' ')), esc(c.label), c.count, `${have} of ${c.count}`, esc(fmtMoney(c.amount))];
      }), [2, 3, 4])}<p class="tot">Total deductions <strong>${esc(fmtMoney(d.total))}</strong> across ${d.count} item${d.count === 1 ? '' : 's'}. ${stats.missing ? `${stats.missing} without a receipt, listed in manifest.txt.` : 'Every item has a receipt.'}</p>`
      : '<p>No deductions tagged.</p>'}`);
    sections.push(`<h2>Business income and expenses</h2>${b.by_category.length
      ? `<p>Business income <strong>${esc(fmtMoney(b.income))}</strong>, expenses <strong>${esc(fmtMoney(b.expenses))}</strong>, net <strong>${esc(fmtMoney(b.net))}</strong>.</p>${table(['Category', 'Income', 'Expenses'], b.by_category.filter((c) => c.income || c.expenses).map((c) => [esc(c.category), c.income ? esc(fmtMoney(c.income)) : '', c.expenses ? esc(fmtMoney(c.expenses)) : '']), [1, 2])}`
      : '<p>No business transactions.</p>'}`);
  }
  if (estimate?.lines?.length) {
    sections.push(`<h2>${esc(estimate.title || 'Tax return estimate')}</h2>${table(['Item', 'Amount'], estimate.lines.map((l) => [esc(l.label), esc(fmtMoney(l.amount))]), [1])}
      <p class="small"><strong>Estimate, not tax advice.</strong>${estimate.note ? ` ${esc(estimate.note)}` : ''}</p>`);
  }
  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accountant pack, ${esc(fyName(fy))}</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:820px;margin:32px auto;padding:0 16px;color:#1b1f23}
h1{font-size:24px;margin:0}h2{font-size:18px;margin:28px 0 8px;border-bottom:1px solid #d0d7de;padding-bottom:4px}h3{font-size:15px;margin:16px 0 6px}
.sub{color:#57606a;margin:4px 0 0}table{width:100%;border-collapse:collapse;margin:8px 0}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #eaeef2;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#57606a}
.r{text-align:right;font-variant-numeric:tabular-nums}.tot{margin:6px 0}.small{font-size:13px;color:#57606a}
footer{margin-top:32px;padding-top:12px;border-top:1px solid #d0d7de;font-size:13px;color:#57606a}
@media print{body{margin:0}}
</style></head><body>
<h1>Accountant pack, ${esc(fyName(fy))}</h1>
<p class="sub">${esc(fmtDMY(from))} to ${esc(fmtDMY(to))} · prepared ${esc(fmtDMY(generated))} from bank records held in Mint</p>
${sections.join('\n')}
<footer>Files in this pack: deductions.csv, business.csv, receipts folder grouped by ATO category, manifest.txt. Any estimate here is an estimate, not tax advice.</footer>
</body></html>
`;
}

function manifestText({ fy, from, to, generated, files, noReceipt, lostFiles }) {
  const line = (d) => `  ${fmtDMY(d.date)}  ${plain(d.description || d.merchant).slice(0, 60)}  ${fmtMoney(d.deductible_amount)}  ${d.ato_category.replace(/_/g, ' ')} ${d.label}`;
  return [
    `Mint accountant pack, ${fyName(fy)} (${fmtDMY(from)} to ${fmtDMY(to)})`,
    `Prepared ${fmtDMY(generated)}.`,
    '',
    `Receipts in this pack (${files.length})`,
    ...files.map((f) => `  ${f.path}`),
    '',
    `No receipt attached (${noReceipt.length})`,
    ...(noReceipt.length ? noReceipt.map(line) : ['  none']),
    '',
    ...(lostFiles.length ? [`Receipt file missing on disk (${lostFiles.length})`, ...lostFiles.map(line), ''] : []),
  ].join('\r\n');
}

// Writes the pack to `out` (a writable) and returns what went in. `estimate` is
// the tax return estimate ({ title, lines: [{ label, amount }], note }) when
// the caller has one; it prints with the estimate-not-advice line.
export async function buildPack({ db, fy, receiptsDir, out, estimate = null, signal = null, now = new Date(), maxReceiptBytes = MAX_RECEIPT_BYTES }) {
  const { from, to } = fyRange(fy);
  const sum = fySummary(db, fy);
  const deds = fyDeductions(db, fy).slice().reverse(); // oldest first
  const rcpts = receiptsByTx(db, from, to);
  let total = 0;
  for (const list of rcpts.values()) for (const r of list) total += r.bytes;
  if (total > maxReceiptBytes) throw new HttpError(413, `the receipts for ${fyName(fy)} are too large to zip in one pack (${Math.round(total / 1048576)} MB, the cap is ${Math.round(maxReceiptBytes / 1048576)} MB)`);

  const z = createZipWriter(out, { now });
  const generated = perthDate(now);
  const check = () => { if (signal?.aborted) throw new Error('pack cancelled'); };
  const used = new Set();
  const files = [];
  const noReceipt = [];
  const lostFiles = [];
  const byCode = new Map();

  // Receipts first into a plan, so the summary and manifest can report them.
  const plan = [];
  for (const d of deds) {
    const list = rcpts.get(d.transaction_id) ?? [];
    if (!list.length) { noReceipt.push(d); continue; }
    let any = false;
    let lost = false;
    for (const r of list) {
      let rec;
      try { rec = getReceipt({ db, dir: receiptsDir, id: r.id }); } catch { lost = true; continue; }
      if (!existsSync(rec.path)) { lost = true; continue; }
      const stem = `${d.date}_${slug(d.merchant || d.description)}_${(-d.amount / 100).toFixed(2)}`;
      const folder = folderOf(d);
      let name = `receipts/${folder}/${stem}${extname(rec.file)}`;
      for (let n = 2; used.has(name); n++) name = `receipts/${folder}/${stem}-${n}${extname(rec.file)}`;
      used.add(name);
      plan.push({ path: name, src: rec.path });
      files.push({ path: name });
      any = true;
    }
    if (any) byCode.set(d.ato_category, (byCode.get(d.ato_category) ?? 0) + 1);
    if (lost) lostFiles.push(d);
  }

  const stats = { byCode, missing: noReceipt.length };
  await z.addBuffer('summary.html', Buffer.from(summaryHtml({ fy, from, to, sum, inc: incomeBySource(db, from, to), estimate, generated, stats })));
  check();
  await z.addBuffer('deductions.csv', Buffer.from(fyCsv(db, fy, 'deductions')));
  await z.addBuffer('business.csv', Buffer.from(fyCsv(db, fy, 'business')));
  for (const p of plan) { check(); await z.addFile(p.path, p.src, { store: true }); }
  await z.addBuffer('manifest.txt', Buffer.from(`${manifestText({ fy, from, to, generated, files, noReceipt, lostFiles })}\r\n`));
  const done = await z.finish();
  return { entries: done.entries, bytes: done.bytes, receipts: plan.length, missing: noReceipt.length, missing_files: lostFiles.length, deductions: deds.length };
}
