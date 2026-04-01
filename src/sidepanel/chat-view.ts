// ─── Side Panel Chat View ───────────────────────────────────────────────────
// Gemini-like sidebar chat UI. Modeled after radiology-copilot-view.ts.

import type { WebMCPRegistryEntry } from '../shared/types';
import type { ToolStepEvent, ToolManifestEntry } from './agent';
import type { MCPServerEntry } from './mcp-client';
import { Agent } from './agent';

export interface SavedConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; time: string }>;
  chatHistory: Array<{ role: string; content: string }>;
}

export interface ChatViewCallbacks {
  onSendMessage: (message: string) => void;
  onConfigApply: (config: { mode: 'direct' | 'lmaas'; fields: Record<string, string> }) => void;
  onVLMConfigApply: (config: { baseUrl: string; apiKey: string; model: string }) => void;
  onRefreshWebMCP: () => void;
  onToolToggle: (toolName: string, enabled: boolean) => void;
  onToolGroupToggle: (toolNames: string[], enabled: boolean) => void;
  onConversationLoad: (conversation: SavedConversation) => void;
  onConversationNew: () => void;
  onConversationDelete: (id: string) => void;
  onMCPServerAdd: (name: string, url: string, authToken?: string) => Promise<MCPServerEntry>;
  onMCPServerRemove: (id: string) => void;
  onMCPServerReconnect: (id: string) => Promise<MCPServerEntry>;
}

type SurfaceMode = 'chat' | 'tools' | 'mcp' | 'conversations' | 'config';

export class ChatView {
  private container: HTMLElement;
  private callbacks: ChatViewCallbacks;

  // DOM references
  private chatHeader!: HTMLElement;
  private chatBody!: HTMLElement;
  private messagesContainer!: HTMLElement;
  private inputContainer!: HTMLElement;
  private messageInput!: HTMLInputElement;
  private sendButton!: HTMLButtonElement;
  private webmcpIndicator!: HTMLElement;
  private bottomNav!: HTMLElement;
  private configPanel!: HTMLElement;
  private toolsPanel!: HTMLElement;
  private conversationsPanel!: HTMLElement;
  private mcpPanel!: HTMLElement;

  // Panel state
  private configMode: 'direct' | 'lmaas' = 'direct';
  private isConfigVisible = false;
  private isToolsVisible = false;
  private isConversationsVisible = false;
  private isMCPVisible = false;
  private activeSurface: SurfaceMode = 'chat';

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

  constructor(container: HTMLElement, callbacks: ChatViewCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.build();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  public enableInput(): void {
    this.sendButton.disabled = false;
    this.messageInput.disabled = false;
  }

  public disableInput(): void {
    this.sendButton.disabled = true;
    this.messageInput.disabled = true;
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
    const completedSteps = steps.filter((s) => s.status === 'completed').length;
    const allCompleted = completedSteps === totalSteps;
    const totalDuration = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
    const durationStr = (totalDuration / 1000).toFixed(1) + 's';

    const statusIcon = allCompleted ? this.checkSvg() : this.spinnerSvg();
    const headerText = allCompleted
      ? `Worked with ${totalSteps} tool${totalSteps > 1 ? 's' : ''} · ${durationStr}`
      : `Working with ${totalSteps} tool${totalSteps > 1 ? 's' : ''}…`;

    const chevronSvg = this.toolStepsCollapsed
      ? `<svg class="tool-steps-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>`
      : `<svg class="tool-steps-chevron rotated" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

    // Build steps list with timeline connector
    let stepsHtml = '';
    for (const step of steps) {
      const stepIcon = step.status === 'completed' ? this.checkSvg() : this.spinnerSvg();
      const stepDuration = step.durationMs ? `${(step.durationMs / 1000).toFixed(1)}s` : '';
      const rawDesc = step.description || '';
      const description = rawDesc.length > 100 ? rawDesc.slice(0, 100) + '…' : rawDesc;

      stepsHtml += `
        <div class="tool-step-item ${step.status}">
          <div class="tool-step-connector">
            <div class="tool-step-icon">${stepIcon}</div>
          </div>
          <div class="tool-step-info">
            <span class="tool-step-label">${this.escapeHtml(step.label)}</span>
            ${description ? `<span class="tool-step-description">${this.escapeHtml(description)}</span>` : ''}
          </div>
          ${stepDuration ? `<span class="tool-step-duration">· ${stepDuration}</span>` : ''}
        </div>`;
    }

    this.currentToolStepsContainer.innerHTML = `
      <div class="tool-steps-header">
        <div class="tool-steps-header-left">
          ${statusIcon}
          <span class="tool-steps-header-text">${headerText}</span>
        </div>
        <div class="tool-steps-header-right">
          <span class="tool-steps-count">${completedSteps} step${completedSteps !== 1 ? 's' : ''} ${allCompleted ? '✓' : ''}</span>
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

    // Attach toggle listeners
    const header = this.currentToolStepsContainer.querySelector('.tool-steps-header');
    const toggleBtn = this.currentToolStepsContainer.querySelector('.tool-steps-toggle');
    const toggleFn = () => {
      this.toolStepsCollapsed = !this.toolStepsCollapsed;
      this.updateToolSteps(steps);
    };
    header?.addEventListener('click', toggleFn);
    toggleBtn?.addEventListener('click', (e) => { e.stopPropagation(); toggleFn(); });

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

      const header = finalized.querySelector('.tool-steps-header') as HTMLElement | null;
      const body = finalized.querySelector('.tool-steps-body') as HTMLElement | null;
      const toggleBtn = finalized.querySelector('.tool-steps-toggle') as HTMLElement | null;
      const chevronSvg = (collapsed: boolean) =>
        `<svg class="tool-steps-chevron${collapsed ? '' : ' rotated'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

      let collapsed = false;

      const render = () => {
        if (body) {
          body.classList.toggle('collapsed', collapsed);
          body.style.maxHeight = '';
          body.style.opacity = '';
          body.style.overflow = '';
        }

        finalized.querySelectorAll('.tool-steps-header .tool-steps-chevron').forEach((el) => {
          el.classList.toggle('rotated', !collapsed);
        });

        if (toggleBtn) {
          toggleBtn.innerHTML = `${collapsed ? 'Show details' : 'Hide details'} ${chevronSvg(collapsed)}`;
        }
      };

      const toggle = () => {
        collapsed = !collapsed;
        render();
      };

      header?.addEventListener('click', toggle);
      toggleBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
      });

      render();

      this.currentToolStepsContainer.replaceWith(finalized);
    }
    this.currentToolStepsContainer = null;
    this.toolStepsCollapsed = false;
  }

  /** Render an MCP App inside a sandboxed iframe */
  public renderMCPApp(appPayload: Record<string, unknown>): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'mcp-app-container';

    const iframe = document.createElement('iframe');
    iframe.sandbox.add('allow-scripts');
    iframe.className = 'mcp-app-iframe';

    // Set content via srcdoc if HTML is provided
    if (typeof appPayload.html === 'string') {
      iframe.srcdoc = appPayload.html;
    } else if (typeof appPayload.url === 'string') {
      iframe.src = appPayload.url;
    }

    wrapper.appendChild(iframe);
    this.messagesContainer.appendChild(wrapper);
    this.scrollToBottom();
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
          <h3>BROW</h3>
        </div>
      </div>
      <div class="header-meta">
        <div class="webmcp-indicator"><span class="status-dot unavailable"></span> WebMCP: N/A</div>
        <span class="connection-status">Ready</span>
        <button class="refresh-webmcp-btn" title="Refresh WebMCP discovery" aria-label="Refresh WebMCP discovery">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
        </button>
      </div>`;
    this.container.appendChild(this.chatHeader);

    this.webmcpIndicator = this.chatHeader.querySelector('.webmcp-indicator') as HTMLElement;
    const refreshBtn = this.chatHeader.querySelector('.refresh-webmcp-btn');
    refreshBtn?.addEventListener('click', () => this.callbacks.onRefreshWebMCP());

    // Chat body
    this.chatBody = document.createElement('div');
    this.chatBody.className = 'chat-body';

    this.messagesContainer = document.createElement('div');
    this.messagesContainer.className = 'chat-messages';

    this.inputContainer = document.createElement('div');
    this.inputContainer.className = 'chat-input-container';

    this.messageInput = document.createElement('input');
    this.messageInput.id = 'chat-input';
    this.messageInput.placeholder = 'Ask the agent anything…';
    this.messageInput.disabled = true;

    this.sendButton = document.createElement('button');
    this.sendButton.id = 'send-button';
    this.sendButton.disabled = true;
    this.sendButton.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;

    this.inputContainer.appendChild(this.messageInput);
    this.inputContainer.appendChild(this.sendButton);

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
  }

  private setupEventListeners(): void {
    const send = () => {
      const msg = this.messageInput.value.trim();
      if (msg) {
        this.callbacks.onSendMessage(msg);
        this.messageInput.value = '';
      }
    };

    this.sendButton.addEventListener('click', send);

    this.messageInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    this.messageInput.addEventListener('keyup', (e) => e.stopPropagation());
    this.messageInput.addEventListener('keypress', (e) => e.stopPropagation());

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
          case 'config':
            this.toggleConfigPanel();
            break;
          default:
            this.setActiveSurface('chat');
        }
      });
    });
  }

  // ─── Tools Panel ────────────────────────────────────────────────────────

  private setActiveSurface(surface: SurfaceMode): void {
    this.activeSurface = surface;
    this.isToolsVisible = surface === 'tools';
    this.isMCPVisible = surface === 'mcp';
    this.isConversationsVisible = surface === 'conversations';
    this.isConfigVisible = surface === 'config';

    this.chatBody.style.display = this.isConfigVisible ? 'none' : 'flex';
    this.configPanel.style.display = this.isConfigVisible ? 'flex' : 'none';
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
      const groupLabel = Agent.getCategoryLabel(category);

      const groupEl = document.createElement('div');
      groupEl.className = 'tools-group';

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
        <div class="tools-group-items">
          ${tools.map(t => `
            <div class="tools-item">
              <label class="tools-toggle-switch">
                <input type="checkbox" data-tool="${this.escapeHtml(t.name)}" ${t.enabled ? 'checked' : ''} />
                <span class="tools-toggle-slider"></span>
              </label>
              <div class="tools-item-info">
                <span class="tools-item-name">${this.escapeHtml(t.name)}</span>
                <span class="tools-item-arrow">&rsaquo;</span>
              </div>
            </div>
          `).join('')}
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

      container.appendChild(groupEl);
    }
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
      if (server.status === 'connected' && server.tools.length > 0) {
        toolsHtml = `<div class="mcp-server-tools">
          ${server.tools.map(t => `<span class="mcp-tool-chip" title="${this.escapeHtml(t.description)}">${this.escapeHtml(t.name)}</span>`).join('')}
        </div>`;
      }

      el.innerHTML = `
        <div class="mcp-server-header">
          <div class="mcp-server-info">
            <span class="status-dot ${statusDot}"></span>
            <div class="mcp-server-details">
              <span class="mcp-server-name">${this.escapeHtml(server.name)}</span>
              <span class="mcp-server-url">${this.escapeHtml(server.url)}</span>
              <span class="mcp-server-status">${statusText}</span>
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
      this.callbacks.onConversationNew();
      this.currentConversationId = null;
      this.setActiveSurface('chat');
    });

    return panel;
  }

  /** Refresh the conversations list from storage */
  public refreshConversationsPanel(): void {
    chrome.storage.local.get('agent-webmcp-conversations', (result) => {
      const conversations: SavedConversation[] = result['agent-webmcp-conversations'] ?? [];
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

    chrome.storage.local.get('agent-webmcp-conversations', (result) => {
      const conversations: SavedConversation[] = result['agent-webmcp-conversations'] ?? [];
      const existingIdx = conversations.findIndex(c => c.id === convo.id);
      if (existingIdx >= 0) {
        convo.createdAt = conversations[existingIdx].createdAt;
        conversations[existingIdx] = convo;
      } else {
        conversations.push(convo);
      }
      this.currentConversationId = convo.id;
      chrome.storage.local.set({ 'agent-webmcp-conversations': conversations });
    });
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
    chrome.storage.local.get('agent-webmcp-conversations', (result) => {
      const conversations: SavedConversation[] = result['agent-webmcp-conversations'] ?? [];
      const filtered = conversations.filter(c => c.id !== id);
      chrome.storage.local.set({ 'agent-webmcp-conversations': filtered });
      if (this.currentConversationId === id) {
        this.currentConversationId = null;
      }
    });
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
          <button class="config-mode-btn active" data-mode="direct">Direct</button>
          <button class="config-mode-btn" data-mode="lmaas">LMaaS</button>
        </div>

        <div class="config-fields config-direct-fields">
          <div class="config-field">
            <label for="llm-config-endpoint">Endpoint</label>
            <div class="config-endpoint-row">
              <input type="text" id="llm-config-endpoint" placeholder="http://host:port/v1" autocomplete="off" />
              <button class="config-refresh-btn" id="llm-config-refresh" title="Fetch models">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14">
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                </svg>
              </button>
            </div>
          </div>
          <div class="config-field">
            <label for="llm-config-api-key">API Key / Token</label>
            <input type="password" id="llm-config-api-key" placeholder="sk-… or Bearer …" autocomplete="off" />
          </div>
          <div class="config-field" id="llm-config-model-field">
            <label>Model Name</label>
            <input type="text" id="llm-config-model" placeholder="Model name" autocomplete="off" />
          </div>
        </div>

        <div class="config-fields config-lmaas-fields" style="display: none;">
          <div class="config-field">
            <label for="llm-config-client-id">Client ID</label>
            <input type="text" id="llm-config-client-id" placeholder="Client ID" autocomplete="off" />
          </div>
          <div class="config-field">
            <label for="llm-config-client-secret">Client Secret</label>
            <input type="password" id="llm-config-client-secret" placeholder="Client Secret" autocomplete="off" />
          </div>
          <div class="config-field">
            <label for="llm-config-audience">Audience</label>
            <input type="text" id="llm-config-audience" placeholder="Audience" autocomplete="off" />
          </div>
          <div class="config-field">
            <label for="llm-config-deployment">Deployment Name</label>
            <input type="text" id="llm-config-deployment" placeholder="gpt-4.1-2025-04-14" autocomplete="off" />
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
        const mode = (btn as HTMLElement).dataset.mode as 'direct' | 'lmaas';
        this.configMode = mode;
        modeBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const df = panel.querySelector('.config-direct-fields') as HTMLElement;
        const lf = panel.querySelector('.config-lmaas-fields') as HTMLElement;
        if (df) df.style.display = mode === 'direct' ? '' : 'none';
        if (lf) lf.style.display = mode === 'lmaas' ? '' : 'none';
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

  private populateConfigFields(): void {
    const defaultDirect = {
      baseUrl: 'http://frbucawdl08.av.lab.ge-healthcare.net:4008/v1',
      apiKey: 'test',
      model: 'Qwen/Qwen3-Coder-Next-FP8',
    };
    const defaultLmaas = {
      clientId: 'YgfOyfUMHU2oQxWQPKiuG4gifPAa',
      clientSecret: 'teflpHu0UUtimxR1jS9lW4xI6jsa',
      audience: '0_b2dJB20TBhxzLIHCMzSG4RiQYa',
      deployment: 'integ-gpt-4.1-2025-04-14',
    };
    const defaultVlm = {
      baseUrl: 'http://frbucawdl08.av.lab.ge-healthcare.net:4010/v1',
      apiKey: '',
      model: 'Qwen3-VL-30B-A3B-Thinking',
    };

    chrome.storage.local.get('agent-webmcp-config', (result) => {
      const saved = (result['agent-webmcp-config'] as Record<string, any>) ?? {};
      const direct = { ...defaultDirect, ...(saved.direct ?? {}) };
      const lmaas = { ...defaultLmaas, ...(saved.lmaas ?? {}) };
      const vlm = { ...defaultVlm, ...(saved.vlm ?? {}) };

      this.setInput('llm-config-endpoint', direct.baseUrl);
      this.setInput('llm-config-api-key', direct.apiKey);
      this.setInput('llm-config-model', direct.model);
      this.setInput('llm-config-client-id', lmaas.clientId);
      this.setInput('llm-config-client-secret', lmaas.clientSecret);
      this.setInput('llm-config-audience', lmaas.audience);
      this.setInput('llm-config-deployment', lmaas.deployment);
      this.setInput('vlm-config-endpoint', vlm.baseUrl);
      this.setInput('vlm-config-api-key', vlm.apiKey);
      this.setInput('vlm-config-model', vlm.model);

      if (saved.activeMode) {
        this.configMode = saved.activeMode;
        const btns = this.configPanel.querySelectorAll('.config-mode-btn');
        btns.forEach((b) => {
          b.classList.toggle('active', (b as HTMLElement).dataset.mode === this.configMode);
        });
        const df = this.configPanel.querySelector('.config-direct-fields') as HTMLElement;
        const lf = this.configPanel.querySelector('.config-lmaas-fields') as HTMLElement;
        if (df) df.style.display = this.configMode === 'direct' ? '' : 'none';
        if (lf) lf.style.display = this.configMode === 'lmaas' ? '' : 'none';
      }
    });
  }

  private applyConfig(): void {
    const statusEl = this.configPanel.querySelector('.config-status') as HTMLElement;
    const fields: Record<string, string> = {};

    if (this.configMode === 'direct') {
      fields.baseUrl = this.getInput('llm-config-endpoint');
      fields.apiKey = this.getInput('llm-config-api-key');
      const select = this.configPanel.querySelector('#llm-config-model-select') as HTMLSelectElement;
      fields.model = select ? select.value : this.getInput('llm-config-model');

      if (!fields.baseUrl || !fields.model) {
        if (statusEl) {
          statusEl.textContent = 'Endpoint and model are required.';
          statusEl.className = 'config-status error';
        }
        return;
      }
    } else {
      fields.clientId = this.getInput('llm-config-client-id');
      fields.clientSecret = this.getInput('llm-config-client-secret');
      fields.audience = this.getInput('llm-config-audience');
      fields.deployment = this.getInput('llm-config-deployment');

      if (!fields.clientId || !fields.clientSecret || !fields.deployment) {
        if (statusEl) {
          statusEl.textContent = 'Client ID, secret, and deployment are required.';
          statusEl.className = 'config-status error';
        }
        return;
      }
    }

    // Save to chrome.storage.local
    chrome.storage.local.get('agent-webmcp-config', (result) => {
      const existing = (result['agent-webmcp-config'] as Record<string, any>) ?? {};
      if (this.configMode === 'direct') {
        existing.direct = fields;
      } else {
        existing.lmaas = fields;
      }
      existing.activeMode = this.configMode;

      // Always save VLM config alongside LLM config
      existing.vlm = {
        baseUrl: this.getInput('vlm-config-endpoint'),
        apiKey: this.getInput('vlm-config-api-key'),
        model: this.getInput('vlm-config-model'),
      };

      chrome.storage.local.set({ 'agent-webmcp-config': existing });
    });

    this.callbacks.onConfigApply({ mode: this.configMode, fields });

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
      statusEl.textContent = `Applied! Using ${this.configMode === 'direct' ? 'Direct' : 'LMaaS'} mode.`;
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
    const el = this.configPanel.querySelector(`#${id}`) as HTMLInputElement;
    if (el) el.value = value;
  }

  private getInput(id: string): string {
    const el = this.configPanel.querySelector(`#${id}`) as HTMLInputElement;
    return el?.value?.trim() ?? '';
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

  private checkSvg(): string {
    return `<svg class="tool-step-check" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#5cb582" stroke-width="2"/><path d="M6 10l3 3 5-6" stroke="#5cb582" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  private spinnerSvg(): string {
    return `<svg class="tool-step-spinner" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="#5ba8c8" stroke-width="2" stroke-dasharray="38 14" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 10 10" to="360 10 10" dur="0.8s" repeatCount="indefinite"/></circle></svg>`;
  }
}
