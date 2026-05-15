const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeLangGraphStreamChunk,
  extractAssistantMessageStreamText,
  extractLlmText,
} = require('../.tmp-live-stream-test/live-stream.js');

test('decodeLangGraphStreamChunk keeps legacy single-mode chunks compatible', () => {
  const payload = { agent: { messages: [] } };

  assert.deepEqual(decodeLangGraphStreamChunk(payload), {
    mode: 'updates',
    payload,
  });
});

test('decodeLangGraphStreamChunk reads mixed-mode LangGraph tuples', () => {
  const payload = [{ content: 'hello' }, { langgraph_node: 'agent' }];

  assert.deepEqual(decodeLangGraphStreamChunk(['messages', payload]), {
    mode: 'messages',
    payload,
  });
});

test('extractAssistantMessageStreamText keeps assistant text and ignores tool chatter', () => {
  assert.equal(
    extractAssistantMessageStreamText([
      {
        content: [
          { text: 'Bonjour' },
          { text: ' ' },
          { text: 'monde' },
        ],
      },
      { langgraph_node: 'agent' },
    ]),
    'Bonjour monde',
  );

  assert.equal(
    extractAssistantMessageStreamText([
      { content: 'tool output that should stay out of chat' },
      { langgraph_node: 'tools' },
    ]),
    '',
  );

  assert.equal(
    extractAssistantMessageStreamText([
      { tool_call_id: 'call_123', content: 'tool result' },
      { langgraph_node: 'agent' },
    ]),
    '',
  );
});

test('extractLlmText normalizes common string and block payloads', () => {
  assert.equal(extractLlmText('plain text'), 'plain text');
  assert.equal(
    extractLlmText([{ text: 'one' }, { text: '\n' }, { text: 'two' }]),
    'one\ntwo',
  );
  assert.equal(
    extractLlmText({ content: [{ text: 'nested' }, { text: ' value' }] }),
    'nested value',
  );
});
