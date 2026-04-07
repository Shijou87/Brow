import { createWebMCPRegistryUpdateMessage } from '../shared/messages';
import type { WebMCPRegistryEntry } from '../shared/types';

const registry = new Map<number, WebMCPRegistryEntry>();

export function setRegistryEntry(tabId: number, entry: WebMCPRegistryEntry): void {
  registry.set(tabId, entry);
}

export function getRegistryEntry(tabId: number): WebMCPRegistryEntry | undefined {
  return registry.get(tabId);
}

export function deleteRegistryEntry(tabId: number): void {
  registry.delete(tabId);
}

export function getRegistrySnapshot(): Record<number, WebMCPRegistryEntry> {
  const snapshot: Record<number, WebMCPRegistryEntry> = {};
  registry.forEach((entry, tabId) => {
    snapshot[tabId] = entry;
  });
  return snapshot;
}

export function broadcastRegistryUpdate(tabId: number, entry: WebMCPRegistryEntry): void {
  chrome.runtime.sendMessage(createWebMCPRegistryUpdateMessage(tabId, entry)).catch(() => {
    // Side panel may not be open.
  });
}

