import { LIVE } from './live.mjs';
// the owner's own name, from the salary description ("SALARY/WAGES JANE CITIZEN").
// A credit carrying it (his name, surname and first initial, or first name and
// surname initial as banks print a payer: "MS JANE QUINN C") is his own
// money from elsewhere, not a friend paying him back.
export function ownerTest(db) {
  const d = db.prepare("SELECT t.description FROM transactions t JOIN income_sources s ON s.id = t.income_source_id WHERE s.kind = 'salary' AND " + LIVE() + " ORDER BY t.date DESC LIMIT 1").get()?.description
    ?? db.prepare("SELECT description FROM transactions WHERE amount > 0 AND description LIKE 'SALARY/WAGES%' AND " + LIVE('transactions') + " ORDER BY date DESC LIMIT 1").get()?.description;
  const words = String(d ?? '').replace(/^SALARY\/WAGES\s*/i, '').toUpperCase().split(/\s+/).filter((w) => /^[A-Z]{2,}$/.test(w));
  if (words.length < 2) return () => false;
  const first = words[0];
  const last = words.at(-1);
  const has = (text, w) => new RegExp(`(^|[^A-Z])${w}([^A-Z]|$)`).test(text);
  const initial = (text, w) => new RegExp(`(^|\\s)${w[0]}(\\s|$)`).test(text);
  return (text) => {
    const t = ` ${String(text ?? '').toUpperCase()} `;
    return (has(t, last) && (has(t, first) || initial(t, first))) || (has(t, first) && initial(t, last));
  };
}

// the owner sending money to himself: his name on a credit the bank words as a
// transfer ("... CREDIT TO ACCOUNT"), even when the bank files it as income.
// Pay, tax refunds and the like carry his name too and are never this.
const TRANSFER_WORDS = /\b(CREDIT TO ACC|TRANSFER|TFR|TRNS|TRANS)/i;
const NOT_OWN_TRANSFER = /\b(SALARY|WAGES|PAYROLL|ROSTER|ATO|REFUND|DIVIDEND|INTEREST|GIFT)/i;
export function ownTransferTest(db) {
  const isOwner = ownerTest(db);
  return (text) => TRANSFER_WORDS.test(text ?? '') && !NOT_OWN_TRANSFER.test(text ?? '') && isOwner(text);
}
