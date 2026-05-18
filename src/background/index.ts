// ─── Background Service Worker (MV3) ────────────────────────────────────────
// Routing hub between the side panel and tab-scoped page logic. The worker
// owns tab lifecycle observation, WebMCP discovery scheduling, bridge-script
// readiness checks, and message relay into content-script runtimes. It should
// not accumulate page semantics that belong in content-script or sidepanel
// modules.

import { logDiscovery, logInfo } from '../shared/logger';
import {
  isRuntimeMessageType,
} from '../shared/messages';
import { clearDiscoveryState, ensureBridgeScripts, runDiscovery, scheduleDiscovery, shouldRefreshDiscovery } from './discovery';
import { getRegistrySnapshot } from './webmcp-registry';
import type { WebMCPRegistryEntry, WorkflowRecordingStoredSession } from '../shared/types';

const WORKFLOW_RECORDING_STORAGE_PREFIX = 'agent-webmcp-workflow-recording:';

function workflowRecordingStorageKey(tabId: number): string {
  return `${WORKFLOW_RECORDING_STORAGE_PREFIX}${tabId}`;
}

function getStorageValue<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      resolve(result[key] as T | undefined);
    });
  });
}

function setStorageValue(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve());
  });
}

function removeStorageValue(key: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, () => resolve());
  });
}

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

  if (isRuntimeMessageType(message, 'BROWSER_SNAPSHOT_OPERATION')) {
    const tabId = message.payload?.tabId;
    if (tabId !== undefined) {
      ensureBridgeScripts(tabId, { strict: true })
        .then(() => chrome.tabs.sendMessage(tabId, message))
        .then((result) => sendResponse(result ?? { ok: false, error: 'No response from content script' }))
        .catch((err) => sendResponse({ ok: false, error: err?.message ?? 'Browser Snapshot operation failed' }));
      return true;
    }
  }

  if (isRuntimeMessageType(message, 'WORKFLOW_RECORDING_RESTORE')) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, active: false, error: 'No sender tab' });
      return false;
    }
    getStorageValue<WorkflowRecordingStoredSession>(workflowRecordingStorageKey(tabId))
      .then((session) => sendResponse({ ok: true, active: Boolean(session), session }))
      .catch((err) => sendResponse({ ok: false, active: false, error: err?.message ?? 'Restore failed' }));
    return true;
  }

  if (isRuntimeMessageType(message, 'WORKFLOW_RECORDING_PERSIST')) {
    const tabId = sender.tab?.id;
    const session = message.payload?.session;
    if (tabId === undefined || !session) {
      sendResponse({ ok: false, error: 'Missing sender tab or session payload' });
      return false;
    }
    setStorageValue(workflowRecordingStorageKey(tabId), { ...session, tabId })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message ?? 'Persist failed' }));
    return true;
  }

  if (isRuntimeMessageType(message, 'WORKFLOW_RECORDING_CLEAR')) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, error: 'No sender tab' });
      return false;
    }
    removeStorageValue(workflowRecordingStorageKey(tabId))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message ?? 'Clear failed' }));
    return true;
  }

  if (
    isRuntimeMessageType(message, 'WORKFLOW_RECORDING_START')
    || isRuntimeMessageType(message, 'WORKFLOW_RECORDING_STOP')
    || isRuntimeMessageType(message, 'WORKFLOW_RECORDING_STATUS')
  ) {
    const tabId = message.payload?.tabId;
    if (tabId !== undefined) {
      ensureBridgeScripts(tabId)
        .then(() => chrome.tabs.sendMessage(tabId, message))
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, active: false, error: err.message }));
      return true;
    }
  }

  return false;
});

logInfo('init', 'Background service worker started');
