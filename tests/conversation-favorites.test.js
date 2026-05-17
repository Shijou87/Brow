const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('saved conversations support favorites and favorites sort before recency', () => {
  const types = read('src/sidepanel/chat-view/types.ts');
  const store = read('src/sidepanel/chat-view/conversation-store.ts');
  const chatView = read('src/sidepanel/chat-view.ts');
  const styles = read('src/sidepanel/styles/_panels.scss');

  assert.match(types, /favorite: boolean;/);

  assert.match(store, /favorite: raw\.favorite === true/);
  assert.match(store, /export function sortSavedConversationsForDisplay/);
  assert.match(store, /const favoriteOrder = Number\(b\.favorite === true\) - Number\(a\.favorite === true\);/);
  assert.match(store, /export async function setSavedConversationFavorite/);

  assert.match(chatView, /private currentConversationFavorite = false;/);
  assert.match(chatView, /sortSavedConversationsForDisplay\(conversations\)/);
  assert.match(chatView, /class="conversation-favorite-btn/);
  assert.match(chatView, /aria-pressed="\$\{convo\.favorite \? 'true' : 'false'\}"/);
  assert.match(chatView, /setSavedConversationFavorite\(convo\.id, nextFavorite\)/);
  assert.match(chatView, /favorite: this\.currentConversationFavorite/);
  assert.match(chatView, /this\.currentConversationFavorite = convo\.favorite === true;/);

  assert.match(styles, /\.conversation-item-actions/);
  assert.match(styles, /\.conversation-favorite-btn/);
  assert.match(styles, /&\.is-favorite/);
});