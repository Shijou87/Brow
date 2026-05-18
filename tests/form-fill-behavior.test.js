const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chooseInferredFormSubmitCandidateIndex,
  getFormFillActionOutcome,
  getFormFillTextCommitMode,
} = require('../.tmp/form-fill-behavior-test/form-fill-behavior.js');

test('commits combobox-like text fields after value injection', () => {
  assert.equal(getFormFillTextCommitMode({
    tagName: 'input',
    role: 'combobox',
    ariaAutocomplete: 'list',
  }), 'enter');

  assert.equal(getFormFillTextCommitMode({
    tagName: 'input',
    ariaAutocomplete: 'list',
  }), 'enter');
});

test('does not force a commit for plain textboxes', () => {
  assert.equal(getFormFillTextCommitMode({
    tagName: 'input',
    role: 'textbox',
    type: 'text',
  }), 'none');
});

test('infers a clear continue submit control for non-form checkout flows', () => {
  assert.equal(chooseInferredFormSubmitCandidateIndex([
    {
      tagName: 'button',
      type: 'button',
      text: 'Open Menu',
      role: 'button',
      testId: 'react-burger-menu-btn',
    },
    {
      tagName: 'button',
      type: 'button',
      text: 'Cancel',
      role: 'button',
      testId: 'cancel',
    },
    {
      tagName: 'input',
      type: 'submit',
      text: 'Continue',
      testId: 'continue',
      name: 'continue',
      id: 'continue',
    },
  ]), 2);
});

test('does not infer a submit control when candidates are ambiguous', () => {
  assert.equal(chooseInferredFormSubmitCandidateIndex([
    {
      tagName: 'button',
      type: 'button',
      text: 'Save',
      role: 'button',
      testId: 'save-primary',
    },
    {
      tagName: 'button',
      type: 'button',
      text: 'Apply',
      role: 'button',
      testId: 'apply-primary',
    },
  ]), undefined);
});

test('treats missing native form submission as a warning when fields were filled', () => {
  assert.deepEqual(getFormFillActionOutcome({
    hadFieldErrors: false,
    submitRequested: true,
    submitted: false,
    submitError: 'No parent form found to submit',
  }), {
    ok: true,
    warning: 'No parent form found to submit',
  });
});

test('keeps missing explicit submit targets as a hard error', () => {
  assert.deepEqual(getFormFillActionOutcome({
    hadFieldErrors: false,
    submitRequested: true,
    submitted: false,
    submitError: 'Submit element not found for selector: #search',
  }), {
    ok: false,
    error: 'Submit element not found for selector: #search',
  });
});

test('keeps field fill errors as hard failures', () => {
  assert.deepEqual(getFormFillActionOutcome({
    hadFieldErrors: true,
    submitRequested: false,
    submitted: false,
  }), {
    ok: false,
    error: 'One or more form fields could not be filled',
  });
});