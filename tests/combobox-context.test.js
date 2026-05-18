const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildComboboxState,
} = require('../.tmp/combobox-context-test/shared/combobox-state.js');
const {
  formatBrowserSnapshot,
} = require('../.tmp/combobox-context-test/sidepanel/agent-runtime/tool-result-snapshot.js');

test('builds selection-required combobox state for external listbox options', () => {
  const state = buildComboboxState({
    role: 'combobox',
    accessibleName: 'A',
    currentValue: 'Rabat',
    placeholder: 'Where to?',
    ariaExpanded: 'true',
    ariaControls: 'flight-destination-popup',
    ariaAutocomplete: 'list',
    ariaActiveDescendant: 'flight-option-rabat',
    controlledPopup: {
      ref: 'e20',
      role: 'listbox',
      visible: true,
      options: [
        { ref: 'e21', role: 'option', text: 'Rabat, Morocco', selected: true },
        { ref: 'e22', role: 'option', text: 'Rabat-Sale Airport' },
      ],
    },
  });

  assert.equal(state?.accessibleName, 'A');
  assert.equal(state?.currentValue, 'Rabat');
  assert.equal(state?.ariaExpanded, true);
  assert.equal(state?.requiresOptionSelection, true);
  assert.equal(state?.controlledPopup?.role, 'listbox');
  assert.deepEqual(state?.controlledPopup?.options.map((option) => ({
    ref: option.ref,
    text: option.text,
    selected: option.selected || false,
  })), [
    { ref: 'e21', text: 'Rabat, Morocco', selected: true },
    { ref: 'e22', text: 'Rabat-Sale Airport', selected: false },
  ]);
  assert.match(state?.interactionHint ?? '', /select a matching option from the controlled popup/i);
});

test('formatted browser snapshot shows combobox current value and popup options', () => {
  const text = formatBrowserSnapshot({
    ok: true,
    snapshotId: 's1',
    tabId: 7,
    url: 'https://www.google.com/travel/flights',
    title: 'Flights',
    generatedAt: 0,
    viewport: {
      width: 1280,
      height: 800,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
    },
    elements: [
      {
        ref: 'e12',
        role: 'combobox',
        name: 'A',
        tagName: 'input',
        selector: 'input[aria-label="A"]',
        actionable: true,
        depth: 1,
        bounds: {
          x: 24,
          y: 48,
          left: 24,
          top: 48,
          right: 360,
          bottom: 96,
          width: 336,
          height: 48,
        },
        combobox: {
          accessibleName: 'A',
          currentValue: 'Rabat',
          ariaExpanded: true,
          requiresOptionSelection: true,
          controlledPopup: {
            role: 'listbox',
            visible: true,
            options: [
              { ref: 'e21', role: 'option', text: 'Rabat, Morocco', selected: true },
              { ref: 'e22', role: 'option', text: 'Rabat-Sale Airport' },
            ],
          },
        },
      },
    ],
    visibleElementCount: 3,
    displayedElementCount: 1,
    omittedElementCount: 0,
  });

  assert.match(text, /combobox "A" \[ref=e12\] \[value="Rabat"\] \[select-option\] \[expanded\] \[popup=listbox:2\]/i);
  assert.match(text, /\* option "Rabat, Morocco" \[ref=e21\] \[selected\]/i);
  assert.match(text, /\* option "Rabat-Sale Airport" \[ref=e22\]/i);
});