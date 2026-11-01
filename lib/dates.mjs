// Calendar helpers. Mint lives in Australia/Perth (UTC+8, no DST); dates are
// stored as YYYY-MM-DD and shown as DD/MM/YYYY.
const PERTH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth', year: 'numeric', month: '2-digit', day: '2-digit' });
const PERTH_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Perth', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const perthDate = (d = new Date()) => PERTH.format(d);

// Minutes since Perth midnight, for the scheduler.
export function perthMinutes(d = new Date()) {
  const [h, m] = PERTH_HM.format(d).split(':').map(Number);
  return h * 60 + m;
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Redbark answers from_too_old for anything past about seven years, so the
// backfill starts seven years back plus a week of margin.
export function oldestAllowedFrom(today) {
  const [y, m, d] = today.split('-').map(Number);
  const back = new Date(Date.UTC(y - 7, m - 1, d));
  if (back.getUTCMonth() !== m - 1) back.setUTCDate(0); // 29 Feb to 28 Feb
  return addDays(back.toISOString().slice(0, 10), 7);
}

export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
export const fmtDMY = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
// Strict: 2027-02-30 is not a date (Date.parse would roll it to 2 March).
export const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
