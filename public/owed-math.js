// Owed to me: the pure side. Who owes what, from the list of debts alone, so
// the server (lib/owed.mjs), the page and the tests all agree and the screen
// can tally offline. No DOM. Money is whole cents, dates are YYYY-MM-DD.
'use strict';

// Names group case-insensitively, trimmed, with runs of spaces collapsed.
const owedKey = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// A debt row needs { amount, repaid, closed, due_on }. closed is null,
// 'settled' or 'written_off'. A debt is settled when repaid covers it, or by
// hand; a hand-closed one owes nothing but remembers what was let go.
function owedState(d, today) {
  const left = Math.max(0, d.amount - (d.repaid ?? 0));
  if (d.closed === 'written_off') return { status: 'written_off', outstanding: 0, overdue: false, written_off: left };
  if (d.closed === 'settled' || left === 0) return { status: 'settled', outstanding: 0, overdue: false, written_off: 0 };
  return { status: 'open', outstanding: left, overdue: !!d.due_on && d.due_on < today, written_off: 0 };
}

const owedView = (d, today) => ({ ...d, ...owedState(d, today) });

// Which way a debt runs: 'owed_to_me' (the default, so old rows and callers
// that never heard of direction keep working) or 'i_owe'.
const owedDir = (d) => (d.direction === 'i_owe' ? 'i_owe' : 'owed_to_me');

// People and the grand totals from a list of debt rows (archived ones left out).
// `outstanding` stays what they owe the owner; `i_owe` is what the owner owes them and
// `net` is the two together (above zero they owe him). Overdue counts only
// money owed to the owner. A person's display name is the spelling on their newest debt.
function owedTally(items, today) {
  const people = new Map();
  for (const d of [...items].filter((x) => !x.archived).sort((x, y) => x.id - y.id)) {
    const key = owedKey(d.person);
    const s = owedState(d, today);
    const p = people.get(key) ?? { key, name: d.person.trim(), outstanding: 0, i_owe: 0, net: 0, open_count: 0, owe_open_count: 0, debts: 0, oldest_open: null, overdue_count: 0, overdue_amount: 0 };
    p.name = d.person.trim().replace(/\s+/g, ' ');
    p.debts += 1;
    if (s.status === 'open') {
      if (owedDir(d) === 'i_owe') {
        p.i_owe += s.outstanding;
        p.owe_open_count += 1;
      } else {
        p.outstanding += s.outstanding;
        p.open_count += 1;
        if (s.overdue) { p.overdue_count += 1; p.overdue_amount += s.outstanding; }
      }
      if (!p.oldest_open || d.lent_on < p.oldest_open) p.oldest_open = d.lent_on;
    }
    people.set(key, p);
  }
  for (const p of people.values()) p.net = p.outstanding - p.i_owe;
  const list = [...people.values()].sort((x, y) => y.net - x.net || x.name.localeCompare(y.name));
  const total_outstanding = list.reduce((s, p) => s + p.outstanding, 0);
  const total_i_owe = list.reduce((s, p) => s + p.i_owe, 0);
  return {
    total_outstanding,
    total_i_owe,
    net: total_outstanding - total_i_owe,
    overdue_total: list.reduce((s, p) => s + p.overdue_amount, 0),
    people: list,
  };
}

// Every name used, newest first, one spelling per person (the person field suggests these).
function owedNames(items) {
  const seen = new Set();
  const out = [];
  for (const d of [...items].sort((x, y) => y.id - x.id)) {
    const key = owedKey(d.person);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d.person.trim().replace(/\s+/g, ' '));
  }
  return out;
}

// The debt as it reads once `payment` is in, for the offline screen.
const owedWithPayment = (d, payment) => ({ ...d, repaid: (d.repaid ?? 0) + payment.amount, payments: [payment, ...(d.payments ?? [])] });

if (typeof module !== 'undefined' && module.exports) module.exports = { owedKey, owedDir, owedState, owedView, owedTally, owedNames, owedWithPayment };
