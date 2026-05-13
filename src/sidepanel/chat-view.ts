// ─── Side Panel Chat View ───────────────────────────────────────────────────
// Gemini-like sidebar chat UI. Modeled after radiology-copilot-view.ts.

import type { ConversationCompactionState, WebMCPRegistryEntry } from '../shared/types';
import {
  type RequestBudgetEstimate,
  type AutomationApprovalDecision,
  type ToolStepEvent,
  type ToolManifestEntry,
} from './agent';
import { buildWorkflowDemonstrationContext } from './agent-runtime/browser-context';
import { getCategoryLabel } from './agent-runtime/tooling';
import {
  DEFAULT_AGENT_RECURSION_LIMIT,
  DEFAULT_CLAUDE_FIELDS,
  DEFAULT_OPENAI_FIELDS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_VLM_CONFIG,
  normalizeContextWindow,
  type ProviderFields,
} from '../shared/config';
import {
  loadConfigEditorState,
  loadPromptEditorState,
  saveConfigEditorState,
  saveDomainSkillRegistryEntries,
  saveSystemPrompt,
} from './chat-view/config-store';
import { saveDomainSkillProposalEntries } from './domain-skill-proposals';
import {
  loadSavedConversations,
  removeSavedConversation,
  upsertSavedConversation,
} from './chat-view/conversation-store';
import type { ContextTabOption, SavedConversation, SavedConversationMessage } from './chat-view/types';
import {
  isToolVisibleToModel,
  type MCPAppRenderRequest,
  type MCPServerEntry,
  type MCPToolDescriptor,
} from './mcp-client';
import type { MCPAppLoadedResource } from './mcp-app-host';
import {
  buildSkillMentionPickerOptions,
  formatSkillTagsInput,
  parseSkillTagsInput,
  parseSkillMarkdownImport,
  slugifySkillName,
  toSkillMentionReference,
  type SkillDraft,
  type SkillMentionPickerOption,
  type SkillRegistryEntry,
} from './skills-registry';
import type { WorkflowRecordingStartResult, WorkflowRecordingStopResult } from '../shared/messages';
import type {
  DomainSkillProposal,
  InteractionSkillEntry,
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
  private contextPickerMode: 'button' | 'mention' | 'skill' | null = null;
  private contextPickerItems: ContextTabOption[] = [];
  private skillPickerItems: SkillMentionPickerOption[] = [];
  private contextPickerHighlightIndex = 0;
  private contextPickerQuery = '';
  private mentionRange: { start: number; end: number } | null = null;
  private skillMentionRange: { start: number; end: number } | null = null;
  private conversationMessages: SavedConversationMessage[] = [];
  private workflowDemonstrationsById = new Map<string, WorkflowDemonstration>();
  private stagedWorkflowDemonstrationIds: string[] = [];
  private selectedSkillMention: SkillMention | null = null;
  private isWorkflowRecording = false;
  private workflowRecordingTabId: number | null = null;
  private draftChangeNotificationsEnabled = false;

  // Prompt skills registry
  private skillRegistry: SkillRegistryEntry[] = [];
  private domainSkillProposals: DomainSkillProposal[] = [];
  private interactionSkillRegistry: InteractionSkillEntry[] = [];
  private editingSkillId: string | null = null;
  private isSkillEditorOpen = false;
  private skillEditorSlugDirty = false;

  constructor(container: HTMLElement, callbacks: ChatViewCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.build();
    this.draftChangeNotificationsEnabled = true;
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

  public getConversationWorkflowDemonstrations(): WorkflowDemonstration[] {
    const seen = new Set<string>();
    const items: WorkflowDemonstration[] = [];

    for (const message of this.conversationMessages) {
      for (const id of message.workflowDemonstrationIds ?? []) {
        if (seen.has(id)) continue;
        const demonstration = this.workflowDemonstrationsById.get(id);
        if (!demonstration) continue;
        seen.add(id);
        items.push(demonstration);
      }
    }

    return items;
  }

  public getStagedWorkflowDemonstrations(): WorkflowDemonstration[] {
    return this.stagedWorkflowDemonstrationIds
      .map((id) => this.workflowDemonstrationsById.get(id))
      .filter((entry): entry is WorkflowDemonstration => Boolean(entry));
  }

  public getSelectedSkillMention(): SkillMention | null {
    return this.selectedSkillMention;
  }

  public getComposerSubmissionText(): string {
    const rawMessage = this.messageInput?.value.trim() ?? '';
    const attachedWorkflowDemonstrations = this.getStagedWorkflowDemonstrations();
    return rawMessage || (attachedWorkflowDemonstrations.length > 0
      ? `Attached workflow demonstration${attachedWorkflowDemonstrations.length !== 1 ? 's' : ''}.`
      : '');
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
    const attachedIds = workflowDemonstrationIds.filter((id) => this.workflowDemonstrationsById.has(id));
    if (attachedIds.length > 0) {
      this.stagedWorkflowDemonstrationIds = this.stagedWorkflowDemonstrationIds.filter((id) => !attachedIds.includes(id));
      this.renderStagedWorkflowDemonstrations();
    }

    const entry: SavedConversationMessage = {
      role: 'user',
      content: message,
      time: new Date().toLocaleTimeString(),
      ...(attachedIds.length > 0 ? { workflowDemonstrationIds: attachedIds } : {}),
      ...(skillMention ? { skillMention: toSkillMentionReference(skillMention) } : {}),
    };
    this.conversationMessages.push(entry);
    this.renderConversationMessage(entry);
  }

  public addAssistantMessage(message: string): void {
    const entry: SavedConversationMessage = {
      role: 'assistant',
      content: message,
      time: new Date().toLocaleTimeString(),
    };
    this.conversationMessages.push(entry);
    this.renderConversationMessage(entry);
  }

  public addSystemMessage(text: string): void {
    const entry: SavedConversationMessage = {
      role: 'system',
      content: text,
      time: '',
    };
    this.conversationMessages.push(entry);
    this.renderConversationMessage(entry);
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

    this.conversationMessages.push({
      role: 'assistant',
      content: message,
      time: new Date().toLocaleTimeString(),
    });

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

  private renderConversationMessage(message: SavedConversationMessage): void {
    const el = document.createElement('div');
    el.className = `message ${message.role}-message`;

    const content = document.createElement('div');
    content.className = 'message-content';
    if (message.role === 'assistant') {
      content.innerHTML = this.formatMessage(message.content);
    } else {
      if (message.role === 'user' && message.skillMention) {
        content.classList.add('with-skill-mention');
        content.appendChild(this.createSkillMentionChip(message.skillMention, 'message'));
        const text = document.createElement('span');
        text.className = 'message-text';
        text.innerHTML = this.escapeHtml(message.content).replace(/\n/g, '<br>');
        content.appendChild(text);
      } else {
        content.innerHTML = this.escapeHtml(message.content).replace(/\n/g, '<br>');
      }
    }
    el.appendChild(content);

    if (message.workflowDemonstrationIds?.length) {
      const attachments = document.createElement('div');
      attachments.className = 'message-workflow-demonstrations';
      for (const workflowDemonstrationId of message.workflowDemonstrationIds) {
        const demonstration = this.workflowDemonstrationsById.get(workflowDemonstrationId);
        if (!demonstration) continue;
        attachments.appendChild(this.createWorkflowDemonstrationMessageCard(demonstration));
      }
      if (attachments.childElementCount > 0) {
        el.appendChild(attachments);
      }
    }

    if (message.time) {
      const time = document.createElement('div');
      time.className = 'message-time';
      time.textContent = message.time;
      el.appendChild(time);
    }

    this.messagesContainer.appendChild(el);
    this.scrollToBottom();
  }

  private createSkillMentionChip(
    mention: SkillMentionReference,
    placement: 'composer' | 'message',
  ): HTMLElement {
    const chip = document.createElement('span');
    chip.className = `skill-mention-chip ${mention.kind === 'domain' ? 'domain' : 'interaction'} is-${placement}`;
    chip.title = `${mention.kind === 'domain' ? 'Domain Skill' : 'Interaction Skill'}: ${mention.name}`;

    const kind = document.createElement('span');
    kind.className = 'skill-mention-kind';
    kind.textContent = mention.kind === 'domain' ? 'D' : 'I';

    const name = document.createElement('span');
    name.className = 'skill-mention-name';
    name.textContent = mention.name;

    chip.appendChild(kind);
    chip.appendChild(name);

    if (placement === 'composer') {
      const remove = document.createElement('button');
      remove.className = 'skill-mention-remove';
      remove.type = 'button';
      remove.title = `Remove ${mention.name}`;
      remove.setAttribute('aria-label', `Remove ${mention.name} skill mention`);
      remove.textContent = '×';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectedSkillMention = null;
        this.renderSelectedSkillMention();
        this.refreshComposerState();
        this.messageInput.focus();
      });
      chip.appendChild(remove);
    }

    return chip;
  }

  private createWorkflowDemonstrationMessageCard(demonstration: WorkflowDemonstration): HTMLElement {
    const chip = document.createElement('div');
    chip.className = 'context-tab-chip workflow-demonstration-chip message-chip';
    chip.title = `${demonstration.title} · ${demonstration.steps.length} step${demonstration.steps.length !== 1 ? 's' : ''}`;
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', `Show ${demonstration.title} workflow demonstration details`);

    const title = document.createElement('span');
    title.className = 'context-tab-title workflow-demonstration-chip-title';
    title.textContent = demonstration.title;

    chip.appendChild(title);
    chip.appendChild(this.createWorkflowDemonstrationIcon());
    this.bindWorkflowDemonstrationDetailsTrigger(chip, demonstration);
    return chip;
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

    this.recordButton = document.createElement('button');
    this.recordButton.id = 'record-button';
    this.recordButton.type = 'button';
    this.recordButton.disabled = true;
    this.recordButton.innerHTML = this.getRecordButtonMarkup();

    contextBar.appendChild(this.contextTabsContainer);

    this.workflowDemonstrationsDock = document.createElement('div');
    this.workflowDemonstrationsDock.className = 'workflow-demonstrations-dock hidden';

    contextBar.appendChild(this.workflowDemonstrationsDock);
    contextBar.appendChild(this.contextAddButton);
    contextBar.appendChild(this.recordButton);

    this.composerMainRow = document.createElement('div');
    this.composerMainRow.className = 'chat-input-main';

    this.requestBudgetIndicator = document.createElement('div');
    this.requestBudgetIndicator.className = 'request-budget-indicator';
    this.requestBudgetIndicator.innerHTML = `
      <span class="request-budget-label">Request Budget</span>
      <button class="request-budget-copy-btn" type="button">Copy Context</button>
      <span class="request-budget-value">0%</span>
      <span class="request-budget-ring" aria-hidden="true">
        <svg viewBox="0 0 40 40" focusable="false">
          <circle class="request-budget-ring-track" cx="20" cy="20" r="14"></circle>
          <circle class="request-budget-ring-fill" cx="20" cy="20" r="14"></circle>
        </svg>
      </span>`;
    this.requestBudgetIndicator.title = 'Estimated Request Budget: 0%';
    this.requestBudgetIndicator.setAttribute('aria-label', 'Estimated Request Budget: 0%');
    this.requestBudgetRingFill = this.requestBudgetIndicator.querySelector('.request-budget-ring-fill') as SVGCircleElement;
    this.requestBudgetValue = this.requestBudgetIndicator.querySelector('.request-budget-value') as HTMLElement;
    this.requestBudgetCopyButton = this.requestBudgetIndicator.querySelector('.request-budget-copy-btn') as HTMLButtonElement;
    this.requestBudgetCopyButton.addEventListener('click', () => {
      void this.copyRequestBudgetContext();
    });

    this.messageInput = document.createElement('textarea');
    this.messageInput.id = 'chat-input';
    this.messageInput.placeholder = 'Ask the agent anything…';
    this.messageInput.disabled = true;
    this.messageInput.rows = 1;
    this.messageInput.spellcheck = true;

    this.skillMentionComposerSlot = document.createElement('div');
    this.skillMentionComposerSlot.className = 'skill-mention-composer-slot';

    this.sendButton = document.createElement('button');
    this.sendButton.id = 'send-button';
    this.sendButton.disabled = true;
    this.sendButton.innerHTML = this.getSendButtonMarkup();

    this.composerMainRow.appendChild(this.skillMentionComposerSlot);
    this.composerMainRow.appendChild(this.messageInput);
    this.composerMainRow.appendChild(this.sendButton);

    this.contextPicker = document.createElement('div');
    this.contextPicker.className = 'context-picker hidden';

    this.inputContainer.appendChild(contextBar);
    this.inputContainer.appendChild(this.contextPicker);
    this.inputContainer.appendChild(this.composerMainRow);
    this.inputContainer.appendChild(this.requestBudgetIndicator);

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
    this.refreshSkillMentionRegistries();
    this.renderContextTabs();
    this.renderSelectedSkillMention();
    this.autoResizeMessageInput();
    this.refreshComposerState();
  }

  private setupEventListeners(): void {
    const send = () => {
      if (this.isAgentBusy) {
        this.callbacks.onStopGeneration();
        return;
      }

      const attachedWorkflowDemonstrations = this.getStagedWorkflowDemonstrations();
      const rawMessage = this.messageInput.value.trim();
      const msg = rawMessage || (attachedWorkflowDemonstrations.length > 0
        ? `Attached workflow demonstration${attachedWorkflowDemonstrations.length !== 1 ? 's' : ''}.`
        : '');
      if (msg) {
        const skillMention = this.selectedSkillMention;
        this.callbacks.onSendMessage(msg, this.getSelectedContextTabIds(), attachedWorkflowDemonstrations, skillMention);
        this.messageInput.value = '';
        this.selectedSkillMention = null;
        this.renderSelectedSkillMention();
        this.autoResizeMessageInput();
        this.closeContextPicker();
        this.refreshComposerState();
        this.notifyConversationDraftChange();
      }
    };

    this.sendButton.addEventListener('click', send);
    this.recordButton.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.toggleWorkflowRecording();
    });
    this.contextAddButton.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!this.isInputEnabled || this.isAgentBusy || this.isWorkflowRecording) return;
      if (this.contextPickerMode === 'button') {
        this.closeContextPicker();
        return;
      }
      this.contextPickerMode = 'button';
      this.contextPickerQuery = '';
      this.contextPickerHighlightIndex = 0;
      this.mentionRange = null;
      this.skillMentionRange = null;
      await this.refreshContextPicker();
    });

    this.messageInput.addEventListener('input', () => {
      this.autoResizeMessageInput();
      this.syncMentionPickerFromInput();
      this.refreshComposerState();
      this.notifyConversationDraftChange();
    });
    this.messageInput.addEventListener('click', () => this.syncMentionPickerFromInput());
    this.messageInput.addEventListener('focus', () => this.syncMentionPickerFromInput());

    this.messageInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (this.contextPickerMode && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const itemCount = this.getActivePickerItemCount();
        if (itemCount === 0) return;
        const direction = e.key === 'ArrowDown' ? 1 : -1;
        const nextIndex =
          (this.contextPickerHighlightIndex + direction + itemCount) %
          itemCount;
        this.contextPickerHighlightIndex = nextIndex;
        this.updateContextPickerHighlight();
        return;
      }
      if (this.contextPickerMode && ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab')) {
        if (this.getActivePickerItemCount() > 0) {
          e.preventDefault();
          this.selectActivePickerItem();
          return;
        }
      }
      if (this.contextPickerMode && e.key === 'Escape') {
        e.preventDefault();
        this.closeContextPicker();
        return;
      }
      if (this.isAgentBusy || this.isWorkflowRecording) return;
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
    if (!this.messageInput || !this.sendButton || !this.recordButton) return;

    const recordingTarget = this.getPreferredRecordingTab();
    const composerDisabled = !this.isInputEnabled || this.isAgentBusy || this.isWorkflowRecording;
    const hasSendableContent = this.messageInput.value.trim().length > 0 || this.stagedWorkflowDemonstrationIds.length > 0;

    this.messageInput.disabled = composerDisabled;
    this.contextAddButton.disabled = composerDisabled;
    this.contextTabsContainer
      .querySelectorAll<HTMLButtonElement>('.context-tab-remove')
      .forEach((button) => {
        button.disabled = composerDisabled;
      });

    if (!this.isInputEnabled || this.isAgentBusy || this.isWorkflowRecording) {
      this.closeContextPicker();
    }

    this.recordButton.disabled = !this.isInputEnabled || this.isAgentBusy || (!this.isWorkflowRecording && !recordingTarget);
    this.recordButton.classList.toggle('is-recording', this.isWorkflowRecording);
    this.recordButton.innerHTML = this.isWorkflowRecording ? this.getStopRecordButtonMarkup() : this.getRecordButtonMarkup();
    this.recordButton.title = this.isWorkflowRecording ? 'Stop recording a workflow demonstration' : 'Record a workflow demonstration';
    this.recordButton.setAttribute('aria-label', this.recordButton.title);

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
    this.sendButton.disabled = !this.isInputEnabled || this.isWorkflowRecording || !hasSendableContent;
  }

  private renderSelectedSkillMention(): void {
    if (!this.skillMentionComposerSlot) return;
    this.skillMentionComposerSlot.innerHTML = '';
    this.skillMentionComposerSlot.classList.toggle('hidden', !this.selectedSkillMention);
    if (this.selectedSkillMention) {
      this.skillMentionComposerSlot.appendChild(this.createSkillMentionChip(this.selectedSkillMention, 'composer'));
    }
    this.notifyConversationDraftChange();
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

  private getSendButtonMarkup(): string {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
  }

  private getRecordButtonMarkup(): string {
    return `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="6"></circle></svg>`;
  }

  private getStopRecordButtonMarkup(): string {
    return `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><rect x="7" y="7" width="10" height="10"></rect></svg>`;
  }

  private getStopButtonMarkup(): string {
    return `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1"></rect></svg>`;
  }

  private createWorkflowDemonstrationIcon(): HTMLElement {
    const icon = document.createElement('span');
    icon.className = 'workflow-demonstration-chip-icon';
    icon.innerHTML = this.getRecordButtonMarkup();
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  private bindWorkflowDemonstrationDetailsTrigger(
    element: HTMLElement,
    demonstration: WorkflowDemonstration,
  ): void {
    const isNestedControl = (target: EventTarget | null) => (
      target instanceof HTMLElement && Boolean(target.closest('button'))
    );

    element.addEventListener('click', (e) => {
      if (isNestedControl(e.target)) return;
      e.stopPropagation();
      this.showWorkflowDemonstrationDetails(demonstration);
    });
    element.addEventListener('keydown', (e) => {
      if (isNestedControl(e.target)) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      this.showWorkflowDemonstrationDetails(demonstration);
    });
  }

  private showWorkflowDemonstrationDetails(demonstration: WorkflowDemonstration): void {
    this.container.querySelector('.workflow-demonstration-detail-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'workflow-demonstration-detail-overlay';

    const panel = document.createElement('div');
    panel.className = 'workflow-demonstration-detail-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', `${demonstration.title} workflow demonstration context`);

    const header = document.createElement('div');
    header.className = 'workflow-demonstration-detail-header';

    const title = document.createElement('div');
    title.className = 'workflow-demonstration-detail-title';
    title.textContent = demonstration.title;

    const closeButton = document.createElement('button');
    closeButton.className = 'workflow-demonstration-detail-close';
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.title = 'Close workflow demonstration details';
    closeButton.setAttribute('aria-label', 'Close workflow demonstration details');

    const preview = document.createElement('pre');
    preview.className = 'workflow-demonstration-detail-context';
    preview.textContent = buildWorkflowDemonstrationContext([demonstration]);

    const close = () => overlay.remove();
    closeButton.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    panel.addEventListener('click', (e) => e.stopPropagation());

    header.appendChild(title);
    header.appendChild(closeButton);
    panel.appendChild(header);
    panel.appendChild(preview);
    overlay.appendChild(panel);
    this.container.appendChild(overlay);
    closeButton.focus();
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
    this.notifyConversationDraftChange();
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

    if (this.contextPickerMode === 'skill') {
      const options = this.getAvailableSkillMentionOptions(this.contextPickerQuery);
      this.skillPickerItems = options;
      this.contextPickerItems = [];
      this.contextPickerHighlightIndex = Math.min(this.contextPickerHighlightIndex, Math.max(options.length - 1, 0));
      this.renderSkillPickerList();
      return;
    }

    const tabs = await this.getAvailableContextTabs(this.contextPickerQuery);
    this.contextPickerItems = tabs;
    this.skillPickerItems = [];
    this.contextPickerHighlightIndex = Math.min(this.contextPickerHighlightIndex, Math.max(tabs.length - 1, 0));
    this.renderContextPickerList();
  }

  private renderContextPickerList(): void {
    if (!this.contextPicker) return;
    if (!this.contextPickerMode) {
      this.closeContextPicker();
      return;
    }
    if (this.contextPickerMode === 'skill') {
      this.renderSkillPickerList();
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

  private renderSkillPickerList(): void {
    if (!this.contextPicker || this.contextPickerMode !== 'skill') return;
    const hint = 'Select a skill with /';

    if (this.skillPickerItems.length === 0) {
      this.contextPicker.innerHTML = `
        <div class="context-picker-header">${this.escapeHtml(hint)}</div>
        <div class="context-picker-empty">No matching skills</div>`;
      this.contextPicker.classList.remove('hidden');
      return;
    }

    const itemsHtml = this.skillPickerItems.map((option, index) => {
      const mention = option.mention;
      const title = this.escapeHtml(mention.name);
      const slug = this.escapeHtml(mention.slug);
      const description = this.escapeHtml(this.truncateText(mention.description || 'No description provided.', 100));
      const kind = option.kind === 'domain' ? 'Domain Skill' : 'Interaction Skill';
      const matched = option.matchedContext ? '<span class="skill-picker-match">Matched</span>' : '';
      return `
        <button class="context-picker-item skill-picker-item ${option.className}${index === this.contextPickerHighlightIndex ? ' active' : ''}" type="button">
          <span class="skill-picker-row">
            <span class="skill-picker-kind">${this.escapeHtml(kind)}</span>
            ${matched}
          </span>
          <span class="context-picker-item-title">${title}</span>
          <span class="context-picker-item-url">${slug} · ${description}</span>
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
        const selected = this.skillPickerItems[index];
        if (selected) this.selectSkillPickerItem(selected);
      });
      button.addEventListener('click', (e) => {
        e.preventDefault();
        const selected = this.skillPickerItems[index];
        if (selected) this.selectSkillPickerItem(selected);
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

  private getActivePickerItemCount(): number {
    if (this.contextPickerMode === 'skill') return this.skillPickerItems.length;
    return this.contextPickerItems.length;
  }

  private selectActivePickerItem(): void {
    if (this.contextPickerMode === 'skill') {
      const selected = this.skillPickerItems[this.contextPickerHighlightIndex];
      if (selected) this.selectSkillPickerItem(selected);
      return;
    }
    const selected = this.contextPickerItems[this.contextPickerHighlightIndex];
    if (selected) this.selectContextPickerItem(selected);
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

  private getSkillMentionContext(): { url?: string; title?: string } {
    if (this.includeCurrentContextTab && this.currentContextTab) {
      return { url: this.currentContextTab.url, title: this.currentContextTab.title };
    }
    const extra = this.extraContextTabs[0];
    if (extra) return { url: extra.url, title: extra.title };
    if (this.currentContextTab) return { url: this.currentContextTab.url, title: this.currentContextTab.title };
    return {};
  }

  private getAvailableSkillMentionOptions(query: string): SkillMentionPickerOption[] {
    return buildSkillMentionPickerOptions({
      domainSkills: this.skillRegistry,
      interactionSkills: this.interactionSkillRegistry,
      query,
      context: this.getSkillMentionContext(),
    });
  }

  private selectSkillPickerItem(option: SkillMentionPickerOption): void {
    this.applySkillMentionSelection();
    this.selectedSkillMention = option.mention;
    this.renderSelectedSkillMention();
    this.closeContextPicker();
    this.autoResizeMessageInput();
    this.refreshComposerState();
    this.messageInput.focus();
  }

  private applySkillMentionSelection(): void {
    const range = this.skillMentionRange ?? this.inferLeadingSlashRange();
    if (!range) return;
    const value = this.messageInput.value;
    const after = value.slice(range.end).replace(/^\s+/, '');
    this.messageInput.value = after;
    this.messageInput.setSelectionRange(0, 0);
  }

  private inferLeadingSlashRange(): { start: number; end: number } | null {
    const match = this.messageInput.value.match(/^\/[^\s]*/);
    if (!match) return null;
    return { start: 0, end: match[0].length };
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

    if (this.syncSkillPickerFromInput()) return;

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
    this.skillMentionRange = null;
    void this.refreshContextPicker();
  }

  private syncSkillPickerFromInput(): boolean {
    if (this.selectedSkillMention) {
      if (this.contextPickerMode === 'skill') this.closeContextPicker();
      return false;
    }

    const value = this.messageInput.value;
    const match = value.match(/^\/([^\s]*)/);
    if (!match) {
      if (this.contextPickerMode === 'skill') this.closeContextPicker();
      return false;
    }

    const token = match[0];
    const selectionStart = this.messageInput.selectionStart ?? value.length;
    if (selectionStart > token.length) {
      if (this.contextPickerMode === 'skill') this.closeContextPicker();
      return false;
    }

    this.contextPickerMode = 'skill';
    this.contextPickerQuery = match[1] ?? '';
    this.contextPickerHighlightIndex = 0;
    this.mentionRange = null;
    this.skillMentionRange = { start: 0, end: token.length };
    void this.refreshContextPicker();
    return true;
  }

  private closeContextPicker(): void {
    this.contextPickerMode = null;
    this.contextPickerItems = [];
    this.skillPickerItems = [];
    this.contextPickerQuery = '';
    this.contextPickerHighlightIndex = 0;
    this.mentionRange = null;
    this.skillMentionRange = null;
    if (this.contextPicker) {
      this.contextPicker.classList.add('hidden');
      this.contextPicker.innerHTML = '';
    }
  }

  private getPreferredRecordingTab(): ContextTabOption | null {
    return this.currentContextTab ?? this.extraContextTabs[0] ?? null;
  }

  private async toggleWorkflowRecording(): Promise<void> {
    if (!this.isInputEnabled || this.isAgentBusy) return;

    if (this.isWorkflowRecording) {
      const tabId = this.workflowRecordingTabId ?? this.getPreferredRecordingTab()?.tabId;
      if (tabId == null) {
        this.isWorkflowRecording = false;
        this.workflowRecordingTabId = null;
        this.refreshComposerState();
        return;
      }

      const result = await this.callbacks.onWorkflowRecordingStop(tabId);
      this.isWorkflowRecording = false;
      this.workflowRecordingTabId = null;
      this.refreshComposerState();

      if (!result.ok || !result.workflowDemonstration) {
        this.addSystemMessage(`Could not stop workflow recording: ${result.error ?? 'unknown error'}`);
        return;
      }

      this.workflowDemonstrationsById.set(result.workflowDemonstration.id, result.workflowDemonstration);
      if (!this.stagedWorkflowDemonstrationIds.includes(result.workflowDemonstration.id)) {
        this.stagedWorkflowDemonstrationIds.push(result.workflowDemonstration.id);
      }
      this.ensureWorkflowDemonstrationContextTab(result.workflowDemonstration);
      this.renderStagedWorkflowDemonstrations();
      return;
    }

    const targetTab = this.getPreferredRecordingTab();
    if (!targetTab) {
      this.addSystemMessage('No browser tab is available to record right now.');
      return;
    }

    const result = await this.callbacks.onWorkflowRecordingStart(targetTab.tabId, {
      title: this.buildWorkflowDemonstrationDefaultTitle(),
      captureTypedValues: true,
    });

    if (!result.ok) {
      this.addSystemMessage(`Could not start workflow recording: ${result.error ?? 'unknown error'}`);
      return;
    }

    this.isWorkflowRecording = true;
    this.workflowRecordingTabId = targetTab.tabId;
    this.refreshComposerState();
  }

  private buildWorkflowDemonstrationDefaultTitle(): string {
    const usedNumbers = new Set<number>();

    for (const demonstration of this.workflowDemonstrationsById.values()) {
      const match = /^demo(\d+)$/i.exec(demonstration.title.trim());
      if (!match) continue;
      const number = Number(match[1]);
      if (Number.isInteger(number) && number > 0) {
        usedNumbers.add(number);
      }
    }

    let nextNumber = 1;
    while (usedNumbers.has(nextNumber)) nextNumber += 1;
    return `demo${nextNumber}`;
  }

  private ensureWorkflowDemonstrationContextTab(demonstration: WorkflowDemonstration): void {
    const tabId = demonstration.demonstratedTab.tabId;
    if (tabId == null || tabId < 0) return;

    if (this.currentContextTab?.tabId === tabId) {
      this.includeCurrentContextTab = true;
      this.renderContextTabs();
      return;
    }

    if (!this.extraContextTabs.some((tab) => tab.tabId === tabId)) {
      this.extraContextTabs.push({
        tabId,
        title: demonstration.demonstratedTab.title ?? demonstration.title,
        url: demonstration.demonstratedTab.url,
        active: false,
      });
      this.renderContextTabs();
    }
  }

  private renderStagedWorkflowDemonstrations(): void {
    if (!this.workflowDemonstrationsDock) return;

    this.workflowDemonstrationsDock.innerHTML = '';
    const demonstrations = this.getStagedWorkflowDemonstrations();
    this.workflowDemonstrationsDock.classList.toggle('hidden', demonstrations.length === 0);

    for (const demonstration of demonstrations) {
      this.workflowDemonstrationsDock.appendChild(this.createStagedWorkflowDemonstrationCard(demonstration));
    }

    this.refreshComposerState();
    this.notifyConversationDraftChange();
  }

  private createStagedWorkflowDemonstrationCard(demonstration: WorkflowDemonstration): HTMLElement {
    const chip = document.createElement('div');
    chip.className = 'context-tab-chip workflow-demonstration-chip staged-chip';
    chip.title = `${demonstration.title} · ${demonstration.steps.length} step${demonstration.steps.length !== 1 ? 's' : ''}`;
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', `Show ${demonstration.title} workflow demonstration details`);

    const title = document.createElement('span');
    title.className = 'context-tab-title workflow-demonstration-chip-title';
    title.textContent = demonstration.title;

    const removeButton = document.createElement('button');
    removeButton.className = 'context-tab-remove workflow-demonstration-chip-remove';
    removeButton.type = 'button';
    removeButton.textContent = '×';
    removeButton.title = `Remove ${demonstration.title}`;
    removeButton.setAttribute('aria-label', `Remove ${demonstration.title}`);
    removeButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.discardWorkflowDemonstrationDraft(demonstration.id);
    });

    chip.appendChild(title);
    chip.appendChild(this.createWorkflowDemonstrationIcon());
    chip.appendChild(removeButton);
    this.bindWorkflowDemonstrationDetailsTrigger(chip, demonstration);
    return chip;
  }

  private discardWorkflowDemonstrationDraft(id: string): void {
    this.stagedWorkflowDemonstrationIds = this.stagedWorkflowDemonstrationIds.filter((entry) => entry !== id);
    if (!this.conversationMessages.some((message) => message.workflowDemonstrationIds?.includes(id))) {
      this.workflowDemonstrationsById.delete(id);
    }
    this.renderStagedWorkflowDemonstrations();
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
  public saveCurrentConversation(
    chatHistory: Array<{ role: string; content: string }>,
    compactionState: ConversationCompactionState | null = null,
  ): void {
    const messages: SavedConversation['messages'] = this.conversationMessages.map((message) => (
      message.workflowDemonstrationIds?.length
        ? { ...message, workflowDemonstrationIds: [...message.workflowDemonstrationIds] }
        : { ...message }
    ));

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
      workflowDemonstrations: Array.from(this.workflowDemonstrationsById.values()),
      stagedWorkflowDemonstrationIds: [...this.stagedWorkflowDemonstrationIds],
      compactionState,
    };

    this.currentConversationId = convo.id;
    void upsertSavedConversation(convo);
  }

  /** Load a conversation into the chat view */
  public loadConversation(convo: SavedConversation): void {
    this.clearMessages();
    this.currentConversationId = convo.id;
    this.conversationMessages = convo.messages.map((message) => (
      message.workflowDemonstrationIds?.length
        ? { ...message, workflowDemonstrationIds: [...message.workflowDemonstrationIds] }
        : { ...message }
    ));
    this.workflowDemonstrationsById = new Map(convo.workflowDemonstrations.map((entry) => [entry.id, entry]));
    this.stagedWorkflowDemonstrationIds = convo.stagedWorkflowDemonstrationIds.filter((id) => this.workflowDemonstrationsById.has(id));
    this.selectedSkillMention = null;
    this.renderSelectedSkillMention();

    for (const msg of this.conversationMessages) {
      this.renderConversationMessage(msg);
    }

    this.renderStagedWorkflowDemonstrations();
  }

  /** Clear all messages from the view */
  public clearMessages(): void {
    this.messagesContainer.innerHTML = '';
    this.conversationMessages = [];
    this.workflowDemonstrationsById.clear();
    this.stagedWorkflowDemonstrationIds = [];
    this.selectedSkillMention = null;
    this.isWorkflowRecording = false;
    this.workflowRecordingTabId = null;
    this.currentToolStepsContainer = null;
    this.toolStepsCollapsed = false;
    this.expandedToolStepDetails.clear();
    this.renderSelectedSkillMention();
    this.streamingElement = null;
    if (this.streamingTimer !== null) {
      clearInterval(this.streamingTimer);
      this.streamingTimer = null;
    }
    this.streamingAccumulated = '';
    this.streamingWordQueue = [];
    this.renderStagedWorkflowDemonstrations();
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
          <div class="config-field">
            <label for="llm-config-context-window">Context Window</label>
            <input type="number" id="llm-config-context-window" min="1024" step="1" placeholder="128000" autocomplete="off" />
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
          <div class="config-field">
            <label for="claude-config-context-window">Context Window</label>
            <input type="number" id="claude-config-context-window" min="1024" step="1" placeholder="200000" autocomplete="off" />
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
        <p class="prompt-panel-note">Domain Skills are user-managed site knowledge. Interaction Skills are Brow-built cross-site mechanics. Agent-generated Domain Skill proposals stay pending until you approve them here. The agent can inspect active skills later with the <code>skills_load</code> tool.</p>
        <div class="skills-registry-header">
          <div class="skills-registry-heading">
            <h3 class="config-section-title">Pending Domain Skill Proposals</h3>
            <p class="skills-registry-subtitle">Agent-generated suggestions for reusable site knowledge. Approve one to save it into the Domain Skill registry.</p>
          </div>
        </div>
        <div class="domain-skill-proposals-count">0 pending proposal(s)</div>
        <div class="domain-skill-proposals-list"></div>
        <hr class="config-divider" />
        <div class="skills-registry-header">
          <div class="skills-registry-heading">
            <h3 class="config-section-title">Domain Skills</h3>
            <p class="skills-registry-subtitle">User-managed reusable site knowledge. Enable a Domain Skill to inject its name and description into the agent prompt.</p>
          </div>
          <button class="skills-new-btn" type="button">New Domain Skill</button>
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
        <div class="skills-registry-count">0 domain skill(s)</div>
        <div class="skill-editor-dock">
          <div class="skill-editor-panel" style="display: none;">
            <div class="skill-editor-header">
              <h4 class="skill-editor-title">New Domain Skill</h4>
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
                <label for="skill-match-domain">Match Domain</label>
                <input type="text" id="skill-match-domain" placeholder="github.com" autocomplete="off" />
              </div>
              <div class="config-field">
                <label for="skill-match-paths">Path Patterns</label>
                <input type="text" id="skill-match-paths" placeholder="/owner/repo/*, /owner/repo/pull/*" autocomplete="off" />
              </div>
              <div class="config-field">
                <label for="skill-match-pages">Page Patterns</label>
                <input type="text" id="skill-match-pages" placeholder="pull request, settings" autocomplete="off" />
              </div>
              <div class="config-field">
                <label for="skill-content">Skill Content (Markdown)</label>
                <textarea id="skill-content" class="skill-content-input" spellcheck="false" placeholder="# My Skill&#10;&#10;Paste or type the full SKILL.md content here..."></textarea>
                <div id="skill-content-preview" class="config-system-prompt-preview skill-content-preview" style="display: none;"></div>
              </div>
            </div>
            <div class="skill-editor-actions">
              <button class="config-apply-btn skill-save-btn" type="button">Save Domain Skill</button>
              <button class="skill-cancel-btn" type="button">Cancel</button>
            </div>
          </div>
        </div>
        <div class="skills-registry-list"></div>
        <hr class="config-divider" />
        <div class="skills-registry-header">
          <div class="skills-registry-heading">
            <h3 class="config-section-title">Interaction Skills</h3>
            <p class="skills-registry-subtitle">Built-in cross-site browser mechanics. These are read-only and always available to Brow.</p>
          </div>
        </div>
        <div class="interaction-skills-count">0 interaction skill(s)</div>
        <div class="interaction-skills-list"></div>
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

    panel.querySelectorAll('.config-editor-btn[data-view]').forEach((btn) => {
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
    void loadPromptEditorState().then(({ systemPrompt, domainSkills, domainSkillProposals, interactionSkills }) => {
      this.skillRegistry = domainSkills;
      this.domainSkillProposals = domainSkillProposals;
      this.interactionSkillRegistry = interactionSkills;
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

  private refreshSkillMentionRegistries(): void {
    void loadPromptEditorState().then(({ domainSkills, interactionSkills }) => {
      this.skillRegistry = domainSkills;
      this.interactionSkillRegistry = interactionSkills;
      if (this.contextPickerMode === 'skill') {
        void this.refreshContextPicker();
      }
    });
  }

  private renderSkillRegistry(): void {
    const proposalList = this.promptPanel.querySelector('.domain-skill-proposals-list') as HTMLElement | null;
    const proposalCount = this.promptPanel.querySelector('.domain-skill-proposals-count') as HTMLElement | null;
    const list = this.promptPanel.querySelector('.skills-registry-list') as HTMLElement | null;
    const count = this.promptPanel.querySelector('.skills-registry-count') as HTMLElement | null;
    const interactionList = this.promptPanel.querySelector('.interaction-skills-list') as HTMLElement | null;
    const interactionCount = this.promptPanel.querySelector('.interaction-skills-count') as HTMLElement | null;
    const dock = this.promptPanel.querySelector('.skill-editor-dock') as HTMLElement | null;
    const editorPanel = this.promptPanel.querySelector('.skill-editor-panel') as HTMLElement | null;
    if (!proposalList || !proposalCount || !list || !count || !interactionList || !interactionCount || !dock || !editorPanel) return;

    this.renderDomainSkillProposalRegistry(proposalList, proposalCount);
    count.textContent = `${this.skillRegistry.length} domain skill${this.skillRegistry.length !== 1 ? 's' : ''}`;
    list.innerHTML = '';
    interactionCount.textContent = `${this.interactionSkillRegistry.length} interaction skill${this.interactionSkillRegistry.length !== 1 ? 's' : ''}`;
    interactionList.innerHTML = '';
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
      empty.textContent = 'No Domain Skills yet. Create one to make reusable site guidance available to Brow.';
      list.appendChild(empty);
    } else {
      for (const skill of this.skillRegistry) {
        const card = document.createElement('div');
        const isEditing = this.isSkillEditorOpen && this.editingSkillId === skill.id;
        card.className = `skill-card${skill.enabled ? ' enabled' : ' disabled'}${isEditing ? ' is-editing' : ''}`;
        const tags = this.renderSkillTagHtml(skill.tags, skill.matcher);

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
          this.persistSkillRegistry(skill.enabled ? 'Domain Skill disabled.' : 'Domain Skill enabled.');
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
    }

    if (this.interactionSkillRegistry.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'skills-empty-state';
      empty.textContent = 'No Interaction Skills are packaged yet.';
      interactionList.appendChild(empty);
    } else {
      for (const skill of this.interactionSkillRegistry) {
        const card = document.createElement('div');
        const tags = this.renderSkillTagHtml(skill.tags);
        card.className = 'skill-card enabled';
        card.innerHTML = `
        <div class="skill-card-header">
          <div class="skill-card-title-group">
            <div class="skill-card-title">${this.escapeHtml(skill.name)}</div>
            <div class="skill-card-slug">${this.escapeHtml(skill.slug)}</div>
          </div>
        </div>
        <div class="skill-card-description">${this.escapeHtml(skill.description || 'No description provided.')}</div>
        ${tags}
        <div class="skill-card-footer">
          <div class="skill-card-meta">Built-in interaction skill</div>
        </div>`;
        interactionList.appendChild(card);
      }
    }

    if (!editorPlaced) {
      dock.appendChild(editorPanel);
    }
  }

  private renderDomainSkillProposalRegistry(list: HTMLElement, count: HTMLElement): void {
    const pendingProposals = this.domainSkillProposals.filter((proposal) => proposal.status === 'pending');
    count.textContent = `${pendingProposals.length} pending proposal${pendingProposals.length !== 1 ? 's' : ''}`;
    list.innerHTML = '';

    if (pendingProposals.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'skills-empty-state';
      empty.textContent = 'No pending Domain Skill proposals.';
      list.appendChild(empty);
      return;
    }

    for (const proposal of pendingProposals) {
      const card = document.createElement('div');
      const tags = this.renderSkillTagHtml(proposal.tags, proposal.matcher);
      const evidence = proposal.evidence?.length
        ? `<div class="skill-card-tags">${proposal.evidence.map((item) => `<span class="skill-tag">${this.escapeHtml(item)}</span>`).join('')}</div>`
        : '';
      const summary = proposal.summary
        ? `<div class="skill-card-meta">${this.escapeHtml(proposal.summary)}</div>`
        : '';

      card.className = 'skill-card enabled';
      card.innerHTML = `
        <div class="skill-card-header">
          <div class="skill-card-title-group">
            <div class="skill-card-title">${this.escapeHtml(proposal.name)}</div>
            <div class="skill-card-slug">${this.escapeHtml(proposal.slug)}</div>
          </div>
        </div>
        <div class="skill-card-description">${this.escapeHtml(proposal.description || 'No description provided.')}</div>
        ${summary}
        ${tags}
        ${evidence}
        <div class="skill-card-footer">
          <div class="skill-card-meta">Proposed ${this.formatRelativeTime(new Date(proposal.updatedAt))}</div>
          <div class="skill-card-actions">
            <button class="skill-toggle-btn is-enabled" type="button">Approve</button>
            <button class="skill-edit-btn" type="button">Edit Draft</button>
            <button class="skill-proposal-reject-btn" type="button">Reject</button>
          </div>
        </div>`;

      card.querySelector('.skill-toggle-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.approveDomainSkillProposal(proposal.id);
      });
      card.querySelector('.skill-edit-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.editDomainSkillProposal(proposal.id);
      });
      card.querySelector('.skill-proposal-reject-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.rejectDomainSkillProposal(proposal.id);
      });

      list.appendChild(card);
    }
  }

  private renderSkillTagHtml(
    tags: string[],
    matcher?: SkillRegistryEntry['matcher'],
  ): string {
    const entries = [...tags];
    if (matcher?.domain) entries.push(`domain:${matcher.domain}`);
    if (matcher?.pathPatterns) {
      for (const pattern of matcher.pathPatterns) entries.push(`path:${pattern}`);
    }
    if (matcher?.pagePatterns) {
      for (const pattern of matcher.pagePatterns) entries.push(`page:${pattern}`);
    }
    if (entries.length === 0) return '';

    return `<div class="skill-card-tags">${entries.map((tag) => `<span class="skill-tag">${this.escapeHtml(tag)}</span>`).join('')}</div>`;
  }

  private parseSkillMatcherInput(value: string): string[] | undefined {
    const normalized = parseSkillTagsInput(value);
    return normalized.length > 0 ? normalized : undefined;
  }

  private formatSkillMatcherInput(values?: string[]): string {
    return values?.join(', ') ?? '';
  }

  private async importSkillFromUrl(): Promise<void> {
    const urlInput = this.promptPanel.querySelector('.skills-import-url') as HTMLInputElement | null;
    const importButton = this.promptPanel.querySelector('.skills-import-url-btn') as HTMLButtonElement | null;
    const rawUrl = urlInput?.value.trim() ?? '';
    if (!rawUrl) {
      this.setPromptStatus('Enter a Domain Skill URL first.', 'error');
      return;
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      this.setPromptStatus('Domain Skill URL is not valid.', 'error');
      return;
    }

    if (importButton) importButton.disabled = true;
    this.setPromptStatus('Loading Domain Skill from URL…');

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const markdown = await response.text();
      const sourceName = url.pathname.split('/').pop() || url.hostname;
      this.prefillSkillEditorFromMarkdown(markdown, sourceName);
      this.setPromptStatus('Domain Skill imported from URL. Review and save it.', 'success');
    } catch (err: any) {
      this.setPromptStatus(`Could not load Domain Skill from URL: ${err.message ?? err}`, 'error');
    } finally {
      if (importButton) importButton.disabled = false;
    }
  }

  private async importSkillFromFile(file: File): Promise<void> {
    const fileName = file.name || 'skill.md';
    if (!/\.md$/i.test(fileName) && file.type && file.type !== 'text/markdown' && file.type !== 'text/plain') {
      this.setPromptStatus('Only markdown Domain Skill files are supported.', 'error');
      return;
    }

    try {
      const markdown = await file.text();
      this.prefillSkillEditorFromMarkdown(markdown, fileName);
      this.setPromptStatus(`Imported ${fileName}. Review and save the Domain Skill.`, 'success');
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
    const matchDomainInput = this.promptPanel.querySelector('#skill-match-domain') as HTMLInputElement | null;
    const matchPathsInput = this.promptPanel.querySelector('#skill-match-paths') as HTMLInputElement | null;
    const matchPagesInput = this.promptPanel.querySelector('#skill-match-pages') as HTMLInputElement | null;
    const contentInput = this.promptPanel.querySelector('#skill-content') as HTMLTextAreaElement | null;
    const saveButton = this.promptPanel.querySelector('.skill-save-btn') as HTMLButtonElement | null;
    if (!panel || !title || !nameInput || !slugInput || !descriptionInput || !tagsInput || !matchDomainInput || !matchPathsInput || !matchPagesInput || !contentInput || !saveButton) return;

    this.isSkillEditorOpen = true;
    this.editingSkillId = skill?.id ?? null;
    this.skillEditorSlugDirty = Boolean(skill);
    title.textContent = skill ? 'Edit Domain Skill' : 'New Domain Skill';
    saveButton.textContent = skill ? 'Update Domain Skill' : 'Create Domain Skill';
    nameInput.value = skill?.name ?? draft?.name ?? '';
    slugInput.value = skill?.slug ?? draft?.slug ?? '';
    descriptionInput.value = skill?.description ?? draft?.description ?? '';
    tagsInput.value = skill ? formatSkillTagsInput(skill.tags) : formatSkillTagsInput(draft?.tags ?? []);
    matchDomainInput.value = skill?.matcher?.domain ?? draft?.matcher?.domain ?? '';
    matchPathsInput.value = this.formatSkillMatcherInput(skill?.matcher?.pathPatterns ?? draft?.matcher?.pathPatterns);
    matchPagesInput.value = this.formatSkillMatcherInput(skill?.matcher?.pagePatterns ?? draft?.matcher?.pagePatterns);
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
    this.persistSkillRegistry(`Domain Skill "${removedSkill.name}" removed.`);
  }

  private findSkillForProposal(proposal: DomainSkillProposal): SkillRegistryEntry | undefined {
    return (proposal.domainSkillId
      ? this.skillRegistry.find((skill) => skill.id === proposal.domainSkillId)
      : undefined)
      ?? this.skillRegistry.find((skill) => skill.slug === proposal.slug);
  }

  private editDomainSkillProposal(proposalId: string): void {
    const proposal = this.domainSkillProposals.find((entry) => entry.id === proposalId && entry.status === 'pending');
    if (!proposal) return;

    this.openSkillEditor(undefined, {
      name: proposal.name,
      slug: proposal.slug,
      description: proposal.description,
      tags: proposal.tags,
      content: proposal.content,
      matcher: proposal.matcher,
    });
    this.setPromptStatus('Domain Skill proposal loaded into the editor. Saving the skill does not change proposal status automatically.', 'success');
  }

  private approveDomainSkillProposal(proposalId: string): void {
    const proposal = this.domainSkillProposals.find((entry) => entry.id === proposalId && entry.status === 'pending');
    if (!proposal) return;

    const now = Date.now();
    const existing = this.findSkillForProposal(proposal);
    const nextSkill: SkillRegistryEntry = existing
      ? {
        ...existing,
        name: proposal.name,
        slug: proposal.slug,
        description: proposal.description,
        tags: [...proposal.tags],
        content: proposal.content,
        matcher: proposal.matcher,
        updatedAt: now,
      }
      : {
        id: proposal.domainSkillId ?? this.generateId(),
        name: proposal.name,
        slug: proposal.slug,
        description: proposal.description,
        tags: [...proposal.tags],
        content: proposal.content,
        matcher: proposal.matcher,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
    const nextSkills = [
      nextSkill,
      ...this.skillRegistry.filter((skill) => skill.id !== nextSkill.id),
    ];
    const nextProposals: DomainSkillProposal[] = this.domainSkillProposals.map((entry) =>
      entry.id === proposal.id
        ? { ...entry, domainSkillId: nextSkill.id, status: 'approved' as const, updatedAt: now }
        : entry,
    );

    void Promise.all([
      saveDomainSkillRegistryEntries(nextSkills),
      saveDomainSkillProposalEntries(nextProposals),
    ]).then(([skills, proposals]) => {
      this.skillRegistry = skills;
      this.domainSkillProposals = proposals;
      this.callbacks.onSkillRegistryApply(this.skillRegistry);
      this.renderSkillRegistry();
      this.setPromptStatus(existing
        ? `Domain Skill proposal applied to "${nextSkill.name}".`
        : `Domain Skill proposal approved as "${nextSkill.name}".`, 'success');
    });
  }

  private rejectDomainSkillProposal(proposalId: string): void {
    const proposal = this.domainSkillProposals.find((entry) => entry.id === proposalId && entry.status === 'pending');
    if (!proposal) return;

    const now = Date.now();
    const nextProposals: DomainSkillProposal[] = this.domainSkillProposals.map((entry) =>
      entry.id === proposal.id
        ? { ...entry, status: 'rejected' as const, updatedAt: now }
        : entry,
    );

    void saveDomainSkillProposalEntries(nextProposals).then((proposals) => {
      this.domainSkillProposals = proposals;
      this.renderSkillRegistry();
      this.setPromptStatus(`Domain Skill proposal "${proposal.name}" rejected.`, 'success');
    });
  }

  private saveSkillFromEditor(): void {
    const nameInput = this.promptPanel.querySelector('#skill-display-name') as HTMLInputElement | null;
    const slugInput = this.promptPanel.querySelector('#skill-slug') as HTMLInputElement | null;
    const descriptionInput = this.promptPanel.querySelector('#skill-description') as HTMLInputElement | null;
    const tagsInput = this.promptPanel.querySelector('#skill-tags') as HTMLInputElement | null;
    const matchDomainInput = this.promptPanel.querySelector('#skill-match-domain') as HTMLInputElement | null;
    const matchPathsInput = this.promptPanel.querySelector('#skill-match-paths') as HTMLInputElement | null;
    const matchPagesInput = this.promptPanel.querySelector('#skill-match-pages') as HTMLInputElement | null;
    const contentInput = this.promptPanel.querySelector('#skill-content') as HTMLTextAreaElement | null;
    if (!nameInput || !slugInput || !descriptionInput || !tagsInput || !matchDomainInput || !matchPathsInput || !matchPagesInput || !contentInput) return;

    const name = nameInput.value.trim();
    const slug = slugifySkillName(slugInput.value || name);
    const description = descriptionInput.value.trim();
    const content = contentInput.value.trim();
    const tags = parseSkillTagsInput(tagsInput.value);
    const matcher = {
      domain: matchDomainInput.value.trim().toLowerCase() || undefined,
      pathPatterns: this.parseSkillMatcherInput(matchPathsInput.value),
      pagePatterns: this.parseSkillMatcherInput(matchPagesInput.value),
    };
    const normalizedMatcher = matcher.domain || matcher.pathPatterns || matcher.pagePatterns ? matcher : undefined;

    if (!name || !description || !content) {
      this.setPromptStatus('Name, description, and content are required for a Domain Skill.', 'error');
      return;
    }

    const duplicate = this.skillRegistry.find((skill) =>
      skill.slug === slug && skill.id !== this.editingSkillId,
    );
    if (duplicate) {
      this.setPromptStatus(`Slug "${slug}" is already used by another Domain Skill.`, 'error');
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
        matcher: normalizedMatcher,
        updatedAt: now,
      }
      : {
        id: this.generateId(),
        name,
        slug,
        description,
        tags,
        content,
        matcher: normalizedMatcher,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };

    this.skillRegistry = [
      nextSkill,
      ...this.skillRegistry.filter((skill) => skill.id !== nextSkill.id),
    ];
    this.persistSkillRegistry(existing ? 'Domain Skill updated.' : 'Domain Skill created.');
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
    void saveDomainSkillRegistryEntries(this.skillRegistry).then((skills) => {
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
