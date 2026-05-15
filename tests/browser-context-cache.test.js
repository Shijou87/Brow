const test = require('node:test');
const assert = require('node:assert/strict');

const {
  invalidateBrowserContextSnapshotCache,
  primeBrowserContextSnapshotCache,
  readBrowserContextSnapshotCache,
  resetBrowserContextSnapshotCacheForTests,
  shouldReuseCachedBrowserContextSnapshot,
} = require('../.tmp-browser-context-cache-test/sidepanel/agent-runtime/browser-context-cache.js');

function makeSnapshot(overrides = {}) {
  return {
    ok: true,
    snapshotId: 's1',
    tabId: 9,
    url: 'https://www.saucedemo.com/inventory.html',
    title: 'Products',
    generatedAt: 123,
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    elements: [],
    visibleElementCount: 0,
    displayedElementCount: 0,
    omittedElementCount: 0,
    ...overrides,
  };
}

test('reuses cached browser-context snapshots only when version and tab identity still match', () => {
  assert.equal(shouldReuseCachedBrowserContextSnapshot(undefined, { version: 0, url: 'a', title: 'b' }), false);
  assert.equal(shouldReuseCachedBrowserContextSnapshot({ snapshotText: 'x', version: 2, url: 'a', title: 'b', generatedAt: 1 }, { version: 2, url: 'a', title: 'b' }), true);
  assert.equal(shouldReuseCachedBrowserContextSnapshot({ snapshotText: 'x', version: 2, url: 'a', title: 'b', generatedAt: 1 }, { version: 3, url: 'a', title: 'b' }), false);
  assert.equal(shouldReuseCachedBrowserContextSnapshot({ snapshotText: 'x', version: 2, url: 'a', title: 'b', generatedAt: 1 }, { version: 2, url: 'c', title: 'b' }), false);
});

test('invalidates cached tab snapshots and accepts fresh primed snapshots afterward', () => {
  resetBrowserContextSnapshotCacheForTests();
  primeBrowserContextSnapshotCache(makeSnapshot(), 'SNAPSHOT A');

  assert.equal(readBrowserContextSnapshotCache(9, { url: 'https://www.saucedemo.com/inventory.html', title: 'Products' })?.snapshotText, 'SNAPSHOT A');

  invalidateBrowserContextSnapshotCache(9);
  assert.equal(readBrowserContextSnapshotCache(9, { url: 'https://www.saucedemo.com/inventory.html', title: 'Products' }), undefined);

  primeBrowserContextSnapshotCache(makeSnapshot({ snapshotId: 's2', generatedAt: 456 }), 'SNAPSHOT B');
  assert.equal(readBrowserContextSnapshotCache(9, { url: 'https://www.saucedemo.com/inventory.html', title: 'Products' })?.snapshotText, 'SNAPSHOT B');
});