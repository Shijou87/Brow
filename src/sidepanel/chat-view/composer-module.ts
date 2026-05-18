import { buildWorkflowDemonstrationContext } from '../agent-runtime/browser-context';
import type { ContextTabOption } from './types';
import type { WorkflowRecordingStartResult, WorkflowRecordingStopResult } from '../../shared/messages';
import type {
  SkillMention,
  SkillMentionReference,
  WorkflowDemonstration,
} from '../../shared/types';
import type { SkillMentionPickerOption } from '../skills-registry';

interface ComposerModuleElements {
  container: HTMLElement;
  inputContainer: HTMLElement;
  messageInput: HTMLTextAreaElement;
  recordButton: HTMLButtonElement;
  sendButton: HTMLButtonElement;
  contextTabsContainer: HTMLElement;
  contextAddButton: HTMLButtonElement;
  contextPicker: HTMLElement;
  skillMentionComposerSlot: HTMLElement;
  workflowDemonstrationsDock: HTMLElement;
}

interface ComposerModuleDeps {
  onSendMessage: (
    message: string,
    contextTabIds: number[],
    workflowDemonstrations: WorkflowDemonstration[],
    skillMention: SkillMention | null,
  ) => void;
  onStopGeneration: () => void;
  onWorkflowRecordingStart: (
    tabId: number,
    options?: { title?: string; captureTypedValues?: boolean },
  ) => Promise<WorkflowRecordingStartResult>;
  onWorkflowRecordingStop: (tabId: number) => Promise<WorkflowRecordingStopResult>;
  getAvailableSkillMentionOptions: (
    query: string,
    context: { url?: string; title?: string },
  ) => SkillMentionPickerOption[];
  onDraftChange: () => void;
  onSystemMessage: (text: string) => void;
  isWorkflowDemonstrationReferenced: (id: string) => boolean;
  escapeHtml: (text: string) => string;
}

export class ComposerModule {
  private readonly elements: ComposerModuleElements;
  private readonly deps: ComposerModuleDeps;

  private isInputEnabled = false;
  private isAgentBusy = false;
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
  private workflowDemonstrationsById = new Map<string, WorkflowDemonstration>();
  private stagedWorkflowDemonstrationIds: string[] = [];
  private selectedSkillMention: SkillMention | null = null;
  private isWorkflowRecording = false;
  private workflowRecordingTabId: number | null = null;

  constructor(elements: ComposerModuleElements, deps: ComposerModuleDeps) {
    this.elements = elements;
    this.deps = deps;
  }

  public initialize(): void {
    this.bindEventListeners();
    this.renderContextTabs();
    this.renderSelectedSkillMention();
    this.autoResizeMessageInput();
    this.refreshComposerState();
  }

  public setInputEnabled(enabled: boolean): void {
    this.isInputEnabled = enabled;
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
    return Array.from(this.workflowDemonstrationsById.values());
  }

  public getStagedWorkflowDemonstrations(): WorkflowDemonstration[] {
    return this.stagedWorkflowDemonstrationIds
      .map((id) => this.workflowDemonstrationsById.get(id))
      .filter((entry): entry is WorkflowDemonstration => Boolean(entry));
  }

  public getStagedWorkflowDemonstrationIds(): string[] {
    return [...this.stagedWorkflowDemonstrationIds];
  }

  public getSelectedSkillMention(): SkillMention | null {
    return this.selectedSkillMention;
  }

  public getComposerSubmissionText(): string {
    const rawMessage = this.elements.messageInput.value.trim();
    if (rawMessage) return rawMessage;
    const attachedWorkflowDemonstrations = this.getStagedWorkflowDemonstrations();
    return attachedWorkflowDemonstrations.length > 0
      ? `Attached workflow demonstration${attachedWorkflowDemonstrations.length !== 1 ? 's' : ''}.`
      : '';
  }

  public getWorkflowDemonstrationById(id: string): WorkflowDemonstration | undefined {
    return this.workflowDemonstrationsById.get(id);
  }

  public consumeAttachedWorkflowDemonstrations(workflowDemonstrationIds: string[]): string[] {
    const attachedIds = workflowDemonstrationIds.filter((id) => this.workflowDemonstrationsById.has(id));
    if (attachedIds.length > 0) {
      this.stagedWorkflowDemonstrationIds = this.stagedWorkflowDemonstrationIds.filter((id) => !attachedIds.includes(id));
      this.renderStagedWorkflowDemonstrations();
    }
    return attachedIds;
  }

  public replaceConversationWorkflowState(
    workflowDemonstrations: WorkflowDemonstration[],
    stagedWorkflowDemonstrationIds: string[],
  ): void {
    this.workflowDemonstrationsById = new Map(workflowDemonstrations.map((entry) => [entry.id, entry]));
    this.stagedWorkflowDemonstrationIds = stagedWorkflowDemonstrationIds.filter((id) => this.workflowDemonstrationsById.has(id));
    this.selectedSkillMention = null;
    this.isWorkflowRecording = false;
    this.workflowRecordingTabId = null;
    this.renderSelectedSkillMention();
    this.renderStagedWorkflowDemonstrations();
  }

  public clearConversationWorkflowState(): void {
    this.workflowDemonstrationsById.clear();
    this.stagedWorkflowDemonstrationIds = [];
    this.selectedSkillMention = null;
    this.isWorkflowRecording = false;
    this.workflowRecordingTabId = null;
    this.renderSelectedSkillMention();
    this.renderStagedWorkflowDemonstrations();
  }

  public refreshSkillPickerIfOpen(): void {
    if (this.contextPickerMode === 'skill') {
      void this.refreshContextPicker();
    }
  }

  public dismissPicker(): void {
    this.closeContextPicker();
  }

  public createSkillMentionChip(
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
        this.elements.messageInput.focus();
      });
      chip.appendChild(remove);
    }

    return chip;
  }

  public createWorkflowDemonstrationMessageCard(demonstration: WorkflowDemonstration): HTMLElement {
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

  private bindEventListeners(): void {
    const send = () => {
      if (this.isAgentBusy) {
        this.deps.onStopGeneration();
        return;
      }

      const attachedWorkflowDemonstrations = this.getStagedWorkflowDemonstrations();
      const rawMessage = this.elements.messageInput.value.trim();
      const msg = rawMessage || (attachedWorkflowDemonstrations.length > 0
        ? `Attached workflow demonstration${attachedWorkflowDemonstrations.length !== 1 ? 's' : ''}.`
        : '');
      if (msg) {
        this.deps.onSendMessage(msg, this.getSelectedContextTabIds(), attachedWorkflowDemonstrations, this.selectedSkillMention);
        this.elements.messageInput.value = '';
        this.selectedSkillMention = null;
        this.renderSelectedSkillMention();
        this.autoResizeMessageInput();
        this.closeContextPicker();
        this.refreshComposerState();
        this.notifyDraftChange();
      }
    };

    this.elements.sendButton.addEventListener('click', send);
    this.elements.recordButton.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.toggleWorkflowRecording();
    });
    this.elements.contextAddButton.addEventListener('click', async (e) => {
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

    this.elements.messageInput.addEventListener('input', () => {
      this.autoResizeMessageInput();
      this.syncMentionPickerFromInput();
      this.refreshComposerState();
      this.notifyDraftChange();
    });
    this.elements.messageInput.addEventListener('click', () => this.syncMentionPickerFromInput());
    this.elements.messageInput.addEventListener('focus', () => this.syncMentionPickerFromInput());
    this.elements.messageInput.addEventListener('keydown', (e) => {
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
    this.elements.messageInput.addEventListener('keyup', (e) => {
      e.stopPropagation();
      this.syncMentionPickerFromInput();
    });
    this.elements.messageInput.addEventListener('keypress', (e) => e.stopPropagation());

    document.addEventListener('click', (e) => {
      if (!this.elements.inputContainer.contains(e.target as Node)) {
        this.closeContextPicker();
      }
    });
  }

  private refreshComposerState(): void {
    const recordingTarget = this.getPreferredRecordingTab();
    const composerDisabled = !this.isInputEnabled || this.isAgentBusy || this.isWorkflowRecording;
    const hasSendableContent = this.elements.messageInput.value.trim().length > 0 || this.stagedWorkflowDemonstrationIds.length > 0;

    this.elements.messageInput.disabled = composerDisabled;
    this.elements.contextAddButton.disabled = composerDisabled;
    this.elements.contextTabsContainer
      .querySelectorAll<HTMLButtonElement>('.context-tab-remove')
      .forEach((button) => {
        button.disabled = composerDisabled;
      });

    if (!this.isInputEnabled || this.isAgentBusy || this.isWorkflowRecording) {
      this.closeContextPicker();
    }

    this.elements.recordButton.disabled = !this.isInputEnabled || this.isAgentBusy || (!this.isWorkflowRecording && !recordingTarget);
    this.elements.recordButton.classList.toggle('is-recording', this.isWorkflowRecording);
    this.elements.recordButton.innerHTML = this.isWorkflowRecording ? this.getStopRecordButtonMarkup() : this.getRecordButtonMarkup();
    this.elements.recordButton.title = this.isWorkflowRecording ? 'Stop recording a workflow demonstration' : 'Record a workflow demonstration';
    this.elements.recordButton.setAttribute('aria-label', this.elements.recordButton.title);

    if (this.isAgentBusy) {
      this.elements.sendButton.disabled = false;
      this.elements.sendButton.classList.add('is-stop');
      this.elements.sendButton.innerHTML = this.getStopButtonMarkup();
      this.elements.sendButton.title = 'Stop generation';
      this.elements.sendButton.setAttribute('aria-label', 'Stop generation');
      return;
    }

    this.elements.sendButton.classList.remove('is-stop');
    this.elements.sendButton.innerHTML = this.getSendButtonMarkup();
    this.elements.sendButton.title = 'Send message';
    this.elements.sendButton.setAttribute('aria-label', 'Send message');
    this.elements.sendButton.disabled = !this.isInputEnabled || this.isWorkflowRecording || !hasSendableContent;
  }

  private renderSelectedSkillMention(): void {
    this.elements.skillMentionComposerSlot.innerHTML = '';
    this.elements.skillMentionComposerSlot.classList.toggle('hidden', !this.selectedSkillMention);
    if (this.selectedSkillMention) {
      this.elements.skillMentionComposerSlot.appendChild(this.createSkillMentionChip(this.selectedSkillMention, 'composer'));
    }
    this.notifyDraftChange();
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
    this.elements.container.querySelector('.workflow-demonstration-detail-overlay')?.remove();

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
    this.elements.container.appendChild(overlay);
    closeButton.focus();
  }

  private autoResizeMessageInput(): void {
    this.elements.messageInput.style.height = 'auto';
    const nextHeight = Math.min(Math.max(this.elements.messageInput.scrollHeight, 24), 96);
    this.elements.messageInput.style.height = `${nextHeight}px`;
  }

  private renderContextTabs(): void {
    this.elements.contextTabsContainer.innerHTML = '';

    const renderedTabIds = new Set<number>();
    if (this.includeCurrentContextTab && this.currentContextTab) {
      renderedTabIds.add(this.currentContextTab.tabId);
      this.elements.contextTabsContainer.appendChild(this.createContextTabChip(this.currentContextTab, 'Now', true));
    }

    for (const tab of this.extraContextTabs) {
      if (renderedTabIds.has(tab.tabId)) continue;
      renderedTabIds.add(tab.tabId);
      const isPrimaryFallback = !this.includeCurrentContextTab && renderedTabIds.size === 1;
      this.elements.contextTabsContainer.appendChild(
        this.createContextTabChip(tab, isPrimaryFallback ? 'Now' : 'Ctx', isPrimaryFallback),
      );
    }

    if (renderedTabIds.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-context-empty';
      empty.textContent = 'No tab attached';
      this.elements.contextTabsContainer.appendChild(empty);
    }

    this.refreshComposerState();
    this.scrollContextTabsToEnd();
    this.notifyDraftChange();
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
    if (!this.contextPickerMode || !this.isInputEnabled || this.isAgentBusy) {
      this.closeContextPicker();
      return;
    }

    if (this.contextPickerMode === 'skill') {
      const options = this.deps.getAvailableSkillMentionOptions(this.contextPickerQuery, this.getSkillMentionContext());
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
      this.elements.contextPicker.innerHTML = `
        <div class="context-picker-header">${this.deps.escapeHtml(hint)}</div>
        <div class="context-picker-empty">No matching tabs</div>`;
      this.elements.contextPicker.classList.remove('hidden');
      return;
    }

    const itemsHtml = this.contextPickerItems.map((tab, index) => {
      const title = this.deps.escapeHtml(tab.title || '(untitled tab)');
      const url = this.deps.escapeHtml(this.truncateText(tab.url || '', 90));
      return `
        <button class="context-picker-item${index === this.contextPickerHighlightIndex ? ' active' : ''}" type="button" data-tab-id="${tab.tabId}">
          <span class="context-picker-item-title">${title}</span>
          <span class="context-picker-item-url">${url}</span>
        </button>`;
    }).join('');

    this.elements.contextPicker.innerHTML = `
      <div class="context-picker-header">${this.deps.escapeHtml(hint)}</div>
      <div class="context-picker-list">${itemsHtml}</div>`;

    this.elements.contextPicker.querySelectorAll<HTMLButtonElement>('.context-picker-item').forEach((button, index) => {
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

    this.elements.contextPicker.classList.remove('hidden');
    this.updateContextPickerHighlight();
  }

  private renderSkillPickerList(): void {
    if (this.contextPickerMode !== 'skill') return;
    const hint = 'Select a skill with /';

    if (this.skillPickerItems.length === 0) {
      this.elements.contextPicker.innerHTML = `
        <div class="context-picker-header">${this.deps.escapeHtml(hint)}</div>
        <div class="context-picker-empty">No matching skills</div>`;
      this.elements.contextPicker.classList.remove('hidden');
      return;
    }

    const itemsHtml = this.skillPickerItems.map((option, index) => {
      const mention = option.mention;
      const title = this.deps.escapeHtml(mention.name);
      const slug = this.deps.escapeHtml(mention.slug);
      const description = this.deps.escapeHtml(this.truncateText(mention.description || 'No description provided.', 100));
      const kind = option.kind === 'domain' ? 'Domain Skill' : 'Interaction Skill';
      const matched = option.matchedContext ? '<span class="skill-picker-match">Matched</span>' : '';
      return `
        <button class="context-picker-item skill-picker-item ${option.className}${index === this.contextPickerHighlightIndex ? ' active' : ''}" type="button">
          <span class="skill-picker-row">
            <span class="skill-picker-kind">${this.deps.escapeHtml(kind)}</span>
            ${matched}
          </span>
          <span class="context-picker-item-title">${title}</span>
          <span class="context-picker-item-url">${slug} · ${description}</span>
        </button>`;
    }).join('');

    this.elements.contextPicker.innerHTML = `
      <div class="context-picker-header">${this.deps.escapeHtml(hint)}</div>
      <div class="context-picker-list">${itemsHtml}</div>`;

    this.elements.contextPicker.querySelectorAll<HTMLButtonElement>('.context-picker-item').forEach((button, index) => {
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

    this.elements.contextPicker.classList.remove('hidden');
    this.updateContextPickerHighlight();
  }

  private updateContextPickerHighlight(): void {
    const items = this.elements.contextPicker.querySelectorAll<HTMLButtonElement>('.context-picker-item');
    items.forEach((button, index) => {
      button.classList.toggle('active', index === this.contextPickerHighlightIndex);
    });
    const active = items[this.contextPickerHighlightIndex];
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  private scrollContextTabsToEnd(): void {
    requestAnimationFrame(() => {
      this.elements.contextTabsContainer.scrollLeft = this.elements.contextTabsContainer.scrollWidth;
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
    this.elements.messageInput.focus();
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

  private selectSkillPickerItem(option: SkillMentionPickerOption): void {
    this.applySkillMentionSelection();
    this.selectedSkillMention = option.mention;
    this.renderSelectedSkillMention();
    this.closeContextPicker();
    this.autoResizeMessageInput();
    this.refreshComposerState();
    this.elements.messageInput.focus();
  }

  private applySkillMentionSelection(): void {
    const range = this.skillMentionRange ?? this.inferLeadingSlashRange();
    if (!range) return;
    const value = this.elements.messageInput.value;
    const after = value.slice(range.end).replace(/^\s+/, '');
    this.elements.messageInput.value = after;
    this.elements.messageInput.setSelectionRange(0, 0);
  }

  private inferLeadingSlashRange(): { start: number; end: number } | null {
    const match = this.elements.messageInput.value.match(/^\/[^\s]*/);
    if (!match) return null;
    return { start: 0, end: match[0].length };
  }

  private applyMentionSelection(): void {
    if (!this.mentionRange) return;
    const { start, end } = this.mentionRange;
    const value = this.elements.messageInput.value;
    const before = value.slice(0, start);
    const after = value.slice(end);
    let nextBefore = before;
    let nextAfter = after;

    if (/\s$/.test(nextBefore) && /^\s/.test(nextAfter)) {
      nextAfter = nextAfter.replace(/^\s+/, ' ');
    } else if (nextBefore.length > 0 && nextAfter.length > 0 && !/\s$/.test(nextBefore) && !/^\s/.test(nextAfter)) {
      nextAfter = ` ${nextAfter}`;
    }

    this.elements.messageInput.value = `${nextBefore}${nextAfter}`;
    this.elements.messageInput.setSelectionRange(nextBefore.length, nextBefore.length);
  }

  private syncMentionPickerFromInput(): void {
    if (!this.isInputEnabled || this.isAgentBusy) {
      this.closeContextPicker();
      return;
    }

    if (this.syncSkillPickerFromInput()) return;

    const selectionStart = this.elements.messageInput.selectionStart ?? this.elements.messageInput.value.length;
    const beforeCaret = this.elements.messageInput.value.slice(0, selectionStart);
    const match = beforeCaret.match(/(^|\s)@([^\s@]*)$/);
    if (!match) {
      if (this.contextPickerMode === 'mention') this.closeContextPicker();
      return;
    }

    const query = match[2] ?? '';
    const tokenStart = selectionStart - match[0].length + match[1].length;
    const shouldResetHighlight = this.contextPickerMode !== 'mention' || this.contextPickerQuery !== query;
    this.contextPickerMode = 'mention';
    this.contextPickerQuery = query;
    if (shouldResetHighlight) {
      this.contextPickerHighlightIndex = 0;
    }
    this.mentionRange = { start: tokenStart, end: selectionStart };
    this.skillMentionRange = null;
    void this.refreshContextPicker();
  }

  private syncSkillPickerFromInput(): boolean {
    if (this.selectedSkillMention) {
      if (this.contextPickerMode === 'skill') this.closeContextPicker();
      return false;
    }

    const value = this.elements.messageInput.value;
    const match = value.match(/^\/([^\s]*)/);
    if (!match) {
      if (this.contextPickerMode === 'skill') this.closeContextPicker();
      return false;
    }

    const token = match[0];
    const selectionStart = this.elements.messageInput.selectionStart ?? value.length;
    if (selectionStart > token.length) {
      if (this.contextPickerMode === 'skill') this.closeContextPicker();
      return false;
    }

    const query = match[1] ?? '';
    const shouldResetHighlight = this.contextPickerMode !== 'skill' || this.contextPickerQuery !== query;
    this.contextPickerMode = 'skill';
    this.contextPickerQuery = query;
    if (shouldResetHighlight) {
      this.contextPickerHighlightIndex = 0;
    }
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
    this.elements.contextPicker.classList.add('hidden');
    this.elements.contextPicker.innerHTML = '';
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

      const result = await this.deps.onWorkflowRecordingStop(tabId);
      this.isWorkflowRecording = false;
      this.workflowRecordingTabId = null;
      this.refreshComposerState();

      if (!result.ok || !result.workflowDemonstration) {
        this.deps.onSystemMessage(`Could not stop workflow recording: ${result.error ?? 'unknown error'}`);
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
      this.deps.onSystemMessage('No browser tab is available to record right now.');
      return;
    }

    const result = await this.deps.onWorkflowRecordingStart(targetTab.tabId, {
      title: this.buildWorkflowDemonstrationDefaultTitle(),
      captureTypedValues: true,
    });

    if (!result.ok) {
      this.deps.onSystemMessage(`Could not start workflow recording: ${result.error ?? 'unknown error'}`);
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
    this.elements.workflowDemonstrationsDock.innerHTML = '';
    const demonstrations = this.getStagedWorkflowDemonstrations();
    this.elements.workflowDemonstrationsDock.classList.toggle('hidden', demonstrations.length === 0);

    for (const demonstration of demonstrations) {
      this.elements.workflowDemonstrationsDock.appendChild(this.createStagedWorkflowDemonstrationCard(demonstration));
    }

    this.refreshComposerState();
    this.notifyDraftChange();
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
    if (!this.deps.isWorkflowDemonstrationReferenced(id)) {
      this.workflowDemonstrationsById.delete(id);
    }
    this.renderStagedWorkflowDemonstrations();
  }

  private notifyDraftChange(): void {
    this.deps.onDraftChange();
  }
}
