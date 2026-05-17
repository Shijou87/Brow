import {
  SANDBOX_PROXY_READY_METHOD,
  SANDBOX_RESOURCE_READY_METHOD,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
  type McpUiSandboxResourceReadyNotification,
} from '@modelcontextprotocol/ext-apps/app-bridge';

export const DEFAULT_SANDBOXED_HTML_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms';
export const BROW_SANDBOX_FRAME_METRICS_EVENT = 'brow:sandbox-frame-metrics';
export const BROW_SANDBOX_RESOURCE_LOADED_EVENT = 'brow:sandbox-resource-loaded';
export type SandboxedHtmlKeyboardPolicy = 'default' | 'capture-game-keys';

export interface SandboxedHtmlResource {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  prefersBorder?: boolean;
  sandbox?: string;
  keyboardPolicy?: SandboxedHtmlKeyboardPolicy;
}

export interface BrowSandboxFrameMetricsMessage {
  type: typeof BROW_SANDBOX_FRAME_METRICS_EVENT;
  sessionId: string;
  height: number;
}

export interface BrowSandboxResourceLoadedMessage {
  type: typeof BROW_SANDBOX_RESOURCE_LOADED_EVENT;
  sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createLockedDownHtmlResource(html: string): SandboxedHtmlResource {
  return {
    html,
    sandbox: DEFAULT_SANDBOXED_HTML_IFRAME_SANDBOX,
    keyboardPolicy: 'capture-game-keys',
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
  };
}

export function createSandboxedHtmlReadyMessage(
  resource: SandboxedHtmlResource,
): McpUiSandboxResourceReadyNotification {
  return {
    method: SANDBOX_RESOURCE_READY_METHOD,
    params: {
      html: resource.html,
      sandbox: resource.sandbox ?? DEFAULT_SANDBOXED_HTML_IFRAME_SANDBOX,
      csp: resource.csp,
      permissions: resource.permissions,
      ...(resource.keyboardPolicy ? { browKeyboardPolicy: resource.keyboardPolicy } : {}),
    } as McpUiSandboxResourceReadyNotification['params'],
  };
}

export function isSandboxProxyReadyMessage(data: unknown): data is { method: typeof SANDBOX_PROXY_READY_METHOD } {
  return isRecord(data) && data.method === SANDBOX_PROXY_READY_METHOD;
}

export function isSandboxFrameMetricsMessage(data: unknown): data is BrowSandboxFrameMetricsMessage {
  return isRecord(data)
    && data.type === BROW_SANDBOX_FRAME_METRICS_EVENT
    && typeof data.sessionId === 'string'
    && typeof data.height === 'number';
}

export function isSandboxResourceLoadedMessage(data: unknown): data is BrowSandboxResourceLoadedMessage {
  return isRecord(data)
    && data.type === BROW_SANDBOX_RESOURCE_LOADED_EVENT
    && typeof data.sessionId === 'string';
}

export function clampSandboxedHtmlHeight(height: number, min = 240, max = 720): number {
  return Math.max(min, Math.min(Math.ceil(height), max));
}
