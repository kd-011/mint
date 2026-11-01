// Dry run of the engine over a copy of the live book. The v1 part prints
// counts and timings only. The v2 part (pay cycles, income, starter budgets,
// safe to spend, the split, the loan) prints dates and amounts but never
// transaction text, payer names or account numbers (digits are stripped from
// account names), so the output is safe to paste in a PR. The live database
// is opened read only and copied with VACUUM INTO; everything the engine
// writes lands in the throwaway copy.
//   node scripts/dry-run.mjs [--ai] [--db path/to/mint.db]
// --ai also runs the model pass (spends a little OpenRouter credit, capped by
// MINT_AI_DAILY_CAP, default 1500 merchants).
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.mjs';
import { seedCategories, seedLoanRules, seedMerchantRules } from '../lib/categories.mjs';
import { applyRules, createAi } from '../lib/categorise.mjs';
import { matchTransfers } from '../lib/transfers.mjs';
import { detectRecurring } from '../lib/recurring.mjs';
import { detectUnusual } from '../lib/unusual.mjs';
import { runAlerts } from '../lib/alerts.mjs';
import { rederiveMerchants, moneyPass } from '../lib/engine.mjs';
import { perthDate, fmtDMY } from '../lib/dates.mjs';
import { listCycles, currentCycle } from '../lib/cycles.mjs';
import { incomeReport } from '../lib/income.mjs';
import { safeToSpend } from '../lib/safe.mjs';
import { splitStatus } from '../lib/plan.mjs';
import { loanView, cardView } from '../lib/debt.mjs';
import { monthlyReport } from '../lib/reports.mjs';
import { listGoals } from '../lib/goals.mjs';
import { taxReturnEstimate } from '../lib/taxestimate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const useAi = args.includes('--ai');
const src = args.includes('--db') ? args[args.indexOf('--db') + 1] : join(process.env.MINT_HOME || ROOT, 'data', 'mint.db');
if (!existsSync(src)) { console.error(`no database at ${src}`); process.exit(1); }

const env = {};
const envFile = join(process.env.MINT_HOME || ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
}

const dir = mkdtempSync(join(tmpdir(), 'mint-dry-'));
const copy = join(dir, 'mint.db');
const live = new DatabaseSync(src, { readOnly: true });
live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
live.close();
const db = openDb(copy);
const today = perthDate();
const time = (label, fn) => { const t = Date.now(); const r = fn(); console.log(`${label.padEnd(34)} ${Date.now() - t} ms`); return r; };
const one = (sql, ...a) => db.prepare(sql).get(...a);
const $ = (c) => (c == null ? 'n/a' : `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const dmy = (d) => (d ? fmtDMY(d) : 'n/a');
const acctName = (n) => String(n ?? '').replace(/\s*\d{3,}/g, '').trim();

try {
  console.log(`transactions                       ${one('SELECT count(*) n FROM transactions').n}`);
  console.log(`accounts                           ${one("SELECT count(*) n FROM accounts WHERE status IS NOT 'gone'").n}`);
  time('seed categories', () => seedCategories(db));
  const re = time('re-derive merchants', () => rederiveMerchants(db));
  console.log(`  merchants re-derived             ${re}`);
  console.log(`  distinct merchants               ${one('SELECT count(DISTINCT merchant) n FROM transactions').n}`);
  const drawdownBefore = one("SELECT count(*) n FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.type = 'loan' AND t.description LIKE 'LOAN DRAWDOWN%'").n;
  const spendBefore = monthlyReport(db, { from: '2026-07', to: '2026-07' }).months[0].spent;
  console.log(`  loan drawdown rules made         ${time('loan drawdown rule', () => seedLoanRules(db))}`);
  const catBefore = new Map(db.prepare('SELECT id, category_id FROM transactions').all().map((r) => [r.id, r.category_id]));
  console.log(`  AU merchant rules made           ${time('AU merchant rules', () => seedMerchantRules(db))}`);
  time('rules + provider fallback', () => applyRules(db));
  console.log('  AU merchant rules: rows matched / moved (pattern and category only, no transaction text)');
  for (const r of db.prepare("SELECT r.id, r.pattern, c.name category FROM rules r JOIN categories c ON c.id = r.category_id WHERE r.source = 'seed' AND r.priority = 150 ORDER BY c.name, r.id").all()) {
    const rows = db.prepare('SELECT id, category_id FROM transactions WHERE rule_id = ?').all(r.id);
    console.log(`    ${r.category.padEnd(20)} ${r.pattern.padEnd(48)} ${String(rows.length).padStart(4)} / ${rows.filter((t) => t.category_id !== catBefore.get(t.id)).length}`);
  }
  const x = time('transfer matching', () => matchTransfers(db));
  console.log(`  pairs linked automatically       ${x.auto}`);
  console.log(`  pairs queued for review          ${x.review}`);
  for (const r of db.prepare("SELECT kind, status, count(*) n FROM transfers GROUP BY 1, 2 ORDER BY 1, 2").all()) {
    console.log(`    ${`${r.kind} ${r.status}`.padEnd(30)} ${r.n}`);
  }
  console.log(`  TRANSFER_* rows left unpaired    ${one(`SELECT count(*) n FROM transactions t WHERE t.provider_category LIKE 'TRANSFER%'
    AND NOT EXISTS (SELECT 1 FROM transfers x WHERE x.out_tx = t.id OR x.in_tx = t.id)`).n}`);
  // Matching can change which rows the model should see, so re-run rules once.
  applyRules(db);
  const drawdownMoved = one("SELECT count(*) n FROM transactions t JOIN categories c ON c.id = t.category_id WHERE c.name = 'Loan drawdown'").n;
  console.log(`  LOAN DRAWDOWN rows on loans      ${drawdownBefore} (now in Loan drawdown: ${drawdownMoved})`);
  console.log(`  July 2026 spend before / after   ${$(spendBefore)} / ${$(monthlyReport(db, { from: '2026-07', to: '2026-07' }).months[0].spent)}`);
  const money = time('income, starter budgets, plan, goals', () => moneyPass(db, { today }));

  if (useAi) {
    if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing from .env');
    const ai = createAi({
      db, key: env.OPENROUTER_API_KEY, model: env.MINT_AI_MODEL || 'google/gemini-3.1-flash-lite',
      dailyCap: Number(env.MINT_AI_DAILY_CAP) || 1500, today: () => `dry-${today}`, log: () => {},
    });
    console.log(`  merchants waiting for the model  ${ai.pending().length}`);
    const t = Date.now();
    const r = await ai.run();
    console.log(`model pass                         ${Date.now() - t} ms`);
    console.log(`  merchants sent                   ${r.merchants}`);
    console.log(`  calls                            ${r.calls}`);
    console.log(`  tokens in / out                  ${r.prompt_tokens} / ${r.completion_tokens}`);
    console.log(`  merchants answered               ${one('SELECT count(*) n FROM ai_cache WHERE category_id IS NOT NULL').n}`);
    console.log(`  merchants left as unknown        ${one('SELECT count(*) n FROM ai_cache WHERE category_id IS NULL').n}`);
    if (r.capped) console.log('  daily cap reached                yes');
    if (r.error) console.log(`  stopped early                    ${r.error.replace(/[^\w :.-]/g, '')}`);
  }

  console.log('categorised by source');
  for (const r of db.prepare("SELECT COALESCE(category_source, 'none') src, count(*) n FROM transactions GROUP BY 1 ORDER BY 2 DESC").all()) {
    console.log(`    ${r.src.padEnd(30)} ${r.n}`);
  }
  console.log(`  rows in a transfer category      ${one("SELECT count(*) n FROM transactions t JOIN categories c ON c.id = t.category_id WHERE c.kind = 'transfer'").n}`);

  const rec = time('recurring detection', () => detectRecurring(db, today));
  const active = rec.filter((r) => r.active);
  console.log(`  series found (active / lapsed)   ${active.length} / ${rec.length - active.length}`);
  console.log(`  active subscriptions / bills     ${active.filter((r) => r.kind === 'subscription').length} / ${active.filter((r) => r.kind === 'bill').length}`);
  for (const c of ['weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly']) {
    const n = active.filter((r) => r.cadence === c).length;
    if (n) console.log(`    ${c.padEnd(30)} ${n}`);
  }
  console.log(`  with a recent price rise         ${active.filter((r) => r.price_rise).length}`);
  console.log(`  new in the last 75 days          ${active.filter((r) => r.is_new).length}`);

  const un = time('unusual charges (last 14 days)', () => detectUnusual(db, today));
  console.log(`  new merchant over $200           ${un.filter((u) => u.reason === 'new_merchant').length}`);
  console.log(`  well above merchant norm         ${un.filter((u) => u.reason === 'above_norm').length}`);

  const alerts = time('alert pipeline', () => runAlerts(db, { now: new Date(), staleHours: 24 }));
  const byKind = {};
  for (const a of alerts) byKind[`${a.kind}:${a.type}`] = (byKind[`${a.kind}:${a.type}`] ?? 0) + 1;
  console.log(`  alerts that would be raised      ${alerts.length}`);
  for (const [k, n] of Object.entries(byKind).sort()) console.log(`    ${k.padEnd(30)} ${n}`);

  console.log('v2: pay cycles');
  const cycles = listCycles(db, { today });
  console.log(`  income streams                   ${one('SELECT count(*) n FROM income_sources').n} (${db.prepare('SELECT kind, count(*) n FROM income_sources GROUP BY 1 ORDER BY 1').all().map((r) => `${r.kind} ${r.n}`).join(', ')})`);
  for (const r of db.prepare('SELECT income_kind k, count(*) n FROM transactions WHERE income_kind IS NOT NULL GROUP BY 1 ORDER BY 1').all()) console.log(`    rows ${r.k.padEnd(25)} ${r.n}`);
  console.log(`  cycles found                     ${cycles.length}${cycles.length ? ` (first ${dmy(cycles[0].start)})` : ''}`);
  console.log(`  late pays in history             ${cycles.filter((c) => !c.open && c.late).length}`);
  const cur = currentCycle(db, { today });
  if (cur) console.log(`  current cycle                    ${dmy(cur.start)} to ${dmy(cur.end)}, day ${cur.day} of ${cur.days}, next payday ${dmy(cur.next_payday)}${cur.late ? `, LATE ${cur.days_late} days` : ''}`);
  const inc = incomeReport(db, { today, cycles: 4 });
  const label = new Map(inc.streams.map((s, i) => [s.id, s.kind === 'salary' ? 'salary' : `${s.kind} stream ${i + 1}`]));
  console.log(`  salary: median of last ${inc.salary.median_of ?? 0}          ${$(inc.salary.median)} (average ${$(inc.salary.average)}, sd ${$(inc.salary.stddev)}, min ${$(inc.salary.min)}, max ${$(inc.salary.max)})`);
  if (inc.next_payday) console.log(`  next payday expected             ${dmy(inc.next_payday.date)}, about ${$(inc.next_payday.expected_amount)}`);
  console.log('  income per stream, last 4 cycles');
  for (const c of inc.by_cycle) {
    const parts = Object.entries(c.by_source).map(([id, v]) => `${label.get(Number(id)) ?? `stream ${id}`} ${$(v)}`);
    console.log(`    ${dmy(c.start)}${c.open ? ' (open)' : ''}: income ${$(c.income)} [salary ${$(c.salary)}, regular ${$(c.regular)}]; reimbursed ${$(c.reimbursed)}; other in ${$(c.other_in)}${parts.length ? `; ${parts.join(', ')}` : ''}`);
  }
  if (inc.current) console.log(`  this cycle received / expected   ${$(inc.current.received.total)} / ${$(inc.current.expected.total)}`);
  const st = money.starter;
  if (st) {
    console.log(`  starter budgets created          ${st.created.length} from ${st.cycles_used} cycles (${dmy(st.from)} to ${dmy(st.to)}), total ${$(st.total_per_cycle)} a cycle${st.reason ? ` (${st.reason})` : ''}`);
    for (const c of st.created) console.log(`    ${c.name.padEnd(28)} ${$(c.cycle_target).padStart(10)} ${c.fixed ? 'fixed' : 'flexible'}`);
    console.log(`  categories skipped               ${st.skipped.length} (${[...new Set(st.skipped.map((x) => x.reason))].join(', ')})`);
  } else console.log(`  starter budgets                  not run (budgets already set up)`);
  const s = safeToSpend(db, { today });
  if (s.cycle) {
    console.log(`  safe to spend now                ${$(s.safe)} (${$(s.per_day)} a day for ${s.days_left} days)`);
    for (const b of s.breakdown) console.log(`    ${b.label.padEnd(36)} ${$(b.amount).padStart(12)}`);
    console.log(`  cash check                       spendable ${$(s.cash.spendable)} in ${s.cash.accounts.length} accounts, bills still due ${$(s.cash.bills_due)}, after ${$(s.cash.after_bills)}${s.cash.short ? ' SHORT' : ''}`);
  } else console.log(`  safe to spend                    ${s.reason}`);
  const sp = splitStatus(db, { today });
  console.log(`  pay split status                 ${sp.status}${sp.payday ? ` (payday ${dmy(sp.payday.date)} ${$(sp.payday.amount)})` : ''}`);
  for (const l of sp.lines) console.log(`    ${`${l.kind}: ${acctName(l.account)}`.padEnd(30)} planned ${$(l.planned)}, moved ${$(l.moved)}, ${l.status}`);
  if (sp.other_moves?.length) console.log(`    outside the plan: ${sp.other_moves.map((m) => `${acctName(m.account)} ${$(m.amount)}`).join(', ')}`);
  console.log(`  goals                            ${listGoals(db, { today }).map((g) => `${g.name} ${$(g.progress)}${g.target_amount ? ` of ${$(g.target_amount)}` : ' (no target)'}`).join('; ') || 'none'}`);
  for (const l of loanView(db, { today, extra: 20000 })) {
    console.log(`  loan                             balance ${$(l.balance)} at ${l.rate == null ? 'rate unknown' : `${(l.rate * 100).toFixed(2)}%`}, offset ${$(l.offset.balance)}, repayment ${$(l.repayment.amount)} ${l.repayment.frequency} (${l.repayment.basis ?? 'none seen'}, ${l.repayment.type ?? 'type unknown'})`);
    console.log(`    interest a year with / without offset  ${$(l.interest.per_year.with_offset)} / ${$(l.interest.per_year.without_offset)}; a cycle ${$(l.interest.per_cycle.with_offset)}`);
    console.log(`    payoff at current repayment            ${l.payoff.date ? `${dmy(l.payoff.date)} (${l.payoff.months} months)` : l.payoff.reason}`);
    if (l.payoff.principal_and_interest) console.log(`    P&I to term                            ${$(l.payoff.principal_and_interest.repayment_per_month)} a month, clears ${dmy(l.payoff.principal_and_interest.date)}, interest ${$(l.payoff.principal_and_interest.interest)}`);
    if (l.extra) console.log(`    with $200 extra a cycle                clears ${dmy(l.extra.payoff_date)}, ${l.extra.months_sooner ?? 'n/a'} months sooner, saves ${$(l.extra.interest_saved)}`);
  }
  for (const c of cardView(db, { today })) {
    console.log(`  card                             balance ${$(c.balance)}, limit ${$(c.limit)}, ${c.rate_known ? `purchase rate ${(c.rate * 100).toFixed(2)}%` : 'rate unknown'}`);
  }
  // Tax return estimate: totals only, nothing identifying.
  for (const fy of [2026, 2027]) {
    const e = taxReturnEstimate(db, { fy, today });
    if (e.status !== 'ok') { console.log(`  tax estimate FY${fy}              ${e.status}: ${e.message}`); continue; }
    console.log(`  tax estimate FY${fy}              ${e.headline.kind} ${$(e.headline.amount)} (${e.confidence.level} confidence, ${e.salary.gross.source} salary, ${e.salary.projection.pays_so_far} of ${e.salary.projection.pays_total} pays)`);
    for (const l of e.lines.filter((x) => x.amount || x.key === 'result')) console.log(`    ${l.label.padEnd(36)} ${$(l.amount).padStart(12)} ${l.source}`);
    for (const w of e.swings) console.log(`    ${w.label.padEnd(36)} +${$(w.amount)}`);
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
