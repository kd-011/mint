// Save and Invest, home loan and offset. Built only from what Mint holds: the
// loan account's balance, the rate and terms Redbark gives, the repayments seen
// going in, the offset account's balance. A detail that is missing is listed in
// `missing` and left out of the maths; the owner can enter it (loan_inputs) and it
// fills the gap, but the bank's own value always wins. Nothing is guessed.
// The maths lives in loanmath.mjs.
import { bad, notFound } from './errors.mjs';
import { daysBetween, isIsoDate, perthDate } from './dates.mjs';
import { netWorth } from './networth.mjs';
import { loanFacts, loanInputsOf, centsParam, instalmentOf, repaymentFacts } from './debt.mjs';
import { projectLoan, balanceSchedule } from './loanmath.mjs';

const FREQUENCIES = ['monthly', 'fortnightly', 'weekly'];

export function homeLoan(db, { today, extraMonth = null } = {}) {
  const extra = centsParam(extraMonth, 'extra_month');
  const nw = netWorth(db);
  const rows = db.prepare("SELECT * FROM accounts WHERE type = 'loan' AND status IS NOT 'gone' AND hidden = 0 ORDER BY sort, name").all();
  return {
    as_of: today,
    items: rows.map((a) => {
      const f = loanFacts(db, a);
      const balance = Math.max(0, -(a.balance_current ?? 0));
      const off = nw.loans.find((l) => l.id === a.id);
      const offset = off?.offset_total ?? 0;
      const perMonth = f.repayment.amount == null ? null : Math.round((f.repayment.amount * f.freq.perYear) / 12);
      const endDate = f.details.loan_end_date;
      const termMonths = endDate ? Math.max(1, Math.round(daysBetween(today, endDate) / 30.4375)) : null;
      const item = {
        id: a.id, name: a.nickname || a.name, institution: a.institution, balance,
        offset: { enabled: f.details.offset_account_enabled ?? null, balance: offset, accounts: off?.offsets ?? [] },
        effective_balance: Math.max(0, balance - offset),
        rate: { value: f.rate, source: f.sources.rate },
        repayment: {
          amount: f.repayment.amount, frequency: f.freq.name, per_month: perMonth, source: f.sources.repayment,
          basis: f.repayment.basis, type: f.details.repayment_type ?? null, next_instalment_date: f.details.next_instalment_date ?? null,
          ...repaymentFacts(f),
        },
        instalment: instalmentOf(db, a, f),
        end_date: { value: endDate, source: f.sources.end_date },
        inputs: loanInputsOf(db, a.id),
        missing: [],
        interest: null, payoff: null, extra: null,
        chart: { basis: null, current: [], with_extra: [] },
      };
      if (f.rate == null) item.missing.push('rate');
      if (f.repayment.amount == null) item.missing.push('repayment');
      if (f.rate == null) return item;
      const p = projectLoan({ today, balance, offset, rate: f.rate, payment: perMonth, extra: extra ?? 0, termMonths });
      item.interest = p.interest;
      item.payoff = p.payoff;
      item.extra = p.extra;
      if (perMonth == null) { item.payoff = null; return item; }
      // An interest-only repayment never clears it; with no end date there is no
      // principal-and-interest line to compare against, so say so.
      if (p.payoff.amortising === false && termMonths == null) item.missing.push('end_date');
      const clears = p.payoff.amortising ? perMonth : p.payoff.principal_and_interest?.repayment_per_month;
      if (clears) {
        item.chart.basis = p.payoff.amortising ? 'current_repayment' : 'principal_and_interest_to_term';
        item.chart.current = balanceSchedule({ today, balance, offset, rate: f.rate, payment: clears });
        // Same sampling for both lines, so a table can put them side by side.
        const every = Math.max(1, Math.ceil((p.payoff.amortising ? p.payoff.months : p.payoff.principal_and_interest.months) / 60));
        if (extra) item.chart.with_extra = balanceSchedule({ today, balance, offset, rate: f.rate, payment: clears + extra, every });
      }
      return item;
    }),
    note: 'Cents. Rates are annual (0.0656 is 6.56%). Interest is on the balance less the offset at today\'s rate, and the offset is assumed to stay as it is.',
  };
}

// Enter the loan details Redbark does not give. Only the keys present change;
// null clears one. Returns what is stored.
export function setLoanInputs(db, accountId, body = {}) {
  const a = db.prepare('SELECT id, type FROM accounts WHERE id = ?').get(accountId);
  if (!a) throw notFound('no such account');
  if (a.type !== 'loan') throw bad('that is not a loan account');
  const cur = loanInputsOf(db, accountId);
  const next = { ...cur };
  let touched = false;
  if ('rate' in body) {
    const v = body.rate;
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 0.5)) throw bad('rate must be a decimal between 0 and 0.5, e.g. 0.0656 for 6.56%');
    next.rate = v;
    touched = true;
  }
  if ('repayment' in body) {
    const v = body.repayment;
    if (v !== null && (!Number.isInteger(v) || v <= 0 || v > 1e10)) throw bad('repayment must be whole cents, more than zero');
    next.repayment = v;
    touched = true;
  }
  if ('frequency' in body) {
    const v = body.frequency;
    if (v !== null && !FREQUENCIES.includes(v)) throw bad(`frequency must be one of ${FREQUENCIES.join(', ')}`);
    next.frequency = v;
    touched = true;
  }
  if ('end_date' in body) {
    const v = body.end_date;
    if (v !== null && (!isIsoDate(v) || v <= perthDate())) throw bad('end_date must be a real date in the future as YYYY-MM-DD');
    next.end_date = v;
    touched = true;
  }
  if (!touched) throw bad('nothing to change');
  if (Object.values(next).every((v) => v == null)) db.prepare('DELETE FROM loan_inputs WHERE account_id = ?').run(accountId);
  else {
    db.prepare(`INSERT INTO loan_inputs (account_id, rate, repayment, frequency, end_date, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET rate = excluded.rate, repayment = excluded.repayment, frequency = excluded.frequency, end_date = excluded.end_date, updated_at = excluded.updated_at`)
      .run(accountId, next.rate, next.repayment, next.frequency, next.end_date, new Date().toISOString());
  }
  return next;
}
