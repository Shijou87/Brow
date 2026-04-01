// ─── Page Bridge (runs in MAIN world) ────────────────────────────────────────
// This script runs in the page's JavaScript context, so it can see
// navigator.modelContext. It communicates with the content script
// (which runs in the ISOLATED world) via window.postMessage.

export {}; // make this a module for TS

declare global {
  interface Navigator {
    modelContext?: {
      registerTool?: (tool: Record<string, unknown>) => void;
      unregisterTool?: (name: string) => void;
      // Polyfill-only: these exist when our polyfill creates modelContext
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
        invoke?: (args: Record<string, unknown>) => Promise<unknown>;
        execute?: (args: Record<string, unknown>) => Promise<unknown>;
      }>;
      listTools?: () => Promise<Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>>;
      invokeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    };
    // Chrome dev trial: discovery + execution API
    modelContextTesting?: {
      listTools?: () => Promise<Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown> | string;
      }>>;
      executeTool?: (name: string, args: string) => Promise<unknown>;
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
      // Chrome splits the API: modelContext for registration, modelContextTesting for discovery.
      // Try modelContextTesting.listTools() first (Chrome native), then fallback to
      // modelContext.listTools() (polyfill) or modelContext.tools (legacy).
      const mct = navigator.modelContextTesting;
      const mc = navigator.modelContext;

      console.log('[WebMCP][page-bridge] discover: modelContextTesting=', !!mct, 'modelContext=', !!mc);

      if (!mct && !mc) {
        console.warn('[WebMCP][page-bridge] discover FAILED: neither modelContext nor modelContextTesting exists');
        window.postMessage({ direction: 'webmcp-from-page', id, result: { available: false, tools: [], error: 'WEBMCP_NOT_AVAILABLE' } }, '*');
        return;
      }

      let tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }> = [];
      let source = 'none';

      if (mct && typeof mct.listTools === 'function') {
        source = 'modelContextTesting.listTools()';
        const raw = await mct.listTools();
        tools = raw.map((t) => {
          // inputSchema may come back as a JSON string from Chrome's native API
          let schema = t.inputSchema;
          if (typeof schema === 'string') {
            try { schema = JSON.parse(schema); } catch { /* keep as-is */ }
          }
          return { name: t.name, description: t.description || '', inputSchema: schema as Record<string, unknown> | undefined };
        });
      } else if (mc && typeof mc.listTools === 'function') {
        source = 'modelContext.listTools()';
        const raw = await mc.listTools();
        tools = raw.map((t) => {
          let schema = t.inputSchema;
          if (typeof schema === 'string') {
            try { schema = JSON.parse(schema); } catch { /* keep as-is */ }
          }
          return { name: t.name, description: t.description || '', inputSchema: schema as Record<string, unknown> | undefined };
        });
      } else if (mc && Array.isArray(mc.tools)) {
        source = 'modelContext.tools[]';
        tools = mc.tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema }));
      }

      console.log(`[WebMCP][page-bridge] discover via ${source}: found ${tools.length} tool(s)`, tools.map(t => t.name));
      if (tools.length === 0) {
        console.warn('[WebMCP][page-bridge] discover returned 0 tools. API keys present:',
          'mct:', mct ? Object.getOwnPropertyNames(Object.getPrototypeOf(mct)) : 'N/A',
          'mc:', mc ? Object.getOwnPropertyNames(Object.getPrototypeOf(mc)) : 'N/A');
      }

      window.postMessage({ direction: 'webmcp-from-page', id, result: { available: true, tools } }, '*');
    } catch (err: any) {
      console.error('[WebMCP][page-bridge] discover ERROR:', err);
      window.postMessage({ direction: 'webmcp-from-page', id, result: { available: false, tools: [], error: err?.message || 'DISCOVERY_ERROR' } }, '*');
    }
    return;
  }

  if (action === 'invoke') {
    try {
      // Chrome native: executeTool on modelContextTesting
      // Polyfill fallback: invokeTool on modelContext, or direct tool.execute()/invoke()
      const mct = navigator.modelContextTesting;
      const mc = navigator.modelContext;

      console.log(`[WebMCP][page-bridge] invoke: tool="${toolName}" modelContextTesting=${!!mct} modelContext=${!!mc}`);

      if (!mct && !mc) {
        console.error(`[WebMCP][page-bridge] invoke FAILED: tool="${toolName}" — no API available`);
        window.postMessage({ direction: 'webmcp-from-page', id, result: { ok: false, error: 'WEBMCP_NOT_AVAILABLE' } }, '*');
        return;
      }

      let invokeResult: unknown;

      if (mct && typeof mct.executeTool === 'function') {
        console.log(`[WebMCP][page-bridge] invoke via modelContextTesting.executeTool("${toolName}")`, args);
        // Chrome's executeTool expects args as a JSON string
        const argsStr = JSON.stringify(args || {});
        invokeResult = await mct.executeTool(toolName, argsStr);
      } else if (mc && typeof mc.invokeTool === 'function') {
        console.log(`[WebMCP][page-bridge] invoke via modelContext.invokeTool("${toolName}")`);
        invokeResult = await mc.invokeTool(toolName, args || {});
      } else if (mc && Array.isArray(mc.tools)) {
        const tool = mc.tools.find((t) => t.name === toolName);
        if (!tool) {
          console.error(`[WebMCP][page-bridge] invoke FAILED: tool="${toolName}" not found in mc.tools`);
          window.postMessage({ direction: 'webmcp-from-page', id, result: { ok: false, error: `Tool "${toolName}" not found` } }, '*');
          return;
        }
        if (typeof tool.execute === 'function') {
          console.log(`[WebMCP][page-bridge] invoke via tool.execute("${toolName}")`);
          invokeResult = await tool.execute(args || {});
        } else if (typeof tool.invoke === 'function') {
          console.log(`[WebMCP][page-bridge] invoke via tool.invoke("${toolName}")`);
          invokeResult = await tool.invoke(args || {});
        } else {
          console.error(`[WebMCP][page-bridge] invoke FAILED: tool="${toolName}" has no execute or invoke method`);
          window.postMessage({ direction: 'webmcp-from-page', id, result: { ok: false, error: 'Tool has no execute or invoke method' } }, '*');
          return;
        }
      } else {
        console.error(`[WebMCP][page-bridge] invoke FAILED: tool="${toolName}" — no invocation API found`);
        window.postMessage({ direction: 'webmcp-from-page', id, result: { ok: false, error: 'No invocation API' } }, '*');
        return;
      }

      // Safely serialize (strip non-cloneable values)
      let safe: unknown;
      try { safe = JSON.parse(JSON.stringify(invokeResult)); } catch { safe = String(invokeResult); }
      console.log(`[WebMCP][page-bridge] invoke OK: tool="${toolName}"`, safe);
      window.postMessage({ direction: 'webmcp-from-page', id, result: { ok: true, result: safe } }, '*');
    } catch (err: any) {
      console.error(`[WebMCP][page-bridge] invoke ERROR: tool="${toolName}"`, err);
      window.postMessage({ direction: 'webmcp-from-page', id, result: { ok: false, error: err?.message || 'INVOCATION_ERROR' } }, '*');
    }
  }
});

  console.log('[WebMCP][page-bridge] Loaded in MAIN world on', location.href);
} // end guard
