import type { WebMCPInvokeResult } from '../shared/messages';
import { logError, logInfo } from '../shared/logger';

interface PageToolDescriptor {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface PageDiscoverResult {
  available: boolean;
  tools: PageToolDescriptor[];
  error?: string;
}

function toPageToolDescriptor(tool: {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown> | string;
}): PageToolDescriptor {
  let inputSchema = tool.inputSchema;
  if (typeof inputSchema === 'string') {
    try {
      inputSchema = JSON.parse(inputSchema);
    } catch {
      // Keep the original value if it cannot be parsed.
    }
  }

  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: inputSchema as Record<string, unknown> | undefined,
  };
}

export async function discoverPageTools(): Promise<PageDiscoverResult> {
  const mct = navigator.modelContextTesting;
  const mc = navigator.modelContext;

  logInfo('page-bridge', `discover: modelContextTesting=${Boolean(mct)} modelContext=${Boolean(mc)}`);

  if (!mct && !mc) {
    return { available: false, tools: [], error: 'WEBMCP_NOT_AVAILABLE' };
  }

  let tools: PageToolDescriptor[] = [];
  let source = 'none';

  if (mct && typeof mct.listTools === 'function') {
    source = 'modelContextTesting.listTools()';
    tools = (await mct.listTools()).map(toPageToolDescriptor);
  } else if (mc && typeof mc.listTools === 'function') {
    source = 'modelContext.listTools()';
    tools = (await mc.listTools()).map(toPageToolDescriptor);
  } else if (mc && Array.isArray(mc.tools)) {
    source = 'modelContext.tools[]';
    tools = mc.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }));
  }

  logInfo('page-bridge', `discover via ${source}: found ${tools.length} tool(s)`);
  return { available: true, tools };
}

export async function invokePageTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<WebMCPInvokeResult> {
  try {
    const mct = navigator.modelContextTesting;
    const mc = navigator.modelContext;

    logInfo('page-bridge', `invoke: tool="${toolName}" modelContextTesting=${Boolean(mct)} modelContext=${Boolean(mc)}`);

    if (!mct && !mc) {
      return { ok: false, error: 'WEBMCP_NOT_AVAILABLE' };
    }

    let invokeResult: unknown;

    if (mct && typeof mct.executeTool === 'function') {
      invokeResult = await mct.executeTool(toolName, JSON.stringify(args || {}));
    } else if (mc && typeof mc.invokeTool === 'function') {
      invokeResult = await mc.invokeTool(toolName, args || {});
    } else if (mc && Array.isArray(mc.tools)) {
      const tool = mc.tools.find((candidate) => candidate.name === toolName);
      if (!tool) return { ok: false, error: `Tool "${toolName}" not found` };
      if (typeof tool.execute === 'function') {
        invokeResult = await tool.execute(args || {});
      } else if (typeof tool.invoke === 'function') {
        invokeResult = await tool.invoke(args || {});
      } else {
        return { ok: false, error: 'Tool has no execute or invoke method' };
      }
    } else {
      return { ok: false, error: 'No invocation API' };
    }

    let safeResult: unknown;
    try {
      safeResult = JSON.parse(JSON.stringify(invokeResult));
    } catch {
      safeResult = String(invokeResult);
    }

    return { ok: true, result: safeResult };
  } catch (err: any) {
    logError('page-bridge', `invoke error for tool="${toolName}"`, err);
    return { ok: false, error: err?.message || 'INVOCATION_ERROR' };
  }
}

