const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getWebMCPAftermathWaitMs,
  isLikelyMutatingWebMCPTool,
  shouldCaptureWebMCPAftermath,
} = require('../.tmp-webmcp-aftermath-test/sidepanel/webmcp-tool-factory.js');

test('treats read-style WebMCP tools as no-snapshot aftermath by default', () => {
  const descriptor = {
    name: 'get_status',
    description: 'Read the current status from the page',
    inputSchema: {},
  };

  assert.equal(isLikelyMutatingWebMCPTool(descriptor), false);
  assert.equal(shouldCaptureWebMCPAftermath(descriptor, { ok: true }), false);
  assert.equal(getWebMCPAftermathWaitMs(descriptor, { ok: true }), 0);
});

test('treats mutating WebMCP tools as snapshot-worthy only after successful calls', () => {
  const descriptor = {
    name: 'submit_login',
    description: 'Submit the login form and navigate to the inventory page',
    inputSchema: { type: 'object', properties: { username: { type: 'string' } } },
  };

  assert.equal(isLikelyMutatingWebMCPTool(descriptor), true);
  assert.equal(shouldCaptureWebMCPAftermath(descriptor, { ok: true }), true);
  assert.equal(getWebMCPAftermathWaitMs(descriptor, { ok: true }), 180);
  assert.equal(shouldCaptureWebMCPAftermath(descriptor, { ok: false }), false);
});