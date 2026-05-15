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