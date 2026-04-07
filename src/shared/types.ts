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

export type LLMConfig = DirectLLMConfig;

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
