import type { MCPAppLoadedResource } from '../mcp-app-host';
import type { MCPAppRenderRequest } from '../mcp-client';

interface MCPAppViewModuleDeps {
  addSystemMessage: (text: string) => void;
  escapeHtml: (text: string) => string;
  requestScrollToBottom: () => void;
}

export class MCPAppViewModule {
  private readonly messagesContainer: HTMLElement;
  private readonly deps: MCPAppViewModuleDeps;

  constructor(messagesContainer: HTMLElement, deps: MCPAppViewModuleDeps) {
    this.messagesContainer = messagesContainer;
    this.deps = deps;
  }

  public renderLoading(request: MCPAppRenderRequest): HTMLElement {
    this.deps.addSystemMessage(`MCP App View requested: ${request.toolTitle ?? request.toolName}`);

    const wrapper = document.createElement('div');
    wrapper.className = 'mcp-app-container mcp-app-loading';
    wrapper.dataset.mcpAppId = request.id;
    wrapper.innerHTML = `
      <div class="mcp-app-card">
        ${this.renderHeader(request)}
        <div class="mcp-app-status">
          <span class="mcp-app-spinner" aria-hidden="true"></span>
          <span>Inspecting app resource...</span>
        </div>
      </div>`;
    this.messagesContainer.appendChild(wrapper);
    this.deps.requestScrollToBottom();
    return wrapper;
  }

  public renderApproval(
    container: HTMLElement,
    request: MCPAppRenderRequest,
    resource: MCPAppLoadedResource,
    callbacks: { onApprove: () => void; onSkip: () => void },
  ): void {
    container.className = 'mcp-app-container mcp-app-pending';
    container.innerHTML = `
      <div class="mcp-app-card">
        ${this.renderHeader(request)}
        <div class="mcp-app-meta-grid">
          <div><span>Server</span><strong>${this.deps.escapeHtml(request.server.name)}</strong></div>
          <div><span>Resource</span><strong>${this.deps.escapeHtml(resource.uri)}</strong></div>
          <div><span>Permissions</span><strong>${this.deps.escapeHtml(this.formatPermissions(resource.permissions))}</strong></div>
          <div><span>CSP</span><strong>${this.deps.escapeHtml(this.formatCsp(resource.csp))}</strong></div>
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
    this.deps.requestScrollToBottom();
  }

  public renderFrame(
    container: HTMLElement,
    request: MCPAppRenderRequest,
    resource: MCPAppLoadedResource,
  ): HTMLIFrameElement {
    container.className = `mcp-app-container mcp-app-live${resource.prefersBorder === false ? ' borderless' : ''}`;
    container.innerHTML = `
      <div class="mcp-app-live-header">
        ${this.renderTitle(request)}
        <span>${this.deps.escapeHtml(request.server.name)}</span>
      </div>
      <div class="mcp-app-frame-shell"></div>`;

    const iframe = document.createElement('iframe');
    iframe.className = 'mcp-app-iframe';
    iframe.title = `MCP App View: ${request.toolTitle ?? request.toolName}`;
    iframe.style.height = '260px';

    container.querySelector('.mcp-app-frame-shell')?.appendChild(iframe);
    this.deps.requestScrollToBottom();
    return iframe;
  }

  public resizeFrame(iframe: HTMLIFrameElement, height: number): void {
    iframe.style.height = `${height}px`;
    this.deps.requestScrollToBottom();
  }

  public renderError(
    container: HTMLElement,
    request: MCPAppRenderRequest,
    message: string,
  ): void {
    container.className = 'mcp-app-container mcp-app-error';
    container.innerHTML = `
      <div class="mcp-app-card">
        ${this.renderHeader(request)}
        <div class="mcp-app-error-text">${this.deps.escapeHtml(message)}</div>
      </div>`;
    this.deps.requestScrollToBottom();
  }

  public renderSkipped(container: HTMLElement, request: MCPAppRenderRequest): void {
    container.className = 'mcp-app-container mcp-app-skipped';
    container.innerHTML = `
      <div class="mcp-app-card">
        ${this.renderHeader(request)}
        <div class="mcp-app-status">Skipped. The app HTML was not rendered.</div>
      </div>`;
    this.deps.requestScrollToBottom();
  }

  private renderHeader(request: MCPAppRenderRequest): string {
    return `
      <div class="mcp-app-header">
        <div>
          ${this.renderTitle(request)}
          <p>${this.deps.escapeHtml(request.toolDescription || 'Interactive MCP App View')}</p>
        </div>
        <span>MCP App</span>
      </div>`;
  }

  private renderTitle(request: MCPAppRenderRequest): string {
    return `<strong>${this.deps.escapeHtml(request.toolTitle ?? request.toolName)}</strong>`;
  }

  private formatPermissions(permissions: MCPAppLoadedResource['permissions']): string {
    if (!permissions) return 'None requested';
    const entries: string[] = [];
    if (permissions.camera) entries.push('camera');
    if (permissions.microphone) entries.push('microphone');
    if (permissions.geolocation) entries.push('location');
    if (permissions.clipboardWrite) entries.push('clipboard write');
    return entries.length > 0 ? entries.join(', ') : 'None requested';
  }

  private formatCsp(csp: MCPAppLoadedResource['csp']): string {
    if (!csp) return 'No external domains';
    const parts: string[] = [];
    if (csp.connectDomains?.length) parts.push(`connect ${csp.connectDomains.length}`);
    if (csp.resourceDomains?.length) parts.push(`resource ${csp.resourceDomains.length}`);
    if (csp.frameDomains?.length) parts.push(`frame ${csp.frameDomains.length}`);
    return parts.length > 0 ? parts.join(' / ') : 'No external domains';
  }
}
