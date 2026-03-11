// ─── Page Bridge (runs in MAIN world) ────────────────────────────────────────
// This script runs in the page's JavaScript context, so it can see
// navigator.modelContext. It communicates with the content script
// (which runs in the ISOLATED world) via window.postMessage.

export {}; // make this a module for TS

declare global {
  interface Navigator {
    modelContext?: {
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
        invoke?: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
      listTools?: () => Promise<Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>>;
      invokeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    };
  }
  interface Window { __webmcp_bridge__?: boolean; }
}

// Guard: only install once even if script is injected multiple times
if (!window.__webmcp_bridge__) {
  window.__webmcp_bridge__ = true;

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.direction !== 'webmcp-from-content') return;

  const { id, action, toolName, args } = event.data;

  if (action === 'discover') {
    try {
      const mc = navigator.modelContext;
      if (!mc) {
        window.postMessage({ direction: 'webmcp-from-page', id, result: { available: false, tools: [], error: 'WEBMCP_NOT_AVAILABLE' } }, '*');
        return;
      }

      let tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }> = [];

      if (typeof mc.listTools === 'function') {
        const raw = await mc.listTools();
        tools = raw.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema }));
      } else if (Array.isArray(mc.tools)) {
        tools = mc.tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema }));
      }

      window.postMessage({ direction: 'webmcp-from-page', id, result: { available: true, tools } }, '*');
    } catch (err: any) {
      window.postMessage({ direction: 'webmcp-from-page', id, result: { available: false, tools: [], error: err?.message || 'DISCOVERY_ERROR' } }, '*');
    }
    return;
  }

  if (action === 'invoke') {
    try {
      const mc = navigator.modelContext;
      if (!mc) {
        window.postMessage({ direction: 'webmcp-from-page', id, result: { ok: false, error: 'WEBMCP_NOT_AVAILABLE' } }, '*');
        return;
      }

      let invokeResult: unknown;

      if (typeof mc.invokeTool === 'function') {
        invokeResult = await mc.invokeTool(toolName, args || {});
      } else if (Array.isArray(mc.tools)) {
        const tool = mc.tools.find((t) => t.name === toolName);
        if (!tool) {
          window.postMessage({ direction: 'webmcp-from-page', id, result: { ok: false, error: `Tool "${toolName}" not found` } }, '*');
          return;
        }
        if (typeof tool.invoke === 'function') {
          invokeResult = await tool.invoke(args || {});
        } else {
          window.postMessage({ direction: 'webmcp-from-page', id, result: { ok: false, error: 'Tool has no invoke method' } }, '*');
          return;
        }
      } else {
        window.postMessage({ direction: 'webmcp-from-page', id, result: { ok: false, error: 'No invocation API' } }, '*');
        return;
      }

      // Safely serialize (strip non-cloneable values)
      let safe: unknown;
      try { safe = JSON.parse(JSON.stringify(invokeResult)); } catch { safe = String(invokeResult); }
      window.postMessage({ direction: 'webmcp-from-page', id, result: { ok: true, result: safe } }, '*');
    } catch (err: any) {
      window.postMessage({ direction: 'webmcp-from-page', id, result: { ok: false, error: err?.message || 'INVOCATION_ERROR' } }, '*');
    }
  }
});

  console.log('[WebMCP][page-bridge] Loaded in MAIN world on', location.href);
} // end guard
