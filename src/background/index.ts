// ─── Background Service Worker (MV3) ────────────────────────────────────────
// Observes tab lifecycle / navigation events, triggers WebMCP discovery via
// content scripts, relays results to the side panel, and manages the
// per-tab WebMCP registry.

import { logDiscovery, logInfo, logError } from '../shared/logger';
import {
  isRuntimeMessageType,
} from '../shared/messages';
import { clearDiscoveryState, runDiscovery, scheduleDiscovery, shouldRefreshDiscovery } from './discovery';
import { getRegistrySnapshot } from './webmcp-registry';
import type { WebMCPRegistryEntry } from '../shared/types';

// ─── Open side panel on action click ────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id !== undefined) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Ensure side panel is available on all tabs
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

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
  if (shouldRefreshDiscovery(tabId)) {
    scheduleDiscovery(tabId);
  }
});

// Tab removed — cleanup registry
chrome.tabs.onRemoved.addListener((tabId) => {
  logInfo('tabs', `Tab removed: ${tabId}`);
  clearDiscoveryState(tabId);
});

// ─── Message handler (from side panel) ──────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isRuntimeMessageType(message, 'GET_REGISTRY')) {
    // Return the full registry to the side panel
    sendResponse(getRegistrySnapshot());
    return true;
  }

  if (isRuntimeMessageType(message, 'FORCE_DISCOVER')) {
    const tabId = message.payload?.tabId;
    if (tabId !== undefined) {
      runDiscovery(tabId).then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  }

  if (isRuntimeMessageType(message, 'DISCOVER_ALL')) {
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

  if (isRuntimeMessageType(message, 'WEBMCP_INVOKE')) {
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
