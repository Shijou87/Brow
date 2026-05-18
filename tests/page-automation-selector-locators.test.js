const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSimpleLocator,
  parseSnapshotRefSelector,
} = require('../.tmp/selector-locators-test/selector-locators.js');

test('keeps existing simple locator support', () => {
  assert.deepEqual(parseSimpleLocator('text="Recherche approfondie"'), {
    kind: 'text',
    needle: 'Recherche approfondie',
  });
});

test('supports role-shaped locators the snapshot encourages the model to try', () => {
  assert.deepEqual(parseSimpleLocator('link="Recherche approfondie"'), {
    kind: 'link',
    needle: 'Recherche approfondie',
  });
  assert.deepEqual(parseSimpleLocator('button="Recherche approfondie"'), {
    kind: 'button',
    needle: 'Recherche approfondie',
  });
});

test('accepts raw snapshot ref tokens from snapshot text', () => {
  assert.deepEqual(parseSnapshotRefSelector('[ref=e96]'), { ref: 'e96' });
  assert.deepEqual(parseSnapshotRefSelector('ref=e96'), { ref: 'e96' });
  assert.deepEqual(parseSnapshotRefSelector('brow-ref://s123/e96'), {
    snapshotId: 's123',
    ref: 'e96',
  });
});