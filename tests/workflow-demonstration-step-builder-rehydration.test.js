const test = require('node:test');
const assert = require('node:assert/strict');

const {
  StepBuilder,
} = require('../.tmp/workflow-step-builder-test/shared/workflow-demonstration/step-builder.js');

function createTarget(name, selector) {
  return {
    selector,
    signature: {
      role: 'button',
      name,
      tagName: 'button',
      selector,
    },
  };
}

test('StepBuilder resumes recording cleanly after rehydration on a later page', () => {
  const startTab = {
    tabId: 7,
    title: 'Start page',
    url: 'https://example.com/start',
  };
  const nextTab = {
    tabId: 7,
    title: 'Next page',
    url: 'https://example.com/next',
  };

  const builder = new StepBuilder(startTab, { captureTypedValues: true });
  builder.addEvent({
    kind: 'click',
    timestamp: 1000,
    tab: startTab,
    target: createTarget('Begin', 'button.begin'),
  });

  const partial = builder.build({
    id: 'demo-1',
    title: 'demo1',
    demonstratedTab: startTab,
    createdAt: 1000,
    updatedAt: 1500,
  });

  const restored = StepBuilder.fromDemonstration(partial, { captureTypedValues: true });
  restored.addEvent({
    kind: 'navigation',
    timestamp: 2000,
    tab: nextTab,
  });
  restored.addEvent({
    kind: 'click',
    timestamp: 2100,
    tab: nextTab,
    target: createTarget('Continue', 'button.continue'),
  });

  const final = restored.build({
    id: 'demo-1',
    title: 'demo1',
    demonstratedTab: nextTab,
    createdAt: 1000,
    updatedAt: 2200,
  });

  assert.equal(final.steps.length, 3);
  assert.equal(final.steps[0].kind, 'click');
  assert.equal(final.steps[1].kind, 'navigate');
  assert.equal(final.steps[2].kind, 'click');
  assert.equal(final.steps[1].tab.url, nextTab.url);
  assert.equal(final.steps[2].trace.urlBefore, nextTab.url);
  assert.equal(final.steps[2].trace.urlAfter, nextTab.url);
});
