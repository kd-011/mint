// The engine's JSON API. The server has already checked the gate identity and
// the origin before any of this runs. Returns true when it handled the request.
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError, bad, notFound } from './errors.mjs';
import { send, readJson, readRaw, rateLimiter, SECURITY_HEADERS } from './http.mjs';
import { isIsoDate, perthDate, fmtDMY } from './dates.mjs';
import { listCategories } from './categories.mjs';
import { listRules, createRule, updateRule, deleteRule, previewRule, setCategory, bulkEdit } from './categorise.mjs';
import { listTransfers, confirmTransfer, rejectTransfer, linkTransfer, setSplit } from './transfers.mjs';
import { detectRecurring } from './recurring.mjs';
import { listSubscriptions, addSubscription, updateSubscription, deleteSubscription, setDetectedState, clearDetectedState } from './subscriptions.mjs';
import { setBudget, deleteBudget, budgetProgress, cycleBudgetProgress, generateStarterBudgets, categoryTransactions } from './budgets.mjs';
import { listCycles, currentCycle, cycleAt } from './cycles.mjs';
import { incomeByFy, setAssessment, deleteAssessment } from './noa.mjs';
import { incomeReport, listSources, createSource, updateSource, deleteSource, setTransactionIncome, previewSource } from './income.mjs';
import { billsCalendar } from './bills.mjs';
import { forecast, setFloor } from './forecast.mjs';
import { safeToSpend } from './safe.mjs';
import { getPlan, setPlan, suggestPlan, splitStatus } from './plan.mjs';
import { listOwed, getOwed, createOwed, updateOwed, deleteOwed, addOwedPayment, deleteOwedPayment } from './owed.mjs';
import { listGoals, createGoal, updateGoal, deleteGoal, addContribution, deleteContribution, listContributions } from './goals.mjs';
import { debtReport } from './debt.mjs';
import { savingsOverview } from './savings.mjs';
import { superOverview } from './superfund.mjs';
import { portfolio, portfolioHistory, snapshotPortfolio, createHolding, updateHolding, deleteHolding, restoreHolding, addLot, updateLot, deleteLot, decideShares } from './holdings.mjs';
import { homeLoan, setLoanInputs } from './homeloan.mjs';
import { taxReturnEstimate, packEstimate } from './taxestimate.mjs';
import { ATO_CATEGORIES, setTaxTag, clearTaxTag, setBusiness, fySummary, fyDeductions, fyCsv, fyOf, dollars, cell, setTaxInputs, saveReceipt, getReceipt, deleteReceipt, listReceipts, RECEIPT_MAX_BYTES } from './tax.mjs';
import { netWorth, netWorthHistory, listAssets, createAsset, updateAsset, addSnapshot, deleteSnapshot, listSnapshots } from './networth.mjs';
import { listAlerts, dismissAlert, weeklySummary } from './alerts.mjs';
import { BUSINESS } from './spend.mjs';
import { buildPack, packFileName } from './pack.mjs';
import { monthlyReport, topMerchants, reviewCounts } from './reports.mjs';
import { getLogo, withLogos, logoInfo, validLogoKey } from './logos.mjs';
import { searchAll, txTermClause, MAX_TERM } from './search.mjs';
import { cycleInsights } from './insights.mjs';
import { listViews, createView, updateView, deleteView } from './views.mjs';
import { createFx } from './fx.mjs';
import { accountView, updateAccount } from './accounts.mjs';
import { setHomeOrder } from './homeorder.mjs';
import {
  createManualAccount, updateManualAccount, deleteManualAccount, manualSummary, addManualTransaction, updateManualTransaction,
  deleteManualTransaction, setManualBalance, getManual,
} from './manual.mjs';
import { decodeCsv, importDates, previewImport, runImport, undoImport, listImports } from './csvimport.mjs';

const TX_ID = '([A-Za-z0-9_-]{1,100})';
const TX_SELECT = `SELECT t.id, t.account_id, COALESCE(a.nickname, a.name) account_name, t.status, t.date, t.post_date, t.description,
    t.reference, t.extended_description, COALESCE(t.merchant_override, t.merchant) merchant, t.amount, t.currency, t.direction,
    t.amount_native, t.fx_rate, t.fx_date, t.import_id, a.manual account_manual,
    t.provider_category, t.category_id, c.name category, c.kind category_kind, t.category_source, t.rule_id,
    t.is_business, ${BUSINESS} business, t.note, t.income_kind, t.income_source_id, t.offset_category_id,
    x.id transfer_id, x.kind transfer_kind, x.status transfer_status,
    g.ato_category tax_category, g.deductible_amount tax_deductible,
    (SELECT count(*) FROM receipts r WHERE r.transaction_id = t.id) receipts
  FROM transactions t JOIN accounts a ON a.id = t.account_id AND a.merged_into IS NULL LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN transfers x ON x.out_tx = t.id OR x.in_tx = t.id
  LEFT JOIN tax_tags g ON g.transaction_id = t.id`;

// amount is AUD; a manual row (manual: true) also has amount_native in its own currency and the rate used.
export function txView({ transfer_id, transfer_kind, transfer_status, tax_category, tax_deductible, business, account_manual, ...r }) {
  return {
    ...r, business: !!business, manual: !!account_manual,
    transfer: transfer_id ? { id: transfer_id, kind: transfer_kind, status: transfer_status } : null,
    tax: tax_category ? { ato_category: tax_category, deductible_amount: tax_deductible } : null,
  };
}

const intParam = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw bad(`${name} must be a positive whole number`);
  return n;
};

const NO_QUOTES = {
  async refresh() { return { fetched: 0, failed: 0, capped: false, skipped: 'not configured' }; },
  status: () => ({ source: null, configured: false, calls_today: 0, cap: 25, last_ok_at: null, last_error: null, note: 'No price source is set up, so prices are entered by hand.', budgeted_exchanges: null }),
};
const SHARES_FOOTER = 'Information only. Prices can be late or wrong, and nothing here is financial advice or a recommendation to buy or sell.';

export function createApi({ db, engine, ai, dataDir, quotes = NO_QUOTES, logos = null, log = console.log, fx = createFx({ db, log }) }) {
  const receiptsDir = join(dataDir, 'receipts');
  const uploadLimited = rateLimiter(60, 10 * 60 * 1000);
  const aiLimited = rateLimiter(6, 60 * 60 * 1000);
  const packLimited = rateLimiter(12, 10 * 60 * 1000);
  let packBusy = false;

  const getTx = (id) => {
    const r = db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(id);
    if (!r) throw notFound('no such transaction');
    return withLogos(db, [txView(r)])[0];
  };

  // The filters the list and the CSV export share, as WHERE terms and their arguments.
  function txFilters(p) {
    const where = [];
    const args = [];
    const account = p.get('account');
    if (account) {
      if (!/^(acct_[A-Za-z0-9_]{1,64}|man_[a-f0-9]{16})$/.test(account)) throw bad('bad account id');
      where.push('t.account_id = ?');
      args.push(account);
    }
    if (p.has('category')) {
      if (p.get('category') === 'none') where.push('t.category_id IS NULL');
      else { where.push('t.category_id = ?'); args.push(intParam(p.get('category'), 'category')); }
    }
    for (const k of ['from', 'to']) if (p.has(k)) {
      if (!isIsoDate(p.get(k))) throw bad(`${k} must be YYYY-MM-DD`);
      where.push(`t.date ${k === 'from' ? '>=' : '<='} ?`);
      args.push(p.get(k));
    }
    if (p.has('business')) {
      if (!['0', '1'].includes(p.get('business'))) throw bad('business must be 0 or 1');
      where.push(`${BUSINESS} = ?`);
      args.push(Number(p.get('business')));
    }
    if (p.has('tax')) {
      if (!['0', '1'].includes(p.get('tax'))) throw bad('tax must be 0 or 1');
      where.push(`g.transaction_id IS ${p.get('tax') === '1' ? 'NOT ' : ''}NULL`);
    }
    if (p.has('direction')) {
      if (!['in', 'out'].includes(p.get('direction'))) throw bad('direction must be in or out');
      where.push(p.get('direction') === 'in' ? 't.amount > 0' : 't.amount < 0');
    }
    if (p.has('source')) {
      if (!['rule', 'ai', 'manual', 'provider'].includes(p.get('source'))) throw bad('source must be rule, ai, manual or provider');
      where.push('t.category_source = ?');
      args.push(p.get('source'));
    }
    const term = (p.get('q') ?? '').trim();
    if (term) {
      if (term.length > MAX_TERM) throw bad('search too long');
      where.push(txTermClause(term, args));
    }
    return { where, args };
  }

  function listTransactions(url) {
    const p = url.searchParams;
    const limit = p.has('limit') ? Number(p.get('limit')) : 60;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('limit must be 1 to 200');
    const { where, args } = txFilters(p);
    const cursor = p.get('cursor');
    if (cursor) {
      let date;
      let id;
      try { [date, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch {}
      if (!isIsoDate(date) || typeof id !== 'string') throw bad('bad cursor');
      where.push('(t.date < ? OR (t.date = ? AND t.id < ?))');
      args.push(date, date, id);
    }
    const rows = db.prepare(`${TX_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.date DESC, t.id DESC LIMIT ?`).all(...args, limit + 1);
    const more = rows.length > limit;
    const items = withLogos(db, rows.slice(0, limit).map(txView));
    const last = items.at(-1);
    return { items, next: more && last ? Buffer.from(JSON.stringify([last.date, last.id])).toString('base64url') : null };
  }

  // Every transaction the list's filters match, as a CSV the page saves as a file.
  const EXPORT_CAP = 50_000;
  const exportLimited = rateLimiter(30, 10 * 60 * 1000);
  function transactionsCsv(url) {
    const { where, args } = txFilters(url.searchParams);
    const rows = db.prepare(`${TX_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.date DESC, t.id DESC LIMIT ?`).all(...args, EXPORT_CAP + 1);
    const truncated = rows.length > EXPORT_CAP;
    const lines = [['Date', 'Description', 'Merchant', 'Account', 'Category', 'Amount', 'Status', 'Counts as', 'Transfer', 'ATO category', 'Deductible', 'Note'].join(',')];
    for (const r of rows.slice(0, EXPORT_CAP)) {
      lines.push([fmtDMY(r.date), (r.description ?? '').trim(), r.merchant, r.account_name, r.category ?? '', dollars(r.amount), r.status, r.business ? 'Business' : 'Personal',
        r.transfer_id ? r.transfer_kind : '', r.tax_category ?? '', dollars(r.tax_deductible), r.note ?? ''].map(cell).join(','));
    }
    return { text: `${lines.join('\r\n')}\r\n`, rows: Math.min(rows.length, EXPORT_CAP), truncated };
  }

  function searchEverything(url) {
    const r = searchAll(db, url.searchParams.get('q'));
    const ids = r.tx_ids;
    const rows = ids.length ? db.prepare(`${TX_SELECT} WHERE t.id IN (${ids.map(() => '?').join(',')}) ORDER BY t.date DESC, t.id DESC`).all(...ids) : [];
    const { tx_ids, tx_total, ...rest } = r;
    return { ...rest, transactions: { total: tx_total, items: withLogos(db, rows.map(txView)) } };
  }

  async function patchTransaction(req, id) {
    const body = await readJson(req);
    getTx(id);
    // Validate everything before writing anything, so a 400 never half-applies.
    if (!['category_id', 'is_business', 'note'].some((k) => k in body)) throw bad('nothing to change');
    if ('category_id' in body) {
      if (body.category_id !== null && !Number.isInteger(body.category_id)) throw bad('category_id must be a category id or null');
      if (body.category_id !== null && !db.prepare('SELECT 1 FROM categories WHERE id = ? AND archived = 0').get(body.category_id)) throw bad('no such category');
      if ('always' in body && typeof body.always !== 'boolean') throw bad('always must be true or false');
    }
    if ('is_business' in body && body.is_business !== null && typeof body.is_business !== 'boolean') throw bad('is_business must be true, false or null');
    const n = body.note;
    if ('note' in body && n !== null && (typeof n !== 'string' || n.length > 500)) throw bad('note must be up to 500 characters');
    let rule = null;
    let applied = 0;
    if ('category_id' in body) ({ rule, applied } = setCategory(db, id, { category_id: body.category_id, always: !!body.always }));
    if ('is_business' in body) setBusiness(db, id, body.is_business);
    if ('note' in body) db.prepare('UPDATE transactions SET note = ? WHERE id = ?').run(n?.trim() || null, id);
    // A manual category can turn a row into (or out of) a transfer candidate.
    if ('category_id' in body) engine.refresh();
    return { transaction: getTx(id), rule, applied };
  }

  // The same manual category and business flag on many rows in one go.
  async function bulkTransactions(req) {
    const b = await readJson(req);
    const ids = bulkEdit(db, b.ids, b);
    if ('category_id' in b) engine.refresh();
    return { updated: ids.length };
  }

  function sendCsv(res, name, text) {
    send(res, 200, text, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
  }

  // The accountant pack: built into a mode 600 temp file (so memory stays flat
  // and the length is known), streamed to the client, then the temp dir is
  // removed whether or not the download finished. One at a time.
  async function sendPack(req, res, fy) {
    if (packBusy) throw new HttpError(429, 'a pack is already being built, try again in a moment');
    if (packLimited('pack')) throw new HttpError(429, 'too many packs, try again in a few minutes');
    packBusy = true;
    const dir = mkdtempSync(join(tmpdir(), 'mint-pack-tmp-'));
    const file = join(dir, 'pack.zip');
    const ac = new AbortController();
    const onClose = () => { if (!res.writableFinished) ac.abort(); };
    res.on('close', onClose);
    try {
      const out = createWriteStream(file, { mode: 0o600 });
      out.on('error', () => {}); // surfaced through the write callbacks; a late open error must not crash the process
      let stats;
      try {
        stats = await buildPack({ db, fy, receiptsDir, out, estimate: packEstimate(taxReturnEstimate(db, { fy, today: perthDate() })), signal: ac.signal });
        out.end();
        await once(out, 'close');
      } catch (e) { out.destroy(); if (!out.closed) await once(out, 'close'); throw e; }
      res.writeHead(200, {
        ...SECURITY_HEADERS, 'Content-Type': 'application/zip', 'Content-Length': statSync(file).size, 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${packFileName(fy)}"`, 'X-Pack-Receipts': String(stats.receipts), 'X-Pack-Missing': String(stats.missing),
      });
      log(`accountant pack FY${fy}: ${stats.entries} files, ${stats.receipts} receipts, ${stats.missing} deductions without one, ${stats.bytes} bytes`);
      await new Promise((resolve) => pipeline(createReadStream(file), res, (err) => { if (err) log(`accountant pack FY${fy} not delivered: ${err.message}`); resolve(); }));
    } finally {
      res.off('close', onClose);
      rmSync(dir, { recursive: true, force: true });
      packBusy = false;
    }
  }


  // ----- manual accounts: writes fetch any exchange rates they need first, then run synchronously -----
  const importLimited = rateLimiter(40, 10 * 60 * 1000);
  const manualView = (id) => accountView(db.prepare(`SELECT a.*, (SELECT count(*) FROM transactions t WHERE t.account_id = a.id) tx_count, 0 pending_count
    FROM accounts a WHERE a.id = ?`).get(id), fx.status);
  // After a manual write: rules, transfers and the money pass as after a sync, the model pass in the background.
  const afterManual = () => { engine.refresh(); engine.runAi?.(); };
  const currencyOf = (id) => getManual(db, id).currency;
  async function rates(currency, dates) {
    if (currency === 'AUD' || !dates.length) return;
    const r = await fx.ensure(currency, dates);
    if (r.error) log(`manual: no fresh ${currency} rates (${r.error}), using what is cached`);
  }
  // The CSV as text: base64 of the file's bytes (decoded strictly here), or text the page already read.
  const csvText = (b) => {
    if (typeof b.base64 === 'string') return decodeCsv(Buffer.from(b.base64, 'base64'));
    if (typeof b.text === 'string') return decodeCsv(b.text);
    throw bad('send the file as base64 (or text)');
  };

  async function manualRoutes(req, res, path, method) {
    let m;
    const today = perthDate();
    if (path === '/api/fx/currencies' && method === 'GET') return send(res, 200, await fx.currencies()), true;
    if (path === '/api/fx/status' && method === 'GET') return send(res, 200, fx.status(await fx.checkCurrency(new URL(req.url, 'http://x').searchParams.get('currency')))), true;
    if (path === '/api/manual/accounts' && method === 'POST') {
      const b = await readJson(req);
      const currency = await fx.checkCurrency(b.currency);
      await rates(currency, [typeof b.opening_date === 'string' ? b.opening_date : today, today]);
      const a = createManualAccount(db, { ...b, currency }, { today });
      afterManual();
      log(`manual account ${a.id} added (${currency})`);
      return send(res, 201, manualView(a.id)), true;
    }
    if ((m = /^\/api\/manual\/accounts\/([A-Za-z0-9_]{1,80})$/.exec(path))) {
      const id = m[1];
      if (method === 'GET') return send(res, 200, { account: (getManual(db, id), manualView(id)), summary: manualSummary(db, id), imports: listImports(db, id) }), true;
      if (method === 'PATCH') {
        const b = await readJson(req);
        const own = ['nickname', 'hidden', 'is_business', 'spendable'].filter((k) => k in b);
        const rest = Object.fromEntries(Object.entries(b).filter(([k]) => !own.includes(k)));
        if (typeof rest.opening_date === 'string') await rates(currencyOf(id), [rest.opening_date]);
        if (Object.keys(rest).length) updateManualAccount(db, id, rest, { today });
        else getManual(db, id);
        if (own.length) updateAccount(db, id, Object.fromEntries(own.map((k) => [k, b[k]])));
        afterManual();
        log(`manual account ${id} updated: ${Object.keys(b).join(', ')}`);
        return send(res, 200, manualView(id)), true;
      }
      if (method === 'DELETE') {
        const r = deleteManualAccount(db, id);
        afterManual();
        log(`manual account ${id} deleted with ${r.transactions} transactions`);
        return send(res, 200, r), true;
      }
    }
    if ((m = /^\/api\/manual\/accounts\/([A-Za-z0-9_]{1,80})\/(transactions|balance|import|imports)$/.exec(path))) {
      const [, id, what] = m;
      if (what === 'imports' && method === 'GET') return send(res, 200, { items: (getManual(db, id), listImports(db, id)) }), true;
      if (method !== 'POST') return false;
      if (what === 'transactions') {
        const b = await readJson(req);
        if (typeof b.date === 'string') await rates(currencyOf(id), [b.date]);
        const t = addManualTransaction(db, id, b, { today });
        afterManual();
        return send(res, 201, getTx(t.id)), true;
      }
      if (what === 'balance') {
        const b = await readJson(req);
        await rates(currencyOf(id), [typeof b.date === 'string' ? b.date : today]);
        const t = setManualBalance(db, id, b, { today });
        afterManual();
        return send(res, 201, { transaction: getTx(t.id), account: manualView(id) }), true;
      }
      if (what === 'import') {
        if (importLimited('import')) throw new HttpError(429, 'too many imports, try again in a few minutes');
        const b = await readJson(req, 4 * 1024 * 1024);
        const body = { ...b, text: csvText(b) };
        const need = importDates(db, id, body, { today });
        await rates(need.currency, need.dates);
        if (b.dry_run === true) return send(res, 200, previewImport(db, id, body, { today })), true;
        const r = runImport(db, id, body, { today });
        if (r.imported) afterManual();
        log(`manual import into ${id}: ${r.imported} added, ${r.duplicates} already there, ${r.failed} failed`);
        return send(res, 200, { ...r, account: manualView(id) }), true;
      }
    }
    if ((m = /^\/api\/manual\/imports\/(\d{1,12})$/.exec(path)) && method === 'DELETE') {
      const r = undoImport(db, Number(m[1]), { today });
      afterManual();
      log(`manual import ${m[1]} undone, ${r.removed} rows removed`);
      return send(res, 200, { ...r, account: manualView(r.account_id) }), true;
    }
    if ((m = new RegExp(`^/api/manual/transactions/${TX_ID}$`).exec(path))) {
      if (method === 'PATCH') {
        const b = await readJson(req);
        const t = db.prepare('SELECT t.account_id, t.date, a.currency FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?').get(m[1]);
        if (t && ('date' in b || 'amount' in b)) await rates(t.currency, [typeof b.date === 'string' ? b.date : t.date]);
        updateManualTransaction(db, m[1], b, { today });
        afterManual();
        return send(res, 200, getTx(m[1])), true;
      }
      if (method === 'DELETE') {
        const r = deleteManualTransaction(db, m[1], { today });
        afterManual();
        return send(res, 200, r), true;
      }
    }
    return false;
  }

  return async function handle(req, res, url) {
    const { pathname: path } = url;
    const method = req.method;
    let m;

    // ----- merchant logos: the cached image, and the owner's own domain for a merchant -----
    if ((m = /^\/api\/logo\/([^/]{1,300})$/.exec(path))) {
      let key = null;
      try { key = decodeURIComponent(m[1]); } catch {}
      if (!validLogoKey(key)) throw notFound('no such logo');
      if (method === 'GET' || method === 'HEAD') {
        const l = getLogo(db, key);
        if (!l) throw notFound('no such logo');
        const headers = {
          'Content-Type': l.type, ETag: l.etag, 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'; sandbox",
        };
        if (req.headers['if-none-match'] === l.etag) return send(res, 304, '', headers), true;
        return send(res, 200, l.body, headers), true;
      }
      if (method === 'PUT') {
        if (!logos) throw new HttpError(503, 'logos are not set up');
        const b = await readJson(req);
        if (!('domain' in b) || (b.domain !== null && typeof b.domain !== 'string')) throw bad('domain must be a domain, or null to clear the logo');
        if (typeof b.domain === 'string' && b.domain.length > 300) throw bad('domain is too long');
        const out = await logos.setManual(key, b.domain);
        log(`logo ${key}: ${out.domain ? `set to ${out.domain}` : 'cleared'}`);
        return send(res, 200, out), true;
      }
    }

    if ((path.startsWith('/api/manual/') || path.startsWith('/api/fx/')) && await manualRoutes(req, res, path, method)) return true;

    // ----- transactions -----
    if (path === '/api/transactions' && method === 'GET') return send(res, 200, listTransactions(url)), true;
    if (path === '/api/transactions/export.csv' && method === 'GET') {
      if (exportLimited('export')) throw new HttpError(429, 'too many exports, try again in a few minutes');
      const out = transactionsCsv(url);
      log(`transactions export: ${out.rows} rows${out.truncated ? ' (capped)' : ''}`);
      return send(res, 200, out.text, {
        'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="mint-transactions-${perthDate()}.csv"`,
        'X-Export-Rows': String(out.rows), 'X-Export-Truncated': out.truncated ? '1' : '0',
        'Access-Control-Expose-Headers': 'X-Export-Rows, X-Export-Truncated, Content-Disposition',
      }), true;
    }
    if (path === '/api/search' && method === 'GET') return send(res, 200, searchEverything(url)), true;
    if (path === '/api/insights/cycle' && method === 'GET') return send(res, 200, cycleInsights(db, { today: perthDate() })), true;

    // ----- saved views on Transactions -----
    if (path === '/api/views' && method === 'GET') return send(res, 200, { items: listViews(db) }), true;
    if (path === '/api/views' && method === 'POST') return send(res, 201, createView(db, await readJson(req))), true;
    if ((m = /^\/api\/views\/([a-z0-9]{6,32})$/.exec(path))) {
      if (method === 'PATCH') return send(res, 200, updateView(db, m[1], await readJson(req))), true;
      if (method === 'DELETE') return send(res, 200, deleteView(db, m[1])), true;
    }
    if (path === '/api/transactions/bulk' && method === 'POST') return send(res, 200, await bulkTransactions(req)), true;
    if ((m = new RegExp(`^/api/transactions/${TX_ID}$`).exec(path))) {
      if (method === 'GET') {
        const transaction = getTx(m[1]);
        return send(res, 200, { transaction, receipts: listReceipts(db, m[1]), logo_info: logoInfo(db, transaction.merchant) }), true;
      }
      if (method === 'PATCH') return send(res, 200, await patchTransaction(req, m[1])), true;
    }
    if ((m = new RegExp(`^/api/transactions/${TX_ID}/tax$`).exec(path))) {
      if (method === 'PUT') {
        const b = await readJson(req);
        return send(res, 200, setTaxTag(db, m[1], { ato_category: b.ato_category, deductible_amount: b.deductible_amount ?? null, note: b.note ?? null })), true;
      }
      if (method === 'DELETE') return send(res, 200, clearTaxTag(db, m[1])), true;
    }
    if ((m = new RegExp(`^/api/transactions/${TX_ID}/receipts$`).exec(path)) && method === 'POST') {
      if (uploadLimited('receipts')) throw new HttpError(429, 'too many uploads, try again in a few minutes');
      getTx(m[1]);
      const buf = await readRaw(req, RECEIPT_MAX_BYTES + 1);
      const r = saveReceipt({ db, dir: receiptsDir, transactionId: m[1], buf, declaredType: req.headers['content-type'] });
      log(`receipt ${r.id} saved for ${m[1]} (${r.mime}, ${r.bytes} bytes)`);
      return send(res, 201, r), true;
    }
    if ((m = /^\/api\/receipts\/(\d{1,12})$/.exec(path))) {
      const id = Number(m[1]);
      if (method === 'GET') {
        const r = getReceipt({ db, dir: receiptsDir, id });
        const stream = createReadStream(r.path);
        await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', () => reject(notFound('receipt file missing'))); });
        res.writeHead(200, {
          ...SECURITY_HEADERS, 'Content-Type': r.mime, 'Content-Length': r.bytes, 'Cache-Control': 'private, no-cache', // revalidated, so a lock (423) also stops a cached copy
          'Content-Disposition': `${r.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="receipt-${r.id}.${r.file.split('.').pop()}"`,
          'Content-Security-Policy': "default-src 'none'; sandbox",
        });
        pipeline(stream, res, () => {});
        return true;
      }
      if (method === 'DELETE') return send(res, 200, deleteReceipt({ db, dir: receiptsDir, id })), true;
    }

    // ----- categories and rules -----
    if (path === '/api/categories' && method === 'GET') return send(res, 200, { items: listCategories(db, { includeArchived: url.searchParams.get('all') === '1' }) }), true;
    if (path === '/api/categories' && method === 'POST') {
      const b = await readJson(req);
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name || name.length > 40) throw bad('name must be 1 to 40 characters');
      if (!['expense', 'income', 'transfer'].includes(b.kind ?? 'expense')) throw bad('kind must be expense, income or transfer');
      if (b.group != null && (typeof b.group !== 'string' || b.group.length > 40)) throw bad('group must be up to 40 characters');
      if (db.prepare('SELECT 1 FROM categories WHERE lower(name) = lower(?)').get(name)) throw new HttpError(409, 'a category with that name exists');
      const { lastInsertRowid } = db.prepare('INSERT INTO categories (name, grp, kind, sort) VALUES (?, ?, ?, (SELECT COALESCE(max(sort), 0) + 1 FROM categories))')
        .run(name, b.group?.trim() || 'Other', b.kind ?? 'expense');
      return send(res, 201, db.prepare('SELECT id, name, grp, kind, color, sort, archived FROM categories WHERE id = ?').get(lastInsertRowid)), true;
    }
    if ((m = /^\/api\/categories\/(\d{1,9})$/.exec(path)) && method === 'PATCH') {
      const id = Number(m[1]);
      if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw notFound('no such category');
      const b = await readJson(req);
      const sets = [];
      const args = [];
      if ('name' in b) {
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (!name || name.length > 40) throw bad('name must be 1 to 40 characters');
        if (db.prepare('SELECT 1 FROM categories WHERE lower(name) = lower(?) AND id != ?').get(name, id)) throw new HttpError(409, 'a category with that name exists');
        sets.push('name = ?'); args.push(name);
      }
      if ('group' in b) {
        if (typeof b.group !== 'string' || !b.group.trim() || b.group.length > 40) throw bad('group must be 1 to 40 characters');
        sets.push('grp = ?'); args.push(b.group.trim());
      }
      if ('archived' in b) {
        if (typeof b.archived !== 'boolean') throw bad('archived must be true or false');
        sets.push('archived = ?'); args.push(b.archived ? 1 : 0);
      }
      if (!sets.length) throw bad('nothing to change');
      db.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      return send(res, 200, db.prepare('SELECT id, name, grp, kind, color, sort, archived FROM categories WHERE id = ?').get(id)), true;
    }
    if (path === '/api/rules' && method === 'GET') return send(res, 200, { items: listRules(db) }), true;
    if (path === '/api/rules' && method === 'POST') {
      const r = createRule(db, await readJson(req));
      engine.refresh();
      log(`rule ${r.rule.id} created, ${r.applied} transactions`);
      return send(res, 201, r), true;
    }
    if (path === '/api/rules/preview' && method === 'POST') return send(res, 200, previewRule(db, await readJson(req))), true;
    if ((m = /^\/api\/rules\/(\d{1,9})$/.exec(path))) {
      const id = Number(m[1]);
      if (method === 'PATCH') { const r = updateRule(db, id, await readJson(req)); engine.refresh(); return send(res, 200, r), true; }
      if (method === 'DELETE') { const r = deleteRule(db, id); engine.refresh(); log(`rule ${id} deleted`); return send(res, 200, r), true; }
    }
    if (path === '/api/categorise/status' && method === 'GET') return send(res, 200, ai.status()), true;
    if (path === '/api/categorise/run' && method === 'POST') {
      if (aiLimited('ai')) throw new HttpError(429, 'the model pass already ran several times this hour');
      engine.runAi({ force: true });
      return send(res, 202, ai.status()), true;
    }

    // ----- transfers -----
    if (path === '/api/transfers' && method === 'GET') return send(res, 200, { items: listTransfers(db, { status: url.searchParams.get('status') || null }) }), true;
    if (path === '/api/transfers' && method === 'POST') {
      const b = await readJson(req);
      const t = linkTransfer(db, b.out_tx, b.in_tx);
      return send(res, 201, t), true;
    }
    if ((m = /^\/api\/transfers\/(\d{1,12})(?:\/(confirm|reject))?$/.exec(path))) {
      const id = Number(m[1]);
      if (method === 'POST' && m[2] === 'confirm') return send(res, 200, confirmTransfer(db, id)), true;
      if (method === 'POST' && m[2] === 'reject') { const r = rejectTransfer(db, id); engine.refresh(); return send(res, 200, r), true; }
      if (method === 'PATCH' && !m[2]) {
        const b = await readJson(req);
        return send(res, 200, setSplit(db, id, { principal: b.principal ?? null, interest: b.interest ?? null })), true;
      }
    }

    // ----- recurring, budgets -----
    if (path === '/api/recurring' && method === 'GET') return send(res, 200, { items: detectRecurring(db, perthDate()) }), true;
    // Budgets: the pay cycle by default (?cycle=YYYY-MM-DD picks the cycle
    // holding that date), ?month=YYYY-MM for the monthly roll-up, and the
    // calendar month while there is no pay cycle yet.
    if (path === '/api/budgets' && method === 'GET') {
      const p = url.searchParams;
      const today = perthDate();
      const opts = { includeBusiness: p.get('include_business') === '1', today };
      if (!p.get('month')) {
        const cycle = p.get('cycle') ? cycleAt(db, p.get('cycle'), { today }) : currentCycle(db, { today });
        if (p.get('cycle') && !cycle) throw notFound('no pay cycle holds that date');
        if (cycle) return send(res, 200, cycleBudgetProgress(db, cycle, opts)), true;
      }
      return send(res, 200, budgetProgress(db, p.get('month') || today.slice(0, 7), opts)), true;
    }
    if (path === '/api/budgets/starter' && method === 'POST') {
      const b = await readJson(req);
      const r = generateStarterBudgets(db, { today: perthDate(), dryRun: b.dry_run === true, replace: b.replace ?? null });
      if (b.dry_run !== true && r.created.length) { engine.refresh(); log(`starter budgets: ${r.created.length} ${b.replace ? 'regenerated' : 'created'}`); }
      return send(res, 200, r), true;
    }
    // The transactions behind one budget row: ?cycle=YYYY-MM-DD (the cycle holding that date, the
    // current one by default) or ?month=YYYY-MM, with the same rows the budget's spent figure counts.
    if ((m = /^\/api\/budgets\/(\d{1,9})\/transactions$/.exec(path)) && method === 'GET') {
      const p = url.searchParams;
      const today = perthDate();
      const id = Number(m[1]);
      if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw notFound('no such category');
      if (p.get('month') && p.get('cycle')) throw bad('give a cycle or a month, not both');
      const includeBusiness = p.get('include_business') === '1';
      let cycle = null;
      if (!p.get('month')) {
        cycle = p.get('cycle') ? cycleAt(db, p.get('cycle'), { today }) : currentCycle(db, { today });
        if (p.get('cycle') && !cycle) throw notFound('no pay cycle holds that date');
      }
      const r = categoryTransactions(db, id, { cycle, month: cycle ? null : (p.get('month') || today.slice(0, 7)), includeBusiness, today });
      const { ids, ...head } = r;
      const rows = ids.length ? db.prepare(`${TX_SELECT} WHERE t.id IN (${ids.map(() => '?').join(',')}) ORDER BY t.date DESC, t.id DESC`).all(...ids) : [];
      return send(res, 200, { ...head, items: withLogos(db, rows.map(txView)) }), true;
    }
    if ((m = /^\/api\/budgets\/(\d{1,9})$/.exec(path))) {
      const id = Number(m[1]);
      if (method === 'PUT') {
        const b = await readJson(req);
        // source is for undo only: putting a regenerated starter budget back as it was.
        if (b.source != null && b.source !== 'manual' && b.source !== 'starter') throw bad("source must be 'manual' or 'starter'");
        const r = setBudget(db, id, { cycle_target: b.cycle_target, monthly_target: b.monthly_target, rollover: b.rollover, fixed: b.fixed }, { source: b.source ?? 'manual' });
        engine.refresh();
        return send(res, 200, { ...r, rollover: !!r.rollover, fixed: !!r.fixed }), true;
      }
      if (method === 'DELETE') return send(res, 200, deleteBudget(db, id)), true;
    }

    // ----- subscriptions: detected ones with the owner's states, plus the ones he adds by hand -----
    if (path === '/api/subscriptions' && method === 'GET') {
      const l = listSubscriptions(db, perthDate());
      for (const g of ['active', 'cancelled', 'stopped', 'dismissed', 'maybe']) l[g] = withLogos(db, l[g], 'name');
      return send(res, 200, l), true;
    }
    if (path === '/api/subscriptions' && method === 'POST') return send(res, 201, addSubscription(db, await readJson(req), { today: perthDate() })), true;
    if ((m = /^\/api\/subscriptions\/detected\/([^/]{1,200})$/.exec(path))) {
      let key = null;
      try { key = decodeURIComponent(m[1]); } catch {}
      if (key == null) throw bad('bad merchant key');
      if (method === 'PUT') return send(res, 200, setDetectedState(db, key, await readJson(req), { today: perthDate() })), true;
      if (method === 'DELETE') return send(res, 200, clearDetectedState(db, key)), true;
    }
    if ((m = /^\/api\/subscriptions\/(\d{1,9})$/.exec(path))) {
      const id = Number(m[1]);
      if (method === 'PATCH') return send(res, 200, updateSubscription(db, id, await readJson(req), { today: perthDate() })), true;
      if (method === 'DELETE') return send(res, 200, deleteSubscription(db, id)), true;
    }

    // ----- v2: pay cycles, income, bills, safe to spend, the pay split, goals, debt -----
    if (path === '/api/cycles' && method === 'GET') {
      const today = perthDate();
      return send(res, 200, { items: listCycles(db, { today }), current: currentCycle(db, { today }) }), true;
    }
    if (path === '/api/cycles/current' && method === 'GET') return send(res, 200, { cycle: currentCycle(db, { today: perthDate() }) }), true;
    if (path === '/api/cycles/at' && method === 'GET') return send(res, 200, { cycle: cycleAt(db, url.searchParams.get('date'), { today: perthDate() }) }), true;
    if (path === '/api/income' && method === 'GET') {
      const p = url.searchParams;
      return send(res, 200, incomeReport(db, { today: perthDate(), cycles: p.has('cycles') ? Number(p.get('cycles')) : undefined, months: p.has('months') ? Number(p.get('months')) : undefined })), true;
    }
    if (path === '/api/income/fy' && method === 'GET') return send(res, 200, incomeByFy(db, { today: perthDate() })), true;
    if ((m = /^\/api\/income\/assessments\/(\d{4})$/.exec(path))) {
      const fy = Number(m[1]);
      if (method === 'PUT') { const r = setAssessment(db, fy, await readJson(req)); log(`NoA FY${fy} saved`); return send(res, 200, r), true; }
      if (method === 'DELETE') { const r = deleteAssessment(db, fy); log(`NoA FY${fy} removed`); return send(res, 200, r), true; }
    }
    if (path === '/api/income/sources' && method === 'GET') return send(res, 200, { items: listSources(db) }), true;
    if (path === '/api/income/sources/preview' && method === 'POST') {
      const b = await readJson(req);
      const { id = null, ...fields } = b ?? {};
      return send(res, 200, previewSource(db, fields, { id, today: perthDate() })), true;
    }
    if (path === '/api/income/sources' && method === 'POST') {
      const r = createSource(db, await readJson(req));
      engine.refresh();
      return send(res, 201, r), true;
    }
    if ((m = /^\/api\/income\/sources\/(\d{1,9})$/.exec(path))) {
      const id = Number(m[1]);
      if (method === 'PATCH') { const r = updateSource(db, id, await readJson(req)); engine.refresh(); return send(res, 200, r), true; }
      if (method === 'DELETE') { const r = deleteSource(db, id); engine.refresh(); return send(res, 200, r), true; }
    }
    if ((m = new RegExp(`^/api/income/transactions/${TX_ID}$`).exec(path)) && method === 'PATCH') {
      const r = setTransactionIncome(db, m[1], await readJson(req));
      engine.refresh();
      return send(res, 200, r), true;
    }
    if (path === '/api/bills' && method === 'GET') {
      const days = url.searchParams.has('days') ? Number(url.searchParams.get('days')) : undefined;
      return send(res, 200, billsCalendar(db, { today: perthDate(), days })), true;
    }
    if (path === '/api/safe-to-spend' && method === 'GET') return send(res, 200, safeToSpend(db, { today: perthDate() })), true;
    if (path === '/api/forecast' && method === 'GET') return send(res, 200, forecast(db, { today: perthDate() })), true;
    if (path === '/api/forecast/floor' && method === 'PUT') return send(res, 200, { floor: setFloor(db, (await readJson(req))?.floor) }), true;
    if (path === '/api/plan' && method === 'GET') return send(res, 200, getPlan(db, { today: perthDate() })), true;
    if (path === '/api/plan' && method === 'PUT') { const r = setPlan(db, await readJson(req)); log(`pay plan saved, ${r.lines.length} lines`); return send(res, 200, r), true; }
    if (path === '/api/plan/suggest' && method === 'GET') return send(res, 200, suggestPlan(db, { today: perthDate() })), true;
    if (path === '/api/plan/status' && method === 'GET') return send(res, 200, splitStatus(db, { today: perthDate() })), true;
    if (path === '/api/goals' && method === 'GET') return send(res, 200, { items: listGoals(db, { today: perthDate(), includeArchived: url.searchParams.get('all') === '1' }) }), true;
    if (path === '/api/goals' && method === 'POST') return send(res, 201, createGoal(db, await readJson(req))), true;
    if ((m = /^\/api\/goals\/(\d{1,9})$/.exec(path))) {
      const id = Number(m[1]);
      if (method === 'PATCH') return send(res, 200, updateGoal(db, id, await readJson(req))), true;
      if (method === 'DELETE') return send(res, 200, deleteGoal(db, id)), true;
    }
    if ((m = /^\/api\/goals\/(\d{1,9})\/contributions(?:\/(\d{1,12}))?$/.exec(path))) {
      const id = Number(m[1]);
      if (!m[2] && method === 'GET') return send(res, 200, { items: listContributions(db, id) }), true;
      if (!m[2] && method === 'POST') {
        const b = await readJson(req);
        return send(res, 201, addContribution(db, id, { date: b.date ?? perthDate(), amount: b.amount, note: b.note ?? null })), true;
      }
      if (m[2] && method === 'DELETE') return send(res, 200, deleteContribution(db, id, Number(m[2]))), true;
    }
    if (path === '/api/owed' && method === 'GET') return send(res, 200, listOwed(db, { today: perthDate(), includeArchived: url.searchParams.get('all') === '1' })), true;
    if (path === '/api/owed' && method === 'POST') return send(res, 201, createOwed(db, await readJson(req), { today: perthDate() })), true;
    if ((m = /^\/api\/owed\/(\d{1,9})$/.exec(path))) {
      const id = Number(m[1]);
      if (method === 'GET') return send(res, 200, getOwed(db, id, { today: perthDate() })), true;
      if (method === 'PATCH') return send(res, 200, updateOwed(db, id, await readJson(req), { today: perthDate() })), true;
      if (method === 'DELETE') return send(res, 200, deleteOwed(db, id)), true;
    }
    if ((m = /^\/api\/owed\/(\d{1,9})\/payments(?:\/(\d{1,12}))?$/.exec(path))) {
      const id = Number(m[1]);
      if (!m[2] && method === 'POST') return send(res, 201, addOwedPayment(db, id, await readJson(req), { today: perthDate() })), true;
      if (m[2] && method === 'DELETE') return send(res, 200, deleteOwedPayment(db, id, Number(m[2]))), true;
    }
    if (path === '/api/debt' && method === 'GET') {
      const p = url.searchParams;
      return send(res, 200, debtReport(db, { today: perthDate(), extra: p.get('extra'), by: p.get('card_by'), perCycle: p.get('card_per_cycle') })), true;
    }

    // ----- Save and Invest: savings, super, home loan -----
    if (path === '/api/savings' && method === 'GET') return send(res, 200, savingsOverview(db, { today: perthDate() })), true;
    if (path === '/api/super' && method === 'GET') return send(res, 200, superOverview(db, { today: perthDate() })), true;
    if (path === '/api/homeloan' && method === 'GET') return send(res, 200, homeLoan(db, { today: perthDate(), extraMonth: url.searchParams.get('extra_month') })), true;
    if ((m = /^\/api\/homeloan\/(acct_[A-Za-z0-9_]{1,64}|man_[a-f0-9]{16})\/inputs$/.exec(path)) && method === 'PUT') return send(res, 200, setLoanInputs(db, m[1], await readJson(req))), true;

    // ----- Save and Invest: shares and ETFs -----
    if (path === '/api/holdings' && method === 'GET') {
      const prices = quotes.status();
      return send(res, 200, { ...portfolio(db, { cap: prices.cap, budgeted: prices.budgeted_exchanges }), history: portfolioHistory(db), prices, footer: SHARES_FOOTER }), true;
    }
    if (path === '/api/holdings' && method === 'POST') {
      const h = createHolding(db, await readJson(req));
      snapshotPortfolio(db, { cap: quotes.status().cap });
      log(`holding ${h.ticker}.${h.exchange} added`);
      return send(res, 201, h), true;
    }
    if (path === '/api/holdings/refresh' && method === 'POST') {
      const r = await quotes.refresh({ force: true });
      const prices = quotes.status();
      snapshotPortfolio(db, { cap: prices.cap });
      return send(res, 200, { ...r, prices }), true;
    }
    if (path === '/api/holdings/restore' && method === 'POST') {
      const h = restoreHolding(db, (await readJson(req)).record);
      snapshotPortfolio(db, { cap: quotes.status().cap });
      return send(res, 201, h), true;
    }
    if ((m = /^\/api\/holdings\/(\d{1,9})(?:\/lots(?:\/(\d{1,9}))?)?$/.exec(path))) {
      const id = Number(m[1]);
      const lots = path.includes('/lots');
      const snap = () => snapshotPortfolio(db, { cap: quotes.status().cap });
      if (!lots && method === 'PATCH') { const h = updateHolding(db, id, await readJson(req)); snap(); return send(res, 200, h), true; }
      if (!lots && method === 'DELETE') { const r = deleteHolding(db, id); snap(); log(`holding ${r.record.ticker}.${r.record.exchange} deleted`); return send(res, 200, r), true; }
      if (lots && !m[2] && method === 'POST') { const l = addLot(db, id, await readJson(req)); snap(); return send(res, 201, l), true; }
      if (lots && m[2] && method === 'PATCH') { const l = updateLot(db, id, Number(m[2]), await readJson(req)); snap(); return send(res, 200, l), true; }
      if (lots && m[2] && method === 'DELETE') { const r = deleteLot(db, id, Number(m[2])); snap(); return send(res, 200, r), true; }
    }
    if ((m = /^\/api\/assets\/(\d{1,9})\/shares-decision$/.exec(path)) && method === 'POST') {
      const r = decideShares(db, Number(m[1]), (await readJson(req)).decision);
      log(`manual shares asset ${r.asset_id}: ${r.decision}`);
      return send(res, 200, r), true;
    }

    // ----- tax and business -----
    if (path === '/api/tax/categories' && method === 'GET') return send(res, 200, { items: ATO_CATEGORIES }), true;
    if ((path === '/api/tax/summary' || path === '/api/tax/export.csv') && method === 'GET') {
      const raw = url.searchParams.get('fy');
      const fy = raw == null ? fyOf(perthDate()) : Number(raw);
      if (!/^\d{4}$/.test(String(fy))) throw bad('fy must be the year the financial year ends, e.g. 2026');
      if (path === '/api/tax/summary') return send(res, 200, fySummary(db, fy)), true;
      return sendCsv(res, `mint-fy${fy}.csv`, fyCsv(db, fy)), true;
    }

    // The refund-or-owing estimate and the figures it asks the owner for (lib/taxestimate.mjs).
    if (path === '/api/tax/estimate' && method === 'GET') {
      const raw = url.searchParams.get('fy');
      const fy = raw == null ? fyOf(perthDate()) : Number(raw);
      if (!/^\d{4}$/.test(String(fy))) throw bad('fy must be the year the financial year ends, e.g. 2026');
      return send(res, 200, taxReturnEstimate(db, { fy, today: perthDate() })), true;
    }
    if (path === '/api/tax/estimate/inputs' && method === 'PUT') {
      const { fy: raw, ...body } = await readJson(req);
      const fy = raw == null ? fyOf(perthDate()) : raw;
      if (!Number.isInteger(fy)) throw bad('fy must be the year the financial year ends, e.g. 2026');
      const r = setTaxInputs(db, fy, body);
      log(`tax estimate inputs FY${fy}: ${Object.keys(body).join(', ')}`);
      return send(res, 200, { ...r, estimate: taxReturnEstimate(db, { fy, today: perthDate() }) }), true;
    }

    if (path === '/api/tax/pack' && method === 'GET') {
      const raw = url.searchParams.get('fy');
      const fy = raw == null ? fyOf(perthDate()) : Number(raw);
      if (!/^\d{4}$/.test(String(fy))) throw bad('fy must be the year the financial year ends, e.g. 2026');
      await sendPack(req, res, fy);
      return true;
    }

    if (path === '/api/tax/deductions' && method === 'GET') {
      const raw = url.searchParams.get('fy');
      const fy = raw == null ? fyOf(perthDate()) : Number(raw);
      if (!/^\d{4}$/.test(String(fy))) throw bad('fy must be the year the financial year ends, e.g. 2026');
      return send(res, 200, { fy, items: fyDeductions(db, fy) }), true;
    }

    // ----- reports and review counts -----
    if (path === '/api/reports/monthly' && method === 'GET') {
      const p = url.searchParams;
      const thisMonth = perthDate().slice(0, 7);
      return send(res, 200, monthlyReport(db, { from: p.get('from') ?? thisMonth, to: p.get('to') ?? thisMonth, includeBusiness: p.get('include_business') === '1' })), true;
    }
    if (path === '/api/reports/merchants' && method === 'GET') {
      const p = url.searchParams;
      return send(res, 200, topMerchants(db, { from: p.get('from'), to: p.get('to'), limit: p.has('limit') ? Number(p.get('limit')) : 10, includeBusiness: p.get('include_business') === '1' })), true;
    }
    if (path === '/api/review' && method === 'GET') return send(res, 200, reviewCounts(db, { today: perthDate() })), true;

    // ----- net worth and manual assets -----
    if (path === '/api/networth' && method === 'GET') return send(res, 200, netWorth(db)), true;
    if (path === '/api/networth/history' && method === 'GET') {
      return send(res, 200, { items: netWorthHistory(db, { from: url.searchParams.get('from'), to: url.searchParams.get('to') }) }), true;
    }
    // The order of the rows on Home: { ids: [account id | asset_<id> | holdings, ...] } in the order wanted.
    if (path === '/api/home/order' && method === 'PUT') return send(res, 200, setHomeOrder(db, (await readJson(req)).ids)), true;
    if (path === '/api/assets' && method === 'GET') return send(res, 200, { items: listAssets(db, { includeArchived: url.searchParams.get('all') === '1' }) }), true;
    if (path === '/api/assets' && method === 'POST') return send(res, 201, createAsset(db, await readJson(req))), true;
    if ((m = /^\/api\/assets\/(\d{1,9})(?:\/snapshots(?:\/(\d{4}-\d{2}-\d{2}))?)?$/.exec(path))) {
      const id = Number(m[1]);
      const snaps = path.includes('/snapshots');
      if (!snaps && method === 'PATCH') return send(res, 200, updateAsset(db, id, await readJson(req))), true;
      if (snaps && !m[2] && method === 'GET') return send(res, 200, { items: listSnapshots(db, id) }), true;
      if (snaps && !m[2] && method === 'POST') {
        const b = await readJson(req);
        return send(res, 200, addSnapshot(db, id, { date: b.date ?? perthDate(), value: b.value, note: b.note ?? null, contribution: b.contribution ?? null })), true;
      }
      if (snaps && m[2] && method === 'DELETE') return send(res, 200, deleteSnapshot(db, id, m[2])), true;
    }

    // ----- alerts -----
    if (path === '/api/alerts' && method === 'GET') return send(res, 200, { items: listAlerts(db, { includeDismissed: url.searchParams.get('all') === '1' }) }), true;
    if ((m = /^\/api\/alerts\/(\d{1,12})\/dismiss$/.exec(path)) && method === 'POST') return send(res, 200, dismissAlert(db, Number(m[1]))), true;
    if (path === '/api/summary/weekly' && method === 'GET') return send(res, 200, { line: weeklySummary(db, perthDate()) }), true;

    return false;
  };
}
