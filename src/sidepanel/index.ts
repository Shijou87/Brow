// ─── Side Panel Entry Point ─────────────────────────────────────────────────
// Bootstraps the chat UI, wires the agent, listens for registry updates.

import './style.scss';

import { ChatView } from './chat-view';
import type { ContextTabOption, SavedConversation } from './chat-view';
import { loadDomainSkillRegistryEntries } from './chat-view/config-store';
import { MCPAppHost } from './mcp-app-host';
import {
  buildToolContextCarryForwardMessage,
  type AutomationApprovalDecision,
  getAgentApi,
  configureAndRebuild,
  type AgentAPI,
  type ChatTurn,
  type RequestBudgetEstimate,
  type ToolStepEvent,
} from './agent';
import {
  type SkillRegistryEntry,
} from './skills-registry';
import {
  DEFAULT_AGENT_RECURSION_LIMIT,
  DEFAULT_CLAUDE_FIELDS,
  DEFAULT_OPENAI_FIELDS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_VLM_CONFIG,
  normalizePreferredOpenAiModel,
  type ProviderFields,
} from '../shared/config';
import {
  loadDisabledTools,
  loadSidepanelConfig,
  saveDisabledTools,
} from '../shared/storage';
import type { WebMCPRegistryEntry, DirectLLMConfig, SkillMention, WorkflowDemonstration } from '../shared/types';
import { logInfo } from '../shared/logger';
import { invalidateBrowserContextSnapshotCache } from './agent-runtime/browser-context';
import { workflowRecordingStart, workflowRecordingStop } from './tab-tools/workflow-demonstrations';

// ─── WebMCP registry (mirror of background SW registry) ────────────────────

const registry = new Map<number, WebMCPRegistryEntry>();
let activeTabId: number | undefined;

// ─── Boot ──────────────────────────────────────────────────────────────────

const app = document.getElementById('app')!;

const view = new ChatView(app, {
  onSendMessage: handleSendMessage,
  onStopGeneration: handleStopGeneration,
  onConfigApply: handleConfigApply,
  onSystemPromptApply: handleSystemPromptApply,
  onSkillRegistryApply: handleSkillRegistryApply,
  onVLMConfigApply: handleVLMConfigApply,
  onRefreshWebMCP: handleRefreshWebMCP,
  onToolToggle: handleToolToggle,
  onToolGroupToggle: handleToolGroupToggle,
  onAutomationApprovalDecision: handleAutomationApprovalDecision,
  onConversationLoad: handleConversationLoad,
  onConversationNew: handleConversationNew,
  onConversationDelete: handleConversationDelete,
  onConversationDraftChange: handleConversationDraftChange,
  onCopyContextDebug: handleCopyContextDebug,
  onMCPServerAdd: handleMCPServerAdd,
  onMCPServerRemove: handleMCPServerRemove,
  onMCPServerReconnect: handleMCPServerReconnect,
  onWorkflowRecordingStart: handleWorkflowRecordingStart,
  onWorkflowRecordingStop: handleWorkflowRecordingStop,
});

// Restore saved config on startup
void restoreSavedConfig();

// Enable input
view.enableInput();

// Wire agent callbacks
const agent = getAgentApi();
const chatHistory: ChatTurn[] = [];
const mcpAppHost = new MCPAppHost();
const REQUEST_BUDGET_REFRESH_DELAY_MS = 180;

type RequestContextDebugInput = {
  query: string;
  history: ChatTurn[];
  contextTabIds: number[];
  workflowDemonstrations: WorkflowDemonstration[];
  skillMention: SkillMention | null;
};

let requestBudgetRefreshTimer: number | null = null;
let requestBudgetRefreshSequence = 0;
let latestRequestBudgetEstimate: RequestBudgetEstimate | null = null;
let latestRequestContextDebugInput: RequestContextDebugInput | null = null;
let activeRunBaseRequestBudget: RequestBudgetEstimate | null = null;
let activeRunStreamTokenEstimate = 0;
let activeRunToolContextTokenEstimate = 0;

function estimateBudgetTextTokens(text: string | undefined): number {
  const trimmed = text?.trim() ?? '';
  if (!trimmed) return 0;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return Math.max(Math.ceil(trimmed.length / 4), Math.ceil(wordCount * 0.8));
}

function estimateToolContextTokens(steps: ToolStepEvent[]): number {
  const toolContextMessage = buildToolContextCarryForwardMessage(steps);
  const carryForwardTokens = toolContextMessage
    ? 8 + estimateBudgetTextTokens('system') + estimateBudgetTextTokens(toolContextMessage)
    : 0;
  const inFlightTokens = steps
    .filter((step) => step.status === 'running' || step.status === 'awaiting_approval')
    .reduce((sum, step) => (
      sum + 8 + estimateBudgetTextTokens(step.toolName) + estimateBudgetTextTokens(step.inputText)
    ), 0);
  return carryForwardTokens + inFlightTokens;
}

function updateActiveRunBudgetIndicator(): void {
  if (!activeRunBaseRequestBudget) return;

  const estimatedTokens = activeRunBaseRequestBudget.estimatedTokens + activeRunToolContextTokenEstimate + activeRunStreamTokenEstimate;
  const usageRatio = estimatedTokens / activeRunBaseRequestBudget.contextWindow;
  const nextEstimate: RequestBudgetEstimate = {
    ...activeRunBaseRequestBudget,
    estimatedTokens,
    usageRatio,
    usagePercent: Math.round(usageRatio * 100),
  };

  latestRequestBudgetEstimate = nextEstimate;
  view.updateRequestBudget(nextEstimate);
}

function beginActiveRunBudgetTracking(baseEstimate: RequestBudgetEstimate): void {
  activeRunBaseRequestBudget = baseEstimate;
  activeRunStreamTokenEstimate = 0;
  activeRunToolContextTokenEstimate = 0;
  latestRequestBudgetEstimate = baseEstimate;
  view.updateRequestBudget(baseEstimate);
}

function clearActiveRunBudgetTracking(): void {
  activeRunBaseRequestBudget = null;
  activeRunStreamTokenEstimate = 0;
  activeRunToolContextTokenEstimate = 0;
}

function refreshActiveRunBudgetFromToolSteps(steps: ToolStepEvent[]): void {
  if (!activeRunBaseRequestBudget) return;
  activeRunToolContextTokenEstimate = estimateToolContextTokens(steps);
  updateActiveRunBudgetIndicator();
}

function refreshActiveRunBudgetFromStreamText(text: string): void {
  if (!activeRunBaseRequestBudget) return;
  activeRunStreamTokenEstimate = estimateBudgetTextTokens(text);
  updateActiveRunBudgetIndicator();
}

restoreSavedSkills();

agent.onToolStep((steps: ToolStepEvent[]) => {
  view.updateToolSteps(steps);
  refreshActiveRunBudgetFromToolSteps(steps);
});
agent.onMCPAppRender((request) => {
  void handleMCPAppRender(request);
});
agent.onRequestBudgetCompaction((event) => {
  latestRequestBudgetEstimate = event.after;
  if (activeRunBaseRequestBudget) {
    activeRunBaseRequestBudget = event.after;
  }
  view.setRequestBudgetPending(false);
  view.updateRequestBudget(event.before);
  window.requestAnimationFrame(() => {
    if (activeRunBaseRequestBudget) {
      updateActiveRunBudgetIndicator();
      return;
    }
    view.updateRequestBudget(event.after);
  });
  view.saveCurrentConversation(chatHistory, agent.getConversationCompactionState());
});

// Provide tool manifest to ChatView
view.setToolManifestProvider(() => agent.getToolManifest());

// Provide MCP server list to ChatView
view.setMCPServerProvider(() => agent.getMCPServers());

// Restore MCP servers from storage
agent.restoreMCPServers().then(() => {
  logInfo('sidepanel', 'MCP servers restored from storage');
  view.refreshMCPPanel();
}).catch(() => {});

// Restore disabled tools from storage
void loadDisabledTools().then((saved) => {
  if (saved == null) return;
  agent.setDisabledTools(saved);
  logInfo('sidepanel', `Restored ${saved.length} disabled tools from storage`);
});

agent.onStreamText((text: string) => {
  refreshActiveRunBudgetFromStreamText(text);
});

// ─── Message handling ──────────────────────────────────────────────────────

async function handleSendMessage(
  message: string,
  contextTabIds: number[],
  workflowDemonstrations: WorkflowDemonstration[],
  skillMention: SkillMention | null,
): Promise<void> {
  if (agent.isBusy()) return;

  const historyBeforeTurn = [...chatHistory];
  view.addUserMessage(message, workflowDemonstrations.map((entry) => entry.id), skillMention);
  chatHistory.push({ role: 'user', content: message });
  view.saveCurrentConversation(chatHistory, agent.getConversationCompactionState());
  view.setAgentBusy(true);
  view.showTypingIndicator();

  const conversationWorkflowDemonstrations = view.getConversationWorkflowDemonstrations();
  latestRequestContextDebugInput = {
    query: message,
    history: [...historyBeforeTurn],
    contextTabIds: [...contextTabIds],
    workflowDemonstrations: conversationWorkflowDemonstrations,
    skillMention,
  };

  const activeRunEstimate = latestRequestBudgetEstimate ?? await agent.estimateRequestBudget(
    message,
    historyBeforeTurn,
    contextTabIds,
    conversationWorkflowDemonstrations,
    skillMention,
  ).catch((err: any) => {
    console.warn('[sidepanel] Failed to seed active request budget estimate:', err?.message ?? err);
    return null;
  });

  if (activeRunEstimate) {
    beginActiveRunBudgetTracking(activeRunEstimate);
    view.setRequestBudgetPending(true);
  }

  try {
    const response = await agent.query(
      message,
      historyBeforeTurn,
      contextTabIds,
      conversationWorkflowDemonstrations,
      skillMention,
    );
    if (response === 'Agent turn was interrupted.') {
      view.hideTypingIndicator();
      view.finalizeToolSteps();
      view.addSystemMessage('Generation stopped.');
      view.saveCurrentConversation(chatHistory, agent.getConversationCompactionState());
      return;
    }

    const toolContextMessage = agent.getLastTurnToolContextMessage();
    if (toolContextMessage) {
      chatHistory.push({ role: 'system', content: toolContextMessage });
    }

    chatHistory.push({ role: 'assistant', content: response });
    view.hideTypingIndicator();
    view.finalizeToolSteps();
    view.streamAssistantMessage(response);

    // Wait for streaming to finish then finalize and auto-save
    setTimeout(() => {
      view.finalizeStreaming();
      view.saveCurrentConversation(chatHistory, agent.getConversationCompactionState());
    }, Math.min(response.length * 35, 5000) + 500);
  } catch (err: any) {
    view.hideTypingIndicator();
    view.addSystemMessage(`Error: ${err.message ?? err}`);
  } finally {
    view.setAgentBusy(false);
    clearActiveRunBudgetTracking();
    scheduleRequestBudgetRefresh();
  }
}

function getWorkflowDemonstrationsForNextTurn(): WorkflowDemonstration[] {
  const byId = new Map<string, WorkflowDemonstration>();
  for (const demonstration of view.getConversationWorkflowDemonstrations()) {
    byId.set(demonstration.id, demonstration);
  }
  for (const demonstration of view.getStagedWorkflowDemonstrations()) {
    byId.set(demonstration.id, demonstration);
  }
  return [...byId.values()];
}

async function refreshRequestBudgetEstimate(sequence: number): Promise<void> {
  const message = view.getComposerSubmissionText();

  try {
    const estimate = await agent.estimateRequestBudget(
      message,
      chatHistory,
      view.getSelectedContextTabIds(),
      getWorkflowDemonstrationsForNextTurn(),
      view.getSelectedSkillMention(),
    );

    if (sequence !== requestBudgetRefreshSequence) return;
    latestRequestBudgetEstimate = estimate;
    if (!activeRunBaseRequestBudget) {
      view.updateRequestBudget(estimate);
    }
  } catch (err: any) {
    if (sequence !== requestBudgetRefreshSequence) return;
    console.warn('[sidepanel] Failed to estimate request budget:', err?.message ?? err);
    latestRequestBudgetEstimate = null;
    view.updateRequestBudget(null);
  } finally {
    if (sequence === requestBudgetRefreshSequence) {
      view.setRequestBudgetPending(false);
    }
  }
}

function scheduleRequestBudgetRefresh(): void {
  requestBudgetRefreshSequence += 1;
  const sequence = requestBudgetRefreshSequence;

  if (requestBudgetRefreshTimer !== null) {
    window.clearTimeout(requestBudgetRefreshTimer);
    requestBudgetRefreshTimer = null;
  }

  if (agent.isBusy() && activeRunBaseRequestBudget) {
    view.setRequestBudgetPending(true);
    return;
  }

  view.setRequestBudgetPending(true);
  requestBudgetRefreshTimer = window.setTimeout(() => {
    requestBudgetRefreshTimer = null;
    void refreshRequestBudgetEstimate(sequence);
  }, REQUEST_BUDGET_REFRESH_DELAY_MS);
}

function handleConversationDraftChange(): void {
  view.saveCurrentConversation(chatHistory, agent.getConversationCompactionState());
  scheduleRequestBudgetRefresh();
}

async function handleCopyContextDebug(): Promise<string> {
  const activeRequestContext = agent.getActiveRequestContextDebugText();
  if (activeRequestContext) {
    return activeRequestContext;
  }

  const draftQuery = view.getComposerSubmissionText();
  if (draftQuery) {
    return agent.buildRequestContextDebugText(
      draftQuery,
      chatHistory,
      view.getSelectedContextTabIds(),
      getWorkflowDemonstrationsForNextTurn(),
      view.getSelectedSkillMention(),
    );
  }

  if (latestRequestContextDebugInput) {
    return agent.buildRequestContextDebugText(
      latestRequestContextDebugInput.query,
      latestRequestContextDebugInput.history,
      latestRequestContextDebugInput.contextTabIds,
      latestRequestContextDebugInput.workflowDemonstrations,
      latestRequestContextDebugInput.skillMention,
    );
  }

  return agent.buildRequestContextDebugText(
    '[No draft message. Debugging carried conversation context only.]',
    chatHistory,
    view.getSelectedContextTabIds(),
    getWorkflowDemonstrationsForNextTurn(),
    view.getSelectedSkillMention(),
  );
}

async function handleWorkflowRecordingStart(
  tabId: number,
  options?: { title?: string; captureTypedValues?: boolean },
) {
  return workflowRecordingStart(tabId, options);
}

async function handleWorkflowRecordingStop(tabId: number) {
  return workflowRecordingStop(tabId);
}

function handleStopGeneration(): void {
  if (!agent.isBusy()) return;
  agent.abort();
}

function handleAutomationApprovalDecision(
  requestId: string,
  decision: AutomationApprovalDecision,
): void {
  agent.resolveAutomationApproval(requestId, decision);
}

function getMCPAppSandboxUrl(sessionId: string): string {
  const url = new URL(chrome.runtime.getURL('mcp-app-sandbox.html'));
  url.searchParams.set('session', sessionId);
  return url.toString();
}

async function handleMCPAppRender(request: import('./mcp-client').MCPAppRenderRequest): Promise<void> {
  const container = view.renderMCPAppLoading(request);

  try {
    const resource = await mcpAppHost.loadResource(request);
    view.renderMCPAppApproval(container, request, resource, {
      onApprove: () => {
        const iframe = view.renderMCPAppFrame(container, request, resource);
        void mcpAppHost.mount(
          request,
          iframe,
          getMCPAppSandboxUrl(request.id),
          resource,
          {
            onSizeChange: (height) => view.resizeMCPAppFrame(iframe, height),
            onLog: (message) => logInfo('mcp-app', message),
            onError: (message) => view.renderMCPAppError(container, request, message),
          },
        ).catch((err: any) => {
          view.renderMCPAppError(container, request, err?.message ?? String(err));
        });
      },
      onSkip: () => {
        mcpAppHost.teardown(request.id);
        view.renderMCPAppSkipped(container, request);
      },
    });
  } catch (err: any) {
    view.renderMCPAppError(container, request, err?.message ?? String(err));
  }
}

function toContextTabOption(tab: chrome.tabs.Tab | undefined): ContextTabOption | null {
  if (tab?.id === undefined || tab.id < 0) return null;
  return {
    tabId: tab.id,
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: tab.active ?? false,
  };
}

async function refreshCurrentTabContext(tabId?: number): Promise<void> {
  try {
    const tab = tabId !== undefined
      ? await chrome.tabs.get(tabId)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const nextContext = toContextTabOption(tab);
    view.setCurrentContextTab(nextContext);
  } catch {
    view.setCurrentContextTab(null);
  }
}

// ─── Config handling ───────────────────────────────────────────────────────

function handleConfigApply(config: {
  mode: 'openai' | 'claude';
  fields: ProviderFields;
  recursionLimit?: number;
  systemPrompt?: string;
}): void {
  const normalizedModel = config.mode === 'openai'
    ? normalizePreferredOpenAiModel(config.fields.model) ?? DEFAULT_OPENAI_FIELDS.model
    : config.fields.model;
  const llmConfig: DirectLLMConfig = {
    provider: 'direct',
    baseUrl: config.fields.baseUrl,
    apiKey: config.fields.apiKey,
    model: normalizedModel,
    contextWindow: config.fields.contextWindow,
  };
  configureAndRebuild(llmConfig);
  const agentApi = getAgentApi();
  agentApi.setRecursionLimit(config.recursionLimit ?? DEFAULT_AGENT_RECURSION_LIMIT);
  if (config.systemPrompt !== undefined) {
    agentApi.setSystemPrompt(config.systemPrompt || DEFAULT_SYSTEM_PROMPT);
  }
  const label = config.mode === 'openai' ? `OpenAI: ${llmConfig.model}` : `Claude: ${llmConfig.model}`;
  view.updateConnectionStatus(label);
  scheduleRequestBudgetRefresh();
}

function handleVLMConfigApply(config: { baseUrl: string; apiKey: string; model: string }): void {
  agent.setVLMConfig(config);
  console.log('[sidepanel] VLM config applied:', config.model, '@', config.baseUrl);
}

function handleSystemPromptApply(prompt: string): void {
  agent.setSystemPrompt(prompt || DEFAULT_SYSTEM_PROMPT);
  scheduleRequestBudgetRefresh();
}

function handleSkillRegistryApply(skills: SkillRegistryEntry[]): void {
  agent.setSkillRegistry(skills);
  scheduleRequestBudgetRefresh();
}

const DEFAULT_CONFIG = {
  mode: 'openai' as const,
  fields: {
      ...DEFAULT_OPENAI_FIELDS,
  },
  recursionLimit: DEFAULT_AGENT_RECURSION_LIMIT,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

async function restoreSavedConfig(): Promise<void> {
  const saved = await loadSidepanelConfig().catch(() => null);
  if (!saved) {
    handleConfigApply(DEFAULT_CONFIG);
    handleVLMConfigApply(DEFAULT_VLM_CONFIG);
    return;
  }

  const fields = saved.activeMode === 'openai' ? saved.openai : saved.claude;
  handleConfigApply({
    mode: saved.activeMode,
    fields,
    recursionLimit: saved.runtime.recursionLimit,
    systemPrompt: saved.runtime.systemPrompt,
  });
  handleVLMConfigApply(saved.vlm ?? DEFAULT_VLM_CONFIG);
}

function restoreSavedSkills(): void {
  void loadDomainSkillRegistryEntries().then((skills) => {
    agent.setSkillRegistry(skills);
    scheduleRequestBudgetRefresh();
  });
}

// ─── MCP Server handling ───────────────────────────────────────────────────

async function handleMCPServerAdd(name: string, url: string, authToken?: string) {
  const entry = await agent.addMCPServer(name, url, authToken);
  if (entry.status === 'connected') {
    view.addSystemMessage(`MCP server "${name}" connected: ${entry.tools.length} tool${entry.tools.length !== 1 ? 's' : ''} available.`);
  } else {
    view.addSystemMessage(`MCP server "${name}" failed: ${entry.error ?? 'unknown error'}`);
  }
  return entry;
}

function handleMCPServerRemove(id: string) {
  agent.removeMCPServer(id);
  view.addSystemMessage('MCP server removed.');
}

async function handleMCPServerReconnect(id: string) {
  const entry = await agent.reconnectMCPServer(id);
  if (entry.status === 'connected') {
    view.addSystemMessage(`MCP server "${entry.name}" reconnected: ${entry.tools.length} tool${entry.tools.length !== 1 ? 's' : ''}.`);
  } else {
    view.addSystemMessage(`MCP server "${entry.name}" reconnection failed: ${entry.error ?? 'unknown error'}`);
  }
  return entry;
}

// ─── WebMCP refresh ────────────────────────────────────────────────────────

async function handleRefreshWebMCP(): Promise<void> {
  if (activeTabId !== undefined) {
    chrome.runtime.sendMessage(
      { type: 'FORCE_DISCOVER', payload: { tabId: activeTabId } },
      () => {},
    );
  }
}

// ─── Tool toggle handling ──────────────────────────────────────────────────

function persistDisabledTools(): void {
  const disabled = Array.from(agent.getDisabledTools());
  void saveDisabledTools(disabled);
}

function handleToolToggle(toolName: string, enabled: boolean): void {
  agent.setToolEnabled(toolName, enabled);
  persistDisabledTools();
  logInfo('sidepanel', `Tool ${toolName} ${enabled ? 'enabled' : 'disabled'}`);
  scheduleRequestBudgetRefresh();
}

function handleToolGroupToggle(toolNames: string[], enabled: boolean): void {
  agent.setToolsEnabled(toolNames, enabled);
  persistDisabledTools();
  logInfo('sidepanel', `${toolNames.length} tools ${enabled ? 'enabled' : 'disabled'}`);
  scheduleRequestBudgetRefresh();
}

// ─── Conversation handling ─────────────────────────────────────────────────

function handleConversationLoad(conversation: SavedConversation): void {
  // Clear current chat and load saved conversation
  mcpAppHost.teardownAll();
  chatHistory.length = 0;
  chatHistory.push(...conversation.chatHistory as ChatTurn[]);
  latestRequestContextDebugInput = null;
  agent.setConversationCompactionState(conversation.compactionState);
  view.loadConversation(conversation);
  view.enableInput();
  logInfo('sidepanel', `Loaded conversation: ${conversation.title}`);
  scheduleRequestBudgetRefresh();
}

function handleConversationNew(): void {
  // Clear current chat and start fresh
  mcpAppHost.teardownAll();
  chatHistory.length = 0;
  latestRequestContextDebugInput = null;
  agent.setConversationCompactionState(null);
  view.clearMessages();
  view.setCurrentConversationId(null);
  view.enableInput();
  logInfo('sidepanel', 'Started new conversation');
  scheduleRequestBudgetRefresh();
}

function handleConversationDelete(id: string): void {
  view.deleteConversation(id);
  logInfo('sidepanel', `Deleted conversation: ${id}`);
}

// ─── WebMCP annotation helper ─────────────────────────────────────────────

function refreshWebMCPAnnotation(): void {
  let totalTools = 0;
  let tabCount = 0;
  for (const entry of registry.values()) {
    if (entry.available && entry.tools?.length > 0) {
      totalTools += entry.tools.length;
      tabCount++;
    }
  }
  view.updateWebMCPStatusAllTabs(totalTools, tabCount);
}

// ─── Listen for registry updates from background SW ────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'WEBMCP_REGISTRY_UPDATE') {
    const { tabId, entry } = message.payload;
    registry.set(tabId, entry);
    logInfo('sidepanel', `Registry update: tab=${tabId} available=${entry.available} tools=${entry.tools?.length ?? 0}`);

    // Refresh the aggregated annotation (all tabs)
    refreshWebMCPAnnotation();

    // Wire WebMCP tools for this tab into the agent (all tabs, not just active)
    if (entry.available && entry.tools?.length > 0) {
      agent.updateWebMCPTools(tabId, entry.tools, entry.url, entry.title);
      logInfo('sidepanel', `Wired ${entry.tools.length} WebMCP tools into agent for tab ${tabId}`);
    } else {
      agent.removeWebMCPToolsForTab(tabId);
    }
  }
});

// Track active tab
chrome.tabs.onActivated?.addListener(({ tabId }) => {
  invalidateBrowserContextSnapshotCache(tabId);
  activeTabId = tabId;
  void refreshCurrentTabContext(tabId);
});

chrome.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.title || changeInfo.url || changeInfo.status) {
    invalidateBrowserContextSnapshotCache(tabId);
  }
  if (tabId !== activeTabId) return;
  if (!changeInfo.title && !changeInfo.url && !changeInfo.status) return;
  void refreshCurrentTabContext(tab.id);
});

// When a tab is closed, remove its WebMCP tools from the agent and update annotation
chrome.tabs.onRemoved?.addListener((tabId) => {
  invalidateBrowserContextSnapshotCache(tabId);
  registry.delete(tabId);
  agent.removeWebMCPToolsForTab(tabId);
  view.removeContextTab(tabId);
  refreshWebMCPAnnotation();
  if (tabId === activeTabId) {
    activeTabId = undefined;
    void refreshCurrentTabContext();
  }
});

// Get initial active tab
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (tab?.id !== undefined) {
    activeTabId = tab.id;
    void refreshCurrentTabContext(tab.id);
    // Request full registry from background and wire ALL tabs' WebMCP tools
    chrome.runtime.sendMessage({ type: 'GET_REGISTRY' }, (reg) => {
      if (reg && Object.keys(reg).length > 0) {
        Object.entries(reg).forEach(([k, v]) => {
          const tid = Number(k);
          const ent = v as WebMCPRegistryEntry;
          registry.set(tid, ent);

          // Wire each tab's tools into the agent
          if (ent.available && ent.tools?.length > 0) {
            agent.updateWebMCPTools(tid, ent.tools, ent.url, ent.title);
          }
        });
        refreshWebMCPAnnotation();
      } else {
        // Registry empty — discover all open tabs
        logInfo('sidepanel', 'Registry empty at init, discovering all tabs');
        chrome.runtime.sendMessage({ type: 'DISCOVER_ALL' }, (res) => {
          logInfo('sidepanel', `DISCOVER_ALL complete: ${res?.discovered ?? 0} tabs`);
        });
      }
    });
  } else {
    void refreshCurrentTabContext();
  }
});
