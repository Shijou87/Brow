const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildToolContextCarryForwardMessage,
} = require('../.tmp-tool-context-carry-forward-test/sidepanel/agent-runtime/tool-context-carry-forward.js');

test('returns null when no completed or error steps exist', () => {
  assert.equal(buildToolContextCarryForwardMessage([
    { label: 'Browser snapshot', toolName: 'browser_snapshot', status: 'running' },
    { label: 'Browser click', toolName: 'browser_click', status: 'awaiting_approval' },
  ]), null);
});

test('keeps only the latest successful step from older successful history', () => {
  const summary = buildToolContextCarryForwardMessage([
    {
      label: 'Create tab',
      toolName: 'create_tab',
      status: 'completed',
      resultText: '{"ok":true}',
    },
    {
      label: 'Initial snapshot',
      toolName: 'browser_snapshot',
      status: 'completed',
      resultText: 'initial snapshot text',
    },
    {
      label: 'Submit click',
      toolName: 'browser_click',
      status: 'completed',
      resultText: 'clicked login',
    },
    {
      label: 'Final snapshot',
      toolName: 'browser_snapshot',
      status: 'completed',
      resultText: 'products snapshot text',
    },
  ]);

  assert.match(summary, /Final snapshot \(browser_snapshot\) \[completed\]/);
  assert.doesNotMatch(summary, /Create tab \(create_tab\) \[completed\]/);
  assert.doesNotMatch(summary, /Initial snapshot \(browser_snapshot\) \[completed\]/);
  assert.doesNotMatch(summary, /Submit click \(browser_click\) \[completed\]/);
});

test('preserves error context alongside the latest successful step', () => {
  const summary = buildToolContextCarryForwardMessage([
    {
      label: 'Initial snapshot',
      toolName: 'browser_snapshot',
      status: 'completed',
      resultText: 'initial snapshot text',
    },
    {
      label: 'Click search',
      toolName: 'browser_click',
      status: 'error',
      errorText: 'Resolved click target is an editable field.',
    },
    {
      label: 'Form snapshot',
      toolName: 'browser_form_snapshot',
      status: 'completed',
      resultText: 'form snapshot text',
    },
    {
      label: 'Submit click',
      toolName: 'browser_click',
      status: 'completed',
      resultText: 'submit succeeded',
    },
  ]);

  assert.match(summary, /Click search \(browser_click\) \[error\]/);
  assert.match(summary, /Resolved click target is an editable field\./);
  assert.match(summary, /Submit click \(browser_click\) \[completed\]/);
  assert.doesNotMatch(summary, /Form snapshot \(browser_form_snapshot\) \[completed\]/);
});