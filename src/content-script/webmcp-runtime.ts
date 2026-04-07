import type { WebMCPInvokeResult } from '../shared/messages';
import type { WebMCPDiscoveryResult, WebMCPToolDescriptor } from '../shared/types';
import { logError, logInfo } from '../shared/logger';
import { callPageBridge } from './bridge-rpc';

function normalizeToolDescriptors(rawTools: any[]): WebMCPToolDescriptor[] {
  return rawTools.map((tool) => {
    let schema = tool.inputSchema;
    if (typeof schema === 'string') {
      try {
        schema = JSON.parse(schema);
      } catch {
        // Keep the original value if it cannot be parsed.
      }
    }

    return {
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: schema,
    };
  });
}

export async function discoverWebMCP(): Promise<WebMCPDiscoveryResult> {
  const tabId = -1;
  logInfo('content-script', `Starting discovery on ${location.href}`);
  const bridgeResult = await callPageBridge('discover');

  if (!bridgeResult.available) {
    logInfo('content-script', `Discovery unavailable: ${bridgeResult.error ?? 'WEBMCP_NOT_AVAILABLE'}`);
    return {
      available: false,
      tools: [],
      page: { url: location.href, title: document.title },
      tabId,
      error: bridgeResult.error ?? 'WEBMCP_NOT_AVAILABLE',
    };
  }

  const tools = normalizeToolDescriptors(bridgeResult.tools ?? []);
  logInfo('content-script', `Discovery OK on ${location.href}: ${tools.length} tool(s)`);

  return {
    available: true,
    tools,
    page: { url: location.href, title: document.title },
    tabId,
  };
}

export async function invokeWebMCPTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<WebMCPInvokeResult> {
  try {
    logInfo('content-script', `Invoking tool="${toolName}"`);
    return await callPageBridge('invoke', { toolName, args });
  } catch (err: any) {
    logError('content-script', `Invoke error for tool="${toolName}"`, err);
    return { ok: false, error: err.message ?? 'INVOCATION_ERROR' };
  }
}

