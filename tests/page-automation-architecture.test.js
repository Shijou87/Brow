const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('page-automation delegates postcondition and navigation semantics to ActionPostconditionRuntime', () => {
  const pageAutomationSource = read('src/sidepanel/tab-tools/page-automation.ts');
  const postconditionModuleSource = read('src/sidepanel/tab-tools/page-automation/action-postconditions.ts');

  assert.match(pageAutomationSource, /import\s+\{\s*createActionPostconditionRuntime\s*\}\s+from\s+'\.\/page-automation\/action-postconditions';/);
  assert.match(pageAutomationSource, /const\s+\{\s*[\s\S]*snapshotAfterAction[\s\S]*navigateTabToClickedHref[\s\S]*\}\s*=\s*createActionPostconditionRuntime\(/);

  for (const delegatedHelper of [
    'snapshotAfterAction',
    'waitForClickPostconditions',
    'evaluatePostconditions',
    'postconditionsPassed',
    'getSuccessfulNavigationWarning',
    'getExpectedClickNavigationHref',
    'shouldRetryProgrammaticClickForNavigation',
    'getMissedClickNavigationError',
    'navigateTabToClickedHref',
  ]) {
    assert.equal(
      pageAutomationSource.includes(`function ${delegatedHelper}(`),
      false,
      `page-automation.ts should delegate ${delegatedHelper} instead of re-defining it inline`,
    );
  }

  assert.match(postconditionModuleSource, /export function createActionPostconditionRuntime/);
  assert.match(postconditionModuleSource, /async function evaluatePostconditions\(/);
  assert.match(postconditionModuleSource, /async function waitForClickPostconditions\(/);
  assert.match(postconditionModuleSource, /async function navigateTabToClickedHref\(/);
});

test('page-automation delegates target resolution and intent repair to TargetResolutionRuntime', () => {
  const pageAutomationSource = read('src/sidepanel/tab-tools/page-automation.ts');
  const targetResolutionSource = read('src/sidepanel/tab-tools/page-automation/target-resolution.ts');

  assert.match(pageAutomationSource, /import\s+\{\s*createTargetResolutionRuntime\s*\}\s+from\s+'\.\/page-automation\/target-resolution';/);
  assert.match(pageAutomationSource, /const\s+\{\s*[\s\S]*resolveActionTarget[\s\S]*browserResolveMemoryTarget[\s\S]*\}\s*=\s*createTargetResolutionRuntime\(/);

  for (const delegatedHelper of [
    'resolveActionTarget',
    'browserResolveMemoryTarget',
    'findIntentCandidate',
    'scoreIntentCandidate',
    'normalizeIntentText',
    'tokenizeIntent',
  ]) {
    assert.equal(
      pageAutomationSource.includes(`function ${delegatedHelper}(`),
      false,
      `page-automation.ts should delegate ${delegatedHelper} instead of re-defining it inline`,
    );
  }

  assert.match(targetResolutionSource, /export function createTargetResolutionRuntime/);
  assert.match(targetResolutionSource, /async function resolveActionTarget\(/);
  assert.match(targetResolutionSource, /async function browserResolveMemoryTarget\(/);
  assert.match(targetResolutionSource, /function findIntentCandidate\(/);
});

test('page-automation delegates single-target Brow Action Memory replay to ActionMemoryRuntime', () => {
  const pageAutomationSource = read('src/sidepanel/tab-tools/page-automation.ts');
  const actionMemoryRuntimeSource = read('src/sidepanel/tab-tools/page-automation/action-memory-runtime.ts');

  assert.match(pageAutomationSource, /import\s+\{\s*createActionMemoryRuntime\s*\}\s+from\s+'\.\/page-automation\/action-memory-runtime';/);
  assert.match(pageAutomationSource, /const\s+\{\s*[\s\S]*tryReplaySingleTargetAction[\s\S]*rememberSingleTargetAction[\s\S]*\}\s*=\s*createActionMemoryRuntime\(/);

  for (const delegatedHelper of [
    'tryReplaySingleTargetAction',
    'rememberSingleTargetAction',
  ]) {
    assert.equal(
      pageAutomationSource.includes(`function ${delegatedHelper}(`),
      false,
      `page-automation.ts should delegate ${delegatedHelper} instead of re-defining it inline`,
    );
  }

  assert.match(actionMemoryRuntimeSource, /export function createActionMemoryRuntime/);
  assert.match(actionMemoryRuntimeSource, /async function tryReplaySingleTargetAction\(/);
  assert.match(actionMemoryRuntimeSource, /async function rememberSingleTargetAction\(/);
});

test('page-automation delegates the settling probe to the injected browser runtime', () => {
  const pageAutomationSource = read('src/sidepanel/tab-tools/page-automation.ts');
  const injectedRuntimeSource = read('src/sidepanel/tab-tools/page-automation/injected-action-runtime.ts');
  const runtimeInstallSource = read('src/sidepanel/tab-tools/page-automation/runtime/runtime-install.ts');
  const runtimeEntrySource = read('src/sidepanel/tab-tools/page-automation/runtime-entry.ts');

  assert.match(pageAutomationSource, /import\s+\{\s*[\s\S]*runPageSettlingProbe[\s\S]*\}\s+from\s+'\.\/page-automation\/injected-action-runtime';/);
  assert.match(pageAutomationSource, /export type \{ BrowserClickPoint \} from '\.\/page-automation\/injected-action-runtime';/);
  assert.match(pageAutomationSource, /ensurePageAutomationRuntimeInjected\(tabId/);

  assert.equal(
    pageAutomationSource.includes('function runPageSettlingProbe('),
    false,
    'page-automation.ts should delegate runPageSettlingProbe instead of re-defining it inline',
  );

  assert.match(injectedRuntimeSource, /export type \{/);
  assert.match(injectedRuntimeSource, /export async function runPageAutomationAction\(action: PageAutomationAction\): Promise<unknown>/);
  assert.match(injectedRuntimeSource, /export async function runPageSettlingProbe\([\s\S]*PageSettlingProbeOptions[\s\S]*PageSettlingProbeResult/);
  assert.match(runtimeInstallSource, /export function installPageAutomationRuntime/);
  assert.match(runtimeEntrySource, /installPageAutomationRuntime\(globalThis\);/);
});

test('tab-action-execution delegates injected browser actions to the injected runtime module', () => {
  const tabExecutionSource = read('src/sidepanel/tab-tools/page-automation/tab-action-execution.ts');

  assert.match(tabExecutionSource, /import\s+\{\s*[\s\S]*runPageAutomationAction[\s\S]*\}\s+from\s+'\.\/injected-action-runtime';/);
  assert.match(tabExecutionSource, /ensurePageAutomationRuntimeInjected/);
  assert.equal(
    tabExecutionSource.includes('function runPageAutomationAction('),
    false,
    'tab-action-execution.ts should delegate runPageAutomationAction instead of re-defining it inline',
  );
});

test('page-automation delegates low-level tab execution wrappers to TabActionExecution', () => {
  const pageAutomationSource = read('src/sidepanel/tab-tools/page-automation.ts');
  const tabExecutionSource = read('src/sidepanel/tab-tools/page-automation/tab-action-execution.ts');

  assert.match(pageAutomationSource, /import\s+\{\s*[\s\S]*tabsListInteractiveElements[\s\S]*tabsHandleDialog[\s\S]*\}\s+from\s+'\.\/page-automation\/tab-action-execution';/);
  assert.match(pageAutomationSource, /export type \{ FormFillMode, FormFillField, FormFillFieldResult, InteractiveElementInfo \} from '\.\/page-automation\/tab-action-execution';/);

  for (const delegatedHelper of [
    'tabsListInteractiveElements',
    'tabsClick',
    'tabsHighlight',
    'tabsHover',
    'tabsType',
    'tabsFillForm',
    'tabsDrag',
    'tabsScroll',
    'tabsKey',
    'tabsUploadFile',
    'tabsHandleDialog',
  ]) {
    assert.equal(
      pageAutomationSource.includes(`export async function ${delegatedHelper}(`),
      false,
      `page-automation.ts should delegate ${delegatedHelper} instead of re-defining it inline`,
    );
  }

  assert.match(tabExecutionSource, /export async function tabsListInteractiveElements\(/);
  assert.match(tabExecutionSource, /export async function tabsClick\(/);
  assert.match(tabExecutionSource, /export async function tabsFillForm\(/);
  assert.match(tabExecutionSource, /export async function tabsHandleDialog\(/);
});
