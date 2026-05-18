const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ComposerModule,
} = require('../.tmp/composer-module-test/sidepanel/chat-view/composer-module.js');

function createClassList() {
  return {
    add() {},
    remove() {},
    toggle() {},
  };
}

function createButton() {
  return {
    disabled: false,
    innerHTML: '',
    title: '',
    classList: createClassList(),
    addEventListener() {},
    setAttribute() {},
  };
}

function createComposerModule() {
  const messageInput = {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    disabled: false,
    scrollHeight: 24,
    style: { height: '24px' },
    addEventListener() {},
    focus() {},
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };

  const module = new ComposerModule({
    container: {
      querySelector() { return null; },
      appendChild() {},
    },
    inputContainer: {
      contains() { return true; },
    },
    messageInput,
    recordButton: createButton(),
    sendButton: createButton(),
    contextTabsContainer: {
      innerHTML: '',
      scrollLeft: 0,
      scrollWidth: 0,
      querySelectorAll() { return []; },
      appendChild() {},
    },
    contextAddButton: createButton(),
    contextPicker: {
      innerHTML: '',
      classList: createClassList(),
      querySelectorAll() { return []; },
    },
    skillMentionComposerSlot: {
      innerHTML: '',
      classList: createClassList(),
      appendChild() {},
    },
    workflowDemonstrationsDock: {
      innerHTML: '',
      classList: createClassList(),
      appendChild() {},
    },
  }, {
    onSendMessage() {},
    onStopGeneration() {},
    async onWorkflowRecordingStart() {
      return { ok: true, active: true, stepCount: 0, page: { url: '', title: '' } };
    },
    async onWorkflowRecordingStop() {
      return { ok: true, active: false };
    },
    getAvailableSkillMentionOptions() {
      return [];
    },
    onDraftChange() {},
    onSystemMessage() {},
    isWorkflowDemonstrationReferenced() {
      return false;
    },
    escapeHtml(text) {
      return text;
    },
  });

  module.isInputEnabled = true;
  module.refreshContextPicker = async () => {};
  return { module, messageInput };
}

test('slash skill picker keeps the current highlight when the query is unchanged', () => {
  const { module, messageInput } = createComposerModule();

  messageInput.value = '/diagnose';
  messageInput.selectionStart = messageInput.value.length;
  messageInput.selectionEnd = messageInput.value.length;

  module.contextPickerMode = 'skill';
  module.contextPickerQuery = 'diagnose';
  module.contextPickerHighlightIndex = 2;

  const matched = module.syncSkillPickerFromInput();

  assert.equal(matched, true);
  assert.equal(module.contextPickerHighlightIndex, 2);
});

test('slash skill picker resets the highlight when the query changes', () => {
  const { module, messageInput } = createComposerModule();

  messageInput.value = '/diag';
  messageInput.selectionStart = messageInput.value.length;
  messageInput.selectionEnd = messageInput.value.length;

  module.contextPickerMode = 'skill';
  module.contextPickerQuery = 'diagnose';
  module.contextPickerHighlightIndex = 2;

  const matched = module.syncSkillPickerFromInput();

  assert.equal(matched, true);
  assert.equal(module.contextPickerHighlightIndex, 0);
});

test('@ mention picker keeps the current highlight when the query is unchanged', () => {
  const { module, messageInput } = createComposerModule();

  messageInput.value = '@chat';
  messageInput.selectionStart = messageInput.value.length;
  messageInput.selectionEnd = messageInput.value.length;

  module.contextPickerMode = 'mention';
  module.contextPickerQuery = 'chat';
  module.contextPickerHighlightIndex = 1;

  module.syncMentionPickerFromInput();

  assert.equal(module.contextPickerHighlightIndex, 1);
});
