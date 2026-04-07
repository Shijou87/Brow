import { CONVERSATIONS_STORAGE_KEY, getStorageValue, setStorageValues } from '../../shared/storage';
import type { SavedConversation } from './types';

function normalizeConversations(raw: unknown): SavedConversation[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is SavedConversation => (
    Boolean(item)
    && typeof item === 'object'
    && typeof (item as SavedConversation).id === 'string'
    && typeof (item as SavedConversation).title === 'string'
    && Array.isArray((item as SavedConversation).messages)
    && Array.isArray((item as SavedConversation).chatHistory)
  ));
}

export async function loadSavedConversations(): Promise<SavedConversation[]> {
  return normalizeConversations(await getStorageValue<unknown>(CONVERSATIONS_STORAGE_KEY));
}

export async function upsertSavedConversation(nextConversation: SavedConversation): Promise<void> {
  const conversations = await loadSavedConversations();
  const existingIndex = conversations.findIndex((conversation) => conversation.id === nextConversation.id);
  if (existingIndex >= 0) {
    nextConversation.createdAt = conversations[existingIndex].createdAt;
    conversations[existingIndex] = nextConversation;
  } else {
    conversations.push(nextConversation);
  }
  await setStorageValues({ [CONVERSATIONS_STORAGE_KEY]: conversations });
}

export async function removeSavedConversation(id: string): Promise<void> {
  const conversations = await loadSavedConversations();
  await setStorageValues({
    [CONVERSATIONS_STORAGE_KEY]: conversations.filter((conversation) => conversation.id !== id),
  });
}

