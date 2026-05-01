// ─── WebMCP → LangChain Tool Factory ────────────────────────────────────────
// Generic converter: takes discovered WebMCP tool descriptors + tabId and
// produces LangChain StructuredTool instances.  Each tool invokes the page's
// tool via the extension messaging bridge (webmcpInvoke).
//
// JSON Schema → Zod conversion handles the common subset used by WebMCP:
//  string, number, integer, boolean, array, object, enum, required.

import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import type { WebMCPToolDescriptor } from '../shared/types';
import { jsonSchemaToZod } from '../shared/json-schema';
import { buildToolSnapshotFields } from './agent-runtime/tool-result-snapshot';
import { browserSnapshot, webmcpInvoke } from './tab-tools';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create LangChain tools from discovered WebMCP tool descriptors.
 *
 * Each tool is prefixed with `webmcp_` to avoid name collisions with builtin
 * tools.  When invoked by the agent, the tool sends a message to the content
 * script which bridges into the page's `navigator.modelContext.invokeTool()`.
 *
 * @param tabId     The tab where the tools live
 * @param tools     Discovered tool descriptors from the page
 * @returns         LangChain StructuredToolInterface[]
 */
export function createWebMCPTools(
  tabId: number,
  descriptors: WebMCPToolDescriptor[],
): StructuredToolInterface[] {
  return descriptors.map((descriptor) => {
    // inputSchema may arrive as a JSON string from Chrome's native API — parse it
    let rawSchema = descriptor.inputSchema;
    if (typeof rawSchema === 'string') {
      try { rawSchema = JSON.parse(rawSchema); } catch { rawSchema = undefined; }
    }
    const zodSchema = rawSchema
      ? jsonSchemaToZod(rawSchema as Record<string, unknown>)
      : z.object({});

    // Include tabId in tool name so tools from different tabs don't collide
    const langchainName = `webmcp_t${tabId}_${descriptor.name}`;

    return tool(
      async (args: Record<string, unknown>) => {
        const result = await webmcpInvoke(tabId, descriptor.name, args);
        await sleep(250);
        const snapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 80 });
        return JSON.stringify({
          ...result,
          ...buildToolSnapshotFields(snapshot),
        }, null, 2);
      },
      {
        name: langchainName,
        description: `[WebMCP · tab ${tabId}] ${descriptor.description}`,
        schema: zodSchema,
      },
    ) as unknown as StructuredToolInterface;
  });
}
