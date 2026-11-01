// the owner's own settings on an account: nickname, hidden, business, spendable, type.
// Shared by the app's PATCH /api/accounts/:id and the chat door. Nothing here
// touches a connection, a credential or a balance. accountView is the shape
// /api/accounts and the manual account routes answer with.
import { bad, notFound } from './errors.mjs';
import { MANUAL_TYPES } from './manual.mjs';

// Validates everything before writing anything. Returns the keys it changed.
export function updateAccount(db, id, body = {}) {
  const sets = [];
  const args = [];
  for (const k of ['is_business', 'hidden']) {
    if (!(k in body)) continue;
    if (typeof body[k] !== 'boolean') throw bad(`${k} must be true or false`);
    sets.push(`${k} = ?`);
    args.push(body[k] ? 1 : 0);
  }
  // Spendable: true or false pins it for the safe to spend cash check, null hands it back to Mint's guess.
  if ('spendable' in body) {
    if (body.spendable !== null && typeof body.spendable !== 'boolean') throw bad('spendable must be true, false or null');
    sets.push('spendable = ?');
    args.push(body.spendable === null ? null : body.spendable ? 1 : 0);
  }
  // Type: one of MANUAL_TYPES overrides what the bank says, null goes back to the bank's. accounts.type carries
  // the effective value (ingest leaves it alone while an override is set), so no reader needs to know about this.
  if ('type_override' in body) {
    const t = body.type_override;
    if (t !== null && !MANUAL_TYPES.includes(t)) throw bad(`type_override must be one of ${MANUAL_TYPES.join(', ')} or null`);
    const row = db.prepare('SELECT manual, type, feed_type FROM accounts WHERE id = ?').get(id);
    if (!row) throw notFound('no such account');
    if (row.manual) throw bad("a manual account's type is set by editing the account, not overridden");
    const feed = row.feed_type ?? row.type; // before the first sync after this column existed, type is still the bank's
    sets.push('type_override = ?', 'type = ?', 'feed_type = ?');
    args.push(t, t ?? feed, feed);
  }
  if ('nickname' in body) {
    const n = body.nickname;
    if (n !== null && (typeof n !== 'string' || n.trim().length > 60)) throw bad('nickname must be up to 60 characters');
    sets.push('nickname = ?');
    args.push(n && n.trim() ? n.trim() : null);
  }
  if (!sets.length) throw bad('nothing to change: give nickname, hidden, is_business, spendable or type_override');
  const r = db.prepare(`UPDATE accounts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, new Date().toISOString(), id);
  if (!r.changes) throw notFound('no such account');
  return sets.map((s) => s.split(' ')[0]);
}

export function accountView(a, fxStatus = null) {
  let loan = null;
  let rates = null;
  if (a.details_json) {
    try {
      const d = JSON.parse(a.details_json);
      rates = { product_name: d.product_name ?? null, lending_rate: d.lending_rate ?? null, deposit_rate: d.deposit_rate ?? null };
      if (d.loan_details) {
        const l = d.loan_details;
        loan = {
          repayment_type: l.repayment_type ?? null, repayment_frequency: l.repayment_frequency ?? null,
          next_instalment_date: l.next_instalment_date ?? null, loan_end_date: l.loan_end_date ?? null,
          offset_account_enabled: l.offset_account_enabled ?? null, original_loan_amount: l.original_loan_amount ?? null,
          max_redraw: l.max_redraw ?? null,
        };
      }
    } catch {}
  }
  return {
    id: a.id, connection_id: a.connection_id, name: a.name, nickname: a.nickname, type: a.type, type_override: a.type_override ?? null, feed_type: a.feed_type ?? null, institution: a.institution,
    number_masked: a.number_masked, currency: a.currency, status: a.status, is_business: a.is_business, hidden: a.hidden,
    spendable: a.spendable == null ? null : !!a.spendable, sort: a.sort ?? 0,
    earliest_date: a.earliest_date, latest_date: a.latest_date, backfill_done_at: a.backfill_done_at,
    last_synced_at: a.last_synced_at, last_sync_error: a.last_sync_error,
    balance_current: a.balance_current, balance_available: a.balance_available,
    balance_observed_at: a.balance_observed_at, balance_freshness: a.balance_freshness,
    tx_count: a.tx_count, pending_count: a.pending_count, rates, loan,
    // A manual account (lib/manual.mjs): balance_current is AUD, balance_native its own currency,
    // fx the rate behind the AUD figure (null for AUD) with its date and whether it is stale.
    manual: !!a.manual, balance_native: a.balance_native ?? null, opening_balance: a.opening_balance ?? null, opening_date: a.opening_date ?? null,
    fx: a.manual && a.currency !== 'AUD' && fxStatus ? fxStatus(a.currency) : null,
    // A manual account that follows a Wise balance (lib/wisesync.mjs): wise_statements is 'ok' (rows sync
    // too) or 'sca' (balance only, rows from a CSV import).
    wise: !!a.wise_balance_id, wise_statements: a.wise_balance_id ? a.wise_statements ?? null : null,
  };
}
