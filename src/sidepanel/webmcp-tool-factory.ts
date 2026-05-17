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
import {
  invalidateBrowserContextSnapshotCache,
  primeBrowserContextSnapshotCache,
} from './agent-runtime/browser-context';
import { jsonSchemaToZod, normalizeJsonSchemaParsedObject } from '../shared/json-schema';
import { buildToolSnapshotFields } from './agent-runtime/tool-result-snapshot';
import { browserSnapshot, webmcpInvoke } from './tab-tools';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const READ_ONLY_NAME_RE = /^(get|list|read|fetch|find|search|query|inspect|check|status|describe|preview|peek|resolve)/i;
const MUTATING_NAME_RE = /^(set|update|create|delete|remove|insert|submit|click|type|fill|open|close|toggle|select|choose|press|activate|navigate|scroll|drag|upload|download|login|logout|send|save)/i;
const READ_ONLY_DESCRIPTION_RE = /\b(read|fetch|list|search|query|inspect|status|preview|describe)\b/i;
const MUTATING_DESCRIPTION_RE = /\b(create|update|delete|remove|submit|click|type|fill|open|close|toggle|select|activate|navigate|scroll|drag|upload|download|login|logout|send|save)\b/i;

/**
 * Heuristically classifies a discovered WebMCP tool as page-mutating or
 * read-oriented so Brow can decide whether aftermath context is useful.
 */
export function isLikelyMutatingWebMCPTool(descriptor: WebMCPToolDescriptor): boolean {
  if (MUTATING_NAME_RE.test(descriptor.name)) return true;
  if (READ_ONLY_NAME_RE.test(descriptor.name)) return false;
  if (MUTATING_DESCRIPTION_RE.test(descriptor.description)) return true;
  if (READ_ONLY_DESCRIPTION_RE.test(descriptor.description)) return false;
  return Boolean(descriptor.inputSchema && Object.keys(descriptor.inputSchema).length > 0);
}

/**
 * Decides whether Brow should append a fresh Browser Snapshot after a WebMCP
 * tool call completes.
 */
export function shouldCaptureWebMCPAftermath(
  descriptor: WebMCPToolDescriptor,
  result: { ok?: boolean } | undefined,
): boolean {
  if (result?.ok === false) return false;
  return isLikelyMutatingWebMCPTool(descriptor);
}

/**
 * Returns the small post-tool delay Brow uses before taking an aftermath
 * snapshot for a likely mutating WebMCP tool.
 */
export function getWebMCPAftermathWaitMs(
  descriptor: WebMCPToolDescriptor,
  result: { ok?: boolean } | undefined,
): number {
  return shouldCaptureWebMCPAftermath(descriptor, result) ? 180 : 0;
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
    const zodSchema: z.ZodTypeAny = rawSchema
      ? jsonSchemaToZod(rawSchema as Record<string, unknown>) as z.ZodTypeAny
      : z.object({});

    // Include tabId in tool name so tools from different tabs don't collide
    const langchainName = `webmcp_t${tabId}_${descriptor.name}`;
    const invokeTool = async (args: Record<string, unknown>): Promise<string> => {
      const normalizedArgs = normalizeJsonSchemaParsedObject(args);
      const result = await webmcpInvoke(tabId, descriptor.name, normalizedArgs);
      const waitMs = getWebMCPAftermathWaitMs(descriptor, result);
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      if (!shouldCaptureWebMCPAftermath(descriptor, result)) {
        return JSON.stringify(result, null, 2);
      }

      invalidateBrowserContextSnapshotCache(tabId);
      const snapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 80 });
      const snapshotFields = buildToolSnapshotFields(snapshot);
      if (snapshot.ok) {
        primeBrowserContextSnapshotCache(snapshot, snapshotFields.snapshotText);
      }

      return JSON.stringify({
        ...result,
        ...snapshotFields,
      }, null, 2);
    };

    const createLangChainTool = tool as (...args: any[]) => unknown;

    return createLangChainTool(
      invokeTool,
      {
        name: langchainName,
        description: `[WebMCP · tab ${tabId}] ${descriptor.description}`,
        schema: zodSchema,
      },
    ) as StructuredToolInterface;
  });
}
