import {
  SANDBOX_PROXY_READY_METHOD,
  SANDBOX_RESOURCE_READY_METHOD,
  buildAllowAttribute,
  type McpUiResourceCsp,
  type McpUiSandboxResourceReadyNotification,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import {
  BROW_SANDBOX_FRAME_METRICS_EVENT,
  BROW_SANDBOX_RESOURCE_LOADED_EVENT,
  type SandboxedHtmlKeyboardPolicy,
} from './sandboxed-html';

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

let innerDocumentResizeObserver: ResizeObserver | null = null;
let awaitingInnerResourceLoad = false;
let activeKeyboardPolicy: SandboxedHtmlKeyboardPolicy = 'default';
let detachInnerKeyboardGuards: (() => void) | null = null;

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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

function shouldCaptureGameplayKey(event: KeyboardEvent, target: EventTarget | null): boolean {
  if (activeKeyboardPolicy !== 'capture-game-keys') return false;
  if (event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (isEditableTarget(target)) return false;

  return event.key === 'ArrowUp'
    || event.key === 'ArrowDown'
    || event.key === 'ArrowLeft'
    || event.key === 'ArrowRight'
    || event.key === ' '
    || event.code === 'Space';
}

function dispatchGameplayKeyToInner(event: KeyboardEvent): void {
  const doc = inner.contentDocument;
  if (!doc) return;

  const target = doc.activeElement instanceof EventTarget
    ? doc.activeElement
    : (doc.body ?? doc.documentElement);
  if (!(target instanceof EventTarget)) return;

  const forwarded = new KeyboardEvent(event.type, {
    key: event.key,
    code: event.code,
    location: event.location,
    repeat: event.repeat,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(forwarded);
}

function installInnerKeyboardGuards(): void {
  detachInnerKeyboardGuards?.();
  detachInnerKeyboardGuards = null;

  const doc = inner.contentDocument;
  if (!doc || activeKeyboardPolicy !== 'capture-game-keys') return;

  const preventGameplayScroll = (event: KeyboardEvent) => {
    if (!shouldCaptureGameplayKey(event, event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  doc.addEventListener('keydown', preventGameplayScroll, { capture: true });
  detachInnerKeyboardGuards = () => {
    doc.removeEventListener('keydown', preventGameplayScroll, { capture: true });
  };
}

function writeInnerHtml(
  html: string,
  csp?: McpUiResourceCsp,
  keyboardPolicy: SandboxedHtmlKeyboardPolicy = 'default',
): void {
  awaitingInnerResourceLoad = true;
  activeKeyboardPolicy = keyboardPolicy;
  inner.srcdoc = injectCsp(html, csp);
}

function focusInnerResource(): void {
  try {
    inner.focus({ preventScroll: true });
    inner.contentWindow?.focus();
    const doc = inner.contentDocument;
    if (!doc) return;
    const activeElement = doc.activeElement;
    if (activeElement && activeElement !== doc.body && activeElement !== doc.documentElement) return;

    const focusTarget = doc.body ?? doc.documentElement;
    if (focusTarget instanceof HTMLElement) {
      if (!focusTarget.hasAttribute('tabindex')) {
        focusTarget.tabIndex = -1;
      }
      focusTarget.focus({ preventScroll: true });
    }
  } catch {
    // Ignore focus failures while the inner frame is loading or reloading.
  }
}

function postInnerResourceLoaded(): void {
  window.parent.postMessage(
    { type: BROW_SANDBOX_RESOURCE_LOADED_EVENT, sessionId },
    parentTargetOrigin,
  );
}

function postInnerFrameHeight(): void {
  const doc = inner.contentDocument;
  if (!doc) return;
  const bodyHeight = doc.body?.scrollHeight ?? 0;
  const docHeight = doc.documentElement?.scrollHeight ?? 0;
  const height = Math.max(bodyHeight, docHeight, 240);
  window.parent.postMessage(
    { type: BROW_SANDBOX_FRAME_METRICS_EVENT, sessionId, height },
    parentTargetOrigin,
  );
}

function watchInnerFrameSize(): void {
  innerDocumentResizeObserver?.disconnect();
  innerDocumentResizeObserver = null;

  const doc = inner.contentDocument;
  if (!doc) return;

  const target = doc.documentElement ?? doc.body;
  if (target) {
    innerDocumentResizeObserver = new ResizeObserver(() => {
      postInnerFrameHeight();
    });
    innerDocumentResizeObserver.observe(target);
  }

  window.setTimeout(() => postInnerFrameHeight(), 0);
}

inner.addEventListener('load', () => {
  if (awaitingInnerResourceLoad) {
    awaitingInnerResourceLoad = false;
    postInnerResourceLoaded();
  }
  installInnerKeyboardGuards();
  watchInnerFrameSize();
});
inner.addEventListener('pointerdown', () => {
  window.setTimeout(() => focusInnerResource(), 0);
});
window.addEventListener('focus', () => {
  window.setTimeout(() => focusInnerResource(), 0);
});

window.addEventListener('message', (event) => {
  if (isExpectedParentMessage(event)) {
    const message = event.data;
    if (message?.method === SANDBOX_RESOURCE_READY_METHOD) {
      const params = (message as McpUiSandboxResourceReadyNotification).params as
        (McpUiSandboxResourceReadyNotification['params'] & {
          browKeyboardPolicy?: SandboxedHtmlKeyboardPolicy;
        });
      if (typeof params?.sandbox === 'string') {
        inner.setAttribute('sandbox', params.sandbox);
      }
      const allow = buildAllowAttribute(params?.permissions);
      if (allow) inner.setAttribute('allow', allow);
      if (typeof params?.html === 'string') {
        writeInnerHtml(params.html, params.csp, params.browKeyboardPolicy ?? 'default');
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

window.addEventListener('keydown', (event) => {
  if (!shouldCaptureGameplayKey(event, event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  focusInnerResource();
  dispatchGameplayKeyToInner(event);
}, { capture: true });

window.parent.postMessage(
  { jsonrpc: '2.0', method: SANDBOX_PROXY_READY_METHOD, params: {} },
  parentTargetOrigin,
);
