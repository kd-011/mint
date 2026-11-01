// Unusual charges, tuned to stay quiet: a merchant never seen before charging
// at least $200, or a charge at least three times the merchant's usual, $100
// over it and a quarter above the biggest one before, once it has five
// charges of history. Only settled charges in the last fortnight are looked
// at, so a backfill never floods the inbox.
import { merchantKey } from './merchant.mjs';
import { addDays } from './dates.mjs';
import { COUNTS, FROM } from './spend.mjs';

export const UNUSUAL = { windowDays: 14, newMerchantMin: 20000, normMinCount: 5, normMultiple: 3, normMinOver: 10000, overMax: 1.25 };

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export function detectUnusual(db, today, opts = {}) {
  const o = { ...UNUSUAL, ...opts };
  const since = addDays(today, -o.windowDays);
  const recent = db.prepare(`SELECT t.id, t.date, -t.amount amount, COALESCE(t.merchant_override, t.merchant) merchant
    FROM ${FROM} WHERE t.amount < 0 AND t.status = 'posted' AND t.date BETWEEN ? AND ? AND ${COUNTS} ORDER BY t.date, t.id`).all(since, today);
  if (!recent.length) return [];
  const keys = new Set(recent.map((r) => merchantKey(r.merchant)).filter(Boolean));
  // Everything ever seen from those merchants, any sign or status.
  const seen = new Map();
  const all = db.prepare(`SELECT t.id, t.date, t.amount, t.status, COALESCE(t.merchant_override, t.merchant) merchant, (${COUNTS}) counts
    FROM ${FROM} ORDER BY t.date, t.id`).all();
  for (const r of all) {
    const k = merchantKey(r.merchant);
    if (keys.has(k)) (seen.get(k) ?? seen.set(k, []).get(k)).push(r);
  }
  const out = [];
  for (const r of recent) {
    const k = merchantKey(r.merchant);
    if (!k) continue;
    const prior = (seen.get(k) ?? []).filter((p) => p.date < r.date);
    if (!prior.length) {
      if (r.amount >= o.newMerchantMin) out.push({ transaction_id: r.id, date: r.date, merchant: r.merchant, merchant_key: k, amount: r.amount, reason: 'new_merchant', norm: null });
      continue;
    }
    const spend = prior.filter((p) => p.amount < 0 && p.status === 'posted' && p.counts).map((p) => -p.amount);
    if (spend.length < o.normMinCount) continue;
    const norm = median(spend.slice(-12));
    const biggest = Math.max(...spend.slice(-24));
    if (r.amount >= Math.max(norm * o.normMultiple, norm + o.normMinOver) && r.amount > biggest * o.overMax) {
      out.push({ transaction_id: r.id, date: r.date, merchant: r.merchant, merchant_key: k, amount: r.amount, reason: 'above_norm', norm });
    }
  }
  return out;
}
