const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('shared conversation types persist HTML App Artifacts and message references', () => {
  const sharedTypes = read('src/shared/types.ts');
  const chatViewTypes = read('src/sidepanel/chat-view/types.ts');
  const conversationStore = read('src/sidepanel/chat-view/conversation-store.ts');
  const storage = read('src/shared/storage.ts');

  assert.match(sharedTypes, /export type HtmlAppRenderTarget = 'inline' \| 'tab' \| 'both';/);
  assert.match(sharedTypes, /export interface HtmlAppArtifactMessageRef/);
  assert.match(sharedTypes, /export interface HtmlAppArtifactRevision/);
  assert.match(sharedTypes, /export interface HtmlAppArtifact/);
  assert.match(sharedTypes, /export interface HtmlAppRenderRequest/);
  assert.match(sharedTypes, /export interface HtmlAppExecutionPreferences/);

  assert.match(chatViewTypes, /htmlAppArtifactRefs\?: HtmlAppArtifactMessageRef\[\];/);
  assert.match(chatViewTypes, /htmlAppArtifacts: HtmlAppArtifact\[\];/);

  assert.match(conversationStore, /function normalizeHtmlAppArtifactMessageRefs/);
  assert.match(conversationStore, /function normalizeHtmlAppArtifacts/);
  assert.match(conversationStore, /htmlAppArtifacts: normalizeHtmlAppArtifacts\(raw\.htmlAppArtifacts\)/);
  assert.match(storage, /HTML_APP_EXECUTION_PREFERENCES_STORAGE_KEY/);
  assert.match(storage, /loadHtmlAppExecutionPreferences/);
  assert.match(storage, /saveHtmlAppExecutionPreferences/);
});

test('HTML App Artifact feature is wired through the built-in tool, sidepanel controller, and dedicated tab host', () => {
  const builtinTools = read('src/sidepanel/agent-tools/builtin-tools.ts');
  const controller = read('src/sidepanel/sidepanel-controller.ts');
  const chatView = read('src/sidepanel/chat-view.ts');
  const shell = read('src/sidepanel/chat-view/shell.ts');
  const htmlAppViewModule = read('src/sidepanel/chat-view/html-app-view-module.ts');
  const dedicatedTab = read('src/html-app-view/index.ts');
  const transcript = read('src/sidepanel/chat-view/transcript-module.ts');
  const sandboxedHost = read('src/sidepanel/sandboxed-html-host.ts');
  const sandboxedHtml = read('src/sidepanel/sandboxed-html.ts');
  const sandboxPage = read('src/sidepanel/mcp-app-sandbox.ts');
  const guidance = read('src/shared/html-app-artifact-guidance.ts');
  const configPanelTemplate = read('src/sidepanel/templates/chat/config-panel.html');
  const webpackConfig = read('webpack.config.js');

  assert.match(builtinTools, /name: 'html_artifact_upsert'/);
  assert.match(builtinTools, /HTML App Artifact saved\. Brow will wait for user approval before executing the generated HTML/);
  assert.match(builtinTools, /renderTargetHint: z\.enum\(\['inline', 'tab', 'both'\]\)/);
  assert.match(builtinTools, /BROW_HTML_APP_THEME_SHORT_GUIDANCE/);
  assert.match(builtinTools, /decorative heading/);
  assert.match(guidance, /square-first/);
  assert.match(guidance, /charcoal \+ neon-purple theme/);

  assert.match(controller, /private readonly htmlAppHost = new SandboxedHtmlHost\(\);/);
  assert.match(controller, /private htmlAppExecutionPreferences: HtmlAppExecutionPreferences/);
  assert.match(controller, /maybePersistAlwaysAllowHtmlApps/);
  assert.match(controller, /alwaysAllowExecution: true/);
  assert.match(controller, /onHtmlAppArtifactOpen:/);
  assert.match(controller, /onHtmlAppArtifactDownload:/);
  assert.match(controller, /onHtmlAppExecutionPreferenceChange:/);
  assert.match(controller, /html-app-view\.html/);
  assert.match(controller, /renderHtmlAppArtifactApproval/);
  assert.match(controller, /mountHtmlAppArtifactInline\(container, request\)/);
  assert.match(chatView, /onHtmlAppExecutionPreferenceChange: \(enabled: boolean\) => void;/);
  assert.match(chatView, /loadHtmlAppExecutionPreferences/);
  assert.match(htmlAppViewModule, /always-allow/);
  assert.match(htmlAppViewModule, /Always allow future HTML apps on this device/);
  assert.match(configPanelTemplate, /html-app-auto-approve/);
  assert.match(configPanelTemplate, /Always Allow HTML Apps/);
  assert.match(configPanelTemplate, /animated-brow/);
  assert.match(configPanelTemplate, /Animated Brow/);
  assert.match(configPanelTemplate, /config-brow-idle-preview/);
  assert.match(shell, /--brow-spritesheet-url/);
  assert.match(shell, /icons\/brow-spritesheet\.png/);

  assert.match(dedicatedTab, /loadSavedConversations/);
  assert.match(dedicatedTab, /createLockedDownHtmlResource/);
  assert.match(dedicatedTab, /mcp-app-sandbox\.html/);
  assert.match(transcript, /message-html-app-artifacts/);
  assert.match(sandboxedHtml, /BROW_SANDBOX_RESOURCE_LOADED_EVENT/);
  assert.match(sandboxedHtml, /export type SandboxedHtmlKeyboardPolicy = 'default' \| 'capture-game-keys';/);
  assert.match(sandboxedHtml, /keyboardPolicy: 'capture-game-keys'/);
  assert.match(sandboxedHost, /isSandboxResourceLoadedMessage/);
  assert.match(sandboxedHost, /iframe\.addEventListener\('pointerdown', handlePointerFocus\)/);
  assert.match(sandboxedHost, /iframe\.tabIndex = 0/);
  assert.match(sandboxPage, /BROW_SANDBOX_RESOURCE_LOADED_EVENT/);
  assert.match(sandboxPage, /awaitingInnerResourceLoad/);
  assert.match(sandboxPage, /focusInnerResource/);
  assert.match(sandboxPage, /shouldCaptureGameplayKey/);
  assert.match(sandboxPage, /dispatchGameplayKeyToInner/);
  assert.match(sandboxPage, /installInnerKeyboardGuards/);

  assert.match(webpackConfig, /'html-app-view': '\.\/src\/html-app-view\/index\.ts'/);
  assert.match(webpackConfig, /\{ from: 'html-app-view\.html', to: '\.' \}/);
});

test('Brow ships a built-in HTML App theme skill and guidance for artifact generation', () => {
  const guidance = read('src/shared/html-app-artifact-guidance.ts');
  const interactionSkills = read('src/sidepanel/interaction-skills.ts');
  const config = read('src/shared/config.ts');
  const prompt = read('src/sidepanel/agent-runtime/prompt.ts');

  assert.match(guidance, /BROW_HTML_APP_THEME_SKILL_NAME = 'Brow HTML App Theme'/);
  assert.match(guidance, /approximately 1:1 viewport/);
  assert.match(guidance, /Do not add a decorative page title, hero heading/);
  assert.match(guidance, /neon purple accents/);
  assert.match(guidance, /icons\/brow-spritesheet\.png/);
  assert.match(guidance, /background-image: url\("icons\/brow-spritesheet\.png"\)/);
  assert.match(guidance, /12 columns by 6 rows/);
  assert.match(guidance, /CSS sprite animation/);
  assert.match(guidance, /Each source cell inside the PNG is 256x256 pixels/);
  assert.match(guidance, /Separate source size from display size/);
  assert.match(guidance, /--brow-display-size: 96px/);
  assert.match(guidance, /The 256x256 source cell is not copied into CSS as "256px"/);
  assert.match(guidance, /Treat row 1 as an action row, not a generic loop/);
  assert.match(guidance, /takeoff and upward motion/);
  assert.match(guidance, /canvas-based game/);
  assert.match(guidance, /ctx\.drawImage/);
  assert.match(guidance, /placeholder rectangles/);
  assert.match(guidance, /source rectangle values sx, sy, sw, and sh should use the 256x256 source cells/);
  assert.match(guidance, /Jump and landing example for a platformer/);
  assert.match(guidance, /function getBrowPose/);
  assert.match(guidance, /player\.landingTimer/);
  assert.match(guidance, /short landing recovery/);

  assert.match(interactionSkills, /BROW_HTML_APP_THEME_SKILL_ID/);
  assert.match(interactionSkills, /tags: \['interaction', 'html-app', 'artifacts', 'theme'\]/);

  assert.match(config, /BROW_HTML_APP_PROMPT_GUIDANCE/);
  assert.match(prompt, /BROW_HTML_APP_PROMPT_GUIDANCE/);
  assert.match(config, /animatedBrow: boolean/);

  const storage = read('src/shared/storage.ts');
  assert.match(storage, /runtimeRecord\.animatedBrow/);
  assert.match(storage, /animatedBrow: config\.runtime\.animatedBrow === true/);
});

test('Brow ships a built-in current-tab app adaptation skill', () => {
  const interactionSkills = read('src/sidepanel/interaction-skills.ts');

  assert.match(interactionSkills, /id: 'interaction-current-tab-app-adaptation'/);
  assert.match(interactionSkills, /name: 'Current Tab App Adaptation'/);
  assert.match(interactionSkills, /tags: \['interaction', 'current-tab', 'app', 'adaptation'\]/);
  assert.match(interactionSkills, /Use tabs_getActive to make the current tab explicit/);
  assert.match(interactionSkills, /Use tabs_getContent with format="html" to recover the page's HTML\/source skeleton/);
  assert.match(interactionSkills, /Use browser_snapshot to recover the visible structure, interactive regions, labels, and layout semantics/);
  assert.match(interactionSkills, /use http_fetch on those resource URLs to inspect the linked source/);
  assert.match(interactionSkills, /recovering the current tab's HTML\/CSS\/JS or component structure first, then adapt it to the new request/);
  assert.match(interactionSkills, /Prefer reusing recovered CSS and TypeScript patterns, component structure, tokens, and layout logic/);
  assert.match(interactionSkills, /link back to the recovered resource URLs or cite them as reference material/);
  assert.match(interactionSkills, /Do not copy proprietary third-party code, branding, or assets verbatim without permission/);
});

test('domain docs distinguish HTML App Artifacts from server-supplied MCP Apps', () => {
  const context = read('CONTEXT.md');
  const adr = read('docs/adr/0012-html-app-artifact-host-reuse.md');

  assert.match(context, /\*\*HTML App Artifact\*\*:/);
  assert.match(context, /\*\*HTML App Revision\*\*:/);
  assert.match(context, /\*\*HTML App View\*\*:/);
  assert.match(context, /\*\*HTML App Artifact\*\* means Brow-authored saved HTML, while \*\*MCP App\*\* remains server-supplied UI/);

  assert.match(adr, /Reuse Brow's Sandboxed HTML Host For HTML App Artifacts/);
  assert.match(adr, /\*\*HTML App Artifact\*\* is the saved Brow-authored HTML document/);
  assert.match(adr, /Brow does not open raw `data:` tabs/);
});
