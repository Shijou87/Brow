const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('sidepanel entrypoint stays boot-only and delegates orchestration to SidepanelController', () => {
  const indexSource = read('src/sidepanel/index.ts');

  assert.match(indexSource, /import\s+\{\s*SidepanelController\s*\}\s+from\s+'\.\/sidepanel-controller';/);
  assert.match(indexSource, /const controller = new SidepanelController\(\);/);
  assert.match(indexSource, /const view = new ChatView\(app, controller\.callbacks\);/);
  assert.match(indexSource, /controller\.bindView\(view\);/);
  assert.match(indexSource, /void controller\.initialize\(\);/);

  for (const forbidden of [
    'getAgentApi(',
    'chrome.runtime.onMessage.addListener',
    'chrome.tabs.onActivated',
    'chrome.tabs.query({ active: true, currentWindow: true })',
    'workflowRecordingStart',
    'MCPAppHost',
  ]) {
    assert.equal(indexSource.includes(forbidden), false, `index.ts should not directly orchestrate ${forbidden}`);
  }
});

test('SidepanelController owns the sidepanel orchestration seam', () => {
  const controllerSource = read('src/sidepanel/sidepanel-controller.ts');

  assert.match(controllerSource, /export class SidepanelController/);
  assert.match(controllerSource, /public readonly callbacks: ChatViewCallbacks;/);
  assert.match(controllerSource, /public bindView\(view: ChatView\): void/);
  assert.match(controllerSource, /public async initialize\(\): Promise<void>/);
  assert.match(controllerSource, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(controllerSource, /chrome\.tabs\.onActivated\?\.addListener/);
  assert.match(controllerSource, /this\.agent\.onToolStep/);
  assert.match(controllerSource, /this\.agent\.onMCPAppRender/);
});

test('ChatView delegates the prompt surface to PromptPanelModule', () => {
  const chatViewSource = read('src/sidepanel/chat-view.ts');
  const promptModuleSource = read('src/sidepanel/chat-view/prompt-panel-module.ts');

  assert.match(chatViewSource, /import\s+\{\s*PromptPanelModule\s*\}\s+from\s+'\.\/chat-view\/prompt-panel-module';/);
  assert.match(chatViewSource, /private promptPanelModule!: PromptPanelModule;/);
  assert.match(chatViewSource, /this\.promptPanelModule = new PromptPanelModule\(this\.promptPanel,/);
  assert.match(chatViewSource, /void this\.promptPanelModule\.initialize\(\);/);
  assert.match(chatViewSource, /this\.promptPanelModule\.populateFields\(\);/);

  assert.match(promptModuleSource, /export class PromptPanelModule/);
  assert.match(promptModuleSource, /public async initialize\(\): Promise<void>/);
  assert.match(promptModuleSource, /public populateFields\(\): void/);
  assert.match(promptModuleSource, /public getAvailableSkillMentionOptions\(/);
});

test('ChatView delegates transcript and tool-step rendering to focused modules', () => {
  const chatViewSource = read('src/sidepanel/chat-view.ts');
  const transcriptModuleSource = read('src/sidepanel/chat-view/transcript-module.ts');
  const toolStepsModuleSource = read('src/sidepanel/chat-view/tool-steps-module.ts');

  assert.match(chatViewSource, /import\s+\{\s*TranscriptModule\s*\}\s+from\s+'\.\/chat-view\/transcript-module';/);
  assert.match(chatViewSource, /import\s+\{\s*ToolStepsModule\s*\}\s+from\s+'\.\/chat-view\/tool-steps-module';/);
  assert.match(chatViewSource, /private transcriptModule!: TranscriptModule;/);
  assert.match(chatViewSource, /private toolStepsModule!: ToolStepsModule;/);
  assert.match(chatViewSource, /this\.transcriptModule = new TranscriptModule\(this\.messagesContainer,/);
  assert.match(chatViewSource, /this\.toolStepsModule = new ToolStepsModule\(this\.messagesContainer,/);
  assert.match(chatViewSource, /this\.transcriptModule\.renderConversationMessage\(entry\);/);
  assert.match(chatViewSource, /this\.transcriptModule\.renderConversationMessage\(msg\);/);
  assert.match(chatViewSource, /this\.transcriptModule\.clear\(\);/);
  assert.match(chatViewSource, /this\.toolStepsModule\.clear\(\);/);
  assert.match(chatViewSource, /this\.transcriptModule\.showTypingIndicator\(\);/);
  assert.match(chatViewSource, /this\.transcriptModule\.hideTypingIndicator\(\);/);
  assert.match(chatViewSource, /this\.transcriptModule\.streamAssistantMessage\(message\);/);
  assert.match(chatViewSource, /this\.transcriptModule\.finalizeStreaming\(\);/);
  assert.match(chatViewSource, /this\.toolStepsModule\.update\(steps\);/);
  assert.match(chatViewSource, /this\.toolStepsModule\.finalize\(\);/);

  assert.match(transcriptModuleSource, /export class TranscriptModule/);
  assert.match(transcriptModuleSource, /public clear\(\): void/);
  assert.match(transcriptModuleSource, /public renderConversationMessage\(/);
  assert.match(transcriptModuleSource, /public showTypingIndicator\(\): void/);
  assert.match(transcriptModuleSource, /public hideTypingIndicator\(\): void/);
  assert.match(transcriptModuleSource, /public streamAssistantMessage\(message: string\): void/);
  assert.match(transcriptModuleSource, /public finalizeStreaming\(\): void/);

  assert.match(toolStepsModuleSource, /export class ToolStepsModule/);
  assert.match(toolStepsModuleSource, /public clear\(\): void/);
  assert.match(toolStepsModuleSource, /public update\(steps: ToolStepEvent\[\]\): void/);
  assert.match(toolStepsModuleSource, /public finalize\(\): void/);
});

test('ChatView delegates composer and MCP app surfaces to focused modules', () => {
  const chatViewSource = read('src/sidepanel/chat-view.ts');
  const composerModuleSource = read('src/sidepanel/chat-view/composer-module.ts');
  const mcpAppViewModuleSource = read('src/sidepanel/chat-view/mcp-app-view-module.ts');

  assert.match(chatViewSource, /import\s+\{\s*ComposerModule\s*\}\s+from\s+'\.\/chat-view\/composer-module';/);
  assert.match(chatViewSource, /import\s+\{\s*MCPAppViewModule\s*\}\s+from\s+'\.\/chat-view\/mcp-app-view-module';/);
  assert.match(chatViewSource, /private composerModule!: ComposerModule;/);
  assert.match(chatViewSource, /private mcpAppViewModule!: MCPAppViewModule;/);
  assert.match(chatViewSource, /this\.composerModule = new ComposerModule\(/);
  assert.match(chatViewSource, /this\.mcpAppViewModule = new MCPAppViewModule\(/);
  assert.match(chatViewSource, /this\.composerModule\.initialize\(\);/);
  assert.match(chatViewSource, /return this\.composerModule\.getComposerSubmissionText\(\);/);
  assert.match(chatViewSource, /return this\.mcpAppViewModule\.renderLoading\(request\);/);
  assert.match(chatViewSource, /this\.mcpAppViewModule\.renderApproval\(container, request, resource, callbacks\);/);

  assert.match(composerModuleSource, /export class ComposerModule/);
  assert.match(composerModuleSource, /public initialize\(\): void/);
  assert.match(composerModuleSource, /public setCurrentContextTab\(tab: ContextTabOption \| null\): void/);
  assert.match(composerModuleSource, /public getSelectedContextTabIds\(\): number\[\]/);
  assert.match(composerModuleSource, /public createWorkflowDemonstrationMessageCard\(/);

  assert.match(mcpAppViewModuleSource, /export class MCPAppViewModule/);
  assert.match(mcpAppViewModuleSource, /public renderLoading\(request: MCPAppRenderRequest\): HTMLElement/);
  assert.match(mcpAppViewModuleSource, /public renderApproval\(/);
  assert.match(mcpAppViewModuleSource, /public renderFrame\(/);
});
