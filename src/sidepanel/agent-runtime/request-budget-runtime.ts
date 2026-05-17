// ─── Request Budget Runtime ────────────────────────────────────────────────
// Assembles the model-facing query context, estimates request size against the
// configured context window, and compacts older conversation history when the
// next turn would otherwise exceed Brow's budget.

import {
  buildBrowserContextSnapshotResult,
  buildWorkflowDemonstrationContext,
  type BrowserContextSnapshotMetrics,
} from './browser-context';
import { buildSelectedSkillMentionContext } from './prompt';
import {
  formatRequestContextDebugText,
  type RequestContextDebugEntry,
  type RequestContextDebugMessage,
  type RequestContextDebugShape,
  type RequestContextDebugSnapshot,
  type RequestContextDebugTimings,
} from './request-context-debug';
import { wrapUntrustedContextBlock } from './untrusted-context';
import type {
  ConversationCompactionState,
  SkillMention,
  WorkflowDemonstration,
} from '../../shared/types';

const REQUEST_BUDGET_COMPACTION_THRESHOLD = 0.9;
const REQUEST_BUDGET_COMPACTION_TARGET = 0.75;
const MIN_VERBATIM_TURNS_AFTER_COMPACTION = 4;
const MIN_COMPACTION_SUMMARY_TOKENS = 96;
const COMPACTION_SUMMARY_TOKEN_RATIO = 0.18;

export type RequestBudgetChatTurn = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type AgentMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export interface AssembledQueryContext {
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

interface RequestBudgetCompactionEventLike {
  before: RequestBudgetEstimate;
  after: RequestBudgetEstimate;
  compactionState: ConversationCompactionState;
}

interface CreateRequestBudgetRuntimeOptions {
  getConfiguredContextWindow: () => number;
  getConversationCompactionState: () => ConversationCompactionState | null;
  setConversationCompactionState: (state: ConversationCompactionState | null) => void;
  emitRequestBudgetCompaction: (event: RequestBudgetCompactionEventLike) => void;
  buildCompiledSystemPrompt: () => string;
  buildMatchedDomainSkillContext: (contextTabIds?: number[]) => Promise<string>;
  buildMatchedDomainMemoryContext: (contextTabIds?: number[]) => Promise<string>;
  generateCompactionSummary: (
    history: RequestBudgetChatTurn[],
    compactedTurnCount: number,
    existingSummary?: string,
  ) => Promise<string>;
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

/**
 * Estimates the token cost of the compiled system prompt plus the provided
 * conversation messages using Brow's lightweight local heuristic.
 */
export function estimateConversationTokens(systemPrompt: string, messages: AgentMessage[]): number {
  return 16 + estimateMessageTokens({ role: 'system', content: systemPrompt })
    + messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function estimateHistoryTurnTokens(turns: RequestBudgetChatTurn[]): number {
  return turns.reduce((sum, turn) => sum + estimateMessageTokens({ role: turn.role, content: turn.content }), 0);
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
  history: RequestBudgetChatTurn[];
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

export function buildRequestContextDebugSnapshot(params: {
  query: string;
  history: RequestBudgetChatTurn[];
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

/**
 * Creates the request-budget helper used by the Agent to assemble context,
 * estimate request size, and compact older history when needed.
 */
export function createRequestBudgetRuntime(options: CreateRequestBudgetRuntimeOptions) {
  function getEffectiveConversationCompactionState(
    history: RequestBudgetChatTurn[],
  ): ConversationCompactionState | null {
    const currentState = options.getConversationCompactionState();
    if (!currentState?.summary.trim()) return null;
    const compactedTurnCount = Math.min(currentState.compactedTurnCount, history.length);
    if (compactedTurnCount <= 0) return null;
    return {
      ...currentState,
      compactedTurnCount,
    };
  }

  function buildCompactionSummaryMessage(state: ConversationCompactionState): AgentMessage {
    return {
      role: 'system',
      content: [
        `Earlier conversation summary replacing the first ${state.compactedTurnCount} chat turns:`,
        state.summary.trim(),
        'Treat this summary as the authoritative context for the compacted earlier conversation.',
      ].join('\n\n'),
    };
  }

  function buildEffectiveHistoryMessages(history: RequestBudgetChatTurn[]): AgentMessage[] {
    const compactionState = getEffectiveConversationCompactionState(history);
    const effectiveHistory = compactionState
      ? history.slice(compactionState.compactedTurnCount)
      : history;

    return [
      ...(compactionState ? [buildCompactionSummaryMessage(compactionState)] : []),
      ...effectiveHistory.map((turn) => ({ role: turn.role, content: turn.content })),
    ];
  }

  function estimateProjectedSummaryTokens(
    history: RequestBudgetChatTurn[],
    compactedTurnCount: number,
  ): number {
    const sourceTokens = estimateHistoryTurnTokens(history.slice(0, compactedTurnCount));
    return Math.max(MIN_COMPACTION_SUMMARY_TOKENS, Math.ceil(sourceTokens * COMPACTION_SUMMARY_TOKEN_RATIO));
  }

  function getNextCompactionTargetTurnCount(
    history: RequestBudgetChatTurn[],
    estimate: RequestBudgetEstimate,
  ): number {
    const maxCompactedTurnCount = Math.max(0, history.length - Math.min(history.length, MIN_VERBATIM_TURNS_AFTER_COMPACTION));
    const currentState = getEffectiveConversationCompactionState(history);
    const currentCompactedTurnCount = currentState?.compactedTurnCount ?? 0;

    if (maxCompactedTurnCount <= currentCompactedTurnCount) {
      return currentCompactedTurnCount;
    }

    const currentSummaryTokens = currentState
      ? estimateMessageTokens(buildCompactionSummaryMessage(currentState))
      : 0;

    let targetTurnCount = currentCompactedTurnCount;
    while (targetTurnCount < maxCompactedTurnCount) {
      const increment = maxCompactedTurnCount - targetTurnCount === 1 ? 1 : 2;
      targetTurnCount = Math.min(maxCompactedTurnCount, targetTurnCount + increment);

      const projectedSummaryTokens = estimateProjectedSummaryTokens(history, targetTurnCount);
      const newlyCompactedTokens = estimateHistoryTurnTokens(history.slice(currentCompactedTurnCount, targetTurnCount));
      const projectedTokens = estimate.estimatedTokens - currentSummaryTokens - newlyCompactedTokens + projectedSummaryTokens;

      if ((projectedTokens / estimate.contextWindow) <= REQUEST_BUDGET_COMPACTION_TARGET) {
        break;
      }
    }

    return targetTurnCount;
  }

  async function assembleQueryContext(
    userQuery: string,
    history: RequestBudgetChatTurn[] = [],
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
    const matchedDomainSkills = await options.buildMatchedDomainSkillContext(contextTabIds).catch((err: any) => {
      console.warn('[agent] Failed to resolve matched Domain Skills:', err?.message ?? err);
      return '';
    });
    const matchedDomainMemory = await options.buildMatchedDomainMemoryContext(contextTabIds).catch((err: any) => {
      console.warn('[agent] Failed to resolve matched Domain Memory:', err?.message ?? err);
      return '';
    });
    const selectedSkillMentionContext = skillMention
      ? buildSelectedSkillMentionContext(skillMention)
      : '';

    const augmentedUserQuery = userQuery;
    const messages: AgentMessage[] = [
      ...buildEffectiveHistoryMessages(history),
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
      systemPrompt: options.buildCompiledSystemPrompt(),
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

  async function estimateRequestBudget(
    userQuery: string,
    history: RequestBudgetChatTurn[] = [],
    contextTabIds?: number[],
    workflowDemonstrations: WorkflowDemonstration[] = [],
    skillMention: SkillMention | null = null,
  ): Promise<RequestBudgetEstimate> {
    const assembled = await assembleQueryContext(
      userQuery,
      history,
      contextTabIds,
      workflowDemonstrations,
      skillMention,
    );
    const estimatedTokens = estimateConversationTokens(assembled.systemPrompt, assembled.messages);
    const contextWindow = options.getConfiguredContextWindow();
    const usageRatio = estimatedTokens / contextWindow;

    return {
      estimatedTokens,
      contextWindow,
      usageRatio,
      usagePercent: Math.round(usageRatio * 100),
      messageCount: assembled.messages.length + 1,
    };
  }

  async function compactConversationIfNeeded(
    userQuery: string,
    history: RequestBudgetChatTurn[] = [],
    contextTabIds?: number[],
    workflowDemonstrations: WorkflowDemonstration[] = [],
    skillMention: SkillMention | null = null,
  ): Promise<void> {
    let before = await estimateRequestBudget(
      userQuery,
      history,
      contextTabIds,
      workflowDemonstrations,
      skillMention,
    );

    while (before.usageRatio > REQUEST_BUDGET_COMPACTION_THRESHOLD) {
      const targetTurnCount = getNextCompactionTargetTurnCount(history, before);
      const currentCompactedTurnCount = getEffectiveConversationCompactionState(history)?.compactedTurnCount ?? 0;

      if (targetTurnCount <= currentCompactedTurnCount) {
        return;
      }

      try {
        const existingSummary = options.getConversationCompactionState()?.summary.trim();
        const summary = await options.generateCompactionSummary(history, targetTurnCount, existingSummary);
        options.setConversationCompactionState({
          summary,
          compactedTurnCount: targetTurnCount,
          updatedAt: Date.now(),
        });
      } catch (err: any) {
        console.warn('[agent] Failed to compact conversation:', err?.message ?? err);
        return;
      }

      const after = await estimateRequestBudget(
        userQuery,
        history,
        contextTabIds,
        workflowDemonstrations,
        skillMention,
      );

      const compactionState = options.getConversationCompactionState();
      if (compactionState) {
        options.emitRequestBudgetCompaction({
          before,
          after,
          compactionState: { ...compactionState },
        });
      }

      if (after.usageRatio <= REQUEST_BUDGET_COMPACTION_TARGET) {
        return;
      }

      before = after;
    }
  }

  async function buildRequestContextDebugText(
    query: string,
    history: RequestBudgetChatTurn[] = [],
    contextTabIds?: number[],
    workflowDemonstrations: WorkflowDemonstration[] = [],
    skillMention: SkillMention | null = null,
  ): Promise<string> {
    const assembled = await assembleQueryContext(
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
      contextWindow: options.getConfiguredContextWindow(),
    }));
  }

  return {
    assembleQueryContext,
    estimateRequestBudget,
    compactConversationIfNeeded,
    buildRequestContextDebugText,
  };
}
