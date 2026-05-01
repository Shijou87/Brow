import {
  SANDBOX_PROXY_READY_METHOD,
  SANDBOX_RESOURCE_READY_METHOD,
  buildAllowAttribute,
  type McpUiResourceCsp,
  type McpUiSandboxResourceReadyNotification,
} from '@modelcontextprotocol/ext-apps/app-bridge';

const sessionId = new URLSearchParams(window.location.search).get('session');

if (window.self === window.top) {
  throw new Error('MCP App sandbox must be embedded in an iframe.');
}

if (!sessionId) {
  throw new Error('Missing MCP App sandbox session.');
}

const expectedParentOrigin = (() => {
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
})();

const parentTargetOrigin = expectedParentOrigin ?? '*';

const inner = document.createElement('iframe');
inner.className = 'mcp-app-inner-frame';
inner.title = 'MCP App View';
inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
document.body.appendChild(inner);

function isExpectedParentMessage(event: MessageEvent): boolean {
  if (event.source !== window.parent) return false;
  if (expectedParentOrigin && event.origin !== expectedParentOrigin) return false;
  return true;
}

function getDomains(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).join(' ')
    : '';
}

function buildCspValue(csp?: McpUiResourceCsp): string {
  const resourceDomains = getDomains(csp?.resourceDomains);
  const connectDomains = getDomains(csp?.connectDomains);
  const frameDomains = getDomains(csp?.frameDomains);
  const baseUriDomains = getDomains(csp?.baseUriDomains);

  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `style-src 'self' 'unsafe-inline'${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `connect-src 'self'${connectDomains ? ` ${connectDomains}` : ''}`,
    `img-src 'self' data:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `font-src 'self'${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `media-src 'self' data:${resourceDomains ? ` ${resourceDomains}` : ''}`,
    `frame-src ${frameDomains || "'none'"}`,
    "object-src 'none'",
    `base-uri ${baseUriDomains || "'self'"}`,
  ].join('; ');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function injectCsp(html: string, csp?: McpUiResourceCsp): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(buildCspValue(csp))}">`;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${meta}`);
  }
  if (/<html(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<html(\s[^>]*)?>/i, (match) => `${match}<head>${meta}</head>`);
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

function writeInnerHtml(html: string, csp?: McpUiResourceCsp): void {
  inner.srcdoc = injectCsp(html, csp);
}

window.addEventListener('message', (event) => {
  if (isExpectedParentMessage(event)) {
    const message = event.data;
    if (message?.method === SANDBOX_RESOURCE_READY_METHOD) {
      const params = (message as McpUiSandboxResourceReadyNotification).params;
      if (typeof params?.sandbox === 'string') {
        inner.setAttribute('sandbox', params.sandbox);
      }
      const allow = buildAllowAttribute(params?.permissions);
      if (allow) inner.setAttribute('allow', allow);
      if (typeof params?.html === 'string') {
        writeInnerHtml(params.html, params.csp);
      }
      return;
    }

    inner.contentWindow?.postMessage(message, '*');
    return;
  }

  if (event.source === inner.contentWindow) {
    window.parent.postMessage(event.data, parentTargetOrigin);
  }
});

window.parent.postMessage(
  { jsonrpc: '2.0', method: SANDBOX_PROXY_READY_METHOD, params: {} },
  parentTargetOrigin,
);
