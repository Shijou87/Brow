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

// ─── Browser Snapshot Automation ───────────────────────────────────────────

export interface BrowserViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface BrowserViewportInfo {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
}

export interface BrowserSnapshotElement {
  ref: string;
  parentRef?: string;
  framePath?: string[];
  shadowPath?: string[];
  role: string;
  name: string;
  text?: string;
  tagName: string;
  type?: string;
  selector: string;
  actionable: boolean;
  depth: number;
  bounds: BrowserViewportRect;
  attributes?: Record<string, string>;
}

export interface BrowserSnapshot {
  ok: boolean;
  snapshotId: string;
  tabId: number;
  url: string;
  title: string;
  generatedAt: number;
  viewport: BrowserViewportInfo;
  elements: BrowserSnapshotElement[];
  visibleElementCount: number;
  displayedElementCount: number;
  omittedElementCount: number;
  rootRef?: string;
  error?: string;
}

export interface BrowserSnapshotOptions {
  mode?: 'compact' | 'full';
  maxElements?: number;
  rootRef?: string;
  snapshotId?: string;
}

export interface BrowserVisualRegion {
  source: 'ref' | 'rect';
  ref?: string;
  snapshotId?: string;
  rect: BrowserViewportRect;
  viewport: BrowserViewportInfo;
}

export type BrowActionKind = 'click' | 'hover' | 'type' | 'fillForm';

export type BrowActionCacheStatus =
  | 'disabled'
  | 'miss'
  | 'hit'
  | 'stale'
  | 'stored'
  | 'store_skipped';

export interface BrowElementSignature {
  role: string;
  name: string;
  text?: string;
  tagName: string;
  type?: string;
  selector?: string;
  attributes?: Record<string, string>;
}

export type BrowActionPostcondition =
  | { type: 'urlIncludes'; value: string }
  | { type: 'urlMatches'; value: string }
  | { type: 'titleIncludes'; value: string }
  | { type: 'textVisible'; value: string }
  | { type: 'textAbsent'; value: string }
  | { type: 'elementVisible'; ref: string; snapshotId?: string }
  | { type: 'elementHidden'; ref: string; snapshotId?: string }
  | { type: 'valueEquals'; ref: string; value: string; snapshotId?: string };

export interface BrowPostconditionResult {
  ok: boolean;
  condition: BrowActionPostcondition;
  actual?: string;
  error?: string;
}

export interface BrowActionTrace {
  traceId: string;
  tabId: number;
  actionKind: BrowActionKind;
  intent?: string;
  cacheStatus: BrowActionCacheStatus;
  startedAt: number;
  completedAt?: number;
  cacheKey?: string;
  memoryEntryId?: string;
  resolvedRef?: string;
  originalRef?: string;
  snapshotId?: string;
  matchScore?: number;
  preconditions?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  postconditions?: BrowPostconditionResult[];
  recoveryDecision?: string;
}

export interface BrowActionMemoryTarget {
  signature: BrowElementSignature;
  selector?: string;
}

export interface BrowActionMemoryField {
  signature: BrowElementSignature;
  selector?: string;
  mode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable';
}

export interface BrowActionMemoryEntry {
  id: string;
  version: 1;
  origin: string;
  pathPattern: string;
  normalizedIntent: string;
  actionKind: BrowActionKind;
  target?: BrowActionMemoryTarget;
  fields?: BrowActionMemoryField[];
  submitTarget?: BrowActionMemoryTarget;
  createdAt: number;
  updatedAt: number;
  successCount: number;
}

export interface BrowActionMemoryStore {
  version: 1;
  entries: Record<string, BrowActionMemoryEntry>;
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
  status: 'running' | 'awaiting_approval' | 'completed' | 'error';
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
