// ─── Content Script (per tab) ───────────────────────────────────────────────
// Runs in the ISOLATED world. Relays between the extension (chrome.runtime)
// and the page-bridge script (which runs in the MAIN world and has access
// to navigator.modelContext). Communication uses window.postMessage.

import { isRuntimeMessageType } from '../shared/messages';
import { logError, logInfo } from '../shared/logger';
import { discoverWebMCP, invokeWebMCPTool } from './webmcp-runtime';

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

  return false;
});

logInfo('content-script', `Loaded in ISOLATED world on ${location.href}`);
