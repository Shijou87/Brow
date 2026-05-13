import type { StructuredToolInterface } from '@langchain/core/tools';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import {
  getMCPToolUIResourceUri,
  getMCPToolVisibility,
  isToolVisibleToModel,
  type MCPAppVisibility,
  type MCPToolDescriptor,
} from '../mcp-client';
import type { WebMCPToolDescriptor } from '../../shared/types';

export type ToolManifestSource = 'builtin' | 'webmcp' | 'mcp';

export interface ToolManifestEntry {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  source: ToolManifestSource;
  sourceLabel: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  visibility?: MCPAppVisibility[];
  resourceUri?: string;
}

export interface WebMCPToolState {
  descriptors: WebMCPToolDescriptor[];
  tools: StructuredToolInterface[];
  url?: string;
  title?: string;
}

export interface MCPToolState {
  id: string;
  name: string;
  url: string;
  authToken?: string;
  sessionId?: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  tools: MCPToolDescriptor[];
  langchainTools: StructuredToolInterface[];
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isZodLikeSchema(value: unknown): boolean {
  return isRecord(value)
    && (typeof value.safeParse === 'function' || isRecord(value._def));
}

function normalizeToolInputSchema(value: unknown): Record<string, unknown> | undefined {
  if (isZodLikeSchema(value)) {
    try {
      const converted = toJsonSchema(value as any);
      return isRecord(converted) ? converted : undefined;
    } catch {
      return undefined;
    }
  }

  if (isRecord(value)) return value;
  if (typeof value !== 'string') return undefined;

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const TOOL_DISPLAY_LABELS: Record<string, string> = {
  tabs_list: 'Listing tabs',
  list_tabs: 'Listing tabs',
  tabs_getActive: 'Getting active tab',
  get_active_tab: 'Getting active tab',
  tabs_getContent: 'Reading tab content',
  get_content: 'Reading tab content',
  tabs_listInteractiveElements: 'Inspecting page elements',
  list_interactive_elements: 'Inspecting page elements',
  tabs_highlight: 'Highlighting page element',
  highlight: 'Highlighting page element',
  highlight_element: 'Highlighting page element',
  tabs_hover: 'Hovering page element',
  hover: 'Hovering page element',
  hover_element: 'Hovering page element',
  tabs_click: 'Clicking page element',
  click: 'Clicking page element',
  click_element: 'Clicking page element',
  tabs_type: 'Typing into page element',
  type: 'Typing into page element',
  type_text: 'Typing into page element',
  tabs_fillForm: 'Filling form',
  fill_form: 'Filling form',
  fill_form_fields: 'Filling form',
  tabs_activate: 'Activating tab',
  activate_tab: 'Activating tab',
  tabs_create: 'Creating tab',
  create_tab: 'Creating tab',
  tabs_updateUrl: 'Navigating tab',
  navigate: 'Navigating tab',
  http_fetch: 'Fetching URL',
  bookmarks_getAll: 'Getting all bookmarks',
  bookmarks_search: 'Searching bookmarks',
  history_search: 'Searching history',
  browser_snapshot: 'Capturing browser snapshot',
  browser_form_snapshot: 'Inspecting form semantics',
  browser_click: 'Clicking page element',
  browser_hover: 'Hovering page element',
  browser_type: 'Typing into page element',
  browser_fill_form: 'Filling form',
  browser_drag: 'Dragging page element',
  browser_scroll: 'Scrolling page',
  browser_key: 'Sending key input',
  browser_wait_for: 'Waiting for page state',
  browser_upload_file: 'Preparing upload',
  browser_download_wait: 'Waiting for download',
  browser_handle_dialog: 'Handling dialog',
  browser_visual_query: 'Querying visual region',
  tab_screenshot_vlm: 'Capturing & querying VLM',
  webmcp_discover: 'Discovering WebMCP tools',
  webmcp_invoke: 'Invoking WebMCP tool',
  skills_load: 'Loading skill details',
  skills_propose: 'Saving Domain Skill proposal',
};

const AUTOMATION_TOOL_NAMES = new Set([
  'tabs_highlight',
  'tabs_hover',
  'tabs_click',
  'tabs_type',
  'tabs_fillForm',
  'tabs_activate',
  'tabs_create',
  'tabs_updateUrl',
  'browser_click',
  'browser_hover',
  'browser_type',
  'browser_fill_form',
  'browser_drag',
  'browser_scroll',
  'browser_key',
  'browser_wait_for',
  'browser_upload_file',
  'browser_download_wait',
  'browser_handle_dialog',
  'http_fetch',
  'webmcp_invoke',
]);

export const DEFAULT_DISABLED_TOOL_NAMES = new Set(AUTOMATION_TOOL_NAMES);

export function isAutomationToolName(toolName: string): boolean {
  return AUTOMATION_TOOL_NAMES.has(toolName) || /^webmcp_t\d+_/.test(toolName);
}

export function getBuiltinToolCategory(toolName: string): string {
  if (toolName.startsWith('skills_')) return 'skills';
  if (isAutomationToolName(toolName)) return 'browser_automation';
  return 'browser_read';
}

export function getToolDisplayLabel(toolName: string): string {
  if (TOOL_DISPLAY_LABELS[toolName]) return TOOL_DISPLAY_LABELS[toolName];

  const webmcpMatch = toolName.match(/^webmcp_t(\d+)_(.+)$/);
  if (webmcpMatch) {
    return `WebMCP: ${webmcpMatch[2].replace(/_/g, ' ')}`;
  }

  if (toolName.startsWith('webmcp_')) {
    return `WebMCP: ${toolName.slice(7).replace(/_/g, ' ')}`;
  }

  return toolName.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getToolCompletionDescription(toolName: string, result?: string): string {
  const MAX = 100;
  if (result) {
    try {
      const parsed = JSON.parse(result);
      if (parsed.message) {
        const message = parsed.message as string;
        return message.length > MAX ? `${message.slice(0, MAX)}…` : message;
      }
    } catch {
      // Ignore invalid JSON tool payloads.
    }
  }

  const defaults: Record<string, string> = {
    tabs_list: 'Retrieved tab list',
    tabs_getActive: 'Got active tab',
    get_active_tab: 'Got active tab',
    tabs_getContent: 'Read tab content',
    get_content: 'Read tab content',
    tabs_listInteractiveElements: 'Inspected interactive elements',
    list_interactive_elements: 'Inspected interactive elements',
    tabs_highlight: 'Element highlighted',
    highlight: 'Element highlighted',
    highlight_element: 'Element highlighted',
    tabs_hover: 'Element hovered',
    hover: 'Element hovered',
    hover_element: 'Element hovered',
    tabs_click: 'Element clicked',
    click: 'Element clicked',
    click_element: 'Element clicked',
    tabs_type: 'Typed into element',
    type: 'Typed into element',
    type_text: 'Typed into element',
    tabs_fillForm: 'Form filled',
    fill_form: 'Form filled',
    fill_form_fields: 'Form filled',
    tabs_activate: 'Tab activated',
    activate_tab: 'Tab activated',
    tabs_create: 'Tab created',
    create_tab: 'Tab created',
    tabs_updateUrl: 'Tab navigated',
    navigate: 'Tab navigated',
    http_fetch: 'HTTP request complete',
    bookmarks_getAll: 'Retrieved bookmarks',
    bookmarks_search: 'Bookmarks search complete',
    history_search: 'History search complete',
    browser_snapshot: 'Captured browser snapshot',
    browser_form_snapshot: 'Inspected form semantics',
    browser_click: 'Element clicked',
    browser_hover: 'Element hovered',
    browser_type: 'Typed into element',
    browser_fill_form: 'Form filled',
    browser_drag: 'Drag action complete',
    browser_scroll: 'Page scrolled',
    browser_key: 'Key input sent',
    browser_wait_for: 'Wait complete',
    browser_upload_file: 'Upload action complete',
    browser_download_wait: 'Download wait complete',
    browser_handle_dialog: 'Dialog handled',
    browser_visual_query: 'Visual query complete',
    tab_screenshot_vlm: 'VLM analysis complete',
    webmcp_discover: 'Discovery complete',
    webmcp_invoke: 'Tool invoked',
  };

  return defaults[toolName] || `Completed ${toolName}`;
}

export function registerWebMCPToolDisplayLabels(tabId: number, descriptors: WebMCPToolDescriptor[]): void {
  for (const descriptor of descriptors) {
    TOOL_DISPLAY_LABELS[`webmcp_t${tabId}_${descriptor.name}`] = `WebMCP: ${descriptor.name.replace(/_/g, ' ')}`;
  }
}

export function registerMCPToolDisplayLabels(
  serverId: string,
  serverName: string,
  descriptors: MCPToolDescriptor[],
): void {
  const safeId = serverId.replace(/[^a-zA-Z0-9]/g, '');
  for (const descriptor of descriptors) {
    TOOL_DISPLAY_LABELS[`mcp_${safeId}_${descriptor.name}`] = `MCP ${serverName}: ${descriptor.name.replace(/_/g, ' ')}`;
  }
}

export function removeMCPToolDisplayLabels(serverId: string, descriptors: MCPToolDescriptor[]): void {
  const safeId = serverId.replace(/[^a-zA-Z0-9]/g, '');
  for (const descriptor of descriptors) {
    delete TOOL_DISPLAY_LABELS[`mcp_${safeId}_${descriptor.name}`];
  }
}

export function getCategoryLabel(category: string): string {
  if (category === 'browser_read') return 'Read Only';
  if (category === 'browser_automation') return 'Automation';
  if (category === 'skills') return 'Skills';
  const webmcpMatch = category.match(/^webmcp_tab_(\d+)$/);
  if (webmcpMatch) return `WebMCP · Tab ${webmcpMatch[1]}`;
  if (category.match(/^mcp_server_(.+)$/)) return 'MCP Server';
  return category;
}

export function buildToolManifest(
  builtinTools: StructuredToolInterface[],
  webmcpByTab: Map<number, WebMCPToolState>,
  mcpServers: Map<string, MCPToolState>,
  disabledTools: Set<string>,
): ToolManifestEntry[] {
  const manifest: ToolManifestEntry[] = [];

  for (const tool of builtinTools) {
    if ((tool as any).__hidden) continue;
    const name = (tool as any).name as string;
    const category = getBuiltinToolCategory(name);
    manifest.push({
      name,
      description: (tool as any).description ?? '',
      category,
      enabled: !disabledTools.has(name),
      source: 'builtin',
      sourceLabel: getCategoryLabel(category),
      title: getToolDisplayLabel(name),
      inputSchema: normalizeToolInputSchema((tool as any).schema),
    });
  }

  for (const [tabId, entry] of webmcpByTab.entries()) {
    const category = `webmcp_tab_${tabId}`;
    for (const descriptor of entry.descriptors) {
      const name = `webmcp_t${tabId}_${descriptor.name}`;
      manifest.push({
        name,
        description: descriptor.description ?? '',
        category,
        enabled: !disabledTools.has(name),
        source: 'webmcp',
        sourceLabel: entry.title ? `WebMCP · ${entry.title}` : `WebMCP · Tab ${tabId}`,
        title: descriptor.name,
        inputSchema: normalizeToolInputSchema(descriptor.inputSchema),
      });
    }
  }

  for (const [serverId, entry] of mcpServers.entries()) {
    if (entry.status !== 'connected') continue;
    const category = `mcp_server_${serverId}`;
    const safeId = serverId.replace(/[^a-zA-Z0-9]/g, '');
    for (const descriptor of entry.tools) {
      if (!isToolVisibleToModel(descriptor)) continue;
      const name = `mcp_${safeId}_${descriptor.name}`;
      manifest.push({
        name,
        description: descriptor.description ?? '',
        category,
        enabled: !disabledTools.has(name),
        source: 'mcp',
        sourceLabel: `MCP · ${entry.name}`,
        title: descriptor.title ?? descriptor.name,
        inputSchema: normalizeToolInputSchema(descriptor.inputSchema),
        visibility: getMCPToolVisibility(descriptor),
        resourceUri: getMCPToolUIResourceUri(descriptor),
      });
    }
  }

  return manifest;
}
