// The screens the README images are shot from (scripts/gen-assets.mjs). A search here must find real
// spending, never transfer pairs: test/demo-seed.test.mjs holds that line. `today` is YYYY-MM-DD.
import { addDays } from '../lib/dates.mjs';

export function shotList({ today }) {
  return [
    ['home', '/'],
    ['transactions', '/transactions'],
    // a month of Woolworths: real rows and one Out total
    ['groceries', `/transactions?q=woolworths&direction=out&from=${addDays(today, -30)}&to=${today}`],
    ['plan', '/plan'],
    ['save', '/save'],
    ['reports', '/reports'],
    ['subs', '/plan?s=subs'],
    // Bills shows Netflix "up from $15.99"
    ['bills', '/plan?s=bills'],
  ];
}

// Which of the shots also get a desktop frame.
export const DESKTOP_SHOTS = ['home', 'transactions', 'groceries', 'plan'];
