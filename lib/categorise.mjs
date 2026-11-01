// Categorisation. Precedence per transaction: the owner's manual pick, then the
// first matching rule (lowest priority number, newest on a tie), then the
// model's cached answer for the merchant, then Redbark's provider_category.
// Rules run on ingest and re-run over history whenever a rule changes.
import { tx } from './db.mjs';
import { bad, notFound } from './errors.mjs';
import { merchantKey, merchantBase } from './merchant.mjs';
import { providerCategoryName, isTransferHint } from './categories.mjs';
import { LINKED } from './spend.mjs';
import { LIVE } from './live.mjs';

const FIELDS = ['description', 'merchant'];
const MATCHES = ['contains', 'starts', 'exact', 'regex'];
const RULE_COLS = 'id, field, match, pattern, account_id, category_id, set_merchant, amount_min, amount_max, priority, source, hits, created_at';

const isInt = (v) => Number.isInteger(v) && Math.abs(v) < 1e13;

function compile(rule) {
  const p = rule.pattern.toLowerCase();
  const re = rule.match === 'regex' ? new RegExp(rule.pattern, 'i') : null;
  return (row) => {
    if (rule.account_id && row.account_id !== rule.account_id) return false;
    if (rule.amount_min != null && row.amount < rule.amount_min) return false;
    if (rule.amount_max != null && row.amount > rule.amount_max) return false;
    const text = String((rule.field === 'merchant' ? row.merchant : row.description) ?? '').trim();
    if (re) return re.test(text);
    const t = text.toLowerCase();
    return rule.match === 'contains' ? t.includes(p) : rule.match === 'starts' ? t.startsWith(p) : t === p;
  };
}

function loadRules(db) {
  return db.prepare(`SELECT ${RULE_COLS} FROM rules WHERE category_id IS NOT NULL ORDER BY priority ASC, id DESC`).all()
    .map((r) => { try { return { ...r, test: compile(r) }; } catch { return null; } })
    .filter(Boolean);
}

function validateRule(db, body, { needCategory = true } = {}) {
  if (!body || typeof body !== 'object') throw bad('rule must be an object');
  const field = body.field ?? 'description';
  const match = body.match ?? 'contains';
  if (!FIELDS.includes(field)) throw bad(`field must be one of ${FIELDS.join(', ')}`);
  if (!MATCHES.includes(match)) throw bad(`match must be one of ${MATCHES.join(', ')}`);
  const pattern = typeof body.pattern === 'string' ? body.pattern.trim() : '';
  if (!pattern || pattern.length > 200) throw bad('pattern must be 1 to 200 characters');
  if (match === 'regex') {
    try { new RegExp(pattern, 'i'); } catch (e) { throw bad(`pattern is not a valid regex: ${e.message}`); }
    // A quantified group that is itself quantified, like (a+)+, can backtrack
    // for ever and every rule runs over every transaction.
    if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) throw bad('pattern nests repeats, like (a+)+, which can hang matching');
  }
  const out = { field, match, pattern, account_id: null, category_id: null, set_merchant: null, amount_min: null, amount_max: null, priority: 100 };
  if (needCategory || body.category_id != null) {
    if (!isInt(body.category_id)) throw bad('category_id must be a category id');
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ? AND archived = 0').get(body.category_id)) throw bad('no such category');
    out.category_id = body.category_id;
  }
  if (body.account_id != null) {
    if (typeof body.account_id !== 'string' || !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(body.account_id)) throw bad('no such account');
    out.account_id = body.account_id;
  }
  for (const k of ['amount_min', 'amount_max']) {
    if (body[k] == null) continue;
    if (!isInt(body[k])) throw bad(`${k} must be whole cents`);
    out[k] = body[k];
  }
  if (out.amount_min != null && out.amount_max != null && out.amount_min > out.amount_max) throw bad('amount_min is above amount_max');
  if (body.priority != null) {
    if (!Number.isInteger(body.priority) || body.priority < 1 || body.priority > 1000) throw bad('priority must be 1 to 1000');
    out.priority = body.priority;
  }
  if (body.set_merchant != null) {
    if (typeof body.set_merchant !== 'string' || body.set_merchant.trim().length > 80) throw bad('set_merchant must be up to 80 characters');
    out.set_merchant = body.set_merchant.trim() || null;
  }
  return out;
}

const SELECT_ROWS = `SELECT t.id, t.account_id, t.description, t.merchant, t.amount, t.provider_category, t.category_id, t.category_source,
  t.rule_id, t.merchant_override FROM transactions t`;

// Re-decide every non-manual row (or just `ids`). Returns how many rows ended
// up categorised by each source and how many changed.
export function applyRules(db, { ids = null } = {}) {
  const rules = loadRules(db);
  const provider = new Map(db.prepare('SELECT id, name FROM categories').all().map((c) => [c.name, c.id]));
  const ai = new Map(db.prepare('SELECT merchant_key, category_id FROM ai_cache WHERE category_id IS NOT NULL').all().map((r) => [r.merchant_key, r.category_id]));
  const where = `(t.category_source IS NULL OR t.category_source != 'manual') AND ${LIVE()}`;
  let rows;
  if (ids) {
    rows = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      rows.push(...db.prepare(`${SELECT_ROWS} WHERE ${where} AND t.id IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
    }
  } else rows = db.prepare(`${SELECT_ROWS} WHERE ${where}`).all();

  const counts = { scanned: rows.length, changed: 0, rule: 0, ai: 0, provider: 0, none: 0 };
  const upd = db.prepare('UPDATE transactions SET category_id = ?, category_source = ?, rule_id = ?, merchant_override = ? WHERE id = ?');
  tx(db, () => {
    for (const row of rows) {
      let d = null;
      const rule = rules.find((r) => r.test(row));
      if (rule) d = { category_id: rule.category_id, source: 'rule', rule_id: rule.id, merchant_override: rule.set_merchant ?? null };
      if (!d && !isTransferHint(row.provider_category)) {
        const hit = ai.get(merchantKey(row.merchant));
        if (hit) d = { category_id: hit, source: 'ai' };
      }
      if (!d) {
        const p = provider.get(providerCategoryName(row.provider_category));
        if (p) d = { category_id: p, source: 'provider' };
      }
      d ??= { category_id: null, source: null };
      d.rule_id ??= null;
      // A rename belongs to the rule that made it; another source keeps none.
      d.merchant_override = d.source === 'rule' ? d.merchant_override : (row.rule_id ? null : row.merchant_override);
      counts[d.source ?? 'none'] += 1;
      if (row.category_id !== d.category_id || row.category_source !== d.source || row.rule_id !== d.rule_id || row.merchant_override !== d.merchant_override) {
        upd.run(d.category_id, d.source, d.rule_id, d.merchant_override, row.id);
        counts.changed += 1;
      }
    }
    db.exec('UPDATE rules SET hits = (SELECT count(*) FROM transactions WHERE rule_id = rules.id)');
  });
  return counts;
}

export function getRule(db, id) {
  return db.prepare(`SELECT ${RULE_COLS.split(', ').map((c) => `r.${c}`).join(', ')}, c.name category, a.name account_name
    FROM rules r LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN accounts a ON a.id = r.account_id WHERE r.id = ?`).get(id) ?? null;
}

export function listRules(db) {
  return db.prepare(`SELECT ${RULE_COLS.split(', ').map((c) => `r.${c}`).join(', ')}, c.name category, a.name account_name
    FROM rules r LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN accounts a ON a.id = r.account_id ORDER BY r.priority, r.id DESC`).all();
}

const appliedBy = (db, id) => db.prepare('SELECT count(*) n FROM transactions WHERE rule_id = ?').get(id).n;

export function createRule(db, body, { source = 'manual' } = {}) {
  const r = validateRule(db, body);
  const { lastInsertRowid } = db.prepare(`INSERT INTO rules (field, match, pattern, account_id, category_id, set_merchant, amount_min, amount_max, priority, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.field, r.match, r.pattern, r.account_id, r.category_id, r.set_merchant, r.amount_min, r.amount_max, r.priority, source, new Date().toISOString());
  const id = Number(lastInsertRowid);
  applyRules(db);
  return { rule: getRule(db, id), applied: appliedBy(db, id) };
}

export function updateRule(db, id, patch) {
  const cur = db.prepare(`SELECT ${RULE_COLS} FROM rules WHERE id = ?`).get(id);
  if (!cur) throw notFound('no such rule');
  const r = validateRule(db, { ...cur, ...patch });
  db.prepare(`UPDATE rules SET field = ?, match = ?, pattern = ?, account_id = ?, category_id = ?, set_merchant = ?, amount_min = ?, amount_max = ?, priority = ? WHERE id = ?`)
    .run(r.field, r.match, r.pattern, r.account_id, r.category_id, r.set_merchant, r.amount_min, r.amount_max, r.priority, id);
  applyRules(db);
  return { rule: getRule(db, id), applied: appliedBy(db, id) };
}

export function deleteRule(db, id) {
  const n = appliedBy(db, id);
  if (!db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes) throw notFound('no such rule');
  db.prepare('UPDATE transactions SET rule_id = NULL WHERE rule_id = ?').run(id);
  applyRules(db);
  return { deleted: true, reverted: n };
}

// How many transactions a draft rule would match, with a few examples.
export function previewRule(db, body) {
  const r = validateRule(db, body, { needCategory: false });
  const test = compile(r);
  const hits = db.prepare('SELECT id, account_id, date, description, merchant, amount FROM transactions t WHERE ' + LIVE() + ' ORDER BY date DESC').all().filter(test);
  return { count: hits.length, sample: hits.slice(0, 5) };
}

// the owner's manual pick. With `always`, the merchant gets a correction rule so
// the next one is right without asking; null hands the row back to the rules.
export function setCategory(db, id, { category_id, always = false }) {
  const row = db.prepare('SELECT id, description, merchant FROM transactions WHERE id = ?').get(id);
  if (!row) throw notFound('no such transaction');
  if (category_id === null) {
    db.prepare('UPDATE transactions SET category_id = NULL, category_source = NULL, rule_id = NULL WHERE id = ?').run(id);
    applyRules(db, { ids: [id] });
    return { transaction: id, rule: null, applied: 0 };
  }
  if (!isInt(category_id) || !db.prepare('SELECT 1 FROM categories WHERE id = ? AND archived = 0').get(category_id)) throw bad('no such category');
  db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual', rule_id = NULL WHERE id = ?").run(category_id, id);
  if (!always) return { transaction: id, rule: null, applied: 0 };
  const base = merchantBase(row.merchant);
  const draft = base
    ? { field: 'merchant', match: 'starts', pattern: base.slice(0, 200) }
    : { field: 'description', match: 'exact', pattern: row.description.trim().slice(0, 200) };
  if (!draft.pattern) throw bad('this transaction has no merchant or description to make a rule from');
  const existing = db.prepare("SELECT id FROM rules WHERE source = 'correction' AND field = ? AND match = ? AND lower(pattern) = lower(?) AND account_id IS NULL")
    .get(draft.field, draft.match, draft.pattern);
  const out = existing
    ? updateRule(db, existing.id, { category_id })
    : createRule(db, { ...draft, category_id, priority: 50 }, { source: 'correction' });
  return { transaction: id, ...out };
}

// The same manual category and business flag on many rows in one go. Unknown
// ids are skipped; returns the ids that were changed. A null category hands
// the rows back to the rules.
export function bulkEdit(db, rawIds, b = {}) {
  if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 500 || !rawIds.every((i) => typeof i === 'string' && i.length <= 100)) throw bad('ids must be 1 to 500 transaction ids');
  if (!('category_id' in b) && !('is_business' in b)) throw bad('nothing to change');
  if ('category_id' in b && b.category_id !== null) {
    if (!isInt(b.category_id) || !db.prepare('SELECT 1 FROM categories WHERE id = ? AND archived = 0').get(b.category_id)) throw bad('no such category');
  }
  if ('is_business' in b && b.is_business !== null && typeof b.is_business !== 'boolean') throw bad('is_business must be true, false or null');
  const ids = rawIds.filter((id) => db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(id));
  tx(db, () => {
    for (const id of ids) {
      if ('category_id' in b && b.category_id !== null) db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual', rule_id = NULL WHERE id = ?").run(b.category_id, id);
      if ('category_id' in b && b.category_id === null) db.prepare('UPDATE transactions SET category_id = NULL, category_source = NULL, rule_id = NULL WHERE id = ?').run(id);
      if ('is_business' in b) db.prepare('UPDATE transactions SET is_business = ? WHERE id = ?').run(b.is_business === null ? null : b.is_business ? 1 : 0, id);
    }
  });
  if ('category_id' in b && b.category_id === null) applyRules(db, { ids });
  return ids;
}

// ---------- the model, for merchants no rule knows ----------

// Account numbers, card masks, BSBs, amounts and long references never
// leave the box. The text is bank-supplied (anyone who pays the owner writes the
// reference), so every pattern here must stay linear: the mask runs are
// separated by at least one space or dash, never split in two, because the
// old (?:[*x]{2,}[\s-]*)+ form backtracked exponentially on a long run of x.
const SCRUB_INPUT_MAX = 1000;
export function scrubForModel(text) {
  return String(text ?? '').slice(0, SCRUB_INPUT_MAX)
    .replace(/[*x\u2022]{2,}(?:[\s-]+[*x\u2022]{2,})*[\s-]*\d{0,4}\b/gi, '#')
    .replace(/(\$|\b[A-Z]{3}\s?)?\d[\d,]*\.\d{2}\b/g, '#')
    .replace(/\d[\d\s-]{4,}\d/g, '#')
    .replace(/\d{4,}/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const SYSTEM = 'You categorise Australian bank transactions for a personal finance app. For each item pick exactly one category from the list given, '
  + 'using the merchant and description only. If you are not reasonably sure, answer "Unknown". Reply with JSON only, in the form '
  + '{"results":[{"i":0,"category":"Groceries"}]}.';

export function createAi({
  db, key, model, fetchImpl = globalThis.fetch, base = 'https://openrouter.ai/api/v1',
  batchSize = 40, dailyCap = 500, timeoutMs = 60_000, backoffMs = 2 * 3600_000, today, log = console.log,
}) {
  let running = false;
  let last = null;
  let failedAt = 0;

  const usage = (d) => db.prepare('SELECT calls, merchants, prompt_tokens, completion_tokens FROM ai_usage WHERE date = ?').get(d)
    ?? { calls: 0, merchants: 0, prompt_tokens: 0, completion_tokens: 0 };

  // One example per merchant key that has no rule, no cached answer and is
  // not a transfer.
  function pending() {
    const rows = db.prepare(`SELECT t.merchant, t.description, t.provider_category FROM transactions t
      WHERE (t.category_source IS NULL OR t.category_source = 'provider') AND NOT ${LINKED} AND ${LIVE()}
      ORDER BY t.date DESC`).all();
    const cached = new Set(db.prepare('SELECT merchant_key FROM ai_cache').all().map((r) => r.merchant_key));
    const out = new Map();
    for (const r of rows) {
      if (isTransferHint(r.provider_category)) continue;
      const k = merchantKey(r.merchant);
      if (!k || cached.has(k) || out.has(k)) continue;
      out.set(k, { key: k, merchant: scrubForModel(r.merchant), description: scrubForModel(r.description) });
    }
    return [...out.values()];
  }

  async function ask(batch, names) {
    const items = batch.map((m, i) => ({ i, merchant: m.merchant, description: m.description }));
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Mint' },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 40 + batch.length * 30, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Categories: ${names.join('; ')}\n\nItems: ${JSON.stringify(items)}` },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content ?? '');
    let parsed = null;
    try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch {}
    // An unusable reply is an error, not a batch of "unknown" answers: caching
    // those would stop these merchants ever being asked again.
    if (!Array.isArray(parsed?.results) || !parsed.results.length) throw new Error('model reply was not usable JSON');
    return { results: parsed.results, usage: data?.usage ?? {} };
  }

  // After a failed call (no credit, model down) the next sync waits out the
  // backoff instead of retrying every 30 minutes; a manual run goes anyway.
  async function run({ force = false } = {}) {
    if (!key) return { merchants: 0, categorised: 0, calls: 0, error: 'OPENROUTER_API_KEY not set' };
    if (running) return { already: true, merchants: 0, categorised: 0, calls: 0 };
    if (!force && Date.now() - failedAt < backoffMs) return { merchants: 0, categorised: 0, calls: 0, waiting: true, error: last?.error ?? null };
    running = true;
    const out = { merchants: 0, categorised: 0, calls: 0, prompt_tokens: 0, completion_tokens: 0, capped: false, error: null };
    try {
      const d = today();
      const list = pending();
      const allowance = Math.max(0, dailyCap - usage(d).merchants);
      out.capped = list.length > allowance;
      const take = list.slice(0, allowance);
      const cats = db.prepare("SELECT id, name FROM categories WHERE archived = 0 AND kind != 'transfer' ORDER BY sort").all();
      const byName = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
      const before = db.prepare("SELECT count(*) n FROM transactions WHERE category_source = 'ai'").get().n;
      for (let i = 0; i < take.length; i += batchSize) {
        const batch = take.slice(i, i + batchSize);
        let answer;
        try {
          answer = await ask(batch, cats.map((c) => c.name));
        } catch (e) {
          out.error = String(e?.message ?? e).slice(0, 200);
          failedAt = Date.now();
          break;
        }
        const pt = Number(answer.usage.prompt_tokens) || 0;
        const ct = Number(answer.usage.completion_tokens) || 0;
        out.calls += 1; out.merchants += batch.length; out.prompt_tokens += pt; out.completion_tokens += ct;
        const at = new Date().toISOString();
        tx(db, () => {
          db.prepare(`INSERT INTO ai_usage (date, calls, merchants, prompt_tokens, completion_tokens) VALUES (?, 1, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET calls = calls + 1, merchants = merchants + excluded.merchants,
              prompt_tokens = prompt_tokens + excluded.prompt_tokens, completion_tokens = completion_tokens + excluded.completion_tokens`)
            .run(d, batch.length, pt, ct);
          const put = db.prepare('INSERT INTO ai_cache (merchant_key, category_id, model, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(merchant_key) DO NOTHING');
          batch.forEach((m, j) => {
            // Only an explicit answer is cached; a merchant the reply skipped is asked again later.
            const hit = answer.results.find((r) => Number(r?.i) === j && typeof r?.category === 'string');
            if (hit) put.run(m.key, byName.get(hit.category.trim().toLowerCase()) ?? null, model, at);
          });
        });
      }
      if (out.calls) { applyRules(db); if (!out.error) failedAt = 0; }
      out.categorised = db.prepare("SELECT count(*) n FROM transactions WHERE category_source = 'ai'").get().n - before;
      if (out.calls || out.error) {
        log(`ai: ${out.merchants} merchants in ${out.calls} calls, ${out.prompt_tokens} tokens in, ${out.completion_tokens} out, ${out.categorised} rows${out.capped ? ', daily cap reached' : ''}${out.error ? `, stopped: ${out.error}` : ''}`);
      }
      return out;
    } finally {
      running = false;
      last = { ...out, at: new Date().toISOString() };
    }
  }

  function status() {
    return {
      enabled: !!key, model, cap: dailyCap, batch: batchSize, running, today: usage(today()), pending: key ? pending().length : 0, last,
      retry_after: failedAt ? new Date(failedAt + backoffMs).toISOString() : null,
    };
  }

  return { run, status, pending };
}
