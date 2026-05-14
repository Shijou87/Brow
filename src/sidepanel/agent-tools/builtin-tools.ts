import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  backendPreferenceSchema,
  nullableOptionalBoolean,
  nullableOptionalClickPoint,
  nullableOptionalNumber,
  nullableOptionalPointerPath,
  normalizeOptionalJsonString,
  parseOptionalTargetEvidenceJson,
  nullableOptionalString,
  nullableOptionalTargetEvidence,
  postconditionSchema,
} from './input-schemas';
import { browserFillFormToolSchema, browserDragToolSchema, browserFillModeSchema } from './browser-tool-schemas';
import { getWebMCPAftermathWaitMs, shouldCaptureWebMCPAftermath } from '../webmcp-tool-factory';
import {
  deleteDomainMemoryEntry,
  loadDomainMemoryEntries,
  queryDomainMemoryEntries,
  saveDomainMemoryDraft,
  setDomainMemoryEnabled,
} from '../domain-memory';

import {
  attachToolSnapshotFields,
  buildToolSnapshotFields,
  type ToolSnapshotPayload,
} from '../agent-runtime/tool-result-snapshot';
import { compactAutomationToolResult, formatAutomationToolResultText } from '../agent-runtime/automation-tool-result';
import {
  invalidateBrowserContextSnapshotCache,
  primeBrowserContextSnapshotCache,
} from '../agent-runtime/browser-context';
import {
  browserClick,
  browserDownloadWait,
  browserDrag,
  browserFillForm,
  browserFormSnapshot,
  browserHandleDialog,
  browserHover,
  browserKey,
  browserResolveRef,
  browserScroll,
  browserSnapshot,
  browserType,
  browserUploadFile,
  browserWaitFor,
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
  tabCaptureScreenshotRegion,
  vlmQuery,
  bookmarksGetAll,
  bookmarksSearch,
  historySearch,
  webmcpDiscover,
  webmcpInvoke,
  type BrowserClickPoint,
  type BrowserDragOptions,
} from '../tab-tools';
import type {
  BrowserSnapshot,
  BrowserViewportRect,
  BrowBackendPreference,
  BrowActionPostcondition,
  BrowReplayTargetEvidence,
  DomainMemoryDraft,
  DomainSkillProposal,
  DomainSkillProposalDraft,
  InteractionSkillEntry,
  VLMConfig,
} from '../../shared/types';
import type { SkillRegistryEntry } from '../skills-registry';

interface BuiltinToolDependencies {
  getVLMConfig: () => VLMConfig | null;
  findSkill: (identifier: string) => SkillRegistryEntry | InteractionSkillEntry | null;
  submitDomainSkillProposal: (draft: DomainSkillProposalDraft) => Promise<DomainSkillProposal>;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOptional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function normalizeStringList(value: string[] | string | null | undefined): string[] | undefined {
  if (Array.isArray(value)) {
    const items = Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'string') {
    const items = Array.from(new Set(value.split(',').map((item) => item.trim()).filter(Boolean)));
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

async function inferActiveDomain(): Promise<string | undefined> {
  const activeTab = await tabsGetActive().catch(() => null);
  if (!activeTab?.url) return undefined;
  try {
    return new URL(activeTab.url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeOptionalJsonRecord(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') return value;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOptionalStringRecord(value: Record<string, string> | string | null | undefined): Record<string, string> | undefined {
  const parsed = normalizeOptionalJsonRecord(value as Record<string, unknown> | string | null | undefined);
  if (!parsed) return undefined;

  const record: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(parsed)) {
    if (typeof entryValue === 'string') {
      record[key] = entryValue;
      continue;
    }
    if (entryValue != null) {
      record[key] = String(entryValue);
    }
  }

  return Object.keys(record).length > 0 ? record : undefined;
}

function stringifyCompact(value: unknown): string {
  return JSON.stringify(value);
}

function primeBrowserContextFromSnapshot(snapshot: BrowserSnapshot | undefined): void {
  if (!snapshot?.ok) return;
  const snapshotFields = buildToolSnapshotFields(snapshot);
  primeBrowserContextSnapshotCache(snapshot, snapshotFields.snapshotText);
}

async function appendFreshSnapshot<T extends object>(
  tabId: number,
  payload: T,
  waitMs = 250,
): Promise<ToolSnapshotPayload<T & { snapshot?: BrowserSnapshot }>> {
  if (waitMs > 0) await sleep(waitMs);
  const snapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 80 });
  invalidateBrowserContextSnapshotCache(tabId);
  primeBrowserContextFromSnapshot(snapshot);
  return attachToolSnapshotFields({ ...payload, snapshot });
}

function finalizeAutomationSnapshotPayload<T extends { snapshot?: BrowserSnapshot; beforeSnapshot?: BrowserSnapshot }>(
  tabId: number,
  payload: T,
): ToolSnapshotPayload<T> {
  invalidateBrowserContextSnapshotCache(tabId);
  primeBrowserContextFromSnapshot(payload.snapshot);
  return attachToolSnapshotFields(compactAutomationToolResult(payload as any) as T);
}

function formatAutomationToolOutput(toolName: string, payload: unknown): string {
  return formatAutomationToolResultText(payload as any, toolName);
}

async function runAutomationTool<T extends { snapshot?: BrowserSnapshot; beforeSnapshot?: BrowserSnapshot }>(
  toolName: string,
  tabId: number | null | undefined,
  invoke: (resolvedTabId: number) => Promise<T>,
): Promise<string> {
  const resolvedTabId = await resolveAliasTabId(normalizeOptional(tabId));
  if (typeof resolvedTabId !== 'number') {
    return formatAutomationToolOutput(toolName, resolvedTabId);
  }

  return formatAutomationToolOutput(
    toolName,
    finalizeAutomationSnapshotPayload(resolvedTabId, await invoke(resolvedTabId)),
  );
}

function normalizeViewportRect(input: {
  x?: number;
  y?: number;
  left?: number;
  top?: number;
  width: number;
  height: number;
}): BrowserViewportRect {
  const left = Number.isFinite(input.left) ? Number(input.left) : Number(input.x ?? 0);
  const top = Number.isFinite(input.top) ? Number(input.top) : Number(input.y ?? 0);
  const width = Number(input.width);
  const height = Number(input.height);
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
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
        format: z.enum(['text', 'html']).nullable().optional().describe('Content format: "text" (default) or "html"'),
      }),
    },
  );

  const tabsListInteractiveElementsTool = tool(
    async ({ tabId, limit }: { tabId: number; limit?: number | null }) =>
      JSON.stringify(await tabsListInteractiveElements(tabId, limit ?? 40), null, 2),
    {
      name: 'tabs_listInteractiveElements',
      description: 'List visible interactive elements on a tab and return candidate selectors, labels, roles, and attributes. Prefer these returned selectors for buttons, links, and form fields before clicking or typing.',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab to inspect'),
        limit: nullableOptionalNumber('Maximum number of elements to return (default: 40, max: 100)'),
      }),
    },
  );

  const tabsClickTool = tool(
    async ({ tabId, selector, clickPoint }: { tabId: number; selector: string; clickPoint?: BrowserClickPoint | null }) =>
      JSON.stringify(await appendFreshSnapshot(tabId, await tabsClick(tabId, selector, normalizeOptional(clickPoint))), null, 2),
    {
      name: 'tabs_click',
      description: 'Fallback click using a locator string. Prefer browser_snapshot plus browser_click for visible UI controls. If this fallback is necessary, prefer selectors returned by tabs_listInteractiveElements, raw current-snapshot ref tokens like [ref=e12] or ref=e12, or simple locators like heading="Daily Summary", text="Continue", title="Settings", placeholder="Search", link="Pricing", button="Continue", or textbox="Search"; avoid guessed tag-specific CSS such as button[aria-label="Search"]. For demonstrated canvas/SVG clicks, pass clickPoint from Workflow Demonstration pointer evidence.',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the target element'),
        selector: z.string().describe('Locator string for the element to click. Supports CSS selectors, raw current-snapshot ref tokens like [ref=e12] or ref=e12, and simple locators such as heading="...", text="...", title="...", placeholder="...", link="...", button="...", or textbox="..."'),
        clickPoint: nullableOptionalClickPoint('Optional precise click point for region/canvas/SVG replay'),
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
      description: 'Highlight an element on a specific tab using a locator string without clicking it. Prefer raw current-snapshot ref tokens like [ref=e12] or ref=e12, or simple locators such as heading="Daily Summary", text="Security", link="Pricing", button="Continue", or textbox="Search". Shows the Brow border overlay and optional label for a short duration.',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the target element'),
        selector: z.string().describe('Locator string for the element to highlight. Supports CSS selectors, raw current-snapshot ref tokens like [ref=e12] or ref=e12, and simple locators such as heading="...", text="...", title="...", placeholder="...", link="...", button="...", or textbox="..."'),
        message: nullableOptionalString('Optional overlay label text. Default: a generated "Brow highlighting ..." message'),
        durationMs: nullableOptionalNumber('How long to keep the highlight visible in milliseconds. Default: 2200, clamped to 600-10000'),
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
    }) => JSON.stringify(await appendFreshSnapshot(tabId, await tabsHover(tabId, selector, message, durationMs)), null, 2),
    {
      name: 'tabs_hover',
      description: 'Hover an element on a specific tab using a locator string without clicking it. Useful for opening menus and navigation states. Prefer raw current-snapshot ref tokens like [ref=e12] or ref=e12, or simple locators such as heading="Daily Summary", text="Security", link="Pricing", button="Continue", or textbox="Search".',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the target element'),
        selector: z.string().describe('Locator string for the element to hover. Supports CSS selectors, raw current-snapshot ref tokens like [ref=e12] or ref=e12, and simple locators such as heading="...", text="...", title="...", placeholder="...", link="...", button="...", or textbox="..."'),
        message: nullableOptionalString('Optional overlay label text. Default: a generated "Brow hovering ..." message'),
        durationMs: nullableOptionalNumber('How long to keep the visual hover preview visible in milliseconds. Default: 1400, clamped to 500-10000'),
      }),
    },
  );

  const tabsTypeTool = tool(
    async ({ tabId, selector, text, submit }: { tabId: number; selector: string; text: string; submit?: boolean }) =>
      JSON.stringify(await appendFreshSnapshot(tabId, await tabsType(tabId, selector, text, submit ?? false)), null, 2),
    {
      name: 'tabs_type',
      description: 'Type into an input, textarea, or contenteditable element on a specific tab using a locator string. Prefer selectors returned by tabs_listInteractiveElements, raw current-snapshot ref tokens like [ref=e12] or ref=e12, or simple locators like placeholder="Search" or textbox="Search".',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the target field'),
        selector: z.string().describe('Locator string for the target field. Supports CSS selectors, raw current-snapshot ref tokens like [ref=e12] or ref=e12, and simple locators such as placeholder="..." or textbox="..."'),
        text: z.string().describe('Text to place into the field'),
        submit: nullableOptionalBoolean('Press Enter / submit the form after typing'),
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
    }) => JSON.stringify(await appendFreshSnapshot(tabId, await tabsFillForm(tabId, fields, submit ?? false, submitSelector)), null, 2),
    {
      name: 'tabs_fillForm',
      description: 'Fill multiple form fields on a specific tab. Supports text inputs, textareas, contenteditable fields, selects, checkboxes, radios, and optional submit. Prefer selectors returned by tabs_listInteractiveElements, raw current-snapshot ref tokens like [ref=e12] or ref=e12, or simple locators like placeholder="..." or textbox="...".',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the form'),
        fields: z.array(
          z.object({
            selector: z.string().describe('Locator string for the target field. Supports CSS selectors, raw current-snapshot ref tokens like [ref=e12] or ref=e12, and simple locators such as placeholder="..." or textbox="..."'),
            value: z.union([z.string(), z.number(), z.boolean()]).describe('Value to apply. Use booleans for checkboxes/radios.'),
            mode: browserFillModeSchema.describe('Optional override for how to fill the field. Default: auto.'),
          }),
        ).describe('List of fields to fill'),
        submit: nullableOptionalBoolean('Submit the closest parent form after filling all fields'),
        submitSelector: nullableOptionalString('Optional locator string for a submit button to click after filling'),
      }),
    },
  );

  const tabsActivateTool = tool(
    async ({ tabId }: { tabId: number }) =>
      JSON.stringify(await appendFreshSnapshot(tabId, await tabsActivate(tabId)), null, 2),
    {
      name: 'tabs_activate',
      description: 'Activate (switch to) a specific browser tab by its tabId.',
      schema: z.object({ tabId: z.number().describe('The ID of the tab to activate') }),
    },
  );

  const tabsCreateTool = tool(
    async ({ url, active }: { url: string; active?: boolean }) => {
      const result = await tabsCreate(url, active ?? true);
      return JSON.stringify(await appendFreshSnapshot(result.tabId, result, 800), null, 2);
    },
    {
      name: 'tabs_create',
      description: 'Create a new browser tab with the specified URL. The agent decides appropriate URLs.',
      schema: z.object({
        url: z.string().describe('URL to open'),
        active: nullableOptionalBoolean('Whether to activate the tab (default: true)'),
      }),
    },
  );

  const tabsUpdateUrlTool = tool(
    async ({ tabId, url }: { tabId: number; url: string }) =>
      JSON.stringify(await appendFreshSnapshot(tabId, await tabsUpdateUrl(tabId, url), 800), null, 2),
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
      method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | null;
      headers?: Record<string, string> | string | null;
      body?: string | null;
      timeoutMs?: number | null;
      maxChars?: number | null;
    }) => JSON.stringify(await httpFetch(url, {
      method: normalizeOptional(method),
      headers: normalizeOptionalStringRecord(headers),
      body: normalizeOptional(body),
      timeoutMs: normalizeOptional(timeoutMs),
      maxChars: normalizeOptional(maxChars),
    }), null, 2),
    {
      name: 'http_fetch',
      description: 'Make a curl-like HTTP request to a URL. Supports GET, HEAD, POST, PUT, PATCH, DELETE, and OPTIONS with optional headers and raw string body. Returns status, headers, and a truncated response body when text is available.',
      schema: z.object({
        url: z.string().describe('The http:// or https:// URL to request'),
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).nullable().optional()
          .describe('HTTP method to use. Default: GET'),
        headers: nullableOptionalString('Optional request headers as a JSON object string, for example {"accept":"application/json"}'),
        body: nullableOptionalString('Optional raw request body. Typically used with POST, PUT, or PATCH'),
        timeoutMs: nullableOptionalNumber('Request timeout in milliseconds. Default: 15000, max: 60000'),
        maxChars: nullableOptionalNumber('Maximum number of response body characters to return. Default: 20000, max: 50000'),
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
        maxResults: nullableOptionalNumber('Maximum number of results to return (default: 50)'),
        startTime: nullableOptionalNumber('Only return results visited after this timestamp (ms since epoch)'),
      }),
    },
  );

  const browserSnapshotTool = tool(
    async ({
      tabId,
      mode,
      maxElements,
      rootRef,
      snapshotId,
    }: {
      tabId?: number | null;
      mode?: 'compact' | 'full' | null;
      maxElements?: number | null;
      rootRef?: string | null;
      snapshotId?: string | null;
    }) => {
      const resolvedTabId = await resolveAliasTabId(normalizeOptional(tabId));
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      const snapshot = await browserSnapshot(resolvedTabId, {
        mode: normalizeOptional(mode),
        maxElements: normalizeOptional(maxElements),
        rootRef: normalizeOptional(rootRef),
        snapshotId: normalizeOptional(snapshotId),
      });
      primeBrowserContextFromSnapshot(snapshot);
      return JSON.stringify({ ok: snapshot.ok, ...buildToolSnapshotFields(snapshot) }, null, 2);
    },
    {
      name: 'browser_snapshot',
      description: 'Capture a Playwright MCP-style DOM-derived browser snapshot for a tab. Returns compact role/name text with element refs like [ref=e12], prioritizing semantic targets over decorative/container nodes. Use refs from this snapshot for browser_click, browser_type, browser_hover, browser_fill_form, or browser_visual_query. If replaying a demonstration and the recorded target is absent, request mode="full" or a larger maxElements instead of guessing.',
      schema: z.object({
        tabId: nullableOptionalNumber('Tab ID to snapshot (default: active tab)'),
        mode: z.enum(['compact', 'full']).nullable().optional().describe('compact shows meaningful/actionable nodes; full shows more visible nodes. Default: compact'),
        maxElements: nullableOptionalNumber('Maximum elements to return (default 70, max 250)'),
        rootRef: nullableOptionalString('Optional ref to snapshot only a subtree/region from a previous snapshot'),
        snapshotId: nullableOptionalString('Snapshot id that rootRef came from'),
      }),
    },
  );

  const browserFormSnapshotTool = tool(
    async ({
      tabId,
      maxFields,
      includeHidden,
      formRef,
      snapshotId,
    }: {
      tabId?: number | null;
      maxFields?: number | null;
      includeHidden?: boolean | null;
      formRef?: string | null;
      snapshotId?: string | null;
    }) => {
      const resolvedTabId = await resolveAliasTabId(normalizeOptional(tabId));
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      const snapshot = await browserFormSnapshot(resolvedTabId, {
        maxFields: normalizeOptional(maxFields),
        includeHidden: normalizeOptional(includeHidden),
        formRef: normalizeOptional(formRef),
        snapshotId: normalizeOptional(snapshotId),
      });
      return JSON.stringify(snapshot, null, 2);
    },
    {
      name: 'browser_form_snapshot',
      description: 'Inspect whole-form semantics for a tab before filling forms. Returns forms, fields, Field Purpose, confidence/evidence, safe current value state, selection-required combobox metadata, visible controlled-popup options with refs, and refs that can be passed to browser_fill_form. This is read-only and does not store identity or autofill profile data.',
      schema: z.object({
        tabId: nullableOptionalNumber('Tab ID to inspect (default: active tab)'),
        maxFields: nullableOptionalNumber('Maximum fields to return (default 120, max 300)'),
        includeHidden: nullableOptionalBoolean('Include hidden and currently off-viewport fields. Default: true'),
        formRef: nullableOptionalString('Optional form ref to inspect only one form from a previous snapshot or form snapshot'),
        snapshotId: nullableOptionalString('Snapshot id that formRef came from'),
      }),
    },
  );

  const browserClickTool = tool(
    async ({
      tabId,
      ref,
      snapshotId,
      intent,
      postconditions,
      useActionMemory,
      clickPoint,
      targetEvidence,
      backendPreference,
    }: {
      tabId?: number | null;
      ref?: string | null;
      snapshotId?: string | null;
      intent?: string | null;
      postconditions?: BrowActionPostcondition[] | null;
      useActionMemory?: boolean | null;
      clickPoint?: BrowserClickPoint | null;
      targetEvidence?: BrowReplayTargetEvidence | null;
      backendPreference?: BrowBackendPreference | null;
    }) => runAutomationTool('browser_click', tabId, (resolvedTabId) => browserClick(resolvedTabId, normalizeOptional(ref), normalizeOptional(snapshotId), {
        intent: normalizeOptional(intent),
        postconditions: normalizeOptional(postconditions),
        useActionMemory: normalizeOptional(useActionMemory),
        clickPoint: normalizeOptional(clickPoint),
        targetEvidence: normalizeOptional(targetEvidence),
        backendPreference: normalizeOptional(backendPreference),
      })),
    {
      name: 'browser_click',
      description: 'Click an actionable element by ref from browser_snapshot. Prefer this over selector-based tabs_click. Do not use this to re-click a form field whose requested value is already visible in the current snapshot; if the field is already correct, move to the real submit/search control or take a fuller snapshot. Returns a fresh snapshot after the action. For canvas/SVG/region replay, pass clickPoint from Workflow Demonstration pointer evidence.',
      schema: z.object({
        tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
        ref: nullableOptionalString('Element ref from browser_snapshot, e.g. "e12". Optional when targetEvidence is provided.'),
        snapshotId: nullableOptionalString('Snapshot id the ref came from; improves stale-ref recovery'),
        intent: nullableOptionalString('Stable natural-language action intent for Brow Action Memory, e.g. "click the Sign in button"'),
        postconditions: postconditionSchema,
        useActionMemory: nullableOptionalBoolean('Set false to bypass cached action replay/storage for this call'),
        clickPoint: nullableOptionalClickPoint('Optional precise click point. Use targetFraction or target offset from Workflow Demonstration pointer evidence for canvas/SVG/region clicks.'),
        targetEvidence: nullableOptionalTargetEvidence('Optional Workflow Demonstration target evidence to conservatively repair stale or missing refs.'),
        backendPreference: backendPreferenceSchema,
      }),
    },
  );

  const browserHoverTool = tool(
    async ({
      tabId,
      ref,
      snapshotId,
      message,
      durationMs,
      intent,
      postconditions,
      useActionMemory,
      targetEvidence,
      backendPreference,
    }: {
      tabId?: number | null;
      ref?: string | null;
      snapshotId?: string | null;
      message?: string | null;
      durationMs?: number | null;
      intent?: string | null;
      postconditions?: BrowActionPostcondition[] | null;
      useActionMemory?: boolean | null;
      targetEvidence?: BrowReplayTargetEvidence | null;
      backendPreference?: BrowBackendPreference | null;
    }) => runAutomationTool('browser_hover', tabId, (resolvedTabId) => browserHover(resolvedTabId, normalizeOptional(ref), normalizeOptional(snapshotId), normalizeOptional(message), normalizeOptional(durationMs), {
        intent: normalizeOptional(intent),
        postconditions: normalizeOptional(postconditions),
        useActionMemory: normalizeOptional(useActionMemory),
        targetEvidence: normalizeOptional(targetEvidence),
        backendPreference: normalizeOptional(backendPreference),
      })),
    {
      name: 'browser_hover',
      description: 'Hover an actionable element by ref from browser_snapshot. Useful for menus/tooltips. Returns a fresh snapshot after the hover.',
      schema: z.object({
        tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
        ref: nullableOptionalString('Element ref from browser_snapshot. Optional when targetEvidence is provided.'),
        snapshotId: nullableOptionalString('Snapshot id the ref came from'),
        message: nullableOptionalString('Optional overlay label'),
        durationMs: nullableOptionalNumber('How long to show the hover preview'),
        intent: nullableOptionalString('Stable natural-language action intent for Brow Action Memory'),
        postconditions: postconditionSchema,
        useActionMemory: nullableOptionalBoolean('Set false to bypass cached action replay/storage for this call'),
        targetEvidence: nullableOptionalTargetEvidence('Optional Workflow Demonstration target evidence to conservatively repair stale or missing refs.'),
        backendPreference: backendPreferenceSchema,
      }),
    },
  );

  const browserTypeTool = tool(
    async ({
      tabId,
      ref,
      text,
      submit,
      snapshotId,
      intent,
      postconditions,
      useActionMemory,
      targetEvidence,
      backendPreference,
    }: {
      tabId?: number | null;
      ref?: string | null;
      text: string;
      submit?: boolean | null;
      snapshotId?: string | null;
      intent?: string | null;
      postconditions?: BrowActionPostcondition[] | null;
      useActionMemory?: boolean | null;
      targetEvidence?: BrowReplayTargetEvidence | null;
      backendPreference?: BrowBackendPreference | null;
    }) => runAutomationTool('browser_type', tabId, (resolvedTabId) => browserType(resolvedTabId, normalizeOptional(ref), text, submit ?? false, normalizeOptional(snapshotId), {
        intent: normalizeOptional(intent),
        postconditions: normalizeOptional(postconditions),
        useActionMemory: normalizeOptional(useActionMemory),
        targetEvidence: normalizeOptional(targetEvidence),
        backendPreference: normalizeOptional(backendPreference),
      })),
    {
      name: 'browser_type',
      description: 'Type text into an editable element by ref from browser_snapshot. Use this only when the field value still needs to change; if the current snapshot already shows the requested value, do not type again and instead move to the next control or take a fuller snapshot. For autocomplete/combobox fields, typing may only open suggestions; if the returned snapshot shows selection-required state or a visible popup, click a matching option to finish. Returns a fresh snapshot after typing.',
      schema: z.object({
        tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
        ref: nullableOptionalString('Editable element ref from browser_snapshot. Optional when targetEvidence is provided.'),
        text: z.string().describe('Text to place into the field'),
        submit: nullableOptionalBoolean('Press Enter / submit after typing'),
        snapshotId: nullableOptionalString('Snapshot id the ref came from'),
        intent: nullableOptionalString('Stable natural-language action intent for Brow Action Memory. Do not include secret field values in the intent.'),
        postconditions: postconditionSchema,
        useActionMemory: nullableOptionalBoolean('Set false to bypass cached action replay/storage for this call'),
        targetEvidence: nullableOptionalTargetEvidence('Optional Workflow Demonstration target evidence to conservatively repair stale or missing refs.'),
        backendPreference: backendPreferenceSchema,
      }),
    },
  );

  const browserFillFormTool = tool(
    async ({
      tabId,
      fields,
      submit,
      submitRef,
      snapshotId,
      intent,
      postconditions,
      useActionMemory,
      targetEvidence,
      backendPreference,
    }: {
      tabId?: number | null;
      fields: Array<{
        ref: string;
        value: string | number | boolean;
        mode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable';
        targetEvidence?: BrowReplayTargetEvidence | null;
      }>;
      submit?: boolean | null;
      submitRef?: string | null;
      snapshotId?: string | null;
      intent?: string | null;
      postconditions?: BrowActionPostcondition[] | null;
      useActionMemory?: boolean | null;
      targetEvidence?: BrowReplayTargetEvidence | null;
      backendPreference?: BrowBackendPreference | null;
    }) => {
      const normalizedFields = fields.map((field) => ({
        ...field,
        targetEvidence: normalizeOptional(field.targetEvidence),
      }));
      return runAutomationTool('browser_fill_form', tabId, (resolvedTabId) => browserFillForm(resolvedTabId, normalizedFields, submit ?? false, normalizeOptional(submitRef), normalizeOptional(snapshotId), {
        intent: normalizeOptional(intent),
        postconditions: normalizeOptional(postconditions),
        useActionMemory: normalizeOptional(useActionMemory),
        targetEvidence: normalizeOptional(targetEvidence),
        backendPreference: normalizeOptional(backendPreference),
      }));
    },
    {
      name: 'browser_fill_form',
      description: 'Fill multiple form fields by refs from browser_snapshot. Supports text inputs, contenteditable, selects, checkboxes, and radios. Do not treat this as complete for selection-required comboboxes or autocomplete fields; if the snapshot shows a visible controlled popup, follow up by selecting a matching option. Returns a fresh snapshot after filling.',
      schema: browserFillFormToolSchema,
    },
  );

  const browserDragTool = tool(
    async ({
      tabId,
      sourceRef,
      destinationRef,
      snapshotId,
      sourceTargetEvidence,
      destinationTargetEvidence,
      sourceClickPoint,
      destinationClickPoint,
      pointerPath,
      durationMs,
      intent,
      postconditions,
      useActionMemory,
      backendPreference,
    }: {
      tabId?: number | null;
      sourceRef?: string | null;
      destinationRef?: string | null;
      snapshotId?: string | null;
      sourceTargetEvidence?: BrowReplayTargetEvidence | null;
      destinationTargetEvidence?: BrowReplayTargetEvidence | null;
      sourceClickPoint?: BrowserClickPoint | null;
      destinationClickPoint?: BrowserClickPoint | null;
      pointerPath?: Array<{ x: number; y: number }> | null;
      durationMs?: number | null;
      intent?: string | null;
      postconditions?: BrowActionPostcondition[] | null;
      useActionMemory?: boolean | null;
      backendPreference?: BrowBackendPreference | null;
    }) => {
      const normalizedSourceTargetEvidence = parseOptionalTargetEvidenceJson(normalizeOptionalJsonString(sourceTargetEvidence)) as BrowReplayTargetEvidence | undefined;
      const normalizedDestinationTargetEvidence = parseOptionalTargetEvidenceJson(normalizeOptionalJsonString(destinationTargetEvidence)) as BrowReplayTargetEvidence | undefined;
      return runAutomationTool('browser_drag', tabId, (resolvedTabId) => browserDrag(
        resolvedTabId,
        normalizeOptional(sourceRef),
        normalizeOptional(destinationRef),
        normalizeOptional(snapshotId),
        {
          intent: normalizeOptional(intent),
          postconditions: normalizeOptional(postconditions),
          useActionMemory: normalizeOptional(useActionMemory),
          backendPreference: normalizeOptional(backendPreference),
          targetEvidence: normalizedSourceTargetEvidence,
          destinationTargetEvidence: normalizedDestinationTargetEvidence,
          sourceClickPoint: normalizeOptional(sourceClickPoint),
          destinationClickPoint: normalizeOptional(destinationClickPoint),
          pointerPath: normalizeOptional(pointerPath),
          durationMs: normalizeOptional(durationMs),
        } satisfies BrowserDragOptions,
      ));
    },
    {
      name: 'browser_drag',
      description: 'Drag from one visible target to another using current refs or Workflow Demonstration target evidence. Uses MV3 synthetic drag events now and reports when a stronger local helper is needed.',
      schema: browserDragToolSchema,
    },
  );

  const browserScrollTool = tool(
    async ({
      tabId,
      ref,
      snapshotId,
      targetEvidence,
      deltaX,
      deltaY,
      top,
      left,
      postconditions,
      backendPreference,
    }: {
      tabId?: number | null;
      ref?: string | null;
      snapshotId?: string | null;
      targetEvidence?: BrowReplayTargetEvidence | null;
      deltaX?: number | null;
      deltaY?: number | null;
      top?: number | null;
      left?: number | null;
      postconditions?: BrowActionPostcondition[] | null;
      backendPreference?: BrowBackendPreference | null;
    }) => runAutomationTool('browser_scroll', tabId, (resolvedTabId) => browserScroll(resolvedTabId, {
        ref: normalizeOptional(ref),
        snapshotId: normalizeOptional(snapshotId),
        targetEvidence: normalizeOptional(targetEvidence),
        deltaX: normalizeOptional(deltaX),
        deltaY: normalizeOptional(deltaY),
        top: normalizeOptional(top),
        left: normalizeOptional(left),
        postconditions: normalizeOptional(postconditions),
        backendPreference: normalizeOptional(backendPreference),
      })),
    {
      name: 'browser_scroll',
      description: 'Scroll the window or a resolved scrollable target. Use this to reveal hidden targets before taking a fresh browser_snapshot.',
      schema: z.object({
        tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
        ref: nullableOptionalString('Optional scroll target ref from browser_snapshot'),
        snapshotId: nullableOptionalString('Snapshot id the ref came from'),
        targetEvidence: nullableOptionalTargetEvidence('Optional Workflow Demonstration target evidence for the scroll container'),
        deltaX: nullableOptionalNumber('Horizontal scroll delta in CSS pixels'),
        deltaY: nullableOptionalNumber('Vertical scroll delta in CSS pixels; default 650'),
        top: nullableOptionalNumber('Absolute target scrollTop/window.scrollY'),
        left: nullableOptionalNumber('Absolute target scrollLeft/window.scrollX'),
        postconditions: postconditionSchema,
        backendPreference: backendPreferenceSchema,
      }),
    },
  );

  const browserKeyTool = tool(
    async ({
      tabId,
      ref,
      snapshotId,
      targetEvidence,
      key,
      code,
      text,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
      postconditions,
      backendPreference,
    }: {
      tabId?: number | null;
      ref?: string | null;
      snapshotId?: string | null;
      targetEvidence?: BrowReplayTargetEvidence | null;
      key?: string | null;
      code?: string | null;
      text?: string | null;
      altKey?: boolean | null;
      ctrlKey?: boolean | null;
      metaKey?: boolean | null;
      shiftKey?: boolean | null;
      postconditions?: BrowActionPostcondition[] | null;
      backendPreference?: BrowBackendPreference | null;
    }) => runAutomationTool('browser_key', tabId, (resolvedTabId) => browserKey(resolvedTabId, {
        ref: normalizeOptional(ref),
        snapshotId: normalizeOptional(snapshotId),
        targetEvidence: normalizeOptional(targetEvidence),
        key: normalizeOptional(key),
        code: normalizeOptional(code),
        text: normalizeOptional(text),
        altKey: normalizeOptional(altKey),
        ctrlKey: normalizeOptional(ctrlKey),
        metaKey: normalizeOptional(metaKey),
        shiftKey: normalizeOptional(shiftKey),
        postconditions: normalizeOptional(postconditions),
        backendPreference: normalizeOptional(backendPreference),
      })),
    {
      name: 'browser_key',
      description: 'Send a key, keyboard shortcut, or text insertion to the active element or a resolved target.',
      schema: z.object({
        tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
        ref: nullableOptionalString('Optional target ref from browser_snapshot'),
        snapshotId: nullableOptionalString('Snapshot id the ref came from'),
        targetEvidence: nullableOptionalTargetEvidence('Optional Workflow Demonstration target evidence for stale-ref repair'),
        key: nullableOptionalString('Keyboard key such as Enter, Escape, ArrowDown, or a single character'),
        code: nullableOptionalString('Keyboard code such as Enter, Escape, KeyA'),
        text: nullableOptionalString('Text to insert when no key is provided'),
        altKey: nullableOptionalBoolean('Hold Alt/Option'),
        ctrlKey: nullableOptionalBoolean('Hold Control'),
        metaKey: nullableOptionalBoolean('Hold Command/Windows'),
        shiftKey: nullableOptionalBoolean('Hold Shift'),
        postconditions: postconditionSchema,
        backendPreference: backendPreferenceSchema,
      }),
    },
  );

  const browserWaitForTool = tool(
    async ({
      tabId,
      postconditions,
      timeoutMs,
      pollMs,
    }: {
      tabId?: number | null;
      postconditions?: BrowActionPostcondition[] | null;
      timeoutMs?: number | null;
      pollMs?: number | null;
    }) => {
      if (!postconditions?.length) return formatAutomationToolOutput('browser_wait_for', { ok: false, error: 'browser_wait_for requires at least one postcondition.' });
      return runAutomationTool('browser_wait_for', tabId, (resolvedTabId) => browserWaitFor(resolvedTabId, postconditions, {
        timeoutMs: normalizeOptional(timeoutMs),
        pollMs: normalizeOptional(pollMs),
      }));
    },
    {
      name: 'browser_wait_for',
      description: 'Wait until postconditions become true, returning the latest snapshot and failed checks on timeout.',
      schema: z.object({
        tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
        postconditions: postconditionSchema,
        timeoutMs: nullableOptionalNumber('Maximum wait in milliseconds; default 5000'),
        pollMs: nullableOptionalNumber('Polling interval in milliseconds; default 250'),
      }),
    },
  );

  const browserUploadFileTool = tool(
    async ({
      tabId,
      ref,
      snapshotId,
      targetEvidence,
      fileName,
      filePath,
      postconditions,
      backendPreference,
    }: {
      tabId?: number | null;
      ref?: string | null;
      snapshotId?: string | null;
      targetEvidence?: BrowReplayTargetEvidence | null;
      fileName?: string | null;
      filePath?: string | null;
      postconditions?: BrowActionPostcondition[] | null;
      backendPreference?: BrowBackendPreference | null;
    }) => runAutomationTool('browser_upload_file', tabId, (resolvedTabId) => browserUploadFile(
        resolvedTabId,
        normalizeOptional(ref),
        normalizeOptional(fileName),
        normalizeOptional(filePath),
        normalizeOptional(snapshotId),
        {
          targetEvidence: normalizeOptional(targetEvidence),
          postconditions: normalizeOptional(postconditions),
          backendPreference: normalizeOptional(backendPreference),
        },
      )),
    {
      name: 'browser_upload_file',
      description: 'Open or complete a file upload control. MV3 can resolve/open the picker; selecting a local file path requires the local helper backend.',
      schema: z.object({
        tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
        ref: nullableOptionalString('Upload control ref from browser_snapshot. Optional when targetEvidence is provided.'),
        snapshotId: nullableOptionalString('Snapshot id the ref came from'),
        targetEvidence: nullableOptionalTargetEvidence('Optional Workflow Demonstration target evidence for the upload control'),
        fileName: nullableOptionalString('Non-secret display file name for verification. Do not include file contents.'),
        filePath: nullableOptionalString('Local file path, redacted in tool results and only usable by the local helper backend.'),
        postconditions: postconditionSchema,
        backendPreference: backendPreferenceSchema,
      }),
    },
  );

  const browserDownloadWaitTool = tool(
    async ({
      tabId,
      filenameIncludes,
      timeoutMs,
      pollMs,
    }: {
      tabId?: number | null;
      filenameIncludes?: string | null;
      timeoutMs?: number | null;
      pollMs?: number | null;
    }) => runAutomationTool('browser_download_wait', tabId, (resolvedTabId) => browserDownloadWait(resolvedTabId, {
        filenameIncludes: normalizeOptional(filenameIncludes),
        timeoutMs: normalizeOptional(timeoutMs),
        pollMs: normalizeOptional(pollMs),
      })),
    {
      name: 'browser_download_wait',
      description: 'Wait for a recent browser download to appear. Requires the downloads permission/API.',
      schema: z.object({
        tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
        filenameIncludes: nullableOptionalString('Optional filename or URL substring to match'),
        timeoutMs: nullableOptionalNumber('Maximum wait in milliseconds; default 30000'),
        pollMs: nullableOptionalNumber('Polling interval in milliseconds; default 500'),
      }),
    },
  );

  const browserHandleDialogTool = tool(
    async ({
      tabId,
      ref,
      snapshotId,
      targetEvidence,
      action,
      text,
      postconditions,
      backendPreference,
    }: {
      tabId?: number | null;
      ref?: string | null;
      snapshotId?: string | null;
      targetEvidence?: BrowReplayTargetEvidence | null;
      action?: 'accept' | 'dismiss' | 'close' | null;
      text?: string | null;
      postconditions?: BrowActionPostcondition[] | null;
      backendPreference?: BrowBackendPreference | null;
    }) => runAutomationTool('browser_handle_dialog', tabId, (resolvedTabId) => browserHandleDialog(resolvedTabId, {
        ref: normalizeOptional(ref),
        snapshotId: normalizeOptional(snapshotId),
        targetEvidence: normalizeOptional(targetEvidence),
        action: normalizeOptional(action),
        text: normalizeOptional(text),
        postconditions: normalizeOptional(postconditions),
        backendPreference: normalizeOptional(backendPreference),
      })),
    {
      name: 'browser_handle_dialog',
      description: 'Handle an HTML dialog/modal when visible. Native browser alert/confirm/prompt handling requires the local helper backend.',
      schema: z.object({
        tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
        ref: nullableOptionalString('Optional dialog or dialog control ref from browser_snapshot'),
        snapshotId: nullableOptionalString('Snapshot id the ref came from'),
        targetEvidence: nullableOptionalTargetEvidence('Optional Workflow Demonstration target evidence for the dialog'),
        action: z.enum(['accept', 'dismiss', 'close']).nullable().optional().describe('Dialog action; default accept'),
        text: nullableOptionalString('Optional dialog label/value for verification'),
        postconditions: postconditionSchema,
        backendPreference: backendPreferenceSchema,
      }),
    },
  );

  const browserVisualQueryTool = tool(
    async ({
      tabId,
      ref,
      snapshotId,
      rect,
      region: regionInput,
      bounds,
      query,
      question,
      prompt,
      paddingPx,
    }: {
      tabId?: number | null;
      ref?: string | null;
      snapshotId?: string | null;
      rect?: { x?: number | null; y?: number | null; left?: number | null; top?: number | null; width: number; height: number } | null;
      region?: { x?: number | null; y?: number | null; left?: number | null; top?: number | null; width: number; height: number } | null;
      bounds?: { x?: number | null; y?: number | null; left?: number | null; top?: number | null; width: number; height: number } | null;
      query?: string | null;
      question?: string | null;
      prompt?: string | null;
      paddingPx?: number | null;
    }) => {
      const vlmConfig = deps.getVLMConfig();
      if (!vlmConfig || !vlmConfig.baseUrl || !vlmConfig.model) {
        return JSON.stringify({ ok: false, error: 'VLM not configured. Please set VLM endpoint, model, and API key in the config panel.' }, null, 2);
      }

      const resolvedTabId = await resolveAliasTabId(normalizeOptional(tabId));
      if (typeof resolvedTabId !== 'number') return JSON.stringify(resolvedTabId, null, 2);
      const visualQuery = normalizeOptional(query) ?? normalizeOptional(question) ?? normalizeOptional(prompt);
      if (!visualQuery) {
        return JSON.stringify({ ok: false, error: 'Provide query, question, or prompt for browser_visual_query.' }, null, 2);
      }

      let visualRegion;
      let resolution;
      if (ref) {
        resolution = await browserResolveRef(resolvedTabId, ref, normalizeOptional(snapshotId), false);
        if (!resolution.ok || !resolution.region) {
          return JSON.stringify({ ok: false, error: resolution.error ?? `Unable to resolve visual ref ${ref}`, resolution }, null, 2);
        }
        visualRegion = resolution.region;
      } else if (rect || regionInput || bounds) {
        const rectInput = rect ?? regionInput ?? bounds!;
        const snapshot = await browserSnapshot(resolvedTabId, { mode: 'compact', maxElements: 1 });
        if (!snapshot.ok) {
          return JSON.stringify({ ok: false, error: snapshot.error ?? 'Failed to read viewport before visual query', snapshot }, null, 2);
        }
        visualRegion = {
          source: 'rect' as const,
          rect: normalizeViewportRect({
            ...rectInput,
            x: rectInput.x ?? undefined,
            y: rectInput.y ?? undefined,
            left: rectInput.left ?? undefined,
            top: rectInput.top ?? undefined,
          }),
          viewport: snapshot.viewport,
        };
      } else {
        return JSON.stringify({ ok: false, error: 'Provide either ref or rect for browser_visual_query.' }, null, 2);
      }

      const screenshot = await tabCaptureScreenshotRegion(resolvedTabId, visualRegion.rect, visualRegion.viewport, paddingPx ?? 8);
      if (!screenshot.ok || !screenshot.dataUrl) {
        return JSON.stringify({ ok: false, error: screenshot.error ?? 'Failed to capture regional screenshot', region: visualRegion, resolution }, null, 2);
      }

      const result = await vlmQuery(vlmConfig, screenshot.dataUrl, visualQuery);
      return JSON.stringify({ ...result, region: visualRegion, resolution }, null, 2);
    },
    {
      name: 'browser_visual_query',
      description: 'Ask the configured VLM about a specific visual region. Provide either a snapshot ref or viewport rect. This is perception-only: use it to extract/describe visual information, not to choose coordinate clicks.',
      schema: z.object({
        tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
        ref: nullableOptionalString('Any visible element/region ref from browser_snapshot'),
        snapshotId: nullableOptionalString('Snapshot id the ref came from'),
        rect: z.object({
          x: z.number().nullable().optional(),
          y: z.number().nullable().optional(),
          left: z.number().nullable().optional(),
          top: z.number().nullable().optional(),
          width: z.number(),
          height: z.number(),
        }).nullable().optional().describe('Viewport rectangle in CSS pixels if no ref is available'),
        region: z.object({
          x: z.number().nullable().optional(),
          y: z.number().nullable().optional(),
          left: z.number().nullable().optional(),
          top: z.number().nullable().optional(),
          width: z.number(),
          height: z.number(),
        }).nullable().optional().describe('Alias for rect. Accepts viewport rectangle in CSS pixels.'),
        bounds: z.object({
          x: z.number().nullable().optional(),
          y: z.number().nullable().optional(),
          left: z.number().nullable().optional(),
          top: z.number().nullable().optional(),
          width: z.number(),
          height: z.number(),
        }).nullable().optional().describe('Alias for rect/region from Workflow Demonstration target bounds.'),
        query: nullableOptionalString('Question or extraction instruction for the VLM about this region'),
        question: nullableOptionalString('Alias for query'),
        prompt: nullableOptionalString('Alias for query'),
        paddingPx: nullableOptionalNumber('Extra pixels around the region to include (default 8)'),
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
        tabId: nullableOptionalNumber('Tab ID to screenshot (default: current active tab)'),
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
        tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
      }),
    },
  );

  const webmcpInvokeTool = tool(
    async ({ tabId, toolName, args }: { tabId: number; toolName: string; args?: Record<string, unknown> | string | null }) => {
      const normalizedArgs = normalizeOptionalJsonRecord(args) ?? {};
      const result = await webmcpInvoke(tabId, toolName, normalizedArgs);
      const descriptor = {
        name: toolName,
        description: '',
        inputSchema: normalizedArgs,
      };

      if (!shouldCaptureWebMCPAftermath(descriptor, result)) {
        return JSON.stringify(result, null, 2);
      }

      return JSON.stringify(
        await appendFreshSnapshot(tabId, result, getWebMCPAftermathWaitMs(descriptor, result)),
        null,
        2,
      );
    },
    {
      name: 'webmcp_invoke',
      description: 'Invoke a WebMCP tool on a specific tab. Must be discovered first.',
      schema: z.object({
        tabId: z.number().describe('Tab ID where the tool lives'),
        toolName: z.string().describe('Name of the WebMCP tool'),
        args: nullableOptionalString('Arguments to pass as a JSON object string'),
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
      description: 'Load the full details of a Domain Skill or Interaction Skill by slug or display name. Use this when a skill listed in the system prompt looks relevant.',
      schema: z.object({
        identifier: z.string().describe('The skill slug or display name to load'),
      }),
    },
  );

  const skillsProposeTool = tool(
    async ({
      name,
      slug,
      description,
      tags,
      content,
      matcher,
      summary,
      evidence,
    }: DomainSkillProposalDraft) => {
      const proposal = await deps.submitDomainSkillProposal({
        name,
        slug,
        description,
        tags,
        content,
        matcher,
        summary,
        evidence,
      });
      return JSON.stringify({
        ok: true,
        proposal,
        message: 'Domain Skill proposal saved for review. It will not become active until approved in the Domain Skills panel.',
      }, null, 2);
    },
    {
      name: 'skills_propose',
      description: 'Create or update a pending Domain Skill proposal for user review. Use this when you learn durable site knowledge that should be reusable later. This does not activate the skill automatically.',
      schema: z.object({
        name: z.string().describe('Display name for the proposed Domain Skill'),
        slug: nullableOptionalString('Optional stable slug; omit to derive one from the name'),
        description: z.string().describe('Short one-line description for review cards and prompts'),
        tags: z.array(z.string()).nullable().optional().describe('Optional tags like github, billing, login'),
        content: z.string().describe('Full markdown skill content to review later'),
        matcher: z.object({
          domain: z.string().nullable().optional().describe('Optional domain scope such as github.com'),
          pathPatterns: z.array(z.string()).nullable().optional().describe('Optional path patterns such as /owner/repo/pull/*'),
          pagePatterns: z.array(z.string()).nullable().optional().describe('Optional page keywords such as pull request or settings'),
        }).nullable().optional().describe('Optional scope for where the Domain Skill should match'),
        summary: nullableOptionalString('Short explanation of what was learned and why it should be saved'),
        evidence: z.array(z.string()).nullable().optional().describe('Optional supporting facts or outcomes that justify the proposal'),
      }),
    },
  );

  const domainMemorySaveTool = tool(
    async ({
      title,
      lesson,
      appliesWhen,
      domain,
      pathPatterns,
      pagePatterns,
      tags,
      evidence,
      confidence,
      enabled,
      outcome,
    }: {
      title: string;
      lesson: string;
      appliesWhen?: string | null;
      domain?: string | null;
      pathPatterns?: string[] | string | null;
      pagePatterns?: string[] | string | null;
      tags?: string[] | string | null;
      evidence?: string[] | string | null;
      confidence?: number | null;
      enabled?: boolean | null;
      outcome?: DomainMemoryDraft['outcome'] | null;
    }) => {
      const scopedDomain = domain?.trim().toLowerCase() || await inferActiveDomain();
      const draft: DomainMemoryDraft = {
        title,
        lesson,
        appliesWhen: appliesWhen?.trim() || undefined,
        matcher: {
          domain: scopedDomain,
          pathPatterns: normalizeStringList(pathPatterns),
          pagePatterns: normalizeStringList(pagePatterns),
        },
        tags: normalizeStringList(tags),
        evidence: normalizeStringList(evidence),
        confidence: confidence ?? undefined,
        enabled: enabled ?? undefined,
        outcome: outcome ?? undefined,
      };
      try {
        const result = await saveDomainMemoryDraft(draft);
        return JSON.stringify({
          ok: true,
          entry: result.entry,
          merged: result.merged,
          message: result.merged
            ? `Domain Memory "${result.entry.title}" updated.`
            : `Domain Memory "${result.entry.title}" saved.`,
        }, null, 2);
      } catch (err: any) {
        return JSON.stringify({
          ok: false,
          error: err?.message ?? 'Domain Memory save failed',
        }, null, 2);
      }
    },
    {
      name: 'domain_memory_save',
      description: 'Save or merge a local Domain Memory card containing non-secret operational site knowledge such as selectors, flows, quirks, waits, or failure fixes. Never store user/account content or secrets.',
      schema: z.object({
        title: z.string().describe('Short card title for the learned operational fact'),
        lesson: z.string().describe('The durable operational lesson. Do not include secrets, personal data, account content, or raw dynamic user values.'),
        appliesWhen: nullableOptionalString('When this memory should be considered relevant, such as a page state, workflow, or failure condition'),
        domain: nullableOptionalString('Domain scope such as github.com. Omit to use the active tab domain.'),
        pathPatterns: z.union([z.array(z.string()), z.string()]).nullable().optional().describe('Optional path patterns such as /owner/repo/pull/*'),
        pagePatterns: z.union([z.array(z.string()), z.string()]).nullable().optional().describe('Optional page keywords such as pull request or settings'),
        tags: z.union([z.array(z.string()), z.string()]).nullable().optional().describe('Optional tags like login, search, checkout, iframe'),
        evidence: z.union([z.array(z.string()), z.string()]).nullable().optional().describe('Optional supporting non-secret facts or outcomes'),
        confidence: nullableOptionalNumber('Optional confidence from 0 to 1'),
        enabled: nullableOptionalBoolean('Whether this memory should be active'),
        outcome: z.enum(['neutral', 'success', 'failure']).nullable().optional().describe('Use success or failure when updating a memory after trying it; failures demote confidence but do not delete it.'),
      }),
    },
  );

  const domainMemoryLoadTool = tool(
    async ({
      id,
      domain,
      query,
      includeDisabled,
      limit,
    }: {
      id?: string | null;
      domain?: string | null;
      query?: string | null;
      includeDisabled?: boolean | null;
      limit?: number | null;
    }) => {
      const entries = await loadDomainMemoryEntries();
      const results = queryDomainMemoryEntries(entries, {
        id: id?.trim() || undefined,
        domain: domain?.trim().toLowerCase() || undefined,
        query: query?.trim() || undefined,
        includeDisabled: includeDisabled ?? false,
        limit: limit ?? undefined,
      });
      return JSON.stringify({
        ok: true,
        memories: results,
        count: results.length,
      }, null, 2);
    },
    {
      name: 'domain_memory_load',
      description: 'Load full local Domain Memory cards by id, domain, or query. Use this when the compact matched-memory index looks relevant.',
      schema: z.object({
        id: nullableOptionalString('Optional exact Domain Memory id to load'),
        domain: nullableOptionalString('Optional domain filter such as github.com'),
        query: nullableOptionalString('Optional text query over title, lesson, scope, tags, and evidence'),
        includeDisabled: nullableOptionalBoolean('Whether to include disabled memories'),
        limit: nullableOptionalNumber('Maximum cards to return'),
      }),
    },
  );

  const domainMemorySetEnabledTool = tool(
    async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const entry = await setDomainMemoryEnabled(id, enabled);
      if (!entry) {
        return JSON.stringify({ ok: false, error: `Domain Memory "${id}" not found` }, null, 2);
      }
      return JSON.stringify({
        ok: true,
        entry,
        message: `Domain Memory "${entry.title}" ${enabled ? 'enabled' : 'disabled'}.`,
      }, null, 2);
    },
    {
      name: 'domain_memory_set_enabled',
      description: 'Enable or disable a local Domain Memory card when it becomes useful or stale.',
      schema: z.object({
        id: z.string().describe('Domain Memory id'),
        enabled: z.boolean().describe('Whether the memory should be active'),
      }),
    },
  );

  const domainMemoryDeleteTool = tool(
    async ({ id }: { id: string }) => {
      const deleted = await deleteDomainMemoryEntry(id);
      return JSON.stringify({
        ok: deleted,
        deleted,
        message: deleted ? `Domain Memory "${id}" deleted.` : `Domain Memory "${id}" not found.`,
      }, null, 2);
    },
    {
      name: 'domain_memory_delete',
      description: 'Delete a local Domain Memory card when it is obsolete or harmful. Deletion is permanent in v1.',
      schema: z.object({
        id: z.string().describe('Domain Memory id'),
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
    browserSnapshotTool as unknown as StructuredToolInterface,
    browserFormSnapshotTool as unknown as StructuredToolInterface,
    browserClickTool as unknown as StructuredToolInterface,
    browserHoverTool as unknown as StructuredToolInterface,
    browserTypeTool as unknown as StructuredToolInterface,
    browserFillFormTool as unknown as StructuredToolInterface,
    browserDragTool as unknown as StructuredToolInterface,
    browserScrollTool as unknown as StructuredToolInterface,
    browserKeyTool as unknown as StructuredToolInterface,
    browserWaitForTool as unknown as StructuredToolInterface,
    browserUploadFileTool as unknown as StructuredToolInterface,
    browserDownloadWaitTool as unknown as StructuredToolInterface,
    browserHandleDialogTool as unknown as StructuredToolInterface,
    browserVisualQueryTool as unknown as StructuredToolInterface,
    tabScreenshotVlmTool as unknown as StructuredToolInterface,
    webmcpDiscoverTool as unknown as StructuredToolInterface,
    webmcpInvokeTool as unknown as StructuredToolInterface,
    skillsProposeTool as unknown as StructuredToolInterface,
    domainMemorySaveTool as unknown as StructuredToolInterface,
    domainMemoryLoadTool as unknown as StructuredToolInterface,
    domainMemorySetEnabledTool as unknown as StructuredToolInterface,
    domainMemoryDeleteTool as unknown as StructuredToolInterface,
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
