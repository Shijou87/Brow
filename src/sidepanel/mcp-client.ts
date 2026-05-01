// ─── MCP HTTP Client ────────────────────────────────────────────────────────
// Connects to remote MCP servers over HTTP (Streamable HTTP / SSE) using the
// MCP JSON-RPC protocol.  Discovers tools via `tools/list` and invokes them
// via `tools/call`.

import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
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
  /** Streamable HTTP session id returned by the MCP server during initialize. */
  sessionId?: string;
}

export interface MCPServerEntry extends MCPServerConfig {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  tools: MCPToolDescriptor[];
  error?: string;
}

export interface MCPToolDescriptor {
  name: string;
  description: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export type MCPAppVisibility = 'model' | 'app';

export interface MCPAppRenderRequest {
  id: string;
  server: MCPServerConfig;
  serverTools: MCPToolDescriptor[];
  toolName: string;
  toolTitle?: string;
  toolDescription: string;
  resourceUri: string;
  arguments: Record<string, unknown>;
  result: unknown;
  descriptor: MCPToolDescriptor;
  createdAt: number;
}

export interface CreateMCPServerToolsOptions {
  onAppToolResult?: (request: MCPAppRenderRequest) => void;
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

function buildRpcHeaders(authToken?: string, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2024-11-05',
  };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return headers;
}

function readSessionId(res: Response): string | undefined {
  return res.headers.get('mcp-session-id') ?? res.headers.get('Mcp-Session-Id') ?? undefined;
}

export async function rpcCall(
  url: string,
  method: string,
  params?: Record<string, unknown>,
  authToken?: string,
  sessionId?: string,
  onSessionId?: (sessionId: string) => void,
): Promise<any> {
  const id = rpcIdCounter++;
  const body: JsonRpcRequest = { jsonrpc: '2.0', id, method, params: params ?? {} };

  const res = await fetch(url, {
    method: 'POST',
    headers: buildRpcHeaders(authToken, sessionId),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${res.statusText}`);
  }

  const nextSessionId = readSessionId(res);
  if (nextSessionId) onSessionId?.(nextSessionId);

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

async function rpcNotify(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  authToken?: string,
  sessionId?: string,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: buildRpcHeaders(authToken, sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }),
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${res.statusText}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function getToolUiMeta(descriptor: MCPToolDescriptor): Record<string, unknown> | undefined {
  return optionalRecord(descriptor._meta?.ui);
}

function normalizeVisibility(value: unknown): MCPAppVisibility[] {
  if (!Array.isArray(value)) return ['model', 'app'];
  const scopes = value.filter((entry): entry is MCPAppVisibility => entry === 'model' || entry === 'app');
  return scopes.length > 0 ? [...new Set(scopes)] : ['model', 'app'];
}

export function getMCPToolVisibility(descriptor: MCPToolDescriptor): MCPAppVisibility[] {
  return normalizeVisibility(getToolUiMeta(descriptor)?.visibility);
}

export function isToolVisibleToModel(descriptor: MCPToolDescriptor): boolean {
  return getMCPToolVisibility(descriptor).includes('model');
}

export function isToolVisibleToApp(descriptor: MCPToolDescriptor): boolean {
  return getMCPToolVisibility(descriptor).includes('app');
}

export function getMCPToolUIResourceUri(descriptor: MCPToolDescriptor): string | undefined {
  try {
    return getToolUiResourceUri(descriptor as any);
  } catch (err: any) {
    logError('mcp-client', `Invalid MCP App UI metadata on ${descriptor.name}: ${err?.message ?? err}`);
    return undefined;
  }
}

function createAppRenderRequest(
  config: MCPServerConfig,
  descriptor: MCPToolDescriptor,
  descriptors: MCPToolDescriptor[],
  args: Record<string, unknown>,
  result: unknown,
  resourceUri: string,
): MCPAppRenderRequest {
  const id =
    globalThis.crypto?.randomUUID?.()
    ?? `mcp-app-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    id,
    server: { ...config },
    serverTools: descriptors,
    toolName: descriptor.name,
    toolTitle: descriptor.title,
    toolDescription: descriptor.description,
    resourceUri,
    arguments: args,
    result,
    descriptor,
    createdAt: Date.now(),
  };
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
  let sessionId = config.sessionId;
  const rememberSessionId = (nextSessionId: string) => {
    sessionId = nextSessionId;
    config.sessionId = nextSessionId;
  };

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
      sessionId,
      rememberSessionId,
    );
  } catch (err: any) {
    // Some servers don't require initialize — continue anyway
    logInfo('mcp-client', `Initialize skipped or failed: ${err.message}`);
  }

  // Step 2: Send initialized notification (fire-and-forget, no id)
  try {
    await rpcNotify(config.url, 'notifications/initialized', {}, config.authToken, sessionId);
  } catch (err: any) {
    // Optional notification
    logInfo('mcp-client', `Initialized notification skipped or failed: ${err.message}`);
  }

  // Step 3: List tools
  const result = await rpcCall(config.url, 'tools/list', {}, config.authToken, sessionId, rememberSessionId);
  const rawTools: any[] = result?.tools ?? [];

  const tools: MCPToolDescriptor[] = rawTools.map((t: any) => ({
    name: t.name ?? 'unknown',
    description: t.description ?? '',
    title: typeof t.title === 'string' ? t.title : undefined,
    inputSchema: optionalRecord(t.inputSchema),
    outputSchema: optionalRecord(t.outputSchema),
    annotations: optionalRecord(t.annotations),
    _meta: optionalRecord(t._meta),
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
    config.sessionId,
  );
  return result;
}

export async function mcpReadResource(
  config: MCPServerConfig,
  uri: string,
): Promise<unknown> {
  logInfo('mcp-client', `Reading resource ${uri} on ${config.name}`);
  return rpcCall(config.url, 'resources/read', { uri }, config.authToken, config.sessionId);
}

export async function mcpListResources(
  config: MCPServerConfig,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return rpcCall(config.url, 'resources/list', params, config.authToken, config.sessionId);
}

export async function mcpListResourceTemplates(
  config: MCPServerConfig,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return rpcCall(config.url, 'resources/templates/list', params, config.authToken, config.sessionId);
}

// ─── LangChain Tool Factory ───────────────────────────────────────────────

/**
 * Create LangChain StructuredTool instances from MCP server tools.
 * Tool names are prefixed with `mcp_{serverId}_` to avoid collisions.
 */
export function createMCPServerTools(
  config: MCPServerConfig,
  descriptors: MCPToolDescriptor[],
  options: CreateMCPServerToolsOptions = {},
): StructuredToolInterface[] {
  return descriptors.filter(isToolVisibleToModel).map((descriptor) => {
    const zodSchema = descriptor.inputSchema
      ? jsonSchemaToZod(descriptor.inputSchema)
      : z.object({});

    const safeId = config.id.replace(/[^a-zA-Z0-9]/g, '');
    const langchainName = `mcp_${safeId}_${descriptor.name}`;

    return tool(
      async (args: Record<string, unknown>) => {
        const result = await mcpCallTool(config, descriptor.name, args);
        const resourceUri = getMCPToolUIResourceUri(descriptor);
        if (resourceUri) {
          options.onAppToolResult?.(
            createAppRenderRequest(config, descriptor, descriptors, args, result, resourceUri),
          );
        }
        return JSON.stringify(result, null, 2);
      },
      {
        name: langchainName,
        description: `[MCP · ${config.name}] ${descriptor.title ?? descriptor.description}`,
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
