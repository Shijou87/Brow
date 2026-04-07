import type { WebMCPInvokeResult } from '../../shared/messages';
import { toWebMCPDiscoveryResult } from '../../shared/messages';
import type { WebMCPDiscoveryResult, WebMCPRegistryEntry } from '../../shared/types';

export async function webmcpDiscover(
  tabId?: number,
): Promise<WebMCPDiscoveryResult | { available: false; tools?: never[]; error: string; tabId?: number }> {
  let targetTabId = tabId;
  if (targetTabId === undefined) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = activeTab?.id;
  }

  if (targetTabId === undefined) {
    return { available: false, error: 'NO_ACTIVE_TAB' };
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'FORCE_DISCOVER', payload: { tabId: targetTabId } },
      () => {
        chrome.runtime.sendMessage({ type: 'GET_REGISTRY' }, (registry: Record<number, WebMCPRegistryEntry> | undefined) => {
          const entry = registry?.[targetTabId!];
          if (entry) {
            resolve(toWebMCPDiscoveryResult(entry, targetTabId!));
          } else {
            resolve({ available: false, tools: [], tabId: targetTabId, error: 'NO_REGISTRY_ENTRY' });
          }
        });
      },
    );
  });
}

export async function webmcpInvoke(
  tabId: number,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<WebMCPInvokeResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'WEBMCP_INVOKE', payload: { tabId, toolName, args } },
      (response) => {
        resolve(response ?? { ok: false, error: 'No response' });
      },
    );
  });
}

