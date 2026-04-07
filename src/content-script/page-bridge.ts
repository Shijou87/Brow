// ─── Page Bridge (runs in MAIN world) ────────────────────────────────────────
// This script runs in the page's JavaScript context, so it can see
// navigator.modelContext. It communicates with the content script
// (which runs in the ISOLATED world) via window.postMessage.

export {}; // make this a module for TS
import { logInfo } from '../shared/logger';
import { discoverPageTools, invokePageTool } from './page-bridge-runtime';

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
    const result = await discoverPageTools();
    window.postMessage({ direction: 'webmcp-from-page', id, result }, '*');
    return;
  }

  if (action === 'invoke') {
    const result = await invokePageTool(toolName, args || {});
    window.postMessage({ direction: 'webmcp-from-page', id, result }, '*');
  }
});

  logInfo('page-bridge', `Loaded in MAIN world on ${location.href}`);
} // end guard
