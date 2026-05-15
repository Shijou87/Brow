import { DEFAULT_SYSTEM_PROMPT } from '../../shared/config';
import type {
  DomainMemoryEntry,
  DomainSkillProposal,
  InteractionSkillEntry,
} from '../../shared/types';
import {
  loadPromptEditorState,
  saveDomainSkillRegistryEntries,
  saveSystemPrompt,
} from './config-store';
import { saveDomainSkillProposalEntries } from '../domain-skill-proposals';
import { hasDisallowedDomainMemoryContent, saveDomainMemoryEntries } from '../domain-memory';
import { escapeHtml as escapeMessageHtml } from '../message-format';
import { renderMarkdownPreview } from './markdown-preview';
import { formatRelativeTime } from './ui-format';
import {
  buildSkillMentionPickerOptions,
  formatSkillTagsInput,
  parseSkillTagsInput,
  parseSkillMarkdownImport,
  slugifySkillName,
  type SkillDraft,
  type SkillMentionPickerOption,
  type SkillRegistryEntry,
} from '../skills-registry';

type SkillMentionContext = {
  url?: string;
  title?: string;
};

export interface PromptPanelModuleCallbacks {
  onClosePanel: () => void;
  onSystemPromptApply: (prompt: string) => void;
  onSkillCatalogChanged: () => void;
  onSkillRegistryApply: (skills: SkillRegistryEntry[]) => void;
}

export class PromptPanelModule {
  private readonly panel: HTMLElement;
  private readonly callbacks: PromptPanelModuleCallbacks;

  private systemPromptPreviewMode: 'edit' | 'preview' = 'edit';
  private skillContentPreviewMode: 'edit' | 'preview' = 'edit';
  private skillRegistry: SkillRegistryEntry[] = [];
  private domainSkillProposals: DomainSkillProposal[] = [];
  private domainMemoryEntries: DomainMemoryEntry[] = [];
  private interactionSkillRegistry: InteractionSkillEntry[] = [];
  private editingSkillId: string | null = null;
  private editingDomainMemoryId: string | null = null;
  private isSkillEditorOpen = false;
  private skillEditorSlugDirty = false;

  constructor(panel: HTMLElement, callbacks: PromptPanelModuleCallbacks) {
    this.panel = panel;
    this.callbacks = callbacks;
    this.bindInteractions();
  }

  public async initialize(): Promise<void> {
    const { domainSkills, interactionSkills } = await loadPromptEditorState();
    this.skillRegistry = domainSkills;
    this.interactionSkillRegistry = interactionSkills;
    this.callbacks.onSkillCatalogChanged();
  }

  public populateFields(): void {
    void loadPromptEditorState().then(({ systemPrompt, domainSkills, domainSkillProposals, domainMemory, interactionSkills }) => {
      this.skillRegistry = domainSkills;
      this.domainSkillProposals = domainSkillProposals;
      this.domainMemoryEntries = domainMemory;
      this.interactionSkillRegistry = interactionSkills;
      this.setPromptInput('llm-config-system-prompt', systemPrompt || DEFAULT_SYSTEM_PROMPT);
      this.refreshSystemPromptPreview(this.panel);
      this.setSystemPromptPreviewMode(this.systemPromptPreviewMode, this.panel);
      this.isSkillEditorOpen = false;
      this.editingSkillId = null;
      this.editingDomainMemoryId = null;
      this.renderSkillRegistry();
      this.closeSkillEditor(false);
      this.callbacks.onSkillCatalogChanged();
    });
  }

  public getAvailableSkillMentionOptions(
    query: string,
    context: SkillMentionContext,
  ): SkillMentionPickerOption[] {
    return buildSkillMentionPickerOptions({
      domainSkills: this.skillRegistry,
      interactionSkills: this.interactionSkillRegistry,
      query,
      context,
    });
  }

  private bindInteractions(): void {
    const systemPromptInput = this.panel.querySelector('#llm-config-system-prompt') as HTMLTextAreaElement | null;
    systemPromptInput?.addEventListener('input', () => this.refreshSystemPromptPreview(this.panel));

    this.panel.querySelectorAll('.config-editor-btn[data-view]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const view = (btn as HTMLElement).dataset.view as 'edit' | 'preview';
        this.setSystemPromptPreviewMode(view, this.panel);
      });
    });

    this.panel.querySelector('.prompt-apply-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.applyPrompt();
    });

    this.panel.querySelector('.skills-new-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openSkillEditor();
    });

    const importUrlInput = this.panel.querySelector('.skills-import-url') as HTMLInputElement | null;
    const importFileInput = this.panel.querySelector('.skills-file-input') as HTMLInputElement | null;
    const dropzone = this.panel.querySelector('.skills-dropzone') as HTMLElement | null;

    this.panel.querySelector('.skills-import-url-btn')?.addEventListener('click', async (e) => {
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

    this.panel.querySelectorAll('.config-editor-btn[data-skill-view]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const view = (btn as HTMLElement).dataset.skillView as 'edit' | 'preview';
        this.setSkillContentPreviewMode(view);
      });
    });

    const skillNameInput = this.panel.querySelector('#skill-display-name') as HTMLInputElement | null;
    const skillSlugInput = this.panel.querySelector('#skill-slug') as HTMLInputElement | null;
    const skillContentInput = this.panel.querySelector('#skill-content') as HTMLTextAreaElement | null;

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

    this.panel.querySelector('.skill-save-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.saveSkillFromEditor();
    });
    this.panel.querySelector('.skill-cancel-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeSkillEditor();
    });

    this.panel.addEventListener('keydown', (e) => e.stopPropagation());
    this.panel.addEventListener('keyup', (e) => e.stopPropagation());
    this.panel.addEventListener('keypress', (e) => e.stopPropagation());

    this.setSystemPromptPreviewMode('edit', this.panel);
    this.setSkillContentPreviewMode('edit', this.panel);
  }

  private applyPrompt(): void {
    const systemPrompt = this.getPromptInput('llm-config-system-prompt') || DEFAULT_SYSTEM_PROMPT;
    void saveSystemPrompt(systemPrompt);

    this.callbacks.onSystemPromptApply(systemPrompt);

    this.setPromptStatus('Prompt applied.', 'success');
    window.setTimeout(() => {
      this.callbacks.onClosePanel();
      this.setPromptStatus('');
    }, 900);
  }

  private renderSkillRegistry(): void {
    const proposalList = this.panel.querySelector('.domain-skill-proposals-list') as HTMLElement | null;
    const proposalCount = this.panel.querySelector('.domain-skill-proposals-count') as HTMLElement | null;
    const list = this.panel.querySelector('.skills-registry-list') as HTMLElement | null;
    const count = this.panel.querySelector('.skills-registry-count') as HTMLElement | null;
    const domainMemoryList = this.panel.querySelector('.domain-memory-list') as HTMLElement | null;
    const domainMemoryCount = this.panel.querySelector('.domain-memory-count') as HTMLElement | null;
    const interactionList = this.panel.querySelector('.interaction-skills-list') as HTMLElement | null;
    const interactionCount = this.panel.querySelector('.interaction-skills-count') as HTMLElement | null;
    const dock = this.panel.querySelector('.skill-editor-dock') as HTMLElement | null;
    const editorPanel = this.panel.querySelector('.skill-editor-panel') as HTMLElement | null;
    if (!proposalList || !proposalCount || !list || !count || !domainMemoryList || !domainMemoryCount || !interactionList || !interactionCount || !dock || !editorPanel) return;

    this.renderDomainSkillProposalRegistry(proposalList, proposalCount);
    this.renderDomainMemoryRegistry(domainMemoryList, domainMemoryCount);
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
          <div class="skill-card-meta">Updated ${formatRelativeTime(new Date(skill.updatedAt))}</div>
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
          <div class="skill-card-meta">Proposed ${formatRelativeTime(new Date(proposal.updatedAt))}</div>
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

  private renderDomainMemoryRegistry(list: HTMLElement, count: HTMLElement): void {
    count.textContent = `${this.domainMemoryEntries.length} domain memory card${this.domainMemoryEntries.length !== 1 ? 's' : ''}`;
    list.innerHTML = '';

    if (this.domainMemoryEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'skills-empty-state';
      empty.textContent = 'No Domain Memory cards yet.';
      list.appendChild(empty);
      return;
    }

    for (const memory of this.domainMemoryEntries) {
      const isEditing = this.editingDomainMemoryId === memory.id;
      const card = document.createElement('div');
      card.className = `skill-card domain-memory-card${memory.enabled ? ' enabled' : ' disabled'}${isEditing ? ' is-editing' : ''}`;

      if (isEditing) {
        card.innerHTML = `
          <div class="skill-card-header">
            <div class="skill-card-title-group">
              <div class="skill-card-title">Edit Domain Memory</div>
              <div class="skill-card-slug">${this.escapeHtml(memory.id)}</div>
            </div>
          </div>
          <div class="config-fields domain-memory-editor-fields">
            <div class="config-field">
              <label>Title</label>
              <input type="text" class="domain-memory-title-input" value="${this.escapeHtml(memory.title)}" autocomplete="off" />
            </div>
            <div class="config-field">
              <label>Lesson</label>
              <textarea class="domain-memory-lesson-input" spellcheck="false">${this.escapeHtml(memory.lesson)}</textarea>
            </div>
            <div class="config-field">
              <label>Applies When</label>
              <input type="text" class="domain-memory-applies-input" value="${this.escapeHtml(memory.appliesWhen ?? '')}" autocomplete="off" />
            </div>
            <div class="config-field">
              <label>Tags</label>
              <input type="text" class="domain-memory-tags-input" value="${this.escapeHtml(formatSkillTagsInput(memory.tags))}" autocomplete="off" />
            </div>
            <div class="config-field">
              <label>Evidence</label>
              <input type="text" class="domain-memory-evidence-input" value="${this.escapeHtml(formatSkillTagsInput(memory.evidence))}" autocomplete="off" />
            </div>
            <div class="config-field">
              <label>Match Domain</label>
              <input type="text" class="domain-memory-domain-input" value="${this.escapeHtml(memory.matcher?.domain ?? '')}" autocomplete="off" />
            </div>
            <div class="config-field">
              <label>Path Patterns</label>
              <input type="text" class="domain-memory-paths-input" value="${this.escapeHtml(this.formatSkillMatcherInput(memory.matcher?.pathPatterns))}" autocomplete="off" />
            </div>
            <div class="config-field">
              <label>Page Patterns</label>
              <input type="text" class="domain-memory-pages-input" value="${this.escapeHtml(this.formatSkillMatcherInput(memory.matcher?.pagePatterns))}" autocomplete="off" />
            </div>
            <div class="config-field">
              <label>Confidence</label>
              <input type="number" class="domain-memory-confidence-input" min="0" max="1" step="0.01" value="${this.escapeHtml(String(memory.confidence))}" />
            </div>
          </div>
          <div class="skill-editor-actions">
            <button class="config-apply-btn domain-memory-save-btn" type="button">Save Memory</button>
            <button class="skill-cancel-btn domain-memory-cancel-btn" type="button">Cancel</button>
          </div>`;

        card.querySelector('.domain-memory-save-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.saveDomainMemoryFromCard(memory.id, card);
        });
        card.querySelector('.domain-memory-cancel-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.editingDomainMemoryId = null;
          this.renderSkillRegistry();
        });
        list.appendChild(card);
        continue;
      }

      const tags = this.renderSkillTagHtml(memory.tags, memory.matcher);
      const evidence = memory.evidence.length > 0
        ? `<div class="skill-card-tags">${memory.evidence.map((item) => `<span class="skill-tag">${this.escapeHtml(item)}</span>`).join('')}</div>`
        : '';
      const scope = [
        memory.matcher?.domain ? `domain:${memory.matcher.domain}` : '',
        ...(memory.matcher?.pathPatterns ?? []).map((pattern) => `path:${pattern}`),
        ...(memory.matcher?.pagePatterns ?? []).map((pattern) => `page:${pattern}`),
      ].filter(Boolean).join(' · ') || 'No scope';
      const stats = `${Math.round(memory.confidence * 100)}% confidence · ${memory.useCount} use${memory.useCount !== 1 ? 's' : ''} · ${memory.successCount} success · ${memory.failureCount} failure`;

      card.innerHTML = `
        <div class="skill-card-header">
          <div class="skill-card-title-group">
            <div class="skill-card-title">${this.escapeHtml(memory.title)}</div>
            <div class="skill-card-slug">${this.escapeHtml(scope)}</div>
          </div>
          <button class="skill-remove-btn domain-memory-remove-btn" type="button" aria-label="Remove memory" title="Remove memory">×</button>
        </div>
        <div class="skill-card-description">${this.escapeHtml(memory.lesson)}</div>
        ${memory.appliesWhen ? `<div class="skill-card-meta">Applies when: ${this.escapeHtml(memory.appliesWhen)}</div>` : ''}
        ${tags}
        ${evidence}
        <div class="skill-card-footer">
          <div class="skill-card-meta">${this.escapeHtml(stats)} · Updated ${formatRelativeTime(new Date(memory.updatedAt))}</div>
          <div class="skill-card-actions">
            <button class="skill-toggle-btn${memory.enabled ? ' is-enabled' : ''}" type="button">${memory.enabled ? 'Active' : 'Inactive'}</button>
            <button class="skill-edit-btn domain-memory-edit-btn" type="button">Edit</button>
          </div>
        </div>`;

      card.querySelector('.skill-toggle-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.domainMemoryEntries = this.domainMemoryEntries.map((entry) =>
          entry.id === memory.id ? { ...entry, enabled: !entry.enabled, updatedAt: Date.now() } : entry,
        );
        this.persistDomainMemory(memory.enabled ? 'Domain Memory disabled.' : 'Domain Memory enabled.');
      });
      card.querySelector('.domain-memory-edit-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.editingDomainMemoryId = memory.id;
        this.renderSkillRegistry();
      });
      card.querySelector('.domain-memory-remove-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeDomainMemory(memory.id);
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
    const urlInput = this.panel.querySelector('.skills-import-url') as HTMLInputElement | null;
    const importButton = this.panel.querySelector('.skills-import-url-btn') as HTMLButtonElement | null;
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
    this.setPromptStatus('Loading Domain Skill from URL...');

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
    const panel = this.panel.querySelector('.skill-editor-panel') as HTMLElement | null;
    const title = this.panel.querySelector('.skill-editor-title') as HTMLElement | null;
    const nameInput = this.panel.querySelector('#skill-display-name') as HTMLInputElement | null;
    const slugInput = this.panel.querySelector('#skill-slug') as HTMLInputElement | null;
    const descriptionInput = this.panel.querySelector('#skill-description') as HTMLInputElement | null;
    const tagsInput = this.panel.querySelector('#skill-tags') as HTMLInputElement | null;
    const matchDomainInput = this.panel.querySelector('#skill-match-domain') as HTMLInputElement | null;
    const matchPathsInput = this.panel.querySelector('#skill-match-paths') as HTMLInputElement | null;
    const matchPagesInput = this.panel.querySelector('#skill-match-pages') as HTMLInputElement | null;
    const contentInput = this.panel.querySelector('#skill-content') as HTMLTextAreaElement | null;
    const saveButton = this.panel.querySelector('.skill-save-btn') as HTMLButtonElement | null;
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
    const panel = this.panel.querySelector('.skill-editor-panel') as HTMLElement | null;
    const dock = this.panel.querySelector('.skill-editor-dock') as HTMLElement | null;
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
      this.callbacks.onSkillCatalogChanged();
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
    const nameInput = this.panel.querySelector('#skill-display-name') as HTMLInputElement | null;
    const slugInput = this.panel.querySelector('#skill-slug') as HTMLInputElement | null;
    const descriptionInput = this.panel.querySelector('#skill-description') as HTMLInputElement | null;
    const tagsInput = this.panel.querySelector('#skill-tags') as HTMLInputElement | null;
    const matchDomainInput = this.panel.querySelector('#skill-match-domain') as HTMLInputElement | null;
    const matchPathsInput = this.panel.querySelector('#skill-match-paths') as HTMLInputElement | null;
    const matchPagesInput = this.panel.querySelector('#skill-match-pages') as HTMLInputElement | null;
    const contentInput = this.panel.querySelector('#skill-content') as HTMLTextAreaElement | null;
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
    root: ParentNode = this.panel,
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

  private refreshSkillContentPreview(root: ParentNode = this.panel): void {
    const input = root.querySelector('#skill-content') as HTMLTextAreaElement | null;
    const preview = root.querySelector('#skill-content-preview') as HTMLElement | null;
    if (!input || !preview) return;
    preview.innerHTML = renderMarkdownPreview(input.value.trim() || '# Skill');
  }

  private persistSkillRegistry(message?: string): void {
    void saveDomainSkillRegistryEntries(this.skillRegistry).then((skills) => {
      this.skillRegistry = skills;
      this.callbacks.onSkillRegistryApply(this.skillRegistry);
      this.callbacks.onSkillCatalogChanged();
      this.renderSkillRegistry();
      if (message) {
        this.setPromptStatus(message, 'success');
      }
    });
  }

  private saveDomainMemoryFromCard(memoryId: string, card: HTMLElement): void {
    const existing = this.domainMemoryEntries.find((entry) => entry.id === memoryId);
    if (!existing) return;

    const title = (card.querySelector('.domain-memory-title-input') as HTMLInputElement | null)?.value.trim() ?? '';
    const lesson = (card.querySelector('.domain-memory-lesson-input') as HTMLTextAreaElement | null)?.value.trim() ?? '';
    const appliesWhen = (card.querySelector('.domain-memory-applies-input') as HTMLInputElement | null)?.value.trim() || undefined;
    const tags = parseSkillTagsInput((card.querySelector('.domain-memory-tags-input') as HTMLInputElement | null)?.value ?? '');
    const evidence = parseSkillTagsInput((card.querySelector('.domain-memory-evidence-input') as HTMLInputElement | null)?.value ?? '');
    const domain = (card.querySelector('.domain-memory-domain-input') as HTMLInputElement | null)?.value.trim().toLowerCase() || undefined;
    const pathPatterns = this.parseSkillMatcherInput((card.querySelector('.domain-memory-paths-input') as HTMLInputElement | null)?.value ?? '');
    const pagePatterns = this.parseSkillMatcherInput((card.querySelector('.domain-memory-pages-input') as HTMLInputElement | null)?.value ?? '');
    const confidenceRaw = Number((card.querySelector('.domain-memory-confidence-input') as HTMLInputElement | null)?.value ?? existing.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : existing.confidence;
    const matcher = domain || pathPatterns || pagePatterns ? { domain, pathPatterns, pagePatterns } : undefined;

    if (!title || !lesson || !matcher?.domain) {
      this.setPromptStatus('Domain Memory requires title, lesson, and match domain.', 'error');
      return;
    }
    if (hasDisallowedDomainMemoryContent([title, lesson, appliesWhen, ...tags, ...evidence])) {
      this.setPromptStatus('Domain Memory cannot store secrets, account content, or private user data.', 'error');
      return;
    }

    this.domainMemoryEntries = this.domainMemoryEntries.map((entry) =>
      entry.id === memoryId
        ? {
          ...entry,
          title,
          lesson,
          appliesWhen,
          tags,
          evidence,
          matcher,
          confidence,
          updatedAt: Date.now(),
        }
        : entry,
    );
    this.editingDomainMemoryId = null;
    this.persistDomainMemory('Domain Memory updated.');
  }

  private removeDomainMemory(memoryId: string): void {
    const removedMemory = this.domainMemoryEntries.find((entry) => entry.id === memoryId);
    if (!removedMemory) return;
    this.domainMemoryEntries = this.domainMemoryEntries.filter((entry) => entry.id !== memoryId);
    if (this.editingDomainMemoryId === memoryId) {
      this.editingDomainMemoryId = null;
    }
    this.persistDomainMemory(`Domain Memory "${removedMemory.title}" removed.`);
  }

  private persistDomainMemory(message?: string): void {
    void saveDomainMemoryEntries(this.domainMemoryEntries).then((entries) => {
      this.domainMemoryEntries = entries;
      this.renderSkillRegistry();
      if (message) {
        this.setPromptStatus(message, 'success');
      }
    });
  }

  private setPromptStatus(message: string, tone: '' | 'success' | 'error' = ''): void {
    const statusEl = this.panel.querySelector('.prompt-status') as HTMLElement | null;
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = `config-status prompt-status${tone ? ` ${tone}` : ''}`;
  }

  private setPromptInput(id: string, value: string): void {
    const el = this.panel.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    if (el) el.value = value;
  }

  private getPromptInput(id: string): string {
    const el = this.panel.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    return el?.value?.trim() ?? '';
  }

  private setSystemPromptPreviewMode(
    mode: 'edit' | 'preview',
    root: ParentNode = this.panel,
  ): void {
    this.systemPromptPreviewMode = mode;
    root.querySelectorAll<HTMLElement>('.config-editor-btn[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === mode);
    });

    const input = root.querySelector('#llm-config-system-prompt') as HTMLTextAreaElement | null;
    const preview = root.querySelector('#llm-config-system-prompt-preview') as HTMLElement | null;
    if (!input || !preview) return;

    this.refreshSystemPromptPreview(root);
    input.style.display = mode === 'edit' ? '' : 'none';
    preview.style.display = mode === 'preview' ? '' : 'block';
  }

  private refreshSystemPromptPreview(root: ParentNode = this.panel): void {
    const input = root.querySelector('#llm-config-system-prompt') as HTMLTextAreaElement | null;
    const preview = root.querySelector('#llm-config-system-prompt-preview') as HTMLElement | null;
    if (!input || !preview) return;
    preview.innerHTML = renderMarkdownPreview(input.value.trim() || DEFAULT_SYSTEM_PROMPT);
  }

  private escapeHtml(text: string): string {
    return escapeMessageHtml(text);
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}
