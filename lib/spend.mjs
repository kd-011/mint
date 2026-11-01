// What counts as spend and income. A transaction is left out when it is one
// leg of a linked transfer (auto or confirmed) or sits in a transfer-kind
// category (an unmatched TRANSFER_* row, say). Queries using these fragments
// alias transactions as t, accounts as a and categories as c.
//
// v2: c is the category a row counts against. For a reimbursement (a friend
// paying the owner back, see lib/income.mjs) that is the spending category it pays
// back, so it nets off spend exactly like a refund; every other row counts
// against its own category. Income is salary and the regular payers only;
// other money in (gifts, interest, cashback) is reported apart.
export const LINKED = `EXISTS (SELECT 1 FROM transfers x WHERE x.status IN ('auto', 'confirmed') AND (x.out_tx = t.id OR x.in_tx = t.id))`;
export const COUNTS = `NOT ${LINKED} AND COALESCE(c.kind, '') != 'transfer'`;
export const BUSINESS = 'COALESCE(t.is_business, a.is_business)';
export const COUNT_CAT = "CASE WHEN t.income_kind = 'reimbursement' THEN t.offset_category_id ELSE t.category_id END";
export const FROM = `transactions t JOIN accounts a ON a.id = t.account_id AND a.merged_into IS NULL LEFT JOIN categories c ON c.id = ${COUNT_CAT}`;
export const KIND = "COALESCE(c.kind, CASE WHEN t.amount > 0 THEN 'income' ELSE 'expense' END)";
// A positive row the income pass has not classified yet still counts, as in v1.
export const INCOME = `(${KIND} = 'income' AND COALESCE(t.income_kind, 'salary') IN ('salary', 'regular'))`;
export const OTHER_IN = `(${KIND} = 'income' AND t.income_kind = 'other')`;
export const REIMBURSED = "(t.income_kind = 'reimbursement')";

// Budgets and spend reports also count a repayment into a loan, which COUNTS
// leaves out as a transfer. the owner pays the home loan from his own account, so
// the repayment is counted once, as the outgoing leg of a matched pair, or as
// the loan-account credit when no outgoing leg is matched (a doubtful pair
// waiting in review counts as neither: the outgoing leg keeps its own category).
// It files under "Home loan" and nothing else on the loan does: a drawdown
// is a debit in the Loan drawdown category, the interest charge is a debit.
// Safe to spend, the forecast and net worth keep COUNTS and FROM, since the
// bills calendar already carries the instalment.
// The week around a loan's start is settlement, not repayment (the borrower's
// own funds going in): same rule as loanFacts in debt.mjs. The start is the
// bank's original_start_date, else the first Loan drawdown seen on the loan.
const SETTLED = (la) => `date(COALESCE(json_extract(${la}.details_json, '$.loan_details.original_start_date'),
  (SELECT MIN(d.date) FROM transactions d JOIN categories dc ON dc.id = d.category_id WHERE d.account_id = ${la}.id AND dc.name = 'Loan drawdown')), '+7 days')`;
const AFTER_SETTLED = (la, date) => `${date} > COALESCE(${SETTLED(la)}, '0000-00-00')`;
const LOAN_OUT = `EXISTS (SELECT 1 FROM transfers x JOIN transactions i ON i.id = x.in_tx JOIN accounts la ON la.id = i.account_id
  WHERE x.status IN ('auto', 'confirmed') AND x.kind = 'loan_repayment' AND x.out_tx = t.id AND ${AFTER_SETTLED('la', 'i.date')})`;
// A credit that reads as a reversal, refund or adjustment (an interest reversal,
// a fee refund) is the bank giving money back, not a repayment.
const LOAN_IN = `(a.type = 'loan' AND t.amount > 0 AND ${AFTER_SETTLED('a', 't.date')}
  AND t.description NOT LIKE '%reversal%' AND t.description NOT LIKE '%refund%' AND t.description NOT LIKE '%adjust%'
  AND NOT EXISTS (SELECT 1 FROM transfers x WHERE x.in_tx = t.id AND x.out_tx IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM categories d WHERE d.id = t.category_id AND d.name = 'Loan drawdown'))`;
const LOAN_PAID = `(${LOAN_OUT} OR ${LOAN_IN})`;
export const HOME_LOAN = 'Home loan';
export const SPEND_FROM = `transactions t JOIN accounts a ON a.id = t.account_id AND a.merged_into IS NULL
  LEFT JOIN categories c ON c.id = CASE WHEN ${LOAN_PAID} THEN (SELECT id FROM categories WHERE name = '${HOME_LOAN}') ELSE ${COUNT_CAT} END`;
export const SPEND_COUNTS = `(NOT ${LINKED} OR (${LOAN_PAID} AND c.id IS NOT NULL)) AND COALESCE(c.kind, '') != 'transfer'`;
// A credit into a loan is money in; as spend it is the repayment, so its sign flips.
export const SPEND_AMT = `(CASE WHEN ${LOAN_IN} THEN -t.amount ELSE t.amount END)`;
