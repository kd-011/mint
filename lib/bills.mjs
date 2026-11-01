// The bills calendar: every expected bill and subscription (lib/recurring.mjs)
// over the next six weeks, plus home loan instalments from the loan details,
// marked inside or outside the current pay cycle and paid or still to come.
// A loan instalment counts as paid when a repayment landed in this cycle in
// the period before it. No credit card statement estimate: Redbark gives no
// statement balance or due date, and Mint does not guess one.
import { bad } from './errors.mjs';
import { addDays } from './dates.mjs';
import { detectRecurring, addMonths } from './recurring.mjs';
import { currentCycle } from './cycles.mjs';
import { loanFacts } from './debt.mjs';
import { LIVE } from './live.mjs';

const step = (cadenceMonths, days) => (iso, k) => (cadenceMonths ? addMonths(iso, cadenceMonths * k) : addDays(iso, days * k));
const MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };

export function billsCalendar(db, { today, days = 42 } = {}) {
  if (!Number.isInteger(days) || days < 7 || days > 120) throw bad('days must be 7 to 120');
  const to = addDays(today, days - 1);
  const cycle = currentCycle(db, { today });
  const inCycle = (d) => !!cycle && d >= cycle.start && d <= cycle.end;
  const items = [];

  // Business bills are not the owner's personal money plan.
  const business = new Set(db.prepare('SELECT id FROM accounts WHERE is_business = 1').all().map((a) => a.id));
  for (const s of detectRecurring(db, today)) {
    if (!s.active || business.has(s.account_id)) continue;
    const base = { kind: s.kind, merchant: s.merchant, merchant_key: s.merchant_key, cadence: s.cadence, category: s.category, category_id: s.category_id, account_id: s.account_id, price_change: s.price_rise };
    if (cycle) for (const r of s.recent) if (r.date >= cycle.start && r.date <= today) items.push({ ...base, date: r.date, amount: r.amount, status: 'paid', in_cycle: true });
    const at = step(MONTHS[s.cadence], s.interval_days);
    // One the owner typed in has a next date to start from; a detected one counts on from its last charge.
    const from = s.anchor_date ?? s.last_date;
    for (let k = s.anchor_date ? 0 : 1; k < 200; k++) {
      const d = at(from, k);
      if (d > to) break;
      items.push({ ...base, date: d, amount: s.amount, status: 'due', overdue: d < today, in_cycle: inCycle(d) });
    }
  }

  for (const a of db.prepare("SELECT * FROM accounts WHERE type = 'loan' AND status IS NOT 'gone' AND hidden = 0").all()) {
    const f = loanFacts(db, a);
    const next = f.details.next_instalment_date;
    if (!next) continue;
    const months = f.freq.perYear === 12 ? 1 : null;
    const at = step(months, f.freq.perYear === 26 ? 14 : 7);
    const paid = cycle ? db.prepare(`SELECT i.date, i.amount FROM transfers x JOIN transactions i ON i.id = x.in_tx
      WHERE x.status IN ('auto', 'confirmed') AND i.account_id = ? AND ${LIVE('i')} AND i.amount > 0 AND i.date >= ? AND i.date <= ? ORDER BY i.date`).all(a.id, cycle.start, today) : [];
    const used = new Set();
    const base = { kind: 'loan', merchant: `${a.nickname || a.name} repayment`, merchant_key: `loan:${a.id}`, cadence: f.freq.name, category: null, category_id: null, account_id: a.id, price_change: null, amount_basis: f.repayment.basis };
    for (let k = 0; k < 60; k++) {
      const d = at(next, k);
      if (d > to) break;
      const prev = at(next, k - 1);
      const cover = paid.findIndex((p, i) => !used.has(i) && p.date > prev && p.date <= d);
      if (cover >= 0) {
        used.add(cover);
        items.push({ ...base, date: d, amount: paid[cover].amount, status: 'paid', paid_on: paid[cover].date, in_cycle: inCycle(paid[cover].date) });
      } else if (d >= today) {
        items.push({ ...base, date: d, amount: f.repayment.amount, status: 'due', overdue: false, in_cycle: inCycle(d) });
      }
    }
    // Repayments this cycle that no listed instalment took: still money gone to the loan.
    paid.forEach((p, i) => { if (!used.has(i)) items.push({ ...base, date: p.date, amount: p.amount, status: 'paid', paid_on: p.date, in_cycle: true, extra_repayment: true }); });
  }

  items.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.merchant.localeCompare(y.merchant)));
  const sum = (pred) => items.filter(pred).reduce((s, i) => s + (i.amount ?? 0), 0);
  return {
    from: today, to,
    cycle: cycle ? { start: cycle.start, end: cycle.end, next_payday: cycle.next_payday } : null,
    items,
    totals: {
      in_cycle: { paid: sum((i) => i.in_cycle && i.status === 'paid'), due: sum((i) => i.in_cycle && i.status === 'due') },
      due_in_window: sum((i) => i.status === 'due'),
    },
    card_statement: null,
    card_statement_note: 'Credit cards have no statement balance or due date on file, so there is no estimate.',
  };
}
