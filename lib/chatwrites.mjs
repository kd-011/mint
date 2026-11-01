// The chat door's writes, in two tiers (see lib/undo.mjs for the machinery).
//
// SAFE writes apply at once and answer with an undo token: recategorise one
// transaction (optionally always, as a rule), a deductible tag, a rule, a
// budget target, a goal, a share holding or lot, a manual asset or its value,
// a loan detail, the tax estimate inputs, a manual account (lib/manual.mjs) or
// one transaction on it. A bulk edit of up to 5 transactions is safe too.
//
// CONFIRM writes never apply on the first call: deleting a rule, budget, goal,
// holding or lot, an Owed to me debt, and anything on an account. Nor does any write, safe or not,
// that would change more than 5 transactions (a bulk edit, or a rule that
// reaches back through history). Those answer 202 with a confirm token and a
// summary of exactly what would change, and apply on POST /confirm/:token.
//
// Nothing here moves money, deletes a transaction, or touches a connection or
// a credential. Cents everywhere, except share units and unit prices (dollars,
// as on the Shares screen).
import { bad, notFound, HttpError } from './errors.mjs';
import { send, readJson } from './http.mjs';
import { isIsoDate, zoneDate } from './dates.mjs';
import { capture, saveUndo, saveConfirm, takeConfirm, applyUndo } from './undo.mjs';
import { setCategory, bulkEdit, getRule, deleteRule } from './categorise.mjs';
import { setBudget, deleteBudget } from './budgets.mjs';
import { createGoal, updateGoal, deleteGoal } from './goals.mjs';
import { createOwed, updateOwed, deleteOwed, getOwed, addOwedPayment, repayPerson, closePerson, findDebtor, listOwed } from './owed.mjs';
import { createHolding, updateHolding, deleteHolding, addLot, deleteLot, snapshotPortfolio } from './holdings.mjs';
import { createAsset, addSnapshot } from './networth.mjs';
import { setLoanInputs } from './homeloan.mjs';
import { setAssessment } from './noa.mjs';
import { setTaxTag, clearTaxTag, setTaxInputs, fyOf, ATO_CATEGORIES } from './tax.mjs';
import { updateAccount } from './accounts.mjs';
import { createManualAccount, addManualTransaction, recomputeAll } from './manual.mjs';
import { applyRules } from './categorise.mjs';

export const BULK_MAX = 5; // more transactions than this in one write needs a confirm

const ATO_LABEL = new Map(ATO_CATEGORIES.map((c) => [c.code, c.label]));
const REFRESH = new Set(['transactions', 'rules', 'budgets', 'accounts']);
const SHARES = new Set(['holdings', 'holding_lots']);

export const money = (c) => (c == null ? 'nothing' : `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const only = (o, keys) => Object.fromEntries(keys.filter((k) => has(o, k)).map((k) => [k, o[k]]));

// ---------- finding things by what the owner calls them ----------

function byName(rows, ref, what, label = (r) => r.name) {
  const s = String(ref ?? '').trim();
  if (/^\d{1,9}$/.test(s)) {
    const hit = rows.find((r) => r.id === Number(s));
    if (hit) return hit;
  }
  const t = s.toLowerCase();
  const exact = rows.filter((r) => label(r).toLowerCase() === t);
  if (exact.length === 1) return exact[0];
  const part = t ? rows.filter((r) => label(r).toLowerCase().includes(t)) : [];
  if (part.length === 1) return part[0];
  const names = rows.map(label).join(', ') || 'none yet';
  if (part.length > 1) throw bad(`"${s.slice(0, 40)}" matches more than one ${what}: ${part.map(label).join(', ')}`);
  throw notFound(`no ${what} called "${s.slice(0, 40)}". ${what[0].toUpperCase()}${what.slice(1)}s: ${names}`);
}

const accountLabel = (a) => a.nickname || a.name;
function findAccount(db, ref, { type = null } = {}) {
  const rows = db.prepare(`SELECT id, name, nickname, type FROM accounts WHERE status IS NOT 'gone' ${type ? 'AND type = ?' : ''} ORDER BY sort, name`).all(...(type ? [type] : []));
  const s = String(ref ?? '').trim();
  const hit = rows.find((a) => a.id === s);
  if (hit) return hit;
  const t = s.toLowerCase();
  const found = rows.filter((a) => a.name.toLowerCase().includes(t) || (a.nickname ?? '').toLowerCase().includes(t));
  if (t && found.length === 1) return found[0];
  const what = type === 'loan' ? 'loan account' : 'account';
  if (found.length > 1 && t) throw bad(`"${s.slice(0, 40)}" matches more than one ${what}: ${found.map(accountLabel).join(', ')}`);
  throw notFound(`no ${what} matches "${s.slice(0, 40)}". ${what[0].toUpperCase()}${what.slice(1)}s: ${rows.map(accountLabel).join(', ') || 'none'}`);
}

// A manual account by id, name or nickname (the chat can only add to these).
function findManual(db, ref) {
  const rows = db.prepare("SELECT id, name, nickname, currency FROM accounts WHERE manual = 1 AND status IS NOT 'gone' ORDER BY sort, name").all();
  const s = String(ref ?? '').trim();
  return rows.find((a) => a.id === s) ?? byName(rows, s, 'manual account', accountLabel);
}
// Native hundredths in the account's own currency, for a summary line.
const native = (c, cur) => `${cur} ${c < 0 ? '-' : ''}${(Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

const findGoal = (db, ref) => byName(db.prepare('SELECT id, name, target_amount FROM goals ORDER BY sort, id').all(), ref, 'goal');
const findAsset = (db, ref) => byName(db.prepare('SELECT id, name, kind FROM manual_assets ORDER BY archived, name').all(), ref, 'asset');

// 12, VAS, or VAS.ASX.
function findHolding(db, ref) {
  const s = String(ref ?? '').trim();
  const rows = db.prepare('SELECT id, ticker, exchange, units, avg_cost FROM holdings ORDER BY ticker, exchange').all();
  const label = (h) => `${h.ticker}.${h.exchange}`;
  if (/^\d{1,9}$/.test(s)) { const h = rows.find((r) => r.id === Number(s)); if (h) return h; }
  const [ticker, exchange] = s.toUpperCase().split('.');
  const hit = rows.filter((h) => h.ticker === ticker && (!exchange || h.exchange === exchange));
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) throw bad(`${ticker} is held on more than one exchange: ${hit.map(label).join(', ')}`);
  throw notFound(`no holding "${s.slice(0, 20)}". Holdings: ${rows.map(label).join(', ') || 'none yet'}`);
}

const txLine = (db, id) => {
  const t = typeof id === 'string' ? db.prepare(`SELECT t.id, t.date, COALESCE(t.merchant_override, t.merchant, t.description) merchant, t.amount, c.name category
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?`).get(id) : null;
  if (!t) throw notFound('no such transaction');
  return t;
};
const describeTx = (t) => `${t.merchant} on ${t.date} (${money(t.amount)})`;

// ---------- the operations ----------
// run(db, p, ctx) does the write and returns { result, summary, status, pin }.
// summary is text or a function of the row counts; it must not read the book,
// because for a preview it is written after the dry run has been rolled back.
// pin is the params with every name resolved to an id: a confirm token keeps
// those, so a rename inside the 10 minutes cannot point it at another row.

function categoryOf(ctx, term) {
  if (term === null || /^(none|uncategori[sz]ed)$/i.test(String(term))) return null;
  if (typeof term !== 'string' || !term.trim()) throw bad('category is required: a category name like Groceries, or null to hand it back to the rules');
  return ctx.resolveCategory(ctx.db, term, { activeOnly: true })[0];
}

const OPS = {
  recategorise: {
    tier: 'safe',
    run(db, p, ctx) {
      const t = txLine(db, p.id);
      if (has(p, 'always') && typeof p.always !== 'boolean') throw bad('always must be true or false');
      const cat = categoryOf(ctx, p.category);
      const r = setCategory(db, p.id, { category_id: cat?.id ?? null, always: !!p.always && !!cat });
      const pin = { id: p.id, category: cat?.name ?? null, always: !!p.always };
      const to = cat?.name ?? 'the rules again';
      return {
        result: { transaction: { ...txLine(db, p.id) }, rule: r.rule ?? null },
        pin,
        summary: (n) => `Move ${describeTx(t)} from ${t.category ?? 'Uncategorised'} to ${to}${p.always && cat ? `, and always: a rule for ${t.merchant} that recategorises ${plural(n.transactions ?? 0, 'transaction')} in all` : ''}`,
      };
    },
  },

  bulk_edit: {
    tier: 'safe',
    run(db, p, ctx) {
      if (!has(p, 'set_category') && !has(p, 'set_business')) throw bad('give set_category (a category name, or null for the rules) and/or set_business (true, false or null)');
      let ids;
      if (has(p, 'ids')) ids = p.ids;
      else if (p.match && typeof p.match === 'object' && !Array.isArray(p.match)) ids = ctx.matchIds(db, p.match);
      else throw bad('give ids (a list of transaction ids) or match (filters like merchant, q, from, to, category, account)');
      const body = {};
      let cat;
      if (has(p, 'set_category')) { cat = categoryOf(ctx, p.set_category); body.category_id = cat?.id ?? null; }
      if (has(p, 'set_business')) body.is_business = p.set_business;
      const done = bulkEdit(db, ids, body);
      if (!done.length) throw notFound('none of those transactions exist');
      const what = [has(p, 'set_category') && `category to ${cat?.name ?? 'whatever the rules say'}`, has(p, 'set_business') && `business to ${p.set_business === null ? 'the account default' : p.set_business ? 'yes' : 'no'}`].filter(Boolean).join(' and ');
      return {
        result: { matched: done.length },
        // A match is re-run at confirm and must find exactly these rows again.
        pin: has(p, 'ids') ? { ...only(p, ['set_category', 'set_business']), ids: done } : { ...only(p, ['match', 'set_category', 'set_business']), expect_ids: done },
        drift: Array.isArray(p.expect_ids) && (p.expect_ids.length !== done.length || p.expect_ids.some((id, i) => id !== done[i])),
        summary: (n) => `Change ${plural(n.transactions ?? 0, 'transaction')}: ${what}${done.length > (n.transactions ?? 0) ? ` (${done.length} matched, the rest are already so)` : ''}`,
      };
    },
  },

  tax_tag: {
    tier: 'safe',
    legacy: true,
    run(db, p) {
      const t = txLine(db, p.id);
      if (p.ato_category === null) {
        const r = clearTaxTag(db, p.id);
        return { result: { transaction_id: p.id, ...r }, summary: `Remove the deductible tag from ${describeTx(t)}` };
      }
      const r = setTaxTag(db, p.id, { ato_category: p.ato_category, deductible_amount: p.deductible_amount ?? null, note: p.note ?? null });
      return { result: r, summary: `Tag ${describeTx(t)} deductible: ${r.ato_category} ${r.label}, ${money(r.deductible_amount)}` };
    },
  },

  rule_add: {
    tier: 'safe',
    legacy: true,
    run(db, p, ctx) {
      const r = ctx.addRule(db, p);
      const rule = r.rule;
      return {
        result: r,
        status: r.created ? 201 : 200,
        summary: (n) => (r.created
          ? `Add a rule: ${rule.field} ${rule.match} "${rule.pattern}" is ${rule.category}, which recategorises ${plural(n.transactions ?? 0, 'transaction')}`
          : `The rule ${rule.field} ${rule.match} "${rule.pattern}" is ${rule.category} already exists, nothing changed`),
      };
    },
  },

  rule_delete: {
    tier: 'confirm',
    run(db, p) {
      const rule = getRule(db, p.id);
      if (!rule) throw notFound('no such rule');
      const r = deleteRule(db, p.id);
      return {
        result: r,
        summary: (n) => `Delete rule ${rule.id} (${rule.field} ${rule.match} "${rule.pattern}" is ${rule.category ?? 'no category'}); ${plural(n.transactions ?? 0, 'transaction')} it categorised go back to the other rules`,
      };
    },
  },

  budget_set: {
    tier: 'safe',
    run(db, p, ctx) {
      const cat = categoryOf(ctx, p.category);
      if (!cat) throw bad('category is required: the spending category the budget is for');
      const was = db.prepare('SELECT cycle_target FROM budgets WHERE category_id = ?').get(cat.id);
      const r = setBudget(db, cat.id, only(p, ['cycle_target', 'monthly_target', 'rollover', 'fixed']));
      return {
        result: { category: cat.name, ...r, rollover: !!r.rollover, fixed: !!r.fixed },
        summary: `${was ? 'Change' : 'Set'} the ${cat.name} budget to ${money(r.cycle_target)} a pay cycle (${money(r.monthly_target)} a month)${was ? `, was ${money(was.cycle_target)} a pay cycle` : ''}`,
      };
    },
  },

  budget_delete: {
    tier: 'confirm',
    run(db, p, ctx) {
      const cat = categoryOf(ctx, p.category);
      if (!cat) throw bad('category is required');
      const was = db.prepare('SELECT cycle_target FROM budgets WHERE category_id = ?').get(cat.id);
      if (!was) throw notFound(`there is no ${cat.name} budget`);
      deleteBudget(db, cat.id);
      return { result: { deleted: true, category: cat.name }, pin: { category: cat.name }, summary: `Delete the ${cat.name} budget (${money(was.cycle_target)} a pay cycle)` };
    },
  },

  goal_add: {
    tier: 'safe',
    run(db, p) {
      const body = only(p, ['name', 'target_amount', 'target_date']);
      if (has(p, 'account')) body.account_id = p.account === null ? null : findAccount(db, p.account).id;
      const g = createGoal(db, body);
      return { result: g, status: 201, summary: `Add the goal ${g.name}${g.target_amount != null ? ` (${money(g.target_amount)}${g.target_date ? ` by ${g.target_date}` : ''})` : ''}` };
    },
  },

  goal_edit: {
    tier: 'safe',
    run(db, p) {
      const g = findGoal(db, p.ref);
      const body = only(p, ['name', 'target_amount', 'target_date', 'archived']);
      if (has(p, 'account')) body.account_id = p.account === null ? null : findAccount(db, p.account).id;
      const r = updateGoal(db, g.id, body);
      return { result: r, summary: `Change the goal ${g.name}: ${Object.keys(body).map((k) => k.replace('_id', '').replace(/_/g, ' ')).join(', ')}` };
    },
  },

  goal_delete: {
    tier: 'confirm',
    run(db, p) {
      const g = findGoal(db, p.ref);
      deleteGoal(db, g.id);
      return {
        result: { deleted: true, id: g.id, name: g.name },
        pin: { ref: String(g.id) },
        summary: (n) => `Delete the goal ${g.name}${g.target_amount != null ? ` (target ${money(g.target_amount)})` : ''}${n.goal_contributions ? `, and its ${plural(n.goal_contributions, 'contribution')}` : ', which has no contributions'}`,
      };
    },
  },

  owed_add: {
    tier: 'safe',
    run(db, p, ctx) {
      const d = createOwed(db, only(p, ['person', 'amount', 'note', 'direction', 'lent_on', 'due_on']), { today: ctx.today() });
      if (d.direction === 'i_owe') return { result: d, status: 201, summary: `Add ${money(d.amount)} you owe ${d.person}${d.note ? ` (${d.note})` : ''}${d.lent_on === ctx.today() ? '' : `, from ${d.lent_on}`}` };
      return { result: d, status: 201, summary: `Add ${money(d.amount)} owed to you by ${d.person}${d.note ? ` (${d.note})` : ''}${d.lent_on === ctx.today() ? '' : `, lent ${d.lent_on}`}` };
    },
  },

  // ref is a debt id (one debt) or a name (oldest debts first, spilling over).
  owed_repay: {
    tier: 'safe',
    run(db, p, ctx) {
      const body = only(p, ['amount', 'date', 'note', 'transaction_id']);
      const today = ctx.today();
      if (/^\d{1,9}$/.test(String(p.ref ?? '').trim())) {
        const d = getOwed(db, Number(p.ref), { today });
        const r = addOwedPayment(db, d.id, body, { today });
        return { result: { person: d.person, payments: [r], outstanding: r.outstanding }, status: 201, summary: d.direction === 'i_owe'
          ? `Log ${money(r.amount)} paid to ${d.person}${d.note ? ` on ${d.note}` : ''}, ${money(r.outstanding)} still owed on it`
          : `Log ${money(r.amount)} paid back by ${d.person}${d.note ? ` on ${d.note}` : ''}, ${money(r.outstanding)} still owed on it` };
      }
      const r = repayPerson(db, p.ref, body, { today });
      return { result: r, status: 201, summary: `Log ${money(body.amount)} paid back by ${r.person}${r.payments.length > 1 ? ` across ${plural(r.payments.length, 'debt')}` : ''}, ${money(r.outstanding)} still owed by them` };
    },
  },

  owed_settle: {
    tier: 'safe',
    run(db, p, ctx) {
      const status = p.status ?? 'settled';
      const today = ctx.today();
      const word = status === 'written_off' ? 'Write off' : 'Mark settled';
      if (/^\d{1,9}$/.test(String(p.ref ?? '').trim())) {
        const d = getOwed(db, Number(p.ref), { today });
        if (status !== 'settled' && status !== 'written_off') throw bad("status must be 'settled' or 'written_off'");
        const r = updateOwed(db, d.id, { closed: status }, { today });
        return { result: r, summary: d.direction === 'i_owe' ? `${word} ${money(d.outstanding)} you owe ${d.person}` : `${word} ${money(d.outstanding)} owed by ${d.person}` };
      }
      const r = closePerson(db, p.ref, status, { today });
      return { result: r, summary: `${word} ${money(r.amount)} owed by ${r.person} (${plural(r.debts.length, 'debt')})` };
    },
  },

  owed_delete: {
    tier: 'confirm',
    run(db, p, ctx) {
      const today = ctx.today();
      let d;
      if (/^\d{1,9}$/.test(String(p.ref ?? '').trim())) d = getOwed(db, Number(p.ref), { today });
      else {
        const who = findDebtor(db, p.ref, { today });
        const theirs = listOwed(db, { today }).items.filter((x) => x.person.trim().toLowerCase() === who.key);
        if (theirs.length !== 1) throw bad(`${who.name} has ${theirs.length} debts (${theirs.map((x) => `#${x.id} ${money(x.amount)}`).join(', ')}); say which by its number`);
        [d] = theirs;
      }
      deleteOwed(db, d.id);
      return {
        result: { deleted: true, id: d.id, person: d.person },
        pin: { ref: String(d.id) },
        summary: (n) => `Delete the ${money(d.amount)} owed by ${d.person}${d.note ? ` (${d.note})` : ''}${n.owed_payments ? `, and its ${plural(n.owed_payments, 'repayment')}` : ', which has no repayments'}`,
      };
    },
  },

  holding_add: {
    tier: 'safe',
    run(db, p) {
      const h = createHolding(db, only(p, ['ticker', 'exchange', 'name', 'asset_class', 'units', 'avg_cost', 'lots', 'manual_price']));
      return { result: h, status: 201, summary: `Add ${h.units} units of ${h.ticker}.${h.exchange} at ${h.avg_cost} dollars average` };
    },
  },

  holding_edit: {
    tier: 'safe',
    run(db, p) {
      const h = findHolding(db, p.ref);
      const body = only(p, ['name', 'asset_class', 'units', 'avg_cost', 'manual_price']);
      const r = updateHolding(db, h.id, body);
      return { result: r, summary: `Change ${h.ticker}.${h.exchange}: ${Object.keys(body).map((k) => k.replace(/_/g, ' ')).join(', ')}` };
    },
  },

  lot_add: {
    tier: 'safe',
    run(db, p) {
      const h = findHolding(db, p.ref);
      const l = addLot(db, h.id, only(p, ['date', 'units', 'price', 'brokerage']));
      return { result: { holding_id: h.id, ...l }, status: 201, summary: `Log a buy of ${l.units} ${h.ticker}.${h.exchange} at ${l.price} dollars on ${l.date}${l.brokerage ? `, ${money(l.brokerage)} brokerage` : ''}` };
    },
  },

  lot_delete: {
    tier: 'confirm',
    run(db, p) {
      const h = findHolding(db, p.ref);
      const lot = db.prepare('SELECT id, date, units, price FROM holding_lots WHERE id = ? AND holding_id = ?').get(p.lot, h.id);
      if (!lot) throw notFound(`no such lot on ${h.ticker}`);
      deleteLot(db, h.id, p.lot);
      return { result: { deleted: true }, pin: { ref: String(h.id), lot: p.lot }, summary: `Delete the ${lot.date} buy of ${lot.units} ${h.ticker}.${h.exchange} at ${lot.price} dollars` };
    },
  },

  holding_delete: {
    tier: 'confirm',
    run(db, p) {
      const h = findHolding(db, p.ref);
      deleteHolding(db, h.id);
      return {
        result: { deleted: true, id: h.id, ticker: h.ticker, exchange: h.exchange },
        pin: { ref: String(h.id) },
        summary: (n) => `Delete the holding ${h.ticker}.${h.exchange} (${h.units} units)${n.holding_lots ? ` and its ${plural(n.holding_lots, 'lot')}` : ''}`,
      };
    },
  },

  asset_add: {
    tier: 'safe',
    run(db, p) {
      const a = createAsset(db, only(p, ['name', 'kind', 'is_liability']));
      return { result: a, status: 201, summary: `Add the ${a.is_liability ? 'liability' : 'asset'} ${a.name} (${a.kind})` };
    },
  },

  asset_snapshot: {
    tier: 'safe',
    run(db, p, ctx) {
      const a = findAsset(db, p.ref);
      const date = p.date ?? ctx.today();
      if (!isIsoDate(date)) throw bad('date must be YYYY-MM-DD');
      const was = db.prepare('SELECT value FROM manual_snapshots WHERE asset_id = ? AND date = ?').get(a.id, date);
      const r = addSnapshot(db, a.id, { date, value: p.value, note: p.note ?? null, contribution: p.contribution ?? null });
      return { result: r, summary: `${was ? 'Change' : 'Log'} ${a.name} at ${money(r.value)} on ${date}${was ? `, was ${money(was.value)}` : ''}${r.contribution != null ? `, ${money(r.contribution)} contributed` : ''}` };
    },
  },

  loan_set: {
    tier: 'safe',
    run(db, p) {
      let acct;
      if (p.account == null) {
        const loans = db.prepare("SELECT id, name, nickname FROM accounts WHERE type = 'loan' AND status IS NOT 'gone'").all();
        if (loans.length !== 1) throw bad(`say which loan: ${loans.map(accountLabel).join(', ') || 'there are none'}`);
        acct = loans[0];
      } else acct = findAccount(db, p.account, { type: 'loan' });
      const body = only(p, ['rate', 'repayment', 'frequency', 'end_date']);
      const r = setLoanInputs(db, acct.id, body);
      const say = { rate: (v) => `rate ${(v * 100).toFixed(2)}%`, repayment: (v) => `repayment ${money(v)}`, frequency: (v) => `${v}`, end_date: (v) => `ending ${v}` };
      return { result: { account_id: acct.id, ...r }, summary: `Set ${accountLabel(acct)}: ${Object.keys(body).map((k) => (body[k] === null ? `${k.replace('_', ' ')} cleared` : say[k](body[k]))).join(', ')}` };
    },
  },

  tax_inputs: {
    tier: 'safe',
    run(db, p, ctx) {
      const fy = p.fy == null ? fyOf(ctx.today()) : p.fy;
      const r = setTaxInputs(db, fy, p);
      const keys = Object.keys(p).filter((k) => k !== 'fy');
      return { result: r, summary: `Tax estimate inputs for FY${fy}: ${keys.map((k) => `${k.replace(/_/g, ' ')} ${typeof p[k] === 'boolean' ? (p[k] ? 'yes' : 'no') : p[k] === null ? 'cleared' : typeof p[k] === 'string' ? p[k] : money(p[k])}`).join(', ')}` };
    },
  },

  // The ATO Notice of Assessment for a finished year (figures only, in cents), for
  // the income-by-year chart. Fields left out keep their saved value.
  noa_set: {
    tier: 'safe',
    run(db, p) {
      const { fy, ...body } = p;
      if (!Number.isInteger(fy)) throw bad('fy must be the year the financial year ends, e.g. 2025');
      const r = setAssessment(db, fy, body);
      return { result: r, summary: `NoA for FY${fy}: taxable income ${money(r.taxable_income)}, tax withheld ${money(r.tax_withheld_payg)}` };
    },
  },

  // A manual account for money Redbark cannot see (Wise, an overseas bank), in any
  // currency Frankfurter knows. prepare() checks the currency and fetches the rates
  // before the write, which then runs inside the undo capture like any other.
  manual_account_add: {
    tier: 'safe',
    async prepare(db, p, ctx) {
      if (!ctx.fx) throw new HttpError(503, 'exchange rates are not set up');
      p.currency = await ctx.fx.checkCurrency(p.currency ?? 'AUD');
      await ctx.fx.ensure(p.currency, [typeof p.opening_date === 'string' ? p.opening_date : ctx.today(), ctx.today()]);
    },
    run(db, p, ctx) {
      const a = createManualAccount(db, only(p, ['name', 'institution', 'type', 'currency', 'opening_balance', 'opening_date', 'is_business']), { today: ctx.today() });
      const aud = a.currency === 'AUD' ? '' : ` (${money(a.balance_current)})`;
      return {
        status: 201,
        result: { id: a.id, name: a.name, institution: a.institution, type: a.type, currency: a.currency, balance_native: a.balance_native, balance_aud: a.balance_current, opening_date: a.opening_date },
        summary: `Add the manual account ${a.name} in ${a.currency}, opening balance ${native(a.opening_balance, a.currency)}${aud} on ${a.opening_date}`,
      };
    },
  },

  // One transaction on a manual account: amount in the account's currency, negative is money out.
  manual_tx_add: {
    tier: 'safe',
    async prepare(db, p, ctx) {
      const a = findManual(db, p.ref);
      if (a.currency !== 'AUD' && ctx.fx) await ctx.fx.ensure(a.currency, [typeof p.date === 'string' ? p.date : ctx.today()]);
    },
    run(db, p, ctx) {
      const a = findManual(db, p.ref);
      const body = only(p, ['date', 'amount', 'description', 'note', 'is_business']);
      body.date ??= ctx.today();
      if (has(p, 'category')) body.category_id = categoryOf(ctx, p.category)?.id ?? null;
      const t = addManualTransaction(db, a.id, body, { today: ctx.today() });
      applyRules(db, { ids: [t.id] }); // filed now, inside the capture, so undo sees the row as the engine leaves it
      const aud = a.currency === 'AUD' ? '' : ` (${money(t.amount)})`;
      return {
        status: 201,
        result: { id: t.id, account_id: a.id, date: t.date, amount_native: t.amount_native, currency: t.currency, amount_aud: t.amount, description: t.description },
        summary: `Add ${native(t.amount_native, a.currency)}${aud} "${t.description}" on ${t.date} to ${accountLabel(a)}`,
      };
    },
  },

  account_edit: {
    tier: 'confirm',
    run(db, p) {
      const a = findAccount(db, p.ref);
      const body = only(p, ['nickname', 'hidden', 'is_business', 'spendable', 'type_override']);
      updateAccount(db, a.id, body);
      const say = (k, v) => (k === 'type_override' ? `type ${v ? `set to ${v}` : "back to the bank's"}` : k === 'nickname' ? `nickname ${v ? `"${String(v).trim()}"` : 'cleared'}` : `${k.replace('is_', '')} ${v === null ? "back to Mint's guess" : v ? 'yes' : 'no'}`);
      return { result: { id: a.id }, pin: { ...body, ref: a.id }, summary: `Change the account ${accountLabel(a)}: ${Object.entries(body).map(([k, v]) => say(k, v)).join(', ')}` };
    },
  },
};

// POST routes to operations. Path parts win over the body, so a body cannot
// point a write somewhere else.
const SEG = '([^/]{1,120})';
const ROUTES = [
  [/^\/transactions\/bulk$/, 'bulk_edit'],
  [/^\/transactions\/([A-Za-z0-9_-]{1,100})\/category$/, 'recategorise', (m) => ({ id: m[1] })],
  [/^\/transactions\/([A-Za-z0-9_-]{1,100})\/tax$/, 'tax_tag', (m) => ({ id: m[1] })],
  [/^\/rules$/, 'rule_add'],
  [/^\/rules\/(\d{1,9})\/delete$/, 'rule_delete', (m) => ({ id: Number(m[1]) })],
  [/^\/budgets$/, 'budget_set'],
  [new RegExp(`^/budgets/${SEG}/delete$`), 'budget_delete', (m) => ({ category: m[1] })],
  [/^\/goals$/, 'goal_add'],
  [new RegExp(`^/goals/${SEG}/delete$`), 'goal_delete', (m) => ({ ref: m[1] })],
  [new RegExp(`^/goals/${SEG}$`), 'goal_edit', (m) => ({ ref: m[1] })],
  [/^\/owed$/, 'owed_add'],
  [new RegExp(`^/owed/${SEG}/payments$`), 'owed_repay', (m) => ({ ref: m[1] })],
  [new RegExp(`^/owed/${SEG}/settle$`), 'owed_settle', (m) => ({ ref: m[1] })],
  [new RegExp(`^/owed/${SEG}/delete$`), 'owed_delete', (m) => ({ ref: m[1] })],
  [/^\/holdings$/, 'holding_add'],
  [new RegExp(`^/holdings/${SEG}/delete$`), 'holding_delete', (m) => ({ ref: m[1] })],
  [new RegExp(`^/holdings/${SEG}/lots$`), 'lot_add', (m) => ({ ref: m[1] })],
  [new RegExp(`^/holdings/${SEG}/lots/(\\d{1,9})/delete$`), 'lot_delete', (m) => ({ ref: m[1], lot: Number(m[2]) })],
  [new RegExp(`^/holdings/${SEG}$`), 'holding_edit', (m) => ({ ref: m[1] })],
  [/^\/assets$/, 'asset_add'],
  [new RegExp(`^/assets/${SEG}/snapshots$`), 'asset_snapshot', (m) => ({ ref: m[1] })],
  [/^\/loan$/, 'loan_set'],
  [/^\/tax\/estimate\/inputs$/, 'tax_inputs'],
  [/^\/income\/assessments\/(\d{4})$/, 'noa_set', (m) => ({ fy: Number(m[1]) })],
  [new RegExp(`^/accounts/${SEG}$`), 'account_edit', (m) => ({ ref: m[1] })],
  [/^\/manual-accounts$/, 'manual_account_add'],
  [new RegExp(`^/manual-accounts/${SEG}/transactions$`), 'manual_tx_add', (m) => ({ ref: m[1] })],
];
const TOKEN = /^\/(undo|confirm)\/([A-Za-z0-9_-]{10,100})$/;

const decode = (s) => {
  try { return decodeURIComponent(s); } catch { throw bad('bad path'); }
};

const sameCounts = (x, y) => {
  const k = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...k].every((t) => (x[t] ?? 0) === (y[t] ?? 0));
};

// For the confirm card: a few of the transactions that would change, as they
// are now and as they would be.
function sampleOf(db, changes) {
  const names = new Map(db.prepare('SELECT id, name FROM categories').all().map((c) => [c.id, c.name]));
  return changes.filter((c) => c.t === 'transactions').slice(0, 5).map((c) => {
    const t = db.prepare('SELECT date, COALESCE(merchant_override, merchant, description) merchant, amount FROM transactions WHERE id = ?').get(c.b.id);
    return {
      id: c.b.id, date: t?.date ?? null, merchant: t?.merchant ?? null, amount: t?.amount ?? null,
      from: names.get(c.b.category_id) ?? 'Uncategorised', to: names.get(c.a.category_id) ?? 'Uncategorised',
      ...(c.b.is_business !== c.a.is_business ? { business_from: c.b.is_business, business_to: c.a.is_business } : {}),
    };
  });
}

export function createChatWrites({ db, engine = null, quotes = null, fx = null, turns = null, log = console.log, now = () => new Date(), resolveCategory, matchIds, addRule }) {
  const ctx = { db, fx, resolveCategory, matchIds, addRule, today: () => zoneDate(now()) };

  // Derived state, after the write has committed. A failure here is logged, not
  // thrown: the write stands and its undo token must still reach the caller.
  function after(counts) {
    const touched = Object.keys(counts);
    try {
      // Undo puts rows back but not a manual account's derived balance and snapshots.
      if (touched.includes('transactions') || touched.includes('accounts')) recomputeAll(db, { today: ctx.today() });
      if (touched.some((t) => REFRESH.has(t))) engine?.refresh();
      if (touched.some((t) => SHARES.has(t))) snapshotPortfolio(db, { today: ctx.today(), cap: quotes?.status().cap ?? 25 });
    } catch (e) { log(`assistant: refresh after a chat write failed: ${e?.stack ?? e}`); }
  }

  // expected: the counts a confirm token was issued for. The write stands only
  // if it changes exactly that many rows; otherwise it is a fresh preview.
  function execute(name, params, { expected = null } = {}) {
    const op = OPS[name];
    let summary;
    let undo = null;
    const at = now().getTime();
    const r = capture(db, () => op.run(db, params, ctx), {
      keep: (counts, out) => (expected ? sameCounts(counts, expected) && !out.drift : op.tier === 'safe' && (counts.transactions ?? 0) <= BULK_MAX),
      onKeep: ({ out, changes, counts }) => {
        summary = typeof out.summary === 'function' ? out.summary(counts) : out.summary;
        undo = saveUndo(db, { op: name, summary, changes, now: at });
      },
    });
    if (!r.kept) {
      summary = typeof r.out.summary === 'function' ? r.out.summary(r.counts) : r.out.summary;
      const c = saveConfirm(db, { op: name, params: r.out.pin ?? params, summary, counts: r.counts, now: at });
      return {
        status: expected ? 409 : 202,
        body: {
          ...(expected ? { error: 'what this would change is different now from the preview; check the new summary and confirm again' } : {}),
          needs_confirm: true, op: name, summary: `Not done yet: ${summary}.`, changes: r.counts, sample: sampleOf(db, r.changes), token: c.token, expires_at: c.expires_at,
        },
      };
    }
    after(r.counts);
    log(`assistant ${name}${expected ? ' (confirmed)' : ''}: ${JSON.stringify(r.counts)}`);
    const base = { op: name, summary, changes: r.counts, undo };
    if (expected) return { status: 200, body: { confirmed: true, applied: true, ...base, result: r.out.result } };
    if (op.legacy) return { status: r.out.status ?? 200, body: { ...r.out.result, ...base } };
    return { status: r.out.status ?? 200, body: { applied: true, ...base, result: r.out.result } };
  }

  return async function handle(req, res, path) {
    const tok = TOKEN.exec(path);
    if (tok) {
      const body = await readJson(req);
      if (tok[1] === 'undo') {
        const u = applyUndo(db, tok[2], { now: now().getTime() });
        after(u.counts);
        log(`assistant undo ${u.op}: ${JSON.stringify(u.counts)}`);
        return send(res, 200, { undone: true, op: u.op, summary: `Undone: ${u.summary}`, changes: u.counts }), true;
      }
      if (body.op != null && typeof body.op !== 'string') throw bad('op must be the operation name the token was issued for');
      const c = takeConfirm(db, tok[2], { now: now().getTime(), claimed: body.op ?? null });
      if (!OPS[c.op]) throw new HttpError(410, 'this confirm is for an operation Mint no longer has');
      const out = execute(c.op, c.params, { expected: c.counts });
      return send(res, out.status, out.body), true;
    }
    for (const [re, name, parts] of ROUTES) {
      const m = re.exec(path);
      if (!m) continue;
      const fromPath = parts ? parts(m.map((s, i) => (i && typeof s === 'string' ? decode(s) : s))) : {};
      const params = { ...(await readJson(req)), ...fromPath };
      await OPS[name].prepare?.(db, params, ctx);
      // A resent chat question gets its first answer back rather than a second write (lib/chatturn.mjs).
      const out = turns ? turns.guard(name, params, () => execute(name, params)) : execute(name, params);
      if (out.body.replayed) log(`assistant ${name}: already made for this question, not repeated`);
      return send(res, out.status, out.body), true;
    }
    return false;
  };
}
