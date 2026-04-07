// ─── MCP HTTP Client ────────────────────────────────────────────────────────
// Connects to remote MCP servers over HTTP (Streamable HTTP / SSE) using the
// MCP JSON-RPC protocol.  Discovers tools via `tools/list` and invokes them
// via `tools/call`.

import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logInfo, logError } from '../shared/logger';
import { jsonSchemaToZod } from '../shared/json-schema';
import {
  MCP_SERVERS_STORAGE_KEY,
  getStorageValue,
  setStorageValues,
} from '../shared/storage';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface MCPServerConfig {
  /** Unique id (generated) */
  id: string;
  /** Human-readable label */
  name: string;
  /** HTTP(S) endpoint, e.g. http://localhost:3001/mcp */
  url: string;
  /** Optional auth header value (Bearer token) */
  authToken?: string;
}

export interface MCPServerEntry extends MCPServerConfig {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  tools: MCPToolDescriptor[];
  error?: string;
}

export interface MCPToolDescriptor {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

// ─── JSON-RPC helpers ──────────────────────────────────────────────────────

let rpcIdCounter = 1;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

async function rpcCall(
  url: string,
  method: string,
  params?: Record<string, unknown>,
  authToken?: string,
): Promise<any> {
  const id = rpcIdCounter++;
  const body: JsonRpcRequest = { jsonrpc: '2.0', id, method, params: params ?? {} };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') ?? '';

  // Handle SSE response (text/event-stream)
  if (contentType.includes('text/event-stream')) {
    return parseSseResponse(res, id);
  }

  // Standard JSON-RPC response
  const json: JsonRpcResponse = await res.json();
  if (json.error) {
    throw new Error(`MCP RPC error ${json.error.code}: ${json.error.message}`);
  }
  return json.result;
}

async function parseSseResponse(res: Response, expectedId: number): Promise<any> {
  const text = await res.text();
  // Parse SSE events: look for "data:" lines
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json: JsonRpcResponse = JSON.parse(data);
        if (json.error) {
          throw new Error(`MCP RPC error ${json.error.code}: ${json.error.message}`);
        }
        if (json.result !== undefined) return json.result;
      } catch (e: any) {
        if (e.message?.startsWith('MCP RPC')) throw e;
        // ignore parse errors for non-JSON SSE lines
      }
    }
  }
  // Fallback: try parsing the whole body as JSON
  try {
    const json = JSON.parse(text);
    if (json.result !== undefined) return json.result;
    return json;
  } catch {
    throw new Error('Could not parse MCP SSE response');
  }
}

// ─── MCP Client ────────────────────────────────────────────────────────────

/**
 * Connect to an MCP server: send `initialize`, then `tools/list`.
 * Returns the list of discovered tools.
 */
export async function mcpConnect(config: MCPServerConfig): Promise<MCPToolDescriptor[]> {
  logInfo('mcp-client', `Connecting to ${config.url}…`);

  // Step 1: Initialize
  try {
    await rpcCall(
      config.url,
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'agent-webmcp', version: '1.0.0' },
      },
      config.authToken,
    );
  } catch (err: any) {
    // Some servers don't require initialize — continue anyway
    logInfo('mcp-client', `Initialize skipped or failed: ${err.message}`);
  }

  // Step 2: Send initialized notification (fire-and-forget, no id)
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (config.authToken) headers['Authorization'] = `Bearer ${config.authToken}`;
    await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  } catch {
    // Optional notification
  }

  // Step 3: List tools
  const result = await rpcCall(config.url, 'tools/list', {}, config.authToken);
  const rawTools: any[] = result?.tools ?? [];

  const tools: MCPToolDescriptor[] = rawTools.map((t: any) => ({
    name: t.name ?? 'unknown',
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? undefined,
  }));

  logInfo('mcp-client', `Connected to ${config.name}: ${tools.length} tools discovered`);
  return tools;
}

/**
 * Call a tool on a remote MCP server.
 */
export async function mcpCallTool(
  config: MCPServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  logInfo('mcp-client', `Calling tool ${toolName} on ${config.name}`);
  const result = await rpcCall(
    config.url,
    'tools/call',
    { name: toolName, arguments: args },
    config.authToken,
  );
  return result;
}

// ─── LangChain Tool Factory ───────────────────────────────────────────────

/**
 * Create LangChain StructuredTool instances from MCP server tools.
 * Tool names are prefixed with `mcp_{serverId}_` to avoid collisions.
 */
export function createMCPServerTools(
  config: MCPServerConfig,
  descriptors: MCPToolDescriptor[],
): StructuredToolInterface[] {
  return descriptors.map((descriptor) => {
    const zodSchema = descriptor.inputSchema
      ? jsonSchemaToZod(descriptor.inputSchema)
      : z.object({});

    const safeId = config.id.replace(/[^a-zA-Z0-9]/g, '');
    const langchainName = `mcp_${safeId}_${descriptor.name}`;

    return tool(
      async (args: Record<string, unknown>) => {
        const result = await mcpCallTool(config, descriptor.name, args);
        return JSON.stringify(result, null, 2);
      },
      {
        name: langchainName,
        description: `[MCP · ${config.name}] ${descriptor.description}`,
        schema: zodSchema,
      },
    ) as unknown as StructuredToolInterface;
  });
}

// ─── Persistence ───────────────────────────────────────────────────────────

export function loadSavedServers(): Promise<MCPServerConfig[]> {
  return getStorageValue<MCPServerConfig[]>(MCP_SERVERS_STORAGE_KEY).then((servers) => servers ?? []);
}

export function saveServers(servers: MCPServerConfig[]): void {
  void setStorageValues({ [MCP_SERVERS_STORAGE_KEY]: servers });
}

export function generateServerId(): string {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
