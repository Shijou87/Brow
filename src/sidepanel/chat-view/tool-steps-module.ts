import {
  approvalSvg,
  checkSvg,
  chevronSvg,
  errorSvg,
  spinnerSvg,
} from './icons';
import type { AutomationApprovalDecision, ToolStepEvent } from '../agent';

export interface ToolStepsModuleDeps {
  escapeHtml: (text: string) => string;
  getStreamingElement: () => HTMLElement | null;
  onAutomationApprovalDecision: (requestId: string, decision: AutomationApprovalDecision) => void;
  requestScrollToBottom: () => void;
}

export class ToolStepsModule {
  private readonly messagesContainer: HTMLElement;
  private readonly deps: ToolStepsModuleDeps;

  private currentToolStepsContainer: HTMLElement | null = null;
  private toolStepsCollapsed = false;
  private expandedToolStepDetails = new Set<number>();

  constructor(messagesContainer: HTMLElement, deps: ToolStepsModuleDeps) {
    this.messagesContainer = messagesContainer;
    this.deps = deps;
  }

  public clear(): void {
    this.currentToolStepsContainer = null;
    this.toolStepsCollapsed = false;
    this.expandedToolStepDetails.clear();
  }

  public update(steps: ToolStepEvent[]): void {
    if (steps.length === 0) return;

    this.ensureTrackerPlacement();

    const totalSteps = steps.length;
    const finishedSteps = steps.filter((s) => this.isToolStepFinished(s)).length;
    const errorSteps = steps.filter((s) => s.status === 'error').length;
    const allFinished = finishedSteps === totalSteps;
    const allSuccessful = allFinished && errorSteps === 0;
    const totalDuration = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
    const durationStr = (totalDuration / 1000).toFixed(1) + 's';

    const statusIcon = !allFinished ? spinnerSvg() : errorSteps > 0 ? errorSvg() : checkSvg();
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
    const chevronIcon = chevronSvg(!this.toolStepsCollapsed);

    if (!this.currentToolStepsContainer) return;
    this.currentToolStepsContainer.innerHTML = `
      <div class="tool-steps-header">
        <div class="tool-steps-header-left">
          ${statusIcon}
          <span class="tool-steps-header-text">${headerText}</span>
        </div>
        <div class="tool-steps-header-right">
          <span class="tool-steps-count">${countText}</span>
          ${chevronIcon}
        </div>
      </div>
      <div class="tool-steps-body ${this.toolStepsCollapsed ? 'collapsed' : ''}">
        <div class="tool-steps-timeline">
          ${stepsHtml}
        </div>
        <div class="tool-steps-toggle">${this.toolStepsCollapsed ? 'Show details' : 'Hide details'} ${chevronIcon}</div>
      </div>
    `;

    this.bindLiveInteractions(steps);
    this.scrollTimelineToBottom();
    this.deps.requestScrollToBottom();
  }

  public finalize(): void {
    if (this.currentToolStepsContainer) {
      const finalized = this.currentToolStepsContainer.cloneNode(true) as HTMLElement;
      finalized.classList.add('finalized');
      this.bindStaticInteractions(finalized);
      this.currentToolStepsContainer.replaceWith(finalized);
    }
    this.currentToolStepsContainer = null;
    this.toolStepsCollapsed = false;
    this.expandedToolStepDetails.clear();
  }

  private ensureTrackerPlacement(): void {
    if (!this.currentToolStepsContainer) {
      this.currentToolStepsContainer = document.createElement('div');
      this.currentToolStepsContainer.className = 'tool-steps-tracker';
      const streamingElement = this.deps.getStreamingElement();
      if (streamingElement && streamingElement.parentNode === this.messagesContainer) {
        this.messagesContainer.insertBefore(this.currentToolStepsContainer, streamingElement);
      } else {
        this.messagesContainer.appendChild(this.currentToolStepsContainer);
      }
      return;
    }

    const streamingElement = this.deps.getStreamingElement();
    if (streamingElement && streamingElement.parentNode === this.messagesContainer) {
      const trackerIndex = Array.from(this.messagesContainer.children).indexOf(this.currentToolStepsContainer);
      const bubbleIndex = Array.from(this.messagesContainer.children).indexOf(streamingElement);
      if (trackerIndex > bubbleIndex) {
        this.messagesContainer.insertBefore(this.currentToolStepsContainer, streamingElement);
      }
    }
  }

  private bindLiveInteractions(steps: ToolStepEvent[]): void {
    if (!this.currentToolStepsContainer) return;

    const header = this.currentToolStepsContainer.querySelector('.tool-steps-header');
    const toggleBtn = this.currentToolStepsContainer.querySelector('.tool-steps-toggle');
    const toggleFn = () => {
      this.toolStepsCollapsed = !this.toolStepsCollapsed;
      this.update(steps);
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
        this.update(steps);
      });
    });

    this.currentToolStepsContainer.querySelectorAll<HTMLButtonElement>('[data-approval-action]').forEach((button) => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const requestId = button.dataset.approvalRequestId;
        const action = button.dataset.approvalAction as AutomationApprovalDecision | undefined;
        if (!requestId || !action) return;
        this.deps.onAutomationApprovalDecision(requestId, action);
      });
    });
  }

  private bindStaticInteractions(container: HTMLElement): void {
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
        toggleBtn.innerHTML = `${collapsed ? 'Show details' : 'Hide details'} ${chevronSvg(!collapsed)}`;
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
        button.innerHTML = `${nextExpanded ? 'Hide raw details' : 'Show raw details'} ${chevronSvg(nextExpanded, 'tool-step-detail-chevron')}`;
      });
    });

    renderHeader();
  }

  private renderToolStepItem(step: ToolStepEvent): string {
    const stepIcon = step.status === 'error'
      ? errorSvg()
      : step.status === 'completed'
        ? checkSvg()
        : step.status === 'awaiting_approval'
          ? approvalSvg()
          : spinnerSvg();
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
          <span class="tool-step-label">${this.deps.escapeHtml(step.label)}</span>
          ${description ? `<span class="tool-step-description ${step.status === 'error' ? 'error' : step.status === 'awaiting_approval' ? 'approval' : ''}">${this.deps.escapeHtml(description)}</span>` : ''}
          ${step.status === 'awaiting_approval' && step.approvalRequestId ? this.renderApprovalActions(step.approvalRequestId) : ''}
          ${hasDetails ? `
            <button class="tool-step-detail-toggle" type="button" data-step-toggle="${step.stepIndex}" aria-expanded="${detailsExpanded ? 'true' : 'false'}">
              ${detailsExpanded ? 'Hide raw details' : 'Show raw details'} ${chevronSvg(detailsExpanded, 'tool-step-detail-chevron')}
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
        <span class="tool-step-detail-label">${this.deps.escapeHtml(label)}</span>
        <pre class="tool-step-detail-content">${this.deps.escapeHtml(text)}</pre>
      </div>
    `;
  }

  private renderApprovalActions(requestId: string): string {
    return `
      <div class="tool-step-approval-actions">
        <button class="tool-step-approval-btn allow" type="button" data-approval-action="allow" data-approval-request-id="${this.deps.escapeHtml(requestId)}">Allow</button>
        <button class="tool-step-approval-btn allow-all" type="button" data-approval-action="allow_all" data-approval-request-id="${this.deps.escapeHtml(requestId)}">Allow All Session</button>
        <button class="tool-step-approval-btn skip" type="button" data-approval-action="skip" data-approval-request-id="${this.deps.escapeHtml(requestId)}">Skip</button>
      </div>
    `;
  }

  private isToolStepFinished(step: ToolStepEvent): boolean {
    return step.status === 'completed' || step.status === 'error';
  }

  private scrollTimelineToBottom(): void {
    requestAnimationFrame(() => {
      const timeline = this.currentToolStepsContainer?.querySelector('.tool-steps-timeline');
      if (timeline instanceof HTMLElement) {
        timeline.scrollTop = timeline.scrollHeight;
      }
    });
  }
}
