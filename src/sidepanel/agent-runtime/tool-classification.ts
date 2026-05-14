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

const OUTBOUND_TRANSFER_TOOL_NAMES = new Set([
  'http_fetch',
  'browser_visual_query',
  'tab_screenshot_vlm',
]);

function isDynamicWebMCPToolName(toolName: string): boolean {
  return /^webmcp_t\d+_/.test(toolName);
}

export const DEFAULT_DISABLED_TOOL_NAMES = new Set(AUTOMATION_TOOL_NAMES);

export function isAutomationToolName(toolName: string): boolean {
  return AUTOMATION_TOOL_NAMES.has(toolName) || isDynamicWebMCPToolName(toolName);
}

export function isApprovalGatedToolName(toolName: string): boolean {
  return isAutomationToolName(toolName) || OUTBOUND_TRANSFER_TOOL_NAMES.has(toolName);
}