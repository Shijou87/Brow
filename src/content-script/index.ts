// ─── Content Script (per tab) ───────────────────────────────────────────────
// Runs in the ISOLATED world. Relays between the extension (chrome.runtime)
// and the page-bridge script (which runs in the MAIN world and has access
// to navigator.modelContext). Communication uses window.postMessage.

import type { WebMCPToolDescriptor, WebMCPDiscoveryResult } from '../shared/types';

// ─── postMessage RPC helpers ───────────────────────────────────────────────

let rpcCounter = 0;
const pendingRpcs = new Map<number, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>();

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.direction !== 'webmcp-from-page') return;
  const { id, result } = event.data;
  const pending = pendingRpcs.get(id);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRpcs.delete(id);
    pending.resolve(result);
  }
});

function callPageBridge(action: string, extra: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve) => {
    const id = ++rpcCounter;
    const timer = setTimeout(() => {
      pendingRpcs.delete(id);
      resolve(action === 'discover'
        ? { available: false, tools: [], error: 'BRIDGE_TIMEOUT' }
        : { ok: false, error: 'BRIDGE_TIMEOUT' });
    }, 5000);
    pendingRpcs.set(id, { resolve, timer });
    window.postMessage({ direction: 'webmcp-from-content', id, action, ...extra }, '*');
  });
}

// ─── Discovery handler ─────────────────────────────────────────────────────

async function discoverWebMCP(): Promise<WebMCPDiscoveryResult> {
  const tabId = -1; // filled by background
  const bridgeResult = await callPageBridge('discover');

  if (!bridgeResult.available) {
    return {
      available: false,
      tools: [],
      page: { url: location.href, title: document.title },
      tabId,
      error: bridgeResult.error ?? 'WEBMCP_NOT_AVAILABLE',
    };
  }

  const tools: WebMCPToolDescriptor[] = (bridgeResult.tools ?? []).map((t: any) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema,
  }));

  return {
    available: true,
    tools,
    page: { url: location.href, title: document.title },
    tabId,
  };
}

// ─── Invocation handler ─────────────────────────────────────────────────────

async function invokeWebMCPTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return callPageBridge('invoke', { toolName, args });
}

// ─── Message listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'WEBMCP_DISCOVER') {
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

  if (message.type === 'WEBMCP_INVOKE') {
    const { toolName, args } = message.payload ?? {};
    if (toolName) {
      invokeWebMCPTool(toolName, args ?? {})
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  }

  return false;
});

console.log('[WebMCP][content-script] Loaded (ISOLATED world) on', location.href);
