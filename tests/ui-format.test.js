const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatRelativeTime,
  formatSchemaType,
  renderToolInputParameters,
} = require('../.tmp/ui-format-test/sidepanel/chat-view/ui-format.js');

test('formatRelativeTime uses friendly recent buckets', () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-05-15T12:00:00.000Z');

  try {
    assert.equal(formatRelativeTime(new Date('2026-05-15T11:59:45.000Z')), 'just now');
    assert.equal(formatRelativeTime(new Date('2026-05-15T11:15:00.000Z')), '45m ago');
    assert.equal(formatRelativeTime(new Date('2026-05-15T09:00:00.000Z')), '3h ago');
    assert.equal(formatRelativeTime(new Date('2026-05-13T12:00:00.000Z')), '2d ago');
  } finally {
    Date.now = originalNow;
  }
});

test('formatSchemaType and renderToolInputParameters preserve required details and escape HTML', () => {
  const schema = {
    type: 'object',
    required: ['status'],
    properties: {
      status: {
        type: 'string',
        enum: ['open', 'closed'],
        description: 'Choose <status>',
      },
      reason: {
        title: 'Reason label',
        type: ['string', 'null'],
        description: 'Free-form <text>',
      },
    },
  };

  assert.equal(formatSchemaType(schema.properties.status), 'string: open | closed');
  assert.equal(formatSchemaType(schema.properties.reason), 'string | null');

  const html = renderToolInputParameters(schema);
  assert.match(html, /tool-param-name">status</);
  assert.match(html, /tool-param-type">string: open \| closed</);
  assert.match(html, /tool-param-required required">Required</);
  assert.match(html, /tool-param-description">Choose &lt;status&gt;</);
  assert.match(html, /tool-param-name">Reason label</);
  assert.match(html, /tool-param-key">reason</);
  assert.match(html, /tool-param-description">Free-form &lt;text&gt;</);
  assert.match(html, /tool-param-required ">Optional</);
});

test('renderToolInputParameters shows a stable empty state when a tool takes no arguments', () => {
  assert.equal(
    renderToolInputParameters({ type: 'object', properties: {} }),
    '<div class="tool-card-empty-detail">No arguments.</div>',
  );
});
