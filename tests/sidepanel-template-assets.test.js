const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const templateExpectations = [
  {
    file: 'src/sidepanel/templates/chat/header.html',
    slots: ['brand-icon', 'webmcp-indicator', 'connection-status'],
    actions: ['new-chat', 'refresh-webmcp'],
  },
  {
    file: 'src/sidepanel/templates/chat/composer.html',
    slots: [
      'context-tabs',
      'workflow-demonstrations-dock',
      'context-add-button',
      'record-button',
      'context-picker',
      'composer-main-row',
      'skill-mention-composer-slot',
      'message-input',
      'send-button',
      'request-budget-indicator',
      'request-budget-value',
      'request-budget-ring-fill',
    ],
    actions: ['context-add', 'copy-context'],
  },
  {
    file: 'src/sidepanel/templates/chat/tools-panel.html',
    slots: ['tools-groups-container'],
    actions: [],
  },
  {
    file: 'src/sidepanel/templates/chat/mcp-panel.html',
    slots: ['mcp-servers-list'],
    actions: ['connect-server'],
  },
  {
    file: 'src/sidepanel/templates/chat/conversations-panel.html',
    slots: ['conversations-list-container'],
    actions: ['new-conversation'],
  },
  {
    file: 'src/sidepanel/templates/chat/config-panel.html',
    slots: ['openai-provider-icon', 'claude-provider-icon'],
    actions: ['refresh-models', 'apply-config'],
  },
  {
    file: 'src/sidepanel/templates/chat/prompt-panel.html',
    slots: [],
    actions: ['new-skill', 'import-skill-url', 'save-skill', 'cancel-skill', 'apply-prompt'],
  },
];

test('chat template assets expose stable slots and actions without interpolation placeholders', () => {
  for (const expectation of templateExpectations) {
    const html = read(expectation.file);
    assert.ok(html.length > 0, `${expectation.file} should not be empty`);
    assert.equal(html.includes('${'), false, `${expectation.file} should not contain runtime interpolation placeholders`);

    for (const slot of expectation.slots) {
      assert.match(html, new RegExp(`data-slot="${slot}"`), `${expectation.file} should expose slot ${slot}`);
    }

    for (const action of expectation.actions) {
      assert.match(html, new RegExp(`data-action="${action}"`), `${expectation.file} should expose action ${action}`);
    }
  }
});

test('bottom nav template keeps all sidepanel surfaces addressable from markup', () => {
  const html = read('src/sidepanel/templates/chat/bottom-nav.html');
  for (const surface of ['tools', 'mcp', 'chat', 'conversations', 'prompt', 'config']) {
    assert.match(html, new RegExp(`data-surface="${surface}"`), `bottom nav should include ${surface} surface button`);
  }
});
