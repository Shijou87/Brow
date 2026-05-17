const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SYSTEM_PROMPT,
} = require('../.tmp-system-prompt-guidance-test/config.js');

test('system prompt explains that postconditions are verification only', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /Postconditions are verification checks only/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /For page-opening link clicks, prefer urlIncludes or elementVisible over generic textVisible guesses like "Price", "Details", or "Info"/);
});

test('system prompt forbids using editable clicks as fake submit actions', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /Never use a click on an editable field as a stand-in for search, submit, continue, ok, or launch/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /If the real submit\/search control is not visible, take a fuller browser snapshot or form snapshot instead of guessing/);
});

test('system prompt says already-satisfied fields are complete', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /If a form field already shows the requested value in the current snapshot, treat that field as complete/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Do not click or type it again/);
});

test('system prompt says autocomplete comboboxes require option selection', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /If a field is a combobox or autocomplete and the snapshot shows selection-required state or a visible popup/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Complete the field by selecting a matching popup option before moving on/);
});

test('system prompt allows proactive HTML App Artifact creation when interactive output would help', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /interactive artifact would help more than plain text/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /html_artifact_upsert/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /square-first viewport/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /avoid redundant headings unless requested/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /purple-on-charcoal look/);
});

test('system prompt prefers adapting current-tab app code when the user asks for inspiration', () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /When the user asks for an app inspired by the current tab, inspect the active tab first/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /prefer recovering the current tab's HTML\/CSS\/JS structure and adapting it instead of recreating the app from memory/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /adapt the observed structure and behavior without cloning proprietary source verbatim/);
});
