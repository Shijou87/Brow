import type {
  HtmlAppArtifact,
  HtmlAppArtifactMessageRef,
  HtmlAppArtifactRevision,
  HtmlAppRenderRequest,
} from '../../shared/types';

type ResolvedHtmlAppArtifact = {
  conversationId: string | null;
  artifact: HtmlAppArtifact;
  revision: HtmlAppArtifactRevision;
};

interface HtmlAppViewModuleDeps {
  escapeHtml: (text: string) => string;
  requestScrollToBottom: () => void;
  resolveArtifactRef: (
    ref: HtmlAppArtifactMessageRef,
    options?: { preferLatest?: boolean },
  ) => ResolvedHtmlAppArtifact | null;
  onOpenInline: (ref: HtmlAppArtifactMessageRef, container: HTMLElement) => void;
  onOpenTab: (ref: HtmlAppArtifactMessageRef) => void;
  onDownload: (ref: HtmlAppArtifactMessageRef) => void;
}

export class HtmlAppViewModule {
  private readonly deps: HtmlAppViewModuleDeps;

  constructor(deps: HtmlAppViewModuleDeps) {
    this.deps = deps;
  }

  public createArtifactMessageCard(ref: HtmlAppArtifactMessageRef): HTMLElement {
    const container = document.createElement('div');
    container.className = 'html-app-container html-app-placeholder';
    container.dataset.htmlAppArtifactId = ref.artifactId;
    container.dataset.htmlAppRevisionId = ref.revisionId;

    const resolved = this.deps.resolveArtifactRef(ref, { preferLatest: true });
    if (!resolved) {
      container.innerHTML = `
        <div class="html-app-card">
          <div class="html-app-header">
            <div>
              <strong>HTML App Artifact unavailable</strong>
              <p>The saved artifact could not be resolved from this conversation.</p>
            </div>
            <span>HTML App</span>
          </div>
        </div>`;
      return container;
    }

    this.renderArtifactPlaceholder(container, resolved, {
      statusText: 'Saved artifact. Choose how to reopen it.',
      openTabLabel: 'Open in dedicated tab',
    });
    return container;
  }

  public renderApproval(
    container: HTMLElement,
    request: HtmlAppRenderRequest,
    callbacks: {
      onRenderInline: (options: { alwaysAllow: boolean }) => void;
      onOpenTab: (options: { alwaysAllow: boolean }) => void;
      onRenderBoth: (options: { alwaysAllow: boolean }) => void;
      onSkip: () => void;
    },
    options: {
      showAlwaysAllowToggle?: boolean;
    } = {},
  ): void {
    container.className = 'html-app-container html-app-pending';
    container.dataset.htmlAppArtifactId = request.artifactId;
    container.dataset.htmlAppRevisionId = request.revisionId;
    container.innerHTML = `
      <div class="html-app-card">
        ${this.renderHeader(request.title, request.summary, 'HTML App')}
        <div class="html-app-meta-grid">
          <div><span>Render Hint</span><strong>${this.deps.escapeHtml(request.renderTargetHint)}</strong></div>
          <div><span>Network</span><strong>No external network</strong></div>
          <div><span>Format</span><strong>Single self-contained HTML document</strong></div>
          <div><span>Revision</span><strong>${this.deps.escapeHtml(request.revisionId)}</strong></div>
        </div>
        ${options.showAlwaysAllowToggle ? `
          <label class="html-app-remember-choice">
            <input type="checkbox" data-action="always-allow">
            <span>
              <strong>Always allow future HTML apps on this device</strong>
              <small>Future HTML App Artifacts will render inline automatically after you accept the risk once.</small>
            </span>
          </label>` : ''}
        <div class="html-app-actions">
          <button class="html-app-primary-btn" type="button" data-action="render-inline">Render Inline</button>
          <button class="html-app-secondary-btn" type="button" data-action="open-tab">Open Tab</button>
          <button class="html-app-secondary-btn" type="button" data-action="render-both">Render Both</button>
          <button class="html-app-skip-btn" type="button" data-action="skip">Skip</button>
        </div>
      </div>`;

    const getDecisionOptions = () => ({
      alwaysAllow: container.querySelector<HTMLInputElement>('[data-action="always-allow"]')?.checked === true,
    });

    container.querySelector<HTMLButtonElement>('[data-action="render-inline"]')?.addEventListener('click', () => {
      callbacks.onRenderInline(getDecisionOptions());
    });
    container.querySelector<HTMLButtonElement>('[data-action="open-tab"]')?.addEventListener('click', () => {
      callbacks.onOpenTab(getDecisionOptions());
    });
    container.querySelector<HTMLButtonElement>('[data-action="render-both"]')?.addEventListener('click', () => {
      callbacks.onRenderBoth(getDecisionOptions());
    });
    container.querySelector<HTMLButtonElement>('[data-action="skip"]')?.addEventListener('click', callbacks.onSkip);
    this.deps.requestScrollToBottom();
  }

  public renderFrame(container: HTMLElement, request: HtmlAppRenderRequest): HTMLIFrameElement {
    const ref = { artifactId: request.artifactId, revisionId: request.revisionId };
    container.className = 'html-app-container html-app-live';
    container.dataset.htmlAppArtifactId = request.artifactId;
    container.dataset.htmlAppRevisionId = request.revisionId;
    container.innerHTML = `
      <div class="html-app-live-header">
        <div class="html-app-live-title">
          <strong>${this.deps.escapeHtml(request.title)}</strong>
          <span>${this.deps.escapeHtml(request.renderTargetHint)}</span>
        </div>
        <div class="html-app-live-actions">
          <button type="button" data-action="open-tab">Open in dedicated tab</button>
          <button type="button" data-action="download-html">Download HTML</button>
        </div>
      </div>
      <div class="html-app-frame-shell"></div>`;

    container.querySelector<HTMLButtonElement>('[data-action="open-tab"]')?.addEventListener('click', () => {
      this.deps.onOpenTab(ref);
    });
    container.querySelector<HTMLButtonElement>('[data-action="download-html"]')?.addEventListener('click', () => {
      this.deps.onDownload(ref);
    });

    const iframe = document.createElement('iframe');
    iframe.className = 'html-app-iframe';
    iframe.title = `HTML App Artifact: ${request.title}`;
    iframe.style.height = '420px';
    container.querySelector('.html-app-frame-shell')?.appendChild(iframe);
    this.deps.requestScrollToBottom();
    return iframe;
  }

  public resizeFrame(iframe: HTMLIFrameElement, height: number): void {
    iframe.style.height = `${height}px`;
    this.deps.requestScrollToBottom();
  }

  public renderOpened(container: HTMLElement, request: HtmlAppRenderRequest): void {
    const resolved = this.deps.resolveArtifactRef(
      { artifactId: request.artifactId, revisionId: request.revisionId },
      { preferLatest: true },
    );
    if (!resolved) {
      this.renderError(container, request.title, 'The HTML App Artifact could not be reopened.');
      return;
    }

    this.renderArtifactPlaceholder(container, resolved, {
      statusText: 'Opened in a dedicated tab.',
      openTabLabel: 'Open again',
    });
  }

  public renderSkipped(container: HTMLElement, request: HtmlAppRenderRequest): void {
    const resolved = this.deps.resolveArtifactRef(
      { artifactId: request.artifactId, revisionId: request.revisionId },
      { preferLatest: true },
    );
    if (!resolved) {
      this.renderError(container, request.title, 'The HTML App Artifact was skipped.');
      return;
    }

    this.renderArtifactPlaceholder(container, resolved, {
      statusText: 'Skipped. The HTML was saved but not executed.',
      openTabLabel: 'Open in dedicated tab',
    });
  }

  public renderError(container: HTMLElement, title: string, message: string): void {
    container.className = 'html-app-container html-app-error';
    container.innerHTML = `
      <div class="html-app-card">
        ${this.renderHeader(title, 'HTML App Artifact', 'HTML App')}
        <div class="html-app-error-text">${this.deps.escapeHtml(message)}</div>
      </div>`;
    this.deps.requestScrollToBottom();
  }

  private renderArtifactPlaceholder(
    container: HTMLElement,
    resolved: ResolvedHtmlAppArtifact,
    options: { statusText: string; openTabLabel: string },
  ): void {
    const ref = {
      artifactId: resolved.artifact.id,
      revisionId: resolved.revision.id,
    };

    container.className = 'html-app-container html-app-placeholder';
    container.dataset.htmlAppArtifactId = resolved.artifact.id;
    container.dataset.htmlAppRevisionId = resolved.revision.id;
    container.innerHTML = `
      <div class="html-app-card">
        ${this.renderHeader(resolved.revision.title, resolved.revision.summary, 'HTML App')}
        <div class="html-app-meta-grid">
          <div><span>Revision</span><strong>${this.deps.escapeHtml(resolved.revision.id)}</strong></div>
          <div><span>Latest</span><strong>${this.deps.escapeHtml(resolved.artifact.latestRevisionId)}</strong></div>
          <div><span>Render Hint</span><strong>${this.deps.escapeHtml(resolved.revision.renderTargetHint)}</strong></div>
          <div><span>Status</span><strong>${this.deps.escapeHtml(options.statusText)}</strong></div>
        </div>
        <div class="html-app-actions">
          <button class="html-app-primary-btn" type="button" data-action="render-inline">Render Inline</button>
          <button class="html-app-secondary-btn" type="button" data-action="open-tab">${this.deps.escapeHtml(options.openTabLabel)}</button>
          <button class="html-app-skip-btn" type="button" data-action="download-html">Download HTML</button>
        </div>
      </div>`;

    container.querySelector<HTMLButtonElement>('[data-action="render-inline"]')?.addEventListener('click', () => {
      this.deps.onOpenInline(ref, container);
    });
    container.querySelector<HTMLButtonElement>('[data-action="open-tab"]')?.addEventListener('click', () => {
      this.deps.onOpenTab(ref);
    });
    container.querySelector<HTMLButtonElement>('[data-action="download-html"]')?.addEventListener('click', () => {
      this.deps.onDownload(ref);
    });
    this.deps.requestScrollToBottom();
  }

  private renderHeader(title: string, subtitle: string | undefined, badge: string): string {
    return `
      <div class="html-app-header">
        <div>
          <strong>${this.deps.escapeHtml(title)}</strong>
          <p>${this.deps.escapeHtml(subtitle || 'Self-contained HTML App Artifact')}</p>
        </div>
        <span>${this.deps.escapeHtml(badge)}</span>
      </div>`;
  }
}
