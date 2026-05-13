// ─── Content Script (per tab) ───────────────────────────────────────────────
// Runs in the ISOLATED world. Relays between the extension (chrome.runtime)
// and the page-bridge script (which runs in the MAIN world and has access
// to navigator.modelContext). Communication uses window.postMessage.

import { isRuntimeMessageType } from '../shared/messages';
import { logError, logInfo } from '../shared/logger';
import { discoverWebMCP, invokeWebMCPTool } from './webmcp-runtime';
import { createWorkflowDemonstrationRecorder } from './workflow-demonstration-recorder';
import { runBrowserSnapshotOperation } from './browser-snapshot-engine';

// Guard against duplicate listener registration when the content script is
// re-injected via chrome.scripting.executeScript (ensureBridgeScripts).
// Without this, each re-injection adds another onMessage listener.  Snapshot
// capture messages then fire N times, rapidly evicting stored snapshots and
// causing subsequent ref resolutions to fail with "Unknown element ref".
const LISTENER_GUARD_KEY = '__browContentScriptListenerRegistered__';
const win = window as unknown as Record<string, boolean | undefined>;
if (win[LISTENER_GUARD_KEY]) {
  // Already registered — bail out to prevent duplicate listeners.
} else {
  win[LISTENER_GUARD_KEY] = true;
  _registerListeners();
}

function _registerListeners(): void {

const workflowDemonstrationRecorder = createWorkflowDemonstrationRecorder();

// ─── Message listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isRuntimeMessageType(message, 'WEBMCP_DISCOVER')) {
    discoverWebMCP()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({
        available: false,
        tools: [],
        page: { url: location.href, title: document.title },
        tabId: -1,
        error: err.message,
      }));
    return true; // async response
  }

  if (isRuntimeMessageType(message, 'WEBMCP_INVOKE')) {
    const { toolName, args } = message.payload ?? {};
    if (toolName) {
      invokeWebMCPTool(toolName, args ?? {})
        .then((result) => {
          if (!result.ok) logError('content-script', `Invoke failed for tool="${toolName}"`, result.error);
          else logInfo('content-script', `Invoke OK for tool="${toolName}"`);
          sendResponse(result);
        })
        .catch((err) => {
          logError('content-script', `Invoke error for tool="${toolName}"`, err);
          sendResponse({ ok: false, error: err.message });
        });
      return true;
    }
  }

  if (isRuntimeMessageType(message, 'BROWSER_SNAPSHOT_OPERATION')) {
    try {
      const result = runBrowserSnapshotOperation(message.payload.operation);
      sendResponse({ ok: true, result });
    } catch (err: any) {
      logError('content-script', 'Browser Snapshot operation failed', err);
      sendResponse({
        ok: false,
        error: err?.message ?? 'Browser Snapshot operation failed',
      });
    }
    return false;
  }

  if (isRuntimeMessageType(message, 'WORKFLOW_RECORDING_START')) {
    const result = workflowDemonstrationRecorder.start({
      title: message.payload?.title,
      captureTypedValues: message.payload?.captureTypedValues,
      tabId: message.payload?.tabId,
    });
    logInfo('content-script', `Workflow demonstration recording started on ${location.href}`);
    sendResponse(result);
    return false;
  }

  if (isRuntimeMessageType(message, 'WORKFLOW_RECORDING_STOP')) {
    const result = workflowDemonstrationRecorder.stop();
    if (!result.ok) {
      logError('content-script', 'Workflow demonstration recording stop failed', result.error);
    } else {
      logInfo('content-script', `Workflow demonstration recording stopped on ${location.href}`);
    }
    sendResponse(result);
    return false;
  }

  if (isRuntimeMessageType(message, 'WORKFLOW_RECORDING_STATUS')) {
    sendResponse(workflowDemonstrationRecorder.getStatus());
    return false;
  }

  return false;
});

} // end _registerListeners

logInfo('content-script', `Loaded in ISOLATED world on ${location.href}`);
