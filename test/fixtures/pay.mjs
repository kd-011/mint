// Pay-cycle fixtures on top of book(): an invented fortnightly salary into the
// everyday account, an invented regular payer into the offset, and helpers to
// run the money pipeline the engine runs. Nothing here is real account data.
import { book } from './book.mjs';
import { applyRules } from '../../lib/categorise.mjs';
import { matchTransfers } from '../../lib/transfers.mjs';
import { runIncome } from '../../lib/income.mjs';

export const PAYDAYS = ['2026-07-15', '2026-07-29', '2026-08-12', '2026-08-26', '2026-09-09', '2026-09-23', '2026-10-07'];
export const PAY_AMOUNTS = [249000, 251000, 250000, 230000, 220000, 225000, 226000];
export const SALARY = 'SALARY/WAGES TEST PERSON';
export const PAY_ACCOUNT = 'acct_t_everyday';

export function payBook({ paydays = PAYDAYS, amounts = PAY_AMOUNTS } = {}) {
  const b = book();
  paydays.forEach((d, i) => b.add(PAY_ACCOUNT, d, amounts[i] ?? amounts.at(-1), SALARY, { provider_category: 'INCOME' }));
  return b;
}

// What the engine does after a sync, minus the alerts and the model.
export function refreshMoney(b, today = '2026-10-17') {
  applyRules(b.db);
  matchTransfers(b.db);
  return runIncome(b.db, { today });
}

// A transfer between two of the fixture accounts that the matcher will link.
export function transfer(b, from, to, date, amount) {
  const o = b.add(from, date, -amount, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_OUT' });
  const i = b.add(to, date, amount, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_IN' });
  return { o, i };
}

export const setCat = (b, id, name) => b.db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(b.cat(name), id);
