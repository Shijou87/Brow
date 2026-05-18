const test = require('node:test');
const assert = require('node:assert/strict');

const {
  browserClick,
} = require('../.tmp/page-automation-click-test/sidepanel/tab-tools/page-automation.js');

function makeBounds(overrides = {}) {
  return {
    x: 100,
    y: 100,
    left: 100,
    top: 100,
    right: 260,
    bottom: 140,
    width: 160,
    height: 40,
    ...overrides,
  };
}

function makeElement(overrides = {}) {
  return {
    ref: 'e41',
    parentRef: 'e40',
    role: 'link',
    name: 'Nokia lumia 1520',
    tagName: 'a',
    selector: '#tbodyid > div:nth-of-type(2) > div > div > h4 > a',
    actionable: true,
    depth: 6,
    bounds: makeBounds(),
    ...overrides,
  };
}

let snapshotCounter = 0;

function makeSnapshot(overrides = {}) {
  const elements = overrides.elements ?? [];
  return {
    ok: true,
    snapshotId: overrides.snapshotId ?? `s${++snapshotCounter}`,
    tabId: overrides.tabId ?? 1,
    url: overrides.url ?? 'https://www.demoblaze.com/index.html#',
    title: overrides.title ?? 'STORE',
    generatedAt: overrides.generatedAt ?? Date.now(),
    viewport: overrides.viewport ?? {
      width: 1056,
      height: 826,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1.25,
    },
    elements,
    visibleElementCount: overrides.visibleElementCount ?? elements.length,
    displayedElementCount: overrides.displayedElementCount ?? elements.length,
    omittedElementCount: overrides.omittedElementCount ?? Math.max(0, (overrides.visibleElementCount ?? elements.length) - elements.length),
  };
}

function installChromeHarness(options) {
  const snapshots = [...options.snapshots];
  const lastSnapshot = snapshots[snapshots.length - 1];
  const clickResults = options.clickResults ? [...options.clickResults] : null;
  let clickCalls = 0;
  let resolveCalls = 0;
  const clickModes = [];
  const urlUpdates = [];

  global.chrome = {
    tabs: {
      async get(tabId) {
        return { id: tabId, active: true, windowId: 1, status: 'complete' };
      },
      async update(tabId, updateInfo) {
        if (typeof updateInfo?.url === 'string') {
          urlUpdates.push(updateInfo.url);
        }
        return { id: tabId, active: updateInfo?.active ?? true, windowId: 1, status: 'complete' };
      },
      async query() {
        return [{ id: 1, active: true, windowId: 1, status: 'complete' }];
      },
    },
    windows: {
      async update() {
        return { id: 1 };
      },
    },
    scripting: {
      async executeScript({ args }) {
        if (args?.[0]?.kind === 'click') {
          clickCalls += 1;
          clickModes.push(args[0].clickMode);
          return [{
            result: clickResults?.shift() ?? options.clickResult ?? {
              ok: true,
              clicked: {
                selector: args[0].selector,
                tagName: 'a',
                text: 'Nokia lumia 1520',
                href: 'https://www.demoblaze.com/prod.html?idp_=2',
              },
            },
          }];
        }

        return [{
          result: {
            ok: true,
            readyState: 'complete',
            quietMs: 180,
            durationMs: 0,
          },
        }];
      },
    },
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        const operation = message?.payload?.operation;
        if (operation?.kind === 'snapshot') {
          callback({
            ok: true,
            result: snapshots.length > 0 ? snapshots.shift() : lastSnapshot,
          });
          return;
        }

        if (operation?.kind === 'resolve') {
          resolveCalls += 1;
          callback({
            ok: true,
            result: {
              ok: true,
              ref: operation.ref,
              snapshotId: operation.snapshotId,
              selector: `brow-ref://${operation.snapshotId}/${operation.ref}`,
              entry: options.resolveEntry ?? makeElement({ ref: operation.ref }),
              preconditions: {
                visible: true,
                enabled: true,
                stable: true,
                receivesEvents: true,
                actionable: true,
                ok: true,
              },
              backend: 'mv3-dom',
              confidence: 100,
            },
          });
          return;
        }

        callback({ ok: false, error: `Unexpected snapshot operation: ${operation?.kind}` });
      },
    },
  };

  return {
    get clickCalls() {
      return clickCalls;
    },
    get resolveCalls() {
      return resolveCalls;
    },
    get clickModes() {
      return [...clickModes];
    },
    get urlUpdates() {
      return [...urlUpdates];
    },
  };
}

function uninstallChromeHarness() {
  delete global.chrome;
}

test('browserClick waits through href navigation when the first post-click snapshot is still on the origin page', async () => {
  snapshotCounter = 0;
  const beforeSnapshot = makeSnapshot({
    snapshotId: 's-before-nav',
    url: 'https://www.demoblaze.com/index.html#',
    elements: [makeElement({ ref: 'e41', name: 'Nokia lumia 1520' })],
  });
  const firstAfterSnapshot = makeSnapshot({
    snapshotId: 's-after-nav-1',
    url: 'https://www.demoblaze.com/index.html#',
    elements: [makeElement({ ref: 'e41', name: 'Nokia lumia 1520' })],
    visibleElementCount: 78,
    displayedElementCount: 41,
    omittedElementCount: 37,
  });
  const navigatedSnapshot = makeSnapshot({
    snapshotId: 's-after-nav-2',
    url: 'https://www.demoblaze.com/prod.html?idp_=2',
    elements: [
      makeElement({ ref: 'e34', role: 'heading', tagName: 'h2', actionable: false, name: 'Nokia lumia 1520' }),
      makeElement({
        ref: 'e47',
        name: 'Add to cart',
        selector: '#tbodyid > div:nth-of-type(2) > div > a',
        bounds: makeBounds({ x: 436, y: 414, left: 436, top: 414, right: 584, bottom: 464, width: 148, height: 50 }),
      }),
    ],
    visibleElementCount: 70,
    displayedElementCount: 35,
    omittedElementCount: 35,
  });

  const harness = installChromeHarness({
    snapshots: [beforeSnapshot, firstAfterSnapshot, navigatedSnapshot],
  });

  try {
    const result = await browserClick(1, 'e41', 's-before-nav', {
      useActionMemory: false,
      postconditions: [{ type: 'textVisible', value: 'Add to cart' }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.snapshot?.url, 'https://www.demoblaze.com/prod.html?idp_=2');
    assert.equal(result.postconditions?.[0]?.ok, true);
    assert.equal(harness.clickCalls, 1);
  } finally {
    uninstallChromeHarness();
  }
});

test('browserClick waits for async textVisible postconditions after a successful click', async () => {
  snapshotCounter = 0;
  const beforeSnapshot = makeSnapshot({
    snapshotId: 's-before',
    elements: [makeElement({ ref: 'e41' })],
  });
  const firstAfterSnapshot = makeSnapshot({
    snapshotId: 's-after-1',
    url: 'https://www.demoblaze.com/prod.html?idp_=2',
    elements: [makeElement({ ref: 'e34', role: 'heading', tagName: 'h2', actionable: false, name: 'Nokia lumia 1520' })],
    visibleElementCount: 52,
    displayedElementCount: 29,
    omittedElementCount: 23,
  });
  const settledAfterSnapshot = makeSnapshot({
    snapshotId: 's-after-2',
    url: 'https://www.demoblaze.com/prod.html?idp_=2',
    elements: [
      makeElement({ ref: 'e34', role: 'heading', tagName: 'h2', actionable: false, name: 'Nokia lumia 1520' }),
      makeElement({
        ref: 'e47',
        name: 'Add to cart',
        selector: '#tbodyid > div:nth-of-type(2) > div > a',
        bounds: makeBounds({ x: 436, y: 414, left: 436, top: 414, right: 584, bottom: 464, width: 148, height: 50 }),
      }),
    ],
    visibleElementCount: 70,
    displayedElementCount: 35,
    omittedElementCount: 35,
  });

  const harness = installChromeHarness({
    snapshots: [beforeSnapshot, firstAfterSnapshot, settledAfterSnapshot],
  });

  try {
    const result = await browserClick(1, 'e41', 's-before', {
      useActionMemory: false,
      postconditions: [{ type: 'textVisible', value: 'Add to cart' }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.postconditions?.[0]?.ok, true);
    assert.equal(result.snapshot?.url, 'https://www.demoblaze.com/prod.html?idp_=2');
    assert.equal(harness.clickCalls, 1);
    assert.equal(harness.resolveCalls >= 1, true);
  } finally {
    uninstallChromeHarness();
  }
});

test('browserClick returns a warning instead of a hard failure when href navigation succeeds but the requested text postcondition is wrong', async () => {
  snapshotCounter = 0;
  const beforeSnapshot = makeSnapshot({
    snapshotId: 's-before-price',
    url: 'https://www.demoblaze.com/#',
    elements: [makeElement({ ref: 'e65', name: 'MacBook air' })],
  });
  const afterSnapshot = makeSnapshot({
    snapshotId: 's-after-price',
    url: 'https://www.demoblaze.com/prod.html?idp_=11',
    elements: [
      makeElement({ ref: 'e34', role: 'heading', tagName: 'h2', actionable: false, name: 'MacBook air' }),
      makeElement({ ref: 'e36', role: 'heading', tagName: 'h3', actionable: false, name: '$700 *includes tax' }),
      makeElement({ ref: 'e47', name: 'Add to cart', selector: '#tbodyid > div:nth-of-type(2) > div > a' }),
    ],
    visibleElementCount: 70,
    displayedElementCount: 35,
    omittedElementCount: 35,
  });

  const harness = installChromeHarness({
    snapshots: [beforeSnapshot, afterSnapshot, afterSnapshot, afterSnapshot, afterSnapshot, afterSnapshot, afterSnapshot, afterSnapshot],
    clickResult: {
      ok: true,
      clicked: {
        selector: 'brow-ref://s-before-price/e65',
        tagName: 'a',
        text: 'MacBook air',
        href: 'https://www.demoblaze.com/prod.html?idp_=11',
      },
    },
    resolveEntry: makeElement({ ref: 'e65', name: 'MacBook air', selector: '#tbodyid > div:nth-of-type(3) > div > div > h4 > a' }),
  });

  try {
    const result = await browserClick(1, 'e65', 's-before-price', {
      useActionMemory: false,
      postconditions: [{ type: 'textVisible', value: 'Price' }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.equal(result.repairNeeded, false);
    assert.equal(result.postconditions?.[0]?.ok, false);
    assert.match(result.warning ?? '', /navigated to the clicked href/i);
    assert.match(result.warning ?? '', /urlIncludes|elementVisible/i);
    assert.equal(result.snapshot?.url, 'https://www.demoblaze.com/prod.html?idp_=11');
    assert.equal(harness.clickCalls, 1);
  } finally {
    uninstallChromeHarness();
  }
});

test('browserClick keeps text postcondition mismatches as hard failures when no navigation occurred', async () => {
  snapshotCounter = 0;
  const beforeSnapshot = makeSnapshot({
    snapshotId: 's-before-same-page',
    url: 'https://www.demoblaze.com/prod.html?idp_=11',
    elements: [makeElement({ ref: 'e47', name: 'Add to cart', selector: '#tbodyid > div:nth-of-type(2) > div > a' })],
  });
  const afterSnapshot = makeSnapshot({
    snapshotId: 's-after-same-page',
    url: 'https://www.demoblaze.com/prod.html?idp_=11',
    elements: [makeElement({ ref: 'e47', name: 'Add to cart', selector: '#tbodyid > div:nth-of-type(2) > div > a' })],
  });

  const harness = installChromeHarness({
    snapshots: [beforeSnapshot, afterSnapshot, afterSnapshot, afterSnapshot, afterSnapshot, afterSnapshot, afterSnapshot, afterSnapshot],
    clickResult: {
      ok: true,
      clicked: {
        selector: 'brow-ref://s-before-same-page/e47',
        tagName: 'a',
        text: 'Add to cart',
        href: 'javascript:void(0)',
      },
    },
    resolveEntry: makeElement({ ref: 'e47', name: 'Add to cart', selector: '#tbodyid > div:nth-of-type(2) > div > a' }),
  });

  try {
    const result = await browserClick(1, 'e47', 's-before-same-page', {
      useActionMemory: false,
      postconditions: [{ type: 'textVisible', value: 'Price' }],
    });

    assert.equal(result.ok, false);
    assert.equal(result.warning, undefined);
    assert.equal(result.repairNeeded, true);
    assert.equal(result.error, 'Click postcondition failed');
    assert.equal(result.postconditions?.[0]?.ok, false);
    assert.equal(harness.clickCalls, 1);
  } finally {
    uninstallChromeHarness();
  }
});

test('browserClick retries a navigable href with a programmatic click when the first click leaves the page on the same URL', async () => {
  snapshotCounter = 0;
  const beforeSnapshot = makeSnapshot({
    snapshotId: 's-before-retry',
    url: 'https://www.demoblaze.com/index.html#',
    elements: [makeElement({ ref: 'e58', name: 'Nokia lumia 1520' })],
  });
  const firstAfterSnapshot = makeSnapshot({
    snapshotId: 's-after-retry-1',
    url: 'https://www.demoblaze.com/index.html#',
    elements: [makeElement({ ref: 'e58', name: 'Nokia lumia 1520' })],
    visibleElementCount: 78,
    displayedElementCount: 41,
    omittedElementCount: 37,
  });
  const repairedSnapshot = makeSnapshot({
    snapshotId: 's-after-retry-2',
    url: 'https://www.demoblaze.com/prod.html?idp_=2',
    elements: [
      makeElement({ ref: 'e34', role: 'heading', tagName: 'h2', actionable: false, name: 'Nokia lumia 1520' }),
      makeElement({ ref: 'e47', name: 'Add to cart', selector: '#tbodyid > div:nth-of-type(2) > div > a' }),
    ],
    visibleElementCount: 70,
    displayedElementCount: 35,
    omittedElementCount: 35,
  });

  const harness = installChromeHarness({
    snapshots: [beforeSnapshot, firstAfterSnapshot, repairedSnapshot],
    clickResults: [
      {
        ok: true,
        clicked: {
          selector: 'brow-ref://s-before-retry/e58',
          tagName: 'a',
          text: 'Nokia lumia 1520',
          href: 'https://www.demoblaze.com/prod.html?idp_=2',
        },
      },
      {
        ok: true,
        clicked: {
          selector: 'brow-ref://s-before-retry/e58',
          tagName: 'a',
          text: 'Nokia lumia 1520',
          href: 'https://www.demoblaze.com/prod.html?idp_=2',
        },
      },
    ],
    resolveEntry: makeElement({ ref: 'e58', name: 'Nokia lumia 1520', selector: '#tbodyid > div:nth-of-type(2) > div > div > h4 > a' }),
  });

  try {
    const result = await browserClick(1, 'e58', 's-before-retry', {
      useActionMemory: false,
      postconditions: [{ type: 'textVisible', value: 'Nokia lumia 1520' }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.snapshot?.url, 'https://www.demoblaze.com/prod.html?idp_=2');
    assert.equal(result.repairNeeded, false);
    assert.equal(harness.clickCalls, 2);
    assert.deepEqual(harness.clickModes, [undefined, 'programmatic']);
    assert.deepEqual(harness.urlUpdates, []);
    assert.equal(result.action?.navigationFallback, undefined);
  } finally {
    uninstallChromeHarness();
  }
});

test('browserClick falls back to direct tab navigation when both DOM click attempts leave a navigable href on the same URL', async () => {
  snapshotCounter = 0;
  const beforeSnapshot = makeSnapshot({
    snapshotId: 's-before-tab-fallback',
    url: 'https://www.demoblaze.com/index.html#',
    elements: [makeElement({ ref: 'e58', name: 'Nokia lumia 1520' })],
    visibleElementCount: 78,
    displayedElementCount: 41,
    omittedElementCount: 37,
  });
  const firstAfterSnapshot = makeSnapshot({
    snapshotId: 's-after-tab-fallback-1',
    url: 'https://www.demoblaze.com/index.html#',
    elements: [makeElement({ ref: 'e58', name: 'Nokia lumia 1520' })],
    visibleElementCount: 78,
    displayedElementCount: 41,
    omittedElementCount: 37,
  });
  const secondAfterSnapshot = makeSnapshot({
    snapshotId: 's-after-tab-fallback-2',
    url: 'https://www.demoblaze.com/index.html#',
    elements: [makeElement({ ref: 'e58', name: 'Nokia lumia 1520' })],
    visibleElementCount: 78,
    displayedElementCount: 41,
    omittedElementCount: 37,
  });
  const repairedSnapshot = makeSnapshot({
    snapshotId: 's-after-tab-fallback-3',
    url: 'https://www.demoblaze.com/prod.html?idp_=2',
    elements: [
      makeElement({ ref: 'e34', role: 'heading', tagName: 'h2', actionable: false, name: 'Nokia lumia 1520' }),
      makeElement({ ref: 'e47', name: 'Add to cart', selector: '#tbodyid > div:nth-of-type(2) > div > a' }),
    ],
    visibleElementCount: 76,
    displayedElementCount: 40,
    omittedElementCount: 36,
  });

  const harness = installChromeHarness({
    snapshots: [beforeSnapshot, firstAfterSnapshot, secondAfterSnapshot, repairedSnapshot],
    clickResults: [
      {
        ok: true,
        clicked: {
          tagName: 'a',
          text: 'Nokia lumia 1520',
          selector: '#tbodyid > div:nth-of-type(1) > div > div:nth-of-type(2) > h4 > a',
          href: 'https://www.demoblaze.com/prod.html?idp_=2',
        },
      },
      {
        ok: true,
        clicked: {
          tagName: 'a',
          text: 'Nokia lumia 1520',
          selector: '#tbodyid > div:nth-of-type(1) > div > div:nth-of-type(2) > h4 > a',
          href: 'https://www.demoblaze.com/prod.html?idp_=2',
        },
      },
    ],
  });

  try {
    const result = await browserClick(1, 'e58', 's-before-tab-fallback', {
      useActionMemory: false,
      postconditions: [{ type: 'textVisible', value: 'Nokia lumia 1520' }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.snapshot?.url, 'https://www.demoblaze.com/prod.html?idp_=2');
    assert.equal(result.repairNeeded, false);
    assert.equal(harness.clickCalls, 2);
    assert.deepEqual(harness.clickModes, [undefined, 'programmatic']);
    assert.deepEqual(harness.urlUpdates, ['https://www.demoblaze.com/prod.html?idp_=2']);
    assert.equal(result.action?.navigationFallback?.method, 'tabs.update');
  } finally {
    uninstallChromeHarness();
  }
});

test('browserClick fails when a navigable href never leaves the current URL even if textVisible stays true', async () => {
  snapshotCounter = 0;
  const beforeSnapshot = makeSnapshot({
    snapshotId: 's-before-stuck',
    url: 'https://www.demoblaze.com/index.html#',
    elements: [makeElement({ ref: 'e58', name: 'Nokia lumia 1520' })],
  });
  const stuckSnapshot = makeSnapshot({
    snapshotId: 's-after-stuck',
    url: 'https://www.demoblaze.com/index.html#',
    elements: [makeElement({ ref: 'e58', name: 'Nokia lumia 1520' })],
    visibleElementCount: 78,
    displayedElementCount: 41,
    omittedElementCount: 37,
  });

  const harness = installChromeHarness({
    snapshots: [beforeSnapshot, stuckSnapshot, stuckSnapshot, stuckSnapshot],
    clickResults: [
      {
        ok: true,
        clicked: {
          selector: 'brow-ref://s-before-stuck/e58',
          tagName: 'a',
          text: 'Nokia lumia 1520',
          href: 'https://www.demoblaze.com/prod.html?idp_=2',
        },
      },
      {
        ok: true,
        clicked: {
          selector: 'brow-ref://s-before-stuck/e58',
          tagName: 'a',
          text: 'Nokia lumia 1520',
          href: 'https://www.demoblaze.com/prod.html?idp_=2',
        },
      },
    ],
    resolveEntry: makeElement({ ref: 'e58', name: 'Nokia lumia 1520', selector: '#tbodyid > div:nth-of-type(2) > div > div > h4 > a' }),
  });

  try {
    const result = await browserClick(1, 'e58', 's-before-stuck', {
      useActionMemory: false,
      postconditions: [{ type: 'textVisible', value: 'Nokia lumia 1520' }],
    });

    assert.equal(result.ok, false);
    assert.equal(result.repairNeeded, true);
    assert.match(result.error ?? '', /did not navigate|clicked href/i);
    assert.equal(result.snapshot?.url, 'https://www.demoblaze.com/index.html#');
    assert.equal(harness.clickCalls, 2);
    assert.deepEqual(harness.clickModes, [undefined, 'programmatic']);
    assert.deepEqual(harness.urlUpdates, ['https://www.demoblaze.com/prod.html?idp_=2']);
    assert.equal(result.action?.navigationFallback?.method, 'tabs.update');
  } finally {
    uninstallChromeHarness();
  }
});

test('browserClick does not skip generic clicks when dialogClosed is already true before the click', async () => {
  snapshotCounter = 0;
  const beforeSnapshot = makeSnapshot({
    snapshotId: 's-before',
    url: 'https://www.demoblaze.com/prod.html?idp_=2',
    elements: [makeElement({ ref: 'e47', name: 'Add to cart', selector: '#tbodyid > div:nth-of-type(2) > div > a' })],
  });
  const afterSnapshot = makeSnapshot({
    snapshotId: 's-after',
    url: 'https://www.demoblaze.com/prod.html?idp_=2',
    elements: [makeElement({ ref: 'e47', name: 'Add to cart', selector: '#tbodyid > div:nth-of-type(2) > div > a' })],
  });

  const harness = installChromeHarness({
    snapshots: [beforeSnapshot, afterSnapshot],
    clickResult: {
      ok: true,
      clicked: {
        selector: 'brow-ref://s-before/e47',
        tagName: 'a',
        text: 'Add to cart',
        href: 'javascript:void(0)',
      },
    },
    resolveEntry: makeElement({ ref: 'e47', name: 'Add to cart', selector: '#tbodyid > div:nth-of-type(2) > div > a' }),
  });

  try {
    const result = await browserClick(1, 'e47', 's-before', {
      useActionMemory: false,
      postconditions: [{ type: 'dialogClosed' }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.action?.skipped, undefined);
    assert.equal(harness.clickCalls, 1);
    assert.equal(result.postconditions?.[0]?.ok, true);
  } finally {
    uninstallChromeHarness();
  }
});
