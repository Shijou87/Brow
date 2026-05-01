import {
  AppBridge,
  PostMessageTransport,
  RESOURCE_MIME_TYPE,
  type McpUiHostCapabilities,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  isToolVisibleToApp,
  mcpCallTool,
  mcpListResourceTemplates,
  mcpListResources,
  mcpReadResource,
  type MCPAppRenderRequest,
  type MCPToolDescriptor,
} from './mcp-client';

const INNER_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms';
const MIN_APP_HEIGHT = 240;
const MAX_APP_HEIGHT = 720;

type ResourceContent = {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
};

export interface MCPAppLoadedResource {
  uri: string;
  mimeType: string;
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  prefersBorder?: boolean;
}

export interface MCPAppMountOptions {
  onSizeChange?: (height: number) => void;
  onLog?: (message: string) => void;
  onError?: (message: string) => void;
}

type MountedMCPApp = {
  bridge: AppBridge;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function normalizeMimeType(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s*;\s*/g, ';');
}

function decodeHtmlBlob(blob: string): string {
  const binary = atob(blob);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function stringifyForToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toCallToolResult(value: unknown): CallToolResult {
  if (isRecord(value) && Array.isArray(value.content)) {
    return value as unknown as CallToolResult;
  }

  return {
    content: [{ type: 'text', text: stringifyForToolResult(value) }],
  } as CallToolResult;
}

function toToolDefinition(descriptor: MCPToolDescriptor): Tool {
  const inputSchema = isRecord(descriptor.inputSchema)
    ? descriptor.inputSchema
    : { type: 'object', properties: {} };

  const toolDef: Record<string, unknown> = {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema,
  };

  if (descriptor.title) toolDef.title = descriptor.title;
  if (descriptor.outputSchema) toolDef.outputSchema = descriptor.outputSchema;
  if (descriptor.annotations) toolDef.annotations = descriptor.annotations;
  if (descriptor._meta) toolDef._meta = descriptor._meta;

  return toolDef as Tool;
}

function createHostCapabilities(resource: MCPAppLoadedResource): McpUiHostCapabilities {
  return {
    serverTools: {},
    serverResources: {},
    logging: {},
    sandbox: {
      csp: resource.csp,
      permissions: resource.permissions,
    },
  };
}

function createHostContext(
  request: MCPAppRenderRequest,
  resource: MCPAppLoadedResource,
): McpUiHostContext {
  return {
    toolInfo: {
      tool: toToolDefinition(request.descriptor),
    },
    theme: 'dark',
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
    containerDimensions: {
      maxWidth: 760,
      maxHeight: MAX_APP_HEIGHT,
    },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: navigator.userAgent,
    platform: 'web',
    deviceCapabilities: {
      touch: navigator.maxTouchPoints > 0,
      hover: matchMedia('(hover: hover)').matches,
    },
    ...(resource.prefersBorder === false ? { displayMode: 'inline' as const } : {}),
  };
}

function extractResource(result: unknown, expectedUri: string): ResourceContent {
  const contents = Array.isArray((result as any)?.contents)
    ? ((result as any).contents as ResourceContent[])
    : [];
  const content = contents.find((entry) => entry.uri === expectedUri) ?? contents[0];
  if (!content) {
    throw new Error(`UI resource ${expectedUri} was not returned by resources/read.`);
  }
  return content;
}

function extractLoadedResource(result: unknown, expectedUri: string): MCPAppLoadedResource {
  const content = extractResource(result, expectedUri);
  const mimeType = normalizeMimeType(content.mimeType);
  if (mimeType !== RESOURCE_MIME_TYPE) {
    throw new Error(`UI resource ${expectedUri} returned "${content.mimeType ?? 'missing MIME type'}"; expected ${RESOURCE_MIME_TYPE}.`);
  }

  const html = typeof content.text === 'string'
    ? content.text
    : typeof content.blob === 'string'
      ? decodeHtmlBlob(content.blob)
      : undefined;

  if (!html) {
    throw new Error(`UI resource ${expectedUri} did not include text or blob HTML content.`);
  }

  const meta = optionalRecord(content._meta);
  const nestedUiMeta = optionalRecord(meta?.ui);
  const resourceMeta = {
    ...nestedUiMeta,
    ...meta,
  };

  return {
    uri: content.uri ?? expectedUri,
    mimeType,
    html,
    csp: optionalRecord(resourceMeta.csp) as McpUiResourceCsp | undefined,
    permissions: optionalRecord(resourceMeta.permissions) as McpUiResourcePermissions | undefined,
    prefersBorder: typeof resourceMeta.prefersBorder === 'boolean' ? resourceMeta.prefersBorder : undefined,
  };
}

function findAppCallableTool(request: MCPAppRenderRequest, toolName: string): MCPToolDescriptor {
  const descriptor =
    request.serverTools.find((toolDescriptor) => toolDescriptor.name === toolName)
    ?? request.serverTools.find((toolDescriptor) =>
      toolName.startsWith(`${toolDescriptor.name}-`) && isToolVisibleToApp(toolDescriptor),
    );
  if (!descriptor) {
    throw new Error(`Tool ${toolName} is not registered on MCP server ${request.server.name}.`);
  }
  if (!isToolVisibleToApp(descriptor)) {
    throw new Error(`Tool ${toolName} is not visible to MCP App views.`);
  }
  return descriptor;
}

function collectApprovedAppToolNames(value: unknown, tools = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectApprovedAppToolNames(entry, tools);
    return tools;
  }

  if (!isRecord(value)) return tools;

  if (value.action === 'toolCall' && typeof value.tool === 'string') {
    tools.add(value.tool);
  }

  for (const child of Object.values(value)) {
    collectApprovedAppToolNames(child, tools);
  }
  return tools;
}

function assertAppCanCallTool(request: MCPAppRenderRequest, toolName: string): void {
  const approvedNames = collectApprovedAppToolNames(request.result);
  if (approvedNames.has(toolName)) return;
  findAppCallableTool(request, toolName);
}

function clampAppHeight(height: number): number {
  return Math.max(MIN_APP_HEIGHT, Math.min(Math.ceil(height), MAX_APP_HEIGHT));
}

export class MCPAppHost {
  private mountedApps = new Map<string, MountedMCPApp>();

  async loadResource(request: MCPAppRenderRequest): Promise<MCPAppLoadedResource> {
    if (!request.resourceUri.startsWith('ui://')) {
      throw new Error(`Invalid MCP App resource URI: ${request.resourceUri}`);
    }
    const result = await mcpReadResource(request.server, request.resourceUri);
    return extractLoadedResource(result, request.resourceUri);
  }

  async mount(
    request: MCPAppRenderRequest,
    iframe: HTMLIFrameElement,
    sandboxUrl: string,
    resource: MCPAppLoadedResource,
    options: MCPAppMountOptions = {},
  ): Promise<void> {
    const existing = this.mountedApps.get(request.id);
    if (existing) void existing.bridge.close();

    if (!iframe.contentWindow) {
      throw new Error('MCP App iframe was not ready to receive messages.');
    }

    const bridge = new AppBridge(
      null,
      { name: 'Brow', version: '1.0.0', title: 'Brow' },
      createHostCapabilities(resource),
      { hostContext: createHostContext(request, resource) },
    );

    let sandboxReady = false;
    let appInitialized = false;
    const startupTimer = window.setTimeout(() => {
      if (!sandboxReady) {
        options.onError?.('MCP App sandbox did not signal readiness.');
      } else if (!appInitialized) {
        options.onError?.('MCP App HTML loaded, but the app did not initialize. Check the app resource CSP and browser console for blocked scripts.');
      }
    }, 10000);

    bridge.onsandboxready = () => {
      sandboxReady = true;
      void bridge.sendSandboxResourceReady({
        html: resource.html,
        sandbox: INNER_IFRAME_SANDBOX,
        csp: resource.csp,
        permissions: resource.permissions,
      });
    };

    bridge.oninitialized = () => {
      appInitialized = true;
      window.clearTimeout(startupTimer);
      void bridge.sendToolInput({ arguments: request.arguments });
      void bridge.sendToolResult(toCallToolResult(request.result));
    };

    bridge.oncalltool = async (params) => {
      assertAppCanCallTool(request, params.name);
      const args = isRecord(params.arguments) ? params.arguments : {};
      const result = await mcpCallTool(request.server, params.name, args);
      return toCallToolResult(result);
    };

    bridge.onreadresource = async (params) => {
      return await mcpReadResource(request.server, params.uri) as any;
    };

    bridge.onlistresources = async (params) => {
      return await mcpListResources(request.server, params ?? {}) as any;
    };

    bridge.onlistresourcetemplates = async (params) => {
      return await mcpListResourceTemplates(request.server, params ?? {}) as any;
    };

    bridge.onsizechange = (params) => {
      if (typeof params.height === 'number') {
        options.onSizeChange?.(clampAppHeight(params.height));
      }
    };

    bridge.onloggingmessage = (params) => {
      options.onLog?.(`[${params.level}] ${stringifyForToolResult(params.data)}`);
    };

    const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
    await bridge.connect(transport);
    this.mountedApps.set(request.id, { bridge });
    iframe.src = sandboxUrl;
  }

  teardown(id: string): void {
    const mounted = this.mountedApps.get(id);
    if (!mounted) return;
    this.mountedApps.delete(id);
    void mounted.bridge.close();
  }

  teardownAll(): void {
    for (const id of [...this.mountedApps.keys()]) {
      this.teardown(id);
    }
  }
}
