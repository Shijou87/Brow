// ─── LangGraph Agent ────────────────────────────────────────────────────────
// Replicates the proven architecture from agent-singleton.ts:
//  • Singleton Agent class with lazy LLM init
//  • Streaming via agent.stream() with updates mode
//  • AbortController + abortable stream generator
//  • Pause/resume support
//  • ToolStepEvent tracking with callId mapping
//  • Dynamic rebuildAgent()

import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';

import {
  tabsList,
  tabsGetActive,
  tabsGetContent,
  tabsActivate,
  tabsCreate,
  tabsUpdateUrl,
  webmcpDiscover,
  webmcpInvoke,
} from './tab-tools';
import {
  ensureLlm,
  getLlmSync,
  reconfigureLlm,
  resetLlm,
  type ChatOpenAIInstance,
  type LLMConfigUnion,
} from './llm-config';
import { createWebMCPTools } from './webmcp-tool-factory';
import {
  createMCPServerTools,
  mcpConnect,
  loadSavedServers,
  saveServers,
  generateServerId,
  type MCPServerConfig,
  type MCPServerEntry,
  type MCPToolDescriptor,
} from './mcp-client';
import type { WebMCPToolDescriptor } from '../shared/types';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolStepEvent {
  stepIndex: number;
  toolName: string;
  label: string;
  status: 'running' | 'completed';
  description?: string;
  durationMs?: number;
  startTime: number;
}

export type ToolStepCallback = (steps: ToolStepEvent[]) => void;
export type StreamTextCallback = (text: string) => void;

export interface ToolManifestEntry {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
}

export interface AgentAPI {
  query: (query: string, history?: ChatTurn[]) => Promise<string>;
  onToolStep: (callback: ToolStepCallback) => void;
  offToolStep: (callback: ToolStepCallback) => void;
  onStreamText: (callback: StreamTextCallback) => void;
  offStreamText: (callback: StreamTextCallback) => void;
  abort: () => void;
  isBusy: () => boolean;
  pause: () => void;
  resume: () => void;
  togglePause: () => void;
  isPaused: () => boolean;
  updateWebMCPTools: (tabId: number, descriptors: WebMCPToolDescriptor[], url?: string, title?: string) => void;
  removeWebMCPToolsForTab: (tabId: number) => void;
  clearWebMCPTools: () => void;
  getToolManifest: () => ToolManifestEntry[];
  setToolEnabled: (toolName: string, enabled: boolean) => void;
  setToolsEnabled: (toolNames: string[], enabled: boolean) => void;
  getDisabledTools: () => string[];
  setDisabledTools: (names: string[]) => void;
  // MCP server management
  addMCPServer: (name: string, url: string, authToken?: string) => Promise<MCPServerEntry>;
  removeMCPServer: (id: string) => void;
  reconnectMCPServer: (id: string) => Promise<MCPServerEntry>;
  getMCPServers: () => MCPServerEntry[];
  restoreMCPServers: () => Promise<void>;
}

type ReactAgent = {
  stream: (input: any, config?: any) => AsyncIterable<any> | Promise<AsyncIterable<any>>;
};

// ─── Tool display helpers ──────────────────────────────────────────────────

const TOOL_DISPLAY_LABELS: Record<string, string> = {
  tabs_list: 'Listing tabs',
  tabs_getActive: 'Getting active tab',
  tabs_getContent: 'Reading tab content',
  tabs_activate: 'Activating tab',
  tabs_create: 'Creating tab',
  tabs_updateUrl: 'Navigating tab',
  webmcp_discover: 'Discovering WebMCP tools',
  webmcp_invoke: 'Invoking WebMCP tool',
};

// Dynamic labels for WebMCP tools get built at runtime
function getToolDisplayLabel(toolName: string): string {
  if (TOOL_DISPLAY_LABELS[toolName]) return TOOL_DISPLAY_LABELS[toolName];
  // For webmcp_t{id}_{name} prefixed tools, show a nicer label
  const mcpMatch = toolName.match(/^webmcp_t(\d+)_(.+)$/);
  if (mcpMatch) {
    const base = mcpMatch[2].replace(/_/g, ' ');
    return `WebMCP: ${base}`;
  }
  if (toolName.startsWith('webmcp_')) {
    const base = toolName.slice(7).replace(/_/g, ' ');
    return `WebMCP: ${base}`;
  }
  return toolName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function getToolCompletionDescription(toolName: string, result?: string): string {
  const MAX = 100;
  if (result) {
    try {
      const parsed = JSON.parse(result);
      if (parsed.message) {
        const msg = parsed.message as string;
        return msg.length > MAX ? msg.slice(0, MAX) + '…' : msg;
      }
    } catch { /* ignore */ }
  }
  const defaults: Record<string, string> = {
    tabs_list: 'Retrieved tab list',
    tabs_getActive: 'Got active tab',
    tabs_getContent: 'Read tab content',
    tabs_activate: 'Tab activated',
    tabs_create: 'Tab created',
    tabs_updateUrl: 'Tab navigated',
    webmcp_discover: 'Discovery complete',
    webmcp_invoke: 'Tool invoked',
  };
  return defaults[toolName] || `Completed ${toolName}`;
}

/**
 * Strip raw JSON tool-call blocks some models embed in text content.
 */
function stripToolCallJson(text: string): string {
  return text
    .replace(/\s*\{[\s\S]*?"tool"\s*:\s*"[^"]*"[\s\S]*?\}\s*$/g, '')
    .trim();
}

// ─── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful AI assistant inside a Chrome browser extension.

You have access to browser tab management tools and WebMCP tools.

**Tab tools:**
- tabs_list: List all open browser tabs
- tabs_getActive: Get info about the currently active tab (no arguments needed)
- tabs_getContent: Read the text or HTML content of a specific tab
- tabs_activate: Switch to a specific tab
- tabs_create: Create a new tab with a URL (you decide URLs for user intent like "go to my email" → https://mail.google.com/)
- tabs_updateUrl: Navigate an existing tab to a new URL

**WebMCP tools:**
- webmcp_discover: Discover WebMCP tools available on a tab (via navigator.modelContext)
- webmcp_invoke: Invoke a discovered WebMCP tool on a tab

Important: You decide URLs based on user intent. Do NOT ask the user for URLs if the intent is clear.
Examples:
- "go to my email" → tabs_create with https://mail.google.com/
- "open YouTube" → tabs_create with https://www.youtube.com/
- "open GitHub" → tabs_create with https://github.com/

Keep responses concise and helpful.`;

// ─── Tool definitions ──────────────────────────────────────────────────────

function createBuiltinTools(): StructuredToolInterface[] {
  const tabsListTool = tool(
    async () => {
      const tabs = await tabsList();
      return JSON.stringify(tabs, null, 2);
    },
    {
      name: 'tabs_list',
      description: 'List all open browser tabs. Returns tabId, windowId, title, url, active, audible, status.',
      schema: z.object({}),
    },
  );

  const tabsGetActiveTool = tool(
    async () => {
      const tab = await tabsGetActive();
      return JSON.stringify(tab, null, 2);
    },
    {
      name: 'tabs_getActive',
      description: 'Get info about the currently active tab. Returns tabId, title, url, etc. No arguments needed.',
      schema: z.object({}),
    },
  );

  const tabsGetContentTool = tool(
    async ({ tabId, format }: { tabId: number; format?: string }) => {
      const result = await tabsGetContent(tabId, (format as 'text' | 'html') ?? 'text');
      return JSON.stringify(result, null, 2);
    },
    {
      name: 'tabs_getContent',
      description: 'Read the text content (or HTML) of a specific tab. Use tabs_getActive first to get the tabId if needed.',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab to read content from'),
        format: z.enum(['text', 'html']).optional().describe('Content format: "text" (default) or "html"'),
      }),
    },
  );

  const tabsActivateTool = tool(
    async ({ tabId }: { tabId: number }) => {
      const result = await tabsActivate(tabId);
      return JSON.stringify(result);
    },
    {
      name: 'tabs_activate',
      description: 'Activate (switch to) a specific browser tab by its tabId.',
      schema: z.object({ tabId: z.number().describe('The ID of the tab to activate') }),
    },
  );

  const tabsCreateTool = tool(
    async ({ url, active }: { url: string; active?: boolean }) => {
      const result = await tabsCreate(url, active ?? true);
      return JSON.stringify(result);
    },
    {
      name: 'tabs_create',
      description: 'Create a new browser tab with the specified URL. The agent decides appropriate URLs.',
      schema: z.object({
        url: z.string().describe('URL to open'),
        active: z.boolean().optional().describe('Whether to activate the tab (default: true)'),
      }),
    },
  );

  const tabsUpdateUrlTool = tool(
    async ({ tabId, url }: { tabId: number; url: string }) => {
      const result = await tabsUpdateUrl(tabId, url);
      return JSON.stringify(result);
    },
    {
      name: 'tabs_updateUrl',
      description: 'Navigate an existing tab to a new URL.',
      schema: z.object({
        tabId: z.number().describe('Tab ID to navigate'),
        url: z.string().describe('New URL to load'),
      }),
    },
  );

  const webmcpDiscoverTool = tool(
    async ({ tabId }: { tabId?: number }) => {
      const result = await webmcpDiscover(tabId);
      return JSON.stringify(result, null, 2);
    },
    {
      name: 'webmcp_discover',
      description: 'Discover WebMCP tools on a tab. Defaults to active tab. Returns tools exposed by the page.',
      schema: z.object({
        tabId: z.number().optional().describe('Tab ID (default: active tab)'),
      }),
    },
  );

  const webmcpInvokeTool = tool(
    async ({ tabId, toolName, args }: { tabId: number; toolName: string; args?: Record<string, unknown> }) => {
      const result = await webmcpInvoke(tabId, toolName, args ?? {});
      return JSON.stringify(result, null, 2);
    },
    {
      name: 'webmcp_invoke',
      description: 'Invoke a WebMCP tool on a specific tab. Must be discovered first.',
      schema: z.object({
        tabId: z.number().describe('Tab ID where the tool lives'),
        toolName: z.string().describe('Name of the WebMCP tool'),
        args: z.record(z.unknown()).optional().describe('Arguments to pass'),
      }),
    },
  );

  return [
    tabsListTool as unknown as StructuredToolInterface,
    tabsGetActiveTool as unknown as StructuredToolInterface,
    tabsGetContentTool as unknown as StructuredToolInterface,
    tabsActivateTool as unknown as StructuredToolInterface,
    tabsCreateTool as unknown as StructuredToolInterface,
    tabsUpdateUrlTool as unknown as StructuredToolInterface,
    webmcpDiscoverTool as unknown as StructuredToolInterface,
    webmcpInvokeTool as unknown as StructuredToolInterface,
  ];
}

// ─── Agent Class (mirrors Agent from agent-singleton.ts) ───────────────────

export class Agent implements AgentAPI {
  private currentAgent: ReactAgent | null = null;
  private readonly builtinTools: StructuredToolInterface[];
  /** Per-tab WebMCP tool storage: tabId → { descriptors, langchainTools } */
  private webmcpByTab = new Map<number, {
    descriptors: WebMCPToolDescriptor[];
    tools: StructuredToolInterface[];
    url?: string;
    title?: string;
  }>();
  /** Remote MCP servers: id → entry */
  private mcpServers = new Map<string, MCPServerEntry & { langchainTools: StructuredToolInterface[] }>();
  /** Disabled tool names — these are excluded from the agent graph */
  private disabledTools = new Set<string>();
  private toolStepCallbacks: ToolStepCallback[] = [];
  private streamTextCallbacks: StreamTextCallback[] = [];
  private queryAbortController: AbortController | null = null;
  private paused = false;
  private pauseResolve: (() => void) | null = null;

  constructor() {
    this.builtinTools = createBuiltinTools();
    // Kick off async LLM init, then rebuild once ready
    void ensureLlm()
      .then(() => this.rebuildAgent())
      .catch((err) => console.warn('[agent] LLM not yet configured:', err.message));
  }

  // ─── Dynamic WebMCP tool management (multi-tab) ─────────────────────

  updateWebMCPTools(tabId: number, descriptors: WebMCPToolDescriptor[], url?: string, title?: string): void {
    const tools = createWebMCPTools(tabId, descriptors);
    this.webmcpByTab.set(tabId, { descriptors, tools, url, title });
    console.log('[agent] WebMCP tools updated for tab', tabId, ':', descriptors.map(t => t.name));

    // Register display labels
    for (const d of descriptors) {
      const key = `webmcp_t${tabId}_${d.name}`;
      TOOL_DISPLAY_LABELS[key] = `WebMCP: ${d.name.replace(/_/g, ' ')}`;
    }

    this.rebuildAgent();
  }

  removeWebMCPToolsForTab(tabId: number): void {
    if (this.webmcpByTab.has(tabId)) {
      this.webmcpByTab.delete(tabId);
      console.log('[agent] Removed WebMCP tools for tab', tabId);
      this.rebuildAgent();
    }
  }

  clearWebMCPTools(): void {
    this.webmcpByTab.clear();
    this.rebuildAgent();
  }

  // ─── Tool enable/disable management ──────────────────────────────

  /** Get a manifest of all available tools with their enabled state and category */
  getToolManifest(): ToolManifestEntry[] {
    const manifest: ToolManifestEntry[] = [];

    // Builtin tab tools
    for (const t of this.builtinTools) {
      const name = (t as any).name as string;
      let category = 'tab_management';
      if (name.startsWith('webmcp_discover') || name.startsWith('webmcp_invoke')) {
        category = 'webmcp_meta';
      }
      manifest.push({
        name,
        description: (t as any).description ?? '',
        category,
        enabled: !this.disabledTools.has(name),
      });
    }

    // Dynamic WebMCP tools per tab
    for (const [tabId, entry] of this.webmcpByTab.entries()) {
      const label = entry.title || entry.url || `tab ${tabId}`;
      const category = `webmcp_tab_${tabId}`;
      for (const t of entry.tools) {
        const name = (t as any).name as string;
        manifest.push({
          name,
          description: (t as any).description ?? '',
          category,
          enabled: !this.disabledTools.has(name),
        });
      }
    }

    // Remote MCP server tools
    for (const [serverId, entry] of this.mcpServers.entries()) {
      if (entry.status !== 'connected') continue;
      const category = `mcp_server_${serverId}`;
      for (const t of entry.langchainTools) {
        const name = (t as any).name as string;
        manifest.push({
          name,
          description: (t as any).description ?? '',
          category,
          enabled: !this.disabledTools.has(name),
        });
      }
    }

    return manifest;
  }

  /** Get category display labels */
  static getCategoryLabel(category: string): string {
    if (category === 'tab_management') return 'Tab Management';
    if (category === 'webmcp_meta') return 'WebMCP Discovery';
    const tabMatch = category.match(/^webmcp_tab_(\d+)$/);
    if (tabMatch) return `WebMCP · Tab ${tabMatch[1]}`;
    const mcpMatch = category.match(/^mcp_server_(.+)$/);
    if (mcpMatch) return `MCP Server`;
    return category;
  }

  setToolEnabled(toolName: string, enabled: boolean): void {
    if (enabled) {
      this.disabledTools.delete(toolName);
    } else {
      this.disabledTools.add(toolName);
    }
    this.rebuildAgent();
  }

  setToolsEnabled(toolNames: string[], enabled: boolean): void {
    for (const name of toolNames) {
      if (enabled) {
        this.disabledTools.delete(name);
      } else {
        this.disabledTools.add(name);
      }
    }
    this.rebuildAgent();
  }

  getDisabledTools(): string[] {
    return [...this.disabledTools];
  }

  setDisabledTools(names: string[]): void {
    this.disabledTools = new Set(names);
    this.rebuildAgent();
  }

  // ─── MCP Server management ──────────────────────────────────────────

  async addMCPServer(name: string, url: string, authToken?: string): Promise<MCPServerEntry> {
    const config: MCPServerConfig = { id: generateServerId(), name, url, authToken };
    const entry: MCPServerEntry & { langchainTools: StructuredToolInterface[] } = {
      ...config,
      status: 'connecting',
      tools: [],
      langchainTools: [],
    };
    this.mcpServers.set(config.id, entry);

    try {
      const tools = await mcpConnect(config);
      entry.status = 'connected';
      entry.tools = tools;
      entry.langchainTools = createMCPServerTools(config, tools);

      // Register display labels for MCP tools
      const safeId = config.id.replace(/[^a-zA-Z0-9]/g, '');
      for (const t of tools) {
        TOOL_DISPLAY_LABELS[`mcp_${safeId}_${t.name}`] = `MCP ${config.name}: ${t.name.replace(/_/g, ' ')}`;
      }

      this.rebuildAgent();
      this.persistMCPServers();
      console.log(`[agent] MCP server "${name}" connected with ${tools.length} tools`);
    } catch (err: any) {
      entry.status = 'error';
      entry.error = err.message ?? String(err);
      console.error(`[agent] MCP server "${name}" connection failed:`, err);
    }

    return entry;
  }

  removeMCPServer(id: string): void {
    const entry = this.mcpServers.get(id);
    if (entry) {
      // Remove display labels
      const safeId = id.replace(/[^a-zA-Z0-9]/g, '');
      for (const t of entry.tools) {
        delete TOOL_DISPLAY_LABELS[`mcp_${safeId}_${t.name}`];
      }
      this.mcpServers.delete(id);
      this.rebuildAgent();
      this.persistMCPServers();
      console.log(`[agent] MCP server "${entry.name}" removed`);
    }
  }

  async reconnectMCPServer(id: string): Promise<MCPServerEntry> {
    const entry = this.mcpServers.get(id);
    if (!entry) throw new Error(`MCP server ${id} not found`);

    entry.status = 'connecting';
    entry.error = undefined;
    entry.tools = [];
    entry.langchainTools = [];

    try {
      const config: MCPServerConfig = { id: entry.id, name: entry.name, url: entry.url, authToken: entry.authToken };
      const tools = await mcpConnect(config);
      entry.status = 'connected';
      entry.tools = tools;
      entry.langchainTools = createMCPServerTools(config, tools);

      const safeId = id.replace(/[^a-zA-Z0-9]/g, '');
      for (const t of tools) {
        TOOL_DISPLAY_LABELS[`mcp_${safeId}_${t.name}`] = `MCP ${entry.name}: ${t.name.replace(/_/g, ' ')}`;
      }

      this.rebuildAgent();
      console.log(`[agent] MCP server "${entry.name}" reconnected with ${tools.length} tools`);
    } catch (err: any) {
      entry.status = 'error';
      entry.error = err.message ?? String(err);
      console.error(`[agent] MCP server "${entry.name}" reconnection failed:`, err);
    }

    return entry;
  }

  getMCPServers(): MCPServerEntry[] {
    return [...this.mcpServers.values()].map(({ langchainTools, ...rest }) => rest);
  }

  async restoreMCPServers(): Promise<void> {
    const saved = await loadSavedServers();
    for (const config of saved) {
      // Don't duplicate if already present
      if (this.mcpServers.has(config.id)) continue;
      // Try to connect in background
      this.addMCPServer(config.name, config.url, config.authToken)
        .catch((err) => console.warn(`[agent] Failed to restore MCP server "${config.name}":`, err));
    }
  }

  private persistMCPServers(): void {
    const configs: MCPServerConfig[] = [...this.mcpServers.values()].map(
      ({ id, name, url, authToken }) => ({ id, name, url, authToken }),
    );
    saveServers(configs);
  }

  // ─── Callback registration ───────────────────────────────────────────

  onToolStep(callback: ToolStepCallback): void {
    this.toolStepCallbacks.push(callback);
  }

  offToolStep(callback: ToolStepCallback): void {
    this.toolStepCallbacks = this.toolStepCallbacks.filter((cb) => cb !== callback);
  }

  onStreamText(callback: StreamTextCallback): void {
    this.streamTextCallbacks.push(callback);
  }

  offStreamText(callback: StreamTextCallback): void {
    this.streamTextCallbacks = this.streamTextCallbacks.filter((cb) => cb !== callback);
  }

  private emitToolSteps(steps: ToolStepEvent[]): void {
    for (const cb of this.toolStepCallbacks) {
      try { cb([...steps]); } catch (e) { console.warn('[agent] toolStep callback error', e); }
    }
  }

  private emitStreamText(text: string): void {
    for (const cb of this.streamTextCallbacks) {
      try { cb(text); } catch (e) { console.warn('[agent] streamText callback error', e); }
    }
  }

  // ─── Abort ──────────────────────────────────────────────────────────

  abort(): void {
    console.log('[agent] Abort requested');
    if (this.queryAbortController) {
      this.queryAbortController.abort();
      this.queryAbortController = null;
    }
  }

  isBusy(): boolean {
    return this.queryAbortController !== null;
  }

  // ─── Pause / Resume ────────────────────────────────────────────────

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    console.log('[agent] Paused');
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    console.log('[agent] Resumed');
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  isPaused(): boolean {
    return this.paused;
  }

  private waitIfPaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
  }

  // ─── Query (streaming, mirrors agent-singleton.ts) ─────────────────

  async query(userQuery: string, history: ChatTurn[] = []): Promise<string> {
    // Lazy re-init if needed
    if (this.currentAgent == null) {
      try {
        await ensureLlm();
        this.rebuildAgent();
      } catch (err: any) {
        console.error('[agent] Failed to init LLM:', err);
      }
      if (this.currentAgent == null) {
        return 'Agent not configured. Please set up your LLM in the config panel.';
      }
    }

    const messages = [
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: 'user', content: userQuery },
    ];
    let finalContent = '';

    // Tool step tracking
    const toolSteps: ToolStepEvent[] = [];
    const pendingTools = new Map<string, ToolStepEvent>();
    let stepCounter = 0;

    // Abort controller for this query
    this.queryAbortController = new AbortController();
    const abortSignal = this.queryAbortController.signal;

    // Abortable stream helper (from agent-singleton.ts)
    async function* abortableStream<T>(
      stream: AsyncIterable<T>,
      signal: AbortSignal,
    ): AsyncGenerator<T> {
      const iterator = stream[Symbol.asyncIterator]();
      const abortPromise = new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
      try {
        while (true) {
          const result = await Promise.race([iterator.next(), abortPromise]);
          if (result.done) break;
          yield result.value;
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          console.log('[agent] Stream aborted');
          return;
        }
        throw err;
      } finally {
        iterator.return?.();
      }
    }

    try {
      const rawStream = await this.currentAgent.stream(
        { messages },
        { streamMode: 'updates', recursionLimit: 50, signal: abortSignal },
      );

      for await (const chunk of abortableStream(rawStream, abortSignal)) {
        // Pause gate
        await this.waitIfPaused();

        if (abortSignal.aborted) {
          console.log('[agent] Query aborted, breaking stream');
          break;
        }

        // ── Agent messages (tool calls + text content) ──────────────
        if (chunk.agent?.messages) {
          for (const msg of chunk.agent.messages) {
            // Track tool calls
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
              console.log('[agent] tool calls', msg.tool_calls);
              for (const call of msg.tool_calls) {
                const toolName =
                  (call as any)?.name ??
                  (call as any)?.tool ??
                  (call as any)?.function?.name;

                if (toolName) {
                  const callId = (call as any)?.id || `step-${stepCounter}`;
                  const step: ToolStepEvent = {
                    stepIndex: stepCounter++,
                    toolName,
                    label: getToolDisplayLabel(toolName),
                    status: 'running',
                    startTime: Date.now(),
                  };
                  toolSteps.push(step);
                  pendingTools.set(callId, step);
                  this.emitToolSteps(toolSteps);
                }
              }
            }

            // Capture final text content (only from messages without tool calls)
            if (msg.content && typeof msg.content === 'string' && !msg.tool_calls?.length) {
              finalContent = msg.content;
              this.emitStreamText(msg.content);
            }
          }
        }

        // ── Tool completion messages ────────────────────────────────
        if (chunk.tools?.messages) {
          for (const toolMsg of chunk.tools.messages) {
            const toolCallId = (toolMsg as any)?.tool_call_id;
            const toolName = (toolMsg as any)?.name;
            const resultContent = typeof toolMsg.content === 'string' ? toolMsg.content : '';

            // Find matching pending step by callId or by name
            let step: ToolStepEvent | undefined;
            if (toolCallId && pendingTools.has(toolCallId)) {
              step = pendingTools.get(toolCallId);
              pendingTools.delete(toolCallId);
            } else {
              for (const [id, s] of pendingTools.entries()) {
                if (s.toolName === toolName && s.status === 'running') {
                  step = s;
                  pendingTools.delete(id);
                  break;
                }
              }
            }

            if (step) {
              step.status = 'completed';
              step.durationMs = Date.now() - step.startTime;
              step.description = getToolCompletionDescription(step.toolName, resultContent);
              this.emitToolSteps(toolSteps);
            }
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('[agent] Stream error:', err);
        finalContent = `Error: ${err.message ?? err}`;
      }
    }

    // Mark any remaining pending steps as completed
    for (const step of pendingTools.values()) {
      if (step.status === 'running') {
        step.status = 'completed';
        step.durationMs = Date.now() - step.startTime;
        step.description = getToolCompletionDescription(step.toolName);
      }
    }
    if (toolSteps.length > 0) {
      this.emitToolSteps(toolSteps);
    }

    // Cleanup
    this.queryAbortController = null;
    this.paused = false;
    this.pauseResolve = null;

    if (abortSignal.aborted) {
      return 'Agent turn was interrupted.';
    }

    return stripToolCallJson(finalContent) || 'No response from agent.';
  }

  // ─── Rebuild agent graph (mirrors agent-singleton.ts) ──────────────

  private rebuildAgent(): void {
    let llm: ChatOpenAIInstance;
    try {
      llm = getLlmSync();
    } catch {
      console.warn('[agent] LLM not ready — agent rebuild deferred');
      return;
    }

    // Merge builtin + all per-tab WebMCP tools + MCP server tools, filtering out disabled
    const allWebmcpTools: StructuredToolInterface[] = [];
    for (const entry of this.webmcpByTab.values()) {
      allWebmcpTools.push(...entry.tools);
    }
    const allMcpTools: StructuredToolInterface[] = [];
    for (const entry of this.mcpServers.values()) {
      if (entry.status === 'connected') {
        allMcpTools.push(...entry.langchainTools);
      }
    }
    const tools = [...this.builtinTools, ...allWebmcpTools, ...allMcpTools]
      .filter((t) => !this.disabledTools.has((t as any).name));
    console.log('[agent] Rebuilding agent graph with tools:', tools.map((t: any) => t.name));

    // Build dynamic system prompt that includes WebMCP tool info
    const prompt = this.buildSystemPrompt();

    this.currentAgent = createReactAgent({
      llm: llm as any,
      tools: tools as any,
      prompt,
    }) as unknown as ReactAgent;
  }

  /**
   * Build a system prompt that includes currently available WebMCP tools
   * so the LLM knows exactly what page tools it can call.
   */
  private buildSystemPrompt(): string {
    let prompt = SYSTEM_PROMPT;

    if (this.webmcpByTab.size > 0) {
      prompt += `\n\n**Available WebMCP page tools (across all tabs):**`;
      prompt += `\nThese are tools exposed by web pages. Call them directly by their full name (webmcp_t{tabId}_{toolName}).`;

      for (const [tabId, entry] of this.webmcpByTab.entries()) {
        const label = entry.title || entry.url || `tab ${tabId}`;
        prompt += `\n\n_Tab ${tabId} — ${label}:_`;
        for (const d of entry.descriptors) {
          const toolName = `webmcp_t${tabId}_${d.name}`;
          if (this.disabledTools.has(toolName)) continue;
          const schema = d.inputSchema
            ? ` — args: ${JSON.stringify(d.inputSchema.properties ?? {})}`
            : ' — no arguments';
          prompt += `\n- ${toolName}: ${d.description}${schema}`;
        }
      }

      prompt += `\n\nPrefer using these page tools directly instead of webmcp_invoke when the tool is listed above.`;
    }

    // Add MCP server tool info
    const connectedServers = [...this.mcpServers.values()].filter(s => s.status === 'connected');
    if (connectedServers.length > 0) {
      prompt += `\n\n**Available MCP server tools (remote HTTP servers):**`;
      prompt += `\nThese are tools provided by remote MCP servers. Call them directly by their full name (mcp_{serverId}_{toolName}).`;

      for (const server of connectedServers) {
        const safeId = server.id.replace(/[^a-zA-Z0-9]/g, '');
        prompt += `\n\n_MCP Server: ${server.name} (${server.url}):_`;
        for (const t of server.tools) {
          const toolName = `mcp_${safeId}_${t.name}`;
          if (this.disabledTools.has(toolName)) continue;
          const schema = t.inputSchema
            ? ` — args: ${JSON.stringify((t.inputSchema as any).properties ?? {})}`
            : ' — no arguments';
          prompt += `\n- ${toolName}: ${t.description}${schema}`;
        }
      }
    }

    return prompt;
  }
}

// ─── Singleton (mirrors agent-singleton.ts) ────────────────────────────────

let singletonAgent: Agent | null = null;

export function getOrCreateAgent(): Agent {
  if (singletonAgent == null) {
    singletonAgent = new Agent();
  }
  return singletonAgent;
}

export function getAgentApi(): AgentAPI {
  return getOrCreateAgent();
}

/**
 * Reset the agent — called after reconfigureLlm() so the next query
 * rebuilds everything with the new config.
 */
export function resetAgent(): void {
  resetLlm();
  if (singletonAgent) {
    (singletonAgent as any).currentAgent = null;
  }
  console.log('[agent] Agent reset — will re-initialise on next query');
}

/**
 * Configure LLM and rebuild the agent.
 */
export function configureAndRebuild(config: LLMConfigUnion): void {
  reconfigureLlm(config);
  resetAgent();
  // Eagerly try to rebuild
  void ensureLlm()
    .then(() => getOrCreateAgent())
    .catch((err) => console.warn('[agent] Config apply deferred:', err.message));
}
