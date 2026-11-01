// Pure helpers for the pay-cycle screens: labels, pace, split totals, bills
// grouped by cycle. No DOM, so the same file runs in the page and in tests.
'use strict';

const CM_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CM_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const cmUtc = (iso) => new Date(`${iso}T00:00:00Z`);
const cmAdd = (iso, n) => { const d = cmUtc(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// 'Wed 21 Oct'
function shortDay(iso) {
  const d = cmUtc(iso);
  return `${CM_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${CM_MONTHS[d.getUTCMonth()]}`;
}

// 'Wed 7 Oct to Tue 20 Oct'; the year rides on the end only when the cycle crosses New Year.
function cycleLabel(c) {
  const crosses = c.start.slice(0, 4) !== c.end.slice(0, 4);
  return `${shortDay(c.start)} to ${shortDay(c.end)}${crosses ? ` ${c.end.slice(0, 4)}` : ''}`;
}

// How far through the cycle today is, 0 to 100. A closed cycle is all the way through,
// and a late payday holds the marker at the end rather than running past it.
function paceMarker(c) {
  if (!c.open) return 100;
  return Math.max(0, Math.min(100, Math.round((c.day / c.days) * 100)));
}

// under / on / ahead / over (budget gone) / none (no target to judge against).
function paceStatus({ spent, target, cycle }) {
  if (!(target > 0)) return 'none';
  const pct = (spent / target) * 100;
  if (pct > 100) return 'over';
  const marker = paceMarker(cycle);
  if (pct > marker + 10) return 'ahead';
  if (pct < marker - 10) return 'under';
  return 'on';
}

const fromPercent = (pct, pay) => Math.round((pay * pct) / 100);
const toPercent = (amount, pay) => (pay > 0 ? Math.round((amount / pay) * 1000) / 10 : 0);

// Planned total for a split editor: a line is an amount or a percent of the pay.
function splitTotals(lines, pay) {
  const planned = lines.reduce((s, l) => s + (l.amount != null ? l.amount : l.percent != null ? fromPercent(l.percent, pay) : 0), 0);
  return { planned, left: pay - planned, over: planned > pay, percent: pay > 0 ? Math.round((planned / pay) * 100) : 0 };
}

// Share of income kept over some cycles, as a whole percent; null when there is no income yet.
function savingsRate(cycles) {
  const income = cycles.reduce((s, c) => s + c.income, 0);
  if (!(income > 0)) return null;
  return Math.round(((income - cycles.reduce((s, c) => s + c.spent, 0)) / income) * 100);
}

// Bills (from /api/bills) grouped under the pay cycle they fall in. The open cycle's
// end and next payday anchor the grid; later cycles step by the pay cadence.
// A paid instalment sits where it was paid, not where it fell due.
const billWhen = (b) => (b.status === 'paid' && b.paid_on ? b.paid_on : b.date);
function groupByCycle(items, cycle, cadence = 14) {
  const groups = [];
  let start = cycle.start;
  let end = cycle.end;
  const last = items.length ? items.reduce((m, b) => (b.date > m ? b.date : m), end) : end;
  for (let i = 0; i < 8; i++) {
    groups.push({ start, end, items: items.filter((b) => billWhen(b) >= start && billWhen(b) <= end), current: i === 0 });
    if (end >= last) break;
    start = cmAdd(end, 1);
    end = cmAdd(start, cadence - 1);
  }
  return groups;
}

// A server reason ('the repayment does not cover the interest') as a sentence.
function asSentence(s) {
  const t = String(s ?? '').trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : '';
}

// The loan rows that say what the owner actually paid: whether the bank's next
// instalment is paid (when, how much), the last repayment, and the bank's own
// figure beside his. fmt formats cents. [{ label, value, tone }], tone pos or warn or ''.
function loanPaidRows(l, fmt) {
  const day = (iso) => shortDay(iso).slice(4);
  const rows = [];
  const r = l.repayment ?? {};
  const i = l.instalment;
  if (i) {
    rows.push(i.status === 'paid'
      ? { label: `Instalment ${day(i.due_date)}`, value: `Paid ${day(i.paid_on)}, ${fmt(i.amount)}`, tone: 'pos' }
      : { label: `Instalment ${day(i.due_date)}`, value: i.amount == null ? 'Not paid yet' : `Not paid yet, ${fmt(i.amount)}`, tone: '' });
  }
  if (r.last_paid && !(i && i.status === 'paid' && i.paid_on === r.last_paid.date)) {
    rows.push({ label: 'Last repayment', value: `${fmt(r.last_paid.amount)}, ${day(r.last_paid.date)}`, tone: '' });
  }
  const s = r.scheduled;
  if (s && s.amount != null && s.amount !== r.amount) {
    rows.push({ label: s.basis === 'bank' ? "Bank's instalment" : 'Interest last charged', value: fmt(s.amount), tone: '' });
  }
  return rows;
}

// The budget editor always edits the per-pay-cycle target. On the monthly roll-up an item's
// `target` is the monthly figure (cycle x 26 / 12), so the editor is given the item's own
// `cycle_target` instead; converting the month figure back would drift and be the wrong unit.
function budgetForEditor(item, basis) {
  return item && basis === 'month' ? { ...item, target: item.cycle_target } : item;
}

// The item as it reads after a save of `body` ({ cycle_target, fixed, rollover }), for the offline path.
function budgetAfterEdit(item, basis, body) {
  const monthly = Math.round((body.cycle_target * 26) / 12);
  const target = basis === 'month' ? monthly : body.cycle_target;
  const available = target + (item.carried ?? 0);
  return {
    ...item, target, cycle_target: body.cycle_target, monthly_target: monthly, available, rollover: body.rollover, fixed: body.fixed, source: 'manual',
    remaining: available - item.spent, pct: available > 0 ? Math.round((item.spent / available) * 100) : 0, over: item.spent > available,
  };
}

// Zero-based Ready to assign after one budget's target moved from `was` to `now`
// (null `now` is a delete): the same arithmetic the server does, so an offline or
// optimistic edit moves the figure before the server has answered.
function zeroAfterEdit(z, was, now) {
  if (!z) return z;
  const assigned = z.assigned - (was ?? 0) + (now ?? 0);
  const ready = z.income - z.set_aside - assigned - z.carried_overspend.total;
  return { ...z, assigned, ready, state: ready === 0 ? 'zero' : ready > 0 ? 'unassigned' : 'over_assigned' };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { zeroAfterEdit, budgetForEditor, budgetAfterEdit, shortDay, cycleLabel, paceMarker, paceStatus, fromPercent, toPercent, splitTotals, groupByCycle, savingsRate, loanPaidRows, asSentence };
