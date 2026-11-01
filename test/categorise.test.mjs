// (a) Categorisation: seed set, provider fallback, rules (retroactive, edit,
// delete, priority, scope, amount range, regex), manual corrections that
// become rules, and the bounded AI pass for unknowns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book } from './fixtures/book.mjs';
import { deriveMerchant, merchantKey } from '../lib/merchant.mjs';
import { SEED_CATEGORIES, seedCategories } from '../lib/categories.mjs';
import { applyRules, createRule, updateRule, deleteRule, setCategory, previewRule, createAi, scrubForModel } from '../lib/categorise.mjs';

const catOf = (b, id) => ({ ...b.db.prepare('SELECT c.name, t.category_source src FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?').get(id) }); // plain object: node:sqlite rows have a null prototype

test('seed set covers income, transfers and an AU personal taxonomy', () => {
  const b = book();
  const rows = b.db.prepare('SELECT name, kind FROM categories').all();
  const kind = Object.fromEntries(rows.map((r) => [r.name, r.kind]));
  for (const n of ['Groceries', 'Eating out', 'Fuel', 'Utilities', 'Subscriptions', 'Shopping', 'Medical', 'Bank fees', 'Debt repayments']) assert.equal(kind[n], 'expense', n);
  for (const n of ['Salary', 'Interest', 'Other income', 'Business income']) assert.equal(kind[n], 'income', n);
  for (const n of ['Transfers', 'Card repayment', 'Loan repayment']) assert.equal(kind[n], 'transfer', n);
  assert.ok(SEED_CATEGORIES.length >= 30);
  // Idempotent: seeding twice adds nothing.
  const n = rows.length;
  seedCategories(b.db);
  assert.equal(b.db.prepare('SELECT count(*) n FROM categories').get().n, n);
});

test('merchant derived from card, EFTPOS, online and BNPL descriptors', () => {
  assert.equal(deriveMerchant('V1234 10/06 TEST PHARMACY TESTVILLE 05151529978'), 'Test Pharmacy Testville');
  assert.equal(deriveMerchant('EFTPOS 25/12 00:55SQ *TEST BAKERY'), 'Test Bakery');
  assert.equal(deriveMerchant('V9999 12/08 PAYPAL *TESTHOST 402-935-77 24013963225'), 'Testhost');
  assert.equal(deriveMerchant('V9999 09/04 TESTSOFT*TESTSOFT 365 BILL.INF 74798065099'), 'Testsoft');
  assert.equal(deriveMerchant('TESTSHOP.COM +188 2025-04-22 2 of 4'), 'Testshop.com');
  assert.equal(deriveMerchant('ONLINE V5218293742 Linked Acc Trns TESTER AB'), 'Linked Acc Trns Tester Ab');
  assert.equal(deriveMerchant('TEST GROCER         TESTVILLE    WA'), 'Test Grocer');
  assert.equal(deriveMerchant('TEST AUTO SHOP 2023-06-19 repayment 4 of 4'), 'Test Auto Shop');
  // A facilitator's name hides the real merchant: the description wins.
  assert.equal(deriveMerchant('EFTPOS 17/10 12:01SQ *TEST TAQUERIA', 'Square'), 'Test Taqueria');
  assert.equal(deriveMerchant('V9999 12/08 PAYPAL *TESTHOST 402-935-77 24013963225', 'PayPal'), 'Testhost');
  assert.equal(merchantKey('Hungry Test (Testville)'), merchantKey('HUNGRY TEST'));
  assert.equal(merchantKey('Test Cafe 3'), merchantKey('Test Cafe 7'));
  assert.equal(deriveMerchant('TEST ADS1234567890'), 'Test Ads');
  assert.equal(merchantKey('Test Ads9824928654'), merchantKey('Test Ads1111111111'));
  assert.equal(merchantKey(''), '');
});

test('provider category is the fallback, transfers land in a transfer category', () => {
  const b = book();
  const food = b.add('acct_t_everyday', '2026-10-01', -1500, 'TEST CAFE', { provider_category: 'FOOD_AND_DRINK' });
  const xfer = b.add('acct_t_everyday', '2026-10-01', -5000, 'ONLINE X1 Linked Acc Trns', { provider_category: 'TRANSFER_OUT' });
  const none = b.add('acct_t_everyday', '2026-10-01', -5000, 'MYSTERY', { provider_category: null });
  const r = applyRules(b.db);
  assert.deepEqual(catOf(b, food), { name: 'Eating out', src: 'provider' });
  assert.deepEqual(catOf(b, xfer), { name: 'Transfers', src: 'provider' });
  assert.equal(catOf(b, none).name, null);
  assert.ok(r.provider >= 2);
});

test('seed rules: salary and interest by sign', () => {
  const b = book();
  const sal = b.add('acct_t_everyday', '2026-10-01', 400000, 'SALARY/WAGES TEST PERSON');
  const intIn = b.add('acct_t_savings', '2026-10-01', 123, 'INTEREST');
  const intOut = b.add('acct_t_loan', '2026-10-01', -200000, 'INTEREST', { provider_category: 'BANK_FEES' });
  applyRules(b.db);
  assert.equal(catOf(b, sal).name, 'Salary');
  assert.equal(catOf(b, intIn).name, 'Interest');
  assert.equal(catOf(b, intOut).name, 'Interest charged');
});

test('a new rule applies retroactively, counts hits, and catches later rows', () => {
  const b = book();
  const a = b.add('acct_t_everyday', '2026-09-01', -8000, 'TEST GROCER         TESTVILLE    WA', { provider_category: 'FOOD_AND_DRINK' });
  const c = b.add('acct_t_card', '2026-09-03', -6000, 'TEST GROCER         OTHERTOWN    WA', { provider_category: 'FOOD_AND_DRINK' });
  applyRules(b.db);
  const { rule, applied } = createRule(b.db, { field: 'merchant', match: 'contains', pattern: 'test grocer', category_id: b.cat('Groceries') });
  assert.equal(applied, 2);
  assert.equal(catOf(b, a).name, 'Groceries');
  assert.equal(catOf(b, c).src, 'rule');
  assert.equal(b.db.prepare('SELECT hits FROM rules WHERE id = ?').get(rule.id).hits, 2);
  const later = b.add('acct_t_everyday', '2026-09-10', -4000, 'TEST GROCER         TESTVILLE    WA', { provider_category: 'FOOD_AND_DRINK' });
  applyRules(b.db, { ids: [later] });
  assert.equal(catOf(b, later).name, 'Groceries');
});

test('editing or deleting a rule re-runs it over history', () => {
  const b = book();
  const a = b.add('acct_t_everyday', '2026-09-01', -8000, 'TEST GROCER', { provider_category: 'FOOD_AND_DRINK' });
  const { rule } = createRule(b.db, { field: 'description', match: 'contains', pattern: 'GROCER', category_id: b.cat('Groceries') });
  assert.equal(catOf(b, a).name, 'Groceries');
  updateRule(b.db, rule.id, { pattern: 'NOT THERE' });
  assert.deepEqual(catOf(b, a), { name: 'Eating out', src: 'provider' });
  updateRule(b.db, rule.id, { pattern: 'GROCER', category_id: b.cat('Shopping') });
  assert.equal(catOf(b, a).name, 'Shopping');
  deleteRule(b.db, rule.id);
  assert.deepEqual(catOf(b, a), { name: 'Eating out', src: 'provider' });
  assert.equal(b.db.prepare('SELECT count(*) n FROM rules WHERE id = ?').get(rule.id).n, 0);
});

test('priority, account scope, amount range and regex', () => {
  const b = book();
  const small = b.add('acct_t_everyday', '2026-09-01', -500, 'TESTMART 123');
  const big = b.add('acct_t_everyday', '2026-09-02', -25000, 'TESTMART 123');
  const onCard = b.add('acct_t_card', '2026-09-02', -900, 'TESTMART 456');
  createRule(b.db, { field: 'description', match: 'starts', pattern: 'TESTMART', category_id: b.cat('Shopping'), priority: 100 });
  createRule(b.db, { field: 'description', match: 'regex', pattern: '^TESTMART \\d+$', category_id: b.cat('Groceries'), priority: 50, amount_max: -1000 });
  createRule(b.db, { field: 'description', match: 'contains', pattern: 'TESTMART', category_id: b.cat('Electronics'), priority: 10, account_id: 'acct_t_card' });
  assert.equal(catOf(b, small).name, 'Shopping'); // regex rule's amount range excludes -5.00
  assert.equal(catOf(b, big).name, 'Groceries'); // lower priority number wins
  assert.equal(catOf(b, onCard).name, 'Electronics'); // card-only rule
  assert.equal(previewRule(b.db, { field: 'description', match: 'starts', pattern: 'TESTMART' }).count, 3);
});

test('rule validation rejects bad input', () => {
  const b = book();
  const bad = (body) => assert.throws(() => createRule(b.db, body), (e) => e.status === 400, JSON.stringify(body));
  bad({ field: 'description', match: 'regex', pattern: '(unclosed', category_id: b.cat('Shopping') });
  bad({ field: 'description', match: 'regex', pattern: '(a+)+$', category_id: b.cat('Shopping') });
  bad({ field: 'nope', match: 'contains', pattern: 'x', category_id: b.cat('Shopping') });
  bad({ field: 'description', match: 'contains', pattern: '', category_id: b.cat('Shopping') });
  bad({ field: 'description', match: 'contains', pattern: 'x'.repeat(201), category_id: b.cat('Shopping') });
  bad({ field: 'description', match: 'contains', pattern: 'x', category_id: 999999 });
  bad({ field: 'description', match: 'contains', pattern: 'x', category_id: b.cat('Shopping'), amount_min: 5.5 });
  bad({ field: 'description', match: 'contains', pattern: 'x', category_id: b.cat('Shopping'), amount_min: 100, amount_max: -100 });
  bad({ field: 'description', match: 'contains', pattern: 'x', category_id: b.cat('Shopping'), account_id: 'acct_missing' });
  assert.throws(() => updateRule(b.db, 99999, { pattern: 'x' }), (e) => e.status === 404);
});

test("manual recategorise sticks, and 'always' makes a correction rule for the merchant", () => {
  const b = book();
  const a = b.add('acct_t_everyday', '2026-09-01', -1200, 'V1234 01/09 TEST FUEL STOP TESTVILLE 74111111111', { merchant_name: 'Test Fuel Stop (Testville)' });
  const c = b.add('acct_t_card', '2026-09-05', -3400, 'V1234 05/09 TEST FUEL STOP OTHERTOWN 74111111112', { merchant_name: 'Test Fuel Stop (Othertown)' });
  const other = b.add('acct_t_card', '2026-09-05', -3400, 'UNRELATED SHOP');
  applyRules(b.db);
  const once = setCategory(b.db, a, { category_id: b.cat('Fuel') });
  assert.equal(once.rule, null);
  assert.deepEqual(catOf(b, a), { name: 'Fuel', src: 'manual' });
  assert.equal(catOf(b, c).name, 'Shopping');
  const always = setCategory(b.db, a, { category_id: b.cat('Fuel'), always: true });
  assert.equal(always.rule.source, 'correction');
  assert.equal(always.applied, 1);
  assert.equal(catOf(b, c).name, 'Fuel');
  assert.equal(catOf(b, other).name, 'Shopping');
  // A rule never overrides a manual choice.
  setCategory(b.db, c, { category_id: b.cat('Car maintenance') });
  createRule(b.db, { field: 'merchant', match: 'contains', pattern: 'Test Fuel', category_id: b.cat('Groceries'), priority: 1 });
  assert.equal(catOf(b, c).name, 'Car maintenance');
  // Clearing a manual category hands the row back to the rules.
  setCategory(b.db, c, { category_id: null });
  assert.equal(catOf(b, c).name, 'Groceries');
  assert.throws(() => setCategory(b.db, 'txn_missing', { category_id: b.cat('Fuel') }), (e) => e.status === 404);
});

// A fake OpenRouter: answers each batch by looking the merchant up in a map.
function fakeModel(answers, { fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body, raw: init.body });
    if (fail) return new Response('{"error":{"message":"down"}}', { status: 503 });
    const prompt = body.messages.at(-1).content;
    const items = JSON.parse(prompt.slice(prompt.indexOf('['))).map((x) => ({ i: x.i, category: answers[x.merchant] ?? 'Nonsense category' }));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ results: items }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  };
  return { calls, fetchImpl };
}

test('AI pass: batched, cached, capped, only description and merchant, token use logged', async () => {
  const b = book();
  const ids = [
    b.add('acct_t_everyday', '2026-10-01', -2300, 'TEST NOODLE BAR', { provider_category: 'FOOD_AND_DRINK' }),
    b.add('acct_t_everyday', '2026-10-02', -2400, 'TEST NOODLE BAR', { provider_category: 'FOOD_AND_DRINK' }),
    b.add('acct_t_everyday', '2026-10-03', -9900, 'TEST HARDWARE TO A/C 12345678 REF 998877', { provider_category: 'MERCHANDISE' }),
    b.add('acct_t_everyday', '2026-10-04', -1000, 'TEST CINEMA', { provider_category: 'ENTERTAINMENT' }),
  ];
  const xfer = b.add('acct_t_everyday', '2026-10-04', -50000, 'ONLINE X1 Linked Acc Trns', { provider_category: 'TRANSFER_OUT' });
  applyRules(b.db);
  const m = fakeModel({ 'Test Noodle Bar': 'Takeaway and delivery', 'Test Hardware To A/C # Ref #': 'Home and garden', 'Test Cinema': 'Entertainment' });
  const ai = createAi({ db: b.db, key: 'sk-or-test-invented', model: 'test/cheap', fetchImpl: m.fetchImpl, batchSize: 2, dailyCap: 100, today: () => '2026-10-17', log: () => {} });
  const r = await ai.run();
  assert.equal(r.merchants, 3);
  assert.equal(m.calls.length, 2); // 3 merchants, batches of 2
  assert.equal(r.prompt_tokens, 200);
  assert.equal(catOf(b, ids[0]).name, 'Takeaway and delivery');
  assert.equal(catOf(b, ids[1]).src, 'ai');
  assert.equal(catOf(b, xfer).name, 'Transfers'); // transfers are never sent
  for (const c of m.calls) {
    assert.equal(c.headers.Authorization ?? c.headers.authorization, 'Bearer sk-or-test-invented');
    assert.match(c.url, /\/chat\/completions$/);
    assert.equal(c.body.model, 'test/cheap');
    assert.doesNotMatch(c.raw, /12345678|998877|xxxx1\d\d\d|Linked Acc|acct_t_|balance|-?99\.00|9900/);
  }
  const usage = b.db.prepare("SELECT * FROM ai_usage WHERE date = '2026-10-17'").get();
  assert.equal(usage.calls, 2);
  assert.equal(usage.merchants, 3);
  assert.equal(usage.prompt_tokens, 200);
  assert.equal(usage.completion_tokens, 40);
  // Cached: a new row from a known merchant is categorised without a call.
  const again = b.add('acct_t_card', '2026-10-05', -2500, 'TEST NOODLE BAR', { provider_category: 'FOOD_AND_DRINK' });
  applyRules(b.db, { ids: [again] });
  const r2 = await ai.run();
  assert.equal(m.calls.length, 2);
  assert.equal(r2.merchants, 0);
  assert.equal(catOf(b, again).name, 'Takeaway and delivery');
  // A rule still beats the model.
  createRule(b.db, { field: 'merchant', match: 'exact', pattern: 'Test Cinema', category_id: b.cat('Subscriptions') });
  assert.equal(catOf(b, ids[3]).name, 'Subscriptions');
});

test('AI daily cap bounds spend and an unknown answer is not applied', async () => {
  const b = book();
  for (let i = 0; i < 5; i++) b.add('acct_t_everyday', '2026-10-01', -1000, `TEST SHOP NUMBER ${'ABCDE'[i]}`, { provider_category: 'MERCHANDISE' });
  applyRules(b.db);
  const m = fakeModel({});
  const ai = createAi({ db: b.db, key: 'k', model: 'test/cheap', fetchImpl: m.fetchImpl, batchSize: 10, dailyCap: 2, today: () => '2026-10-17', log: () => {} });
  const r = await ai.run();
  assert.equal(r.merchants, 2);
  assert.equal(r.capped, true);
  assert.equal(r.categorised, 0); // the model answered with a category that does not exist
  assert.equal(b.db.prepare("SELECT count(*) n FROM transactions WHERE category_source = 'provider'").get().n, 5);
  const r2 = await ai.run();
  assert.equal(r2.merchants, 0);
  assert.equal(m.calls.length, 1);
  const s = ai.status();
  assert.equal(s.today.merchants, 2);
  assert.equal(s.cap, 2);
  assert.ok(s.pending >= 3);
  assert.equal(s.model, 'test/cheap');
});

test('AI failure is reported, not thrown, and nothing is cached', async () => {
  const b = book();
  b.add('acct_t_everyday', '2026-10-01', -1000, 'TEST SHOP', { provider_category: 'MERCHANDISE' });
  applyRules(b.db);
  const m = fakeModel({}, { fail: true });
  const ai = createAi({ db: b.db, key: 'k', model: 'test/cheap', fetchImpl: m.fetchImpl, today: () => '2026-10-17', log: () => {} });
  const r = await ai.run();
  assert.match(r.error, /503/);
  assert.equal(b.db.prepare('SELECT count(*) n FROM ai_cache').get().n, 0);
  assert.equal(createAi({ db: b.db, key: '', model: 'x', today: () => '2026-10-17' }).status().enabled, false);
  // The next scheduled run waits out the backoff; a manual one goes anyway.
  const calls = m.calls.length;
  assert.equal((await ai.run()).waiting, true);
  assert.equal(m.calls.length, calls);
  assert.ok(ai.status().retry_after);
  await ai.run({ force: true });
  assert.equal(m.calls.length, calls + 1);
});

test('scrubForModel strips account numbers, card masks and long references', () => {
  assert.equal(scrubForModel('LOAN INSTALMENT TO A/C 123456789 TEST'), 'LOAN INSTALMENT TO A/C # TEST');
  assert.equal(scrubForModel('BPAY TESTCARD xxxx xxxx xxxx 0221'), 'BPAY TESTCARD #');
  assert.equal(scrubForModel('TRANSFER FROM 306-511-123'), 'TRANSFER FROM #');
  assert.equal(scrubForModel('TEST CAFE 3'), 'TEST CAFE 3');
  assert.equal(scrubForModel('TESTSHOP AU USD 1249.99 FX FEE'), 'TESTSHOP AU # FX FEE');
  assert.equal(scrubForModel('Fee $1,250.00 intl'), 'Fee # intl');
  assert.equal(scrubForModel('CARD **** **** **** 1234'), 'CARD #');
  assert.equal(scrubForModel('4111 **** 1234 TEST'), '# # TEST');
  assert.equal(scrubForModel('TESTXXON FUEL'), 'TESTXXON FUEL');
});

// A payer writes the reference, so a hostile one must not hang the event loop.
// The old mask pattern took minutes on 50 x's followed by a letter.
test('scrubForModel stays fast on a hostile bank reference', () => {
  for (const s of ['x'.repeat(5000) + 'A', '*'.repeat(5000) + '!', 'xx '.repeat(2000) + 'A', 'X'.repeat(60) + '1A']) {
    const t = performance.now();
    scrubForModel(s);
    assert.ok(performance.now() - t < 250, `took ${Math.round(performance.now() - t)}ms on ${s.slice(-4)}`);
  }
  assert.equal(scrubForModel(`PAY ${'x'.repeat(5000)}`), 'PAY #');
});

test('an unusable model reply caches nothing and backs off', async () => {
  const b = book();
  b.add('acct_t_everyday', '2026-10-01', -1000, 'TEST SHOP', { provider_category: 'MERCHANDISE' });
  applyRules(b.db);
  let n = 0;
  const fetchImpl = async () => { n += 1; return Response.json({ choices: [{ message: { content: 'Sure! Here you go: not json' } }], usage: {} }); };
  const ai = createAi({ db: b.db, key: 'k', model: 'test/cheap', fetchImpl, today: () => '2026-10-17', log: () => {} });
  const r = await ai.run();
  assert.match(r.error, /not usable/);
  assert.equal(b.db.prepare('SELECT count(*) n FROM ai_cache').get().n, 0);
  assert.equal(ai.status().pending, 1);
  assert.equal((await ai.run()).waiting, true);
  assert.equal(n, 1);
});
