import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMerchant } from '../lib/merchant.mjs';

test('fixed-width card descriptors keep the merchant column only', () => {
  assert.equal(deriveMerchant('TEST CAFE 3              TESTVILLE    AU'), 'Test Cafe 3');
  assert.equal(deriveMerchant('AUTHORISATION ONLY - TEST SOFTWARE INC.     SAN FRANCISCO US'), 'Test Software Inc.');
});

test('an explicit merchant name wins after tidying', () => {
  assert.equal(deriveMerchant('WHATEVER', '  TEST GROCER  '), 'Test Grocer');
});

test('blank in, blank out', () => {
  assert.equal(deriveMerchant(''), '');
  assert.equal(deriveMerchant(null), '');
});
