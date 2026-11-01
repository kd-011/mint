// What the scheduler tick should run now, as a pure rule so it can be tested across daylight
// saving. The nightly reconcile is due once per local day, from 02:40 on that day's clock (on a
// day that skips 02:00 to 03:00 it runs when the clock first passes 02:40, so at 03:00); the poll
// is plain elapsed time, so a clock change never double-fires or skips it.
import { zoneDate, zoneMinutes } from './dates.mjs';

export const POLL_MS = 30 * 60 * 1000;
export const RECONCILE_AT = 2 * 60 + 40;

export function dueSync({ now, lastReconcile, lastPoll }) {
  if (zoneMinutes(now) >= RECONCILE_AT && (!lastReconcile || zoneDate(new Date(lastReconcile)) !== zoneDate(now))) return 'reconcile';
  if (!lastPoll || now - Date.parse(lastPoll) >= POLL_MS) return 'poll';
  return null;
}
