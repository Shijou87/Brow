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

test('page-automation runtime exposes a final Brow overlay dismiss hook', () => {
  const actionRuntimeSource = read('src/sidepanel/tab-tools/page-automation/runtime/action-runtime.ts');
  const interactionRuntimeSource = read('src/sidepanel/tab-tools/page-automation/runtime/interaction-runtime.ts');
  const runtimeInstallSource = read('src/sidepanel/tab-tools/page-automation/runtime/runtime-install.ts');
  const tabExecutionSource = read('src/sidepanel/tab-tools/page-automation/tab-action-execution.ts');

  assert.match(actionRuntimeSource, /const dismissPageAutomationOverlay = \(delay\?: number\) =>/);
  assert.match(interactionRuntimeSource, /const dismissOverlay = \(delay = 0\) =>/);
  assert.match(runtimeInstallSource, /dismissPageAutomationOverlay/);
  assert.match(tabExecutionSource, /export async function dismissBrowAutomationOverlays/);
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

test('tab-action-execution hydrates Animated Brow visual settings from sidepanel runtime config before dispatch', () => {
  const tabExecutionSource = read('src/sidepanel/tab-tools/page-automation/tab-action-execution.ts');
  const runtimeTypesSource = read('src/sidepanel/tab-tools/page-automation/runtime/types.ts');
  const injectedRuntimeSource = read('src/sidepanel/tab-tools/page-automation/injected-action-runtime.ts');

  assert.match(runtimeTypesSource, /export interface PageAutomationVisualSettings/);
  assert.match(runtimeTypesSource, /animatedBrow: boolean/);
  assert.match(injectedRuntimeSource, /PageAutomationVisualSettings/);

  assert.match(tabExecutionSource, /loadSidepanelConfig/);
  assert.match(tabExecutionSource, /async function loadPageAutomationVisualSettings\(\)/);
  assert.match(tabExecutionSource, /animatedBrow: config\.runtime\.animatedBrow === true/);

  for (const actionKind of ['click', 'highlight', 'type', 'fillForm']) {
    assert.match(
      tabExecutionSource,
      new RegExp(`kind: '${actionKind}'[\\s\\S]*visualSettings`),
      `tab-action-execution.ts should pass visualSettings for ${actionKind} actions`,
    );
  }
});

test('page-automation runtime exposes Brow spritesheet assets and shared character constants', () => {
  const baseRuntimeSource = read('src/sidepanel/tab-tools/page-automation/runtime/base-runtime.ts');
  const interactionRuntimeSource = read('src/sidepanel/tab-tools/page-automation/runtime/interaction-runtime.ts');
  const manifestSource = read('manifest.json');

  assert.match(baseRuntimeSource, /chrome\.runtime\.getURL\('icons\/brow-spritesheet\.png'\)/);
  assert.match(baseRuntimeSource, /BROW_CHARACTER_COLUMNS = 12/);
  assert.match(baseRuntimeSource, /BROW_CHARACTER_ROWS = 6/);
  assert.match(baseRuntimeSource, /BROW_CHARACTER_POINT_ROW = 3/);
  assert.match(baseRuntimeSource, /BROW_CHARACTER_WALK_DOWN_ROW = 4/);
  assert.match(baseRuntimeSource, /BROW_CHARACTER_WALK_UP_ROW = 5/);
  assert.match(interactionRuntimeSource, /cursor\.style\.backgroundImage = `url\("\$\{base\.BROW_CHARACTER_SPRITESHEET_URL\}"\)`/);
  assert.match(interactionRuntimeSource, /cursor\.style\.backgroundImage = `url\("\$\{base\.CURSOR_SPRITESHEET_URL\}"\)`/);
  assert.match(manifestSource, /icons\/brow-spritesheet\.png/);
});

test('action-runtime forwards visual settings into animated preview helpers while hover stays on the legacy path', () => {
  const actionRuntimeSource = read('src/sidepanel/tab-tools/page-automation/runtime/action-runtime.ts');
  const interactionRuntimeSource = read('src/sidepanel/tab-tools/page-automation/runtime/interaction-runtime.ts');

  assert.match(actionRuntimeSource, /previewHighlight\([\s\S]*action\.visualSettings/);
  assert.match(actionRuntimeSource, /previewClick\([\s\S]*action\.visualSettings/);
  assert.match(actionRuntimeSource, /previewFieldEdit\([\s\S]*action\.visualSettings/);
  assert.match(interactionRuntimeSource, /isAnimatedBrowEnabled/);
  assert.match(interactionRuntimeSource, /startBrowIdle/);
  assert.match(interactionRuntimeSource, /startBrowPointing/);
  assert.match(interactionRuntimeSource, /animateBrowJump/);
  assert.match(actionRuntimeSource, /previewHover\(el, message\)/);
});

test('animated highlight renders the overlay label as a Brow speech bubble that follows the sprite', () => {
  const interactionRuntimeSource = read('src/sidepanel/tab-tools/page-automation/runtime/interaction-runtime.ts');

  assert.match(interactionRuntimeSource, /brow-automation-badge\[data-variant="speech"\]/);
  assert.match(interactionRuntimeSource, /badge\.dataset\.speaker = 'brow'/);
  assert.match(interactionRuntimeSource, /function|const\s+positionSpeechBubbleForBrow/);
  assert.match(interactionRuntimeSource, /const characterCenterX = characterLeft \+ base\.BROW_CHARACTER_DISPLAY_WIDTH \/ 2/);
  assert.match(interactionRuntimeSource, /const preferredLeft = characterCenterX - badgeWidth \/ 2/);
  assert.match(interactionRuntimeSource, /characterTop \+ base\.BROW_CHARACTER_DISPLAY_HEIGHT \+ 12/);
  assert.match(interactionRuntimeSource, /showBadgeFollowingBrow\(message, currentState\)/);
  assert.match(interactionRuntimeSource, /startBrowIdle\(currentState\)/);
});

test('animated Brow keeps a vertically flipped ground shadow, including during jumps', () => {
  const interactionRuntimeSource = read('src/sidepanel/tab-tools/page-automation/runtime/interaction-runtime.ts');

  assert.match(interactionRuntimeSource, /brow-automation-brow-shadow/);
  assert.match(interactionRuntimeSource, /root\.appendChild\(shadow\)/);
  assert.match(interactionRuntimeSource, /shadow\.classList\.add\('visible'\)/);
  assert.match(interactionRuntimeSource, /const shadowYOffset = Math\.round\(base\.BROW_CHARACTER_DISPLAY_HEIGHT \/ 3\)/);
  assert.match(interactionRuntimeSource, /shadowGroundY:\s*start\.y/);
  assert.match(interactionRuntimeSource, /scaleY\(-\$\{shadowScaleY\}\) skewX\(/);
  assert.equal(
    /if \(row !== base\.BROW_CHARACTER_JUMP_ROW\)/.test(interactionRuntimeSource),
    false,
    'jump shadow rendering should no longer be gated by row !== jump row',
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
