import { logDiscovery, logError, logInfo } from '../shared/logger';
import type { WebMCPDiscoveryResult, WebMCPRegistryEntry } from '../shared/types';
import { broadcastRegistryUpdate, deleteRegistryEntry, getRegistryEntry, setRegistryEntry } from './webmcp-registry';

const debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 800;
const STALE_MS = 60_000;

function isInternalUrl(url: string): boolean {
  return url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:');
}

function createRegistryEntry(
  tab: chrome.tabs.Tab,
  response: Pick<WebMCPDiscoveryResult, 'available' | 'tools' | 'error'>,
): WebMCPRegistryEntry {
  return {
    url: tab.url ?? '',
    title: tab.title ?? '',
    discoveredAt: Date.now(),
    available: response.available,
    tools: response.tools ?? [],
  };
}

export async function ensureBridgeScripts(tabId: number, options: { strict?: boolean } = {}): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['page-bridge.js'],
      world: 'MAIN',
    });
  } catch (err: any) {
    if (options.strict) {
      throw new Error(err?.message ?? 'Failed to inject page bridge');
    }
    // page-bridge may already be injected
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    });
  } catch (err: any) {
    if (options.strict) {
      throw new Error(err?.message ?? 'Failed to inject content script');
    }
    // content script may already be injected via manifest
  }
}

export function scheduleDiscovery(tabId: number): void {
  const existing = debounceTimers.get(tabId);
  if (existing) clearTimeout(existing);

  debounceTimers.set(
    tabId,
    setTimeout(() => {
      debounceTimers.delete(tabId);
      void runDiscovery(tabId);
    }, DEBOUNCE_MS),
  );
}

export function clearDiscoveryState(tabId: number): void {
  deleteRegistryEntry(tabId);
  const timer = debounceTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(tabId);
  }
}

export function shouldRefreshDiscovery(tabId: number): boolean {
  const existing = getRegistryEntry(tabId);
  return !existing || Date.now() - existing.discoveredAt > STALE_MS;
}

export async function runDiscovery(tabId: number): Promise<void> {
  const startTime = Date.now();

  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? '';
    if (isInternalUrl(url)) {
      logInfo('discover', `Skipping internal page: ${url}`);
      return;
    }

    await ensureBridgeScripts(tabId);
    const response: WebMCPDiscoveryResult = await chrome.tabs.sendMessage(tabId, {
      type: 'WEBMCP_DISCOVER',
    });

    const durationMs = Date.now() - startTime;
    const entry = createRegistryEntry(tab, response);
    setRegistryEntry(tabId, entry);

    logDiscovery(
      tabId,
      entry.url,
      response.available,
      response.tools?.length ?? 0,
      response.tools?.map((tool) => tool.name) ?? [],
      durationMs,
      response.error,
    );

    broadcastRegistryUpdate(tabId, entry);
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    logError('discover', `Discovery failed for tab ${tabId}: ${err.message}`);
    const entry: WebMCPRegistryEntry = {
      url: '',
      title: '',
      discoveredAt: Date.now(),
      available: false,
      tools: [],
    };
    setRegistryEntry(tabId, entry);
    logDiscovery(tabId, '', false, 0, [], durationMs, err.message ?? 'DISCOVERY_ERROR');
    broadcastRegistryUpdate(tabId, entry);
  }
}
