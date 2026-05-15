const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatRequestContextDebugText,
} = require('../.tmp-request-context-debug-test/request-context-debug.js');

test('renders the exact prompt surface and live updates together', () => {
  const text = formatRequestContextDebugText({
    query: 'please open a random metallica sound in youtube',
    estimatedTokens: 6000,
    contextWindow: 128000,
    rawHistory: [],
    exactPromptMessages: [
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'system', content: 'Browser context snapshot: ...' },
      { role: 'user', content: 'please open a random metallica sound in youtube' },
    ],
    requestShape: {
      rawHistoryMessageCount: 0,
      rawHistoryChars: 0,
      exactPromptMessageCount: 3,
      exactPromptChars: 92,
      systemPromptChars: 13,
      browserContextChars: 27,
      browserContextFrameChars: 6,
      browserContextOpenTabsChars: 7,
      browserContextActiveTabChars: 5,
      browserContextAttachedSnapshotsChars: 9,
      workflowDemonstrationChars: 0,
      matchedDomainSkillsChars: 0,
      matchedDomainMemoryChars: 0,
      selectedSkillMentionChars: 0,
      carriedForwardToolSummaryChars: 0,
      selectedContextTabCount: 1,
      attachedContextTabCount: 1,
      attachedSnapshotCount: 1,
    },
    timings: {
      compactionMs: 4,
      requestAssemblyMs: 12,
      firstAgentUpdateMs: 180,
      firstToolCallMs: 220,
      agentStreamMs: 980,
      toolCount: 1,
      totalToolDurationMs: 350,
      toolWallTimeMs: 350,
      postToolFollowUpMs: 410,
      turnTotalMs: 1030,
    },
    liveUpdates: [
      { label: '[LIVE 1] ASSISTANT', content: 'tool_calls:\n[{"name":"browser_snapshot"}]' },
      { label: '[LIVE 2] TOOL', content: 'Tool: browser_snapshot\n{"ok":true}' },
    ],
  });

  assert.match(text, /Messages: 3/);
  assert.match(text, /Exact prompt surface passed to the agent:/);
  assert.match(text, /Request shape:/);
  assert.match(text, /Browser context chars: 27/);
  assert.match(text, /Browser context frame chars: 6 \(22%\)/);
  assert.match(text, /Open tabs section chars: 7 \(26%\)/);
  assert.match(text, /Active tab section chars: 5 \(19%\)/);
  assert.match(text, /Attached snapshot section chars: 9 \(33%\)/);
  assert.match(text, /Attached snapshots: 1/);
  assert.match(text, /Timing breakdown:/);
  assert.match(text, /Conversation compaction: 4 ms/);
  assert.match(text, /Tool count: 1/);
  assert.match(text, /\[0\] SYSTEM/);
  assert.match(text, /Live turn updates captured so far:/);
  assert.match(text, /\[LIVE 2\] TOOL/);
});

test('marks empty carried history explicitly', () => {
  const text = formatRequestContextDebugText({
    query: 'hi',
    estimatedTokens: 10,
    contextWindow: 1000,
    rawHistory: [],
    exactPromptMessages: [
      { role: 'system', content: 'SYSTEM PROMPT' },
    ],
  });

  assert.match(text, /Raw carried history:\n\n\(empty\)/);
});
