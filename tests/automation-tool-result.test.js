const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compactAutomationToolResult,
  formatAutomationToolResultText,
} = require('../.tmp/automation-tool-result-test/sidepanel/agent-runtime/automation-tool-result.js');

test('removes duplicate trace payload and collapses resolved target details', () => {
  const compacted = compactAutomationToolResult({
    ok: true,
    action: {
      clicked: {
        selector: 'brow-ref://snap/e20',
        tagName: 'select',
        text: 'Name (A to Z) Name (Z to A) Price (low to high) Price (high to low)',
        type: 'select-one',
      },
      ok: true,
    },
    resolved: {
      ok: true,
      ref: 'e20',
      snapshotId: 'snap',
      entry: {
        ref: 'e20',
        role: 'combobox',
        name: 'Sort order',
        tagName: 'select',
        type: 'select-one',
        selector: 'select[data-test="product-sort-container"]',
        actionable: true,
        depth: 4,
        bounds: { x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 },
      },
      preconditions: {
        visible: true,
        enabled: true,
        stable: true,
        receivesEvents: true,
        actionable: true,
        ok: true,
      },
      region: {
        source: 'ref',
        ref: 'e20',
        snapshotId: 'snap',
        rect: { x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 },
        viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
      },
    },
    trace: {
      traceId: 'trace-1',
      resolvedRef: 'e20',
      execution: { clicked: { selector: 'brow-ref://snap/e20' } },
    },
    postconditions: [{ ok: true, condition: { type: 'textVisible', value: 'Price' } }],
    beforeSnapshot: { ok: true, snapshotId: 'before' },
    backend: 'mv3-dom',
    confidence: 100,
    cacheStatus: 'disabled',
  });

  assert.equal(compacted.trace, undefined);
  assert.equal(compacted.action.ok, undefined);
  assert.equal(compacted.resolved.ref, 'e20');
  assert.equal(compacted.resolved.target.role, 'combobox');
  assert.equal(compacted.resolved.target.tagName, 'select');
  assert.equal(compacted.resolved.region, undefined);
  assert.equal(compacted.resolved.failedPreconditions, undefined);
  assert.equal(compacted.beforeSnapshot, undefined);
  assert.equal(compacted.backend, undefined);
  assert.equal(compacted.confidence, undefined);
  assert.equal(compacted.cacheStatus, undefined);
});

test('keeps failed postconditions and slim recovery candidates for repair cases', () => {
  const compacted = compactAutomationToolResult({
    ok: false,
    resolved: {
      ok: true,
      ref: 'e7',
      originalRef: 'e4',
      snapshotId: 'snap',
      recovered: true,
      matchScore: 84,
      preconditions: { visible: false, ok: false },
      repairCandidates: [
        { ref: 'e7', selector: 'button[type="submit"]', role: 'button', name: 'Search', tagName: 'button', score: 84, bounds: { x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 } },
      ],
    },
    recoveryCandidates: [
      { ref: 'e7', selector: 'button[type="submit"]', role: 'button', name: 'Search', tagName: 'button', score: 84, bounds: { x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 } },
      { ref: 'e8', selector: 'button[data-test="search"]', role: 'button', name: 'Search now', tagName: 'button', score: 73, bounds: { x: 0, y: 0, left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 } },
    ],
    postconditions: [
      {
        ok: false,
        condition: { type: 'textVisible', value: 'Results' },
        actual: 'No results yet',
        error: 'Timed out waiting for text',
      },
    ],
    trace: { traceId: 'trace-1' },
    repairNeeded: true,
  });

  assert.equal(compacted.trace, undefined);
  assert.equal(compacted.resolved.recovered, true);
  assert.equal(compacted.resolved.failedPreconditions.visible, false);
  assert.equal(compacted.resolved.repairCandidates[0].score, 84);
  assert.equal(compacted.recoveryCandidates.length, 2);
  assert.equal(compacted.recoveryCandidates[0].bounds, undefined);
  assert.equal(compacted.postconditions[0].actual, 'No results yet');
  assert.equal(compacted.postconditions[0].error, 'Timed out waiting for text');
});

test('formats successful automation output as terse text without echoing typed values', () => {
  const formatted = formatAutomationToolResultText({
    ok: true,
    action: {
      typed: {
        selector: 'brow-ref://smp4oasee71rbtx/e11',
        tagName: 'input',
        name: 'user-name',
        text: 'standard_user',
        type: 'text',
        id: 'user-name',
        placeholder: 'Username',
      },
    },
    resolved: {
      ok: true,
      ref: 'e11',
      snapshotId: 'smp4oasee71rbtx',
      target: {
        ref: 'e11',
        role: 'textbox',
        name: 'Username',
        tagName: 'input',
        type: 'text',
        actionable: true,
        selector: '#user-name',
      },
    },
    postconditions: [
      {
        ok: true,
        condition: {
          type: 'valueEquals',
          value: 'standard_user',
          ref: 'e11',
          snapshotId: 'smp4oasee71rbtx',
        },
      },
    ],
    snapshotText: 'Browser snapshot snapshotId=smp4oax56iqajhn title="Swag Labs" url=https://www.saucedemo.com/\n      - textbox "Username" [ref=e11] [type=text]\n      - textbox "Password" [ref=e13] [type=password]\n      - button "login-button" [ref=e15] [type=submit]\n... 15 more nodes omitted. Use browser_snapshot for a deeper view.',
  }, 'browser_type');

  assert.match(formatted, /^ok typed \[e11\] textbox "Username"/);
  assert.match(formatted, /page: smp4oax56iqajhn "Swag Labs" https:\/\/www\.saucedemo\.com\//);
  assert.match(formatted, /refs: textbox "Username" \[ref=e11\] \[type=text\]; textbox "Password" \[ref=e13\] \[type=password\]; button "login-button" \[ref=e15\] \[type=submit\]; \+15 more/);
  assert.doesNotMatch(formatted, /standard_user/);
  assert.doesNotMatch(formatted, /"ok":/);
  assert.doesNotMatch(formatted, /^\{/);
});

test('formats failed automation output with compact failure detail', () => {
  const formatted = formatAutomationToolResultText({
    ok: false,
    resolved: {
      ok: true,
      ref: 'e7',
      recovered: true,
      repairCandidates: [
        { ref: 'e7', role: 'button', name: 'Search' },
      ],
    },
    postconditions: [
      {
        ok: false,
        condition: { type: 'textVisible', value: 'Results' },
        actual: 'No results yet',
        error: 'Timed out waiting for text',
      },
    ],
    recoveryCandidates: [
      { ref: 'e7', role: 'button', name: 'Search' },
      { ref: 'e8', role: 'button', name: 'Search now' },
    ],
    repairNeeded: true,
    error: 'Postconditions failed',
  }, 'browser_click');

  assert.match(formatted, /^failed clicked \[e7\] \[recovered\]$/m);
  assert.match(formatted, /postconditions: textVisible "Results" actual="No results yet" error="Timed out waiting for text"/);
  assert.match(formatted, /repair needed/);
  assert.match(formatted, /candidates: \[e7\] button "Search"; \[e8\] button "Search now"/);
  assert.match(formatted, /error: Postconditions failed/);
});