const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeHtml,
  formatAssistantMessage,
} = require('../.tmp-message-format-test/sidepanel/message-format.js');

test('escapes raw HTML in assistant messages instead of rendering tags', () => {
  const formatted = formatAssistantMessage('<img src=x onerror="alert(1)"> hello');

  assert.doesNotMatch(formatted, /<img\b/i);
  assert.match(formatted, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; hello/);
});

test('renders an inert markdown subset with safe external links', () => {
  const formatted = formatAssistantMessage('**bold** *italic* `code` https://example.com?q=1&v=2');

  assert.match(formatted, /<strong>bold<\/strong>/);
  assert.match(formatted, /<em>italic<\/em>/);
  assert.match(formatted, /<code>code<\/code>/);
  assert.match(
    formatted,
    /<a href="https:\/\/example\.com\/\?q=1&amp;v=2" target="_blank" rel="noopener noreferrer">https:\/\/example\.com\?q=1&amp;v=2<\/a>/,
  );
});

test('does not turn markdown image syntax into a rendered image', () => {
  const formatted = formatAssistantMessage('![leak](https://example.com/image.png)');

  assert.doesNotMatch(formatted, /<img\b/i);
  assert.match(formatted, /^!\[leak\]\(<a href="https:\/\/example\.com\/image\.png"/);
});

test('escapes apostrophes for attribute-safe reuse', () => {
  assert.equal(escapeHtml("it's"), 'it&#39;s');
});