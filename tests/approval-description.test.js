const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildApprovalAwaitingDescription,
} = require('../.tmp/approval-description-test/sidepanel/agent-runtime/approval-description.js');

test('describes http_fetch approvals with the request method and destination host', () => {
  const description = buildApprovalAwaitingDescription({
    toolName: 'http_fetch',
    input: {
      url: 'https://api.example.com/v1/report?token=secret',
      method: 'post',
    },
  });

  assert.equal(
    description,
    'Awaiting approval to send an HTTP POST request to api.example.com. This can transfer data off-device.',
  );
});

test('describes browser_visual_query approvals as region screenshot transfers to the VLM host', () => {
  const description = buildApprovalAwaitingDescription({
    toolName: 'browser_visual_query',
    input: { query: 'read the chart' },
    vlmBaseUrl: 'https://vlm.example.com/v1',
  });

  assert.equal(
    description,
    'Awaiting approval to send a region screenshot to the VLM endpoint at vlm.example.com. This can transfer page data off-device.',
  );
});

test('describes tab_screenshot_vlm approvals as full-tab screenshot transfers', () => {
  const description = buildApprovalAwaitingDescription({
    toolName: 'tab_screenshot_vlm',
    input: { query: 'describe the page' },
    vlmBaseUrl: 'https://vlm.example.com/v1',
  });

  assert.equal(
    description,
    'Awaiting approval to send a tab screenshot to the VLM endpoint at vlm.example.com. This can transfer page data off-device.',
  );
});

test('falls back to the generic approval copy for non-transfer actions', () => {
  const description = buildApprovalAwaitingDescription({
    toolName: 'browser_click',
    input: { ref: 'e12' },
  });

  assert.equal(description, 'Awaiting approval to run this action.');
});