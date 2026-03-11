// ─── Background Service Worker (MV3) ────────────────────────────────────────
// Observes tab lifecycle / navigation events, triggers WebMCP discovery via
// content scripts, relays results to the side panel, and manages the
// per-tab WebMCP registry.

import { logDiscovery, logInfo, logError } from '../shared/logger';
import type {
  WebMCPRegistryEntry,
  WebMCPDiscoveryResult,
  WebMCPRegistryUpdateMessage,
} from '../shared/types';

// ─── Per-tab WebMCP registry ────────────────────────────────────────────────

const registry = new Map<number, WebMCPRegistryEntry>();

// Debounce timers per-tab to avoid multiple rapid discovery triggers
const debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 800;

// ─── Open side panel on action click ────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id !== undefined) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Ensure side panel is available on all tabs
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─── Discovery trigger (debounced) ──────────────────────────────────────────

function scheduleDiscovery(tabId: number): void {
  // Clear any existing timer for this tab
  const existing = debounceTimers.get(tabId);
  if (existing) clearTimeout(existing);

  debounceTimers.set(
    tabId,
    setTimeout(() => {
      debounceTimers.delete(tabId);
      runDiscovery(tabId);
    }, DEBOUNCE_MS),
  );
}

async function runDiscovery(tabId: number): Promise<void> {
  const startTime = Date.now();

  try {
    // Get tab info
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? '';
    const title = tab.title ?? '';

    // Skip chrome:// and extension pages
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
      logInfo('discover', `Skipping internal page: ${url}`);
      return;
    }

    // Ensure content scripts are injected (isolated + main world)
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['page-bridge.js'],
        world: 'MAIN',
      });
    } catch {
      // page-bridge may already be injected
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-script.js'],
      });
    } catch {
      // Content script may already be injected via manifest
    }

    // Send discovery message to content script
    const response: WebMCPDiscoveryResult = await chrome.tabs.sendMessage(tabId, {
      type: 'WEBMCP_DISCOVER',
    });

    const durationMs = Date.now() - startTime;

    // Update registry
    const entry: WebMCPRegistryEntry = {
      url,
      title,
      discoveredAt: Date.now(),
      available: response.available,
      tools: response.tools ?? [],
    };
    registry.set(tabId, entry);

    // Log discovery
    logDiscovery(
      tabId,
      url,
      response.available,
      response.tools?.length ?? 0,
      response.tools?.map((t) => t.name) ?? [],
      durationMs,
      response.error,
    );

    // Notify side panel
    broadcastRegistryUpdate(tabId, entry);
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    logError('discover', `Discovery failed for tab ${tabId}: ${err.message}`);

    // Store unavailable entry
    const entry: WebMCPRegistryEntry = {
      url: '',
      title: '',
      discoveredAt: Date.now(),
      available: false,
      tools: [],
    };
    registry.set(tabId, entry);
    broadcastRegistryUpdate(tabId, entry);
  }
}

function broadcastRegistryUpdate(tabId: number, entry: WebMCPRegistryEntry): void {
  const message: WebMCPRegistryUpdateMessage = {
    type: 'WEBMCP_REGISTRY_UPDATE',
    payload: { tabId, entry },
  };
  // Send to all runtime listeners (side panel)
  chrome.runtime.sendMessage(message).catch(() => {
    // Side panel may not be open
  });
}

// ─── Tab lifecycle listeners ────────────────────────────────────────────────

// New tab created
chrome.tabs.onCreated.addListener((tab) => {
  logInfo('tabs', `Tab created: ${tab.id}`);
  if (tab.id !== undefined && tab.url && !tab.url.startsWith('chrome://')) {
    scheduleDiscovery(tab.id);
  }
});

// Tab navigated or finished loading
chrome.tabs.onUpdated.addListener((tabId, changeInfo, _tab) => {
  // Trigger when navigation starts (URL change) or when page finishes loading
  if (changeInfo.url) {
    logInfo('tabs', `Tab ${tabId} navigated to: ${changeInfo.url}`);
    scheduleDiscovery(tabId);
  } else if (changeInfo.status === 'complete') {
    logInfo('tabs', `Tab ${tabId} load complete`);
    scheduleDiscovery(tabId);
  }
});

// Tab activated — discover if stale or missing
chrome.tabs.onActivated.addListener(({ tabId }) => {
  logInfo('tabs', `Tab activated: ${tabId}`);
  const existing = registry.get(tabId);
  const STALE_MS = 60_000; // re-discover if older than 1 minute
  if (!existing || Date.now() - existing.discoveredAt > STALE_MS) {
    scheduleDiscovery(tabId);
  }
});

// Tab removed — cleanup registry
chrome.tabs.onRemoved.addListener((tabId) => {
  logInfo('tabs', `Tab removed: ${tabId}`);
  registry.delete(tabId);
  const timer = debounceTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(tabId);
  }
});

// ─── Message handler (from side panel) ──────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_REGISTRY') {
    // Return the full registry to the side panel
    const obj: Record<number, WebMCPRegistryEntry> = {};
    registry.forEach((v, k) => (obj[k] = v));
    sendResponse(obj);
    return true;
  }

  if (message.type === 'FORCE_DISCOVER') {
    const tabId = message.payload?.tabId;
    if (tabId !== undefined) {
      runDiscovery(tabId).then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  }

  if (message.type === 'DISCOVER_ALL') {
    // Discover WebMCP tools on all non-internal tabs
    chrome.tabs.query({}).then(async (tabs) => {
      let discovered = 0;
      for (const tab of tabs) {
        const url = tab.url ?? '';
        if (tab.id !== undefined && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('about:')) {
          try {
            await runDiscovery(tab.id);
            discovered++;
          } catch { /* skip tabs that fail */ }
        }
      }
      sendResponse({ ok: true, discovered });
    }).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'WEBMCP_INVOKE') {
    const { tabId, toolName, args } = message.payload ?? {};
    if (tabId !== undefined && toolName) {
      chrome.tabs.sendMessage(tabId, { type: 'WEBMCP_INVOKE', payload: { toolName, args } })
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  }

  return false;
});

logInfo('init', 'Background service worker started');
