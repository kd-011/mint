// Saved views on Transactions: a filter set kept under a name. The id is chosen
// by the page (so a view made offline can be renamed or deleted before it ever
// reaches the server) and creating an id that already exists is a no-op that
// answers the stored row, which makes a replayed queued write harmless.
import { bad, notFound, HttpError } from './errors.mjs';
import { isIsoDate } from './dates.mjs';

export const VIEW_FILTER_KEYS = ['q', 'account', 'category', 'from', 'to', 'business', 'tax', 'direction', 'source'];
export const MAX_VIEWS = 30;
const ID = /^[a-z0-9]{6,32}$/;
const ENUMS = { business: ['0', '1'], tax: ['0', '1'], direction: ['in', 'out'], source: ['rule', 'ai', 'manual', 'provider'] };

export function cleanName(v) {
  const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw bad('name is required');
  if (name.length > 40) throw bad('name must be 40 characters or fewer');
  return name;
}

// Only the keys the list understands, each checked as the list checks it, so a saved view can never 400 when applied.
export function cleanFilters(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad('filters must be an object');
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    if (!VIEW_FILTER_KEYS.includes(k)) throw bad(`unknown filter ${k}`);
    if (v == null || v === '') continue;
    if (typeof v !== 'string') throw bad(`${k} must be text`);
    if (k === 'q' && v.length > 100) throw bad('search too long');
    if (k === 'account' && !/^(acct_[A-Za-z0-9_]{1,64}|man_[a-f0-9]{16})$/.test(v)) throw bad('bad account id');
    if (k === 'category' && v !== 'none' && !/^[1-9]\d{0,9}$/.test(v)) throw bad('category must be a category id or none');
    if ((k === 'from' || k === 'to') && !isIsoDate(v)) throw bad(`${k} must be YYYY-MM-DD`);
    if (ENUMS[k] && !ENUMS[k].includes(v)) throw bad(`${k} must be ${ENUMS[k].join(', ')}`);
    out[k] = v;
  }
  if (!Object.keys(out).length) throw bad('a view needs at least one filter');
  return out;
}

const view = (r) => ({ id: r.id, name: r.name, filters: JSON.parse(r.filters), sort: r.sort, created_at: r.created_at, updated_at: r.updated_at });
const nowIso = () => new Date().toISOString();

export function listViews(db) {
  return db.prepare('SELECT * FROM saved_views ORDER BY sort, created_at, id').all().map(view);
}

function nameTaken(db, name, exceptId = null) {
  return !!db.prepare('SELECT 1 FROM saved_views WHERE name = ? COLLATE NOCASE AND id IS NOT ?').get(name, exceptId);
}

export function createView(db, body) {
  const name = cleanName(body?.name);
  const filters = cleanFilters(body?.filters);
  const id = body?.id == null ? Math.random().toString(36).slice(2, 12).padEnd(6, '0') : body.id;
  if (typeof id !== 'string' || !ID.test(id)) throw bad('id must be 6 to 32 lowercase letters and digits');
  const existing = db.prepare('SELECT * FROM saved_views WHERE id = ?').get(id);
  if (existing) return view(existing);
  if (nameTaken(db, name)) throw new HttpError(409, 'a view with that name already exists');
  if (db.prepare('SELECT count(*) n FROM saved_views').get().n >= MAX_VIEWS) throw bad(`keep to ${MAX_VIEWS} saved views or fewer`);
  const sort = (db.prepare('SELECT max(sort) m FROM saved_views').get().m ?? -1) + 1;
  const t = nowIso();
  db.prepare('INSERT INTO saved_views (id, name, filters, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, JSON.stringify(filters), sort, t, t);
  return view(db.prepare('SELECT * FROM saved_views WHERE id = ?').get(id));
}

export function updateView(db, id, body) {
  const row = db.prepare('SELECT * FROM saved_views WHERE id = ?').get(id);
  if (!row) throw notFound('no such view');
  if (!body || !['name', 'filters'].some((k) => k in body)) throw bad('nothing to change');
  const name = 'name' in body ? cleanName(body.name) : row.name;
  const filters = 'filters' in body ? cleanFilters(body.filters) : JSON.parse(row.filters);
  if (nameTaken(db, name, id)) throw new HttpError(409, 'a view with that name already exists');
  db.prepare('UPDATE saved_views SET name = ?, filters = ?, updated_at = ? WHERE id = ?').run(name, JSON.stringify(filters), nowIso(), id);
  return view(db.prepare('SELECT * FROM saved_views WHERE id = ?').get(id));
}

// Deleting one that is already gone is fine: a replayed queued delete must not fail.
export function deleteView(db, id) {
  db.prepare('DELETE FROM saved_views WHERE id = ?').run(id);
  return { deleted: true };
}
