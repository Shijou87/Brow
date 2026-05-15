const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getUnsafeEditableClickIntentError,
  getUnsafePromotedClickResolutionError,
  isIntentRecoveryEntryAllowed,
  shouldRepairForSatisfiedValuePostconditions,
  shouldSkipActionForSatisfiedPostconditions,
} = require('../.tmp-click-intent-guards-test/sidepanel/tab-tools/click-intent-guards.js');

test('disallows typeable controls as click intent-recovery targets', () => {
  assert.equal(isIntentRecoveryEntryAllowed({ role: 'combobox', tagName: 'input' }, 'click'), false);
  assert.equal(isIntentRecoveryEntryAllowed({ role: 'textbox', tagName: 'textarea' }, 'click'), false);
  assert.equal(isIntentRecoveryEntryAllowed({ role: 'link', tagName: 'a' }, 'click'), true);
});

test('skips click actions when all requested postconditions are already satisfied', () => {
  assert.equal(shouldSkipActionForSatisfiedPostconditions([
    { ok: true, condition: { type: 'mediaState', value: 'playing' }, actual: 'playing' },
  ]), true);

  assert.equal(shouldSkipActionForSatisfiedPostconditions([
    { ok: true, condition: { type: 'valueEquals', value: 'Rabat' }, actual: 'Rabat' },
  ]), true);

  assert.equal(shouldSkipActionForSatisfiedPostconditions([
    { ok: false, condition: { type: 'mediaState', value: 'playing' }, actual: 'paused' },
  ]), false);

  assert.equal(shouldSkipActionForSatisfiedPostconditions([]), false);
});

test('does not skip clicks for already-visible label text or element presence checks', () => {
  assert.equal(shouldSkipActionForSatisfiedPostconditions([
    { ok: true, condition: { type: 'textVisible', value: 'Departure' } },
  ]), false);

  assert.equal(shouldSkipActionForSatisfiedPostconditions([
    { ok: true, condition: { type: 'elementVisible', ref: 'e216', snapshotId: 's1' }, actual: 'Departure' },
  ]), false);
});

test('does not skip clicks just because dialogClosed is currently satisfied', () => {
  assert.equal(shouldSkipActionForSatisfiedPostconditions([
    { ok: true, condition: { type: 'dialogClosed' }, actual: 'closed' },
  ]), false);
});

test('marks satisfied valueEquals postconditions as a repair case', () => {
  assert.equal(shouldRepairForSatisfiedValuePostconditions([
    { ok: true, condition: { type: 'valueEquals', ref: 'e17', value: 'Paris' }, actual: 'Paris' },
  ]), true);
});

test('does not mark non-value postconditions as a repair case', () => {
  assert.equal(shouldRepairForSatisfiedValuePostconditions([
    { ok: true, condition: { type: 'urlIncludes', value: 'google.com/travel/flights' }, actual: 'https://www.google.com/travel/flights' },
  ]), false);
});

test('rejects promoted click resolutions from large container refs', () => {
  const error = getUnsafePromotedClickResolutionError({
    promotedFrom: {
      role: 'text',
      tagName: 'ytd-page-manager',
      selector: '#page-manager',
      bounds: { width: 919.2, height: 2125.7 },
    },
    entry: {
      role: 'button',
      tagName: 'button',
      selector: '#subscribe-button',
      bounds: { width: 93.9, height: 36 },
    },
  });

  assert.match(error, /large non-actionable container/);
});

test('allows promoted click resolutions from small child refs inside a button', () => {
  const error = getUnsafePromotedClickResolutionError({
    promotedFrom: {
      role: 'text',
      tagName: 'span',
      selector: 'button > span',
      bounds: { width: 48, height: 14 },
    },
    entry: {
      role: 'button',
      tagName: 'button',
      selector: 'button',
      bounds: { width: 96, height: 36 },
    },
  });

  assert.equal(error, undefined);
});

test('rejects submit-like click intents on editable controls', () => {
  const error = getUnsafeEditableClickIntentError(
    { role: 'combobox', tagName: 'input' },
    'click search button',
  );

  assert.match(error, /editable field/);
  assert.match(error, /browser_snapshot/);
});

test('allows editable clicks for field-focus intents', () => {
  const error = getUnsafeEditableClickIntentError(
    { role: 'textbox', tagName: 'input' },
    'open departure date picker',
  );

  assert.equal(error, undefined);
});