const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attachToolSnapshotFields,
} = require('../.tmp/tool-result-shape-test/sidepanel/agent-runtime/tool-result-snapshot.js');

function makeSnapshot(snapshotId) {
  return {
    ok: true,
    snapshotId,
    tabId: 3,
    url: 'https://www.saucedemo.com/',
    title: 'SauceDemo',
    generatedAt: 1,
    viewport: {
      width: 1280,
      height: 720,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
    },
    elements: [
      {
        ref: 'e1',
        role: 'textbox',
        name: 'Username',
        tagName: 'input',
        selector: '#user-name',
        actionable: true,
        depth: 0,
        bounds: {
          x: 10,
          y: 10,
          left: 10,
          top: 10,
          right: 110,
          bottom: 40,
          width: 100,
          height: 30,
        },
      },
    ],
    visibleElementCount: 1,
    displayedElementCount: 1,
    omittedElementCount: 0,
  };
}

test('tool snapshot payload summarizes beforeSnapshot instead of exposing raw elements', () => {
  const payload = attachToolSnapshotFields({
    ok: true,
    beforeSnapshot: makeSnapshot('before'),
    snapshot: makeSnapshot('after'),
  });

  assert.equal(payload.beforeSnapshot.snapshotId, 'before');
  assert.equal(payload.beforeSnapshot.visibleElementCount, 1);
  assert.equal(payload.beforeSnapshot.displayedElementCount, undefined);
  assert.equal(payload.beforeSnapshot.viewport, undefined);
  assert.equal(payload.beforeSnapshot.elements, undefined);
  assert.equal(payload.snapshot.snapshotId, 'after');
  assert.match(payload.snapshotText, /Browser snapshot snapshotId=after/);
  assert.doesNotMatch(payload.snapshotText, /\[bounds=/);
  assert.doesNotMatch(payload.snapshotText, /viewport=1280x720/);
});