// Display merchant from what the bank sends. Redbark's merchant_name is often
// empty, so most merchants come from the description: drop the card and
// EFTPOS prefixes (V1234 10/06, EFTPOS 25/12 00:55, ONLINE A123456789),
// payment-facilitator prefixes (SQ *, PAYPAL *), trailing reference numbers
// and BNPL instalment tails, keep the first fixed-width column, and soften
// ALL CAPS. Rules match on this and on the raw description.
const PREFIXES = [
  /^V\d{4}\s+\d{2}\/\d{2}\s+/i,
  /^EFTPOS\s+\d{2}\/\d{2}\s+\d{2}:\d{2}\s*/i,
  /^ONLINE\s+[A-Z]\d{6,}\s+/i,
  /^(AUTHORISATION ONLY|AUTHORIZATION ONLY|VISA PURCHASE|EFTPOS PURCHASE|EFTPOS|POS AUTHORISATION|PURCHASE)\s*-?\s*/i,
];
const FACILITATOR = /^(SQ|ZLR|PAYPAL|PP|GPAY|SMP|IZ|LSP|TST)\s*\*\s*/i;
const TAILS = [
  /\s+\d{4}-\d{2}-\d{2}\s+(repayment\s+)?\d+\s+of\s+\d+$/i, // BNPL "2025-04-22 2 of 4"
  /\s+\+\d+$/, // "+188"
  /\s+\d{8,}$/, // card reference
  /(?<=[A-Za-z])\d{8,}$/, // an account number glued on: "ADS9824928654"
  /\s+\d+(-\d+)+$/, // phone number
  /\s+(AU|AUS)$/,
];

const strip = (s, list) => {
  for (let changed = true; changed;) {
    changed = false;
    for (const re of list) {
      const next = s.replace(re, '').trim();
      if (next !== s && next) { s = next; changed = true; }
    }
  }
  return s;
};

// ALL CAPS words become Title Case; mixed-case words are left alone.
const soften = (s) => s.replace(/[^\s]+/g, (w) => (/[A-Z]{2}/.test(w) && w === w.toUpperCase()
  ? w.toLowerCase().replace(/(^|[(/&-])([a-z])/g, (_, a, b) => a + b.toUpperCase())
  : w));

const tidy = (s) => {
  let t = String(s ?? '').trim();
  if (!t) return '';
  t = strip(t, PREFIXES);
  t = t.split(/\s{2,}/)[0].trim();
  t = t.replace(FACILITATOR, '').trim() || t;
  const star = t.indexOf('*');
  if (star > 1) t = t.slice(0, star).trim();
  t = strip(t, TAILS).replace(/\\+$/, '').trim();
  return soften(t);
};

// Bump when the derivation changes: the engine re-derives stored merchants once.
export const MERCHANT_VERSION = 2;

// Redbark's merchant_name names the payment facilitator for these, which
// hides the real merchant, so the description wins.
const FACILITATOR_NAMES = /^(square|paypal|google australia|afterpay|zip|zip pay|stripe|zeller|sumup|tyro)$/i;

export function deriveMerchant(description, merchantName) {
  const named = FACILITATOR_NAMES.test(String(merchantName ?? '').trim()) ? '' : tidy(merchantName);
  return named || tidy(description);
}

// Pay-in-4 style instalments ("2 of 4"): finite plans, not subscriptions.
export const isInstalment = (description) => /\b\d+\s+of\s+\d+\s*$/i.test(String(description ?? '').trim());

// The merchant without a trailing "(branch)", for correction rules.
export const merchantBase = (m) => String(m ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();

// Grouping key: case, punctuation, branch and store numbers ignored, so
// "Test Cafe (Testville)" and "TEST CAFE 7" land together.
export function merchantKey(m) {
  return String(m ?? '').toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\d{4,}/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !/^\d+$/.test(w))
    .join(' ');
}
