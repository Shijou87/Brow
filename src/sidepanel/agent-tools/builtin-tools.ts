import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import {
  tabsActivate,
  tabsClick,
  tabsCreate,
  tabsFillForm,
  tabsGetActive,
  tabsGetContent,
  tabsHighlight,
  tabsHover,
  tabsList,
  tabsListInteractiveElements,
  tabsType,
  tabsUpdateUrl,
  httpFetch,
  tabCaptureScreenshot,
  vlmQuery,
  bookmarksGetAll,
  bookmarksSearch,
  historySearch,
  webmcpDiscover,
  webmcpInvoke,
} from '../tab-tools';
import type { VLMConfig } from '../../shared/types';
import type { SkillRegistryEntry } from '../skills-registry';

interface BuiltinToolDependencies {
  getVLMConfig: () => VLMConfig | null;
  findSkill: (identifier: string) => SkillRegistryEntry | null;
}

function markToolAlias(
  toolInstance: StructuredToolInterface,
  aliasOf: string,
): StructuredToolInterface {
  (toolInstance as any).__hidden = true;
  (toolInstance as any).__aliasOf = aliasOf;
  return toolInstance;
}

async function resolveAliasTabId(tabId?: number): Promise<number | { ok: false; error: string }> {
  if (typeof tabId === 'number' && Number.isFinite(tabId)) return tabId;
  const activeTab = await tabsGetActive();
  if (activeTab?.tabId != null && activeTab.tabId >= 0) return activeTab.tabId;
  return {
    ok: false,
    error: 'No active tab is available for this browser automation action.',
  };
}

export function createBuiltinTools(deps: BuiltinToolDependencies): StructuredToolInterface[] {
  const tabsListTool = tool(
    async () => JSON.stringify(await tabsList(), null, 2),
    {
      name: 'tabs_list',
      description: 'List all open browser tabs. Returns tabId, windowId, title, url, active, audible, status.',
      schema: z.object({}),
    },
  );

  const tabsGetActiveTool = tool(
    async () => JSON.stringify(await tabsGetActive(), null, 2),
    {
      name: 'tabs_getActive',
      description: 'Get info about the currently active tab. Returns tabId, title, url, etc. No arguments needed.',
      schema: z.object({}),
    },
  );

  const tabsGetContentTool = tool(
    async ({ tabId, format }: { tabId: number; format?: string }) =>
      JSON.stringify(await tabsGetContent(tabId, (format as 'text' | 'html') ?? 'text'), null, 2),
    {
      name: 'tabs_getContent',
      description: 'Read the text content (or HTML) of a specific tab. Use tabs_getActive first to get the tabId if needed.',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab to read content from'),
        format: z.enum(['text', 'html']).optional().describe('Content format: "text" (default) or "html"'),
      }),
    },
  );

  const tabsListInteractiveElementsTool = tool(
    async ({ tabId, limit }: { tabId: number; limit?: number }) =>
      JSON.stringify(await tabsListInteractiveElements(tabId, limit ?? 40), null, 2),
    {
      name: 'tabs_listInteractiveElements',
      description: 'List visible interactive elements on a tab and return candidate selectors, labels, roles, and attributes. Prefer these returned selectors for buttons, links, and form fields before clicking or typing.',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab to inspect'),
        limit: z.number().optional().describe('Maximum number of elements to return (default: 40, max: 100)'),
      }),
    },
  );

  const tabsClickTool = tool(
    async ({ tabId, selector }: { tabId: number; selector: string }) =>
      JSON.stringify(await tabsClick(tabId, selector), null, 2),
    {
      name: 'tabs_click',
      description: 'Click an element on a specific tab using a locator string. Prefer selectors returned by tabs_listInteractiveElements for interactive controls. Also supports simple text locators like heading="Daily Summary", text="Continue", title="Settings", or placeholder="Search".',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the target element'),
        selector: z.string().describe('Locator string for the element to click. Supports CSS selectors and simple text locators such as heading="...", text="...", title="...", or placeholder="..."'),
      }),
    },
  );

  const tabsHighlightTool = tool(
    async ({
      tabId,
      selector,
      message,
      durationMs,
    }: {
      tabId: number;
      selector: string;
      message?: string;
      durationMs?: number;
    }) => JSON.stringify(await tabsHighlight(tabId, selector, message, durationMs), null, 2),
    {
      name: 'tabs_highlight',
      description: 'Highlight an element on a specific tab using a locator string without clicking it. Prefer simple text locators for content such as heading="Daily Summary" or text="Security". Shows the Brow border overlay and optional label for a short duration.',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the target element'),
        selector: z.string().describe('Locator string for the element to highlight. Supports CSS selectors and simple text locators such as heading="...", text="...", title="...", or placeholder="..."'),
        message: z.string().optional().describe('Optional overlay label text. Default: a generated "Brow highlighting ..." message'),
        durationMs: z.number().optional().describe('How long to keep the highlight visible in milliseconds. Default: 2200, clamped to 600-10000'),
      }),
    },
  );

  const tabsHoverTool = tool(
    async ({
      tabId,
      selector,
      message,
      durationMs,
    }: {
      tabId: number;
      selector: string;
      message?: string;
      durationMs?: number;
    }) => JSON.stringify(await tabsHover(tabId, selector, message, durationMs), null, 2),
    {
      name: 'tabs_hover',
      description: 'Hover an element on a specific tab using a locator string without clicking it. Useful for opening menus and navigation states. Prefer simple text locators for content such as heading="Daily Summary" or text="Security".',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the target element'),
        selector: z.string().describe('Locator string for the element to hover. Supports CSS selectors and simple text locators such as heading="...", text="...", title="...", or placeholder="..."'),
        message: z.string().optional().describe('Optional overlay label text. Default: a generated "Brow hovering ..." message'),
        durationMs: z.number().optional().describe('How long to keep the visual hover preview visible in milliseconds. Default: 1400, clamped to 500-10000'),
      }),
    },
  );

  const tabsTypeTool = tool(
    async ({ tabId, selector, text, submit }: { tabId: number; selector: string; text: string; submit?: boolean }) =>
      JSON.stringify(await tabsType(tabId, selector, text, submit ?? false), null, 2),
    {
      name: 'tabs_type',
      description: 'Type into an input, textarea, or contenteditable element on a specific tab using a locator string. Prefer selectors returned by tabs_listInteractiveElements or simple locators like placeholder="Search".',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the target field'),
        selector: z.string().describe('Locator string for the target field. Supports CSS selectors and simple text locators such as placeholder="..."'),
        text: z.string().describe('Text to place into the field'),
        submit: z.boolean().optional().describe('Press Enter / submit the form after typing'),
      }),
    },
  );

  const tabsFillFormTool = tool(
    async ({
      tabId,
      fields,
      submit,
      submitSelector,
    }: {
      tabId: number;
      fields: Array<{
        selector: string;
        value: string | number | boolean;
        mode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable';
      }>;
      submit?: boolean;
      submitSelector?: string;
    }) => JSON.stringify(await tabsFillForm(tabId, fields, submit ?? false, submitSelector), null, 2),
    {
      name: 'tabs_fillForm',
      description: 'Fill multiple form fields on a specific tab. Supports text inputs, textareas, contenteditable fields, selects, checkboxes, radios, and optional submit. Prefer selectors returned by tabs_listInteractiveElements or simple locators like placeholder="...".',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the form'),
        fields: z.array(
          z.object({
            selector: z.string().describe('Locator string for the target field. Supports CSS selectors and simple text locators such as placeholder="..."'),
            value: z.union([z.string(), z.number(), z.boolean()]).describe('Value to apply. Use booleans for checkboxes/radios.'),
            mode: z.enum(['auto', 'text', 'checkbox', 'radio', 'select', 'contenteditable']).optional()
              .describe('Optional override for how to fill the field. Default: auto.'),
          }),
        ).describe('List of fields to fill'),
        submit: z.boolean().optional().describe('Submit the closest parent form after filling all fields'),
        submitSelector: z.string().optional().describe('Optional locator string for a submit button to click after filling'),
      }),
    },
  );

  const tabsActivateTool = tool(
    async ({ tabId }: { tabId: number }) => JSON.stringify(await tabsActivate(tabId)),
    {
      name: 'tabs_activate',
      description: 'Activate (switch to) a specific browser tab by its tabId.',
      schema: z.object({ tabId: z.number().describe('The ID of the tab to activate') }),
    },
  );

  const tabsCreateTool = tool(
    async ({ url, active }: { url: string; active?: boolean }) => JSON.stringify(await tabsCreate(url, active ?? true)),
    {
      name: 'tabs_create',
      description: 'Create a new browser tab with the specified URL. The agent decides appropriate URLs.',
      schema: z.object({
        url: z.string().describe('URL to open'),
        active: z.boolean().optional().describe('Whether to activate the tab (default: true)'),
      }),
    },
  );

  const tabsUpdateUrlTool = tool(
    async ({ tabId, url }: { tabId: number; url: string }) => JSON.stringify(await tabsUpdateUrl(tabId, url)),
    {
      name: 'tabs_updateUrl',
      description: 'Navigate an existing tab to a new URL.',
      schema: z.object({
        tabId: z.number().describe('Tab ID to navigate'),
        url: z.string().describe('New URL to load'),
      }),
    },
  );

  const bookmarksGetAllTool = tool(
    async () => JSON.stringify(await bookmarksGetAll(), null, 2),
    {
      name: 'bookmarks_getAll',
      description: 'Get all browser bookmarks as a flat list. Returns id, title, url, parentId, dateAdded for each bookmark.',
      schema: z.object({}),
    },
  );

  const httpFetchTool = tool(
    async ({
      url,
      method,
      headers,
      body,
      timeoutMs,
      maxChars,
    }: {
      url: string;
      method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
      maxChars?: number;
    }) => JSON.stringify(await httpFetch(url, { method, headers, body, timeoutMs, maxChars }), null, 2),
    {
      name: 'http_fetch',
      description: 'Make a curl-like HTTP request to a URL. Supports GET, HEAD, POST, PUT, PATCH, DELETE, and OPTIONS with optional headers and raw string body. Returns status, headers, and a truncated response body when text is available.',
      schema: z.object({
        url: z.string().describe('The http:// or https:// URL to request'),
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).optional()
          .describe('HTTP method to use. Default: GET'),
        headers: z.record(z.string()).optional()
          .describe('Optional request headers as key/value pairs'),
        body: z.string().optional()
          .describe('Optional raw request body. Typically used with POST, PUT, or PATCH'),
        timeoutMs: z.number().optional()
          .describe('Request timeout in milliseconds. Default: 15000, max: 60000'),
        maxChars: z.number().optional()
          .describe('Maximum number of response body characters to return. Default: 20000, max: 50000'),
      }),
    },
  );

  const bookmarksSearchTool = tool(
    async ({ query }: { query: string }) => JSON.stringify(await bookmarksSearch(query), null, 2),
    {
      name: 'bookmarks_search',
      description: 'Search bookmarks by title or URL keyword.',
      schema: z.object({
        query: z.string().describe('Search query to match against bookmark titles and URLs'),
      }),
    },
  );

  const historySearchTool = tool(
    async ({ query, maxResults, startTime }: { query: string; maxResults?: number; startTime?: number }) =>
      JSON.stringify(await historySearch(query, maxResults ?? 50, startTime), null, 2),
    {
      name: 'history_search',
      description: 'Search browser history. Returns matching history items with url, title, lastVisitTime, visitCount.',
      schema: z.object({
        query: z.string().describe('Text to search for in history URLs and titles'),
        maxResults: z.number().optional().describe('Maximum number of results to return (default: 50)'),
        startTime: z.number().optional().describe('Only return results visited after this timestamp (ms since epoch)'),
      }),
    },
  );

  const tabScreenshotVlmTool = tool(
    async ({ tabId, query }: { tabId?: number; query: string }) => {
      const vlmConfig = deps.getVLMConfig();
      if (!vlmConfig || !vlmConfig.baseUrl || !vlmConfig.model) {
        return JSON.stringify({ ok: false, error: 'VLM not configured. Please set VLM endpoint, model, and API key in the config panel.' });
      }

      const screenshot = await tabCaptureScreenshot(tabId);
      if (!screenshot.ok || !screenshot.dataUrl) {
        return JSON.stringify({ ok: false, error: screenshot.error ?? 'Failed to capture screenshot' });
      }

      return JSON.stringify(await vlmQuery(vlmConfig, screenshot.dataUrl, query), null, 2);
    },
    {
      name: 'tab_screenshot_vlm',
      description: 'Capture a screenshot of a browser tab and send it with a text query to a Vision Language Model (VLM). Use this to visually analyze webpage content. Returns the VLM\'s text response.',
      schema: z.object({
        tabId: z.number().optional().describe('Tab ID to screenshot (default: current active tab)'),
        query: z.string().describe('Question or instruction for the VLM about the screenshot (e.g., "describe what you see", "extract all text", "what products are shown?")'),
      }),
    },
  );

  const webmcpDiscoverTool = tool(
    async ({ tabId }: { tabId?: number }) => JSON.stringify(await webmcpDiscover(tabId), null, 2),
    {
      name: 'webmcp_discover',
      description: 'Discover WebMCP tools on a tab. Defaults to active tab. Returns tools exposed by the page.',
      schema: z.object({
        tabId: z.number().optional().describe('Tab ID (default: active tab)'),
      }),
    },
  );

  const webmcpInvokeTool = tool(
    async ({ tabId, toolName, args }: { tabId: number; toolName: string; args?: Record<string, unknown> }) =>
      JSON.stringify(await webmcpInvoke(tabId, toolName, args ?? {}), null, 2),
    {
      name: 'webmcp_invoke',
      description: 'Invoke a WebMCP tool on a specific tab. Must be discovered first.',
      schema: z.object({
        tabId: z.number().describe('Tab ID where the tool lives'),
        toolName: z.string().describe('Name of the WebMCP tool'),
        args: z.record(z.unknown()).optional().describe('Arguments to pass'),
      }),
    },
  );

  const clickAliasTool = markToolAlias(tool(
    async ({ tabId, selector }: { tabId?: number; selector: string }) => {
      const resolvedTabId = await resolveAliasTabId(tabId);
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      return JSON.stringify(await tabsClick(resolvedTabId, selector), null, 2);
    },
    {
      name: 'click',
      description: 'Alias for tabs_click.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_click');

  const clickElementAliasTool = markToolAlias(tool(
    async ({ tabId, selector }: { tabId?: number; selector: string }) => {
      const resolvedTabId = await resolveAliasTabId(tabId);
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      return JSON.stringify(await tabsClick(resolvedTabId, selector), null, 2);
    },
    {
      name: 'click_element',
      description: 'Alias for tabs_click.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_click');

  const highlightAliasTool = markToolAlias(tool(
    async ({
      tabId,
      selector,
      message,
      durationMs,
    }: {
      tabId?: number;
      selector: string;
      message?: string;
      durationMs?: number;
    }) => {
      const resolvedTabId = await resolveAliasTabId(tabId);
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      return JSON.stringify(await tabsHighlight(resolvedTabId, selector, message, durationMs), null, 2);
    },
    {
      name: 'highlight',
      description: 'Alias for tabs_highlight.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
        message: z.string().optional(),
        durationMs: z.number().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_highlight');

  const highlightElementAliasTool = markToolAlias(tool(
    async ({
      tabId,
      selector,
      message,
      durationMs,
    }: {
      tabId?: number;
      selector: string;
      message?: string;
      durationMs?: number;
    }) => {
      const resolvedTabId = await resolveAliasTabId(tabId);
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      return JSON.stringify(await tabsHighlight(resolvedTabId, selector, message, durationMs), null, 2);
    },
    {
      name: 'highlight_element',
      description: 'Alias for tabs_highlight.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
        message: z.string().optional(),
        durationMs: z.number().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_highlight');

  const hoverAliasTool = markToolAlias(tool(
    async ({
      tabId,
      selector,
      message,
      durationMs,
    }: {
      tabId?: number;
      selector: string;
      message?: string;
      durationMs?: number;
    }) => {
      const resolvedTabId = await resolveAliasTabId(tabId);
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      return JSON.stringify(await tabsHover(resolvedTabId, selector, message, durationMs), null, 2);
    },
    {
      name: 'hover',
      description: 'Alias for tabs_hover.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
        message: z.string().optional(),
        durationMs: z.number().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_hover');

  const hoverElementAliasTool = markToolAlias(tool(
    async ({
      tabId,
      selector,
      message,
      durationMs,
    }: {
      tabId?: number;
      selector: string;
      message?: string;
      durationMs?: number;
    }) => {
      const resolvedTabId = await resolveAliasTabId(tabId);
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      return JSON.stringify(await tabsHover(resolvedTabId, selector, message, durationMs), null, 2);
    },
    {
      name: 'hover_element',
      description: 'Alias for tabs_hover.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
        message: z.string().optional(),
        durationMs: z.number().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_hover');

  const typeAliasTool = markToolAlias(tool(
    async ({ tabId, selector, text, submit }: { tabId?: number; selector: string; text: string; submit?: boolean }) => {
      const resolvedTabId = await resolveAliasTabId(tabId);
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      return JSON.stringify(await tabsType(resolvedTabId, selector, text, submit ?? false), null, 2);
    },
    {
      name: 'type',
      description: 'Alias for tabs_type.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
        text: z.string(),
        submit: z.boolean().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_type');

  const typeTextAliasTool = markToolAlias(tool(
    async ({ tabId, selector, text, submit }: { tabId?: number; selector: string; text: string; submit?: boolean }) => {
      const resolvedTabId = await resolveAliasTabId(tabId);
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      return JSON.stringify(await tabsType(resolvedTabId, selector, text, submit ?? false), null, 2);
    },
    {
      name: 'type_text',
      description: 'Alias for tabs_type.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
        text: z.string(),
        submit: z.boolean().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_type');

  const fillFormAliasTool = markToolAlias(tool(
    async ({
      tabId,
      fields,
      submit,
      submitSelector,
    }: {
      tabId?: number;
      fields: Array<{
        selector: string;
        value: string | number | boolean;
        mode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable';
      }>;
      submit?: boolean;
      submitSelector?: string;
    }) => {
      const resolvedTabId = await resolveAliasTabId(tabId);
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      return JSON.stringify(await tabsFillForm(resolvedTabId, fields, submit ?? false, submitSelector), null, 2);
    },
    {
      name: 'fill_form',
      description: 'Alias for tabs_fillForm.',
      schema: z.object({
        tabId: z.number().optional(),
        fields: z.array(
          z.object({
            selector: z.string(),
            value: z.union([z.string(), z.number(), z.boolean()]),
            mode: z.enum(['auto', 'text', 'checkbox', 'radio', 'select', 'contenteditable']).optional(),
          }),
        ),
        submit: z.boolean().optional(),
        submitSelector: z.string().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_fillForm');

  const fillFormFieldsAliasTool = markToolAlias(tool(
    async ({
      tabId,
      fields,
      submit,
      submitSelector,
    }: {
      tabId?: number;
      fields: Array<{
        selector: string;
        value: string | number | boolean;
        mode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable';
      }>;
      submit?: boolean;
      submitSelector?: string;
    }) => {
      const resolvedTabId = await resolveAliasTabId(tabId);
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      return JSON.stringify(await tabsFillForm(resolvedTabId, fields, submit ?? false, submitSelector), null, 2);
    },
    {
      name: 'fill_form_fields',
      description: 'Alias for tabs_fillForm.',
      schema: z.object({
        tabId: z.number().optional(),
        fields: z.array(
          z.object({
            selector: z.string(),
            value: z.union([z.string(), z.number(), z.boolean()]),
            mode: z.enum(['auto', 'text', 'checkbox', 'radio', 'select', 'contenteditable']).optional(),
          }),
        ),
        submit: z.boolean().optional(),
        submitSelector: z.string().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_fillForm');

  const listInteractiveElementsAliasTool = markToolAlias(tool(
    async ({ tabId, limit }: { tabId: number; limit?: number }) =>
      JSON.stringify(await tabsListInteractiveElements(tabId, limit ?? 40), null, 2),
    {
      name: 'list_interactive_elements',
      description: 'Alias for tabs_listInteractiveElements.',
      schema: z.object({
        tabId: z.number(),
        limit: z.number().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_listInteractiveElements');

  const getActiveTabAliasTool = markToolAlias(tool(
    async () => JSON.stringify(await tabsGetActive(), null, 2),
    {
      name: 'get_active_tab',
      description: 'Alias for tabs_getActive.',
      schema: z.object({}),
    },
  ) as unknown as StructuredToolInterface, 'tabs_getActive');

  const listTabsAliasTool = markToolAlias(tool(
    async () => JSON.stringify(await tabsList(), null, 2),
    {
      name: 'list_tabs',
      description: 'Alias for tabs_list.',
      schema: z.object({}),
    },
  ) as unknown as StructuredToolInterface, 'tabs_list');

  const getContentAliasTool = markToolAlias(tool(
    async ({ tabId, format }: { tabId: number; format?: string }) =>
      JSON.stringify(await tabsGetContent(tabId, (format as 'text' | 'html') ?? 'text'), null, 2),
    {
      name: 'get_content',
      description: 'Alias for tabs_getContent.',
      schema: z.object({
        tabId: z.number(),
        format: z.enum(['text', 'html']).optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_getContent');

  const activateTabAliasTool = markToolAlias(tool(
    async ({ tabId }: { tabId: number }) => JSON.stringify(await tabsActivate(tabId)),
    {
      name: 'activate_tab',
      description: 'Alias for tabs_activate.',
      schema: z.object({ tabId: z.number() }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_activate');

  const createTabAliasTool = markToolAlias(tool(
    async ({ url, active }: { url: string; active?: boolean }) => JSON.stringify(await tabsCreate(url, active ?? true)),
    {
      name: 'create_tab',
      description: 'Alias for tabs_create.',
      schema: z.object({
        url: z.string(),
        active: z.boolean().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_create');

  const navigateAliasTool = markToolAlias(tool(
    async ({ tabId, url }: { tabId: number; url: string }) => JSON.stringify(await tabsUpdateUrl(tabId, url)),
    {
      name: 'navigate',
      description: 'Alias for tabs_updateUrl.',
      schema: z.object({
        tabId: z.number(),
        url: z.string(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_updateUrl');

  const skillsLoadTool = tool(
    async ({ identifier }: { identifier: string }) => {
      const skill = deps.findSkill(identifier);
      if (!skill) {
        return JSON.stringify({
          ok: false,
          error: `Skill "${identifier}" not found`,
        }, null, 2);
      }
      return JSON.stringify({ ok: true, skill }, null, 2);
    },
    {
      name: 'skills_load',
      description: 'Load the full details of a configured reusable skill by slug or display name. Use this when a skill listed in the system prompt looks relevant.',
      schema: z.object({
        identifier: z.string().describe('The skill slug or display name to load'),
      }),
    },
  );

  return [
    tabsListTool as unknown as StructuredToolInterface,
    tabsGetActiveTool as unknown as StructuredToolInterface,
    tabsGetContentTool as unknown as StructuredToolInterface,
    tabsListInteractiveElementsTool as unknown as StructuredToolInterface,
    tabsHighlightTool as unknown as StructuredToolInterface,
    tabsHoverTool as unknown as StructuredToolInterface,
    tabsClickTool as unknown as StructuredToolInterface,
    tabsTypeTool as unknown as StructuredToolInterface,
    tabsFillFormTool as unknown as StructuredToolInterface,
    tabsActivateTool as unknown as StructuredToolInterface,
    tabsCreateTool as unknown as StructuredToolInterface,
    tabsUpdateUrlTool as unknown as StructuredToolInterface,
    httpFetchTool as unknown as StructuredToolInterface,
    bookmarksGetAllTool as unknown as StructuredToolInterface,
    bookmarksSearchTool as unknown as StructuredToolInterface,
    historySearchTool as unknown as StructuredToolInterface,
    tabScreenshotVlmTool as unknown as StructuredToolInterface,
    webmcpDiscoverTool as unknown as StructuredToolInterface,
    webmcpInvokeTool as unknown as StructuredToolInterface,
    clickAliasTool,
    clickElementAliasTool,
    highlightAliasTool,
    highlightElementAliasTool,
    hoverAliasTool,
    hoverElementAliasTool,
    typeAliasTool,
    typeTextAliasTool,
    fillFormAliasTool,
    fillFormFieldsAliasTool,
    listInteractiveElementsAliasTool,
    listTabsAliasTool,
    getActiveTabAliasTool,
    getContentAliasTool,
    activateTabAliasTool,
    createTabAliasTool,
    navigateAliasTool,
    skillsLoadTool as unknown as StructuredToolInterface,
  ];
}
