// Pulls Redbark into Mint's own copy: connections and accounts, live balances
// (snapshotted daily, since Redbark keeps no history), loan details, and every
// transaction as far back as each bank allows. One sync runs at a time.
import { tx, getSetting, setSetting } from './db.mjs';
import { zoneDate, addDays, oldestAllowedFrom, daysBetween, isIsoDate } from './dates.mjs';
import { deriveMerchant } from './merchant.mjs';
import { findDuplicates } from './accountmerge.mjs';

export const POLL_WINDOW_DAYS = 21; // pending rows can sit a fortnight before settling
export const RECONCILE_WINDOW_DAYS = 120;
const CONSENT_WARN_DAYS = 30;

const describe = (e) => (e?.code ? `${e.code}: ${e.message?.replace(/^Redbark \S+ \S+: /, '')}` : String(e?.message ?? e)).slice(0, 500);

const PROVIDER_FIELDS = ['account_id', 'status', 'date', 'post_date', 'datetime', 'description', 'reference', 'extended_description',
  'amount', 'currency', 'direction', 'provider_category', 'rb_category', 'merchant_name', 'mcc', 'merchant'];

function mapTransaction(row, accountId) {
  const amount = row.amount?.amount;
  if (!Number.isInteger(amount) || typeof row.id !== 'string' || !row.id || !isIsoDate(row.date)) return null;
  const str = (v) => (typeof v === 'string' ? v : v == null ? null : String(v));
  return {
    id: row.id,
    account_id: row.account ?? accountId,
    status: row.status === 'pending' ? 'pending' : 'posted',
    date: row.date,
    post_date: str(row.post_date),
    datetime: str(row.datetime),
    description: str(row.description) ?? '',
    reference: str(row.reference),
    extended_description: str(row.extended_description),
    amount,
    currency: String(row.amount?.currency ?? 'aud').toUpperCase(),
    direction: str(row.direction),
    provider_category: str(row.provider_category),
    rb_category: str(row.category),
    merchant_name: str(row.merchant_name),
    mcc: str(row.merchant_category_code),
    merchant: deriveMerchant(str(row.description), str(row.merchant_name)),
  };
}

// afterSync runs once a poll or reconcile has landed its rows (categorise,
// match transfers, alerts); its failure is logged, never the sync's.
// wise (lib/wisesync.mjs) is optional: when it is enabled a poll and a reconcile run it after
// Redbark, on the same queue and the same running guard, and it can run alone (kind 'wise').
// client is null when REDBARK_API_KEY is not set: there is no bank feed, so a poll, a reconcile and a
// snapshot do nothing (and write nothing to the sync log) apart from Wise when it is on.
export function createIngest({ db, client, now = () => new Date(), log = console.log, afterSync = null, wise = null }) {
  const nowIso = () => now().toISOString();
  const today = () => zoneDate(now());
  const state = {
    running: false, kind: null, label: '', step: 0, steps: 0,
    startedAt: null, finishedAt: null, lastError: null, accountErrors: 0,
  };
  const progress = (step, label) => { state.step = step; state.label = label; };

  const q = {
    getTx: db.prepare(`SELECT ${PROVIDER_FIELDS.join(', ')} FROM transactions WHERE id = ?`),
    insertTx: db.prepare(`INSERT INTO transactions (id, ${PROVIDER_FIELDS.join(', ')}, first_seen_at, updated_at)
      VALUES (:id, ${PROVIDER_FIELDS.map((f) => `:${f}`).join(', ')}, :now, :now)`),
    updateTx: db.prepare(`UPDATE transactions SET ${PROVIDER_FIELDS.map((f) => `${f} = :${f}`).join(', ')}, updated_at = :now WHERE id = :id`),
    log: db.prepare(`INSERT INTO sync_log (kind, account_id, started_at, finished_at, ok, fetched, inserted, updated, removed, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  };

  function upsertRows(accountId, rows, counts) {
    const at = nowIso();
    for (const raw of rows) {
      const t = mapTransaction(raw, accountId);
      if (!t) { log(`skipped malformed transaction on ${accountId}`); continue; }
      const old = q.getTx.get(t.id);
      if (!old) {
        q.insertTx.run({ ...t, now: at });
        counts.inserted += 1;
      } else if (PROVIDER_FIELDS.some((f) => old[f] !== t[f])) {
        q.updateTx.run({ ...t, now: at });
        counts.updated += 1;
      }
    }
  }

  // A pending row the bank no longer returns has settled (usually under a new
  // id) or been dropped. Move anything the owner set onto the settled row, then
  // remove the pending one.
  function dropVanishedPending(accountId, from, to, seen) {
    const pend = db.prepare(`SELECT * FROM transactions WHERE account_id = ? AND status = 'pending' AND date BETWEEN ? AND ?`).all(accountId, from, to);
    let removed = 0;
    for (const p of pend) {
      if (seen.has(p.id)) continue;
      const match = db.prepare(`SELECT id FROM transactions WHERE account_id = ? AND status = 'posted' AND amount = ?
        AND date BETWEEN ? AND ? ORDER BY date, id LIMIT 1`).get(accountId, p.amount, p.date, addDays(p.date, 7));
      if (match) {
        const manualCat = p.category_source === 'manual' ? p.category_id : null;
        db.prepare(`UPDATE transactions SET
            category_id = COALESCE(?, category_id),
            category_source = CASE WHEN ? IS NOT NULL THEN 'manual' ELSE category_source END,
            is_business = COALESCE(is_business, ?), note = COALESCE(note, ?)
          WHERE id = ?`).run(manualCat, manualCat, p.is_business, p.note, match.id);
        db.prepare('UPDATE receipts SET transaction_id = ? WHERE transaction_id = ?').run(match.id, p.id);
        db.prepare('UPDATE owed_payments SET transaction_id = ? WHERE transaction_id = ?').run(match.id, p.id);
        db.prepare(`UPDATE tax_tags SET transaction_id = ? WHERE transaction_id = ?
          AND NOT EXISTS (SELECT 1 FROM tax_tags WHERE transaction_id = ?)`).run(match.id, p.id, match.id);
      }
      db.prepare('DELETE FROM transactions WHERE id = ?').run(p.id);
      removed += 1;
    }
    return removed;
  }

  async function syncMeta() {
    const [conns, accts] = await Promise.all([client.connections(), client.accounts()]);
    const at = nowIso();
    let skipped = 0;
    tx(db, () => {
      const upConn = db.prepare(`INSERT INTO connections (id, institution, provider, status, consent_id, consent_status, consent_expires_at, last_refreshed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET institution = excluded.institution, provider = excluded.provider, status = excluded.status,
          consent_id = excluded.consent_id, consent_status = excluded.consent_status, consent_expires_at = excluded.consent_expires_at,
          last_refreshed_at = excluded.last_refreshed_at, updated_at = excluded.updated_at`);
      for (const c of conns) {
        upConn.run(c.id, c.institution?.name ?? 'Unknown bank', c.provider ?? null, c.status ?? 'unknown', c.consent?.id ?? null,
          c.consent?.status ?? null, c.consent?.expires_at ?? null, c.last_refreshed_at ?? null, at);
      }
      const connIds = new Set(conns.map((c) => c.id));
      // The row is found by Redbark's account id alone. A rename arrives under the same id, so it updates
      // the name in place; the name is never part of the match.
      const known = db.prepare('SELECT merged_into FROM accounts WHERE id = ?');
      const ins = db.prepare(`INSERT INTO accounts (id, connection_id, name, type, feed_type, institution, number_masked, currency, status, is_business, sort, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM accounts), ?, ?)`);
      const upd = db.prepare(`UPDATE accounts SET connection_id = ?, name = ?, type = COALESCE(type_override, ?), feed_type = ?, institution = ?, number_masked = ?, currency = ?, status = ?, updated_at = ? WHERE id = ?`);
      const banking = accts.filter((a) => (a.category ?? 'banking') === 'banking');
      skipped = accts.length - banking.length;
      // A new account goes to the end (sort = last + 1), never to a place the owner has already filled; the update path never touches sort.
      // One account the bank describes badly (no name or type) is logged and skipped; it must not stop the others being added.
      banking.forEach((a) => {
        try {
          tx(db, () => {
            const row = known.get(a.id);
            if (row?.merged_into) return; // folded into a newer row for the same account, stays retired
            const conn = connIds.has(a.connection) ? a.connection : null;
            const cur = String(a.currency ?? 'aud').toUpperCase();
            const inst = a.institution?.name ?? 'Unknown bank';
            const name = a.name || 'Unnamed account';
            const type = a.type || 'other';
            if (row) upd.run(conn, name, type, type, inst, a.account_number ?? null, cur, a.status ?? null, at, a.id);
            else ins.run(a.id, conn, name, type, type, inst, a.account_number ?? null, cur, a.status ?? null, /business/i.test(name) ? 1 : 0, at, at);
          });
        } catch (e) {
          log(`account ${a.id} skipped: ${describe(e)}`);
        }
      });
      const live = new Set(banking.map((a) => a.id));
      // Manual accounts (lib/manual.mjs) are not Redbark's to retire.
      for (const { id } of db.prepare("SELECT id FROM accounts WHERE status IS NOT 'gone' AND manual = 0").all()) {
        if (!live.has(id)) db.prepare("UPDATE accounts SET status = 'gone', updated_at = ? WHERE id = ?").run(at, id);
      }
    });
    return { connections: conns.length, accounts: accts.length, skipped };
  }

  // Every Redbark call (balances, details, transactions) walks this list, so a manual account is never asked about.
  const activeAccounts = () => db.prepare("SELECT * FROM accounts WHERE status IS NOT 'gone' AND manual = 0 ORDER BY sort, name").all();

  async function syncBalances() {
    const ids = activeAccounts().map((a) => a.id);
    if (!ids.length) return 0;
    const bal = await client.balances(ids);
    const d = today();
    tx(db, () => {
      for (const b of bal) {
        if (!ids.includes(b.account)) continue;
        if (b.current == null || !Number.isInteger(b.current.amount)) {
          db.prepare('UPDATE accounts SET balance_freshness = ? WHERE id = ?').run(b.freshness ?? 'unavailable', b.account);
          continue;
        }
        const avail = Number.isInteger(b.available?.amount) ? b.available.amount : null;
        db.prepare(`UPDATE accounts SET balance_current = ?, balance_available = ?, balance_observed_at = ?, balance_freshness = ? WHERE id = ?`)
          .run(b.current.amount, avail, b.observed_at ?? nowIso(), b.freshness ?? null, b.account);
        db.prepare(`INSERT INTO balance_snapshots (account_id, date, current, available, observed_at, freshness) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, date) DO UPDATE SET current = excluded.current, available = excluded.available,
            observed_at = excluded.observed_at, freshness = excluded.freshness`)
          .run(b.account, d, b.current.amount, avail, b.observed_at ?? nowIso(), b.freshness ?? null);
      }
    });
    return bal.length;
  }

  async function syncDetails() {
    let n = 0;
    for (const a of activeAccounts()) {
      try {
        const det = await client.details(a.id);
        db.prepare('UPDATE accounts SET details_json = ?, details_at = ? WHERE id = ?').run(JSON.stringify(det), nowIso(), a.id);
        n += 1;
      } catch (e) {
        if (e?.code !== 'not_supported' && e?.code !== 'wrong_endpoint_for_category') log(`details ${a.id}: ${describe(e)}`);
      }
    }
    return n;
  }

  // Daily: today's balance row per account, with the rate and loan terms the
  // bank reported that day (rates change; Redbark keeps no history of them).
  async function snapshotDaily() {
    await syncBalances();
    await syncDetails();
    const d = today();
    for (const a of activeAccounts()) {
      if (!a.details_json) continue;
      const det = JSON.parse(a.details_json);
      if (det.lending_rate == null && det.deposit_rate == null && !det.loan_details) continue;
      const compact = JSON.stringify({ product_name: det.product_name ?? null, lending_rate: det.lending_rate ?? null, deposit_rate: det.deposit_rate ?? null, loan_details: det.loan_details ?? null });
      db.prepare('UPDATE balance_snapshots SET details_json = ? WHERE account_id = ? AND date = ?').run(compact, a.id, d);
    }
    setSetting(db, 'last_snapshot_at', nowIso());
  }

  async function syncAccount(accountId, { from, to = today() } = {}) {
    const started = nowIso();
    const counts = { inserted: 0, updated: 0, removed: 0 };
    const seen = new Set();
    try {
      const res = await client.walkTransactions({
        account: accountId, from, to, includePending: true,
        onRows: (rows) => {
          rows.forEach((r) => seen.add(r.id));
          tx(db, () => upsertRows(accountId, rows, counts));
        },
      });
      tx(db, () => {
        counts.removed = dropVanishedPending(accountId, res.from, to, seen);
        const span = db.prepare('SELECT MIN(date) lo, MAX(date) hi FROM transactions WHERE account_id = ?').get(accountId);
        db.prepare('UPDATE accounts SET earliest_date = ?, latest_date = ?, last_synced_at = ?, last_sync_error = NULL WHERE id = ?')
          .run(span.lo, span.hi, nowIso(), accountId);
      });
      if (res.incomplete) log(`${accountId}: a single day exceeded the row ceiling, some rows may be missing`);
      q.log.run('account', accountId, started, nowIso(), 1, res.count, counts.inserted, counts.updated, counts.removed, null);
      return { fetched: res.count, ...counts, from: res.from, splits: res.splits };
    } catch (e) {
      db.prepare('UPDATE accounts SET last_sync_error = ? WHERE id = ?').run(describe(e), accountId);
      q.log.run('account', accountId, started, nowIso(), 0, seen.size, counts.inserted, counts.updated, counts.removed, describe(e));
      throw e;
    }
  }

  async function backfillAccount(accountId) {
    const r = await syncAccount(accountId, { from: oldestAllowedFrom(today()) });
    db.prepare('UPDATE accounts SET backfill_done_at = ? WHERE id = ?').run(nowIso(), accountId);
    const earliest = db.prepare('SELECT earliest_date FROM accounts WHERE id = ?').get(accountId)?.earliest_date ?? null;
    return { count: r.fetched, earliest, inserted: r.inserted };
  }

  // Shared body of poll and reconcile: refresh metadata and balances, then
  // walk each account (a full backfill the first time it is seen).
  async function sweep(kind, { accounts = null, windowDays, from = null, daily = false }) {
    const started = nowIso();
    const totals = { fetched: 0, inserted: 0, updated: 0, removed: 0, errors: 0 };
    progress(1, 'Checking connections');
    await syncMeta();
    progress(2, 'Reading balances');
    if (daily) await snapshotDaily(); else await syncBalances();
    const list = activeAccounts().filter((a) => !accounts || accounts.includes(a.id));
    state.steps = 2 + list.length;
    const defaultFrom = addDays(today(), -windowDays);
    const windowFrom = from && from < defaultFrom ? from : defaultFrom;
    for (const [i, a] of list.entries()) {
      progress(3 + i, `${a.backfill_done_at ? 'Fetching' : 'Backfilling'} ${a.nickname || a.name} (${i + 1} of ${list.length})`);
      try {
        const r = a.backfill_done_at ? await syncAccount(a.id, { from: windowFrom }) : await backfillAccount(a.id).then((b) => ({ fetched: b.count, inserted: b.inserted, updated: 0, removed: 0 }));
        totals.fetched += r.fetched; totals.inserted += r.inserted; totals.updated += r.updated ?? 0; totals.removed += r.removed ?? 0;
      } catch (e) {
        totals.errors += 1;
        log(`${kind} ${a.id}: ${describe(e)}`);
      }
    }
    state.accountErrors = totals.errors;
    // Never merged here: a person reads `node scripts/merge-accounts.mjs` (a dry run) and applies it.
    try {
      const dup = findDuplicates(db).pairs.length;
      if (dup) log(`${kind}: ${dup} account(s) are the same bank account under a second Redbark id; run scripts/merge-accounts.mjs to review`);
    } catch (e) { log(`${kind}: duplicate account check failed: ${describe(e)}`); }
    q.log.run(kind, null, started, nowIso(), totals.errors ? 0 : 1, totals.fetched, totals.inserted, totals.updated, totals.removed,
      totals.errors ? `${totals.errors} account(s) failed` : null);
    return totals;
  }

  // Wise never throws into a sweep: it answers { ok, error } and keeps its own log row and alert state.
  // A webhook-scoped poll (accounts given) is about named Redbark accounts, so Wise skips it.
  async function runWise(kind, { force = false } = {}) {
    if (!wise?.enabled) return null;
    state.steps = Math.max(state.steps, state.step) + 1;
    progress(state.steps, 'Syncing Wise');
    try {
      const r = await wise.sync({ kind, force });
      if (!r.ok) state.accountErrors += 1;
      return r;
    } catch (e) {
      state.accountErrors += 1;
      log(`wise ${kind}: ${String(e?.message ?? e).slice(0, 300)}`);
      return null;
    }
  }

  const idle = () => ({ fetched: 0, inserted: 0, updated: 0, removed: 0, errors: 0 });

  async function poll(opts = {}) {
    let r;
    if (!client) {
      if (opts.accounts || !wise?.enabled) return idle();
      await runWise('poll');
      setSetting(db, 'last_poll_at', nowIso());
      return idle();
    }
    try {
      r = await sweep('poll', { ...opts, windowDays: POLL_WINDOW_DAYS });
    } finally {
      if (!opts.accounts) await runWise('poll'); // even when Redbark is down
    }
    if (!opts.accounts) setSetting(db, 'last_poll_at', nowIso()); // a webhook-scoped poll does not reset the 30 minute clock
    return r;
  }

  async function reconcile() {
    let r;
    if (!client) {
      if (!wise?.enabled) return idle();
      await runWise('reconcile');
      setSetting(db, 'last_reconcile_at', nowIso());
      return idle();
    }
    try {
      r = await sweep('reconcile', { windowDays: RECONCILE_WINDOW_DAYS, daily: true });
    } finally {
      await runWise('reconcile');
    }
    db.prepare('DELETE FROM sync_log WHERE started_at < ?').run(new Date(now().getTime() - 30 * 86400000).toISOString());
    setSetting(db, 'last_reconcile_at', nowIso());
    return r;
  }

  const JOBS = {
    poll: (opts) => poll(opts),
    reconcile: () => reconcile(),
    wise: async () => { state.steps = 0; return runWise('poll', { force: true }); },
    snapshot: async () => { if (!client) return idle(); progress(1, 'Reading balances and loan details'); state.steps = 1; await snapshotDaily(); return undefined; },
  };

  async function runSync(kind, opts = {}) {
    if (state.running) return { already: true, state: { ...state } };
    if (!JOBS[kind]) throw new Error(`unknown sync kind ${kind}`);
    if (!client && !wise?.enabled) return { ok: true, result: idle() }; // no bank feed at all: nothing to run, nothing to log
    Object.assign(state, { running: true, kind, label: 'Starting', step: 0, steps: 2, startedAt: nowIso(), finishedAt: null, lastError: null, accountErrors: 0 });
    try {
      const result = await JOBS[kind](opts);
      if (afterSync && kind !== 'snapshot') {
        progress(state.steps, 'Categorising');
        try { await afterSync(kind); } catch (e) { log(`after ${kind}: ${e?.stack ?? e}`); }
      }
      return { ok: true, result };
    } catch (e) {
      state.lastError = describe(e);
      log(`${kind} failed: ${state.lastError}`);
      if (kind !== 'snapshot') q.log.run(kind, null, state.startedAt, nowIso(), 0, 0, 0, 0, 0, state.lastError);
      return { ok: false, error: state.lastError };
    } finally {
      Object.assign(state, { running: false, label: '', finishedAt: nowIso() });
    }
  }

  function health() {
    const d = today();
    const connections = db.prepare('SELECT * FROM connections ORDER BY institution').all().map((c) => {
      const days = c.consent_expires_at ? daysBetween(d, zoneDate(new Date(c.consent_expires_at))) : null;
      return {
        id: c.id, institution: c.institution, status: c.status, consent_status: c.consent_status,
        consent_expires_at: c.consent_expires_at, consent_days: days,
        consent_warning: c.status !== 'active' || (days != null && days <= CONSENT_WARN_DAYS),
        last_refreshed_at: c.last_refreshed_at,
      };
    });
    return {
      connections,
      sync: {
        ...state,
        lastPollAt: getSetting(db, 'last_poll_at'),
        lastReconcileAt: getSetting(db, 'last_reconcile_at'),
        lastSnapshotAt: getSetting(db, 'last_snapshot_at'),
      },
    };
  }

  // Which feeds exist on this install: Redbark (a key is set) and Wise (a token is set).
  const feeds = () => ({ redbark: !!client, wise: !!wise?.enabled });

  return { feeds, syncMeta, syncBalances, syncDetails, snapshotDaily, syncAccount, backfillAccount, poll, reconcile, runSync, state: () => ({ ...state }), health };
}
