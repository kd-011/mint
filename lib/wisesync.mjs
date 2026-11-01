// Wise sync: keeps a manual account (lib/manual.mjs) per Wise currency balance
// current, read only. Each balance becomes one account keyed by Wise's balance
// id (accounts.wise_balance_id), so a re-sync finds it and never adds a second.
// Statement rows go in through the manual insert path (rate for the row's date,
// rules, merchant derivation and the model pass all apply) as one manual_imports
// row, idempotent on Wise's transaction reference (import_hash). The balance is
// then set to the figure Wise reports with the usual Balance adjustment row, so
// Mint matches Wise exactly.
//
// The first run backfills twelve months and takes the opening balance from
// Wise's own statement, so a clean account needs no adjustment at all. If Wise
// refuses statements for SCA the account runs on balances alone (wise_statements
// = 'sca'; rows come from a CSV import). Nothing here works around SCA.
//
// A run never throws: it answers { ok, error, ... }, writes one sync_log row,
// and keeps the run level state (wise_ok_at, wise_error) the page and the alert
// pipeline read. An unset token means no WiseSync at all (enabled = false).
import { createHash } from 'node:crypto';
import { getSetting, setSetting, tx } from './db.mjs';
import { zoneDate, addDays } from './dates.mjs';
import { HttpError } from './errors.mjs';
import { WiseError } from './wise.mjs';
import { createManualAccount, insertManualRow, recomputeAccount, setManualBalance } from './manual.mjs';

export const BACKFILL_DAYS = 365;
const POLL_WINDOW_DAYS = 21;
const RECONCILE_WINDOW_DAYS = 120;
const NOTE = 'Matches the balance Wise reports';

const cents = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) : null);

export function createWiseSync({ db, client, fx = null, configError = null, now = () => new Date(), log = console.log, backfillDays = BACKFILL_DAYS }) {
  const enabled = !!client || !!configError;
  const nowIso = () => now().toISOString();
  const redact = (t) => (client?.redact ? client.redact(t) : String(t));
  const describe = (e) => redact(e instanceof HttpError ? e.message : (e?.message ?? e)).replace(/\s+/g, ' ').slice(0, 500);
  let running = null;

  function status() {
    return { enabled, ok_at: getSetting(db, 'wise_ok_at'), error: getSetting(db, 'wise_error') };
  }

  // Window start for an account that already exists: recent days, or further
  // back when the last good sync was longer ago, never before the opening date.
  function windowFrom(a, kind, today) {
    let from = addDays(today, -(kind === 'reconcile' ? RECONCILE_WINDOW_DAYS : POLL_WINDOW_DAYS));
    const last = a.last_synced_at ? zoneDate(new Date(a.last_synced_at)) : null;
    if (last && addDays(last, -2) < from) from = addDays(last, -2);
    const floor = addDays(today, -backfillDays);
    if (from < floor) from = floor;
    if (a.opening_date && from < a.opening_date) from = a.opening_date;
    return from;
  }

  // Occurrence-numbered per reference, so two lines that share one are both kept.
  function hashed(accountId, rows) {
    const seen = new Map();
    return rows.map((r) => {
      const key = r.ref || `${r.at}|${r.amount}|${r.description}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return { ...r, hash: createHash('sha256').update(`${accountId}|wise|${key}|${n}`).digest('hex').slice(0, 32) };
    });
  }

  function importRows(a, rows, today) {
    const have = new Set(db.prepare('SELECT import_hash FROM transactions WHERE account_id = ? AND import_hash IS NOT NULL').all(a.id).map((r) => r.import_hash));
    const fresh = hashed(a.id, rows).filter((r) => r.date >= a.opening_date && r.date <= today && !have.has(r.hash));
    if (!fresh.length) return 0;
    const dates = fresh.map((r) => r.date).sort();
    const at = nowIso();
    const importId = Number(db.prepare(`INSERT INTO manual_imports (account_id, file_name, rows, duplicates, failed, from_date, to_date, created_at)
      VALUES (?, 'Wise sync', ?, 0, 0, ?, ?, ?)`).run(a.id, fresh.length, dates[0], dates.at(-1), at).lastInsertRowid);
    for (const r of fresh) {
      insertManualRow(db, a, { date: r.date, amount_native: r.amount, description: (r.description || `Wise ${String(r.kind ?? 'transaction').toLowerCase()}`).slice(0, 200), reference: r.ref ? r.ref.slice(0, 100) : null },
        { now: now(), importId, importHash: r.hash });
    }
    return fresh.length;
  }

  async function syncBalance(profileId, bal, { kind, force, today }) {
    const currency = String(bal?.currency ?? '').toUpperCase();
    const balanceId = String(bal?.id ?? '');
    const reported = cents(bal?.amount?.value);
    if (!/^[A-Z]{3}$/.test(currency) || !balanceId || reported == null) return { currency, skipped: 'unreadable' };

    const known = db.prepare('SELECT * FROM accounts WHERE wise_balance_id = ?').get(balanceId);
    if (known?.status === 'gone') return { currency, account_id: known.id, skipped: 'archived' };
    const emptyKey = `wise_empty:${balanceId}`;
    if (!known && reported === 0 && !force && getSetting(db, emptyKey) === today) return { currency, skipped: 'empty' };

    const from = known ? windowFrom(known, kind, today) : addDays(today, -backfillDays);
    let walk = null;
    let mode = 'ok';
    try {
      walk = await client.walkStatement(profileId, balanceId, { currency, from, to: today });
    } catch (e) {
      if (!(e instanceof WiseError && e.sca)) throw e;
      mode = 'sca';
    }

    if (!known && reported === 0 && (mode === 'sca' || !walk.rows.length)) {
      setSetting(db, emptyKey, today);
      return { currency, skipped: 'empty' };
    }

    // Rates first (one range call), then every write is synchronous. No rate means
    // the write refuses (HttpError 422) and this account is left as it was.
    if (currency !== 'AUD' && fx) {
      const dates = [today, ...(mode === 'ok' ? [from, ...walk.rows.map((r) => r.date)] : [])];
      await fx.ensure(currency, dates);
    }

    return tx(db, () => {
      let a = known;
      let created = false;
      if (!a) {
        const made = createManualAccount(db, {
          name: `Wise ${currency}`, institution: 'Wise', type: 'transaction', currency,
          opening_balance: mode === 'ok' ? (walk.openingCents ?? 0) : reported,
          opening_date: mode === 'ok' ? from : today,
        }, { today, now: now() });
        db.prepare('UPDATE accounts SET wise_balance_id = ? WHERE id = ?').run(balanceId, made.id);
        a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(made.id);
        created = true;
      }
      const inserted = mode === 'ok' ? importRows(a, walk.rows, today) : 0;
      if (inserted) recomputeAccount(db, a.id, { today, now: now() });
      a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(a.id);
      let adjusted = 0;
      if (a.balance_native !== reported) {
        setManualBalance(db, a.id, { balance: reported, note: NOTE }, { today, now: now() });
        adjusted = reported - a.balance_native;
      }
      db.prepare('UPDATE accounts SET wise_statements = ?, last_synced_at = ?, last_sync_error = NULL WHERE id = ?').run(mode, nowIso(), a.id);
      return { currency, account_id: a.id, created, mode, inserted, adjusted, balance_native: reported };
    });
  }

  async function run({ kind = 'poll', force = false } = {}) {
    if (!enabled) return { ok: true, skipped: true };
    const started = nowIso();
    const today = zoneDate(now());
    const out = { ok: true, error: null, accounts: [], inserted: 0 };
    let runError = null;
    try {
      if (configError) throw new Error(configError);
      const profile = await client.personalProfile();
      const balances = await client.balances(profile.id);
      const failures = [];
      for (const bal of balances) {
        try {
          const r = await syncBalance(profile.id, bal, { kind, force, today });
          out.accounts.push(r);
          out.inserted += r.inserted ?? 0;
        } catch (e) {
          const message = describe(e);
          const currency = String(bal?.currency ?? '?').toUpperCase();
          failures.push(`Wise ${currency}: ${message}`);
          out.accounts.push({ currency, error: message });
          db.prepare('UPDATE accounts SET last_sync_error = ? WHERE wise_balance_id = ?').run(message, String(bal?.id));
        }
      }
      if (failures.length) { out.ok = false; out.error = failures.join('; ').slice(0, 500); }
    } catch (e) {
      runError = describe(e);
      out.ok = false;
      out.error = runError;
    }
    setSetting(db, 'wise_error', runError);
    if (!runError) setSetting(db, 'wise_ok_at', nowIso());
    db.prepare(`INSERT INTO sync_log (kind, account_id, started_at, finished_at, ok, fetched, inserted, updated, removed, error)
      VALUES ('wise', NULL, ?, ?, ?, ?, ?, 0, 0, ?)`).run(started, nowIso(), out.ok ? 1 : 0, out.accounts.length, out.inserted, out.error);
    if (!out.ok) log(`wise ${kind}: ${out.error}`);
    return out;
  }

  // One run at a time; a second call while one is going shares it.
  return {
    enabled,
    status,
    sync: (opts) => (running ??= run(opts).finally(() => { running = null; })),
  };
}
