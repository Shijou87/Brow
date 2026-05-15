// ─── LangGraph Agent ────────────────────────────────────────────────────────
// Replicates the proven architecture from agent-singleton.ts:
//  • Singleton Agent class with lazy LLM init
//  • Streaming via agent.stream() with updates mode
//  • AbortController + abortable stream generator
//  • Pause/resume support
//  • ToolStepEvent tracking with callId mapping
//  • Dynamic rebuildAgent()

import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { createReactAgent } from '@langchain/langgraph/prebuilt';

import { createBuiltinTools } from './agent-tools/builtin-tools';
import {
  buildBrowserContextSnapshotResult,
  buildWorkflowDemonstrationContext,
  stripToolCallJson,
  type BrowserContextSnapshotMetrics,
} from './agent-runtime/browser-context';
import { getEffectiveContextTabIds } from './agent-runtime/context-tab-selection';
import { buildSelectedSkillMentionContext, buildSystemPrompt } from './agent-runtime/prompt';
import {
  formatRequestContextDebugText,
  type RequestContextDebugEntry,
  type RequestContextDebugSnapshot,
  type RequestContextDebugTimings,
} from './agent-runtime/request-context-debug';
import {
  decodeLangGraphStreamChunk,
  extractAssistantMessageStreamText,
  extractLlmText,
} from './agent-runtime/live-stream';
import {
  buildRequestContextDebugSnapshot,
  createRequestBudgetRuntime,
  type AssembledQueryContext,
  type RequestBudgetEstimate,
} from './agent-runtime/request-budget-runtime';
import { buildApprovalAwaitingDescription } from './agent-runtime/approval-description';
import { wrapUntrustedContextBlock } from './agent-runtime/untrusted-context';
import { buildToolContextCarryForwardMessage } from './agent-runtime/tool-context-carry-forward';
import { createRepeatedToolFailureTracker } from './agent-runtime/repeated-tool-failure';
import { submitDomainSkillProposal } from './domain-skill-proposals';
import {
  buildDomainMemoryIndexContext,
  loadDomainMemoryEntries,
} from './domain-memory';
import {
  DEFAULT_DISABLED_TOOL_NAMES,
  buildToolManifest,
  getCategoryLabel,
  getToolCompletionDescription,
  getToolDisplayLabel,
  isApprovalGatedToolName,
  registerMCPToolDisplayLabels,
  registerWebMCPToolDisplayLabels,
  removeMCPToolDisplayLabels,
  type MCPToolState,
  type ToolManifestEntry,
  type WebMCPToolState,
} from './agent-runtime/tooling';
import {
  ensureLlm,
  getLlmSync,
  getRuntimeLlmConfig,
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
  type MCPAppRenderRequest,
  type MCPServerConfig,
  type MCPServerEntry,
} from './mcp-client';
import {
  formatDomainSkillMatcherSummary,
  matchesDomainSkillContext,
  type SkillRegistryEntry,
  normalizeSkillRegistry,
} from './skills-registry';
import { getInteractionSkillRegistry } from './interaction-skills';
import { tabsGetActive, tabsList } from './tab-tools';
import {
  DEFAULT_OPENAI_FIELDS,
  DEFAULT_AGENT_RECURSION_LIMIT,
  DEFAULT_SYSTEM_PROMPT,
  normalizeRecursionLimit,
} from '../shared/config';
import { logInfo } from '../shared/logger';
import type {
  ConversationCompactionState,
  InteractionSkillEntry,
  SkillMention,
  VLMConfig,
  WebMCPToolDescriptor,
  WorkflowDemonstration,
} from '../shared/types';
import type { DomainSkillProposalDraft } from '../shared/types';

export { DEFAULT_AGENT_RECURSION_LIMIT, DEFAULT_SYSTEM_PROMPT } from '../shared/config';
export { buildToolContextCarryForwardMessage } from './agent-runtime/tool-context-carry-forward';
export type { ToolManifestEntry } from './agent-runtime/tooling';
export type { RequestBudgetEstimate } from './agent-runtime/request-budget-runtime';

const AUTOMATION_TOOL_TIMEOUT_MS = 30_000;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ToolStepEvent {
  stepIndex: number;
  toolName: string;
  label: string;
  status: 'running' | 'awaiting_approval' | 'completed' | 'error';
  description?: string;
  durationMs?: number;
  startTime: number;
  inputText?: string;
  resultText?: string;
  errorText?: string;
  approvalRequestId?: string;
}

export type ToolStepCallback = (steps: ToolStepEvent[]) => void;
export type StreamTextCallback = (text: string) => void;
export type MCPAppRenderCallback = (request: MCPAppRenderRequest) => void;
export type AutomationApprovalDecision = 'allow' | 'allow_all' | 'skip';

type AgentMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export interface RequestBudgetCompactionEvent {
  before: RequestBudgetEstimate;
  after: RequestBudgetEstimate;
  compactionState: ConversationCompactionState;
}

export type RequestBudgetCompactionCallback = (event: RequestBudgetCompactionEvent) => void;

export interface AgentAPI {
  query: (
    query: string,
    history?: ChatTurn[],
    contextTabIds?: number[],
    workflowDemonstrations?: WorkflowDemonstration[],
    skillMention?: SkillMention | null,
  ) => Promise<string>;
  estimateRequestBudget: (
    query: string,
    history?: ChatTurn[],
    contextTabIds?: number[],
    workflowDemonstrations?: WorkflowDemonstration[],
    skillMention?: SkillMention | null,
  ) => Promise<RequestBudgetEstimate>;
  onRequestBudgetCompaction: (callback: RequestBudgetCompactionCallback) => void;
  offRequestBudgetCompaction: (callback: RequestBudgetCompactionCallback) => void;
  onToolStep: (callback: ToolStepCallback) => void;
  offToolStep: (callback: ToolStepCallback) => void;
  onStreamText: (callback: StreamTextCallback) => void;
  offStreamText: (callback: StreamTextCallback) => void;
  onMCPAppRender: (callback: MCPAppRenderCallback) => void;
  offMCPAppRender: (callback: MCPAppRenderCallback) => void;
  resolveAutomationApproval: (requestId: string, decision: AutomationApprovalDecision) => void;
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
  addMCPServer: (name: string, url: string, authToken?: string) => Promise<MCPServerEntry>;
  removeMCPServer: (id: string) => void;
  reconnectMCPServer: (id: string) => Promise<MCPServerEntry>;
  getMCPServers: () => MCPServerEntry[];
  restoreMCPServers: () => Promise<void>;
  setVLMConfig: (config: VLMConfig) => void;
  getVLMConfig: () => VLMConfig | null;
  setRecursionLimit: (limit: number) => void;
  getRecursionLimit: () => number;
  setSystemPrompt: (prompt: string) => void;
  getSystemPrompt: () => string;
  setSkillRegistry: (skills: SkillRegistryEntry[]) => void;
  getSkillRegistry: () => SkillRegistryEntry[];
  setConversationCompactionState: (state: ConversationCompactionState | null) => void;
  getConversationCompactionState: () => ConversationCompactionState | null;
  getLastTurnToolContextMessage: () => string | null;
  getActiveRequestContextDebugText: () => string | null;
  buildRequestContextDebugText: (
    query: string,
    history?: ChatTurn[],
    contextTabIds?: number[],
    workflowDemonstrations?: WorkflowDemonstration[],
    skillMention?: SkillMention | null,
  ) => Promise<string>;
}

type ReactAgent = {
  stream: (input: any, config?: any) => AsyncIterable<any> | Promise<AsyncIterable<any>>;
};

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function truncateText(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatToolPayload(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = tryParseJson(trimmed);
    if (parsed !== undefined) return JSON.stringify(parsed, null, 2);
    return trimmed;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatActiveDebugMessageContent(message: any): string | null {
  const sections: string[] = [];
  const content = formatToolPayload(message?.content)?.trim();
  if (content) sections.push(content);

  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    const calls = message.tool_calls.map((call: any) => ({
      id: call?.id,
      name: call?.name ?? call?.tool ?? call?.function?.name,
      input: extractToolCallInput(call),
    }));
    sections.push(`tool_calls:\n${JSON.stringify(calls, null, 2)}`);
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

function formatToolDebugMessageContent(toolMessage: any): string | null {
  const parts: string[] = [];
  if (toolMessage?.name) parts.push(`Tool: ${toolMessage.name}`);
  if (toolMessage?.tool_call_id) parts.push(`Tool call id: ${toolMessage.tool_call_id}`);
  const payload = formatToolPayload(toolMessage?.content)?.trim();
  if (payload) parts.push(payload);
  return parts.length > 0 ? parts.join('\n') : null;
}

function extractToolCallInput(call: unknown): string | undefined {
  const rawArgs =
    (call as any)?.args ??
    (call as any)?.arguments ??
    (call as any)?.function?.arguments;
  return formatToolPayload(rawArgs);
}

function extractErrorText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'object' && typeof (value as any).message === 'string') {
    return ((value as any).message as string).trim() || undefined;
  }
  const serialized = formatToolPayload(value);
  return serialized?.trim() || undefined;
}

function analyzeToolOutcome(
  toolName: string,
  rawContent: unknown,
): Pick<ToolStepEvent, 'status' | 'description' | 'resultText' | 'errorText'> {
  const resultText = formatToolPayload(rawContent);
  if (!resultText) {
    return {
      status: 'completed',
      description: getToolCompletionDescription(toolName),
    };
  }

  const parsed = tryParseJson(resultText);
  let errorText: string | undefined;

  if (parsed && typeof parsed === 'object') {
    const payload = parsed as any;
    if (payload.ok === false || payload.success === false || payload.error) {
      errorText =
        extractErrorText(payload.error)
        ?? ((payload.ok === false || payload.success === false)
          ? extractErrorText(payload.message)
          : undefined);
    }
  }

  if (!errorText && /^error\b[:\s-]/i.test(resultText)) {
    errorText = resultText;
  }

  if (errorText) {
    return {
      status: 'error',
      description: truncateText(errorText),
      resultText,
      errorText,
    };
  }

  return {
    status: 'completed',
    description: getToolCompletionDescription(toolName, resultText),
    resultText,
  };
}

// ─── Agent Class (mirrors Agent from agent-singleton.ts) ───────────────────

export class Agent implements AgentAPI {
  private currentAgent: ReactAgent | null = null;
  private readonly builtinTools: StructuredToolInterface[];
  private webmcpByTab = new Map<number, WebMCPToolState>();
  private mcpServers = new Map<string, MCPToolState>();
  private disabledTools = new Set<string>(DEFAULT_DISABLED_TOOL_NAMES);
  private vlmConfig: VLMConfig | null = null;
  private toolStepCallbacks: ToolStepCallback[] = [];
  private streamTextCallbacks: StreamTextCallback[] = [];
  private mcpAppRenderCallbacks: MCPAppRenderCallback[] = [];
  private requestBudgetCompactionCallbacks: RequestBudgetCompactionCallback[] = [];
  private queryAbortController: AbortController | null = null;
  private paused = false;
  private pauseResolve: (() => void) | null = null;
  private recursionLimit = DEFAULT_AGENT_RECURSION_LIMIT;
  private systemPrompt = DEFAULT_SYSTEM_PROMPT;
  private domainSkillRegistry: SkillRegistryEntry[] = [];
  private interactionSkillRegistry: InteractionSkillEntry[] = getInteractionSkillRegistry();
  private activeToolSteps: ToolStepEvent[] = [];
  private activePendingTools = new Map<string, ToolStepEvent>();
  private pendingAutomationApprovals = new Map<string, {
    resolve: (decision: AutomationApprovalDecision) => void;
    stepIndex?: number;
  }>();
  private allowAutomationForSession = false;
  private conversationCompactionState: ConversationCompactionState | null = null;
  private lastTurnToolContextMessage: string | null = null;
  private activeRequestContextDebugSnapshot: RequestContextDebugSnapshot | null = null;
  private compiledSystemPromptCache: string | null = null;
  private readonly requestBudgetRuntime: ReturnType<typeof createRequestBudgetRuntime>;

  private appendActiveRequestDebugEntry(roleLabel: string, content: string): void {
    if (!this.activeRequestContextDebugSnapshot) return;
    const trimmed = content.trim();
    if (!trimmed) return;
    const liveUpdates = this.activeRequestContextDebugSnapshot.liveUpdates ?? [];
    const previous = liveUpdates[liveUpdates.length - 1];
    if (previous?.content === trimmed && previous.label.endsWith(roleLabel)) return;
    liveUpdates.push({
      label: `[LIVE ${liveUpdates.length + 1}] ${roleLabel}`,
      content: trimmed,
    });
    this.activeRequestContextDebugSnapshot.liveUpdates = liveUpdates;
  }

  private mergeActiveRequestDebugTimings(partial: Partial<RequestContextDebugTimings>): void {
    if (!this.activeRequestContextDebugSnapshot) return;
    this.activeRequestContextDebugSnapshot.timings = {
      ...(this.activeRequestContextDebugSnapshot.timings ?? {}),
      ...partial,
    };
  }

  private buildCompiledSystemPrompt(): string {
    if (this.compiledSystemPromptCache) {
      return this.compiledSystemPromptCache;
    }

    this.compiledSystemPromptCache = buildSystemPrompt({
      basePrompt: this.systemPrompt,
      domainSkillRegistry: this.domainSkillRegistry,
      interactionSkillRegistry: this.interactionSkillRegistry,
      disabledTools: this.disabledTools,
      webmcpByTab: this.webmcpByTab,
      mcpServers: this.mcpServers.values(),
    });

    return this.compiledSystemPromptCache;
  }

  private invalidateCompiledSystemPrompt(): void {
    this.compiledSystemPromptCache = null;
  }

  private getConfiguredContextWindow(): number {
    return getRuntimeLlmConfig()?.contextWindow ?? DEFAULT_OPENAI_FIELDS.contextWindow;
  }

  private emitRequestBudgetCompaction(event: RequestBudgetCompactionEvent): void {
    for (const callback of this.requestBudgetCompactionCallbacks) {
      callback(event);
    }
  }

  constructor() {
    this.builtinTools = createBuiltinTools({
      getVLMConfig: () => this.vlmConfig,
      findSkill: (identifier) => this.findSkill(identifier),
      submitDomainSkillProposal: (draft) => this.submitDomainSkillProposal(draft),
    }).map((builtinTool) => this.wrapAutomationToolWithApproval(builtinTool));
    this.requestBudgetRuntime = createRequestBudgetRuntime({
      getConfiguredContextWindow: () => this.getConfiguredContextWindow(),
      getConversationCompactionState: () => this.getConversationCompactionState(),
      setConversationCompactionState: (state) => this.setConversationCompactionState(state),
      emitRequestBudgetCompaction: (event) => this.emitRequestBudgetCompaction(event),
      buildCompiledSystemPrompt: () => this.buildCompiledSystemPrompt(),
      buildMatchedDomainSkillContext: (contextTabIds) => this.buildMatchedDomainSkillContext(contextTabIds),
      buildMatchedDomainMemoryContext: (contextTabIds) => this.buildMatchedDomainMemoryContext(contextTabIds),
      generateCompactionSummary: (history, compactedTurnCount, existingSummary) => (
        this.generateCompactionSummaryFromLlm(history, compactedTurnCount, existingSummary)
      ),
    });

    void ensureLlm()
      .then(() => this.rebuildAgent())
      .catch((err) => console.warn('[agent] LLM not yet configured:', err.message));
  }

  private async generateCompactionSummaryFromLlm(
    history: ChatTurn[],
    compactedTurnCount: number,
    existingSummary?: string,
  ): Promise<string> {
    const llm = await ensureLlm();
    const transcript = history
      .slice(0, compactedTurnCount)
      .map((turn, index) => `Turn ${index + 1} (${turn.role}):\n${turn.content}`)
      .join('\n\n');
    const response = await (llm as any).invoke([
      {
        role: 'system',
        content: [
          'You are compacting earlier conversation turns for a browser automation agent.',
          'Produce a concise running summary for future turns.',
          'Preserve durable user goals, chosen constraints, important browser findings, workflow-demonstration facts, completed decisions, and unresolved work.',
          'Omit filler, politeness, and token-budget discussion.',
          'Respond with short bullet lines only.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          existingSummary
            ? `Existing running summary:\n${existingSummary}`
            : 'There is no existing running summary yet.',
          `Update the running summary so it accurately replaces the first ${compactedTurnCount} chat turns.`,
          'Conversation to compact:',
          transcript,
        ].join('\n\n'),
      },
    ]);
    const summary = extractLlmText(response).trim();
    if (!summary) {
      throw new Error('Compaction summary was empty.');
    }
    return summary;
  }

  updateWebMCPTools(tabId: number, descriptors: WebMCPToolDescriptor[], url?: string, title?: string): void {
    const tools = createWebMCPTools(tabId, descriptors)
      .map((webmcpTool) => this.wrapAutomationToolWithApproval(webmcpTool));
    this.webmcpByTab.set(tabId, { descriptors, tools, url, title });
    registerWebMCPToolDisplayLabels(tabId, descriptors);
    console.log('[agent] WebMCP tools updated for tab', tabId, ':', descriptors.map((tool) => tool.name));
    this.invalidateCompiledSystemPrompt();
    this.rebuildAgent();
  }

  removeWebMCPToolsForTab(tabId: number): void {
    if (!this.webmcpByTab.has(tabId)) return;
    this.webmcpByTab.delete(tabId);
    console.log('[agent] Removed WebMCP tools for tab', tabId);
    this.invalidateCompiledSystemPrompt();
    this.rebuildAgent();
  }

  clearWebMCPTools(): void {
    this.webmcpByTab.clear();
    this.invalidateCompiledSystemPrompt();
    this.rebuildAgent();
  }

  getToolManifest(): ToolManifestEntry[] {
    return buildToolManifest(
      this.builtinTools,
      this.webmcpByTab,
      this.mcpServers,
      this.disabledTools,
    );
  }

  static getCategoryLabel(category: string): string {
    return getCategoryLabel(category);
  }

  setToolEnabled(toolName: string, enabled: boolean): void {
    if (enabled) this.disabledTools.delete(toolName);
    else this.disabledTools.add(toolName);
    this.invalidateCompiledSystemPrompt();
    this.rebuildAgent();
  }

  setToolsEnabled(toolNames: string[], enabled: boolean): void {
    for (const toolName of toolNames) {
      if (enabled) this.disabledTools.delete(toolName);
      else this.disabledTools.add(toolName);
    }
    this.invalidateCompiledSystemPrompt();
    this.rebuildAgent();
  }

  getDisabledTools(): string[] {
    return [...this.disabledTools];
  }

  setDisabledTools(names: string[]): void {
    this.disabledTools = new Set(names);
    this.invalidateCompiledSystemPrompt();
    this.rebuildAgent();
  }

  async addMCPServer(name: string, url: string, authToken?: string): Promise<MCPServerEntry> {
    const config: MCPServerConfig = { id: generateServerId(), name, url, authToken };
    const entry: MCPToolState = {
      ...config,
      status: 'connecting',
      tools: [],
      langchainTools: [],
    };
    this.mcpServers.set(config.id, entry);

    try {
      const tools = await mcpConnect(config);
      entry.status = 'connected';
      entry.sessionId = config.sessionId;
      entry.tools = tools;
      entry.langchainTools = createMCPServerTools(config, tools, {
        onAppToolResult: (request) => this.emitMCPAppRender(request),
      });
      registerMCPToolDisplayLabels(config.id, config.name, tools);
      this.invalidateCompiledSystemPrompt();
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
    if (!entry) return;

    removeMCPToolDisplayLabels(id, entry.tools);
    this.mcpServers.delete(id);
    this.invalidateCompiledSystemPrompt();
    this.rebuildAgent();
    this.persistMCPServers();
    console.log(`[agent] MCP server "${entry.name}" removed`);
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
      entry.sessionId = config.sessionId;
      entry.tools = tools;
      entry.langchainTools = createMCPServerTools(config, tools, {
        onAppToolResult: (request) => this.emitMCPAppRender(request),
      });
      registerMCPToolDisplayLabels(id, entry.name, tools);
      this.invalidateCompiledSystemPrompt();
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
      if (this.mcpServers.has(config.id)) continue;
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

  setVLMConfig(config: VLMConfig): void {
    this.vlmConfig = config;
    console.log('[agent] VLM config set:', config.model, '@', config.baseUrl);
  }

  getVLMConfig(): VLMConfig | null {
    return this.vlmConfig;
  }

  setRecursionLimit(limit: number): void {
    this.recursionLimit = normalizeRecursionLimit(limit);
    console.log('[agent] Recursion limit set to', this.recursionLimit);
  }

  getRecursionLimit(): number {
    return this.recursionLimit;
  }

  setSystemPrompt(prompt: string): void {
    const normalized = prompt.trim() || DEFAULT_SYSTEM_PROMPT;
    this.systemPrompt = normalized;
    this.invalidateCompiledSystemPrompt();
    if (this.currentAgent) {
      this.rebuildAgent();
    }
    console.log('[agent] System prompt updated');
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  setSkillRegistry(skills: SkillRegistryEntry[]): void {
    this.domainSkillRegistry = normalizeSkillRegistry(skills);
    this.invalidateCompiledSystemPrompt();
    if (this.currentAgent) {
      this.rebuildAgent();
    }
    console.log('[agent] Domain skill registry updated:', this.domainSkillRegistry.length, 'skills');
  }

  getSkillRegistry(): SkillRegistryEntry[] {
    return [...this.domainSkillRegistry];
  }

  setConversationCompactionState(state: ConversationCompactionState | null): void {
    if (!state?.summary.trim() || state.compactedTurnCount <= 0) {
      this.conversationCompactionState = null;
      return;
    }

    this.conversationCompactionState = {
      summary: state.summary,
      compactedTurnCount: Math.max(0, Math.floor(state.compactedTurnCount)),
      updatedAt: state.updatedAt,
    };
  }

  getConversationCompactionState(): ConversationCompactionState | null {
    return this.conversationCompactionState
      ? { ...this.conversationCompactionState }
      : null;
  }

  getLastTurnToolContextMessage(): string | null {
    return this.lastTurnToolContextMessage;
  }

  getActiveRequestContextDebugText(): string | null {
    return this.activeRequestContextDebugSnapshot
      ? formatRequestContextDebugText(this.activeRequestContextDebugSnapshot)
      : null;
  }

  async buildRequestContextDebugText(
    query: string,
    history: ChatTurn[] = [],
    contextTabIds?: number[],
    workflowDemonstrations: WorkflowDemonstration[] = [],
    skillMention: SkillMention | null = null,
  ): Promise<string> {
    return await this.requestBudgetRuntime.buildRequestContextDebugText(
      query,
      history,
      contextTabIds,
      workflowDemonstrations,
      skillMention,
    );
  }

  findSkill(identifier: string): SkillRegistryEntry | InteractionSkillEntry | null {
    const normalized = identifier.trim().toLowerCase();
    if (!normalized) return null;
    return this.domainSkillRegistry.find((skill) =>
      skill.slug.toLowerCase() === normalized || skill.name.toLowerCase() === normalized,
    ) ?? this.interactionSkillRegistry.find((skill) =>
      skill.slug.toLowerCase() === normalized || skill.name.toLowerCase() === normalized,
    ) ?? null;
  }

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

  onMCPAppRender(callback: MCPAppRenderCallback): void {
    this.mcpAppRenderCallbacks.push(callback);
  }

  offMCPAppRender(callback: MCPAppRenderCallback): void {
    this.mcpAppRenderCallbacks = this.mcpAppRenderCallbacks.filter((cb) => cb !== callback);
  }

  onRequestBudgetCompaction(callback: RequestBudgetCompactionCallback): void {
    this.requestBudgetCompactionCallbacks.push(callback);
  }

  offRequestBudgetCompaction(callback: RequestBudgetCompactionCallback): void {
    this.requestBudgetCompactionCallbacks = this.requestBudgetCompactionCallbacks.filter((cb) => cb !== callback);
  }

  resolveAutomationApproval(requestId: string, decision: AutomationApprovalDecision): void {
    if (decision === 'allow_all') {
      this.allowAutomationForSession = true;
      for (const [pendingId, pending] of this.pendingAutomationApprovals.entries()) {
        this.pendingAutomationApprovals.delete(pendingId);
        const step = pending.stepIndex == null
          ? undefined
          : this.activeToolSteps.find((entry) => entry.stepIndex === pending.stepIndex);
        if (step) {
          step.approvalRequestId = undefined;
          step.status = 'running';
          step.description = pendingId === requestId
            ? 'Approval granted. All approval-gated actions allowed for this session.'
            : 'Approval granted by session-wide allow. Executing action…';
        }
        pending.resolve(pendingId === requestId ? 'allow_all' : 'allow');
      }
      this.emitToolSteps(this.activeToolSteps);
      return;
    }

    const pending = this.pendingAutomationApprovals.get(requestId);
    if (!pending) return;
    this.pendingAutomationApprovals.delete(requestId);

    const step = pending.stepIndex == null
      ? undefined
      : this.activeToolSteps.find((entry) => entry.stepIndex === pending.stepIndex);
    if (step) {
      step.approvalRequestId = undefined;
      step.status = 'running';
      step.description = decision === 'skip'
        ? 'Skipping action…'
        : 'Approval granted. Executing action…';
      this.emitToolSteps(this.activeToolSteps);
    }

    pending.resolve(decision);
  }

  private emitToolSteps(steps: ToolStepEvent[]): void {
    for (const callback of this.toolStepCallbacks) {
      try {
        callback([...steps]);
      } catch (err) {
        console.warn('[agent] toolStep callback error', err);
      }
    }
  }

  private emitStreamText(text: string): void {
    for (const callback of this.streamTextCallbacks) {
      try {
        callback(text);
      } catch (err) {
        console.warn('[agent] streamText callback error', err);
      }
    }
  }

  private emitMCPAppRender(request: MCPAppRenderRequest): void {
    for (const callback of this.mcpAppRenderCallbacks) {
      try {
        callback(request);
      } catch (err) {
        console.warn('[agent] MCP App render callback error', err);
      }
    }
  }

  private isAutomationTool(tool: StructuredToolInterface): boolean {
    const name = (tool as any).name as string;
    const aliasOf = (tool as any).__aliasOf as string | undefined;
    return isApprovalGatedToolName(aliasOf ?? name);
  }

  private wrapAutomationToolWithApproval(originalTool: StructuredToolInterface): StructuredToolInterface {
    if (!this.isAutomationTool(originalTool)) return originalTool;

    const wrapped = tool(
      async (input: unknown) => {
        const toolName = (originalTool as any).name as string;
        const decision = await this.waitForAutomationApproval(toolName, input);
        if (decision === 'skip') {
          return JSON.stringify({
            ok: false,
            error: 'Approval-gated action skipped by user.',
            skippedByUser: true,
          }, null, 2);
        }
        return await this.invokeAutomationToolWithTimeout(originalTool, input, toolName);
      },
      {
        name: (originalTool as any).name as string,
        description: (originalTool as any).description ?? '',
        schema: (originalTool as any).schema,
      },
    ) as unknown as StructuredToolInterface;

    if ((originalTool as any).__hidden) {
      (wrapped as any).__hidden = true;
    }
    if ((originalTool as any).__aliasOf) {
      (wrapped as any).__aliasOf = (originalTool as any).__aliasOf;
    }

    return wrapped;
  }

  private async invokeAutomationToolWithTimeout(
    originalTool: StructuredToolInterface,
    input: unknown,
    toolName: string,
  ): Promise<unknown> {
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = new Promise<string>((resolve) => {
      timeoutId = globalThis.setTimeout(() => {
        resolve(JSON.stringify({
          ok: false,
          timedOut: true,
          timeoutMs: AUTOMATION_TOOL_TIMEOUT_MS,
          error: `Automation tool "${toolName}" timed out after ${AUTOMATION_TOOL_TIMEOUT_MS}ms. Stop waiting on this call, take a fresh browser_snapshot if needed, and try a smaller or more explicit action.`,
        }, null, 2));
      }, AUTOMATION_TOOL_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        (originalTool as any).invoke(input),
        timeout,
      ]);
    } finally {
      if (timeoutId !== undefined) {
        globalThis.clearTimeout(timeoutId);
      }
    }
  }

  abort(): void {
    console.log('[agent] Abort requested');
    this.clearPendingAutomationApprovals('skip');
    if (this.queryAbortController) {
      this.queryAbortController.abort();
      this.queryAbortController = null;
    }
  }

  isBusy(): boolean {
    return this.queryAbortController !== null;
  }

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

  private isToolEnabled(tool: StructuredToolInterface): boolean {
    if ((tool as any).__hidden) return false;
    const name = (tool as any).name as string;
    const aliasOf = (tool as any).__aliasOf as string | undefined;
    if (this.disabledTools.has(name)) return false;
    if (aliasOf && this.disabledTools.has(aliasOf)) return false;
    return true;
  }

  private async waitForAutomationApproval(
    toolName: string,
    input: unknown,
  ): Promise<'allow' | 'skip'> {
    if (this.allowAutomationForSession) return 'allow';
    if (!this.queryAbortController || this.queryAbortController.signal.aborted) return 'allow';

    const inputText = formatToolPayload(input);
    const step = this.activeToolSteps.find((entry) =>
      entry.toolName === toolName
      && entry.status === 'running'
      && !entry.approvalRequestId
      && (
        (inputText && entry.inputText === inputText)
        || (!inputText && !entry.inputText)
      ),
    ) ?? this.activeToolSteps.find((entry) =>
      entry.toolName === toolName
      && entry.status === 'running'
      && !entry.approvalRequestId,
    );

    if (!step) return 'allow';

    const requestId =
      globalThis.crypto?.randomUUID?.()
      ?? `approval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    step.status = 'awaiting_approval';
    step.description = buildApprovalAwaitingDescription({
      toolName,
      input,
      vlmBaseUrl: this.vlmConfig?.baseUrl,
    });
    step.approvalRequestId = requestId;
    this.emitToolSteps(this.activeToolSteps);

    const decision = await new Promise<AutomationApprovalDecision>((resolve) => {
      this.pendingAutomationApprovals.set(requestId, {
        resolve,
        stepIndex: step.stepIndex,
      });
    });

    if (decision === 'allow_all') {
      this.allowAutomationForSession = true;
      return 'allow';
    }
    return decision === 'skip' ? 'skip' : 'allow';
  }

  private clearPendingAutomationApprovals(decision: AutomationApprovalDecision): void {
    for (const [requestId, pending] of this.pendingAutomationApprovals.entries()) {
      this.pendingAutomationApprovals.delete(requestId);
      pending.resolve(decision);
    }
  }

  private waitIfPaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
  }

  private async submitDomainSkillProposal(draft: DomainSkillProposalDraft) {
    return submitDomainSkillProposal(draft);
  }

  private async buildMatchedDomainSkillContext(contextTabIds?: number[]): Promise<string> {
    const [tabs, activeTab] = await Promise.all([
      tabsList().catch(() => []),
      tabsGetActive().catch(() => null),
    ]);

    const selectedTabIds = getEffectiveContextTabIds(contextTabIds, activeTab?.tabId);
    if (selectedTabIds.length === 0) return '';

    const tabsById = new Map<number, (typeof tabs)[number]>();
    for (const tab of tabs) {
      tabsById.set(tab.tabId, tab);
    }

    const selectedTabs = selectedTabIds
      .map((tabId) => tabsById.get(tabId) ?? (activeTab?.tabId === tabId ? activeTab : undefined))
      .filter((tab): tab is NonNullable<typeof activeTab> => Boolean(tab));

    if (selectedTabs.length === 0) return '';

    const matchedSkills = this.domainSkillRegistry.filter((skill) =>
      skill.enabled && selectedTabs.some((tab) => matchesDomainSkillContext(skill, {
        url: tab.url,
        title: tab.title,
      })),
    );

    if (matchedSkills.length === 0) return '';

    return [
      'Matched Domain Skills for the selected browser context:',
      ...matchedSkills.map((skill) => {
        const description = skill.description || 'No description provided.';
        const tags = skill.tags.length > 0 ? ` — tags: ${skill.tags.join(', ')}` : '';
        const matcher = formatDomainSkillMatcherSummary(skill.matcher);
        const scope = matcher ? ` — scope: ${matcher}` : '';
        return `- ${skill.name} (slug: ${skill.slug}) — ${description}${tags}${scope}`;
      }),
      'If one of these matched Domain Skills seems relevant, call skills_load with its slug or name before relying on the full guidance.',
    ].join('\n');
  }

  private async buildMatchedDomainMemoryContext(contextTabIds?: number[]): Promise<string> {
    const [tabs, activeTab, domainMemory] = await Promise.all([
      tabsList().catch(() => []),
      tabsGetActive().catch(() => null),
      loadDomainMemoryEntries().catch(() => []),
    ]);

    const selectedTabIds = getEffectiveContextTabIds(contextTabIds, activeTab?.tabId);
    if (selectedTabIds.length === 0) return '';

    const tabsById = new Map<number, (typeof tabs)[number]>();
    for (const tab of tabs) {
      tabsById.set(tab.tabId, tab);
    }

    const selectedTabs = selectedTabIds
      .map((tabId) => tabsById.get(tabId) ?? (activeTab?.tabId === tabId ? activeTab : undefined))
      .filter((tab): tab is NonNullable<typeof activeTab> => Boolean(tab));

    if (selectedTabs.length === 0) return '';

    return buildDomainMemoryIndexContext(domainMemory, selectedTabs.map((tab) => ({
      url: tab.url,
      title: tab.title,
    })));
  }

  async query(
    userQuery: string,
    history: ChatTurn[] = [],
    contextTabIds?: number[],
    workflowDemonstrations: WorkflowDemonstration[] = [],
    skillMention: SkillMention | null = null,
  ): Promise<string> {
    const turnStartedAt = Date.now();

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

    const compactionStartedAt = Date.now();
    await this.requestBudgetRuntime.compactConversationIfNeeded(
      userQuery,
      history,
      contextTabIds,
      workflowDemonstrations,
      skillMention,
    );
    const compactionMs = Date.now() - compactionStartedAt;

    const requestAssemblyStartedAt = Date.now();
    const assembled = await this.requestBudgetRuntime.assembleQueryContext(
      userQuery,
      history,
      contextTabIds,
      workflowDemonstrations,
      skillMention,
    );
    const requestAssemblyMs = Date.now() - requestAssemblyStartedAt;
    const messages = assembled.messages;
    let finalContent = '';

    this.activeRequestContextDebugSnapshot = buildRequestContextDebugSnapshot({
      query: userQuery,
      history,
      assembled,
      contextWindow: this.getConfiguredContextWindow(),
      timings: {
        compactionMs,
        requestAssemblyMs,
      },
      liveUpdates: [],
    });

    this.lastTurnToolContextMessage = null;
    this.activeToolSteps = [];
    this.activePendingTools = new Map<string, ToolStepEvent>();
    this.clearPendingAutomationApprovals('skip');
    const toolSteps = this.activeToolSteps;
    const pendingTools = this.activePendingTools;
    let stepCounter = 0;
    let repeatedToolFailureMessage: string | undefined;
    const repeatedToolFailures = createRepeatedToolFailureTracker();

    this.queryAbortController = new AbortController();
    const abortController = this.queryAbortController;
    const abortSignal = abortController.signal;
    const agentStreamStartedAt = Date.now();
    let firstAgentUpdateMs: number | undefined;
    let firstToolCallMs: number | undefined;
    let firstAssistantTextMs: number | undefined;
    let firstToolStartedAt: number | undefined;
    let lastToolCompletedAt: number | undefined;
    let streamedAssistantText = '';

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
        { streamMode: ['updates', 'messages'], recursionLimit: this.recursionLimit, signal: abortSignal },
      );

      for await (const rawChunk of abortableStream(rawStream, abortSignal)) {
        await this.waitIfPaused();

        if (firstAgentUpdateMs == null) {
          firstAgentUpdateMs = Date.now() - agentStreamStartedAt;
          this.mergeActiveRequestDebugTimings({ firstAgentUpdateMs });
        }

        if (abortSignal.aborted) {
          console.log('[agent] Query aborted, breaking stream');
          break;
        }

        const { mode, payload } = decodeLangGraphStreamChunk(rawChunk);

        if (mode === 'messages') {
          const assistantTextDelta = extractAssistantMessageStreamText(payload);
          if (assistantTextDelta) {
            if (firstAssistantTextMs == null) {
              firstAssistantTextMs = Date.now() - agentStreamStartedAt;
              this.mergeActiveRequestDebugTimings({ firstAssistantTextMs });
            }
            streamedAssistantText += assistantTextDelta;
            this.emitStreamText(streamedAssistantText);
          }
          continue;
        }

        const chunk = payload as any;
        if (chunk.agent?.messages) {
          for (const message of chunk.agent.messages) {
            const debugContent = formatActiveDebugMessageContent(message);
            if (debugContent) {
              const roleLabel = typeof (message as any)?.role === 'string'
                ? String((message as any).role).toUpperCase()
                : 'ASSISTANT';
              this.appendActiveRequestDebugEntry(roleLabel, debugContent);
            }

            if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
              console.log('[agent] tool calls', message.tool_calls);
              for (const call of message.tool_calls) {
                const toolName =
                  (call as any)?.name ??
                  (call as any)?.tool ??
                  (call as any)?.function?.name;

                if (!toolName) continue;

                const callId = (call as any)?.id || `step-${stepCounter}`;
                const step: ToolStepEvent = {
                  stepIndex: stepCounter++,
                  toolName,
                  label: getToolDisplayLabel(toolName),
                  status: 'running',
                  startTime: Date.now(),
                  inputText: extractToolCallInput(call),
                };
                if (firstToolCallMs == null) {
                  firstToolCallMs = step.startTime - agentStreamStartedAt;
                  this.mergeActiveRequestDebugTimings({ firstToolCallMs });
                }
                if (firstToolStartedAt == null) {
                  firstToolStartedAt = step.startTime;
                }
                toolSteps.push(step);
                pendingTools.set(callId, step);
                this.emitToolSteps(toolSteps);
              }
            }

            const assistantMessageText = extractLlmText(message.content);
            if (assistantMessageText && !message.tool_calls?.length) {
              if (firstAssistantTextMs == null) {
                firstAssistantTextMs = Date.now() - agentStreamStartedAt;
                this.mergeActiveRequestDebugTimings({ firstAssistantTextMs });
              }
              finalContent = assistantMessageText;
            }
          }
        }

        if (chunk.tools?.messages) {
          for (const toolMessage of chunk.tools.messages) {
            const debugContent = formatToolDebugMessageContent(toolMessage);
            if (debugContent) {
              this.appendActiveRequestDebugEntry('TOOL', debugContent);
            }

            const toolCallId = (toolMessage as any)?.tool_call_id;
            const toolName = (toolMessage as any)?.name;
            const resultContent = (toolMessage as any)?.content;

            let step: ToolStepEvent | undefined;
            if (toolCallId && pendingTools.has(toolCallId)) {
              step = pendingTools.get(toolCallId);
              pendingTools.delete(toolCallId);
            } else {
              for (const [id, pendingStep] of pendingTools.entries()) {
                if (pendingStep.toolName === toolName && pendingStep.status === 'running') {
                  step = pendingStep;
                  pendingTools.delete(id);
                  break;
                }
              }
            }

            if (step) {
              const outcome = analyzeToolOutcome(step.toolName, resultContent);
              step.status = outcome.status;
              step.durationMs = Date.now() - step.startTime;
              lastToolCompletedAt = step.startTime + step.durationMs;
              step.description = outcome.description;
              step.resultText = outcome.resultText;
              step.errorText = outcome.errorText;
              this.emitToolSteps(toolSteps);
              if (outcome.status === 'error') {
                const failureDecision = repeatedToolFailures.recordFailure({
                  toolName: step.toolName,
                  inputText: step.inputText,
                  errorText: outcome.errorText,
                  description: outcome.description,
                });
                if (failureDecision.shouldAbort && !abortSignal.aborted) {
                  repeatedToolFailureMessage = failureDecision.message;
                  abortController.abort();
                }
              } else {
                repeatedToolFailures.reset();
              }
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

    for (const step of pendingTools.values()) {
      if (step.status === 'running' || step.status === 'awaiting_approval') {
        const errorText = abortSignal.aborted
          ? 'Tool execution was interrupted before a result was received.'
          : step.status === 'awaiting_approval'
            ? 'Automation action was never approved.'
            : 'Tool finished without returning a result.';
        step.status = 'error';
        step.durationMs = Date.now() - step.startTime;
        step.description = truncateText(errorText);
        step.errorText = errorText;
        step.approvalRequestId = undefined;
      }
    }
    if (toolSteps.length > 0) {
      this.emitToolSteps(toolSteps);
    }

    const turnFinishedAt = Date.now();
    const totalToolDurationMs = toolSteps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
    const toolWallTimeMs = firstToolStartedAt != null && lastToolCompletedAt != null
      ? Math.max(0, lastToolCompletedAt - firstToolStartedAt)
      : undefined;
    const postToolFollowUpMs = lastToolCompletedAt != null
      ? Math.max(0, turnFinishedAt - lastToolCompletedAt)
      : undefined;
    const finalTimings: RequestContextDebugTimings = {
      compactionMs,
      requestAssemblyMs,
      firstAgentUpdateMs,
      firstToolCallMs,
      firstAssistantTextMs,
      agentStreamMs: turnFinishedAt - agentStreamStartedAt,
      toolCount: toolSteps.length,
      totalToolDurationMs,
      toolWallTimeMs,
      postToolFollowUpMs,
      turnTotalMs: turnFinishedAt - turnStartedAt,
    };
    this.mergeActiveRequestDebugTimings(finalTimings);

    if (this.activeRequestContextDebugSnapshot?.requestShape) {
      const shape = this.activeRequestContextDebugSnapshot.requestShape;
      logInfo(
        'agent-turn',
        `tokens=${this.activeRequestContextDebugSnapshot.estimatedTokens} turn=${finalTimings.turnTotalMs ?? 0}ms assembly=${requestAssemblyMs}ms firstUpdate=${firstAgentUpdateMs ?? 'n/a'}ms stream=${finalTimings.agentStreamMs ?? 0}ms tools=${toolSteps.length} toolTotal=${totalToolDurationMs}ms toolWall=${toolWallTimeMs ?? 'n/a'}ms postTool=${postToolFollowUpMs ?? 'n/a'}ms promptChars=${shape.exactPromptChars} browserContextChars=${shape.browserContextChars}`,
      );
    }

    this.lastTurnToolContextMessage = buildToolContextCarryForwardMessage(toolSteps);

    this.clearPendingAutomationApprovals('skip');
    this.queryAbortController = null;
    this.paused = false;
    this.pauseResolve = null;
    this.activePendingTools = new Map<string, ToolStepEvent>();
    this.activeToolSteps = [];
    this.activeRequestContextDebugSnapshot = null;

    if (abortSignal.aborted) {
      if (repeatedToolFailureMessage) return repeatedToolFailureMessage;
      return 'Agent turn was interrupted.';
    }

    return stripToolCallJson(finalContent) || 'No response from agent.';
  }

  async estimateRequestBudget(
    userQuery: string,
    history: ChatTurn[] = [],
    contextTabIds?: number[],
    workflowDemonstrations: WorkflowDemonstration[] = [],
    skillMention: SkillMention | null = null,
  ): Promise<RequestBudgetEstimate> {
    return await this.requestBudgetRuntime.estimateRequestBudget(
      userQuery,
      history,
      contextTabIds,
      workflowDemonstrations,
      skillMention,
    );
  }

  private rebuildAgent(): void {
    let llm: ChatOpenAIInstance;
    try {
      llm = getLlmSync();
    } catch {
      console.warn('[agent] LLM not ready — agent rebuild deferred');
      return;
    }

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
      .filter((tool) => this.isToolEnabled(tool));
    console.log('[agent] Rebuilding agent graph with tools:', tools.map((tool: any) => tool.name));

    const prompt = this.buildCompiledSystemPrompt();

    this.currentAgent = createReactAgent({
      llm: llm as any,
      tools: tools as any,
      prompt,
    }) as unknown as ReactAgent;
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

export function resetAgent(): void {
  resetLlm();
  if (singletonAgent) {
    (singletonAgent as any).currentAgent = null;
  }
  console.log('[agent] Agent reset — will re-initialise on next query');
}

export function configureAndRebuild(config: LLMConfigUnion): void {
  reconfigureLlm(config);
  resetAgent();
  void ensureLlm()
    .then(() => getOrCreateAgent())
    .catch((err) => console.warn('[agent] Config apply deferred:', err.message));
}
