// ─── Side Panel Chat View ───────────────────────────────────────────────────
// Gemini-like sidebar chat UI. Modeled after radiology-copilot-view.ts.

import type { WebMCPRegistryEntry } from '../shared/types';
import {
  type AutomationApprovalDecision,
  type ToolStepEvent,
  type ToolManifestEntry,
} from './agent';
import { getCategoryLabel } from './agent-runtime/tooling';
import {
  DEFAULT_AGENT_RECURSION_LIMIT,
  DEFAULT_CLAUDE_FIELDS,
  DEFAULT_OPENAI_FIELDS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_VLM_CONFIG,
} from '../shared/config';
import {
  loadConfigEditorState,
  loadPromptEditorState,
  saveConfigEditorState,
  saveSkillRegistryEntries,
  saveSystemPrompt,
} from './chat-view/config-store';
import {
  loadSavedConversations,
  removeSavedConversation,
  upsertSavedConversation,
} from './chat-view/conversation-store';
import type { ContextTabOption, SavedConversation } from './chat-view/types';
import {
  isToolVisibleToModel,
  type MCPAppRenderRequest,
  type MCPServerEntry,
  type MCPToolDescriptor,
} from './mcp-client';
import type { MCPAppLoadedResource } from './mcp-app-host';
import {
  formatSkillTagsInput,
  parseSkillTagsInput,
  parseSkillMarkdownImport,
  slugifySkillName,
  type SkillDraft,
  type SkillRegistryEntry,
} from './skills-registry';
export type { SavedConversation, ContextTabOption } from './chat-view/types';

export interface ChatViewCallbacks {
  onSendMessage: (message: string, contextTabIds: number[]) => void;
  onStopGeneration: () => void;
  onConfigApply: (config: {
    mode: 'openai' | 'claude';
    fields: Record<string, string>;
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
  onMCPServerAdd: (name: string, url: string, authToken?: string) => Promise<MCPServerEntry>;
  onMCPServerRemove: (id: string) => void;
  onMCPServerReconnect: (id: string) => Promise<MCPServerEntry>;
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
  private messageInput!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private contextTabsContainer!: HTMLElement;
  private contextAddButton!: HTMLButtonElement;
  private contextPicker!: HTMLElement;
  private webmcpIndicator!: HTMLElement;
  private newChatButton!: HTMLButtonElement;
  private bottomNav!: HTMLElement;
  private configPanel!: HTMLElement;
  private promptPanel!: HTMLElement;
  private toolsPanel!: HTMLElement;
  private conversationsPanel!: HTMLElement;
  private mcpPanel!: HTMLElement;
  private isInputEnabled = false;
  private isAgentBusy = false;

  // Panel state
  private configMode: 'openai' | 'claude' = 'openai';
  private isConfigVisible = false;
  private isToolsVisible = false;
  private isConversationsVisible = false;
  private isMCPVisible = false;
  private isPromptVisible = false;
  private activeSurface: SurfaceMode = 'chat';
  private systemPromptPreviewMode: 'edit' | 'preview' = 'edit';
  private skillContentPreviewMode: 'edit' | 'preview' = 'edit';

  // Current conversation
  private currentConversationId: string | null = null;

  // Streaming state
  private streamingElement: HTMLElement | null = null;
  private streamingAccumulated = '';
  private streamingWordQueue: string[] = [];
  private streamingTimer: number | null = null;

  // Tool steps
  private currentToolStepsContainer: HTMLElement | null = null;
  private toolStepsCollapsed = false;
  private expandedToolStepDetails = new Set<number>();
  private expandedToolCards = new Set<string>();
  private pendingToolCardFocusKey: string | null = null;

  // Composer context
  private currentContextTab: ContextTabOption | null = null;
  private includeCurrentContextTab = true;
  private hasInitializedCurrentContext = false;
  private extraContextTabs: ContextTabOption[] = [];
  private contextPickerMode: 'button' | 'mention' | null = null;
  private contextPickerItems: ContextTabOption[] = [];
  private contextPickerHighlightIndex = 0;
  private contextPickerQuery = '';
  private mentionRange: { start: number; end: number } | null = null;

  // Prompt skills registry
  private skillRegistry: SkillRegistryEntry[] = [];
  private editingSkillId: string | null = null;
  private isSkillEditorOpen = false;
  private skillEditorSlugDirty = false;

  constructor(container: HTMLElement, callbacks: ChatViewCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.build();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  public enableInput(): void {
    this.isInputEnabled = true;
    this.refreshComposerState();
  }

  public disableInput(): void {
    this.isInputEnabled = false;
    this.refreshComposerState();
  }

  public setAgentBusy(busy: boolean): void {
    this.isAgentBusy = busy;
    this.refreshComposerState();
  }

  public setCurrentContextTab(tab: ContextTabOption | null): void {
    const previousTabId = this.currentContextTab?.tabId ?? null;
    const nextTabId = tab?.tabId ?? null;
    if (!this.hasInitializedCurrentContext && tab) {
      this.includeCurrentContextTab = true;
    }
    if (this.hasInitializedCurrentContext && nextTabId !== null && nextTabId !== previousTabId) {
      // Removing NOW only hides the current active tab. When Chrome switches to a new
      // active tab, that new tab becomes the NOW context again.
      this.includeCurrentContextTab = true;
    }
    this.currentContextTab = tab;
    if (nextTabId !== null) {
      this.extraContextTabs = this.extraContextTabs.filter((entry) => entry.tabId !== nextTabId);
    }
    if (!tab && !this.hasInitializedCurrentContext) {
      this.includeCurrentContextTab = false;
    }
    this.hasInitializedCurrentContext = true;
    this.renderContextTabs();
    void this.refreshContextPicker();
  }

  public removeContextTab(tabId: number): void {
    if (this.currentContextTab?.tabId === tabId) {
      this.currentContextTab = null;
    }
    this.extraContextTabs = this.extraContextTabs.filter((tab) => tab.tabId !== tabId);
    this.renderContextTabs();
    void this.refreshContextPicker();
  }

  public getSelectedContextTabIds(): number[] {
    const ids: number[] = [];
    if (this.includeCurrentContextTab && this.currentContextTab) {
      ids.push(this.currentContextTab.tabId);
    }
    for (const tab of this.extraContextTabs) {
      if (!ids.includes(tab.tabId)) ids.push(tab.tabId);
    }
    return ids;
  }

  public addUserMessage(message: string): void {
    const el = document.createElement('div');
    el.className = 'message user-message';
    el.innerHTML = `
      <div class="message-content">${this.escapeHtml(message)}</div>
      <div class="message-time">${new Date().toLocaleTimeString()}</div>`;
    this.messagesContainer.appendChild(el);
    this.scrollToBottom();
  }

  public addAssistantMessage(message: string): void {
    const el = document.createElement('div');
    el.className = 'message assistant-message';
    el.innerHTML = `
      <div class="message-content">${this.formatMessage(message)}</div>
      <div class="message-time">${new Date().toLocaleTimeString()}</div>`;
    this.messagesContainer.appendChild(el);
    this.scrollToBottom();
  }

  public addSystemMessage(text: string): void {
    const el = document.createElement('div');
    el.className = 'message system-message';
    el.innerHTML = `<div class="message-content">${this.escapeHtml(text)}</div>`;
    this.messagesContainer.appendChild(el);
    this.scrollToBottom();
  }

  public showTypingIndicator(): void {
    const el = document.createElement('div');
    el.className = 'message assistant-message typing-indicator';
    el.id = 'typing-indicator';
    el.innerHTML = `
      <div class="message-content">
        <div class="typing-dots"><span></span><span></span><span></span></div>
      </div>`;
    this.messagesContainer.appendChild(el);
    this.scrollToBottom();
  }

  public hideTypingIndicator(): void {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  /** Streaming: word-by-word assistant message */
  public streamAssistantMessage(message: string): void {
    if (this.streamingElement) {
      if (this.streamingTimer !== null) {
        clearInterval(this.streamingTimer);
        this.streamingTimer = null;
      }
      const newWords = (' ' + message).split(/( +)/);
      this.streamingWordQueue.push(...newWords);
      this.startStreamingWords();
      return;
    }

    const el = document.createElement('div');
    el.className = 'message assistant-message';
    el.innerHTML = `
      <div class="message-content"><span class="streaming-text"></span><span class="streaming-cursor">|</span></div>
      <div class="message-time">${new Date().toLocaleTimeString()}</div>`;
    this.messagesContainer.appendChild(el);
    this.streamingElement = el;
    this.streamingAccumulated = '';
    this.streamingWordQueue = message.split(/( +)/);
    this.startStreamingWords();
  }

  public finalizeStreaming(): void {
    if (this.streamingTimer !== null) {
      clearInterval(this.streamingTimer);
      this.streamingTimer = null;
    }
    if (this.streamingElement) {
      const textSpan = this.streamingElement.querySelector('.streaming-text') as HTMLElement;
      if (textSpan && this.streamingWordQueue.length > 0) {
        this.streamingAccumulated += this.streamingWordQueue.join('');
        this.streamingWordQueue = [];
        textSpan.innerHTML = this.formatMessage(this.streamingAccumulated);
      }
      const cursor = this.streamingElement.querySelector('.streaming-cursor');
      if (cursor) cursor.remove();
      this.streamingElement = null;
    }
    this.streamingAccumulated = '';
    this.streamingWordQueue = [];
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
    if (steps.length === 0) return;

    // Create container if it doesn't exist yet
    if (!this.currentToolStepsContainer) {
      this.currentToolStepsContainer = document.createElement('div');
      this.currentToolStepsContainer.className = 'tool-steps-tracker';
      // Insert tracker BEFORE the streaming bubble if one exists
      if (this.streamingElement && this.streamingElement.parentNode === this.messagesContainer) {
        this.messagesContainer.insertBefore(this.currentToolStepsContainer, this.streamingElement);
      } else {
        this.messagesContainer.appendChild(this.currentToolStepsContainer);
      }
    } else if (this.streamingElement && this.streamingElement.parentNode === this.messagesContainer) {
      // Ensure tracker stays above the streaming bubble even after re-renders
      const trackerIndex = Array.from(this.messagesContainer.children).indexOf(this.currentToolStepsContainer);
      const bubbleIndex = Array.from(this.messagesContainer.children).indexOf(this.streamingElement);
      if (trackerIndex > bubbleIndex) {
        this.messagesContainer.insertBefore(this.currentToolStepsContainer, this.streamingElement);
      }
    }

    const totalSteps = steps.length;
    const finishedSteps = steps.filter((s) => this.isToolStepFinished(s)).length;
    const errorSteps = steps.filter((s) => s.status === 'error').length;
    const allFinished = finishedSteps === totalSteps;
    const allSuccessful = allFinished && errorSteps === 0;
    const totalDuration = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
    const durationStr = (totalDuration / 1000).toFixed(1) + 's';

    const statusIcon = !allFinished ? this.spinnerSvg() : errorSteps > 0 ? this.errorSvg() : this.checkSvg();
    const headerText = !allFinished
      ? `Working with ${totalSteps} tool${totalSteps > 1 ? 's' : ''}…`
      : errorSteps > 0
        ? `Finished ${totalSteps} tool${totalSteps > 1 ? 's' : ''} · ${errorSteps} failed · ${durationStr}`
        : `Worked with ${totalSteps} tool${totalSteps > 1 ? 's' : ''} · ${durationStr}`;

    let stepsHtml = '';
    for (const step of steps) {
      stepsHtml += this.renderToolStepItem(step);
    }

    const countText = errorSteps > 0
      ? `${finishedSteps}/${totalSteps} finished · ${errorSteps} failed`
      : `${finishedSteps}/${totalSteps} finished${allSuccessful ? ' ✓' : ''}`;
    const chevronSvg = this.chevronSvg(!this.toolStepsCollapsed);

    this.currentToolStepsContainer.innerHTML = `
      <div class="tool-steps-header">
        <div class="tool-steps-header-left">
          ${statusIcon}
          <span class="tool-steps-header-text">${headerText}</span>
        </div>
        <div class="tool-steps-header-right">
          <span class="tool-steps-count">${countText}</span>
          ${chevronSvg}
        </div>
      </div>
      <div class="tool-steps-body ${this.toolStepsCollapsed ? 'collapsed' : ''}">
        <div class="tool-steps-timeline">
          ${stepsHtml}
        </div>
        <div class="tool-steps-toggle">${this.toolStepsCollapsed ? 'Show details' : 'Hide details'} ${chevronSvg}</div>
      </div>
    `;

    this.bindLiveToolStepInteractions(steps);

    this.scrollToolStepsToBottom();
    this.scrollToBottom();
  }

  /**
   * Finalize the current tool steps widget so a new query gets a fresh one.
   * The existing widget stays in the chat history.
   */
  public finalizeToolSteps(): void {
    if (this.currentToolStepsContainer) {
      const finalized = this.currentToolStepsContainer.cloneNode(true) as HTMLElement;
      finalized.classList.add('finalized');
      this.bindStaticToolTrackerInteractions(finalized);
      this.currentToolStepsContainer.replaceWith(finalized);
    }
    this.currentToolStepsContainer = null;
    this.toolStepsCollapsed = false;
    this.expandedToolStepDetails.clear();
  }

  private bindLiveToolStepInteractions(steps: ToolStepEvent[]): void {
    if (!this.currentToolStepsContainer) return;

    const header = this.currentToolStepsContainer.querySelector('.tool-steps-header');
    const toggleBtn = this.currentToolStepsContainer.querySelector('.tool-steps-toggle');
    const toggleFn = () => {
      this.toolStepsCollapsed = !this.toolStepsCollapsed;
      this.updateToolSteps(steps);
    };
    header?.addEventListener('click', toggleFn);
    toggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFn();
    });

    this.currentToolStepsContainer.querySelectorAll<HTMLElement>('[data-step-toggle]').forEach((button) => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const rawIndex = button.dataset.stepToggle;
        if (!rawIndex) return;
        const stepIndex = Number(rawIndex);
        if (Number.isNaN(stepIndex)) return;
        if (this.expandedToolStepDetails.has(stepIndex)) this.expandedToolStepDetails.delete(stepIndex);
        else this.expandedToolStepDetails.add(stepIndex);
        this.updateToolSteps(steps);
      });
    });

    this.currentToolStepsContainer.querySelectorAll<HTMLButtonElement>('[data-approval-action]').forEach((button) => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const requestId = button.dataset.approvalRequestId;
        const action = button.dataset.approvalAction as AutomationApprovalDecision | undefined;
        if (!requestId || !action) return;
        this.callbacks.onAutomationApprovalDecision(requestId, action);
      });
    });
  }

  private bindStaticToolTrackerInteractions(container: HTMLElement): void {
    const header = container.querySelector('.tool-steps-header') as HTMLElement | null;
    const body = container.querySelector('.tool-steps-body') as HTMLElement | null;
    const toggleBtn = container.querySelector('.tool-steps-toggle') as HTMLElement | null;
    let collapsed = body?.classList.contains('collapsed') ?? false;

    const renderHeader = () => {
      body?.classList.toggle('collapsed', collapsed);
      container.querySelectorAll<HTMLElement>('.tool-steps-header .tool-steps-chevron').forEach((el) => {
        el.classList.toggle('rotated', !collapsed);
      });
      if (toggleBtn) {
        toggleBtn.innerHTML = `${collapsed ? 'Show details' : 'Hide details'} ${this.chevronSvg(!collapsed)}`;
      }
    };

    const toggle = () => {
      collapsed = !collapsed;
      renderHeader();
    };

    header?.addEventListener('click', toggle);
    toggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });

    container.querySelectorAll<HTMLElement>('[data-step-toggle]').forEach((button) => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const stepIndex = button.dataset.stepToggle;
        if (!stepIndex) return;
        const details = container.querySelector<HTMLElement>(`[data-step-details="${stepIndex}"]`);
        if (!details) return;
        const nextExpanded = details.classList.contains('collapsed');
        details.classList.toggle('collapsed', !nextExpanded);
        button.setAttribute('aria-expanded', String(nextExpanded));
        button.innerHTML = `${nextExpanded ? 'Hide raw details' : 'Show raw details'} ${this.chevronSvg(nextExpanded, 'tool-step-detail-chevron')}`;
      });
    });

    renderHeader();
  }

  private renderToolStepItem(step: ToolStepEvent): string {
    const stepIcon = step.status === 'error'
      ? this.errorSvg()
      : step.status === 'completed'
        ? this.checkSvg()
        : step.status === 'awaiting_approval'
          ? this.approvalSvg()
          : this.spinnerSvg();
    const stepDuration = step.durationMs ? `${(step.durationMs / 1000).toFixed(1)}s` : '';
    const rawDesc = step.description || '';
    const description = rawDesc.length > 140 ? `${rawDesc.slice(0, 140)}…` : rawDesc;
    const hasDetails = Boolean(step.inputText || step.resultText || step.errorText);
    const detailsExpanded = this.expandedToolStepDetails.has(step.stepIndex);
    const detailSections: string[] = [];

    if (step.inputText) {
      detailSections.push(this.renderToolStepDetailSection('Input', step.inputText));
    }
    if (step.errorText) {
      detailSections.push(this.renderToolStepDetailSection('Error', step.errorText, 'error'));
    }
    if (step.resultText && step.resultText !== step.errorText) {
      detailSections.push(this.renderToolStepDetailSection('Result', step.resultText));
    }

    return `
      <div class="tool-step-item ${step.status}">
        <div class="tool-step-connector">
          <div class="tool-step-icon">${stepIcon}</div>
        </div>
        <div class="tool-step-info">
          <span class="tool-step-label">${this.escapeHtml(step.label)}</span>
          ${description ? `<span class="tool-step-description ${step.status === 'error' ? 'error' : step.status === 'awaiting_approval' ? 'approval' : ''}">${this.escapeHtml(description)}</span>` : ''}
          ${step.status === 'awaiting_approval' && step.approvalRequestId ? this.renderApprovalActions(step.approvalRequestId) : ''}
          ${hasDetails ? `
            <button class="tool-step-detail-toggle" type="button" data-step-toggle="${step.stepIndex}" aria-expanded="${detailsExpanded ? 'true' : 'false'}">
              ${detailsExpanded ? 'Hide raw details' : 'Show raw details'} ${this.chevronSvg(detailsExpanded, 'tool-step-detail-chevron')}
            </button>
            <div class="tool-step-details ${detailsExpanded ? '' : 'collapsed'}" data-step-details="${step.stepIndex}">
              ${detailSections.join('')}
            </div>
          ` : ''}
        </div>
        ${stepDuration ? `<span class="tool-step-duration">· ${stepDuration}</span>` : ''}
      </div>`;
  }

  private renderToolStepDetailSection(
    label: string,
    text: string,
    tone: 'default' | 'error' = 'default',
  ): string {
    return `
      <div class="tool-step-detail-section ${tone}">
        <span class="tool-step-detail-label">${this.escapeHtml(label)}</span>
        <pre class="tool-step-detail-content">${this.escapeHtml(text)}</pre>
      </div>
    `;
  }

  private renderApprovalActions(requestId: string): string {
    return `
      <div class="tool-step-approval-actions">
        <button class="tool-step-approval-btn allow" type="button" data-approval-action="allow" data-approval-request-id="${this.escapeHtml(requestId)}">Allow</button>
        <button class="tool-step-approval-btn allow-all" type="button" data-approval-action="allow_all" data-approval-request-id="${this.escapeHtml(requestId)}">Allow All Session</button>
        <button class="tool-step-approval-btn skip" type="button" data-approval-action="skip" data-approval-request-id="${this.escapeHtml(requestId)}">Skip</button>
      </div>
    `;
  }

  private isToolStepFinished(step: ToolStepEvent): boolean {
    return step.status === 'completed' || step.status === 'error';
  }

  /** Create an inert MCP App card while Brow fetches and validates the UI resource. */
  public renderMCPAppLoading(request: MCPAppRenderRequest): HTMLElement {
    this.addSystemMessage(`MCP App View requested: ${request.toolTitle ?? request.toolName}`);

    const wrapper = document.createElement('div');
    wrapper.className = 'mcp-app-container mcp-app-loading';
    wrapper.dataset.mcpAppId = request.id;
    wrapper.innerHTML = `
      <div class="mcp-app-card">
        ${this.renderMCPAppHeader(request)}
        <div class="mcp-app-status">
          <span class="mcp-app-spinner" aria-hidden="true"></span>
          <span>Inspecting app resource...</span>
        </div>
      </div>`;
    this.messagesContainer.appendChild(wrapper);
    this.scrollToBottom();
    return wrapper;
  }

  public renderMCPAppApproval(
    container: HTMLElement,
    request: MCPAppRenderRequest,
    resource: MCPAppLoadedResource,
    callbacks: { onApprove: () => void; onSkip: () => void },
  ): void {
    container.className = 'mcp-app-container mcp-app-pending';
    container.innerHTML = `
      <div class="mcp-app-card">
        ${this.renderMCPAppHeader(request)}
        <div class="mcp-app-meta-grid">
          <div><span>Server</span><strong>${this.escapeHtml(request.server.name)}</strong></div>
          <div><span>Resource</span><strong>${this.escapeHtml(resource.uri)}</strong></div>
          <div><span>Permissions</span><strong>${this.escapeHtml(this.formatMCPAppPermissions(resource.permissions))}</strong></div>
          <div><span>CSP</span><strong>${this.escapeHtml(this.formatMCPAppCsp(resource.csp))}</strong></div>
        </div>
        <div class="mcp-app-actions">
          <button class="mcp-app-approve-btn" type="button">Render App</button>
          <button class="mcp-app-skip-btn" type="button">Skip</button>
        </div>
      </div>`;

    container.querySelector<HTMLButtonElement>('.mcp-app-approve-btn')?.addEventListener('click', () => {
      callbacks.onApprove();
    });
    container.querySelector<HTMLButtonElement>('.mcp-app-skip-btn')?.addEventListener('click', () => {
      callbacks.onSkip();
    });
    this.scrollToBottom();
  }

  public renderMCPAppFrame(
    container: HTMLElement,
    request: MCPAppRenderRequest,
    resource: MCPAppLoadedResource,
  ): HTMLIFrameElement {
    container.className = `mcp-app-container mcp-app-live${resource.prefersBorder === false ? ' borderless' : ''}`;
    container.innerHTML = `
      <div class="mcp-app-live-header">
        ${this.renderMCPAppTitle(request)}
        <span>${this.escapeHtml(request.server.name)}</span>
      </div>
      <div class="mcp-app-frame-shell"></div>`;

    const iframe = document.createElement('iframe');
    iframe.className = 'mcp-app-iframe';
    iframe.title = `MCP App View: ${request.toolTitle ?? request.toolName}`;
    iframe.style.height = '260px';

    container.querySelector('.mcp-app-frame-shell')?.appendChild(iframe);
    this.scrollToBottom();
    return iframe;
  }

  public resizeMCPAppFrame(iframe: HTMLIFrameElement, height: number): void {
    iframe.style.height = `${height}px`;
    this.scrollToBottom();
  }

  public renderMCPAppError(
    container: HTMLElement,
    request: MCPAppRenderRequest,
    message: string,
  ): void {
    container.className = 'mcp-app-container mcp-app-error';
    container.innerHTML = `
      <div class="mcp-app-card">
        ${this.renderMCPAppHeader(request)}
        <div class="mcp-app-error-text">${this.escapeHtml(message)}</div>
      </div>`;
    this.scrollToBottom();
  }

  public renderMCPAppSkipped(container: HTMLElement, request: MCPAppRenderRequest): void {
    container.className = 'mcp-app-container mcp-app-skipped';
    container.innerHTML = `
      <div class="mcp-app-card">
        ${this.renderMCPAppHeader(request)}
        <div class="mcp-app-status">Skipped. The app HTML was not rendered.</div>
      </div>`;
    this.scrollToBottom();
  }

  private renderMCPAppHeader(request: MCPAppRenderRequest): string {
    return `
      <div class="mcp-app-header">
        <div>
          ${this.renderMCPAppTitle(request)}
          <p>${this.escapeHtml(request.toolDescription || 'Interactive MCP App View')}</p>
        </div>
        <span>MCP App</span>
      </div>`;
  }

  private renderMCPAppTitle(request: MCPAppRenderRequest): string {
    return `<strong>${this.escapeHtml(request.toolTitle ?? request.toolName)}</strong>`;
  }

  private formatMCPAppPermissions(permissions: MCPAppLoadedResource['permissions']): string {
    if (!permissions) return 'None requested';
    const entries: string[] = [];
    if (permissions.camera) entries.push('camera');
    if (permissions.microphone) entries.push('microphone');
    if (permissions.geolocation) entries.push('location');
    if (permissions.clipboardWrite) entries.push('clipboard write');
    return entries.length > 0 ? entries.join(', ') : 'None requested';
  }

  private formatMCPAppCsp(csp: MCPAppLoadedResource['csp']): string {
    if (!csp) return 'No external domains';
    const parts: string[] = [];
    if (csp.connectDomains?.length) parts.push(`connect ${csp.connectDomains.length}`);
    if (csp.resourceDomains?.length) parts.push(`resource ${csp.resourceDomains.length}`);
    if (csp.frameDomains?.length) parts.push(`frame ${csp.frameDomains.length}`);
    return parts.length > 0 ? parts.join(' / ') : 'No external domains';
  }

  // ─── Build ──────────────────────────────────────────────────────────────

  private build(): void {
    this.container.innerHTML = '';
    this.container.className = 'chat-container';

    // Header
    this.chatHeader = document.createElement('div');
    this.chatHeader.className = 'chat-header';
    this.chatHeader.innerHTML = `
      <div class="header-brand">
        <div class="brand-copy">
          <img src="${chrome.runtime.getURL('icons/extension-icon.png')}" alt="Agent WebMCP" class="brand-icon" />
          <span class="brand-label">BROW</span>
        </div>
      </div>
      <div class="header-meta">
        <div class="webmcp-indicator"><span class="status-dot unavailable"></span> WebMCP: N/A</div>
        <span class="connection-status">Ready</span>
        <div class="header-actions">
          <button class="new-chat-btn" title="Start a new chat" aria-label="Start a new chat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h11"></path>
              <line x1="18" y1="3" x2="18" y2="9"></line>
              <line x1="15" y1="6" x2="21" y2="6"></line>
            </svg>
            <span>New Chat</span>
          </button>
          <button class="refresh-webmcp-btn" title="Refresh WebMCP discovery" aria-label="Refresh WebMCP discovery">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
          </button>
        </div>
      </div>`;
    this.container.appendChild(this.chatHeader);

    this.webmcpIndicator = this.chatHeader.querySelector('.webmcp-indicator') as HTMLElement;
    this.newChatButton = this.chatHeader.querySelector('.new-chat-btn') as HTMLButtonElement;
    const refreshBtn = this.chatHeader.querySelector('.refresh-webmcp-btn');
    this.newChatButton.addEventListener('click', () => this.startNewConversation());
    refreshBtn?.addEventListener('click', () => this.callbacks.onRefreshWebMCP());

    // Chat body
    this.chatBody = document.createElement('div');
    this.chatBody.className = 'chat-body';

    this.messagesContainer = document.createElement('div');
    this.messagesContainer.className = 'chat-messages';

    this.inputContainer = document.createElement('div');
    this.inputContainer.className = 'chat-input-container';

    const contextBar = document.createElement('div');
    contextBar.className = 'chat-context-bar';

    this.contextTabsContainer = document.createElement('div');
    this.contextTabsContainer.className = 'chat-context-tabs';

    this.contextAddButton = document.createElement('button');
    this.contextAddButton.className = 'context-add-button';
    this.contextAddButton.type = 'button';
    this.contextAddButton.title = 'Add a tab to context';
    this.contextAddButton.setAttribute('aria-label', 'Add a tab to context');
    this.contextAddButton.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>`;

    contextBar.appendChild(this.contextTabsContainer);
    contextBar.appendChild(this.contextAddButton);

    this.composerMainRow = document.createElement('div');
    this.composerMainRow.className = 'chat-input-main';

    this.messageInput = document.createElement('textarea');
    this.messageInput.id = 'chat-input';
    this.messageInput.placeholder = 'Ask the agent anything…';
    this.messageInput.disabled = true;
    this.messageInput.rows = 1;
    this.messageInput.spellcheck = true;

    this.sendButton = document.createElement('button');
    this.sendButton.id = 'send-button';
    this.sendButton.disabled = true;
    this.sendButton.innerHTML = this.getSendButtonMarkup();

    this.composerMainRow.appendChild(this.messageInput);
    this.composerMainRow.appendChild(this.sendButton);

    this.contextPicker = document.createElement('div');
    this.contextPicker.className = 'context-picker hidden';

    this.inputContainer.appendChild(contextBar);
    this.inputContainer.appendChild(this.contextPicker);
    this.inputContainer.appendChild(this.composerMainRow);

    // Tools panel (hidden, sits between messages and input)
    this.toolsPanel = this.createToolsPanel();

    // MCP servers panel (hidden)
    this.mcpPanel = this.createMCPPanel();

    // Conversations panel (hidden)
    this.conversationsPanel = this.createConversationsPanel();

    this.chatBody.appendChild(this.messagesContainer);
    this.chatBody.appendChild(this.toolsPanel);
    this.chatBody.appendChild(this.mcpPanel);
    this.chatBody.appendChild(this.conversationsPanel);
    this.chatBody.appendChild(this.inputContainer);
    this.container.appendChild(this.chatBody);

    // Config panel (hidden)
    this.configPanel = this.createConfigPanel();
    this.container.appendChild(this.configPanel);
    this.promptPanel = this.createPromptPanel();
    this.container.appendChild(this.promptPanel);

    // Bottom nav
    this.bottomNav = document.createElement('nav');
    this.bottomNav.className = 'bottom-nav';
    this.bottomNav.innerHTML = `
      <button class="bottom-nav-btn tools-toggle-btn" data-surface="tools" title="Manage Tools" aria-label="Manage Tools">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
        </svg>
      </button>
      <button class="bottom-nav-btn mcp-toggle-btn" data-surface="mcp" title="MCP Servers" aria-label="MCP Servers">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
          <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
          <line x1="6" y1="6" x2="6.01" y2="6"></line>
          <line x1="6" y1="18" x2="6.01" y2="18"></line>
        </svg>
      </button>
      <button class="bottom-nav-btn chat-home-btn" data-surface="chat" title="Chat" aria-label="Chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
      </button>
      <button class="bottom-nav-btn conversations-toggle-btn" data-surface="conversations" title="Conversations" aria-label="Conversations">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <line x1="7" y1="7" x2="17" y2="7"></line>
          <line x1="7" y1="12" x2="17" y2="12"></line>
          <line x1="7" y1="17" x2="13" y2="17"></line>
          <rect x="3" y="3" width="18" height="18" rx="3"></rect>
        </svg>
      </button>
      <button class="bottom-nav-btn prompt-toggle-btn" data-surface="prompt" title="Prompt" aria-label="Prompt">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"></path>
        </svg>
      </button>
      <button class="bottom-nav-btn config-toggle-btn" data-surface="config" title="Configure LLM" aria-label="Configure LLM">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>`;
    this.container.appendChild(this.bottomNav);

    // Event listeners
    this.setupEventListeners();
    this.setActiveSurface('chat');
    this.renderContextTabs();
    this.autoResizeMessageInput();
    this.refreshComposerState();
  }

  private setupEventListeners(): void {
    const send = () => {
      if (this.isAgentBusy) {
        this.callbacks.onStopGeneration();
        return;
      }

      const msg = this.messageInput.value.trim();
      if (msg) {
        this.callbacks.onSendMessage(msg, this.getSelectedContextTabIds());
        this.messageInput.value = '';
        this.autoResizeMessageInput();
        this.closeContextPicker();
        this.refreshComposerState();
      }
    };

    this.sendButton.addEventListener('click', send);
    this.contextAddButton.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!this.isInputEnabled || this.isAgentBusy) return;
      if (this.contextPickerMode === 'button') {
        this.closeContextPicker();
        return;
      }
      this.contextPickerMode = 'button';
      this.contextPickerQuery = '';
      this.contextPickerHighlightIndex = 0;
      this.mentionRange = null;
      await this.refreshContextPicker();
    });

    this.messageInput.addEventListener('input', () => {
      this.autoResizeMessageInput();
      this.syncMentionPickerFromInput();
      this.refreshComposerState();
    });
    this.messageInput.addEventListener('click', () => this.syncMentionPickerFromInput());
    this.messageInput.addEventListener('focus', () => this.syncMentionPickerFromInput());

    this.messageInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (this.contextPickerMode && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        if (this.contextPickerItems.length === 0) return;
        const direction = e.key === 'ArrowDown' ? 1 : -1;
        const nextIndex =
          (this.contextPickerHighlightIndex + direction + this.contextPickerItems.length) %
          this.contextPickerItems.length;
        this.contextPickerHighlightIndex = nextIndex;
        this.updateContextPickerHighlight();
        return;
      }
      if (this.contextPickerMode && ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab')) {
        if (this.contextPickerItems.length > 0) {
          e.preventDefault();
          this.selectContextPickerItem(this.contextPickerItems[this.contextPickerHighlightIndex]);
          return;
        }
      }
      if (this.contextPickerMode && e.key === 'Escape') {
        e.preventDefault();
        this.closeContextPicker();
        return;
      }
      if (this.isAgentBusy) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    this.messageInput.addEventListener('keyup', (e) => {
      e.stopPropagation();
      this.syncMentionPickerFromInput();
    });
    this.messageInput.addEventListener('keypress', (e) => e.stopPropagation());

    document.addEventListener('click', (e) => {
      if (!this.inputContainer.contains(e.target as Node)) {
        this.closeContextPicker();
      }
    });

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

  private refreshComposerState(): void {
    if (!this.messageInput || !this.sendButton) return;

    this.messageInput.disabled = !this.isInputEnabled || this.isAgentBusy;
    this.contextAddButton.disabled = !this.isInputEnabled || this.isAgentBusy;
    this.contextTabsContainer
      .querySelectorAll<HTMLButtonElement>('.context-tab-remove')
      .forEach((button) => {
        button.disabled = !this.isInputEnabled || this.isAgentBusy;
      });

    if (!this.isInputEnabled || this.isAgentBusy) {
      this.closeContextPicker();
    }

    if (this.isAgentBusy) {
      this.sendButton.disabled = false;
      this.sendButton.classList.add('is-stop');
      this.sendButton.innerHTML = this.getStopButtonMarkup();
      this.sendButton.title = 'Stop generation';
      this.sendButton.setAttribute('aria-label', 'Stop generation');
      return;
    }

    this.sendButton.classList.remove('is-stop');
    this.sendButton.innerHTML = this.getSendButtonMarkup();
    this.sendButton.title = 'Send message';
    this.sendButton.setAttribute('aria-label', 'Send message');
    this.sendButton.disabled = !this.isInputEnabled || this.messageInput.value.trim().length === 0;
  }

  private getSendButtonMarkup(): string {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
  }

  private getStopButtonMarkup(): string {
    return `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1"></rect></svg>`;
  }

  private autoResizeMessageInput(): void {
    if (!this.messageInput) return;
    this.messageInput.style.height = 'auto';
    const nextHeight = Math.min(Math.max(this.messageInput.scrollHeight, 24), 96);
    this.messageInput.style.height = `${nextHeight}px`;
  }

  private renderContextTabs(): void {
    if (!this.contextTabsContainer) return;
    this.contextTabsContainer.innerHTML = '';

    const renderedTabIds = new Set<number>();
    if (this.includeCurrentContextTab && this.currentContextTab) {
      renderedTabIds.add(this.currentContextTab.tabId);
      this.contextTabsContainer.appendChild(this.createContextTabChip(this.currentContextTab, 'Now', true));
    }

    for (const tab of this.extraContextTabs) {
      if (renderedTabIds.has(tab.tabId)) continue;
      renderedTabIds.add(tab.tabId);
      const isPrimaryFallback = !this.includeCurrentContextTab && renderedTabIds.size === 1;
      this.contextTabsContainer.appendChild(
        this.createContextTabChip(tab, isPrimaryFallback ? 'Now' : 'Ctx', isPrimaryFallback),
      );
    }

    if (renderedTabIds.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-context-empty';
      empty.textContent = 'No tab attached';
      this.contextTabsContainer.appendChild(empty);
    }

    this.refreshComposerState();
    this.scrollContextTabsToEnd();
  }

  private createContextTabChip(tab: ContextTabOption, label: string, isCurrent: boolean): HTMLElement {
    const chip = document.createElement('div');
    chip.className = `context-tab-chip${isCurrent ? ' current' : ''}`;
    chip.title = `${tab.title || '(untitled tab)'}\n${tab.url || ''}`;

    const labelEl = document.createElement('span');
    labelEl.className = 'context-tab-kind';
    labelEl.textContent = label;

    const titleEl = document.createElement('span');
    titleEl.className = 'context-tab-title';
    titleEl.textContent = this.truncateText(tab.title || tab.url || `Tab ${tab.tabId}`, 52);

    const removeButton = document.createElement('button');
    removeButton.className = 'context-tab-remove';
    removeButton.type = 'button';
    removeButton.innerHTML = '&times;';
    removeButton.title = `Remove ${tab.title || 'tab'} from context`;
    removeButton.setAttribute('aria-label', `Remove ${tab.title || 'tab'} from context`);
    removeButton.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isCurrent) {
        this.includeCurrentContextTab = false;
      } else {
        this.extraContextTabs = this.extraContextTabs.filter((entry) => entry.tabId !== tab.tabId);
      }
      this.renderContextTabs();
      void this.refreshContextPicker();
    });

    chip.appendChild(labelEl);
    chip.appendChild(titleEl);
    chip.appendChild(removeButton);
    return chip;
  }

  private truncateText(text: string, max: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= max) return normalized;
    return normalized.slice(0, max) + '…';
  }

  private async refreshContextPicker(): Promise<void> {
    if (!this.contextPicker || !this.contextPickerMode || !this.isInputEnabled || this.isAgentBusy) {
      this.closeContextPicker();
      return;
    }

    const tabs = await this.getAvailableContextTabs(this.contextPickerQuery);
    this.contextPickerItems = tabs;
    this.contextPickerHighlightIndex = Math.min(this.contextPickerHighlightIndex, Math.max(tabs.length - 1, 0));
    this.renderContextPickerList();
  }

  private renderContextPickerList(): void {
    if (!this.contextPicker) return;
    if (!this.contextPickerMode) {
      this.closeContextPicker();
      return;
    }

    const hint = this.contextPickerMode === 'mention'
      ? 'Attach a tab with @'
      : 'Add another tab to the message context';

    if (this.contextPickerItems.length === 0) {
      this.contextPicker.innerHTML = `
        <div class="context-picker-header">${this.escapeHtml(hint)}</div>
        <div class="context-picker-empty">No matching tabs</div>`;
      this.contextPicker.classList.remove('hidden');
      return;
    }

    const itemsHtml = this.contextPickerItems.map((tab, index) => {
      const title = this.escapeHtml(tab.title || '(untitled tab)');
      const url = this.escapeHtml(this.truncateText(tab.url || '', 90));
      return `
        <button class="context-picker-item${index === this.contextPickerHighlightIndex ? ' active' : ''}" type="button" data-tab-id="${tab.tabId}">
          <span class="context-picker-item-title">${title}</span>
          <span class="context-picker-item-url">${url}</span>
        </button>`;
    }).join('');

    this.contextPicker.innerHTML = `
      <div class="context-picker-header">${this.escapeHtml(hint)}</div>
      <div class="context-picker-list">${itemsHtml}</div>`;

    this.contextPicker.querySelectorAll<HTMLButtonElement>('.context-picker-item').forEach((button, index) => {
      button.addEventListener('mouseenter', () => {
        this.contextPickerHighlightIndex = index;
        this.updateContextPickerHighlight();
      });
      button.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const selected = this.contextPickerItems[index];
        if (selected) this.selectContextPickerItem(selected);
      });
      button.addEventListener('click', (e) => {
        e.preventDefault();
        const selected = this.contextPickerItems[index];
        if (selected) this.selectContextPickerItem(selected);
      });
    });

    this.contextPicker.classList.remove('hidden');
    this.updateContextPickerHighlight();
  }

  private updateContextPickerHighlight(): void {
    if (!this.contextPicker) return;
    const items = this.contextPicker.querySelectorAll<HTMLButtonElement>('.context-picker-item');
    items.forEach((button, index) => {
      button.classList.toggle('active', index === this.contextPickerHighlightIndex);
    });
    const active = items[this.contextPickerHighlightIndex];
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  private scrollContextTabsToEnd(): void {
    if (!this.contextTabsContainer) return;
    requestAnimationFrame(() => {
      this.contextTabsContainer.scrollLeft = this.contextTabsContainer.scrollWidth;
    });
  }

  private async getAvailableContextTabs(query: string): Promise<ContextTabOption[]> {
    const selectedIds = new Set(this.getSelectedContextTabIds());
    const normalizedQuery = query.trim().toLowerCase();
    const tabs = await chrome.tabs.query({});

    return tabs
      .filter((tab) => tab.id !== undefined)
      .map((tab) => ({
        tabId: tab.id!,
        title: tab.title ?? '',
        url: tab.url ?? '',
        active: tab.active ?? false,
      }))
      .filter((tab) => !selectedIds.has(tab.tabId))
      .filter((tab) => {
        if (!normalizedQuery) return true;
        const haystack = `${tab.title} ${tab.url}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  }

  private selectContextPickerItem(tab: ContextTabOption): void {
    if (this.contextPickerMode === 'mention') {
      this.applyMentionSelection();
    }

    if (this.currentContextTab?.tabId === tab.tabId) {
      this.includeCurrentContextTab = true;
      this.extraContextTabs = this.extraContextTabs.filter((entry) => entry.tabId !== tab.tabId);
    } else {
      const withoutSelected = this.extraContextTabs.filter((entry) => entry.tabId !== tab.tabId);
      this.extraContextTabs = this.includeCurrentContextTab
        ? [...withoutSelected, tab]
        : [tab, ...withoutSelected];
    }

    this.renderContextTabs();
    this.closeContextPicker();
    this.autoResizeMessageInput();
    this.messageInput.focus();
  }

  private applyMentionSelection(): void {
    if (!this.mentionRange) return;
    const { start, end } = this.mentionRange;
    const value = this.messageInput.value;
    const before = value.slice(0, start);
    const after = value.slice(end);
    let nextBefore = before;
    let nextAfter = after;

    if (/\s$/.test(nextBefore) && /^\s/.test(nextAfter)) {
      nextAfter = nextAfter.replace(/^\s+/, ' ');
    } else if (nextBefore.length > 0 && nextAfter.length > 0 && !/\s$/.test(nextBefore) && !/^\s/.test(nextAfter)) {
      nextAfter = ` ${nextAfter}`;
    }

    this.messageInput.value = `${nextBefore}${nextAfter}`;
    this.messageInput.setSelectionRange(nextBefore.length, nextBefore.length);
  }

  private syncMentionPickerFromInput(): void {
    if (!this.isInputEnabled || this.isAgentBusy) {
      this.closeContextPicker();
      return;
    }

    const selectionStart = this.messageInput.selectionStart ?? this.messageInput.value.length;
    const beforeCaret = this.messageInput.value.slice(0, selectionStart);
    const match = beforeCaret.match(/(^|\s)@([^\s@]*)$/);
    if (!match) {
      if (this.contextPickerMode === 'mention') this.closeContextPicker();
      return;
    }

    const query = match[2] ?? '';
    const tokenStart = selectionStart - match[0].length + match[1].length;
    this.contextPickerMode = 'mention';
    this.contextPickerQuery = query;
    this.contextPickerHighlightIndex = 0;
    this.mentionRange = { start: tokenStart, end: selectionStart };
    void this.refreshContextPicker();
  }

  private closeContextPicker(): void {
    this.contextPickerMode = null;
    this.contextPickerItems = [];
    this.contextPickerQuery = '';
    this.contextPickerHighlightIndex = 0;
    this.mentionRange = null;
    if (this.contextPicker) {
      this.contextPicker.classList.add('hidden');
      this.contextPicker.innerHTML = '';
    }
  }

  private startNewConversation(): void {
    this.callbacks.onConversationNew();
    this.currentConversationId = null;
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
      this.closeContextPicker();
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
      this.populatePromptFields();
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
          ${this.renderToolInputParameters(details.inputSchema)}
        </div>
      </div>`;
  }

  private renderToolInputParameters(inputSchema?: Record<string, unknown>): string {
    const properties = this.asRecord(inputSchema?.properties);
    if (!properties || Object.keys(properties).length === 0) {
      return '<div class="tool-card-empty-detail">No arguments.</div>';
    }

    const required = new Set(
      Array.isArray(inputSchema?.required)
        ? inputSchema.required.filter((name): name is string => typeof name === 'string')
        : [],
    );

    return `
      <div class="tool-param-list">
        ${Object.entries(properties).map(([name, schema]) => {
          const prop = this.asRecord(schema);
          const label = prop?.title && typeof prop.title === 'string' ? prop.title : name;
          const description = prop?.description && typeof prop.description === 'string' ? prop.description : '';
          return `
            <div class="tool-param">
              <div class="tool-param-heading">
                <span class="tool-param-name">${this.escapeHtml(label)}</span>
                <span class="tool-param-type">${this.escapeHtml(this.formatSchemaType(prop))}</span>
                <span class="tool-param-required ${required.has(name) ? 'required' : ''}">${required.has(name) ? 'Required' : 'Optional'}</span>
              </div>
              ${label !== name ? `<div class="tool-param-key">${this.escapeHtml(name)}</div>` : ''}
              ${description ? `<div class="tool-param-description">${this.escapeHtml(description)}</div>` : ''}
            </div>`;
        }).join('')}
      </div>`;
  }

  private formatSchemaType(schema?: Record<string, unknown>): string {
    if (!schema) return 'value';
    const rawType = schema.type;
    const type = Array.isArray(rawType)
      ? rawType.filter((value): value is string => typeof value === 'string').join(' | ')
      : typeof rawType === 'string' ? rawType : 'value';
    const enumValues = Array.isArray(schema.enum)
      ? schema.enum.slice(0, 4).map((value) => this.truncateText(String(value), 24)).join(' | ')
      : '';
    const enumSuffix = Array.isArray(schema.enum) && schema.enum.length > 4 ? ' | ...' : '';
    return enumValues ? `${type}: ${enumValues}${enumSuffix}` : type;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private createToolsPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'tools-panel';
    panel.style.display = 'none';

    panel.innerHTML = `
      <div class="tools-panel-inner">
        <p class="tools-panel-subtitle">Enable or disable tool sources and individual tools</p>
        <div class="tools-groups-container"></div>
      </div>`;

    return panel;
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

  private createMCPPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'mcp-panel';
    panel.style.display = 'none';

    panel.innerHTML = `
      <div class="mcp-panel-inner">
        <p class="mcp-panel-subtitle">Connect to remote MCP servers (HTTP/SSE)</p>
        <div class="mcp-add-form">
          <div class="mcp-add-row">
            <input type="text" class="mcp-add-name" placeholder="Server name" autocomplete="off" />
          </div>
          <div class="mcp-add-row">
            <input type="text" class="mcp-add-url" placeholder="http://host:port/mcp" autocomplete="off" />
          </div>
          <div class="mcp-add-row">
            <input type="password" class="mcp-add-token" placeholder="Auth token (optional)" autocomplete="off" />
          </div>
          <button class="mcp-add-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            Connect
          </button>
          <div class="mcp-add-status"></div>
        </div>
        <div class="mcp-servers-list"></div>
      </div>`;

    // Stop key propagation (same as config panel)
    panel.addEventListener('keydown', (e) => e.stopPropagation());
    panel.addEventListener('keyup', (e) => e.stopPropagation());
    panel.addEventListener('keypress', (e) => e.stopPropagation());

    // Add button
    panel.querySelector('.mcp-add-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.handleAddMCPServer();
    });

    // Enter key on URL field
    panel.querySelector('.mcp-add-url')?.addEventListener('keydown', async (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        await this.handleAddMCPServer();
      }
    });

    return panel;
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

  private createConversationsPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'conversations-panel';
    panel.style.display = 'none';

    panel.innerHTML = `
      <div class="conversations-panel-inner">
        <div class="conversations-header-row">
          <p class="conversations-panel-subtitle">Your saved conversations</p>
          <button class="conversations-new-btn" title="New Conversation">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            New
          </button>
        </div>
        <div class="conversations-list-container"></div>
      </div>`;

    // New conversation button
    panel.querySelector('.conversations-new-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.startNewConversation();
    });

    return panel;
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

      // Sort by most recent first
      const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

      for (const convo of sorted) {
        const el = document.createElement('div');
        el.className = 'conversation-item' + (this.currentConversationId === convo.id ? ' active' : '');
        const date = new Date(convo.updatedAt);
        const timeStr = this.formatRelativeTime(date);
        const msgCount = convo.messages.filter(m => m.role === 'user').length;

        el.innerHTML = `
          <div class="conversation-item-content">
            <div class="conversation-item-title">${this.escapeHtml(convo.title)}</div>
            <div class="conversation-item-meta">
              <span>${msgCount} message${msgCount !== 1 ? 's' : ''}</span>
              <span>·</span>
              <span>${timeStr}</span>
            </div>
          </div>
          <button class="conversation-delete-btn" title="Delete conversation" data-id="${convo.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>`;

        // Click to load conversation
        el.querySelector('.conversation-item-content')?.addEventListener('click', () => {
          this.currentConversationId = convo.id;
          this.callbacks.onConversationLoad(convo);
          this.setActiveSurface('chat');
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
  public saveCurrentConversation(chatHistory: Array<{ role: string; content: string }>): void {
    // Collect messages from DOM
    const messages: SavedConversation['messages'] = [];
    const msgEls = this.messagesContainer.querySelectorAll('.message');
    msgEls.forEach(el => {
      let role: 'user' | 'assistant' | 'system' = 'system';
      if (el.classList.contains('user-message')) role = 'user';
      else if (el.classList.contains('assistant-message') && !el.classList.contains('typing-indicator')) role = 'assistant';

      const content = el.querySelector('.message-content')?.textContent ?? '';
      const time = el.querySelector('.message-time')?.textContent ?? '';
      if (content) messages.push({ role, content, time });
    });

    if (messages.length === 0) return;

    const firstUserMsg = messages.find(m => m.role === 'user');
    const title = firstUserMsg
      ? (firstUserMsg.content.length > 50 ? firstUserMsg.content.slice(0, 50) + '…' : firstUserMsg.content)
      : 'New conversation';

    const now = Date.now();
    const convo: SavedConversation = {
      id: this.currentConversationId ?? this.generateId(),
      title,
      createdAt: now,
      updatedAt: now,
      messages,
      chatHistory: [...chatHistory],
    };

    this.currentConversationId = convo.id;
    void upsertSavedConversation(convo);
  }

  /** Load a conversation into the chat view */
  public loadConversation(convo: SavedConversation): void {
    this.clearMessages();
    this.currentConversationId = convo.id;

    for (const msg of convo.messages) {
      if (msg.role === 'user') {
        this.addUserMessage(msg.content);
      } else if (msg.role === 'assistant') {
        this.addAssistantMessage(msg.content);
      } else {
        this.addSystemMessage(msg.content);
      }
    }
  }

  /** Clear all messages from the view */
  public clearMessages(): void {
    this.messagesContainer.innerHTML = '';
    this.currentToolStepsContainer = null;
    this.toolStepsCollapsed = false;
    this.expandedToolStepDetails.clear();
    this.streamingElement = null;
    if (this.streamingTimer !== null) {
      clearInterval(this.streamingTimer);
      this.streamingTimer = null;
    }
    this.streamingAccumulated = '';
    this.streamingWordQueue = [];
  }

  /** Delete a conversation from storage */
  public deleteConversation(id: string): void {
    void removeSavedConversation(id);
    if (this.currentConversationId === id) {
      this.currentConversationId = null;
    }
  }

  /** Set current conversation id */
  public setCurrentConversationId(id: string | null): void {
    this.currentConversationId = id;
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  private formatRelativeTime(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  }

  // ─── Config Panel ───────────────────────────────────────────────────────

  private toggleConfigPanel(): void {
    this.setActiveSurface(this.activeSurface === 'config' ? 'chat' : 'config');
  }

  private createConfigPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'llm-config-panel';
    panel.style.display = 'none';

    panel.innerHTML = `
      <div class="config-panel-inner">
        <div class="config-mode-toggle">
          <button class="config-mode-btn active" data-mode="openai">
            <img src="${chrome.runtime.getURL('icons/openai.png')}" class="provider-icon" alt="" />
            <span>OpenAI</span>
          </button>
          <button class="config-mode-btn" data-mode="claude">
            <img src="${chrome.runtime.getURL('icons/claude.png')}" class="provider-icon" alt="" />
            <span>Claude</span>
          </button>
        </div>

        <div class="config-fields config-openai-fields">
          <div class="config-field">
            <label for="llm-config-endpoint">Base URL</label>
            <div class="config-endpoint-row">
              <input type="text" id="llm-config-endpoint" placeholder="http://localhost:11434/v1" autocomplete="off" />
              <button class="config-refresh-btn" id="llm-config-refresh" title="Fetch models">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14">
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                </svg>
              </button>
            </div>
          </div>
          <div class="config-field">
            <label for="llm-config-api-key">API Key</label>
            <input type="password" id="llm-config-api-key" placeholder="sk-… or leave blank" autocomplete="off" />
          </div>
          <div class="config-field" id="llm-config-model-field">
            <label>Model</label>
            <input type="text" id="llm-config-model" placeholder="gpt-4o" autocomplete="off" />
          </div>
        </div>

        <div class="config-fields config-claude-fields" style="display: none;">
          <div class="config-field">
            <label for="claude-config-endpoint">API Base URL</label>
            <input type="text" id="claude-config-endpoint" placeholder="https://api.anthropic.com/v1" autocomplete="off" />
          </div>
          <div class="config-field">
            <label for="claude-config-api-key">Anthropic API Key</label>
            <input type="password" id="claude-config-api-key" placeholder="sk-ant-…" autocomplete="off" />
          </div>
          <div class="config-field">
            <label for="claude-config-model">Model</label>
            <input type="text" id="claude-config-model" placeholder="claude-opus-4-5" autocomplete="off" />
          </div>
        </div>

        <hr class="config-divider" />
        <h3 class="config-section-title">Runtime</h3>
        <div class="config-fields config-agent-fields">
          <div class="config-field">
            <label for="llm-config-recursion-limit">Recursion Limit</label>
            <input type="number" id="llm-config-recursion-limit" min="1" step="1" placeholder="100" autocomplete="off" />
          </div>
        </div>

        <hr class="config-divider" />
        <h3 class="config-section-title">Vision LM (VLM)</h3>
        <div class="config-fields config-vlm-fields">
          <div class="config-field">
            <label for="vlm-config-endpoint">VLM Endpoint</label>
            <input type="text" id="vlm-config-endpoint" placeholder="http://host:port/v1" autocomplete="off" />
          </div>
          <div class="config-field">
            <label for="vlm-config-api-key">VLM API Key (optional)</label>
            <input type="password" id="vlm-config-api-key" placeholder="Bearer token" autocomplete="off" />
          </div>
          <div class="config-field">
            <label for="vlm-config-model">VLM Model</label>
            <input type="text" id="vlm-config-model" placeholder="Qwen3-VL-30B-A3B-Thinking" autocomplete="off" />
          </div>
        </div>

        <button class="config-apply-btn">Apply &amp; Reconnect</button>
        <div class="config-status"></div>
      </div>`;

    // Mode toggle
    const modeBtns = panel.querySelectorAll('.config-mode-btn');
    modeBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = (btn as HTMLElement).dataset.mode as 'openai' | 'claude';
        this.configMode = mode;
        modeBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const of = panel.querySelector('.config-openai-fields') as HTMLElement;
        const cf = panel.querySelector('.config-claude-fields') as HTMLElement;
        if (of) of.style.display = mode === 'openai' ? '' : 'none';
        if (cf) cf.style.display = mode === 'claude' ? '' : 'none';
      });
    });

    // Apply
    panel.querySelector('.config-apply-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.applyConfig();
    });

    // Fetch models
    panel.querySelector('#llm-config-refresh')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.fetchModels();
    });

    // Stop key propagation
    panel.addEventListener('keydown', (e) => e.stopPropagation());
    panel.addEventListener('keyup', (e) => e.stopPropagation());
    panel.addEventListener('keypress', (e) => e.stopPropagation());

    return panel;
  }

  private togglePromptPanel(): void {
    this.setActiveSurface(this.activeSurface === 'prompt' ? 'chat' : 'prompt');
  }

  private createPromptPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'llm-config-panel prompt-panel';
    panel.style.display = 'none';

    panel.innerHTML = `
      <div class="config-panel-inner prompt-panel-inner">
        <p class="prompt-panel-note">Active skills inject their name and description at runtime. The agent can inspect full skill details later with the <code>skills_load</code> tool.</p>
        <div class="skills-registry-header">
          <div class="skills-registry-heading">
            <h3 class="config-section-title">Skills Registry</h3>
            <p class="skills-registry-subtitle">Reusable SKILL.md-style helpers. Enable a skill to inject its name and description into the agent prompt.</p>
          </div>
          <button class="skills-new-btn" type="button">New Skill</button>
        </div>
        <div class="skills-import-toolbar">
          <div class="skills-import-url-row">
            <input type="text" class="skills-import-url" placeholder="https://example.com/SKILL.md" autocomplete="off" />
            <button class="skills-import-url-btn" type="button">Load URL</button>
          </div>
          <div class="skills-dropzone" tabindex="0" role="button" aria-label="Drop markdown file here or click to browse">
            <span>Drop <code>.md</code> file here or click to browse</span>
            <input type="file" class="skills-file-input" accept=".md,text/markdown" />
        </div>
        </div>
        <div class="skills-registry-count">0 skill(s)</div>
        <div class="skill-editor-dock">
          <div class="skill-editor-panel" style="display: none;">
            <div class="skill-editor-header">
              <h4 class="skill-editor-title">New Skill</h4>
              <div class="config-editor-toggle" role="tablist" aria-label="Skill content view">
                <button type="button" class="config-editor-btn active" data-skill-view="edit">Edit</button>
                <button type="button" class="config-editor-btn" data-skill-view="preview">Preview</button>
              </div>
            </div>
            <div class="config-fields skill-editor-fields">
              <div class="config-field">
                <label for="skill-display-name">Display Name</label>
                <input type="text" id="skill-display-name" placeholder="My Custom Skill" autocomplete="off" />
              </div>
              <div class="config-field">
                <label for="skill-slug">Slug</label>
                <input type="text" id="skill-slug" placeholder="my-custom-skill" autocomplete="off" />
              </div>
              <div class="config-field">
                <label for="skill-description">Description</label>
                <input type="text" id="skill-description" placeholder="Short description for card display" autocomplete="off" />
              </div>
              <div class="config-field">
                <label for="skill-tags">Tags</label>
                <input type="text" id="skill-tags" placeholder="debugging, testing, performance" autocomplete="off" />
              </div>
              <div class="config-field">
                <label for="skill-content">Skill Content (Markdown)</label>
                <textarea id="skill-content" class="skill-content-input" spellcheck="false" placeholder="# My Skill&#10;&#10;Paste or type the full SKILL.md content here..."></textarea>
                <div id="skill-content-preview" class="config-system-prompt-preview skill-content-preview" style="display: none;"></div>
              </div>
            </div>
            <div class="skill-editor-actions">
              <button class="config-apply-btn skill-save-btn" type="button">Save Skill</button>
              <button class="skill-cancel-btn" type="button">Cancel</button>
            </div>
          </div>
        </div>
        <div class="skills-registry-list"></div>
        <div class="config-fields config-prompt-fields">
          <h3 class="config-section-title">System Prompt</h3>
          <div class="config-field config-system-prompt-field">
            <div class="config-field-header">
              <label for="llm-config-system-prompt">Prompt</label>
              <div class="config-editor-toggle" role="tablist" aria-label="System prompt view">
                <button type="button" class="config-editor-btn active" data-view="edit">Edit</button>
                <button type="button" class="config-editor-btn" data-view="preview">Preview</button>
              </div>
            </div>
            <textarea id="llm-config-system-prompt" class="config-system-prompt-input" spellcheck="false"></textarea>
            <div id="llm-config-system-prompt-preview" class="config-system-prompt-preview" style="display: none;"></div>
          </div>
        </div>
        <button class="config-apply-btn prompt-apply-btn">Apply Prompt</button>
        <div class="config-status prompt-status"></div>
      </div>`;

    const systemPromptInput = panel.querySelector('#llm-config-system-prompt') as HTMLTextAreaElement | null;
    systemPromptInput?.addEventListener('input', () => this.refreshSystemPromptPreview(panel));

    panel.querySelectorAll('.config-editor-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const view = (btn as HTMLElement).dataset.view as 'edit' | 'preview';
        this.setSystemPromptPreviewMode(view, panel);
      });
    });

    panel.querySelector('.prompt-apply-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.applyPrompt();
    });

    panel.querySelector('.skills-new-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openSkillEditor();
    });

    const importUrlInput = panel.querySelector('.skills-import-url') as HTMLInputElement | null;
    const importFileInput = panel.querySelector('.skills-file-input') as HTMLInputElement | null;
    const dropzone = panel.querySelector('.skills-dropzone') as HTMLElement | null;

    panel.querySelector('.skills-import-url-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.importSkillFromUrl();
    });
    importUrlInput?.addEventListener('keydown', async (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        await this.importSkillFromUrl();
      }
    });

    importFileInput?.addEventListener('change', async () => {
      const file = importFileInput.files?.[0];
      if (!file) return;
      await this.importSkillFromFile(file);
      importFileInput.value = '';
    });

    dropzone?.addEventListener('click', () => importFileInput?.click());
    dropzone?.addEventListener('keydown', (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        importFileInput?.click();
      }
    });
    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    });
    dropzone?.addEventListener('dragleave', (e) => {
      if (!dropzone.contains(e.relatedTarget as Node | null)) {
        dropzone.classList.remove('is-dragover');
      }
    });
    dropzone?.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-dragover');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      await this.importSkillFromFile(file);
    });

    panel.querySelectorAll('.config-editor-btn[data-skill-view]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const view = (btn as HTMLElement).dataset.skillView as 'edit' | 'preview';
        this.setSkillContentPreviewMode(view);
      });
    });

    const skillNameInput = panel.querySelector('#skill-display-name') as HTMLInputElement | null;
    const skillSlugInput = panel.querySelector('#skill-slug') as HTMLInputElement | null;
    const skillContentInput = panel.querySelector('#skill-content') as HTMLTextAreaElement | null;

    skillNameInput?.addEventListener('input', () => {
      if (!this.skillEditorSlugDirty && skillSlugInput) {
        skillSlugInput.value = slugifySkillName(skillNameInput.value);
      }
    });
    skillSlugInput?.addEventListener('input', () => {
      this.skillEditorSlugDirty = true;
      skillSlugInput.value = slugifySkillName(skillSlugInput.value);
    });
    skillContentInput?.addEventListener('input', () => this.refreshSkillContentPreview());

    panel.querySelector('.skill-save-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.saveSkillFromEditor();
    });
    panel.querySelector('.skill-cancel-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeSkillEditor();
    });

    panel.addEventListener('keydown', (e) => e.stopPropagation());
    panel.addEventListener('keyup', (e) => e.stopPropagation());
    panel.addEventListener('keypress', (e) => e.stopPropagation());

    this.setSystemPromptPreviewMode('edit', panel);
    this.setSkillContentPreviewMode('edit', panel);
    return panel;
  }

  private populatePromptFields(): void {
    void loadPromptEditorState().then(({ systemPrompt, skills }) => {
      this.skillRegistry = skills;
      this.setPromptInput('llm-config-system-prompt', systemPrompt || DEFAULT_SYSTEM_PROMPT);
      this.refreshSystemPromptPreview(this.promptPanel);
      this.setSystemPromptPreviewMode(this.systemPromptPreviewMode, this.promptPanel);
      this.isSkillEditorOpen = false;
      this.editingSkillId = null;
      this.renderSkillRegistry();
      this.closeSkillEditor(false);
    });
  }

  private applyPrompt(): void {
    const systemPrompt = this.getPromptInput('llm-config-system-prompt') || DEFAULT_SYSTEM_PROMPT;
    void saveSystemPrompt(systemPrompt);

    this.callbacks.onSystemPromptApply(systemPrompt);

    this.setPromptStatus('Prompt applied.', 'success');
    setTimeout(() => {
      this.togglePromptPanel();
      this.setPromptStatus('');
    }, 900);
  }

  private renderSkillRegistry(): void {
    const list = this.promptPanel.querySelector('.skills-registry-list') as HTMLElement | null;
    const count = this.promptPanel.querySelector('.skills-registry-count') as HTMLElement | null;
    const dock = this.promptPanel.querySelector('.skill-editor-dock') as HTMLElement | null;
    const editorPanel = this.promptPanel.querySelector('.skill-editor-panel') as HTMLElement | null;
    if (!list || !count || !dock || !editorPanel) return;

    count.textContent = `${this.skillRegistry.length} skill${this.skillRegistry.length !== 1 ? 's' : ''}`;
    list.innerHTML = '';
    let editorPlaced = false;

    if (!this.isSkillEditorOpen || !this.editingSkillId) {
      dock.appendChild(editorPanel);
      editorPlaced = true;
    }
    editorPanel.style.display = this.isSkillEditorOpen ? 'flex' : 'none';

    if (this.skillRegistry.length === 0) {
      if (!editorPlaced) {
        dock.appendChild(editorPanel);
      }
      const empty = document.createElement('div');
      empty.className = 'skills-empty-state';
      empty.textContent = 'No skills yet. Create one to make reusable guidance available to Brow.';
      list.appendChild(empty);
      return;
    }

    for (const skill of this.skillRegistry) {
      const card = document.createElement('div');
      const isEditing = this.isSkillEditorOpen && this.editingSkillId === skill.id;
      card.className = `skill-card${skill.enabled ? ' enabled' : ' disabled'}${isEditing ? ' is-editing' : ''}`;
      const tags = skill.tags.length > 0
        ? `<div class="skill-card-tags">${skill.tags.map((tag) => `<span class="skill-tag">${this.escapeHtml(tag)}</span>`).join('')}</div>`
        : '';

      card.innerHTML = `
        <div class="skill-card-header">
          <div class="skill-card-title-group">
            <div class="skill-card-title">${this.escapeHtml(skill.name)}</div>
            <div class="skill-card-slug">${this.escapeHtml(skill.slug)}</div>
          </div>
          <button class="skill-remove-btn" type="button" aria-label="Remove skill" title="Remove skill">×</button>
        </div>
        <div class="skill-card-description">${this.escapeHtml(skill.description || 'No description provided.')}</div>
        ${tags}
        <div class="skill-card-footer">
          <div class="skill-card-meta">Updated ${this.formatRelativeTime(new Date(skill.updatedAt))}</div>
          <div class="skill-card-actions">
            <button class="skill-toggle-btn${skill.enabled ? ' is-enabled' : ''}" type="button">${skill.enabled ? 'Active' : 'Inactive'}</button>
            <button class="skill-edit-btn" type="button">${isEditing ? 'Close' : 'Edit'}</button>
          </div>
        </div>`;

      card.querySelector('.skill-toggle-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.skillRegistry = this.skillRegistry.map((entry) =>
          entry.id === skill.id ? { ...entry, enabled: !entry.enabled, updatedAt: Date.now() } : entry,
        );
        this.persistSkillRegistry(skill.enabled ? 'Skill disabled.' : 'Skill enabled.');
      });

      card.querySelector('.skill-edit-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isEditing) {
          this.closeSkillEditor();
          return;
        }
        this.openSkillEditor(skill);
      });

      card.querySelector('.skill-remove-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeSkill(skill.id);
      });

      list.appendChild(card);

      if (isEditing) {
        const inlineEditor = document.createElement('div');
        inlineEditor.className = 'skill-card-inline-editor';
        inlineEditor.appendChild(editorPanel);
        editorPlaced = true;
        list.appendChild(inlineEditor);
      }
    }

    if (!editorPlaced) {
      dock.appendChild(editorPanel);
    }
  }

  private async importSkillFromUrl(): Promise<void> {
    const urlInput = this.promptPanel.querySelector('.skills-import-url') as HTMLInputElement | null;
    const importButton = this.promptPanel.querySelector('.skills-import-url-btn') as HTMLButtonElement | null;
    const rawUrl = urlInput?.value.trim() ?? '';
    if (!rawUrl) {
      this.setPromptStatus('Enter a skill URL first.', 'error');
      return;
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      this.setPromptStatus('Skill URL is not valid.', 'error');
      return;
    }

    if (importButton) importButton.disabled = true;
    this.setPromptStatus('Loading skill from URL…');

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const markdown = await response.text();
      const sourceName = url.pathname.split('/').pop() || url.hostname;
      this.prefillSkillEditorFromMarkdown(markdown, sourceName);
      this.setPromptStatus('Skill imported from URL. Review and save it.', 'success');
    } catch (err: any) {
      this.setPromptStatus(`Could not load skill from URL: ${err.message ?? err}`, 'error');
    } finally {
      if (importButton) importButton.disabled = false;
    }
  }

  private async importSkillFromFile(file: File): Promise<void> {
    const fileName = file.name || 'skill.md';
    if (!/\.md$/i.test(fileName) && file.type && file.type !== 'text/markdown' && file.type !== 'text/plain') {
      this.setPromptStatus('Only markdown skill files are supported.', 'error');
      return;
    }

    try {
      const markdown = await file.text();
      this.prefillSkillEditorFromMarkdown(markdown, fileName);
      this.setPromptStatus(`Imported ${fileName}. Review and save it.`, 'success');
    } catch (err: any) {
      this.setPromptStatus(`Could not read ${fileName}: ${err.message ?? err}`, 'error');
    }
  }

  private prefillSkillEditorFromMarkdown(markdown: string, sourceName?: string): void {
    const draft = parseSkillMarkdownImport(markdown, sourceName);
    this.openSkillEditor(undefined, draft);
  }

  private openSkillEditor(skill?: SkillRegistryEntry, draft?: SkillDraft): void {
    const panel = this.promptPanel.querySelector('.skill-editor-panel') as HTMLElement | null;
    const title = this.promptPanel.querySelector('.skill-editor-title') as HTMLElement | null;
    const nameInput = this.promptPanel.querySelector('#skill-display-name') as HTMLInputElement | null;
    const slugInput = this.promptPanel.querySelector('#skill-slug') as HTMLInputElement | null;
    const descriptionInput = this.promptPanel.querySelector('#skill-description') as HTMLInputElement | null;
    const tagsInput = this.promptPanel.querySelector('#skill-tags') as HTMLInputElement | null;
    const contentInput = this.promptPanel.querySelector('#skill-content') as HTMLTextAreaElement | null;
    const saveButton = this.promptPanel.querySelector('.skill-save-btn') as HTMLButtonElement | null;
    if (!panel || !title || !nameInput || !slugInput || !descriptionInput || !tagsInput || !contentInput || !saveButton) return;

    this.isSkillEditorOpen = true;
    this.editingSkillId = skill?.id ?? null;
    this.skillEditorSlugDirty = Boolean(skill);
    title.textContent = skill ? 'Edit Skill' : 'New Skill';
    saveButton.textContent = skill ? 'Update Skill' : 'Create Skill';
    nameInput.value = skill?.name ?? draft?.name ?? '';
    slugInput.value = skill?.slug ?? draft?.slug ?? '';
    descriptionInput.value = skill?.description ?? draft?.description ?? '';
    tagsInput.value = skill ? formatSkillTagsInput(skill.tags) : formatSkillTagsInput(draft?.tags ?? []);
    contentInput.value = skill?.content ?? draft?.content ?? '';
    panel.style.display = 'flex';
    this.setSkillContentPreviewMode('edit');
    this.refreshSkillContentPreview();
    this.renderSkillRegistry();
    window.setTimeout(() => nameInput.focus(), 0);
  }

  private closeSkillEditor(rerender = true): void {
    const panel = this.promptPanel.querySelector('.skill-editor-panel') as HTMLElement | null;
    const dock = this.promptPanel.querySelector('.skill-editor-dock') as HTMLElement | null;
    if (panel && dock) {
      dock.appendChild(panel);
    }
    if (panel) panel.style.display = 'none';
    this.isSkillEditorOpen = false;
    this.editingSkillId = null;
    this.skillEditorSlugDirty = false;
    this.setSkillContentPreviewMode('edit');
    if (rerender) {
      this.renderSkillRegistry();
    }
  }

  private removeSkill(skillId: string): void {
    const removedSkill = this.skillRegistry.find((skill) => skill.id === skillId);
    if (!removedSkill) return;

    this.skillRegistry = this.skillRegistry.filter((skill) => skill.id !== skillId);
    if (this.editingSkillId === skillId) {
      this.closeSkillEditor(false);
    }
    this.persistSkillRegistry(`Skill "${removedSkill.name}" removed.`);
  }

  private saveSkillFromEditor(): void {
    const nameInput = this.promptPanel.querySelector('#skill-display-name') as HTMLInputElement | null;
    const slugInput = this.promptPanel.querySelector('#skill-slug') as HTMLInputElement | null;
    const descriptionInput = this.promptPanel.querySelector('#skill-description') as HTMLInputElement | null;
    const tagsInput = this.promptPanel.querySelector('#skill-tags') as HTMLInputElement | null;
    const contentInput = this.promptPanel.querySelector('#skill-content') as HTMLTextAreaElement | null;
    if (!nameInput || !slugInput || !descriptionInput || !tagsInput || !contentInput) return;

    const name = nameInput.value.trim();
    const slug = slugifySkillName(slugInput.value || name);
    const description = descriptionInput.value.trim();
    const content = contentInput.value.trim();
    const tags = parseSkillTagsInput(tagsInput.value);

    if (!name || !description || !content) {
      this.setPromptStatus('Name, description, and content are required for a skill.', 'error');
      return;
    }

    const duplicate = this.skillRegistry.find((skill) =>
      skill.slug === slug && skill.id !== this.editingSkillId,
    );
    if (duplicate) {
      this.setPromptStatus(`Slug "${slug}" is already used by another skill.`, 'error');
      return;
    }

    const now = Date.now();
    const existing = this.skillRegistry.find((skill) => skill.id === this.editingSkillId);
    const nextSkill: SkillRegistryEntry = existing
      ? {
        ...existing,
        name,
        slug,
        description,
        tags,
        content,
        updatedAt: now,
      }
      : {
        id: this.generateId(),
        name,
        slug,
        description,
        tags,
        content,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };

    this.skillRegistry = [
      nextSkill,
      ...this.skillRegistry.filter((skill) => skill.id !== nextSkill.id),
    ];
    this.persistSkillRegistry(existing ? 'Skill updated.' : 'Skill created.');
    this.closeSkillEditor();
  }

  private setSkillContentPreviewMode(
    mode: 'edit' | 'preview',
    root: ParentNode = this.promptPanel,
  ): void {
    this.skillContentPreviewMode = mode;
    root.querySelectorAll<HTMLElement>('.config-editor-btn[data-skill-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.skillView === mode);
    });

    const input = root.querySelector('#skill-content') as HTMLTextAreaElement | null;
    const preview = root.querySelector('#skill-content-preview') as HTMLElement | null;
    if (!input || !preview) return;

    this.refreshSkillContentPreview(root);
    input.style.display = mode === 'edit' ? '' : 'none';
    preview.style.display = mode === 'preview' ? '' : 'none';
  }

  private refreshSkillContentPreview(root: ParentNode = this.promptPanel): void {
    const input = root.querySelector('#skill-content') as HTMLTextAreaElement | null;
    const preview = root.querySelector('#skill-content-preview') as HTMLElement | null;
    if (!input || !preview) return;
    preview.innerHTML = this.renderMarkdownPreview(input.value.trim() || '# Skill');
  }

  private persistSkillRegistry(message?: string): void {
    void saveSkillRegistryEntries(this.skillRegistry).then((skills) => {
      this.skillRegistry = skills;
      this.callbacks.onSkillRegistryApply(this.skillRegistry);
      this.renderSkillRegistry();
      if (message) {
        this.setPromptStatus(message, 'success');
      }
    });
  }

  private setPromptStatus(message: string, tone: '' | 'success' | 'error' = ''): void {
    const statusEl = this.promptPanel.querySelector('.prompt-status') as HTMLElement | null;
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = `config-status prompt-status${tone ? ` ${tone}` : ''}`;
  }

  private populateConfigFields(): void {
    void loadConfigEditorState().then((saved) => {
      const openai = { ...DEFAULT_OPENAI_FIELDS, ...saved.openai };
      const claude = { ...DEFAULT_CLAUDE_FIELDS, ...saved.claude };
      const vlm = { ...DEFAULT_VLM_CONFIG, ...saved.vlm };

      this.setInput('llm-config-endpoint', openai.baseUrl);
      this.setInput('llm-config-api-key', openai.apiKey);
      this.setInput('llm-config-model', openai.model);
      this.setInput('claude-config-endpoint', claude.baseUrl);
      this.setInput('claude-config-api-key', claude.apiKey);
      this.setInput('claude-config-model', claude.model);
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
    });
  }

  private applyConfig(): void {
    const statusEl = this.configPanel.querySelector('.config-status') as HTMLElement;
    const fields: Record<string, string> = {};
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
      fields.baseUrl = this.getInput('llm-config-endpoint');
      fields.apiKey = this.getInput('llm-config-api-key');
      const select = this.configPanel.querySelector('#llm-config-model-select') as HTMLSelectElement;
      fields.model = select ? select.value : this.getInput('llm-config-model');

      if (!fields.baseUrl || !fields.model) {
        if (statusEl) {
          statusEl.textContent = 'Base URL and model are required.';
          statusEl.className = 'config-status error';
        }
        return;
      }
    } else {
      fields.baseUrl = this.getInput('claude-config-endpoint') || 'https://api.anthropic.com/v1';
      fields.apiKey = this.getInput('claude-config-api-key');
      fields.model = this.getInput('claude-config-model');

      if (!fields.apiKey || !fields.model) {
        if (statusEl) {
          statusEl.textContent = 'Anthropic API key and model are required.';
          statusEl.className = 'config-status error';
        }
        return;
      }
    }

    void saveConfigEditorState({
      mode: this.configMode,
      fields,
      recursionLimit: Math.floor(recursionLimit),
      vlm: {
        baseUrl: this.getInput('vlm-config-endpoint'),
        apiKey: this.getInput('vlm-config-api-key'),
        model: this.getInput('vlm-config-model'),
      },
    });

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

  private setPromptInput(id: string, value: string): void {
    const el = this.promptPanel.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (el) el.value = value;
  }

  private getPromptInput(id: string): string {
    const el = this.promptPanel.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    return el?.value?.trim() ?? '';
  }

  private setSystemPromptPreviewMode(
    mode: 'edit' | 'preview',
    root: ParentNode = this.configPanel,
  ): void {
    this.systemPromptPreviewMode = mode;
    root.querySelectorAll<HTMLElement>('.config-editor-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === mode);
    });

    const input = root.querySelector('#llm-config-system-prompt') as HTMLTextAreaElement | null;
    const preview = root.querySelector('#llm-config-system-prompt-preview') as HTMLElement | null;
    if (!input || !preview) return;

    this.refreshSystemPromptPreview(root);
    input.style.display = mode === 'edit' ? '' : 'none';
    preview.style.display = mode === 'preview' ? '' : 'block';
  }

  private refreshSystemPromptPreview(root: ParentNode = this.configPanel): void {
    const input = root.querySelector('#llm-config-system-prompt') as HTMLTextAreaElement | null;
    const preview = root.querySelector('#llm-config-system-prompt-preview') as HTMLElement | null;
    if (!input || !preview) return;
    preview.innerHTML = this.renderMarkdownPreview(input.value.trim() || DEFAULT_SYSTEM_PROMPT);
  }

  private renderMarkdownPreview(markdown: string): string {
    const lines = markdown.split(/\r?\n/);
    const html: string[] = [];
    let listType: 'ul' | 'ol' | null = null;

    const closeList = () => {
      if (!listType) return;
      html.push(`</${listType}>`);
      listType = null;
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        closeList();
        continue;
      }

      const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
      if (orderedMatch) {
        if (listType !== 'ol') {
          closeList();
          html.push('<ol>');
          listType = 'ol';
        }
        html.push(`<li>${this.renderMarkdownPreviewInline(orderedMatch[1])}</li>`);
        continue;
      }

      const unorderedMatch = trimmed.match(/^-\s+(.*)$/);
      if (unorderedMatch) {
        if (listType !== 'ul') {
          closeList();
          html.push('<ul>');
          listType = 'ul';
        }
        html.push(`<li>${this.renderMarkdownPreviewInline(unorderedMatch[1])}</li>`);
        continue;
      }

      closeList();

      if (/^[A-Z][A-Z0-9 /&-]{2,}$/.test(trimmed) && trimmed.length <= 48) {
        html.push(`<h4>${this.escapeHtml(trimmed)}</h4>`);
        continue;
      }

      html.push(`<p>${this.renderMarkdownPreviewInline(trimmed)}</p>`);
    }

    closeList();
    return html.join('');
  }

  private renderMarkdownPreviewInline(text: string): string {
    return this.escapeHtml(text)
      .replace(/(https?:\/\/[^\s),]+)/gi, '<a href="$1" target="_blank">$1</a>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>');
  }

  private startStreamingWords(): void {
    if (this.streamingTimer !== null || !this.streamingElement) return;
    const textSpan = this.streamingElement.querySelector('.streaming-text') as HTMLElement;
    if (!textSpan) return;

    this.streamingTimer = window.setInterval(() => {
      if (this.streamingWordQueue.length > 0) {
        this.streamingAccumulated += this.streamingWordQueue.shift()!;
        textSpan.innerHTML = this.formatMessage(this.streamingAccumulated);
        this.scrollToBottom();
      } else {
        if (this.streamingTimer !== null) {
          clearInterval(this.streamingTimer);
          this.streamingTimer = null;
        }
      }
    }, 30);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private formatMessage(message: string): string {
    return message
      .replace(/(https?:\/\/[^\s),]+)/gi, '<a href="$1" target="_blank">$1</a>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    });
  }

  private scrollToolStepsToBottom(): void {
    requestAnimationFrame(() => {
      const timeline = this.currentToolStepsContainer?.querySelector('.tool-steps-timeline');
      if (timeline instanceof HTMLElement) {
        timeline.scrollTop = timeline.scrollHeight;
      }
    });
  }

  private chevronSvg(expanded: boolean, className = 'tool-steps-chevron'): string {
    return `<svg class="${className}${expanded ? ' rotated' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
  }

  private checkSvg(): string {
    return `<svg class="tool-step-check" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#5cb582" stroke-width="2"/><path d="M6 10l3 3 5-6" stroke="#5cb582" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  private errorSvg(): string {
    return `<svg class="tool-step-error" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="#d86a6a" stroke-width="2"/><path d="M7 7l6 6M13 7l-6 6" stroke="#d86a6a" stroke-width="2" stroke-linecap="round"/></svg>`;
  }

  private approvalSvg(): string {
    return `<svg class="tool-step-approval" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="#e3b341" stroke-width="2"/><path d="M10 5.6v5.1" stroke="#e3b341" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="13.9" r="1" fill="#e3b341"/></svg>`;
  }

  private spinnerSvg(): string {
    return `<svg class="tool-step-spinner" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="#5ba8c8" stroke-width="2" stroke-dasharray="38 14" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 10 10" to="360 10 10" dur="0.8s" repeatCount="indefinite"/></circle></svg>`;
  }
}
