const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chooseTypeTarget,
} = require('../.tmp-type-target-selection-test/type-target-selection.js');

test('prefers the explicitly matched type target over an unrelated active field', () => {
  assert.equal(chooseTypeTarget({
    directTarget: 'departure',
    activeTarget: 'where-else',
    activeRelatedToMatched: false,
    visibleTargets: ['where-else', 'departure', 'return'],
  }), 'departure');
});

test('uses a related active target when the matched ref is a wrapper around the live field', () => {
  assert.equal(chooseTypeTarget({
    activeTarget: 'wrapped-input',
    activeRelatedToMatched: true,
    visibleTargets: ['wrapped-input', 'other-input'],
  }), 'wrapped-input');
});

test('falls back to the lone visible target only when no better match exists', () => {
  assert.equal(chooseTypeTarget({
    visibleTargets: ['only-input'],
  }), 'only-input');

  assert.equal(chooseTypeTarget({
    visibleTargets: ['first', 'second'],
  }), null);
});