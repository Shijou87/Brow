const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_OPENAI_FIELDS,
  DEFAULT_VLM_CONFIG,
  resolveVLMConfig,
} = require('../.tmp/system-prompt-guidance-test/config.js');

const repoRoot = process.cwd();
const legacyHostedProviderAliasPattern = new RegExp(`llm${'aas'}`, 'i');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('default VLM config is neutral and reuses the active text model', () => {
  assert.equal(DEFAULT_VLM_CONFIG.baseUrl, '');
  assert.equal(DEFAULT_VLM_CONFIG.apiKey, '');
  assert.equal(DEFAULT_VLM_CONFIG.model, '');
  assert.equal(DEFAULT_VLM_CONFIG.useTextModel, true);

  assert.deepEqual(
    resolveVLMConfig(DEFAULT_VLM_CONFIG, DEFAULT_OPENAI_FIELDS),
    {
      baseUrl: DEFAULT_OPENAI_FIELDS.baseUrl,
      apiKey: DEFAULT_OPENAI_FIELDS.apiKey,
      model: DEFAULT_OPENAI_FIELDS.model,
      useTextModel: true,
    },
  );
});

test('VLM config can resolve to a separate vision endpoint and model', () => {
  assert.deepEqual(
    resolveVLMConfig(
      {
        baseUrl: 'https://vision.example/v1',
        apiKey: 'vision-token',
        model: 'vision-model',
        useTextModel: false,
      },
      DEFAULT_OPENAI_FIELDS,
    ),
    {
      baseUrl: 'https://vision.example/v1',
      apiKey: 'vision-token',
      model: 'vision-model',
      useTextModel: false,
    },
  );

  assert.equal(
    resolveVLMConfig(
      {
        baseUrl: '',
        apiKey: '',
        model: '',
        useTextModel: false,
      },
      DEFAULT_OPENAI_FIELDS,
    ),
    null,
  );
});

test('source tree does not keep private VLM defaults or legacy hosted-provider naming', () => {
  assert.doesNotMatch(read('src/shared/config.ts'), /ge-healthcare\.net/i);
  assert.doesNotMatch(read('src/sidepanel/llm-config.ts'), legacyHostedProviderAliasPattern);
});

test('config UI exposes the VLM text-model toggle and resolves raw VLM settings before apply', () => {
  assert.match(read('src/sidepanel/templates/chat/config-panel.html'), /vlm-config-use-text-model/);

  const chatView = read('src/sidepanel/chat-view.ts');
  assert.match(chatView, /resolveVLMConfig\(rawVlmConfig, fields\)/);
  assert.match(chatView, /updateVLMConfigModeUI/);
});
