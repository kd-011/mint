// The order the owner sets on Home. A row is an account (its id), a manual asset
// (`asset_<id>`) or the share portfolio (`holdings`). Position is stored where
// the row lives: accounts.sort, manual_assets.sort, and the portfolio, which
// has no row of its own, in settings. Home sends every row it shows, so each
// gets its place in one list; the page keeps the section grouping and only
// reads the order within a section. Redbark sync inserts new accounts at the
// end and never updates sort (lib/ingest.mjs).
import { bad } from './errors.mjs';
import { tx, getSetting, setSetting } from './db.mjs';

export const MAX_ORDER = 200;
const HOLDINGS_KEY = 'home_sort_holdings';

export const holdingsSort = (db) => Number(getSetting(db, HOLDINGS_KEY)) || 0;

export function setHomeOrder(db, ids) {
  if (!Array.isArray(ids) || !ids.length) throw bad('ids must be a list of rows, in the order wanted');
  if (ids.length > MAX_ORDER) throw bad(`at most ${MAX_ORDER} rows`);
  if (ids.some((id) => typeof id !== 'string' || !id || id.length > 80) || new Set(ids).size !== ids.length) throw bad('ids must be unique strings');
  const plan = ids.map((id, i) => {
    if (id === 'holdings') return { id, kind: 'holdings', pos: i + 1 };
    const asset = /^asset_(\d{1,12})$/.exec(id);
    if (asset) {
      if (!db.prepare('SELECT 1 FROM manual_assets WHERE id = ?').get(Number(asset[1]))) throw bad(`no such asset: ${id}`);
      return { id: Number(asset[1]), kind: 'asset', pos: i + 1 };
    }
    if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND status IS NOT 'gone'").get(id)) throw bad(`no such account: ${id}`);
    return { id, kind: 'account', pos: i + 1 };
  });
  tx(db, () => {
    for (const p of plan) {
      if (p.kind === 'holdings') setSetting(db, HOLDINGS_KEY, p.pos);
      else if (p.kind === 'asset') db.prepare('UPDATE manual_assets SET sort = ? WHERE id = ?').run(p.pos, p.id);
      else db.prepare('UPDATE accounts SET sort = ? WHERE id = ?').run(p.pos, p.id);
    }
  });
  return { saved: plan.length };
}
