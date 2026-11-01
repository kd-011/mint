// Runs the engine over the book: once at startup, and after every sync.
// Order matters: the loan drawdown and AU merchant rules, rules and provider fallback first,
// then transfer matching (so the model never sees transfers), then the income
// streams (which need both), the one-off v2 seeds, then alerts, then the model
// for merchants nothing else knows, then income and alerts again if it
// changed anything.
import { getSetting, setSetting, tx } from './db.mjs';
import { seedCategories, seedLoanRules, seedMerchantRules } from './categories.mjs';
import { runIncome } from './income.mjs';
import { generateStarterBudgets } from './budgets.mjs';
import { seedHomeLoanBudget } from './loanbudget.mjs';
import { seedPlan } from './plan.mjs';
import { seedGoals } from './goals.mjs';
import { perthDate } from './dates.mjs';
import { applyRules } from './categorise.mjs';
import { matchTransfers } from './transfers.mjs';
import { runAlerts } from './alerts.mjs';
import { deriveMerchant, MERCHANT_VERSION } from './merchant.mjs';

// Stored merchants follow the current derivation; rows outside the sync
// window would otherwise keep an old one forever.
export function rederiveMerchants(db) {
  if (getSetting(db, 'merchant_version') === String(MERCHANT_VERSION)) return 0;
  let n = 0;
  tx(db, () => {
    const upd = db.prepare('UPDATE transactions SET merchant = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, description, merchant_name, merchant FROM transactions').all()) {
      const m = deriveMerchant(r.description, r.merchant_name);
      if (m !== r.merchant) { upd.run(m, r.id); n += 1; }
    }
  });
  setSetting(db, 'merchant_version', MERCHANT_VERSION);
  return n;
}

// Starter budgets, once: only into an empty budgets table, and only once two
// pay cycles have closed. After that the owner's edits and deletes stand.
export function starterOnce(db, { today }) {
  if (getSetting(db, 'starter_budgets_at')) return null;
  if (db.prepare('SELECT count(*) n FROM budgets').get().n) { setSetting(db, 'starter_budgets_at', 'had budgets'); return null; }
  const r = generateStarterBudgets(db, { today });
  if (r.cycles_used >= 2) setSetting(db, 'starter_budgets_at', new Date().toISOString());
  return r;
}

// Everything after categorising and transfers that v2 derives from the book.
export function moneyPass(db, { today }) {
  const income = runIncome(db, { today });
  const starter = starterOnce(db, { today });
  seedPlan(db, { today });
  seedGoals(db);
  // After the starter pass, so a fresh book still gets its starter budgets.
  if (getSetting(db, 'starter_budgets_at')) seedHomeLoanBudget(db);
  return { income, starter };
}

export function createEngine({ db, ai = null, logos = null, log = console.log, now = () => new Date(), staleHours = 24, wise = false }) {
  let aiRun = null;

  function init() {
    seedCategories(db);
    const re = rederiveMerchants(db);
    if (re) log(`engine: re-derived ${re} merchants`);
    return refresh();
  }

  function refresh() {
    seedLoanRules(db);
    seedMerchantRules(db);
    const cat = applyRules(db);
    const xfer = matchTransfers(db);
    const money = moneyPass(db, { today: perthDate(now()) });
    if (money.starter?.created.length) log(`engine: ${money.starter.created.length} starter budgets from ${money.starter.cycles_used} pay cycles`);
    const alerts = runAlerts(db, { now: now(), staleHours, wise });
    return { categorised: cat, transfers: xfer, income: money.income, alerts: alerts.length };
  }

  // The model pass runs in the background; one at a time.
  function runAi({ force = false } = {}) {
    if (!ai || aiRun) return aiRun;
    aiRun = ai.run({ force })
      .then((r) => { if (r.categorised) { moneyPass(db, { today: perthDate(now()) }); runAlerts(db, { now: now(), staleHours, wise }); } return r; })
      .catch((e) => { log(`ai: ${e?.stack ?? e}`); return { error: String(e?.message ?? e) }; })
      .finally(() => { aiRun = null; });
    return aiRun;
  }

  // Merchant logos run after the model pass so categorising is never held up,
  // and never throw into a sync. `drain` keeps going until nothing is due (the backfill).
  let logoRun = null;
  function runLogos({ drain = false } = {}) {
    if (!logos || logoRun) return logoRun;
    logoRun = (async () => {
      for (let i = 0; i < 20; i++) {
        const r = await logos.run();
        if (!drain || r.already || r.considered < 1 || (!r.resolved && !r.none && !r.errors)) break;
      }
    })().catch((e) => log(`logos: ${e?.stack ?? e}`)).finally(() => { logoRun = null; });
    return logoRun;
  }

  function afterSync() {
    const r = refresh();
    if (r.transfers.auto || r.transfers.review || r.alerts) {
      log(`engine: ${r.transfers.auto} transfers linked, ${r.transfers.review} to review, ${r.alerts} new alerts`);
    }
    const p = runAi();
    if (p) p.finally(() => runLogos()); else runLogos();
    return r;
  }

  return { init, refresh, afterSync, runAi, runLogos };
}
