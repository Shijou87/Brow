// ─── Shared types for Agent WebMCP Chrome Extension ─────────────────────────

// ─── WebMCP ─────────────────────────────────────────────────────────────────

export interface WebMCPToolDescriptor {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface WebMCPDiscoveryResult {
  available: boolean;
  tools: WebMCPToolDescriptor[];
  page: { url: string; title: string };
  tabId: number;
  error?: string;
}

export interface WebMCPRegistryEntry {
  url: string;
  title: string;
  discoveredAt: number;
  available: boolean;
  tools: WebMCPToolDescriptor[];
}

// ─── Messages (between background ↔ content-script ↔ sidepanel) ────────────

export type MessageType =
  | 'WEBMCP_DISCOVER'
  | 'WEBMCP_DISCOVER_RESULT'
  | 'WEBMCP_INVOKE'
  | 'WEBMCP_INVOKE_RESULT'
  | 'WEBMCP_REGISTRY_UPDATE'
  | 'TAB_EVENT';

export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
}

export interface WebMCPDiscoverMessage extends ExtensionMessage {
  type: 'WEBMCP_DISCOVER';
}

export interface WebMCPDiscoverResultMessage extends ExtensionMessage {
  type: 'WEBMCP_DISCOVER_RESULT';
  payload: WebMCPDiscoveryResult;
}

export interface WebMCPInvokeMessage extends ExtensionMessage {
  type: 'WEBMCP_INVOKE';
  payload: { toolName: string; args: Record<string, unknown> };
}

export interface WebMCPInvokeResultMessage extends ExtensionMessage {
  type: 'WEBMCP_INVOKE_RESULT';
  payload: { ok: boolean; result?: unknown; error?: string };
}

export interface WebMCPRegistryUpdateMessage extends ExtensionMessage {
  type: 'WEBMCP_REGISTRY_UPDATE';
  payload: { tabId: number; entry: WebMCPRegistryEntry };
}

// ─── MCP Config ─────────────────────────────────────────────────────────────

export interface MCPConfig {
  endpoint: string;
  transport: 'http' | 'sse' | 'streamable-http';
  authToken?: string;
}

// ─── LLM Config ─────────────────────────────────────────────────────────────

export interface DirectLLMConfig {
  provider: 'direct';
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LMaaSConfig {
  provider: 'lmaas';
  clientId: string;
  clientSecret: string;
  audience: string;
  deployment: string;
  tokenEndpoint?: string;
}

export type LLMConfig = DirectLLMConfig | LMaaSConfig;

// ─── VLM Config ─────────────────────────────────────────────────────────────

export interface VLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ─── Extension settings (stored via chrome.storage) ─────────────────────────

export interface ExtensionSettings {
  llm: LLMConfig;
  vlm: VLMConfig;
  mcp: MCPConfig;
  enableWebMCP: boolean;
  enableMCPApps: boolean;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  llm: {
    provider: 'direct',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    model: 'qwen2.5',
  },
  vlm: {
    baseUrl: 'http://frbucawdl08.av.lab.ge-healthcare.net:4010/v1',
    apiKey: '',
    model: 'Qwen3-VL-30B-A3B-Thinking',
  },
  mcp: {
    endpoint: '',
    transport: 'sse',
  },
  enableWebMCP: true,
  enableMCPApps: true,
  debugLogging: true,
};

// ─── Chat ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  toolName?: string;
  toolSteps?: ToolStepInfo[];
}

export interface ToolStepInfo {
  label: string;
  description?: string;
  status: 'running' | 'completed' | 'error';
  durationMs?: number;
}

// ─── Tool response types ────────────────────────────────────────────────────

export type ToolResponseType = 'text' | 'mcp_app' | 'data' | 'error';

export interface ToolResponse {
  type: ToolResponseType;
  content?: string;
  app?: Record<string, unknown>;
  json?: Record<string, unknown>;
  error?: { message: string; code?: string };
}
