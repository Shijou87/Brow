const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_DISABLED_TOOL_NAMES,
  isApprovalGatedToolName,
  isAutomationToolName,
} = require('../.tmp-tool-classification-test/sidepanel/agent-runtime/tool-classification.js');

test('keeps outbound screenshot and visual-query tools approval-gated without treating them as default-disabled automation', () => {
  assert.equal(isAutomationToolName('browser_visual_query'), false);
  assert.equal(isAutomationToolName('tab_screenshot_vlm'), false);

  assert.equal(isApprovalGatedToolName('browser_visual_query'), true);
  assert.equal(isApprovalGatedToolName('tab_screenshot_vlm'), true);
  assert.equal(isApprovalGatedToolName('http_fetch'), true);
  assert.equal(isApprovalGatedToolName('browser_click'), true);

  assert.equal(DEFAULT_DISABLED_TOOL_NAMES.has('browser_visual_query'), false);
  assert.equal(DEFAULT_DISABLED_TOOL_NAMES.has('tab_screenshot_vlm'), false);
  assert.equal(DEFAULT_DISABLED_TOOL_NAMES.has('browser_click'), true);
});