// A transaction on an account that was folded into another (accounts.merged_into,
// see lib/accountmerge.mjs) is a retired duplicate: kept, never deleted, but not
// part of the book. Any query that scans or totals transactions without joining
// accounts adds this; the ones that join accounts say `AND a.merged_into IS NULL`
// on the join instead. alias is the transactions table name or alias in the query.
export const LIVE = (alias = 't') => `${alias}.account_id NOT IN (SELECT id FROM accounts WHERE merged_into IS NOT NULL)`;
