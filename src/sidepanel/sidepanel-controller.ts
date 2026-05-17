// ─── Side Panel Runtime Coordinator ────────────────────────────────────────
// Owns the visible side-panel lifecycle: binds ChatView callbacks, restores
// persisted state, keeps request-budget/debug state current, and bridges UI
// actions into the agent, browser tabs, and app-render hosts.

import { ChatView, type ChatViewCallbacks, type ContextTabOption, type SavedConversation } from './chat-view';
import { loadDomainSkillRegistryEntries } from './chat-view/config-store';
import { downloadHtmlAppArtifact } from './html-app-artifact-utils';
import { MCPAppHost } from './mcp-app-host';
import { createLockedDownHtmlResource } from './sandboxed-html';
import { SandboxedHtmlHost } from './sandboxed-html-host';
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
import type { SkillRegistryEntry } from './skills-registry';
import {
  DEFAULT_AGENT_RECURSION_LIMIT,
  DEFAULT_CLAUDE_FIELDS,
  DEFAULT_OPENAI_FIELDS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_VLM_CONFIG,
  normalizePreferredOpenAiModel,
  resolveVLMConfig,
  type ProviderFields,
} from '../shared/config';
import {
  loadDisabledTools,
  loadHtmlAppExecutionPreferences,
  loadSidepanelConfig,
  saveDisabledTools,
  saveHtmlAppExecutionPreferences,
} from '../shared/storage';
import type {
  DirectLLMConfig,
  HtmlAppArtifactMessageRef,
  HtmlAppExecutionPreferences,
  HtmlAppRenderRequest,
  SkillMention,
  WebMCPRegistryEntry,
  WorkflowDemonstration,
} from '../shared/types';
import { logInfo } from '../shared/logger';
import { invalidateBrowserContextSnapshotCache } from './agent-runtime/browser-context';
import { dismissBrowAutomationOverlays } from './tab-tools/page-automation/tab-action-execution';
import { workflowRecordingStart, workflowRecordingStop } from './tab-tools/workflow-demonstrations';
import type { MCPAppRenderRequest, MCPServerEntry } from './mcp-client';

type RequestContextDebugInput = {
  query: string;
  history: ChatTurn[];
  contextTabIds: number[];
  workflowDemonstrations: WorkflowDemonstration[];
  skillMention: SkillMention | null;
};

const REQUEST_BUDGET_REFRESH_DELAY_MS = 180;
const DEFAULT_CONFIG = {
  mode: 'openai' as const,
  fields: {
    ...DEFAULT_OPENAI_FIELDS,
  },
  recursionLimit: DEFAULT_AGENT_RECURSION_LIMIT,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

/**
 * Coordinates the side-panel UI with the agent runtime and browser-facing
 * extension services.
 *
 * This class is the main owner of visible chat state, request-budget refresh,
 * approval flow, workflow recording initiation, and MCP/HTML app rendering
 * lifecycles. Keep reusable policy in dedicated helpers and keep the
 * controller focused on orchestration.
 */
export class SidepanelController {
  private view: ChatView | null = null;
  private readonly agent: AgentAPI;
  private readonly mcpAppHost = new MCPAppHost();
  private readonly htmlAppHost = new SandboxedHtmlHost();
  private readonly registry = new Map<number, WebMCPRegistryEntry>();
  private readonly chatHistory: ChatTurn[] = [];

  private activeTabId: number | undefined;
  private requestBudgetRefreshTimer: number | null = null;
  private requestBudgetRefreshSequence = 0;
  private latestRequestBudgetEstimate: RequestBudgetEstimate | null = null;
  private latestRequestContextDebugInput: RequestContextDebugInput | null = null;
  private activeRunBaseRequestBudget: RequestBudgetEstimate | null = null;
  private activeRunStreamTokenEstimate = 0;
  private activeRunToolContextTokenEstimate = 0;
  private activeRunHasVisibleAssistantStream = false;
  private activeRunLastAssistantStreamText = '';
  private htmlAppExecutionPreferences: HtmlAppExecutionPreferences = {
    alwaysAllowExecution: false,
  };
  private agentCallbacksBound = false;
  private chromeListenersBound = false;

  public readonly callbacks: ChatViewCallbacks;

  constructor(agent: AgentAPI = getAgentApi()) {
    this.agent = agent;
    this.callbacks = {
      onSendMessage: (message, contextTabIds, workflowDemonstrations, skillMention) => {
        void this.handleSendMessage(message, contextTabIds, workflowDemonstrations, skillMention);
      },
      onStopGeneration: () => this.handleStopGeneration(),
      onConfigApply: (config) => this.handleConfigApply(config),
      onSystemPromptApply: (prompt) => this.handleSystemPromptApply(prompt),
      onSkillRegistryApply: (skills) => this.handleSkillRegistryApply(skills),
      onVLMConfigApply: (config) => this.handleVLMConfigApply(config),
      onRefreshWebMCP: () => {
        void this.handleRefreshWebMCP();
      },
      onToolToggle: (toolName, enabled) => this.handleToolToggle(toolName, enabled),
      onToolGroupToggle: (toolNames, enabled) => this.handleToolGroupToggle(toolNames, enabled),
      onAutomationApprovalDecision: (requestId, decision) => this.handleAutomationApprovalDecision(requestId, decision),
      onConversationLoad: (conversation) => this.handleConversationLoad(conversation),
      onConversationNew: () => this.handleConversationNew(),
      onConversationDelete: (id) => this.handleConversationDelete(id),
      onConversationDraftChange: () => this.handleConversationDraftChange(),
      onCopyContextDebug: () => this.handleCopyContextDebug(),
      onHtmlAppExecutionPreferenceChange: (enabled) => {
        this.handleHtmlAppExecutionPreferenceChange(enabled);
      },
      onHtmlAppArtifactOpen: (ref, mode, container) => {
        void this.handleHtmlAppArtifactOpen(ref, mode, container);
      },
      onHtmlAppArtifactDownload: (ref) => {
        void this.handleHtmlAppArtifactDownload(ref);
      },
      onMCPServerAdd: (name, url, authToken) => this.handleMCPServerAdd(name, url, authToken),
      onMCPServerRemove: (id) => this.handleMCPServerRemove(id),
      onMCPServerReconnect: (id) => this.handleMCPServerReconnect(id),
      onWorkflowRecordingStart: (tabId, options) => this.handleWorkflowRecordingStart(tabId, options),
      onWorkflowRecordingStop: (tabId) => this.handleWorkflowRecordingStop(tabId),
    };
  }

  public bindView(view: ChatView): void {
    this.view = view;
    this.attachAgentCallbacks();
    view.setToolManifestProvider(() => this.agent.getToolManifest());
    view.setMCPServerProvider(() => this.agent.getMCPServers());
  }

  public async initialize(): Promise<void> {
    const view = this.requireView();
    this.bindChromeListeners();

    await this.restoreSavedConfig();
    view.enableInput();
    this.restoreSavedSkills();
    void this.restoreMCPServers();
    void this.restoreDisabledTools();
    await this.restoreHtmlAppExecutionPreferences();
    await this.restoreInitialTabAndRegistry();
    this.scheduleRequestBudgetRefresh();
  }

  private requireView(): ChatView {
    if (!this.view) {
      throw new Error('SidepanelController requires a bound ChatView.');
    }
    return this.view;
  }

  private attachAgentCallbacks(): void {
    if (this.agentCallbacksBound) return;
    this.agentCallbacksBound = true;

    this.agent.onToolStep((steps: ToolStepEvent[]) => {
      const view = this.requireView();
      view.updateToolSteps(steps);
      this.refreshActiveRunBudgetFromToolSteps(steps);
    });

    this.agent.onMCPAppRender((request) => {
      void this.handleMCPAppRender(request);
    });

    this.agent.onHtmlAppRender((request) => {
      void this.handleHtmlAppRender(request);
    });

    this.agent.onRequestBudgetCompaction((event) => {
      const view = this.requireView();
      this.latestRequestBudgetEstimate = event.after;
      if (this.activeRunBaseRequestBudget) {
        this.activeRunBaseRequestBudget = event.after;
      }
      view.setRequestBudgetPending(false);
      view.updateRequestBudget(event.before);
      window.requestAnimationFrame(() => {
        if (this.activeRunBaseRequestBudget) {
          this.updateActiveRunBudgetIndicator();
          return;
        }
        view.updateRequestBudget(event.after);
      });
      view.saveCurrentConversation(this.chatHistory, this.agent.getConversationCompactionState());
    });

    this.agent.onStreamText((text: string) => {
      this.refreshActiveRunBudgetFromStreamText(text);
      if (!this.agent.isBusy()) return;
      if (text === this.activeRunLastAssistantStreamText) return;
      this.activeRunLastAssistantStreamText = text;
      if (!text) return;

      const view = this.requireView();
      if (!this.activeRunHasVisibleAssistantStream) {
        view.hideTypingIndicator();
        this.activeRunHasVisibleAssistantStream = true;
      }
      view.streamAssistantMessage(text);
    });
  }

  private estimateBudgetTextTokens(text: string | undefined): number {
    const trimmed = text?.trim() ?? '';
    if (!trimmed) return 0;
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    return Math.max(Math.ceil(trimmed.length / 4), Math.ceil(wordCount * 0.8));
  }

  private estimateToolContextTokens(steps: ToolStepEvent[]): number {
    const toolContextMessage = buildToolContextCarryForwardMessage(steps);
    const carryForwardTokens = toolContextMessage
      ? 8 + this.estimateBudgetTextTokens('system') + this.estimateBudgetTextTokens(toolContextMessage)
      : 0;
    const inFlightTokens = steps
      .filter((step) => step.status === 'running' || step.status === 'awaiting_approval')
      .reduce((sum, step) => (
        sum + 8 + this.estimateBudgetTextTokens(step.toolName) + this.estimateBudgetTextTokens(step.inputText)
      ), 0);
    return carryForwardTokens + inFlightTokens;
  }

  private updateActiveRunBudgetIndicator(): void {
    if (!this.activeRunBaseRequestBudget) return;

    const estimatedTokens = this.activeRunBaseRequestBudget.estimatedTokens
      + this.activeRunToolContextTokenEstimate
      + this.activeRunStreamTokenEstimate;
    const usageRatio = estimatedTokens / this.activeRunBaseRequestBudget.contextWindow;
    const nextEstimate: RequestBudgetEstimate = {
      ...this.activeRunBaseRequestBudget,
      estimatedTokens,
      usageRatio,
      usagePercent: Math.round(usageRatio * 100),
    };

    this.latestRequestBudgetEstimate = nextEstimate;
    this.requireView().updateRequestBudget(nextEstimate);
  }

  private beginActiveRunBudgetTracking(baseEstimate: RequestBudgetEstimate): void {
    this.activeRunBaseRequestBudget = baseEstimate;
    this.activeRunStreamTokenEstimate = 0;
    this.activeRunToolContextTokenEstimate = 0;
    this.activeRunHasVisibleAssistantStream = false;
    this.activeRunLastAssistantStreamText = '';
    this.latestRequestBudgetEstimate = baseEstimate;
    this.requireView().updateRequestBudget(baseEstimate);
  }

  private clearActiveRunBudgetTracking(): void {
    this.activeRunBaseRequestBudget = null;
    this.activeRunStreamTokenEstimate = 0;
    this.activeRunToolContextTokenEstimate = 0;
    this.activeRunHasVisibleAssistantStream = false;
    this.activeRunLastAssistantStreamText = '';
  }

  private refreshActiveRunBudgetFromToolSteps(steps: ToolStepEvent[]): void {
    if (!this.activeRunBaseRequestBudget) return;
    this.activeRunToolContextTokenEstimate = this.estimateToolContextTokens(steps);
    this.updateActiveRunBudgetIndicator();
  }

  private refreshActiveRunBudgetFromStreamText(text: string): void {
    if (!this.activeRunBaseRequestBudget) return;
    this.activeRunStreamTokenEstimate = this.estimateBudgetTextTokens(text);
    this.updateActiveRunBudgetIndicator();
  }

  private async handleSendMessage(
    message: string,
    contextTabIds: number[],
    workflowDemonstrations: WorkflowDemonstration[],
    skillMention: SkillMention | null,
  ): Promise<void> {
    const view = this.requireView();
    if (this.agent.isBusy()) return;

    const historyBeforeTurn = [...this.chatHistory];
    view.addUserMessage(message, workflowDemonstrations.map((entry) => entry.id), skillMention);
    this.chatHistory.push({ role: 'user', content: message });
    view.saveCurrentConversation(this.chatHistory, this.agent.getConversationCompactionState());
    view.setAgentBusy(true);
    view.showTypingIndicator();

    const conversationWorkflowDemonstrations = view.getConversationWorkflowDemonstrations();
    this.latestRequestContextDebugInput = {
      query: message,
      history: [...historyBeforeTurn],
      contextTabIds: [...contextTabIds],
      workflowDemonstrations: conversationWorkflowDemonstrations,
      skillMention,
    };

    const activeRunEstimate = this.latestRequestBudgetEstimate ?? await this.agent.estimateRequestBudget(
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
      this.beginActiveRunBudgetTracking(activeRunEstimate);
      view.setRequestBudgetPending(true);
    }

    try {
      const response = await this.agent.query(
        message,
        historyBeforeTurn,
        contextTabIds,
        conversationWorkflowDemonstrations,
        skillMention,
      );
      if (response === 'Agent turn was interrupted.') {
        view.hideTypingIndicator();
        view.finalizeToolSteps();
        view.finalizeStreaming();
        view.addSystemMessage('Generation stopped.');
        view.saveCurrentConversation(this.chatHistory, this.agent.getConversationCompactionState());
        return;
      }

      const toolContextMessage = this.agent.getLastTurnToolContextMessage();
      if (toolContextMessage) {
        this.chatHistory.push({ role: 'system', content: toolContextMessage });
      }

      this.chatHistory.push({ role: 'assistant', content: response });
      view.hideTypingIndicator();
      view.finalizeToolSteps();
      if (response && response !== this.activeRunLastAssistantStreamText) {
        view.streamAssistantMessage(response);
        this.activeRunHasVisibleAssistantStream = true;
        this.activeRunLastAssistantStreamText = response;
      }
      view.finalizeStreaming();
      view.saveCurrentConversation(this.chatHistory, this.agent.getConversationCompactionState());
    } catch (err: any) {
      view.hideTypingIndicator();
      view.finalizeToolSteps();
      view.finalizeStreaming();
      view.addSystemMessage(`Error: ${err.message ?? err}`);
      view.saveCurrentConversation(this.chatHistory, this.agent.getConversationCompactionState());
    } finally {
      view.setAgentBusy(false);
      this.clearActiveRunBudgetTracking();
      this.scheduleRequestBudgetRefresh();
      await dismissBrowAutomationOverlays().catch((err: any) => {
        console.warn('[sidepanel] Failed to dismiss Brow automation overlays:', err?.message ?? err);
      });
    }
  }

  private getWorkflowDemonstrationsForNextTurn(): WorkflowDemonstration[] {
    const view = this.requireView();
    const byId = new Map<string, WorkflowDemonstration>();
    for (const demonstration of view.getConversationWorkflowDemonstrations()) {
      byId.set(demonstration.id, demonstration);
    }
    for (const demonstration of view.getStagedWorkflowDemonstrations()) {
      byId.set(demonstration.id, demonstration);
    }
    return [...byId.values()];
  }

  private async refreshRequestBudgetEstimate(sequence: number): Promise<void> {
    const view = this.requireView();
    const message = view.getComposerSubmissionText();

    try {
      const estimate = await this.agent.estimateRequestBudget(
        message,
        this.chatHistory,
        view.getSelectedContextTabIds(),
        this.getWorkflowDemonstrationsForNextTurn(),
        view.getSelectedSkillMention(),
      );

      if (sequence !== this.requestBudgetRefreshSequence) return;
      this.latestRequestBudgetEstimate = estimate;
      if (!this.activeRunBaseRequestBudget) {
        view.updateRequestBudget(estimate);
      }
    } catch (err: any) {
      if (sequence !== this.requestBudgetRefreshSequence) return;
      console.warn('[sidepanel] Failed to estimate request budget:', err?.message ?? err);
      this.latestRequestBudgetEstimate = null;
      view.updateRequestBudget(null);
    } finally {
      if (sequence === this.requestBudgetRefreshSequence) {
        view.setRequestBudgetPending(false);
      }
    }
  }

  private scheduleRequestBudgetRefresh(): void {
    const view = this.requireView();
    this.requestBudgetRefreshSequence += 1;
    const sequence = this.requestBudgetRefreshSequence;

    if (this.requestBudgetRefreshTimer !== null) {
      window.clearTimeout(this.requestBudgetRefreshTimer);
      this.requestBudgetRefreshTimer = null;
    }

    if (this.agent.isBusy() && this.activeRunBaseRequestBudget) {
      view.setRequestBudgetPending(true);
      return;
    }

    view.setRequestBudgetPending(true);
    this.requestBudgetRefreshTimer = window.setTimeout(() => {
      this.requestBudgetRefreshTimer = null;
      void this.refreshRequestBudgetEstimate(sequence);
    }, REQUEST_BUDGET_REFRESH_DELAY_MS);
  }

  private handleConversationDraftChange(): void {
    const view = this.requireView();
    view.saveCurrentConversation(this.chatHistory, this.agent.getConversationCompactionState());
    this.scheduleRequestBudgetRefresh();
  }

  private async handleCopyContextDebug(): Promise<string> {
    const view = this.requireView();
    const activeRequestContext = this.agent.getActiveRequestContextDebugText();
    if (activeRequestContext) {
      return activeRequestContext;
    }

    const draftQuery = view.getComposerSubmissionText();
    if (draftQuery) {
      return this.agent.buildRequestContextDebugText(
        draftQuery,
        this.chatHistory,
        view.getSelectedContextTabIds(),
        this.getWorkflowDemonstrationsForNextTurn(),
        view.getSelectedSkillMention(),
      );
    }

    if (this.latestRequestContextDebugInput) {
      return this.agent.buildRequestContextDebugText(
        this.latestRequestContextDebugInput.query,
        this.latestRequestContextDebugInput.history,
        this.latestRequestContextDebugInput.contextTabIds,
        this.latestRequestContextDebugInput.workflowDemonstrations,
        this.latestRequestContextDebugInput.skillMention,
      );
    }

    return this.agent.buildRequestContextDebugText(
      '[No draft message. Debugging carried conversation context only.]',
      this.chatHistory,
      view.getSelectedContextTabIds(),
      this.getWorkflowDemonstrationsForNextTurn(),
      view.getSelectedSkillMention(),
    );
  }

  private handleWorkflowRecordingStart(
    tabId: number,
    options?: { title?: string; captureTypedValues?: boolean },
  ) {
    return workflowRecordingStart(tabId, options);
  }

  private handleWorkflowRecordingStop(tabId: number) {
    return workflowRecordingStop(tabId);
  }

  private handleStopGeneration(): void {
    if (!this.agent.isBusy()) return;
    this.agent.abort();
  }

  private handleAutomationApprovalDecision(
    requestId: string,
    decision: AutomationApprovalDecision,
  ): void {
    this.agent.resolveAutomationApproval(requestId, decision);
  }

  private getSandboxUrl(sessionId: string): string {
    const url = new URL(chrome.runtime.getURL('mcp-app-sandbox.html'));
    url.searchParams.set('session', sessionId);
    return url.toString();
  }

  private getHtmlAppViewUrl(conversationId: string, artifactId: string, revisionId: string): string {
    const url = new URL(chrome.runtime.getURL('html-app-view.html'));
    url.searchParams.set('conversation', conversationId);
    url.searchParams.set('artifact', artifactId);
    url.searchParams.set('revision', revisionId);
    return url.toString();
  }

  private generateRuntimeId(prefix: string): string {
    const suffix =
      globalThis.crypto?.randomUUID?.()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}-${suffix}`;
  }

  private async handleMCPAppRender(request: MCPAppRenderRequest): Promise<void> {
    const view = this.requireView();
    const container = view.renderMCPAppLoading(request);

    try {
      const resource = await this.mcpAppHost.loadResource(request);
      view.renderMCPAppApproval(container, request, resource, {
        onApprove: () => {
          const iframe = view.renderMCPAppFrame(container, request, resource);
          void this.mcpAppHost.mount(
            request,
            iframe,
            this.getSandboxUrl(request.id),
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
          this.mcpAppHost.teardown(request.id);
          view.renderMCPAppSkipped(container, request);
        },
      });
    } catch (err: any) {
      view.renderMCPAppError(container, request, err?.message ?? String(err));
    }
  }

  private async openHtmlAppArtifactTab(
    conversationId: string,
    artifactId: string,
    revisionId: string,
  ): Promise<void> {
    await chrome.tabs.create({
      url: this.getHtmlAppViewUrl(conversationId, artifactId, revisionId),
      active: true,
    });
  }

  private async mountHtmlAppArtifactInline(
    container: HTMLElement,
    request: HtmlAppRenderRequest,
    sessionId = request.id,
  ): Promise<void> {
    const view = this.requireView();
    const iframe = view.renderHtmlAppArtifactFrame(container, request);
    await this.htmlAppHost.mount(
      sessionId,
      iframe,
      this.getSandboxUrl(sessionId),
      createLockedDownHtmlResource(request.html),
      {
        onSizeChange: (height) => view.resizeHtmlAppArtifactFrame(iframe, height),
        onError: (message) => view.renderHtmlAppArtifactError(container, request, message),
      },
    );
  }

  private async maybePersistAlwaysAllowHtmlApps(rememberChoice: boolean): Promise<void> {
    if (!rememberChoice || this.htmlAppExecutionPreferences.alwaysAllowExecution) return;

    const accepted = window.confirm(
      'Always allow future HTML App Artifacts on this device?\n\n'
      + 'Generated HTML apps can run JavaScript inside Brow\'s sandbox and may capture keyboard input while focused. '
      + 'Only enable this if you trust the HTML apps you ask Brow to generate.',
    );
    if (!accepted) return;

    this.htmlAppExecutionPreferences = await saveHtmlAppExecutionPreferences({
      alwaysAllowExecution: true,
    });
    this.requireView().addSystemMessage(
      'Future HTML App Artifacts will render inline automatically until you turn off "Always Allow HTML Apps" in Config.',
    );
  }

  private async executeHtmlAppApprovalAction(
    container: HTMLElement,
    request: HtmlAppRenderRequest,
    mode: 'inline' | 'tab' | 'both',
    options: { alwaysAllow: boolean },
  ): Promise<void> {
    const view = this.requireView();
    await this.maybePersistAlwaysAllowHtmlApps(options.alwaysAllow);

    if (mode === 'inline') {
      await this.mountHtmlAppArtifactInline(container, request);
      return;
    }

    const conversationId = view.getCurrentConversationId();
    if (!conversationId) {
      view.renderHtmlAppArtifactError(container, request, 'The current conversation is not available for tab rendering.');
      return;
    }

    if (mode === 'tab') {
      await this.openHtmlAppArtifactTab(conversationId, request.artifactId, request.revisionId);
      view.renderHtmlAppArtifactOpened(container, request);
      return;
    }

    await this.mountHtmlAppArtifactInline(container, request);
    await this.openHtmlAppArtifactTab(conversationId, request.artifactId, request.revisionId);
  }

  private async handleHtmlAppRender(request: HtmlAppRenderRequest): Promise<void> {
    const view = this.requireView();
    const container = view.addHtmlAppArtifactMessage(request);
    view.saveCurrentConversation(this.chatHistory, this.agent.getConversationCompactionState());

    if (!container) return;

    if (this.htmlAppExecutionPreferences.alwaysAllowExecution) {
      void this.mountHtmlAppArtifactInline(container, request).catch((err: any) => {
        view.renderHtmlAppArtifactError(container, request, err?.message ?? String(err));
      });
      return;
    }

    view.renderHtmlAppArtifactApproval(container, request, {
      onRenderInline: (options) => {
        void this.executeHtmlAppApprovalAction(container, request, 'inline', options).catch((err: any) => {
          view.renderHtmlAppArtifactError(container, request, err?.message ?? String(err));
        });
      },
      onOpenTab: (options) => {
        void this.executeHtmlAppApprovalAction(container, request, 'tab', options).catch((err: any) => {
          view.renderHtmlAppArtifactError(container, request, err?.message ?? String(err));
        });
      },
      onRenderBoth: (options) => {
        void this.executeHtmlAppApprovalAction(container, request, 'both', options).catch((err: any) => {
          view.renderHtmlAppArtifactError(container, request, err?.message ?? String(err));
        });
      },
      onSkip: () => {
        this.htmlAppHost.teardown(request.id);
        view.renderHtmlAppArtifactSkipped(container, request);
      },
    }, {
      showAlwaysAllowToggle: !this.htmlAppExecutionPreferences.alwaysAllowExecution,
    });
  }

  private async handleHtmlAppArtifactOpen(
    ref: HtmlAppArtifactMessageRef,
    mode: 'inline' | 'tab',
    container?: HTMLElement,
  ): Promise<void> {
    const view = this.requireView();
    const resolved = view.resolveHtmlAppArtifact(ref, { preferLatest: true });
    if (!resolved) return;

    const request: HtmlAppRenderRequest = {
      id: this.generateRuntimeId('html-app-inline'),
      artifactId: resolved.artifact.id,
      revisionId: resolved.revision.id,
      title: resolved.revision.title,
      html: resolved.revision.html,
      renderTargetHint: resolved.revision.renderTargetHint,
      summary: resolved.revision.summary,
      createdAt: Date.now(),
    };

    if (mode === 'tab') {
      if (!resolved.conversationId) return;
      await this.openHtmlAppArtifactTab(resolved.conversationId, resolved.artifact.id, resolved.revision.id);
      return;
    }

    if (!container) return;
    await this.mountHtmlAppArtifactInline(container, request, request.id);
  }

  private async handleHtmlAppArtifactDownload(ref: HtmlAppArtifactMessageRef): Promise<void> {
    const view = this.requireView();
    const resolved = view.resolveHtmlAppArtifact(ref, { preferLatest: true });
    if (!resolved) return;
    await downloadHtmlAppArtifact(
      resolved.revision.title,
      resolved.revision.html,
      resolved.revision.id,
    );
  }

  private toContextTabOption(tab: chrome.tabs.Tab | undefined): ContextTabOption | null {
    if (tab?.id === undefined || tab.id < 0) return null;
    return {
      tabId: tab.id,
      title: tab.title ?? '',
      url: tab.url ?? '',
      active: tab.active ?? false,
    };
  }

  private async refreshCurrentTabContext(tabId?: number): Promise<void> {
    const view = this.requireView();
    try {
      const tab = tabId !== undefined
        ? await chrome.tabs.get(tabId)
        : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      const nextContext = this.toContextTabOption(tab);
      view.setCurrentContextTab(nextContext);
    } catch {
      view.setCurrentContextTab(null);
    }
  }

  private handleConfigApply(config: {
    mode: 'openai' | 'claude';
    fields: ProviderFields;
    recursionLimit?: number;
    systemPrompt?: string;
  }): void {
    const view = this.requireView();
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
    this.scheduleRequestBudgetRefresh();
  }

  private handleVLMConfigApply(config: { baseUrl: string; apiKey: string; model: string; useTextModel: boolean } | null): void {
    this.agent.setVLMConfig(config);
    if (!config) {
      logInfo('sidepanel', 'VLM config cleared');
      return;
    }
    logInfo('sidepanel', 'VLM config applied:', config.model, '@', config.baseUrl);
  }

  private handleSystemPromptApply(prompt: string): void {
    this.agent.setSystemPrompt(prompt || DEFAULT_SYSTEM_PROMPT);
    this.scheduleRequestBudgetRefresh();
  }

  private handleSkillRegistryApply(skills: SkillRegistryEntry[]): void {
    this.agent.setSkillRegistry(skills);
    this.scheduleRequestBudgetRefresh();
  }

  private async restoreSavedConfig(): Promise<void> {
    const saved = await loadSidepanelConfig().catch(() => null);
    if (!saved) {
      this.handleConfigApply(DEFAULT_CONFIG);
      this.handleVLMConfigApply(resolveVLMConfig(DEFAULT_VLM_CONFIG, DEFAULT_CONFIG.fields));
      return;
    }

    const fields = saved.activeMode === 'openai' ? saved.openai : saved.claude;
    this.handleConfigApply({
      mode: saved.activeMode,
      fields,
      recursionLimit: saved.runtime.recursionLimit,
      systemPrompt: saved.runtime.systemPrompt,
    });
    this.handleVLMConfigApply(resolveVLMConfig(saved.vlm ?? DEFAULT_VLM_CONFIG, fields));
  }

  private restoreSavedSkills(): void {
    void loadDomainSkillRegistryEntries().then((skills) => {
      this.agent.setSkillRegistry(skills);
      this.scheduleRequestBudgetRefresh();
    });
  }

  private async restoreMCPServers(): Promise<void> {
    const view = this.requireView();
    await this.agent.restoreMCPServers().then(() => {
      logInfo('sidepanel', 'MCP servers restored from storage');
      view.refreshMCPPanel();
    }).catch(() => {});
  }

  private async restoreDisabledTools(): Promise<void> {
    const saved = await loadDisabledTools().catch(() => null);
    if (saved == null) return;
    this.agent.setDisabledTools(saved);
    logInfo('sidepanel', `Restored ${saved.length} disabled tools from storage`);
  }

  private async restoreHtmlAppExecutionPreferences(): Promise<void> {
    this.htmlAppExecutionPreferences = await loadHtmlAppExecutionPreferences().catch(() => ({
      alwaysAllowExecution: false,
    }));
  }

  private handleHtmlAppExecutionPreferenceChange(enabled: boolean): void {
    if (enabled === this.htmlAppExecutionPreferences.alwaysAllowExecution) return;
    this.htmlAppExecutionPreferences = {
      alwaysAllowExecution: enabled,
    };
    void saveHtmlAppExecutionPreferences(this.htmlAppExecutionPreferences).catch((err: any) => {
      console.warn('[sidepanel] Failed to save HTML App execution preferences:', err?.message ?? err);
    });
  }

  private async handleMCPServerAdd(name: string, url: string, authToken?: string): Promise<MCPServerEntry> {
    const view = this.requireView();
    const entry = await this.agent.addMCPServer(name, url, authToken);
    if (entry.status === 'connected') {
      view.addSystemMessage(`MCP server "${name}" connected: ${entry.tools.length} tool${entry.tools.length !== 1 ? 's' : ''} available.`);
    } else {
      view.addSystemMessage(`MCP server "${name}" failed: ${entry.error ?? 'unknown error'}`);
    }
    return entry;
  }

  private handleMCPServerRemove(id: string): void {
    const view = this.requireView();
    this.agent.removeMCPServer(id);
    view.addSystemMessage('MCP server removed.');
  }

  private async handleMCPServerReconnect(id: string): Promise<MCPServerEntry> {
    const view = this.requireView();
    const entry = await this.agent.reconnectMCPServer(id);
    if (entry.status === 'connected') {
      view.addSystemMessage(`MCP server "${entry.name}" reconnected: ${entry.tools.length} tool${entry.tools.length !== 1 ? 's' : ''}.`);
    } else {
      view.addSystemMessage(`MCP server "${entry.name}" reconnection failed: ${entry.error ?? 'unknown error'}`);
    }
    return entry;
  }

  private async handleRefreshWebMCP(): Promise<void> {
    if (this.activeTabId !== undefined) {
      chrome.runtime.sendMessage(
        { type: 'FORCE_DISCOVER', payload: { tabId: this.activeTabId } },
        () => {},
      );
    }
  }

  private persistDisabledTools(): void {
    const disabled = Array.from(this.agent.getDisabledTools());
    void saveDisabledTools(disabled);
  }

  private handleToolToggle(toolName: string, enabled: boolean): void {
    this.agent.setToolEnabled(toolName, enabled);
    this.persistDisabledTools();
    logInfo('sidepanel', `Tool ${toolName} ${enabled ? 'enabled' : 'disabled'}`);
    this.scheduleRequestBudgetRefresh();
  }

  private handleToolGroupToggle(toolNames: string[], enabled: boolean): void {
    this.agent.setToolsEnabled(toolNames, enabled);
    this.persistDisabledTools();
    logInfo('sidepanel', `${toolNames.length} tools ${enabled ? 'enabled' : 'disabled'}`);
    this.scheduleRequestBudgetRefresh();
  }

  private handleConversationLoad(conversation: SavedConversation): void {
    const view = this.requireView();
    this.mcpAppHost.teardownAll();
    this.htmlAppHost.teardownAll();
    this.chatHistory.length = 0;
    this.chatHistory.push(...conversation.chatHistory as ChatTurn[]);
    this.latestRequestContextDebugInput = null;
    this.agent.setConversationCompactionState(conversation.compactionState);
    view.loadConversation(conversation);
    view.enableInput();
    logInfo('sidepanel', `Loaded conversation: ${conversation.title}`);
    this.scheduleRequestBudgetRefresh();
  }

  private handleConversationNew(): void {
    const view = this.requireView();
    this.mcpAppHost.teardownAll();
    this.htmlAppHost.teardownAll();
    this.chatHistory.length = 0;
    this.latestRequestContextDebugInput = null;
    this.agent.setConversationCompactionState(null);
    view.clearMessages();
    view.setCurrentConversationId(null);
    view.enableInput();
    logInfo('sidepanel', 'Started new conversation');
    this.scheduleRequestBudgetRefresh();
  }

  private handleConversationDelete(id: string): void {
    const view = this.requireView();
    view.deleteConversation(id);
    logInfo('sidepanel', `Deleted conversation: ${id}`);
  }

  private refreshWebMCPAnnotation(): void {
    const view = this.requireView();
    let totalTools = 0;
    let tabCount = 0;
    for (const entry of this.registry.values()) {
      if (entry.available && entry.tools?.length > 0) {
        totalTools += entry.tools.length;
        tabCount++;
      }
    }
    view.updateWebMCPStatusAllTabs(totalTools, tabCount);
  }

  private bindChromeListeners(): void {
    if (this.chromeListenersBound) return;
    this.chromeListenersBound = true;

    chrome.runtime.onMessage.addListener(this.handleRuntimeMessage);
    chrome.tabs.onActivated?.addListener(this.handleTabActivated);
    chrome.tabs.onUpdated?.addListener(this.handleTabUpdated);
    chrome.tabs.onRemoved?.addListener(this.handleTabRemoved);
  }

  private readonly handleRuntimeMessage = (message: any): void => {
    if (message.type !== 'WEBMCP_REGISTRY_UPDATE') return;

    const { tabId, entry } = message.payload;
    this.registry.set(tabId, entry);
    logInfo('sidepanel', `Registry update: tab=${tabId} available=${entry.available} tools=${entry.tools?.length ?? 0}`);

    this.refreshWebMCPAnnotation();

    if (entry.available && entry.tools?.length > 0) {
      this.agent.updateWebMCPTools(tabId, entry.tools, entry.url, entry.title);
      logInfo('sidepanel', `Wired ${entry.tools.length} WebMCP tools into agent for tab ${tabId}`);
    } else {
      this.agent.removeWebMCPToolsForTab(tabId);
    }
  };

  private readonly handleTabActivated = ({ tabId }: { tabId: number }): void => {
    invalidateBrowserContextSnapshotCache(tabId);
    this.activeTabId = tabId;
    void this.refreshCurrentTabContext(tabId);
  };

  private readonly handleTabUpdated = (
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ): void => {
    if (changeInfo.title || changeInfo.url || changeInfo.status) {
      invalidateBrowserContextSnapshotCache(tabId);
    }
    if (tabId !== this.activeTabId) return;
    if (!changeInfo.title && !changeInfo.url && !changeInfo.status) return;
    void this.refreshCurrentTabContext(tab.id);
  };

  private readonly handleTabRemoved = (tabId: number): void => {
    const view = this.requireView();
    invalidateBrowserContextSnapshotCache(tabId);
    this.registry.delete(tabId);
    this.agent.removeWebMCPToolsForTab(tabId);
    view.removeContextTab(tabId);
    this.refreshWebMCPAnnotation();
    if (tabId === this.activeTabId) {
      this.activeTabId = undefined;
      void this.refreshCurrentTabContext();
    }
  };

  private async restoreInitialTabAndRegistry(): Promise<void> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) {
      await this.refreshCurrentTabContext();
      return;
    }

    this.activeTabId = tab.id;
    await this.refreshCurrentTabContext(tab.id);

    chrome.runtime.sendMessage({ type: 'GET_REGISTRY' }, (reg) => {
      if (reg && Object.keys(reg).length > 0) {
        Object.entries(reg).forEach(([key, value]) => {
          const tid = Number(key);
          const entry = value as WebMCPRegistryEntry;
          this.registry.set(tid, entry);
          if (entry.available && entry.tools?.length > 0) {
            this.agent.updateWebMCPTools(tid, entry.tools, entry.url, entry.title);
          }
        });
        this.refreshWebMCPAnnotation();
        return;
      }

      logInfo('sidepanel', 'Registry empty at init, discovering all tabs');
      chrome.runtime.sendMessage({ type: 'DISCOVER_ALL' }, (res) => {
        logInfo('sidepanel', `DISCOVER_ALL complete: ${res?.discovered ?? 0} tabs`);
      });
    });
  }
}
