// Makes a resent chat question safe. The page tags each question with a request
// id and sends the same id on Retry. The chat proxy tells this module which
// question is in flight (begin/end); a safe write the assistant makes meanwhile through
// the door is journaled under that id (guard). When the same question comes back
// and the assistant makes the same write again, the journaled answer is returned, undo
// token and all, and nothing is written twice.
//
// The assistant does not say which question a write belongs to, so Mint attributes by
// time: the one question in flight, or the latest one for a few minutes after its
// stream ended (the assistant can keep working after the page dropped). Two different
// questions in flight at once are ambiguous and are not attributed. Only a write
// whose undo is still open replays; one undone since is applied afresh. Rows are
// kept for the undo window.
import { createHash } from 'node:crypto';
import { UNDO_MS, undoOpen } from './undo.mjs';

export const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;
const GRACE_MS = 5 * 60_000;

const stable = (v) => (v && typeof v === 'object'
  ? Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  : JSON.stringify(v) ?? 'null');
const fingerprint = (name, params) => createHash('sha256').update(`${name}\0${stable(params)}`).digest('hex').slice(0, 32);

export function createChatTurns({ db, now = () => Date.now() }) {
  const live = new Set();
  let last = null;

  // A new attempt at question rid. Returns the function that ends it.
  function begin(rid) {
    const t = { rid, ended: 0, seen: new Map() };
    live.add(t);
    last = t;
    return () => { live.delete(t); t.ended = now(); };
  }

  function current() {
    const rids = new Set([...live].map((t) => t.rid));
    if (rids.size > 1) return null;
    if (live.size) return last && live.has(last) ? last : [...live].at(-1);
    return last && now() - last.ended < GRACE_MS ? last : null;
  }

  // Runs write() unless this exact write was already made for this question.
  // write() answers { status, body }; only an applied write with an undo is journaled.
  function guard(name, params, write) {
    const t = current();
    if (!t) return write();
    const fp = fingerprint(name, params);
    const k = t.seen.get(fp) ?? 0;
    t.seen.set(fp, k + 1);
    const rows = db.prepare('SELECT n, status, body FROM chat_turn_writes WHERE rid = ? AND fp = ? ORDER BY n').all(t.rid, fp);
    const prior = rows[k];
    if (prior) {
      const body = JSON.parse(prior.body);
      if (undoOpen(db, body.undo?.token, { now: now() })) return { status: prior.status, body: { ...body, replayed: true } };
    }
    const out = write();
    if (out.status < 300 && out.body?.undo) {
      const at = new Date(now()).toISOString();
      if (prior) db.prepare('UPDATE chat_turn_writes SET status = ?, body = ?, created_at = ? WHERE rid = ? AND fp = ? AND n = ?').run(out.status, JSON.stringify(out.body), at, t.rid, fp, prior.n);
      else {
        db.prepare('DELETE FROM chat_turn_writes WHERE created_at < ?').run(new Date(now() - UNDO_MS).toISOString());
        db.prepare('INSERT INTO chat_turn_writes (rid, fp, n, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(t.rid, fp, rows.length, out.status, JSON.stringify(out.body), at);
      }
    }
    return out;
  }

  return { begin, current, guard };
}
