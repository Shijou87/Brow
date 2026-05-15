import {
  messageCopiedSvg,
  messageCopyFailedSvg,
  messageCopySvg,
} from './icons';
import type { SavedConversationMessage } from './types';
import type { SkillMentionReference, WorkflowDemonstration } from '../../shared/types';

export interface TranscriptModuleDeps {
  escapeHtml: (text: string) => string;
  formatMessage: (message: string) => string;
  createSkillMentionChip: (
    mention: SkillMentionReference,
    placement: 'composer' | 'message',
  ) => HTMLElement;
  createWorkflowDemonstrationMessageCard: (demonstration: WorkflowDemonstration) => HTMLElement;
  getWorkflowDemonstrationById: (id: string) => WorkflowDemonstration | undefined;
  requestScrollToBottom: () => void;
}

export class TranscriptModule {
  private readonly messagesContainer: HTMLElement;
  private readonly deps: TranscriptModuleDeps;

  private streamingElement: HTMLElement | null = null;

  constructor(messagesContainer: HTMLElement, deps: TranscriptModuleDeps) {
    this.messagesContainer = messagesContainer;
    this.deps = deps;
  }

  public getStreamingElement(): HTMLElement | null {
    return this.streamingElement;
  }

  public clear(): void {
    this.messagesContainer.innerHTML = '';
    this.streamingElement = null;
  }

  public renderConversationMessage(message: SavedConversationMessage): void {
    const el = document.createElement('div');
    el.className = `message ${message.role}-message`;

    const content = document.createElement('div');
    content.className = 'message-content';
    if (message.role === 'assistant') {
      content.innerHTML = this.deps.formatMessage(message.content);
    } else if (message.role === 'user' && message.skillMention) {
      content.classList.add('with-skill-mention');
      content.appendChild(this.deps.createSkillMentionChip(message.skillMention, 'message'));
      const text = document.createElement('span');
      text.className = 'message-text';
      text.innerHTML = this.deps.escapeHtml(message.content).replace(/\n/g, '<br>');
      content.appendChild(text);
    } else {
      content.innerHTML = this.deps.escapeHtml(message.content).replace(/\n/g, '<br>');
    }
    el.appendChild(content);

    if (message.workflowDemonstrationIds?.length) {
      const attachments = document.createElement('div');
      attachments.className = 'message-workflow-demonstrations';
      for (const workflowDemonstrationId of message.workflowDemonstrationIds) {
        const demonstration = this.deps.getWorkflowDemonstrationById(workflowDemonstrationId);
        if (!demonstration) continue;
        attachments.appendChild(this.deps.createWorkflowDemonstrationMessageCard(demonstration));
      }
      if (attachments.childElementCount > 0) {
        el.appendChild(attachments);
      }
    }

    if (message.time || (message.content && message.role !== 'system')) {
      el.appendChild(this.createMessageFooter(
        message.time,
        message.content && message.role !== 'system' ? () => message.content : null,
      ));
    }

    this.messagesContainer.appendChild(el);
    this.deps.requestScrollToBottom();
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
    this.deps.requestScrollToBottom();
  }

  public hideTypingIndicator(): void {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  public streamAssistantMessage(message: string): void {
    if (this.streamingElement) {
      const textSpan = this.streamingElement.querySelector('.streaming-text') as HTMLElement | null;
      if (textSpan) {
        textSpan.innerHTML = this.deps.formatMessage(message);
      }
      this.streamingElement.dataset.copyText = message;
      this.deps.requestScrollToBottom();
      return;
    }

    const el = document.createElement('div');
    el.className = 'message assistant-message';
    el.dataset.copyText = message;

    const content = document.createElement('div');
    content.className = 'message-content';
    const textSpan = document.createElement('span');
    textSpan.className = 'streaming-text';
    const cursor = document.createElement('span');
    cursor.className = 'streaming-cursor';
    cursor.textContent = '|';
    content.append(textSpan, cursor);
    el.appendChild(content);
    el.appendChild(this.createMessageFooter(
      new Date().toLocaleTimeString(),
      () => el.dataset.copyText ?? '',
    ));

    this.messagesContainer.appendChild(el);
    this.streamingElement = el;
    textSpan.innerHTML = this.deps.formatMessage(message);
    this.deps.requestScrollToBottom();
  }

  public finalizeStreaming(): void {
    if (this.streamingElement) {
      const cursor = this.streamingElement.querySelector('.streaming-cursor');
      if (cursor) cursor.remove();
      this.streamingElement = null;
    }
  }

  private createMessageFooter(
    timeText: string | undefined,
    getText: (() => string) | null,
  ): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'message-footer';
    if (!timeText?.trim()) {
      footer.classList.add('copy-only');
    }

    if (timeText?.trim()) {
      const time = document.createElement('div');
      time.className = 'message-time';
      time.textContent = timeText;
      footer.appendChild(time);
    }

    if (getText) {
      footer.appendChild(this.createMessageCopyButton(getText));
    }

    return footer;
  }

  private createMessageCopyButton(getText: () => string): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'message-copy-button';
    button.type = 'button';
    button.title = 'Copy message';
    button.setAttribute('aria-label', 'Copy message');
    button.innerHTML = messageCopySvg();
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.copyMessageToClipboard(button, getText);
    });
    return button;
  }

  private async copyMessageToClipboard(
    button: HTMLButtonElement,
    getText: () => string,
  ): Promise<void> {
    const text = getText();
    if (!text) return;

    button.disabled = true;
    button.classList.remove('is-copied', 'is-copy-failed');

    try {
      await navigator.clipboard.writeText(text);
      button.classList.add('is-copied');
      button.innerHTML = messageCopiedSvg();
      button.title = 'Copied';
      button.setAttribute('aria-label', 'Message copied');
    } catch (err) {
      console.warn('[chat-view] Failed to copy message:', err);
      button.classList.add('is-copy-failed');
      button.innerHTML = messageCopyFailedSvg();
      button.title = 'Copy failed';
      button.setAttribute('aria-label', 'Copy message failed');
    }

    window.setTimeout(() => {
      button.disabled = false;
      button.classList.remove('is-copied', 'is-copy-failed');
      button.innerHTML = messageCopySvg();
      button.title = 'Copy message';
      button.setAttribute('aria-label', 'Copy message');
    }, 1400);
  }
}
