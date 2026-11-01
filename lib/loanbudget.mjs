// The Home loan budget line, made once. The target is what the owner actually pays
// (loanFacts: the middle of the last three repayments, never a guess), as a
// monthly figure, scaled to the pay cycle like every other monthly bill. Fixed,
// no rollover: a negative carry would make the cycle after an instalment read
// as overspent with nothing spent. Made once, so a line the owner deletes stays gone.
import { getSetting, setSetting } from './db.mjs';
import { setBudget } from './budgets.mjs';
import { loanFacts } from './debt.mjs';
import { HOME_LOAN } from './spend.mjs';

const KEY = 'home_loan_budget';

export function seedHomeLoanBudget(db) {
  if (getSetting(db, KEY)) return 0;
  const cat = db.prepare('SELECT id FROM categories WHERE name = ? AND archived = 0').get(HOME_LOAN);
  if (!cat) return 0;
  const done = () => setSetting(db, KEY, '1');
  if (db.prepare('SELECT 1 FROM budgets WHERE category_id = ?').get(cat.id)) { done(); return 0; }
  const loans = db.prepare("SELECT * FROM accounts WHERE type = 'loan' AND status IS NOT 'gone' AND hidden = 0").all();
  const monthly = loans.reduce((sum, a) => {
    const f = loanFacts(db, a);
    return f.repayment.amount == null ? sum : sum + Math.round((f.repayment.amount * f.freq.perYear) / 12);
  }, 0);
  if (monthly <= 0) return 0;
  setBudget(db, cat.id, { monthly_target: monthly, fixed: true, rollover: false }, { source: 'starter' });
  done();
  return 1;
}
