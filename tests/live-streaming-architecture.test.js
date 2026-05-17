const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('agent queries mixed LangGraph stream modes and delegates live assistant text through the stream callback', () => {
  const agentSource = read('src/sidepanel/agent.ts');

  assert.match(agentSource, /streamMode:\s*\['updates', 'messages'\]/);
  assert.match(agentSource, /decodeLangGraphStreamChunk\(rawChunk\)/);
  assert.match(agentSource, /if \(mode === 'messages'\)/);
  assert.match(agentSource, /extractAssistantMessageStreamText\(payload\)/);
  assert.match(agentSource, /streamedAssistantText \+= assistantTextDelta;/);
  assert.match(agentSource, /this\.emitStreamText\(streamedAssistantText\);/);
});

test('sidepanel controller renders live text immediately and keeps partial text on stop', () => {
  const controllerSource = read('src/sidepanel/sidepanel-controller.ts');

  assert.match(controllerSource, /import\s+\{\s*dismissBrowAutomationOverlays\s*\}\s+from\s+'\.\/tab-tools\/page-automation\/tab-action-execution';/);
  assert.match(controllerSource, /this\.agent\.onStreamText\(\(text: string\) => \{/);
  assert.match(controllerSource, /view\.hideTypingIndicator\(\);/);
  assert.match(controllerSource, /view\.streamAssistantMessage\(text\);/);
  assert.match(controllerSource, /if \(response === 'Agent turn was interrupted\.'\) \{/);
  assert.match(controllerSource, /view\.finalizeStreaming\(\);/);
  assert.match(controllerSource, /await dismissBrowAutomationOverlays\(\)\.catch\(/);
  assert.match(controllerSource, /view\.addSystemMessage\('Generation stopped\.'\);/);
  assert.doesNotMatch(controllerSource, /setTimeout\(\(\) => \{\s*view\.finalizeStreaming\(\);/);
});

test('chat transcript updates one live bubble instead of replaying words on a timer', () => {
  const chatViewSource = read('src/sidepanel/chat-view.ts');
  const transcriptModuleSource = read('src/sidepanel/chat-view/transcript-module.ts');

  assert.match(chatViewSource, /private streamingConversationMessageIndex: number \| null = null;/);
  assert.match(chatViewSource, /if \(this\.streamingConversationMessageIndex == null\) \{/);
  assert.match(chatViewSource, /this\.conversationMessages\[this\.streamingConversationMessageIndex\]\.content = message;/);
  assert.match(chatViewSource, /this\.streamingConversationMessageIndex = null;/);

  assert.match(transcriptModuleSource, /if \(this\.streamingElement\) \{/);
  assert.match(transcriptModuleSource, /textSpan\.innerHTML = this\.deps\.formatMessage\(message\);/);
  assert.doesNotMatch(transcriptModuleSource, /setInterval\(/);
  assert.doesNotMatch(transcriptModuleSource, /streamingWordQueue/);
});
