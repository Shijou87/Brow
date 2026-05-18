const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getFormSnapshotControlPriority,
  prioritizeFormSnapshotControls,
} = require('../.tmp/form-snapshot-priority-test/content-script/form-snapshot-priority.js');

function control(index, overrides = {}) {
  return {
    index,
    visible: true,
    hidden: false,
    disabled: false,
    readonly: false,
    fillControl: false,
    purpose: 'unknown',
    tagName: 'button',
    role: 'button',
    hasForm: false,
    ...overrides,
  };
}

test('prioritizes visible native text-entry fields ahead of buttons and hidden controls', () => {
  const ordered = prioritizeFormSnapshotControls([
    control(0, { purpose: 'submit' }),
    control(1, { fillControl: true, tagName: 'div', role: 'combobox' }),
    control(2),
    control(3, { fillControl: true, tagName: 'input', role: 'combobox', type: 'text' }),
    control(4, { fillControl: true, tagName: 'input', role: 'combobox', type: 'text' }),
    control(5, { fillControl: true, tagName: 'input', role: 'textbox', type: 'text' }),
    control(6, { fillControl: true, tagName: 'input', role: 'textbox', type: 'text' }),
    control(7, { hidden: true, visible: false, purpose: 'submit' }),
  ]);

  assert.deepEqual(ordered.slice(0, 4).map((entry) => entry.index), [3, 4, 5, 6]);
  assert.equal(ordered.at(-1).index, 7);
});

test('preserves DOM order for equally ranked controls', () => {
  const ordered = prioritizeFormSnapshotControls([
    control(2, { fillControl: true, tagName: 'input', role: 'textbox', type: 'text' }),
    control(5, { fillControl: true, tagName: 'input', role: 'textbox', type: 'text' }),
  ]);

  assert.deepEqual(ordered.map((entry) => entry.index), [2, 5]);
});

test('scores native text inputs above custom combobox wrappers', () => {
  const tripTypeScore = getFormSnapshotControlPriority(
    control(0, { fillControl: true, tagName: 'div', role: 'combobox' }),
  );
  const originScore = getFormSnapshotControlPriority(
    control(1, { fillControl: true, tagName: 'input', role: 'combobox', type: 'text' }),
  );

  assert.ok(originScore > tripTypeScore);
});