// ─── Side Panel Chat View ───────────────────────────────────────────────────
// Gemini-like sidebar chat UI. Modeled after radiology-copilot-view.ts.

import type {
  ConversationCompactionState,
  HtmlAppArtifact,
  HtmlAppArtifactMessageRef,
  HtmlAppRenderRequest,
  WebMCPRegistryEntry,
} from '../shared/types';
import {
  type RequestBudgetEstimate,
  type AutomationApprovalDecision,
  type ToolStepEvent,
  type ToolManifestEntry,
} from './agent';
import { getCategoryLabel } from './agent-runtime/tooling';
import {
  DEFAULT_AGENT_RECURSION_LIMIT,
  DEFAULT_CLAUDE_FIELDS,
  DEFAULT_OPENAI_FIELDS,
  DEFAULT_VLM_CONFIG,
  normalizeContextWindow,
  type ProviderFields,
} from '../shared/config';
import {
  loadConfigEditorState,
  saveConfigEditorState,
} from './chat-view/config-store';
import {
  loadSavedConversations,
  removeSavedConversation,
  setSavedConversationFavorite,
  sortSavedConversationsForDisplay,
  upsertSavedConversation,
} from './chat-view/conversation-store';
import type { ContextTabOption, SavedConversation, SavedConversationMessage } from './chat-view/types';
import { escapeHtml as escapeMessageHtml, formatAssistantMessage } from './message-format';
import { loadHtmlAppExecutionPreferences } from '../shared/storage';
import {
  spinnerSvg,
} from './chat-view/icons';
import { ComposerModule } from './chat-view/composer-module';
import { HtmlAppViewModule } from './chat-view/html-app-view-module';
import { MCPAppViewModule } from './chat-view/mcp-app-view-module';
import { PromptPanelModule } from './chat-view/prompt-panel-module';
import { buildChatViewShell } from './chat-view/shell';
import { ToolStepsModule } from './chat-view/tool-steps-module';
import { TranscriptModule } from './chat-view/transcript-module';
import { formatRelativeTime, renderToolInputParameters } from './chat-view/ui-format';
import {
  isToolVisibleToModel,
  type MCPAppRenderRequest,
  type MCPServerEntry,
  type MCPToolDescriptor,
} from './mcp-client';
import type { MCPAppLoadedResource } from './mcp-app-host';
import {
  cloneHtmlAppArtifacts,
  resolveHtmlAppArtifactRef,
  upsertHtmlAppArtifact,
} from './html-app-artifact-utils';
import {
  toSkillMentionReference,
  type SkillRegistryEntry,
} from './skills-registry';
import type { WorkflowRecordingStartResult, WorkflowRecordingStopResult } from '../shared/messages';
import type {
  SkillMention,
  SkillMentionReference,
  WorkflowDemonstration,
} from '../shared/types';
export type { SavedConversation, ContextTabOption } from './chat-view/types';

export interface ChatViewCallbacks {
  onSendMessage: (
    message: string,
    contextTabIds: number[],
    workflowDemonstrations: WorkflowDemonstration[],
    skillMention: SkillMention | null,
  ) => void;
  onStopGeneration: () => void;
  onConfigApply: (config: {
    mode: 'openai' | 'claude';
    fields: ProviderFields;
    recursionLimit: number;
    systemPrompt?: string;
  }) => void;
  onSystemPromptApply: (prompt: string) => void;
  onSkillRegistryApply: (skills: SkillRegistryEntry[]) => void;
  onVLMConfigApply: (config: { baseUrl: string; apiKey: string; model: string }) => void;
  onRefreshWebMCP: () => void;
  onToolToggle: (toolName: string, enabled: boolean) => void;
  onToolGroupToggle: (toolNames: string[], enabled: boolean) => void;
  onAutomationApprovalDecision: (requestId: string, decision: AutomationApprovalDecision) => void;
  onConversationLoad: (conversation: SavedConversation) => void;
  onConversationNew: () => void;
  onConversationDelete: (id: string) => void;
  onConversationDraftChange: () => void;
  onCopyContextDebug: () => Promise<string>;
  onHtmlAppExecutionPreferenceChange: (enabled: boolean) => void;
  onHtmlAppArtifactOpen: (
    ref: HtmlAppArtifactMessageRef,
    mode: 'inline' | 'tab',
    container?: HTMLElement,
  ) => void;
  onHtmlAppArtifactDownload: (ref: HtmlAppArtifactMessageRef) => void;
  onMCPServerAdd: (name: string, url: string, authToken?: string) => Promise<MCPServerEntry>;
  onMCPServerRemove: (id: string) => void;
  onMCPServerReconnect: (id: string) => Promise<MCPServerEntry>;
  onWorkflowRecordingStart: (tabId: number, options?: { title?: string; captureTypedValues?: boolean }) => Promise<WorkflowRecordingStartResult>;
  onWorkflowRecordingStop: (tabId: number) => Promise<WorkflowRecordingStopResult>;
}

type SurfaceMode = 'chat' | 'tools' | 'mcp' | 'conversations' | 'prompt' | 'config';

export class ChatView {
  private container: HTMLElement;
  private callbacks: ChatViewCallbacks;

  // DOM references
  private chatHeader!: HTMLElement;
  private chatBody!: HTMLElement;
  private messagesContainer!: HTMLElement;
  private inputContainer!: HTMLElement;
  private composerMainRow!: HTMLElement;
  private requestBudgetIndicator!: HTMLElement;
  private requestBudgetRingFill!: SVGCircleElement;
  private requestBudgetValue!: HTMLElement;
  private requestBudgetCopyButton!: HTMLButtonElement;
  private messageInput!: HTMLTextAreaElement;
  private recordButton!: HTMLButtonElement;
  private sendButton!: HTMLButtonElement;
  private contextTabsContainer!: HTMLElement;
  private contextAddButton!: HTMLButtonElement;
  private contextPicker!: HTMLElement;
  private skillMentionComposerSlot!: HTMLElement;
  private workflowDemonstrationsDock!: HTMLElement;
  private webmcpIndicator!: HTMLElement;
  private newChatButton!: HTMLButtonElement;
  private bottomNav!: HTMLElement;
  private configPanel!: HTMLElement;
  private promptPanel!: HTMLElement;
  private toolsPanel!: HTMLElement;
  private conversationsPanel!: HTMLElement;
  private mcpPanel!: HTMLElement;

  // Panel state
  private configMode: 'openai' | 'claude' = 'openai';
  private isConfigVisible = false;
  private isToolsVisible = false;
  private isConversationsVisible = false;
  private isMCPVisible = false;
  private isPromptVisible = false;
  private activeSurface: SurfaceMode = 'chat';

  // Current conversation
  private currentConversationId: string | null = null;
  private currentConversationFavorite = false;

  // Transcript + tool steps
  private transcriptModule!: TranscriptModule;
  private toolStepsModule!: ToolStepsModule;
  private composerModule!: ComposerModule;
  private htmlAppViewModule!: HtmlAppViewModule;
  private mcpAppViewModule!: MCPAppViewModule;
  private expandedToolCards = new Set<string>();
  private pendingToolCardFocusKey: string | null = null;

  private conversationMessages: SavedConversationMessage[] = [];
  private conversationHtmlAppArtifacts: HtmlAppArtifact[] = [];
  private streamingConversationMessageIndex: number | null = null;
  private draftChangeNotificationsEnabled = false;

  // Prompt surface
  private promptPanelModule!: PromptPanelModule;

  constructor(container: HTMLElement, callbacks: ChatViewCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.build();
    this.draftChangeNotificationsEnabled = true;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  public enableInput(): void {
    this.composerModule.setInputEnabled(true);
  }

  public disableInput(): void {
    this.composerModule.setInputEnabled(false);
  }

  public setAgentBusy(busy: boolean): void {
    this.composerModule.setAgentBusy(busy);
  }

  public setCurrentContextTab(tab: ContextTabOption | null): void {
    this.composerModule.setCurrentContextTab(tab);
  }

  public removeContextTab(tabId: number): void {
    this.composerModule.removeContextTab(tabId);
  }

  public getSelectedContextTabIds(): number[] {
    return this.composerModule.getSelectedContextTabIds();
  }

  public getConversationWorkflowDemonstrations(): WorkflowDemonstration[] {
    return this.composerModule.getConversationWorkflowDemonstrations();
  }

  public getStagedWorkflowDemonstrations(): WorkflowDemonstration[] {
    return this.composerModule.getStagedWorkflowDemonstrations();
  }

  public getSelectedSkillMention(): SkillMention | null {
    return this.composerModule.getSelectedSkillMention();
  }

  public getComposerSubmissionText(): string {
    return this.composerModule.getComposerSubmissionText();
  }

  private async copyRequestBudgetContext(): Promise<void> {
    if (!this.requestBudgetCopyButton) return;

    const originalLabel = this.requestBudgetCopyButton.textContent || 'Copy Context';
    this.requestBudgetCopyButton.disabled = true;

    try {
      const contextText = await this.callbacks.onCopyContextDebug();
      await navigator.clipboard.writeText(contextText);
      this.requestBudgetCopyButton.textContent = 'Copied';
    } catch (err) {
      console.warn('[chat-view] Failed to copy request budget context:', err);
      this.requestBudgetCopyButton.textContent = 'Copy failed';
    }

    window.setTimeout(() => {
      this.requestBudgetCopyButton.disabled = false;
      this.requestBudgetCopyButton.textContent = originalLabel;
    }, 1800);
  }

  public updateRequestBudget(estimate: RequestBudgetEstimate | null): void {
    if (!this.requestBudgetIndicator || !this.requestBudgetRingFill) return;

    if (!estimate) {
      this.requestBudgetIndicator.classList.remove('hidden');
      this.requestBudgetIndicator.classList.remove('is-pending');
      this.requestBudgetIndicator.title = 'Estimated Request Budget: 0%';
      this.requestBudgetIndicator.setAttribute('aria-label', 'Estimated Request Budget: 0%');
      this.requestBudgetValue.textContent = '0%';
      this.requestBudgetRingFill.style.stroke = '#6a6870';
      this.requestBudgetRingFill.style.strokeDasharray = '87.965';
      this.requestBudgetRingFill.style.strokeDashoffset = '87.965';
      return;
    }

    const clampedRatio = Math.max(0, Math.min(estimate.usageRatio, 1));
    const circumference = 2 * Math.PI * 14;
    const visualRatio = estimate.estimatedTokens > 0 ? Math.max(clampedRatio, 0.01) : 0;
    const dashOffset = circumference * (1 - visualRatio);
    const percent = estimate.usageRatio > 0 && estimate.usageRatio < 0.01
      ? `${(estimate.usageRatio * 100).toFixed(1)}%`
      : `${Math.max(0, Math.round(estimate.usageRatio * 100))}%`;
    const strokeColor = this.getRequestBudgetColor(clampedRatio);
    const tooltip = `Estimated Request Budget: ${percent} (${estimate.estimatedTokens.toLocaleString()} / ${estimate.contextWindow.toLocaleString()} tokens, approximate)`;

    this.requestBudgetIndicator.classList.remove('hidden');
  this.requestBudgetValue.textContent = percent;
    this.requestBudgetRingFill.style.stroke = strokeColor;
    this.requestBudgetRingFill.style.strokeDasharray = `${circumference.toFixed(3)}`;
    this.requestBudgetRingFill.style.strokeDashoffset = dashOffset.toFixed(3);
    this.requestBudgetIndicator.title = tooltip;
    this.requestBudgetIndicator.setAttribute('aria-label', tooltip);
  }

  public setRequestBudgetPending(pending: boolean): void {
    if (!this.requestBudgetIndicator) return;
    if (pending) {
      this.requestBudgetIndicator.classList.remove('hidden');
      this.requestBudgetIndicator.title = 'Estimating Request Budget...';
      this.requestBudgetIndicator.setAttribute('aria-label', 'Estimating Request Budget');
      this.requestBudgetValue.textContent = '...';
      this.requestBudgetRingFill.style.stroke = '#6a6870';
      this.requestBudgetRingFill.style.strokeDasharray = '87.965';
      this.requestBudgetRingFill.style.strokeDashoffset = '87.965';
    }
    this.requestBudgetIndicator.classList.toggle('is-pending', pending);
  }

  public addUserMessage(
    message: string,
    workflowDemonstrationIds: string[] = [],
    skillMention: SkillMentionReference | null = null,
  ): void {
    const attachedIds = this.composerModule.consumeAttachedWorkflowDemonstrations(workflowDemonstrationIds);

    const entry: SavedConversationMessage = {
      role: 'user',
      content: message,
      time: new Date().toLocaleTimeString(),
      ...(attachedIds.length > 0 ? { workflowDemonstrationIds: attachedIds } : {}),
      ...(skillMention ? { skillMention: toSkillMentionReference(skillMention) } : {}),
    };
    this.conversationMessages.push(entry);
    this.transcriptModule.renderConversationMessage(entry);
  }

  public addAssistantMessage(message: string): void {
    const entry: SavedConversationMessage = {
      role: 'assistant',
      content: message,
      time: new Date().toLocaleTimeString(),
    };
    this.conversationMessages.push(entry);
    this.transcriptModule.renderConversationMessage(entry);
  }

  public addSystemMessage(text: string): void {
    const entry: SavedConversationMessage = {
      role: 'system',
      content: text,
      time: '',
    };
    this.conversationMessages.push(entry);
    this.transcriptModule.renderConversationMessage(entry);
  }

  public addHtmlAppArtifactMessage(request: HtmlAppRenderRequest): HTMLElement | null {
    this.registerHtmlAppArtifact(request);

    const entry: SavedConversationMessage = {
      role: 'system',
      content: `HTML App Artifact ready: ${request.title}`,
      time: '',
      htmlAppArtifactRefs: [{
        artifactId: request.artifactId,
        revisionId: request.revisionId,
      }],
    };
    this.conversationMessages.push(entry);

    const messageEl = this.transcriptModule.renderConversationMessage(entry);
    const cards = messageEl.querySelectorAll<HTMLElement>('[data-html-app-artifact-id][data-html-app-revision-id]');
    return [...cards].find((card) =>
      card.dataset.htmlAppArtifactId === request.artifactId
      && card.dataset.htmlAppRevisionId === request.revisionId,
    ) ?? null;
  }

  public showTypingIndicator(): void {
    this.transcriptModule.showTypingIndicator();
  }

  public hideTypingIndicator(): void {
    this.transcriptModule.hideTypingIndicator();
  }

  /** Streaming: update or create the current assistant message bubble */
  public streamAssistantMessage(message: string): void {
    if (this.streamingConversationMessageIndex == null) {
      this.conversationMessages.push({
        role: 'assistant',
        content: message,
        time: new Date().toLocaleTimeString(),
      });
      this.streamingConversationMessageIndex = this.conversationMessages.length - 1;
    } else {
      this.conversationMessages[this.streamingConversationMessageIndex].content = message;
    }
    this.transcriptModule.streamAssistantMessage(message);
  }

  public finalizeStreaming(): void {
    this.streamingConversationMessageIndex = null;
    this.transcriptModule.finalizeStreaming();
  }

  /** Update WebMCP status indicator */
  public updateWebMCPStatus(tabId: number, entry: WebMCPRegistryEntry | null): void {
    if (!entry) {
      this.webmcpIndicator.innerHTML = `<span class="status-dot unavailable"></span> No tab`;
      return;
    }
    if (entry.available) {
      this.webmcpIndicator.innerHTML =
        `<span class="status-dot available"></span> WebMCP: ${entry.tools.length} tool${entry.tools.length !== 1 ? 's' : ''}`;
    } else {
      this.webmcpIndicator.innerHTML =
        `<span class="status-dot unavailable"></span> WebMCP: N/A`;
    }
  }

  /** Update WebMCP status showing total tools across all tabs */
  public updateWebMCPStatusAllTabs(totalTools: number, tabCount: number): void {
    if (totalTools > 0) {
      this.webmcpIndicator.innerHTML =
        `<span class="status-dot available"></span> WebMCP: ${totalTools} tool${totalTools !== 1 ? 's' : ''} (${tabCount} tab${tabCount !== 1 ? 's' : ''})`;
    } else {
      this.webmcpIndicator.innerHTML =
        `<span class="status-dot unavailable"></span> WebMCP: N/A`;
    }
  }

  /** Update MCP server connection status */
  public updateConnectionStatus(status: string): void {
    const el = this.chatHeader.querySelector('.connection-status');
    if (el) el.textContent = status;
  }

  /** Tool steps tracker (collapsible) — matches in-person reference */
  public updateToolSteps(steps: ToolStepEvent[]): void {
    this.toolStepsModule.update(steps);
  }

  /**
   * Finalize the current tool steps widget so a new query gets a fresh one.
   * The existing widget stays in the chat history.
   */
  public finalizeToolSteps(): void {
    this.toolStepsModule.finalize();
  }

  /** Create an inert MCP App card while Brow fetches and validates the UI resource. */
  public renderMCPAppLoading(request: MCPAppRenderRequest): HTMLElement {
    return this.mcpAppViewModule.renderLoading(request);
  }

  public renderMCPAppApproval(
    container: HTMLElement,
    request: MCPAppRenderRequest,
    resource: MCPAppLoadedResource,
    callbacks: { onApprove: () => void; onSkip: () => void },
  ): void {
    this.mcpAppViewModule.renderApproval(container, request, resource, callbacks);
  }

  public renderMCPAppFrame(
    container: HTMLElement,
    request: MCPAppRenderRequest,
    resource: MCPAppLoadedResource,
  ): HTMLIFrameElement {
    return this.mcpAppViewModule.renderFrame(container, request, resource);
  }

  public resizeMCPAppFrame(iframe: HTMLIFrameElement, height: number): void {
    this.mcpAppViewModule.resizeFrame(iframe, height);
  }

  public renderMCPAppError(
    container: HTMLElement,
    request: MCPAppRenderRequest,
    message: string,
  ): void {
    this.mcpAppViewModule.renderError(container, request, message);
  }

  public renderMCPAppSkipped(container: HTMLElement, request: MCPAppRenderRequest): void {
    this.mcpAppViewModule.renderSkipped(container, request);
  }

  public renderHtmlAppArtifactApproval(
    container: HTMLElement,
    request: HtmlAppRenderRequest,
    callbacks: {
      onRenderInline: (options: { alwaysAllow: boolean }) => void;
      onOpenTab: (options: { alwaysAllow: boolean }) => void;
      onRenderBoth: (options: { alwaysAllow: boolean }) => void;
      onSkip: () => void;
    },
    options: { showAlwaysAllowToggle?: boolean } = {},
  ): void {
    this.htmlAppViewModule.renderApproval(container, request, callbacks, options);
  }

  public renderHtmlAppArtifactFrame(
    container: HTMLElement,
    request: HtmlAppRenderRequest,
  ): HTMLIFrameElement {
    return this.htmlAppViewModule.renderFrame(container, request);
  }

  public resizeHtmlAppArtifactFrame(iframe: HTMLIFrameElement, height: number): void {
    this.htmlAppViewModule.resizeFrame(iframe, height);
  }

  public renderHtmlAppArtifactOpened(container: HTMLElement, request: HtmlAppRenderRequest): void {
    this.htmlAppViewModule.renderOpened(container, request);
  }

  public renderHtmlAppArtifactSkipped(container: HTMLElement, request: HtmlAppRenderRequest): void {
    this.htmlAppViewModule.renderSkipped(container, request);
  }

  public renderHtmlAppArtifactError(
    container: HTMLElement,
    request: HtmlAppRenderRequest,
    message: string,
  ): void {
    this.htmlAppViewModule.renderError(container, request.title, message);
  }

  public getCurrentConversationId(): string | null {
    return this.currentConversationId;
  }

  public resolveHtmlAppArtifact(
    ref: HtmlAppArtifactMessageRef,
    options: { preferLatest?: boolean } = {},
  ): { artifact: HtmlAppArtifact; revision: HtmlAppArtifact['revisions'][number]; conversationId: string | null } | null {
    const resolved = resolveHtmlAppArtifactRef(this.conversationHtmlAppArtifacts, ref, options);
    if (!resolved) return null;

    return {
      ...resolved,
      conversationId: this.currentConversationId,
    };
  }

  // ─── Build ──────────────────────────────────────────────────────────────

  private build(): void {
    const shell = buildChatViewShell(this.container);
    this.chatHeader = shell.chatHeader;
    this.chatBody = shell.chatBody;
    this.messagesContainer = shell.messagesContainer;
    this.inputContainer = shell.inputContainer;
    this.composerMainRow = shell.composerMainRow;
    this.requestBudgetIndicator = shell.requestBudgetIndicator;
    this.requestBudgetRingFill = shell.requestBudgetRingFill;
    this.requestBudgetValue = shell.requestBudgetValue;
    this.requestBudgetCopyButton = shell.requestBudgetCopyButton;
    this.messageInput = shell.messageInput;
    this.recordButton = shell.recordButton;
    this.sendButton = shell.sendButton;
    this.contextTabsContainer = shell.contextTabsContainer;
    this.contextAddButton = shell.contextAddButton;
    this.contextPicker = shell.contextPicker;
    this.skillMentionComposerSlot = shell.skillMentionComposerSlot;
    this.workflowDemonstrationsDock = shell.workflowDemonstrationsDock;
    this.webmcpIndicator = shell.webmcpIndicator;
    this.newChatButton = shell.newChatButton;
    this.bottomNav = shell.bottomNav;
    this.toolsPanel = shell.toolsPanel;
    this.mcpPanel = shell.mcpPanel;
    this.conversationsPanel = shell.conversationsPanel;
    this.configPanel = shell.configPanel;
    this.promptPanel = shell.promptPanel;
    this.promptPanelModule = new PromptPanelModule(this.promptPanel, {
      onClosePanel: () => this.setActiveSurface('chat'),
      onSystemPromptApply: (prompt) => this.callbacks.onSystemPromptApply(prompt),
      onSkillCatalogChanged: () => this.composerModule.refreshSkillPickerIfOpen(),
      onSkillRegistryApply: (skills) => this.callbacks.onSkillRegistryApply(skills),
    });
    this.composerModule = new ComposerModule({
      container: this.container,
      inputContainer: this.inputContainer,
      messageInput: this.messageInput,
      recordButton: this.recordButton,
      sendButton: this.sendButton,
      contextTabsContainer: this.contextTabsContainer,
      contextAddButton: this.contextAddButton,
      contextPicker: this.contextPicker,
      skillMentionComposerSlot: this.skillMentionComposerSlot,
      workflowDemonstrationsDock: this.workflowDemonstrationsDock,
    }, {
      onSendMessage: (message, contextTabIds, workflowDemonstrations, skillMention) => {
        this.callbacks.onSendMessage(message, contextTabIds, workflowDemonstrations, skillMention);
      },
      onStopGeneration: () => this.callbacks.onStopGeneration(),
      onWorkflowRecordingStart: (tabId, options) => this.callbacks.onWorkflowRecordingStart(tabId, options),
      onWorkflowRecordingStop: (tabId) => this.callbacks.onWorkflowRecordingStop(tabId),
      getAvailableSkillMentionOptions: (query, context) => (
        this.promptPanelModule.getAvailableSkillMentionOptions(query, context)
      ),
      onDraftChange: () => this.notifyConversationDraftChange(),
      onSystemMessage: (text) => this.addSystemMessage(text),
      isWorkflowDemonstrationReferenced: (id) => (
        this.conversationMessages.some((message) => message.workflowDemonstrationIds?.includes(id))
      ),
      escapeHtml: (text) => this.escapeHtml(text),
    });
    this.transcriptModule = new TranscriptModule(this.messagesContainer, {
      escapeHtml: (text) => this.escapeHtml(text),
      formatMessage: (message) => this.formatMessage(message),
      createSkillMentionChip: (mention, placement) => this.composerModule.createSkillMentionChip(mention, placement),
      createWorkflowDemonstrationMessageCard: (demonstration) => (
        this.composerModule.createWorkflowDemonstrationMessageCard(demonstration)
      ),
      createHtmlAppArtifactMessageCard: (ref) => this.htmlAppViewModule.createArtifactMessageCard(ref),
      getWorkflowDemonstrationById: (id) => this.composerModule.getWorkflowDemonstrationById(id),
      requestScrollToBottom: () => this.scrollToBottom(),
    });
    this.toolStepsModule = new ToolStepsModule(this.messagesContainer, {
      escapeHtml: (text) => this.escapeHtml(text),
      getStreamingElement: () => this.transcriptModule.getStreamingElement(),
      onAutomationApprovalDecision: (requestId, decision) => this.callbacks.onAutomationApprovalDecision(requestId, decision),
      requestScrollToBottom: () => this.scrollToBottom(),
    });
    this.htmlAppViewModule = new HtmlAppViewModule({
      escapeHtml: (text) => this.escapeHtml(text),
      requestScrollToBottom: () => this.scrollToBottom(),
      resolveArtifactRef: (ref, options) => this.resolveHtmlAppArtifact(ref, options),
      onOpenInline: (ref, container) => this.callbacks.onHtmlAppArtifactOpen(ref, 'inline', container),
      onOpenTab: (ref) => this.callbacks.onHtmlAppArtifactOpen(ref, 'tab'),
      onDownload: (ref) => this.callbacks.onHtmlAppArtifactDownload(ref),
    });
    this.mcpAppViewModule = new MCPAppViewModule(this.messagesContainer, {
      addSystemMessage: (text) => this.addSystemMessage(text),
      escapeHtml: (text) => this.escapeHtml(text),
      requestScrollToBottom: () => this.scrollToBottom(),
    });

    this.requestBudgetCopyButton.addEventListener('click', () => {
      void this.copyRequestBudgetContext();
    });
    this.newChatButton.addEventListener('click', () => this.startNewConversation());
    shell.refreshWebmcpButton.addEventListener('click', () => this.callbacks.onRefreshWebMCP());

    this.bindMCPPanelInteractions();
    this.bindConversationsPanelInteractions();
    this.bindConfigPanelInteractions();

    this.setupEventListeners();
    this.setActiveSurface('chat');
    void this.promptPanelModule.initialize();
    this.composerModule.initialize();
  }

  private setupEventListeners(): void {
    this.bottomNav.querySelectorAll<HTMLButtonElement>('.bottom-nav-btn[data-surface]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const surface = btn.dataset.surface as SurfaceMode;
        switch (surface) {
          case 'tools':
            this.toggleToolsPanel();
            break;
          case 'mcp':
            this.toggleMCPPanel();
            break;
          case 'conversations':
            this.toggleConversationsPanel();
            break;
          case 'prompt':
            this.togglePromptPanel();
            break;
          case 'config':
            this.toggleConfigPanel();
            break;
          default:
            this.setActiveSurface('chat');
        }
      });
    });
  }

  private notifyConversationDraftChange(): void {
    if (!this.draftChangeNotificationsEnabled) return;
    this.callbacks.onConversationDraftChange();
  }

  private getRequestBudgetColor(usageRatio: number): string {
    const clamped = Math.max(0, Math.min(usageRatio, 1));
    const saturation = Math.round(clamped * 82);
    const lightness = Math.round(58 - (clamped * 8));
    return `hsl(0 ${saturation}% ${lightness}%)`;
  }

  private startNewConversation(): void {
    this.callbacks.onConversationNew();
    this.currentConversationId = null;
    this.currentConversationFavorite = false;
    this.setActiveSurface('chat');
  }

  // ─── Tools Panel ────────────────────────────────────────────────────────

  private setActiveSurface(surface: SurfaceMode): void {
    this.activeSurface = surface;
    this.isToolsVisible = surface === 'tools';
    this.isMCPVisible = surface === 'mcp';
    this.isConversationsVisible = surface === 'conversations';
    this.isPromptVisible = surface === 'prompt';
    this.isConfigVisible = surface === 'config';

    if (surface !== 'chat') {
      this.composerModule.dismissPicker();
    }

    const overlayPanelVisible = this.isConfigVisible || this.isPromptVisible;
    this.chatBody.style.display = overlayPanelVisible ? 'none' : 'flex';
    this.configPanel.style.display = this.isConfigVisible ? 'flex' : 'none';
    this.promptPanel.style.display = this.isPromptVisible ? 'flex' : 'none';
    this.toolsPanel.style.display = this.isToolsVisible ? 'flex' : 'none';
    this.mcpPanel.style.display = this.isMCPVisible ? 'flex' : 'none';
    this.conversationsPanel.style.display = this.isConversationsVisible ? 'flex' : 'none';

    const inBodyPanel = this.isToolsVisible || this.isMCPVisible || this.isConversationsVisible;
    this.messagesContainer.style.display = inBodyPanel ? 'none' : 'flex';
    this.inputContainer.style.display = inBodyPanel ? 'none' : 'flex';

    this.bottomNav.querySelectorAll<HTMLElement>('.bottom-nav-btn[data-surface]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.surface === surface);
    });

    if (surface === 'tools') {
      this.refreshToolsPanel();
    } else if (surface === 'mcp') {
      this.refreshMCPPanel();
    } else if (surface === 'conversations') {
      this.refreshConversationsPanel();
    } else if (surface === 'prompt') {
      this.promptPanelModule.populateFields();
    } else if (surface === 'config') {
      this.populateConfigFields();
    }
  }

  private toggleToolsPanel(): void {
    this.setActiveSurface(this.activeSurface === 'tools' ? 'chat' : 'tools');
  }

  private toolManifestProvider: (() => ToolManifestEntry[]) | null = null;

  /** Set the provider function for getting tool manifest (called from index.ts) */
  public setToolManifestProvider(provider: () => ToolManifestEntry[]): void {
    this.toolManifestProvider = provider;
  }

  private toggleToolCard(key: string): void {
    if (this.expandedToolCards.has(key)) {
      this.expandedToolCards.delete(key);
      return;
    }
    this.expandedToolCards.add(key);
  }

  private openToolInToolsPanel(toolName: string): void {
    const key = `tools:${toolName}`;
    this.expandedToolCards.add(key);
    this.pendingToolCardFocusKey = key;
    this.setActiveSurface('tools');
    this.focusPendingToolCard();
  }

  private focusPendingToolCard(): void {
    const key = this.pendingToolCardFocusKey;
    if (!key) return;

    requestAnimationFrame(() => {
      const target = Array.from(this.toolsPanel.querySelectorAll<HTMLElement>('[data-tool-card-key]'))
        .find((el) => el.dataset.toolCardKey === key);
      if (!target) return;
      this.pendingToolCardFocusKey = null;
      target.closest('.tool-card')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.focus({ preventScroll: true });
    });
  }

  private getToolTypeLabel(toolEntry: ToolManifestEntry): string {
    if (toolEntry.source === 'mcp') return 'MCP';
    if (toolEntry.source === 'webmcp') return 'WebMCP';
    return getCategoryLabel(toolEntry.category);
  }

  private renderGlobalToolCard(toolEntry: ToolManifestEntry): string {
    const key = `tools:${toolEntry.name}`;
    const expanded = this.expandedToolCards.has(key);
    const title = toolEntry.title || toolEntry.name;
    const description = toolEntry.description || 'No description provided.';
    const typeLabel = this.getToolTypeLabel(toolEntry);

    return `
      <div class="tools-item tool-card${expanded ? ' expanded' : ''}">
        <div class="tools-item-row">
          <label class="tools-toggle-switch" title="${toolEntry.enabled ? 'Disable tool' : 'Enable tool'}">
            <input type="checkbox" data-tool="${this.escapeHtml(toolEntry.name)}" ${toolEntry.enabled ? 'checked' : ''} />
            <span class="tools-toggle-slider"></span>
          </label>
          <button class="tool-card-summary" type="button" data-tool-card-key="${this.escapeHtml(key)}" aria-expanded="${expanded}">
            <span class="tool-card-copy">
              <span class="tool-card-title-row">
                <span class="tools-item-name">${this.escapeHtml(title)}</span>
                <span class="tool-card-badge type">${this.escapeHtml(typeLabel)}</span>
              </span>
            </span>
            <span class="tools-item-arrow" aria-hidden="true">&rsaquo;</span>
          </button>
        </div>
        ${expanded ? this.renderToolCardDetails({
          title,
          technicalName: toolEntry.name,
          description,
          sourceLabel: toolEntry.sourceLabel,
          inputSchema: toolEntry.inputSchema,
          visibility: toolEntry.visibility,
          resourceUri: toolEntry.resourceUri,
        }) : ''}
      </div>`;
  }

  private renderMCPToolCard(server: MCPServerEntry, toolDescriptor: MCPToolDescriptor): string {
    const title = toolDescriptor.title || toolDescriptor.name;
    const safeId = server.id.replace(/[^a-zA-Z0-9]/g, '');
    const toolName = `mcp_${safeId}_${toolDescriptor.name}`;

    return `
      <div class="mcp-tool-card mini">
        <button class="mcp-tool-card-summary" type="button" data-tool-name="${this.escapeHtml(toolName)}" title="Open in Tools">
          <span class="mcp-tool-mini-title">${this.escapeHtml(title)}</span>
        </button>
      </div>`;
  }

  private renderToolCardBadges(
    sourceLabel: string,
    visibility?: Array<'model' | 'app'>,
    resourceUri?: string,
  ): string {
    const badges = [`<span class="tool-card-badge source">${this.escapeHtml(sourceLabel)}</span>`];
    for (const scope of visibility ?? []) {
      badges.push(`<span class="tool-card-badge">${this.escapeHtml(scope)}</span>`);
    }
    if (resourceUri) {
      badges.push('<span class="tool-card-badge ui">UI</span>');
    }
    return `<span class="tool-card-badges">${badges.join('')}</span>`;
  }

  private renderToolCardDetails(details: {
    title: string;
    technicalName: string;
    description: string;
    sourceLabel: string;
    inputSchema?: Record<string, unknown>;
    visibility?: Array<'model' | 'app'>;
    resourceUri?: string;
  }): string {
    const visibility = details.visibility?.length ? details.visibility.join(' + ') : undefined;
    const resourceHtml = details.resourceUri
      ? `<div class="tool-card-meta-row"><span>UI Resource</span><strong>${this.escapeHtml(details.resourceUri)}</strong></div>`
      : '';
    const visibilityHtml = visibility
      ? `<div class="tool-card-meta-row"><span>Visibility</span><strong>${this.escapeHtml(visibility)}</strong></div>`
      : '';

    return `
      <div class="tool-card-details">
        <div class="tool-card-detail-section">
          <span class="tool-card-detail-label">Description</span>
          <p>${this.escapeHtml(details.description || 'No description provided.')}</p>
        </div>
        <div class="tool-card-meta-grid">
          <div class="tool-card-meta-row"><span>Source</span><strong>${this.escapeHtml(details.sourceLabel)}</strong></div>
          <div class="tool-card-meta-row"><span>Name</span><strong>${this.escapeHtml(details.technicalName)}</strong></div>
          ${visibilityHtml}
          ${resourceHtml}
        </div>
        <div class="tool-card-detail-section">
          <span class="tool-card-detail-label">Arguments</span>
          ${renderToolInputParameters(details.inputSchema)}
        </div>
      </div>`;
  }

  /** Refresh the tools panel with current manifest */
  public refreshToolsPanel(): void {
    if (!this.toolManifestProvider) return;
    const manifest = this.toolManifestProvider();

    // Group by category
    const groups = new Map<string, ToolManifestEntry[]>();
    for (const entry of manifest) {
      const list = groups.get(entry.category) ?? [];
      list.push(entry);
      groups.set(entry.category, list);
    }

      const container = this.toolsPanel.querySelector('.tools-groups-container')!;
      container.innerHTML = '';

    for (const [category, tools] of groups.entries()) {
      const enabledCount = tools.filter(t => t.enabled).length;
      const allOn = enabledCount === tools.length;
      const allOff = enabledCount === 0;
      const groupLabel = getCategoryLabel(category);

      const groupEl = document.createElement('div');
      groupEl.className = `tools-group${category === 'browser_automation' ? ' dangerous' : ''}`;
      const warningHtml = category === 'browser_automation'
        ? `<div class="tools-group-warning">These tools can modify pages, navigate tabs, or execute actions. Enable them only when you want Brow to automate the browser.</div>`
        : '';

      groupEl.innerHTML = `
        <div class="tools-group-header">
          <span class="tools-group-name">${this.escapeHtml(groupLabel)}</span>
          <span class="tools-group-count">(${enabledCount}/${tools.length})</span>
          <button class="tools-group-toggle-btn ${allOn ? 'all-on' : allOff ? 'all-off' : 'partial'}"
                  data-category="${this.escapeHtml(category)}"
                  data-action="${allOn ? 'off' : 'on'}">
            ${allOn ? 'All on' : allOff ? 'All off' : `${enabledCount} on`}
          </button>
        </div>
        ${warningHtml}
        <div class="tools-group-items">
          ${tools.map(t => this.renderGlobalToolCard(t)).join('')}
        </div>`;

      // Group toggle button
      groupEl.querySelector('.tools-group-toggle-btn')?.addEventListener('click', (e) => {
        const btn = e.currentTarget as HTMLElement;
        const action = btn.dataset.action;
        const names = tools.map(t => t.name);
        this.callbacks.onToolGroupToggle(names, action === 'on');
        // Re-render after a tick
        setTimeout(() => this.refreshToolsPanel(), 50);
      });

      // Individual toggles
      groupEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          const toolName = cb.dataset.tool!;
          this.callbacks.onToolToggle(toolName, cb.checked);
          // Re-render group header counts
          setTimeout(() => this.refreshToolsPanel(), 50);
        });
      });

      groupEl.querySelectorAll<HTMLButtonElement>('.tool-card-summary').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const key = btn.dataset.toolCardKey;
          if (!key) return;
          this.toggleToolCard(key);
          this.refreshToolsPanel();
        });
      });

      container.appendChild(groupEl);
    }

    this.focusPendingToolCard();
  }

  // ─── Config Panel ───────────────────────────────────────────────────────

  // ─── MCP Servers Panel ──────────────────────────────────────────────────

  private toggleMCPPanel(): void {
    this.setActiveSurface(this.activeSurface === 'mcp' ? 'chat' : 'mcp');
  }

  private mcpServerProvider: (() => MCPServerEntry[]) | null = null;

  /** Set the provider for getting MCP server list */
  public setMCPServerProvider(provider: () => MCPServerEntry[]): void {
    this.mcpServerProvider = provider;
  }

  private bindMCPPanelInteractions(): void {
    this.mcpPanel.addEventListener('keydown', (e) => e.stopPropagation());
    this.mcpPanel.addEventListener('keyup', (e) => e.stopPropagation());
    this.mcpPanel.addEventListener('keypress', (e) => e.stopPropagation());

    this.mcpPanel.querySelector('.mcp-add-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.handleAddMCPServer();
    });

    this.mcpPanel.querySelector('.mcp-add-url')?.addEventListener('keydown', async (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        await this.handleAddMCPServer();
      }
    });
  }

  private async handleAddMCPServer(): Promise<void> {
    const nameInput = this.mcpPanel.querySelector('.mcp-add-name') as HTMLInputElement;
    const urlInput = this.mcpPanel.querySelector('.mcp-add-url') as HTMLInputElement;
    const tokenInput = this.mcpPanel.querySelector('.mcp-add-token') as HTMLInputElement;
    const statusEl = this.mcpPanel.querySelector('.mcp-add-status') as HTMLElement;
    const addBtn = this.mcpPanel.querySelector('.mcp-add-btn') as HTMLButtonElement;

    const name = nameInput?.value.trim();
    const url = urlInput?.value.trim();
    const token = tokenInput?.value.trim() || undefined;

    if (!name || !url) {
      if (statusEl) { statusEl.textContent = 'Name and URL are required.'; statusEl.className = 'mcp-add-status error'; }
      return;
    }

    // Validate URL
    try {
      new URL(url);
    } catch {
      if (statusEl) { statusEl.textContent = 'Invalid URL format.'; statusEl.className = 'mcp-add-status error'; }
      return;
    }

    if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Connecting…'; }
    if (statusEl) { statusEl.textContent = 'Connecting to server…'; statusEl.className = 'mcp-add-status'; }

    try {
      const entry = await this.callbacks.onMCPServerAdd(name, url, token);

      if (entry.status === 'connected') {
        if (statusEl) {
          statusEl.textContent = `Connected! ${entry.tools.length} tool${entry.tools.length !== 1 ? 's' : ''} discovered.`;
          statusEl.className = 'mcp-add-status success';
        }
        // Clear inputs
        if (nameInput) nameInput.value = '';
        if (urlInput) urlInput.value = '';
        if (tokenInput) tokenInput.value = '';
        // Refresh panel + tools panel
        this.refreshMCPPanel();
        if (this.toolManifestProvider) this.refreshToolsPanel();
      } else {
        if (statusEl) {
          statusEl.textContent = `Error: ${entry.error ?? 'Connection failed'}`;
          statusEl.className = 'mcp-add-status error';
        }
      }
    } catch (err: any) {
      if (statusEl) {
        statusEl.textContent = `Error: ${err.message ?? err}`;
        statusEl.className = 'mcp-add-status error';
      }
    } finally {
      if (addBtn) { addBtn.disabled = false; addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Connect`; }
    }
  }

  public refreshMCPPanel(): void {
    if (!this.mcpServerProvider) return;
    const servers = this.mcpServerProvider();
    const container = this.mcpPanel.querySelector('.mcp-servers-list')!;
    container.innerHTML = '';

    if (servers.length === 0) {
      container.innerHTML = `<div class="mcp-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
          <line x1="6" y1="6" x2="6.01" y2="6"></line>
          <line x1="6" y1="18" x2="6.01" y2="18"></line>
        </svg>
        <p>No MCP servers connected</p>
        <p class="mcp-empty-hint">Add a server above to discover its tools</p>
      </div>`;
      return;
    }

    for (const server of servers) {
      const el = document.createElement('div');
      el.className = 'mcp-server-item';

      const statusDot = server.status === 'connected' ? 'available'
        : server.status === 'connecting' ? 'connecting'
        : 'unavailable';

      const statusText = server.status === 'connected'
        ? `${server.tools.length} tool${server.tools.length !== 1 ? 's' : ''}`
        : server.status === 'connecting' ? 'Connecting…'
        : server.error ? `Error: ${server.error.length > 40 ? server.error.slice(0, 40) + '…' : server.error}`
        : 'Disconnected';

      // Build tool list for connected servers
      let toolsHtml = '';
      const visibleTools = server.tools.filter(isToolVisibleToModel);
      if (server.status === 'connected' && visibleTools.length > 0) {
        toolsHtml = `<div class="mcp-server-tools">
          ${visibleTools.map(t => this.renderMCPToolCard(server, t)).join('')}
        </div>`;
      } else if (server.status === 'connected') {
        toolsHtml = `<div class="mcp-server-tools empty">
          <span>No model-visible tools discovered</span>
        </div>`;
      }

      el.innerHTML = `
        <div class="mcp-server-header">
          <div class="mcp-server-info">
            <span class="status-dot ${statusDot}"></span>
            <div class="mcp-server-details">
	              <span class="mcp-server-name">${this.escapeHtml(server.name)}</span>
	              <span class="mcp-server-url">${this.escapeHtml(server.url)}</span>
	              <span class="mcp-server-status">${this.escapeHtml(statusText)}</span>
	            </div>
	          </div>
          <div class="mcp-server-actions">
            <button class="mcp-reconnect-btn" title="Reconnect" data-id="${server.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12">
                <polyline points="23 4 23 10 17 10"></polyline>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
              </svg>
            </button>
            <button class="mcp-remove-btn" title="Remove server" data-id="${server.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        ${toolsHtml}`;

      // Reconnect button
      el.querySelector('.mcp-reconnect-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget as HTMLButtonElement;
        btn.classList.add('spinning');
        btn.disabled = true;
        try {
          await this.callbacks.onMCPServerReconnect(server.id);
        } catch { /* handled by agent */ }
        btn.classList.remove('spinning');
        btn.disabled = false;
        this.refreshMCPPanel();
        if (this.toolManifestProvider) this.refreshToolsPanel();
      });

      // Remove button
      el.querySelector('.mcp-remove-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onMCPServerRemove(server.id);
        this.refreshMCPPanel();
        if (this.toolManifestProvider) this.refreshToolsPanel();
      });

      el.querySelectorAll<HTMLButtonElement>('.mcp-tool-card-summary').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const toolName = btn.dataset.toolName;
          if (!toolName) return;
          this.openToolInToolsPanel(toolName);
        });
      });

      container.appendChild(el);
    }
  }

  // ─── Conversations Panel ────────────────────────────────────────────────

  private toggleConversationsPanel(): void {
    this.setActiveSurface(this.activeSurface === 'conversations' ? 'chat' : 'conversations');
  }

  private bindConversationsPanelInteractions(): void {
    this.conversationsPanel.querySelector('.conversations-new-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.startNewConversation();
    });
  }

  /** Refresh the conversations list from storage */
  public refreshConversationsPanel(): void {
    void loadSavedConversations().then((conversations) => {
      const container = this.conversationsPanel.querySelector('.conversations-list-container')!;
      container.innerHTML = '';

      if (conversations.length === 0) {
        container.innerHTML = `<div class="conversations-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <p>No saved conversations yet</p>
          <p class="conversations-empty-hint">Your conversations are saved automatically</p>
        </div>`;
        return;
      }

      const sorted = sortSavedConversationsForDisplay(conversations);

      for (const convo of sorted) {
        const el = document.createElement('div');
        el.className = 'conversation-item' + (this.currentConversationId === convo.id ? ' active' : '');
        const date = new Date(convo.updatedAt);
        const timeStr = formatRelativeTime(date);
        const msgCount = convo.messages.filter(m => m.role === 'user').length;

        el.innerHTML = `
          <div class="conversation-item-content">
            <div class="conversation-item-title">${this.escapeHtml(convo.title)}</div>
            <div class="conversation-item-meta">
              ${convo.favorite ? '<span class="conversation-item-favorite-label">Favorite</span><span>·</span>' : ''}
              <span>${msgCount} message${msgCount !== 1 ? 's' : ''}</span>
              <span>·</span>
              <span>${timeStr}</span>
            </div>
          </div>
          <div class="conversation-item-actions">
            <button
              class="conversation-favorite-btn${convo.favorite ? ' is-favorite' : ''}"
              type="button"
              title="${convo.favorite ? 'Remove favorite' : 'Mark as favorite'}"
              aria-label="${convo.favorite ? 'Remove favorite' : 'Mark as favorite'}"
              aria-pressed="${convo.favorite ? 'true' : 'false'}"
              data-id="${convo.id}"
            >
              <svg viewBox="0 0 24 24" fill="${convo.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" width="14" height="14" aria-hidden="true">
                <path d="M12 3.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 18.27l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z"></path>
              </svg>
            </button>
            <button class="conversation-delete-btn" type="button" title="Delete conversation" data-id="${convo.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>`;

        // Click to load conversation
        el.querySelector('.conversation-item-content')?.addEventListener('click', () => {
          this.currentConversationId = convo.id;
          this.currentConversationFavorite = convo.favorite === true;
          this.callbacks.onConversationLoad(convo);
          this.setActiveSurface('chat');
        });

        el.querySelector('.conversation-favorite-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          const nextFavorite = !(convo.favorite === true);
          const shouldTrackCurrentConversation = this.currentConversationId === convo.id;
          const previousFavorite = this.currentConversationFavorite;

          if (shouldTrackCurrentConversation) {
            this.currentConversationFavorite = nextFavorite;
          }

          void setSavedConversationFavorite(convo.id, nextFavorite)
            .then((updated) => {
              if (!updated && shouldTrackCurrentConversation) {
                this.currentConversationFavorite = previousFavorite;
              }
              this.refreshConversationsPanel();
            })
            .catch((error) => {
              console.warn('[chat-view] Failed to update conversation favorite:', error);
              if (shouldTrackCurrentConversation) {
                this.currentConversationFavorite = previousFavorite;
              }
              this.refreshConversationsPanel();
            });
        });

        // Delete button
        el.querySelector('.conversation-delete-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.callbacks.onConversationDelete(convo.id);
          setTimeout(() => this.refreshConversationsPanel(), 50);
        });

        container.appendChild(el);
      }
    });
  }

  /** Save current conversation to storage */
  public saveCurrentConversation(
    chatHistory: Array<{ role: string; content: string }>,
    compactionState: ConversationCompactionState | null = null,
  ): void {
    const messages: SavedConversation['messages'] = this.conversationMessages.map((message) => ({
      ...message,
      ...(message.workflowDemonstrationIds?.length
        ? { workflowDemonstrationIds: [...message.workflowDemonstrationIds] }
        : {}),
      ...(message.htmlAppArtifactRefs?.length
        ? { htmlAppArtifactRefs: message.htmlAppArtifactRefs.map((ref) => ({ ...ref })) }
        : {}),
    }));

    if (messages.length === 0) return;

    const firstUserMsg = messages.find(m => m.role === 'user');
    const title = firstUserMsg
      ? (firstUserMsg.content.length > 50 ? firstUserMsg.content.slice(0, 50) + '…' : firstUserMsg.content)
      : 'New conversation';

    const now = Date.now();
    const convo: SavedConversation = {
      id: this.currentConversationId ?? this.generateId(),
      title,
      favorite: this.currentConversationFavorite,
      createdAt: now,
      updatedAt: now,
      messages,
      chatHistory: [...chatHistory],
      workflowDemonstrations: this.composerModule.getConversationWorkflowDemonstrations(),
      htmlAppArtifacts: cloneHtmlAppArtifacts(this.conversationHtmlAppArtifacts),
      stagedWorkflowDemonstrationIds: this.composerModule.getStagedWorkflowDemonstrationIds(),
      compactionState,
    };

    this.currentConversationId = convo.id;
    void upsertSavedConversation(convo);
  }

  /** Load a conversation into the chat view */
  public loadConversation(convo: SavedConversation): void {
    this.clearMessages();
    this.currentConversationId = convo.id;
    this.currentConversationFavorite = convo.favorite === true;
    this.conversationHtmlAppArtifacts = cloneHtmlAppArtifacts(convo.htmlAppArtifacts);
    this.conversationMessages = convo.messages.map((message) => ({
      ...message,
      ...(message.workflowDemonstrationIds?.length
        ? { workflowDemonstrationIds: [...message.workflowDemonstrationIds] }
        : {}),
      ...(message.htmlAppArtifactRefs?.length
        ? { htmlAppArtifactRefs: message.htmlAppArtifactRefs.map((ref) => ({ ...ref })) }
        : {}),
    }));
    this.composerModule.replaceConversationWorkflowState(
      convo.workflowDemonstrations,
      convo.stagedWorkflowDemonstrationIds,
    );

    for (const msg of this.conversationMessages) {
      this.transcriptModule.renderConversationMessage(msg);
    }
  }

  /** Clear all messages from the view */
  public clearMessages(): void {
    this.transcriptModule.clear();
    this.toolStepsModule.clear();
    this.currentConversationFavorite = false;
    this.conversationMessages = [];
    this.conversationHtmlAppArtifacts = [];
    this.streamingConversationMessageIndex = null;
    this.composerModule.clearConversationWorkflowState();
  }

  /** Delete a conversation from storage */
  public deleteConversation(id: string): void {
    void removeSavedConversation(id);
    if (this.currentConversationId === id) {
      this.currentConversationId = null;
      this.currentConversationFavorite = false;
    }
  }

  /** Set current conversation id */
  public setCurrentConversationId(id: string | null): void {
    this.currentConversationId = id;
    if (id === null) {
      this.currentConversationFavorite = false;
    }
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  private registerHtmlAppArtifact(request: HtmlAppRenderRequest): void {
    upsertHtmlAppArtifact(this.conversationHtmlAppArtifacts, request);
  }

  // ─── Config Panel ───────────────────────────────────────────────────────

  private toggleConfigPanel(): void {
    this.setActiveSurface(this.activeSurface === 'config' ? 'chat' : 'config');
  }

  private bindConfigPanelInteractions(): void {
    const modeBtns = this.configPanel.querySelectorAll('.config-mode-btn');
    modeBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = (btn as HTMLElement).dataset.mode as 'openai' | 'claude';
        this.configMode = mode;
        modeBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const of = this.configPanel.querySelector('.config-openai-fields') as HTMLElement;
        const cf = this.configPanel.querySelector('.config-claude-fields') as HTMLElement;
        if (of) of.style.display = mode === 'openai' ? '' : 'none';
        if (cf) cf.style.display = mode === 'claude' ? '' : 'none';
      });
    });

    this.configPanel.querySelector('.config-apply-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.applyConfig();
    });

    this.configPanel.querySelector('#llm-config-refresh')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.fetchModels();
    });

    this.configPanel.addEventListener('keydown', (e) => e.stopPropagation());
    this.configPanel.addEventListener('keyup', (e) => e.stopPropagation());
    this.configPanel.addEventListener('keypress', (e) => e.stopPropagation());
  }

  private togglePromptPanel(): void {
    this.setActiveSurface(this.activeSurface === 'prompt' ? 'chat' : 'prompt');
  }

  private populateConfigFields(): void {
    void Promise.all([
      loadConfigEditorState(),
      loadHtmlAppExecutionPreferences(),
    ]).then(([saved, htmlAppPreferences]) => {
      const openai = { ...DEFAULT_OPENAI_FIELDS, ...saved.openai };
      const claude = { ...DEFAULT_CLAUDE_FIELDS, ...saved.claude };
      const vlm = { ...DEFAULT_VLM_CONFIG, ...saved.vlm };

      this.setInput('llm-config-endpoint', openai.baseUrl);
      this.setInput('llm-config-api-key', openai.apiKey);
      this.setInput('llm-config-model', openai.model);
      this.setInput('llm-config-context-window', String(openai.contextWindow));
      this.setInput('claude-config-endpoint', claude.baseUrl);
      this.setInput('claude-config-api-key', claude.apiKey);
      this.setInput('claude-config-model', claude.model);
      this.setInput('claude-config-context-window', String(claude.contextWindow));
      this.setInput(
        'llm-config-recursion-limit',
        String(Number(saved.runtime.recursionLimit) || DEFAULT_AGENT_RECURSION_LIMIT),
      );
      this.setInput('vlm-config-endpoint', vlm.baseUrl);
      this.setInput('vlm-config-api-key', vlm.apiKey);
      this.setInput('vlm-config-model', vlm.model);

      this.configMode = saved.activeMode;
      const btns = this.configPanel.querySelectorAll('.config-mode-btn');
      btns.forEach((b) => {
        b.classList.toggle('active', (b as HTMLElement).dataset.mode === this.configMode);
      });
      const of = this.configPanel.querySelector('.config-openai-fields') as HTMLElement;
      const cf = this.configPanel.querySelector('.config-claude-fields') as HTMLElement;
      if (of) of.style.display = this.configMode === 'openai' ? '' : 'none';
      if (cf) cf.style.display = this.configMode === 'claude' ? '' : 'none';

      const htmlAppAutoApprove = this.configPanel.querySelector('#html-app-auto-approve') as HTMLInputElement | null;
      if (htmlAppAutoApprove) {
        htmlAppAutoApprove.checked = htmlAppPreferences.alwaysAllowExecution;
      }

      const animatedBrow = this.configPanel.querySelector('#animated-brow') as HTMLInputElement | null;
      if (animatedBrow) {
        animatedBrow.checked = saved.runtime.animatedBrow === true;
      }
    });
  }

  private applyConfig(): void {
    const statusEl = this.configPanel.querySelector('.config-status') as HTMLElement;
    let fields: ProviderFields;
    const recursionLimitRaw = this.getInput('llm-config-recursion-limit');
    const recursionLimit = Number(recursionLimitRaw || DEFAULT_AGENT_RECURSION_LIMIT);

    if (!Number.isFinite(recursionLimit) || recursionLimit < 1 || !Number.isInteger(recursionLimit)) {
      if (statusEl) {
        statusEl.textContent = 'Recursion limit must be a positive integer.';
        statusEl.className = 'config-status error';
      }
      return;
    }

    if (this.configMode === 'openai') {
      const baseUrl = this.getInput('llm-config-endpoint');
      const apiKey = this.getInput('llm-config-api-key');
      const select = this.configPanel.querySelector('#llm-config-model-select') as HTMLSelectElement;
      const model = select ? select.value : this.getInput('llm-config-model');
      const contextWindowRaw = this.getInput('llm-config-context-window');

      if (!baseUrl || !model) {
        if (statusEl) {
          statusEl.textContent = 'Base URL and model are required.';
          statusEl.className = 'config-status error';
        }
        return;
      }

      const parsedContextWindow = Number(contextWindowRaw);
      if (contextWindowRaw && (!Number.isFinite(parsedContextWindow) || parsedContextWindow < 1024 || !Number.isInteger(parsedContextWindow))) {
        if (statusEl) {
          statusEl.textContent = 'Context window must be an integer of at least 1024.';
          statusEl.className = 'config-status error';
        }
        return;
      }

      fields = {
        baseUrl,
        apiKey,
        model,
        contextWindow: normalizeContextWindow(contextWindowRaw, DEFAULT_OPENAI_FIELDS.contextWindow),
      };
    } else {
      const baseUrl = this.getInput('claude-config-endpoint') || DEFAULT_CLAUDE_FIELDS.baseUrl;
      const apiKey = this.getInput('claude-config-api-key');
      const model = this.getInput('claude-config-model');
      const contextWindowRaw = this.getInput('claude-config-context-window');

      if (!apiKey || !model) {
        if (statusEl) {
          statusEl.textContent = 'Anthropic API key and model are required.';
          statusEl.className = 'config-status error';
        }
        return;
      }

      const parsedContextWindow = Number(contextWindowRaw);
      if (contextWindowRaw && (!Number.isFinite(parsedContextWindow) || parsedContextWindow < 1024 || !Number.isInteger(parsedContextWindow))) {
        if (statusEl) {
          statusEl.textContent = 'Context window must be an integer of at least 1024.';
          statusEl.className = 'config-status error';
        }
        return;
      }

      fields = {
        baseUrl,
        apiKey,
        model,
        contextWindow: normalizeContextWindow(contextWindowRaw, DEFAULT_CLAUDE_FIELDS.contextWindow),
      };
    }

    void saveConfigEditorState({
      mode: this.configMode,
      fields,
      recursionLimit: Math.floor(recursionLimit),
      animatedBrow: (this.configPanel.querySelector('#animated-brow') as HTMLInputElement | null)?.checked === true,
      vlm: {
        baseUrl: this.getInput('vlm-config-endpoint'),
        apiKey: this.getInput('vlm-config-api-key'),
        model: this.getInput('vlm-config-model'),
      },
    });
    const htmlAppAutoApprove = this.configPanel.querySelector('#html-app-auto-approve') as HTMLInputElement | null;
    this.callbacks.onHtmlAppExecutionPreferenceChange(htmlAppAutoApprove?.checked === true);

    this.callbacks.onConfigApply({
      mode: this.configMode,
      fields,
      recursionLimit: Math.floor(recursionLimit),
    });

    // Apply VLM config
    const vlmBaseUrl = this.getInput('vlm-config-endpoint');
    const vlmModel = this.getInput('vlm-config-model');
    if (vlmBaseUrl && vlmModel) {
      this.callbacks.onVLMConfigApply({
        baseUrl: vlmBaseUrl,
        apiKey: this.getInput('vlm-config-api-key'),
        model: vlmModel,
      });
    }

    if (statusEl) {
      statusEl.textContent = `Applied! Using ${this.configMode === 'openai' ? 'OpenAI Compatible' : 'Claude'} mode.`;
      statusEl.className = 'config-status success';
    }
    setTimeout(() => {
      this.toggleConfigPanel();
      if (statusEl) { statusEl.textContent = ''; statusEl.className = 'config-status'; }
    }, 1200);
  }

  private async fetchModels(): Promise<void> {
    const endpoint = this.getInput('llm-config-endpoint');
    const apiKey = this.getInput('llm-config-api-key');
    const statusEl = this.configPanel.querySelector('.config-status') as HTMLElement;
    const refreshBtn = this.configPanel.querySelector('#llm-config-refresh') as HTMLButtonElement;

    if (!endpoint) {
      if (statusEl) { statusEl.textContent = 'Enter an endpoint first.'; statusEl.className = 'config-status error'; }
      return;
    }

    if (refreshBtn) { refreshBtn.classList.add('spinning'); refreshBtn.disabled = true; }
    if (statusEl) { statusEl.textContent = 'Fetching models…'; statusEl.className = 'config-status'; }

    try {
      const base = endpoint.replace(/\/+$/, '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(`${base}/models`, { method: 'GET', headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models: string[] = (data?.data ?? data?.models ?? []).map((m: any) =>
        typeof m === 'string' ? m : (m?.id ?? m?.name ?? String(m)),
      );

      if (models.length === 0) throw new Error('No models returned');

      const modelField = this.configPanel.querySelector('#llm-config-model-field') as HTMLElement;
      const old = modelField.querySelector('#llm-config-model, #llm-config-model-select');
      if (old) old.remove();

      const select = document.createElement('select');
      select.id = 'llm-config-model-select';
      select.className = 'config-model-select';
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = '— select a model —';
      select.appendChild(ph);
      models.forEach((id) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        select.appendChild(opt);
      });
      modelField.appendChild(select);
      if (models.length > 0) select.value = models[0];

      if (statusEl) {
        statusEl.textContent = `${models.length} model${models.length > 1 ? 's' : ''} loaded.`;
        statusEl.className = 'config-status success';
      }
    } catch (err: any) {
      if (statusEl) {
        statusEl.textContent = `Could not load models: ${err.message}`;
        statusEl.className = 'config-status error';
      }
    } finally {
      if (refreshBtn) { refreshBtn.classList.remove('spinning'); refreshBtn.disabled = false; }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private setInput(id: string, value: string): void {
    const el = this.configPanel.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (el) el.value = value;
  }

  private getInput(id: string): string {
    const el = this.configPanel.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    return el?.value?.trim() ?? '';
  }

  private escapeHtml(text: string): string {
    return escapeMessageHtml(text);
  }

  private formatMessage(message: string): string {
    return formatAssistantMessage(message);
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    });
  }

}
