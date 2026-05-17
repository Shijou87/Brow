// ─── WebMCP Polyfill (runs in MAIN world at document_start) ─────────────────
// Creates navigator.modelContext when the browser doesn't natively provide it.
// Pages can then call registerTool / unregisterTool and the extension's
// page-bridge can discover & invoke them via listTools / invokeTool.

import { logInfo } from '../shared/logger';

export {}; // module for TS

(function () {
  const nav = navigator as any;

  // Chrome provides a split API:
  //   navigator.modelContext       → registerTool() / unregisterTool()
  //   navigator.modelContextTesting → listTools() / executeTool()
  // If either native object exists, the page-bridge handles both directly — skip polyfill.
  if (nav.modelContext || nav.modelContextTesting) {
    logInfo('polyfill', 'Native WebMCP detected, skipping polyfill');
    return;
  }

  // Neither property exists — create a full polyfill
  const toolMap = new Map<string, Record<string, unknown>>();

  const modelContext = {
    registerTool(tool: Record<string, unknown>) {
      if (tool && typeof tool.name === 'string') {
        toolMap.set(tool.name, tool);
      }
    },

    unregisterTool(name: string) {
      toolMap.delete(name);
    },

    get tools(): Array<Record<string, unknown>> {
      return Array.from(toolMap.values());
    },

    async listTools() {
      return Array.from(toolMap.values()).map((t) => ({
        name: t.name as string,
        description: (t.description as string) || '',
        inputSchema: t.inputSchema as Record<string, unknown> | undefined,
      }));
    },

    async invokeTool(name: string, args: Record<string, unknown> = {}) {
      const tool = toolMap.get(name);
      if (!tool) throw new Error(`Tool "${name}" not found`);
      if (typeof tool.execute === 'function') return await tool.execute(args);
      if (typeof tool.invoke === 'function') return await tool.invoke(args);
      throw new Error(`Tool "${name}" has no execute or invoke method`);
    },
  };

  Object.defineProperty(navigator, 'modelContext', {
    value: modelContext,
    writable: true,
    configurable: true,
  });

  logInfo('polyfill', 'navigator.modelContext polyfilled');
})();
