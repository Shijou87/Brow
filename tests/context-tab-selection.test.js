const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getEffectiveContextTabIds,
} = require('../.tmp-context-tab-selection-test/context-tab-selection.js');

test('defaults to the active tab when no explicit context tabs are provided', () => {
  assert.deepEqual(getEffectiveContextTabIds(undefined, 42), [42]);
});

test('keeps the active tab in context when stale explicit tabs are present', () => {
  assert.deepEqual(getEffectiveContextTabIds([864], 885), [885, 864]);
});

test('deduplicates the active tab when already selected and drops invalid ids', () => {
  assert.deepEqual(getEffectiveContextTabIds([885, -1, 885, 12.4, 901], 885), [885, 901]);
});