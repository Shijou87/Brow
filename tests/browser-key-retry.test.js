const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldRetryBodyMediaKey,
} = require('../.tmp-browser-key-retry-test/sidepanel/tab-tools/browser-key-retry.js');

test('retries a media toggle key on body after the initial target fails the media postcondition', () => {
  assert.equal(shouldRetryBodyMediaKey({
    key: 'k',
    code: 'KeyK',
    postconditions: [{ type: 'mediaState', value: 'playing' }],
    postconditionResults: [{ ok: false, condition: { type: 'mediaState', value: 'playing' }, actual: 'paused' }],
    targetSelector: 'activeElement',
    targetTagName: 'div',
  }), true);
});

test('does not retry explicit element targets or non-media key actions', () => {
  assert.equal(shouldRetryBodyMediaKey({
    selector: '#movie_player',
    key: 'k',
    code: 'KeyK',
    postconditions: [{ type: 'mediaState', value: 'playing' }],
    postconditionResults: [{ ok: false, condition: { type: 'mediaState', value: 'playing' }, actual: 'paused' }],
    targetSelector: '#movie_player',
    targetTagName: 'div',
  }), false);

  assert.equal(shouldRetryBodyMediaKey({
    text: 'Metallica',
    postconditions: [{ type: 'mediaState', value: 'playing' }],
    postconditionResults: [{ ok: false, condition: { type: 'mediaState', value: 'playing' }, actual: 'paused' }],
    targetSelector: 'activeElement',
    targetTagName: 'input',
  }), false);
});