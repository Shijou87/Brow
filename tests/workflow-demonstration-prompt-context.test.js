const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildWorkflowDemonstrationContext,
} = require('../.tmp-workflow-demo-context-test/shared/workflow-demonstration/context-format.js');
const {
  buildSystemPrompt,
} = require('../.tmp-workflow-demo-context-test/sidepanel/agent-runtime/prompt.js');

function createWorkflowDemonstration() {
  return {
    id: 'demo1',
    title: 'Search ChatGPT history',
    demonstratedTab: { tabId: 1, title: 'ChatGPT', url: 'https://chatgpt.com/' },
    steps: [
      {
        kind: 'click',
        replayability: 'replayable',
        title: 'Click "Search chats" button',
        tab: { tabId: 1, title: 'ChatGPT', url: 'https://chatgpt.com/' },
        target: {
          selector: 'button[aria-label="Search chats"]',
          signature: {
            role: 'button',
            name: 'Search chats',
            text: 'Search chats',
            tagName: 'button',
          },
        },
      },
      {
        kind: 'type',
        replayability: 'replayable',
        title: 'Type into search',
        tab: { tabId: 1, title: 'ChatGPT', url: 'https://chatgpt.com/' },
        target: {
          selector: 'input[placeholder="Rechercher des chats..."]',
          signature: {
            role: 'textbox',
            name: 'Rechercher des chats...',
            tagName: 'input',
            type: 'text',
            attributes: { placeholder: 'Rechercher des chats...' },
          },
        },
        value: { captureMode: 'literal', text: 'hello' },
      },
    ],
  };
}

test('workflow demonstration context frames recorded steps as attachment context, not an unconditional replay command', () => {
  const text = buildWorkflowDemonstrationContext([createWorkflowDemonstration()]);

  assert.match(text, /The user explicitly recorded (this|these) workflow demonstration/i);
  assert.match(text, /Use (it|them) to understand what the user did, answer questions, or adapt the workflow when the current request calls for action/i);
  assert.match(text, /Do not replay or follow the demonstrated steps unless the current user request calls for it/i);
  assert.match(text, /RECORDED WORKFLOW SUMMARY/i);
  assert.doesNotMatch(text, /EXECUTION PLAN \(follow exactly in order, use same interaction pattern as demo\)/i);
  assert.doesNotMatch(text, /follow the demo steps in order/i);
});

test('compiled system prompt makes workflow demonstration replay conditional on the current request', () => {
  const prompt = buildSystemPrompt({
    basePrompt: 'base',
    domainSkillRegistry: [],
    interactionSkillRegistry: [],
    disabledTools: new Set(),
    webmcpByTab: new Map(),
    mcpServers: [],
  });

  assert.match(prompt, /Workflow Demonstrations are user-recorded context showing how a task was done on a site/i);
  assert.match(prompt, /Only replay or adapt the demonstrated steps when the current user request is asking you to perform the task or explicitly asks you to use the demonstration/i);
  assert.doesNotMatch(prompt, /Workflow Demonstrations are TEMPLATES showing how to accomplish a task on a site\. Follow the same navigation steps and UI targets/i);
});

test('agent request assembly source does not inject an unconditional workflow replay preamble into the user turn', () => {
  const agentSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidepanel', 'agent.ts'), 'utf8');

  assert.doesNotMatch(agentSource, /\[IMPORTANT: Follow the attached Workflow Demonstration EXECUTION PLAN step by step\./);
  assert.doesNotMatch(agentSource, /Use the SAME interaction pattern as the demo/);
});