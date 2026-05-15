const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBrowserContextSnapshotLayout,
  buildBrowserContextSnapshotText,
} = require('../.tmp-browser-context-layout-test/sidepanel/agent-runtime/browser-context-layout.js');

test('includes active tab context and attached snapshot text', () => {
  const text = buildBrowserContextSnapshotText({
    totalTabCount: 3,
    listedTabs: [
      { tabId: 91, title: 'Products', url: 'https://www.saucedemo.com/inventory.html', active: true, status: 'complete' },
      { tabId: 58, title: 'Cart', url: 'https://www.saucedemo.com/cart.html', active: false, status: 'complete' },
      { tabId: 12, title: 'Docs', url: 'https://example.com/docs', active: false, status: 'complete' },
    ],
    extraTabCount: 0,
    visibleTabId: 91,
    activeTab: { tabId: 91, title: 'Products', url: 'https://www.saucedemo.com/inventory.html', active: true, status: 'complete' },
    selectedTabCount: 2,
    omittedAttachedTabCount: 0,
    attachedSnapshotBlocks: [
      {
        tabId: 91,
        title: 'Products',
        url: 'https://www.saucedemo.com/inventory.html',
        active: true,
        snapshotText: 'Browser snapshot snapshotId=s-products tabId=91 title="Products" url=https://www.saucedemo.com/inventory.html viewport=1280x720',
      },
      {
        tabId: 58,
        title: 'Cart',
        url: 'https://www.saucedemo.com/cart.html',
        active: false,
        snapshotText: 'Browser snapshot snapshotId=s-cart tabId=58 title="Cart" url=https://www.saucedemo.com/cart.html viewport=1280x720',
      },
    ],
  });

  assert.match(text, /Open tabs \(3 total\):/);
  assert.match(text, /Current visible\/selected tab:/);
  assert.match(text, /Attached tab ref snapshots \(2 selected\):/);
  assert.match(text, /Browser snapshot snapshotId=s-products/);
  assert.match(text, /Browser snapshot snapshotId=s-cart/);
});

test('renders the no-attached-tabs message when no context snapshots are selected', () => {
  const text = buildBrowserContextSnapshotText({
    totalTabCount: 1,
    listedTabs: [
      { tabId: 91, title: 'Products', url: 'https://www.saucedemo.com/inventory.html', active: true, status: 'complete' },
    ],
    extraTabCount: 0,
    visibleTabId: 91,
    activeTab: { tabId: 91, title: 'Products', url: 'https://www.saucedemo.com/inventory.html', active: true, status: 'complete' },
    selectedTabCount: 0,
    omittedAttachedTabCount: 0,
    attachedSnapshotBlocks: [],
  });

  assert.match(text, /Attached tab ref snapshots: none selected for this message\./);
});

test('reports section metrics that reconcile to the full rendered text length', () => {
  const result = buildBrowserContextSnapshotLayout({
    totalTabCount: 3,
    listedTabs: [
      { tabId: 91, title: 'Products', url: 'https://www.saucedemo.com/inventory.html', active: true, status: 'complete' },
      { tabId: 58, title: 'Cart', url: 'https://www.saucedemo.com/cart.html', active: false, status: 'complete' },
      { tabId: 12, title: 'Docs', url: 'https://example.com/docs', active: false, status: 'complete' },
    ],
    extraTabCount: 0,
    visibleTabId: 91,
    activeTab: { tabId: 91, title: 'Products', url: 'https://www.saucedemo.com/inventory.html', active: true, status: 'complete' },
    selectedTabCount: 1,
    omittedAttachedTabCount: 0,
    attachedSnapshotBlocks: [
      {
        tabId: 91,
        title: 'Products',
        url: 'https://www.saucedemo.com/inventory.html',
        active: true,
        snapshotText: 'Browser snapshot snapshotId=s-products tabId=91 title="Products" url=https://www.saucedemo.com/inventory.html viewport=1280x720',
      },
    ],
  });

  assert.equal(
    result.metrics.frameChars
      + result.metrics.openTabsSectionChars
      + result.metrics.activeTabSectionChars
      + result.metrics.attachedSnapshotsSectionChars,
    result.text.length,
  );
  assert.ok(result.metrics.activeTabSectionChars > 0);
});

test('summarizes open-tab locations while keeping the active section URL exact', () => {
  const text = buildBrowserContextSnapshotText({
    totalTabCount: 2,
    listedTabs: [
      { tabId: 11, title: 'Search', url: 'https://example.com/search?q=browser+snapshot', active: true, status: 'complete' },
      { tabId: 12, title: 'Docs', url: 'https://example.com/docs?tab=api', active: false, status: 'complete' },
    ],
    extraTabCount: 0,
    visibleTabId: 11,
    activeTab: { tabId: 11, title: 'Search', url: 'https://example.com/search?q=browser+snapshot', active: true, status: 'complete' },
    selectedTabCount: 0,
    omittedAttachedTabCount: 0,
    attachedSnapshotBlocks: [],
  });

  assert.match(text, /1\. \[ACTIVE, SELECTED\] tabId=11 title="Search" location=example\.com\/search/);
  assert.match(text, /2\. tabId=12 title="Docs" location=example\.com\/docs/);
  assert.doesNotMatch(text, /location=.*\?/);
  assert.match(text, /Current visible\/selected tab:\ntabId=11\ntitle="Search"\nurl=https:\/\/example\.com\/search\?q=browser\+snapshot/);
});

test('condenses non-active attached snapshots while keeping the active snapshot detailed', () => {
  const text = buildBrowserContextSnapshotText({
    totalTabCount: 3,
    listedTabs: [
      { tabId: 91, title: 'Products', url: 'https://www.saucedemo.com/inventory.html', active: true, status: 'complete' },
      { tabId: 58, title: 'Cart', url: 'https://www.saucedemo.com/cart.html', active: false, status: 'complete' },
      { tabId: 12, title: 'Docs', url: 'https://example.com/docs', active: false, status: 'complete' },
    ],
    extraTabCount: 0,
    visibleTabId: 91,
    activeTab: { tabId: 91, title: 'Products', url: 'https://www.saucedemo.com/inventory.html', active: true, status: 'complete' },
    selectedTabCount: 2,
    omittedAttachedTabCount: 0,
    attachedSnapshotBlocks: [
      {
        tabId: 91,
        title: 'Products',
        url: 'https://www.saucedemo.com/inventory.html',
        active: true,
        snapshotText: 'Browser snapshot snapshotId=s-products tabId=91 title="Products" url=https://www.saucedemo.com/inventory.html viewport=1280x720\n- heading "Products" [ref=e1]\n- button "Add to cart Sauce Labs Backpack" [ref=e7]',
      },
      {
        tabId: 58,
        title: 'Cart',
        url: 'https://www.saucedemo.com/cart.html',
        active: false,
        snapshotText: 'Browser snapshot snapshotId=s-cart tabId=58 title="Cart" url=https://www.saucedemo.com/cart.html viewport=1280x720\n- heading "Your Cart" [ref=e1]\n- button "Checkout" [ref=e4]',
      },
    ],
  });

  assert.match(text, /Browser snapshot snapshotId=s-products[\s\S]*- button "Add to cart Sauce Labs Backpack" \[ref=e7\]/);
  assert.match(text, /Browser snapshot snapshotId=s-cart tabId=58 title="Cart" url=https:\/\/www\.saucedemo\.com\/cart\.html viewport=1280x720\n- button "Checkout"/);
  assert.doesNotMatch(text, /Browser snapshot snapshotId=s-cart[\s\S]*- heading "Your Cart" \[ref=e1\]/);
  assert.doesNotMatch(text, /Browser snapshot snapshotId=s-cart[\s\S]*- button "Checkout" \[ref=e4\]/);
});