// ─── WebMCP → LangChain Tool Factory ────────────────────────────────────────
// Generic converter: takes discovered WebMCP tool descriptors + tabId and
// produces LangChain StructuredTool instances.  Each tool invokes the page's
// tool via the extension messaging bridge (webmcpInvoke).
//
// JSON Schema → Zod conversion handles the common subset used by WebMCP:
//  string, number, integer, boolean, array, object, enum, required.

import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { z, type ZodTypeAny } from 'zod';

import type { WebMCPToolDescriptor } from '../shared/types';
import { webmcpInvoke } from './tab-tools';

// ─── JSON Schema → Zod ────────────────────────────────────────────────────

/**
 * Convert a single JSON Schema property definition to a Zod type.
 * Handles: string (+ enum), number, integer, boolean, array, object.
 * Falls back to z.unknown() for anything unrecognised.
 */
function jsonSchemaPropertyToZod(prop: Record<string, unknown>): ZodTypeAny {
  const type = prop.type as string | undefined;

  switch (type) {
    case 'string': {
      let s: ZodTypeAny = z.string();
      if (Array.isArray(prop.enum)) {
        const values = prop.enum as [string, ...string[]];
        s = z.enum(values);
      }
      return s;
    }

    case 'number':
    case 'integer':
      return z.number();

    case 'boolean':
      return z.boolean();

    case 'array': {
      const items = prop.items as Record<string, unknown> | undefined;
      if (items) {
        return z.array(jsonSchemaPropertyToZod(items));
      }
      return z.array(z.unknown());
    }

    case 'object': {
      const nested = prop.properties as Record<string, Record<string, unknown>> | undefined;
      if (nested) {
        return jsonSchemaToZod(prop as Record<string, unknown>);
      }
      return z.record(z.unknown());
    }

    default:
      return z.unknown();
  }
}

/**
 * Convert a JSON Schema object (with `properties` and `required`) to a Zod
 * object schema.  Missing / empty properties → z.object({}) (no args).
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodObject<any> {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || Object.keys(properties).length === 0) {
    return z.object({});
  }

  const requiredFields = new Set<string>(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );

  const shape: Record<string, ZodTypeAny> = {};

  for (const [key, propSchema] of Object.entries(properties)) {
    let zodType = jsonSchemaPropertyToZod(propSchema);

    // Attach description if present
    const desc = propSchema.description as string | undefined;
    if (desc) {
      zodType = zodType.describe(desc);
    }

    // Make optional if not required
    if (!requiredFields.has(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return z.object(shape);
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
    const zodSchema = descriptor.inputSchema
      ? jsonSchemaToZod(descriptor.inputSchema)
      : z.object({});

    // Include tabId in tool name so tools from different tabs don't collide
    const langchainName = `webmcp_t${tabId}_${descriptor.name}`;

    return tool(
      async (args: Record<string, unknown>) => {
        const result = await webmcpInvoke(tabId, descriptor.name, args);
        return JSON.stringify(result, null, 2);
      },
      {
        name: langchainName,
        description: `[WebMCP · tab ${tabId}] ${descriptor.description}`,
        schema: zodSchema,
      },
    ) as unknown as StructuredToolInterface;
  });
}
