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
  type RequestContextDebugMessage,
  type RequestContextDebugShape,
  type RequestContextDebugSnapshot,
  type RequestContextDebugTimings,
} from './agent-runtime/request-context-debug';
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

const AUTOMATION_TOOL_TIMEOUT_MS = 30_000;
const REQUEST_BUDGET_COMPACTION_THRESHOLD = 0.9;
const REQUEST_BUDGET_COMPACTION_TARGET = 0.75;
const MIN_VERBATIM_TURNS_AFTER_COMPACTION = 4;
const MIN_COMPACTION_SUMMARY_TOKENS = 96;
const COMPACTION_SUMMARY_TOKEN_RATIO = 0.18;

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

interface AssembledQueryContext {
  systemPrompt: string;
  messages: AgentMessage[];
  augmentedUserQuery: string;
  browserContext: string;
  browserContextMetrics: BrowserContextSnapshotMetrics;
  workflowDemonstrationContext: string;
  matchedDomainSkills: string;
  matchedDomainMemory: string;
  selectedSkillMentionContext: string;
}

export interface RequestBudgetEstimate {
  estimatedTokens: number;
  contextWindow: number;
  usageRatio: number;
  usagePercent: number;
  messageCount: number;
}

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

function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const charEstimate = Math.ceil(trimmed.length / 4);
  const wordEstimate = Math.ceil(wordCount * 0.8);
  return Math.max(charEstimate, wordEstimate);
}

function estimateMessageTokens(message: AgentMessage): number {
  return 8 + estimateTextTokens(message.role) + estimateTextTokens(message.content);
}

function estimateConversationTokens(systemPrompt: string, messages: AgentMessage[]): number {
  return 16 + estimateMessageTokens({ role: 'system', content: systemPrompt })
    + messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function sumMessageContentChars(messages: RequestContextDebugMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

function countCarriedForwardToolSummaryChars(messages: RequestContextDebugMessage[]): number {
  return messages.reduce((sum, message) => {
    return message.content.startsWith('Previous turn tool-result summary.')
      ? sum + message.content.length
      : sum;
  }, 0);
}

function buildRequestContextDebugShape(params: {
  history: ChatTurn[];
  assembled: AssembledQueryContext;
  exactPromptMessages: RequestContextDebugMessage[];
}): RequestContextDebugShape {
  return {
    rawHistoryMessageCount: params.history.length,
    rawHistoryChars: params.history.reduce((sum, turn) => sum + turn.content.length, 0),
    exactPromptMessageCount: params.exactPromptMessages.length,
    exactPromptChars: sumMessageContentChars(params.exactPromptMessages),
    systemPromptChars: params.assembled.systemPrompt.length,
    browserContextChars: params.assembled.browserContext.length,
    browserContextFrameChars: params.assembled.browserContextMetrics.frameChars,
    browserContextOpenTabsChars: params.assembled.browserContextMetrics.openTabsSectionChars,
    browserContextActiveTabChars: params.assembled.browserContextMetrics.activeTabSectionChars,
    browserContextAttachedSnapshotsChars: params.assembled.browserContextMetrics.attachedSnapshotsSectionChars,
    workflowDemonstrationChars: params.assembled.workflowDemonstrationContext.length,
    matchedDomainSkillsChars: params.assembled.matchedDomainSkills.length,
    matchedDomainMemoryChars: params.assembled.matchedDomainMemory.length,
    selectedSkillMentionChars: params.assembled.selectedSkillMentionContext.length,
    carriedForwardToolSummaryChars: countCarriedForwardToolSummaryChars(params.exactPromptMessages),
    selectedContextTabCount: params.assembled.browserContextMetrics.selectedTabCount,
    attachedContextTabCount: params.assembled.browserContextMetrics.attachedTabCount,
    attachedSnapshotCount: params.assembled.browserContextMetrics.attachedSnapshotCount,
  };
}

function buildRequestContextDebugSnapshot(params: {
  query: string;
  history: ChatTurn[];
  assembled: AssembledQueryContext;
  contextWindow: number;
  timings?: RequestContextDebugTimings;
  liveUpdates?: RequestContextDebugEntry[];
}): RequestContextDebugSnapshot {
  const exactPromptMessages: RequestContextDebugMessage[] = [
    { role: 'system', content: params.assembled.systemPrompt },
    ...params.assembled.messages,
  ];

  return {
    query: params.query,
    estimatedTokens: estimateConversationTokens(params.assembled.systemPrompt, params.assembled.messages),
    contextWindow: params.contextWindow,
    rawHistory: params.history.map((turn) => ({ role: turn.role, content: turn.content })),
    exactPromptMessages,
    requestShape: buildRequestContextDebugShape({
      history: params.history,
      assembled: params.assembled,
      exactPromptMessages,
    }),
    timings: params.timings,
    liveUpdates: params.liveUpdates,
  };
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

function estimateHistoryTurnTokens(turns: ChatTurn[]): number {
  return turns.reduce((sum, turn) => sum + estimateMessageTokens({ role: turn.role, content: turn.content }), 0);
}

function extractLlmText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof (item as any).text === 'string') {
          return (item as any).text as string;
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  if (value && typeof value === 'object' && typeof (value as any).content !== 'undefined') {
    return extractLlmText((value as any).content);
  }
  return '';
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

  private getEffectiveConversationCompactionState(history: ChatTurn[]): ConversationCompactionState | null {
    if (!this.conversationCompactionState?.summary.trim()) return null;
    const compactedTurnCount = Math.min(this.conversationCompactionState.compactedTurnCount, history.length);
    if (compactedTurnCount <= 0) return null;
    return {
      ...this.conversationCompactionState,
      compactedTurnCount,
    };
  }

  private buildCompactionSummaryMessage(state: ConversationCompactionState): AgentMessage {
    return {
      role: 'system',
      content: [
        `Earlier conversation summary replacing the first ${state.compactedTurnCount} chat turns:`,
        state.summary.trim(),
        'Treat this summary as the authoritative context for the compacted earlier conversation.',
      ].join('\n\n'),
    };
  }

  private buildEffectiveHistoryMessages(history: ChatTurn[]): AgentMessage[] {
    const compactionState = this.getEffectiveConversationCompactionState(history);
    const effectiveHistory = compactionState
      ? history.slice(compactionState.compactedTurnCount)
      : history;

    return [
      ...(compactionState ? [this.buildCompactionSummaryMessage(compactionState)] : []),
      ...effectiveHistory.map((turn) => ({ role: turn.role, content: turn.content })),
    ];
  }

  private estimateProjectedSummaryTokens(history: ChatTurn[], compactedTurnCount: number): number {
    const sourceTokens = estimateHistoryTurnTokens(history.slice(0, compactedTurnCount));
    return Math.max(MIN_COMPACTION_SUMMARY_TOKENS, Math.ceil(sourceTokens * COMPACTION_SUMMARY_TOKEN_RATIO));
  }

  private getNextCompactionTargetTurnCount(
    history: ChatTurn[],
    estimate: RequestBudgetEstimate,
  ): number {
    const maxCompactedTurnCount = Math.max(0, history.length - Math.min(history.length, MIN_VERBATIM_TURNS_AFTER_COMPACTION));
    const currentState = this.getEffectiveConversationCompactionState(history);
    const currentCompactedTurnCount = currentState?.compactedTurnCount ?? 0;

    if (maxCompactedTurnCount <= currentCompactedTurnCount) {
      return currentCompactedTurnCount;
    }

    const currentSummaryTokens = currentState
      ? estimateMessageTokens(this.buildCompactionSummaryMessage(currentState))
      : 0;

    let targetTurnCount = currentCompactedTurnCount;
    while (targetTurnCount < maxCompactedTurnCount) {
      const increment = maxCompactedTurnCount - targetTurnCount === 1 ? 1 : 2;
      targetTurnCount = Math.min(maxCompactedTurnCount, targetTurnCount + increment);

      const projectedSummaryTokens = this.estimateProjectedSummaryTokens(history, targetTurnCount);
      const newlyCompactedTokens = estimateHistoryTurnTokens(history.slice(currentCompactedTurnCount, targetTurnCount));
      const projectedTokens = estimate.estimatedTokens - currentSummaryTokens - newlyCompactedTokens + projectedSummaryTokens;

      if ((projectedTokens / estimate.contextWindow) <= REQUEST_BUDGET_COMPACTION_TARGET) {
        break;
      }
    }

    return targetTurnCount;
  }

  private async generateCompactionSummary(history: ChatTurn[], compactedTurnCount: number): Promise<string> {
    const llm = await ensureLlm();
    const existingSummary = this.conversationCompactionState?.summary.trim();
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

  private async compactConversationIfNeeded(
    userQuery: string,
    history: ChatTurn[] = [],
    contextTabIds?: number[],
    workflowDemonstrations: WorkflowDemonstration[] = [],
    skillMention: SkillMention | null = null,
  ): Promise<void> {
    let before = await this.estimateRequestBudget(
      userQuery,
      history,
      contextTabIds,
      workflowDemonstrations,
      skillMention,
    );

    while (before.usageRatio > REQUEST_BUDGET_COMPACTION_THRESHOLD) {
      const targetTurnCount = this.getNextCompactionTargetTurnCount(history, before);
      const currentCompactedTurnCount = this.getEffectiveConversationCompactionState(history)?.compactedTurnCount ?? 0;

      if (targetTurnCount <= currentCompactedTurnCount) {
        return;
      }

      try {
        const summary = await this.generateCompactionSummary(history, targetTurnCount);
        this.conversationCompactionState = {
          summary,
          compactedTurnCount: targetTurnCount,
          updatedAt: Date.now(),
        };
      } catch (err: any) {
        console.warn('[agent] Failed to compact conversation:', err?.message ?? err);
        return;
      }

      const after = await this.estimateRequestBudget(
        userQuery,
        history,
        contextTabIds,
        workflowDemonstrations,
        skillMention,
      );

      this.emitRequestBudgetCompaction({
        before,
        after,
        compactionState: { ...this.conversationCompactionState },
      });

      if (after.usageRatio <= REQUEST_BUDGET_COMPACTION_TARGET) {
        return;
      }

      before = after;
    }
  }

  private async assembleQueryContext(
    userQuery: string,
    history: ChatTurn[] = [],
    contextTabIds?: number[],
    workflowDemonstrations: WorkflowDemonstration[] = [],
    skillMention: SkillMention | null = null,
  ): Promise<AssembledQueryContext> {
    const browserContextResult = await buildBrowserContextSnapshotResult(contextTabIds).catch((err: any) => {
      console.warn('[agent] Failed to build browser context snapshot:', err?.message ?? err);
      return {
        text: 'Browser context snapshot: unavailable.',
        metrics: {
          openTabCount: 0,
          listedTabCount: 0,
          extraTabCount: 0,
          selectedTabCount: 0,
          attachedTabCount: 0,
          omittedAttachedTabCount: 0,
          attachedSnapshotCount: 0,
          frameChars: 0,
          openTabsSectionChars: 0,
          activeTabSectionChars: 0,
          attachedSnapshotsSectionChars: 0,
        },
      };
    });
    const browserContext = wrapUntrustedContextBlock(
      'Browser context snapshot from the current tabs.',
      browserContextResult.text,
    );
    const workflowDemonstrationContext = buildWorkflowDemonstrationContext(workflowDemonstrations);
    const matchedDomainSkills = await this.buildMatchedDomainSkillContext(contextTabIds).catch((err: any) => {
      console.warn('[agent] Failed to resolve matched Domain Skills:', err?.message ?? err);
      return '';
    });
    const matchedDomainMemory = await this.buildMatchedDomainMemoryContext(contextTabIds).catch((err: any) => {
      console.warn('[agent] Failed to resolve matched Domain Memory:', err?.message ?? err);
      return '';
    });
    const selectedSkillMentionContext = skillMention
      ? buildSelectedSkillMentionContext(skillMention)
      : '';

    const augmentedUserQuery = userQuery;

    const messages: AgentMessage[] = [
      ...this.buildEffectiveHistoryMessages(history),
      { role: 'system', content: browserContext },
    ];

    if (workflowDemonstrationContext) {
      messages.push({ role: 'system', content: workflowDemonstrationContext });
    }
    if (matchedDomainSkills) {
      messages.push({ role: 'system', content: matchedDomainSkills });
    }
    if (matchedDomainMemory) {
      messages.push({ role: 'system', content: matchedDomainMemory });
    }
    if (selectedSkillMentionContext) {
      messages.push({ role: 'system', content: selectedSkillMentionContext });
    }
    messages.push({ role: 'user', content: augmentedUserQuery });

    return {
      systemPrompt: this.buildCompiledSystemPrompt(),
      messages,
      augmentedUserQuery,
      browserContext,
      browserContextMetrics: browserContextResult.metrics,
      workflowDemonstrationContext,
      matchedDomainSkills,
      matchedDomainMemory,
      selectedSkillMentionContext,
    };
  }

  constructor() {
    this.builtinTools = createBuiltinTools({
      getVLMConfig: () => this.vlmConfig,
      findSkill: (identifier) => this.findSkill(identifier),
      submitDomainSkillProposal: (draft) => this.submitDomainSkillProposal(draft),
    }).map((builtinTool) => this.wrapAutomationToolWithApproval(builtinTool));

    void ensureLlm()
      .then(() => this.rebuildAgent())
      .catch((err) => console.warn('[agent] LLM not yet configured:', err.message));
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
    const assembled = await this.assembleQueryContext(
      query,
      history,
      contextTabIds,
      workflowDemonstrations,
      skillMention,
    );
    return formatRequestContextDebugText(buildRequestContextDebugSnapshot({
      query,
      history,
      assembled,
      contextWindow: this.getConfiguredContextWindow(),
    }));
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
    await this.compactConversationIfNeeded(
      userQuery,
      history,
      contextTabIds,
      workflowDemonstrations,
      skillMention,
    );
    const compactionMs = Date.now() - compactionStartedAt;

    const requestAssemblyStartedAt = Date.now();
    const assembled = await this.assembleQueryContext(
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
        { streamMode: 'updates', recursionLimit: this.recursionLimit, signal: abortSignal },
      );

      for await (const chunk of abortableStream(rawStream, abortSignal)) {
        await this.waitIfPaused();

        if (firstAgentUpdateMs == null) {
          firstAgentUpdateMs = Date.now() - agentStreamStartedAt;
          this.mergeActiveRequestDebugTimings({ firstAgentUpdateMs });
        }

        if (abortSignal.aborted) {
          console.log('[agent] Query aborted, breaking stream');
          break;
        }

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

            if (message.content && typeof message.content === 'string' && !message.tool_calls?.length) {
              if (firstAssistantTextMs == null) {
                firstAssistantTextMs = Date.now() - agentStreamStartedAt;
                this.mergeActiveRequestDebugTimings({ firstAssistantTextMs });
              }
              finalContent = message.content;
              this.emitStreamText(message.content);
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
    const assembled = await this.assembleQueryContext(
      userQuery,
      history,
      contextTabIds,
      workflowDemonstrations,
      skillMention,
    );
    const estimatedTokens = estimateConversationTokens(assembled.systemPrompt, assembled.messages);
    const contextWindow = this.getConfiguredContextWindow();
    const usageRatio = estimatedTokens / contextWindow;

    return {
      estimatedTokens,
      contextWindow,
      usageRatio,
      usagePercent: Math.round(usageRatio * 100),
      messageCount: assembled.messages.length + 1,
    };
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
