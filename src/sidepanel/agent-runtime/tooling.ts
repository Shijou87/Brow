import type { StructuredToolInterface } from '@langchain/core/tools';
import type { MCPToolDescriptor } from '../mcp-client';
import type { WebMCPToolDescriptor } from '../../shared/types';

export interface ToolManifestEntry {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
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
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  tools: MCPToolDescriptor[];
  langchainTools: StructuredToolInterface[];
  error?: string;
}

const TOOL_DISPLAY_LABELS: Record<string, string> = {
  tabs_list: 'Listing tabs',
  tabs_getActive: 'Getting active tab',
  tabs_getContent: 'Reading tab content',
  tabs_listInteractiveElements: 'Inspecting page elements',
  tabs_click: 'Clicking page element',
  tabs_type: 'Typing into page element',
  tabs_fillForm: 'Filling form',
  tabs_activate: 'Activating tab',
  tabs_create: 'Creating tab',
  tabs_updateUrl: 'Navigating tab',
  http_fetch: 'Fetching URL',
  bookmarks_getAll: 'Getting all bookmarks',
  bookmarks_search: 'Searching bookmarks',
  history_search: 'Searching history',
  tab_screenshot_vlm: 'Capturing & querying VLM',
  webmcp_discover: 'Discovering WebMCP tools',
  webmcp_invoke: 'Invoking WebMCP tool',
  skills_load: 'Loading skill details',
};

const AUTOMATION_TOOL_NAMES = new Set([
  'tabs_click',
  'tabs_type',
  'tabs_fillForm',
  'tabs_activate',
  'tabs_create',
  'tabs_updateUrl',
  'http_fetch',
  'webmcp_invoke',
]);

export const DEFAULT_DISABLED_TOOL_NAMES = new Set(AUTOMATION_TOOL_NAMES);

export function getBuiltinToolCategory(toolName: string): string {
  if (toolName.startsWith('skills_')) return 'skills';
  if (AUTOMATION_TOOL_NAMES.has(toolName)) return 'browser_automation';
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
    tabs_getContent: 'Read tab content',
    tabs_listInteractiveElements: 'Inspected interactive elements',
    tabs_click: 'Element clicked',
    tabs_type: 'Typed into element',
    tabs_fillForm: 'Form filled',
    tabs_activate: 'Tab activated',
    tabs_create: 'Tab created',
    tabs_updateUrl: 'Tab navigated',
    http_fetch: 'HTTP request complete',
    bookmarks_getAll: 'Retrieved bookmarks',
    bookmarks_search: 'Bookmarks search complete',
    history_search: 'History search complete',
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
    const name = (tool as any).name as string;
    manifest.push({
      name,
      description: (tool as any).description ?? '',
      category: getBuiltinToolCategory(name),
      enabled: !disabledTools.has(name),
    });
  }

  for (const [tabId, entry] of webmcpByTab.entries()) {
    const category = `webmcp_tab_${tabId}`;
    for (const tool of entry.tools) {
      const name = (tool as any).name as string;
      manifest.push({
        name,
        description: (tool as any).description ?? '',
        category,
        enabled: !disabledTools.has(name),
      });
    }
  }

  for (const [serverId, entry] of mcpServers.entries()) {
    if (entry.status !== 'connected') continue;
    const category = `mcp_server_${serverId}`;
    for (const tool of entry.langchainTools) {
      const name = (tool as any).name as string;
      manifest.push({
        name,
        description: (tool as any).description ?? '',
        category,
        enabled: !disabledTools.has(name),
      });
    }
  }

  return manifest;
}
