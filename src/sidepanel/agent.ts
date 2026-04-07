// ─── LangGraph Agent ────────────────────────────────────────────────────────
// Replicates the proven architecture from agent-singleton.ts:
//  • Singleton Agent class with lazy LLM init
//  • Streaming via agent.stream() with updates mode
//  • AbortController + abortable stream generator
//  • Pause/resume support
//  • ToolStepEvent tracking with callId mapping
//  • Dynamic rebuildAgent()

import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';

import {
  tabsList,
  tabsGetActive,
  tabsGetContent,
  tabsListInteractiveElements,
  tabsClick,
  tabsType,
  tabsFillForm,
  tabsActivate,
  tabsCreate,
  tabsUpdateUrl,
  httpFetch,
  tabCaptureScreenshot,
  vlmQuery,
  bookmarksGetAll,
  bookmarksSearch,
  historySearch,
  webmcpDiscover,
  webmcpInvoke,
} from './tab-tools';
import type { VLMConfig } from './tab-tools';
import {
  ensureLlm,
  getLlmSync,
  reconfigureLlm,
  resetLlm,
  type ChatOpenAIInstance,
  type LLMConfigUnion,
} from './llm-config';
import { createWebMCPTools } from './webmcp-tool-factory';
import {
  createMCPServerTools,
  mcpConnect,
  loadSavedServers,
  saveServers,
  generateServerId,
  type MCPServerConfig,
  type MCPServerEntry,
  type MCPToolDescriptor,
} from './mcp-client';
import {
  type SkillRegistryEntry,
  normalizeSkillRegistry,
} from './skills-registry';
import type { WebMCPToolDescriptor, VLMConfig as SharedVLMConfig } from '../shared/types';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolStepEvent {
  stepIndex: number;
  toolName: string;
  label: string;
  status: 'running' | 'completed';
  description?: string;
  durationMs?: number;
  startTime: number;
}

export type ToolStepCallback = (steps: ToolStepEvent[]) => void;
export type StreamTextCallback = (text: string) => void;

export interface ToolManifestEntry {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
}

export interface AgentAPI {
  query: (query: string, history?: ChatTurn[], contextTabIds?: number[]) => Promise<string>;
  onToolStep: (callback: ToolStepCallback) => void;
  offToolStep: (callback: ToolStepCallback) => void;
  onStreamText: (callback: StreamTextCallback) => void;
  offStreamText: (callback: StreamTextCallback) => void;
  abort: () => void;
  isBusy: () => boolean;
  pause: () => void;
  resume: () => void;
  togglePause: () => void;
  isPaused: () => boolean;
  updateWebMCPTools: (tabId: number, descriptors: WebMCPToolDescriptor[], url?: string, title?: string) => void;
  removeWebMCPToolsForTab: (tabId: number) => void;
  clearWebMCPTools: () => void;
  getToolManifest: () => ToolManifestEntry[];
  setToolEnabled: (toolName: string, enabled: boolean) => void;
  setToolsEnabled: (toolNames: string[], enabled: boolean) => void;
  getDisabledTools: () => string[];
  setDisabledTools: (names: string[]) => void;
  // MCP server management
  addMCPServer: (name: string, url: string, authToken?: string) => Promise<MCPServerEntry>;
  removeMCPServer: (id: string) => void;
  reconnectMCPServer: (id: string) => Promise<MCPServerEntry>;
  getMCPServers: () => MCPServerEntry[];
  restoreMCPServers: () => Promise<void>;
  // VLM config
  setVLMConfig: (config: VLMConfig) => void;
  getVLMConfig: () => VLMConfig | null;
  setRecursionLimit: (limit: number) => void;
  getRecursionLimit: () => number;
  setSystemPrompt: (prompt: string) => void;
  getSystemPrompt: () => string;
  setSkillRegistry: (skills: SkillRegistryEntry[]) => void;
  getSkillRegistry: () => SkillRegistryEntry[];
}

type ReactAgent = {
  stream: (input: any, config?: any) => AsyncIterable<any> | Promise<AsyncIterable<any>>;
};

export const DEFAULT_AGENT_RECURSION_LIMIT = 100;

function normalizeRecursionLimit(limit: number | string | undefined | null): number {
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed)) return DEFAULT_AGENT_RECURSION_LIMIT;
  return Math.max(1, Math.floor(parsed));
}

// ─── Tool display helpers ──────────────────────────────────────────────────

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

const DEFAULT_DISABLED_TOOL_NAMES = new Set(AUTOMATION_TOOL_NAMES);

function getBuiltinToolCategory(toolName: string): string {
  if (toolName.startsWith('skills_')) return 'skills';
  if (AUTOMATION_TOOL_NAMES.has(toolName)) return 'browser_automation';
  return 'browser_read';
}

// Dynamic labels for WebMCP tools get built at runtime
function getToolDisplayLabel(toolName: string): string {
  if (TOOL_DISPLAY_LABELS[toolName]) return TOOL_DISPLAY_LABELS[toolName];
  // For webmcp_t{id}_{name} prefixed tools, show a nicer label
  const mcpMatch = toolName.match(/^webmcp_t(\d+)_(.+)$/);
  if (mcpMatch) {
    const base = mcpMatch[2].replace(/_/g, ' ');
    return `WebMCP: ${base}`;
  }
  if (toolName.startsWith('webmcp_')) {
    const base = toolName.slice(7).replace(/_/g, ' ');
    return `WebMCP: ${base}`;
  }
  return toolName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function getToolCompletionDescription(toolName: string, result?: string): string {
  const MAX = 100;
  if (result) {
    try {
      const parsed = JSON.parse(result);
      if (parsed.message) {
        const msg = parsed.message as string;
        return msg.length > MAX ? msg.slice(0, MAX) + '…' : msg;
      }
    } catch { /* ignore */ }
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

/**
 * Strip raw JSON tool-call blocks some models embed in text content.
 */
function stripToolCallJson(text: string): string {
  return text
    .replace(/\s*\{[\s\S]*?"tool"\s*:\s*"[^"]*"[\s\S]*?\}\s*$/g, '')
    .trim();
}

const QUERY_CONTEXT_TAB_LIMIT = 40;
const QUERY_CONTEXT_TITLE_LIMIT = 120;
const QUERY_CONTEXT_URL_LIMIT = 160;
const QUERY_CONTEXT_CONTENT_LIMIT = 12_000;
const QUERY_CONTEXT_SELECTED_TAB_LIMIT = 8;

function normalizeInlineText(text: string | undefined | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function truncateInline(text: string | undefined | null, max: number): string {
  const normalized = normalizeInlineText(text);
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max) + '…';
}

async function buildBrowserContextSnapshot(contextTabIds?: number[]): Promise<string> {
  const [tabs, activeTab] = await Promise.all([
    tabsList().catch(() => []),
    tabsGetActive().catch(() => null),
  ]);

  const visibleTabId = activeTab?.tabId;
  const listedTabs = tabs.slice(0, QUERY_CONTEXT_TAB_LIMIT);
  const extraTabCount = Math.max(tabs.length - listedTabs.length, 0);
  const selectedTabIds = Array.from(
    new Set(
      (contextTabIds === undefined
        ? (activeTab?.tabId !== undefined ? [activeTab.tabId] : [])
        : contextTabIds
      ).filter((tabId): tabId is number => Number.isInteger(tabId) && tabId >= 0),
    ),
  );
  const attachedTabIds = selectedTabIds.slice(0, QUERY_CONTEXT_SELECTED_TAB_LIMIT);
  const omittedAttachedTabCount = Math.max(selectedTabIds.length - attachedTabIds.length, 0);
  const tabsById = new Map<number, (typeof tabs)[number]>();
  for (const tab of tabs) {
    tabsById.set(tab.tabId, tab);
  }

  const tabLines = listedTabs.length > 0
    ? listedTabs.map((tab, index) => {
      const markers = [
        tab.tabId === visibleTabId ? 'ACTIVE' : null,
        tab.active ? 'SELECTED' : null,
      ].filter(Boolean).join(', ');
      const markerPrefix = markers ? `[${markers}] ` : '';
      const title = truncateInline(tab.title || '(untitled tab)', QUERY_CONTEXT_TITLE_LIMIT);
      const url = truncateInline(tab.url || '', QUERY_CONTEXT_URL_LIMIT);
      return `${index + 1}. ${markerPrefix}tabId=${tab.tabId} title="${title}" url=${url}`;
    }).join('\n')
    : 'No open tabs found.';

  const activeSection = activeTab
    ? [
      'Current visible/selected tab:',
      `tabId=${activeTab.tabId}`,
      `title="${truncateInline(activeTab.title || '(untitled tab)', QUERY_CONTEXT_TITLE_LIMIT)}"`,
      `url=${truncateInline(activeTab.url || '', QUERY_CONTEXT_URL_LIMIT)}`,
      `status=${activeTab.status}`,
    ].join('\n')
    : 'Current visible/selected tab: unavailable.';

  const attachedContentBlocks = await Promise.all(attachedTabIds.map(async (tabId, index) => {
    const tab = tabsById.get(tabId) ?? (activeTab?.tabId === tabId ? activeTab : undefined);
    const contentResult: { ok: boolean; content?: string; error?: string } =
      await tabsGetContent(tabId, 'text').catch(() => ({
        ok: false,
        error: 'Failed to read tab content',
      }));

    const markers = [
      tabId === visibleTabId ? 'ACTIVE' : null,
      tab?.active ? 'SELECTED' : null,
    ].filter(Boolean).join(', ');
    const markerPrefix = markers ? `[${markers}] ` : '';
    const header = `${index + 1}. ${markerPrefix}tabId=${tabId} title="${truncateInline(tab?.title || '(untitled tab)', QUERY_CONTEXT_TITLE_LIMIT)}" url=${truncateInline(tab?.url || '', QUERY_CONTEXT_URL_LIMIT)}`;

    if (!contentResult.ok) {
      return `${header}\nContent unavailable (${contentResult.error ?? 'unknown error'}).`;
    }

    const rawContent = (contentResult.content ?? '').trim();
    if (!rawContent) {
      return `${header}\nContent (text): [empty]`;
    }

    const truncated = rawContent.length > QUERY_CONTEXT_CONTENT_LIMIT
      ? `${rawContent.slice(0, QUERY_CONTEXT_CONTENT_LIMIT)}\n\n[...truncated at ${QUERY_CONTEXT_CONTENT_LIMIT} chars]`
      : rawContent;
    return `${header}\nContent (text):\n${truncated}`;
  }));

  const attachedTabsSection = attachedContentBlocks.length > 0
    ? [
      `Attached tab content (${selectedTabIds.length} selected${omittedAttachedTabCount > 0 ? `, showing first ${attachedContentBlocks.length}` : ''}):`,
      attachedContentBlocks.join('\n\n'),
      omittedAttachedTabCount > 0 ? `...and ${omittedAttachedTabCount} more attached tabs not shown.` : '',
    ].filter(Boolean).join('\n')
    : 'Attached tab content: none selected for this message.';

  return [
    'Browser context snapshot:',
    '',
    `Open tabs (${tabs.length} total${extraTabCount > 0 ? `, showing first ${listedTabs.length}` : ''}):`,
    tabLines,
    extraTabCount > 0 ? `...and ${extraTabCount} more tabs not shown.` : '',
    '',
    activeSection,
    '',
    attachedTabsSection,
  ]
    .filter(Boolean)
    .join('\n');
}

// ─── System prompt ─────────────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = `You are Brow, the user's browser bro: a friendly, sharp, context-aware browser agent.

Your job is to help the user directly inside their browsing session with as little friction as possible. Be useful, natural, and quick. Understand what the user likely means from the current browser context and respond accordingly.

IDENTITY AND TONE
- Your name is Brow.
- Be warm, natural, calm, and reliable.
- Sound human, concise, and confident.
- Be lightly playful when appropriate, but never distracting or unprofessional.
- Reduce effort for the user rather than adding steps.

CORE PRINCIPLE
- The active tab is your default context.
- Treat the active tab as the primary source for understanding the user's request.
- Do not ask the user to repeat, paste, or restate information that is already available from the browsing context.
- A fresh browser context snapshot may be provided with each request, including the tab list, the active tab, and any tab content explicitly attached from the composer. Treat that snapshot as current state unless tool calls reveal something newer.

CONTEXT PRIORITY
Use context in this order:
1. the user's latest message
2. the latest browser context snapshot provided at runtime
3. the active tab
4. selected or highlighted text in the active tab
5. active tab metadata such as title, URL, headings, visible labels, page structure, and page type
6. relevant other open tabs when needed
7. prior conversation context

DEFAULT INTERPRETATION
- Unless the user clearly refers to something else, interpret words like "this," "here," "that," "this page," "this tab," and "the current tab" as referring to the active tab.
- If text is selected, treat it as the immediate focus while using the rest of the active tab as supporting context.

ACTIVE TAB AWARENESS
You must understand both:
- the content of the active tab
- the function of the active tab

The active tab may be a page to read, a chat interface, a form, a composer, a search page, an editor, a dashboard, a prompt field, or another interactive tool.

Use available signals such as page title, URL, layout, visible controls, labels, input fields, and page structure to infer what kind of interface the active tab is.

INTERFACE-AWARE BEHAVIOR
When the active tab is an interface, understand what the user wants done inside that interface.

If the user refers to writing "here," "in this tab," "in the chat," "in this box," "in this field," or similar, interpret that as targeting the relevant input area in the active tab when such an input exists.

Do not treat every request as a request about page content only. Sometimes the active tab is the place where the user wants text prepared or inserted.

WRITE VS DO
Before responding, determine whether the user wants you to:
- explain
- summarize
- analyze
- compare
- locate information
- write content
- prepare content for another interface
- perform an action

If the user asks you to write, draft, prepare, generate, formulate, or propose text, produce the requested text directly.

If the request can be satisfied by producing text, do that first.

Do not turn a writing request into an execution request unless the user clearly asked for execution.

HOST INTERFACE VS FINAL GOAL
Do not confuse the tool open in the active tab with the user's final goal.

If the active tab is being used as a destination interface, your role is to help the user operate within it by preparing the right content for that interface.

If the user wants text to use in the active tab, provide that text. Do not refuse merely because you cannot carry out the downstream result yourself.

PREPARE VS SEND
Preparing text and submitting text are different actions.

If the user asks you to write, draft, prepare, or put something into a field:
- compose the content
- place it into the appropriate input if interaction is available
- do not automatically submit, send, or execute unless the user clearly asks for that final step

If interaction is not available, still provide the exact text the user needs.

MULTI-TAB FALLBACK
The active tab is the default context, but not the only context.

If the answer is missing, unclear, incomplete, or likely located elsewhere, inspect other relevant open tabs automatically.

Expand context in this order:
1. active tab only
2. active tab plus selection and metadata
3. relevant other open tabs

Use other tabs only when needed and only when relevant to the request.

Do not scan unrelated tabs unnecessarily.

When checking other tabs, prioritize those most likely to help based on title, URL, page type, recent context, and semantic relevance.

If needed, briefly mention that you used other relevant tabs.

GENERAL BEHAVIOR
- Be proactive.
- Resolve ambiguity from available context before asking follow-up questions.
- Ask clarifying questions only when needed to avoid a likely wrong or unsafe result.
- Start with the answer, not with process explanations.
- Prefer direct usefulness over commentary about limitations.
- Keep the browsing experience smooth, fast, and low-friction.

CAPABILITIES
You can help the user:
- summarize pages, articles, threads, and documents
- explain difficult content simply
- extract key points, action items, deadlines, risks, and decisions
- compare information across tabs
- answer questions about the current page
- locate where information appears
- translate text
- rewrite content
- draft replies, prompts, messages, queries, and commands
- assess trustworthiness, bias, completeness, and red flags
- turn long content into concise notes
- help the user decide what matters most

RESPONSE STYLE
- Be clear, compact, and useful.
- Match the depth to the request.
- Use structure when it improves readability.
- Avoid fluff, repetition, robotic phrasing, and unnecessary disclaimers.
- Avoid asking the user to restate context that is already visible.
- When summarizing, prioritize the main point, the key details, and any important caveats.

TRUST AND ACCURACY
- Never pretend to see information that is not actually available in the browsing context or conversation.
- Be honest about uncertainty.
- If content is incomplete, hidden, truncated, or ambiguous, say so briefly and continue with the best grounded answer possible.
- Distinguish between what the page says, what you infer, and what you recommend.
- Do not invent facts, quotes, page details, or unsupported connections across tabs.

TOOL LIMITATIONS
- Mention tool limitations only when they are directly relevant to the user's actual request.
- If the user asks for content, provide the content.
- If the user asks for execution, perform it if possible.
- If execution is not possible, say so clearly and briefly.
- Never replace a valid writing response with a limitation message.

PRIVACY AND SENSITIVITY
- Treat browsing context as sensitive by default.
- Use information from tabs only when relevant to the request.
- Do not surface irrelevant private or sensitive information.
- Be especially careful with personal, financial, medical, legal, account, and private-document content.
- Do not inspect unrelated tabs in a way that feels intrusive.

SAFETY
- Refuse clearly and calmly if the user asks for harmful, illegal, deceptive, malicious, or unsafe help.
- Still help with safe alternatives such as explanation, summarization, defensive guidance, or legitimate writing help.

DECISION RULES
1. If the request can be answered from the active tab, answer immediately.
2. If selected text matches the request, prioritize it.
3. If the user asks for text, write the text.
4. If the user asks for explanation, explain.
5. If the user asks for analysis, analyze.
6. If the user asks for execution, perform it if possible.
7. If the active tab is insufficient, inspect relevant other tabs.
8. If the user indicates a destination such as a chat box, field, or composer, treat that as the target.
9. If several tabs are relevant, synthesize only what is clearly supported.
10. If ambiguity remains after checking relevant context, ask a concise clarifying question.
11. If a short answer is enough, keep it short.
12. Only discuss limitations when execution is actually what the user requested.

OUTPUT PRINCIPLES
- Be useful fast.
- Stay grounded in the browsing context.
- Use the active tab by default.
- Expand to other tabs only when needed.
- Understand both what the user is viewing and what they are trying to do.
- Prefer solving the user's task over describing your constraints.

You are Brow: friendly, sharp, context-aware, reliable, and helpful by default.`;

// ─── Tool definitions ──────────────────────────────────────────────────────

function createBuiltinTools(): StructuredToolInterface[] {
  const tabsListTool = tool(
    async () => {
      const tabs = await tabsList();
      return JSON.stringify(tabs, null, 2);
    },
    {
      name: 'tabs_list',
      description: 'List all open browser tabs. Returns tabId, windowId, title, url, active, audible, status.',
      schema: z.object({}),
    },
  );

  const tabsGetActiveTool = tool(
    async () => {
      const tab = await tabsGetActive();
      return JSON.stringify(tab, null, 2);
    },
    {
      name: 'tabs_getActive',
      description: 'Get info about the currently active tab. Returns tabId, title, url, etc. No arguments needed.',
      schema: z.object({}),
    },
  );

  const tabsGetContentTool = tool(
    async ({ tabId, format }: { tabId: number; format?: string }) => {
      const result = await tabsGetContent(tabId, (format as 'text' | 'html') ?? 'text');
      return JSON.stringify(result, null, 2);
    },
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
    async ({ tabId, limit }: { tabId: number; limit?: number }) => {
      const result = await tabsListInteractiveElements(tabId, limit ?? 40);
      return JSON.stringify(result, null, 2);
    },
    {
      name: 'tabs_listInteractiveElements',
      description: 'List visible interactive elements on a tab and return candidate CSS selectors, labels, roles, and attributes. Use this before clicking or typing.',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab to inspect'),
        limit: z.number().optional().describe('Maximum number of elements to return (default: 40, max: 100)'),
      }),
    },
  );

  const tabsClickTool = tool(
    async ({ tabId, selector }: { tabId: number; selector: string }) => {
      const result = await tabsClick(tabId, selector);
      return JSON.stringify(result, null, 2);
    },
    {
      name: 'tabs_click',
      description: 'Click an element on a specific tab using a CSS selector. Prefer selectors returned by tabs_listInteractiveElements.',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the target element'),
        selector: z.string().describe('CSS selector for the element to click'),
      }),
    },
  );

  const tabsTypeTool = tool(
    async ({ tabId, selector, text, submit }: { tabId: number; selector: string; text: string; submit?: boolean }) => {
      const result = await tabsType(tabId, selector, text, submit ?? false);
      return JSON.stringify(result, null, 2);
    },
    {
      name: 'tabs_type',
      description: 'Type into an input, textarea, or contenteditable element on a specific tab using a CSS selector.',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the target field'),
        selector: z.string().describe('CSS selector for the target field'),
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
    }) => {
      const result = await tabsFillForm(tabId, fields, submit ?? false, submitSelector);
      return JSON.stringify(result, null, 2);
    },
    {
      name: 'tabs_fillForm',
      description: 'Fill multiple form fields on a specific tab. Supports text inputs, textareas, contenteditable fields, selects, checkboxes, radios, and optional submit.',
      schema: z.object({
        tabId: z.number().describe('The ID of the tab containing the form'),
        fields: z.array(
          z.object({
            selector: z.string().describe('CSS selector for the target field'),
            value: z.union([z.string(), z.number(), z.boolean()]).describe('Value to apply. Use booleans for checkboxes/radios.'),
            mode: z.enum(['auto', 'text', 'checkbox', 'radio', 'select', 'contenteditable']).optional()
              .describe('Optional override for how to fill the field. Default: auto.'),
          }),
        ).describe('List of fields to fill'),
        submit: z.boolean().optional().describe('Submit the closest parent form after filling all fields'),
        submitSelector: z.string().optional().describe('Optional CSS selector for a submit button to click after filling'),
      }),
    },
  );

  const tabsActivateTool = tool(
    async ({ tabId }: { tabId: number }) => {
      const result = await tabsActivate(tabId);
      return JSON.stringify(result);
    },
    {
      name: 'tabs_activate',
      description: 'Activate (switch to) a specific browser tab by its tabId.',
      schema: z.object({ tabId: z.number().describe('The ID of the tab to activate') }),
    },
  );

  const tabsCreateTool = tool(
    async ({ url, active }: { url: string; active?: boolean }) => {
      const result = await tabsCreate(url, active ?? true);
      return JSON.stringify(result);
    },
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
    async ({ tabId, url }: { tabId: number; url: string }) => {
      const result = await tabsUpdateUrl(tabId, url);
      return JSON.stringify(result);
    },
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
    async () => {
      const bookmarks = await bookmarksGetAll();
      return JSON.stringify(bookmarks, null, 2);
    },
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
    }) => {
      const result = await httpFetch(url, { method, headers, body, timeoutMs, maxChars });
      return JSON.stringify(result, null, 2);
    },
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
    async ({ query }: { query: string }) => {
      const results = await bookmarksSearch(query);
      return JSON.stringify(results, null, 2);
    },
    {
      name: 'bookmarks_search',
      description: 'Search bookmarks by title or URL keyword.',
      schema: z.object({
        query: z.string().describe('Search query to match against bookmark titles and URLs'),
      }),
    },
  );

  const historySearchTool = tool(
    async ({ query, maxResults, startTime }: { query: string; maxResults?: number; startTime?: number }) => {
      const results = await historySearch(query, maxResults ?? 50, startTime);
      return JSON.stringify(results, null, 2);
    },
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
      // Get VLM config from the singleton agent
      const agentInstance = singletonAgent;
      const vlmConfig = agentInstance?.getVLMConfig();
      if (!vlmConfig || !vlmConfig.baseUrl || !vlmConfig.model) {
        return JSON.stringify({ ok: false, error: 'VLM not configured. Please set VLM endpoint, model, and API key in the config panel.' });
      }

      // Capture screenshot
      const screenshot = await tabCaptureScreenshot(tabId);
      if (!screenshot.ok || !screenshot.dataUrl) {
        return JSON.stringify({ ok: false, error: screenshot.error ?? 'Failed to capture screenshot' });
      }

      // Send to VLM
      const result = await vlmQuery(vlmConfig, screenshot.dataUrl, query);
      return JSON.stringify(result, null, 2);
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
    async ({ tabId }: { tabId?: number }) => {
      const result = await webmcpDiscover(tabId);
      return JSON.stringify(result, null, 2);
    },
    {
      name: 'webmcp_discover',
      description: 'Discover WebMCP tools on a tab. Defaults to active tab. Returns tools exposed by the page.',
      schema: z.object({
        tabId: z.number().optional().describe('Tab ID (default: active tab)'),
      }),
    },
  );

  const webmcpInvokeTool = tool(
    async ({ tabId, toolName, args }: { tabId: number; toolName: string; args?: Record<string, unknown> }) => {
      const result = await webmcpInvoke(tabId, toolName, args ?? {});
      return JSON.stringify(result, null, 2);
    },
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

  const skillsLoadTool = tool(
    async ({ identifier }: { identifier: string }) => {
      const skill = singletonAgent?.findSkill(identifier) ?? null;
      if (!skill) {
        return JSON.stringify({
          ok: false,
          error: `Skill "${identifier}" not found`,
        }, null, 2);
      }
      return JSON.stringify({
        ok: true,
        skill,
      }, null, 2);
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
    skillsLoadTool as unknown as StructuredToolInterface,
  ];
}

// ─── Agent Class (mirrors Agent from agent-singleton.ts) ───────────────────

export class Agent implements AgentAPI {
  private currentAgent: ReactAgent | null = null;
  private readonly builtinTools: StructuredToolInterface[];
  /** Per-tab WebMCP tool storage: tabId → { descriptors, langchainTools } */
  private webmcpByTab = new Map<number, {
    descriptors: WebMCPToolDescriptor[];
    tools: StructuredToolInterface[];
    url?: string;
    title?: string;
  }>();
  /** Remote MCP servers: id → entry */
  private mcpServers = new Map<string, MCPServerEntry & { langchainTools: StructuredToolInterface[] }>();
  /** Disabled tool names — these are excluded from the agent graph */
  private disabledTools = new Set<string>(DEFAULT_DISABLED_TOOL_NAMES);
  /** VLM configuration for the screenshot analysis tool */
  private vlmConfig: VLMConfig | null = null;
  private toolStepCallbacks: ToolStepCallback[] = [];
  private streamTextCallbacks: StreamTextCallback[] = [];
  private queryAbortController: AbortController | null = null;
  private paused = false;
  private pauseResolve: (() => void) | null = null;
  private recursionLimit = DEFAULT_AGENT_RECURSION_LIMIT;
  private systemPrompt = DEFAULT_SYSTEM_PROMPT;
  private skillRegistry: SkillRegistryEntry[] = [];

  constructor() {
    this.builtinTools = createBuiltinTools();
    // Kick off async LLM init, then rebuild once ready
    void ensureLlm()
      .then(() => this.rebuildAgent())
      .catch((err) => console.warn('[agent] LLM not yet configured:', err.message));
  }

  // ─── Dynamic WebMCP tool management (multi-tab) ─────────────────────

  updateWebMCPTools(tabId: number, descriptors: WebMCPToolDescriptor[], url?: string, title?: string): void {
    const tools = createWebMCPTools(tabId, descriptors);
    this.webmcpByTab.set(tabId, { descriptors, tools, url, title });
    console.log('[agent] WebMCP tools updated for tab', tabId, ':', descriptors.map(t => t.name));

    // Register display labels
    for (const d of descriptors) {
      const key = `webmcp_t${tabId}_${d.name}`;
      TOOL_DISPLAY_LABELS[key] = `WebMCP: ${d.name.replace(/_/g, ' ')}`;
    }

    this.rebuildAgent();
  }

  removeWebMCPToolsForTab(tabId: number): void {
    if (this.webmcpByTab.has(tabId)) {
      this.webmcpByTab.delete(tabId);
      console.log('[agent] Removed WebMCP tools for tab', tabId);
      this.rebuildAgent();
    }
  }

  clearWebMCPTools(): void {
    this.webmcpByTab.clear();
    this.rebuildAgent();
  }

  // ─── Tool enable/disable management ──────────────────────────────

  /** Get a manifest of all available tools with their enabled state and category */
  getToolManifest(): ToolManifestEntry[] {
    const manifest: ToolManifestEntry[] = [];

    // Builtin tab tools
    for (const t of this.builtinTools) {
      const name = (t as any).name as string;
      const category = getBuiltinToolCategory(name);
      manifest.push({
        name,
        description: (t as any).description ?? '',
        category,
        enabled: !this.disabledTools.has(name),
      });
    }

    // Dynamic WebMCP tools per tab
    for (const [tabId, entry] of this.webmcpByTab.entries()) {
      const label = entry.title || entry.url || `tab ${tabId}`;
      const category = `webmcp_tab_${tabId}`;
      for (const t of entry.tools) {
        const name = (t as any).name as string;
        manifest.push({
          name,
          description: (t as any).description ?? '',
          category,
          enabled: !this.disabledTools.has(name),
        });
      }
    }

    // Remote MCP server tools
    for (const [serverId, entry] of this.mcpServers.entries()) {
      if (entry.status !== 'connected') continue;
      const category = `mcp_server_${serverId}`;
      for (const t of entry.langchainTools) {
        const name = (t as any).name as string;
        manifest.push({
          name,
          description: (t as any).description ?? '',
          category,
          enabled: !this.disabledTools.has(name),
        });
      }
    }

    return manifest;
  }

  /** Get category display labels */
  static getCategoryLabel(category: string): string {
    if (category === 'browser_read') return 'Read Only';
    if (category === 'browser_automation') return 'Automation';
    if (category === 'skills') return 'Skills';
    const tabMatch = category.match(/^webmcp_tab_(\d+)$/);
    if (tabMatch) return `WebMCP · Tab ${tabMatch[1]}`;
    const mcpMatch = category.match(/^mcp_server_(.+)$/);
    if (mcpMatch) return `MCP Server`;
    return category;
  }

  setToolEnabled(toolName: string, enabled: boolean): void {
    if (enabled) {
      this.disabledTools.delete(toolName);
    } else {
      this.disabledTools.add(toolName);
    }
    this.rebuildAgent();
  }

  setToolsEnabled(toolNames: string[], enabled: boolean): void {
    for (const name of toolNames) {
      if (enabled) {
        this.disabledTools.delete(name);
      } else {
        this.disabledTools.add(name);
      }
    }
    this.rebuildAgent();
  }

  getDisabledTools(): string[] {
    return [...this.disabledTools];
  }

  setDisabledTools(names: string[]): void {
    this.disabledTools = new Set(names);
    this.rebuildAgent();
  }

  // ─── MCP Server management ──────────────────────────────────────────

  async addMCPServer(name: string, url: string, authToken?: string): Promise<MCPServerEntry> {
    const config: MCPServerConfig = { id: generateServerId(), name, url, authToken };
    const entry: MCPServerEntry & { langchainTools: StructuredToolInterface[] } = {
      ...config,
      status: 'connecting',
      tools: [],
      langchainTools: [],
    };
    this.mcpServers.set(config.id, entry);

    try {
      const tools = await mcpConnect(config);
      entry.status = 'connected';
      entry.tools = tools;
      entry.langchainTools = createMCPServerTools(config, tools);

      // Register display labels for MCP tools
      const safeId = config.id.replace(/[^a-zA-Z0-9]/g, '');
      for (const t of tools) {
        TOOL_DISPLAY_LABELS[`mcp_${safeId}_${t.name}`] = `MCP ${config.name}: ${t.name.replace(/_/g, ' ')}`;
      }

      this.rebuildAgent();
      this.persistMCPServers();
      console.log(`[agent] MCP server "${name}" connected with ${tools.length} tools`);
    } catch (err: any) {
      entry.status = 'error';
      entry.error = err.message ?? String(err);
      console.error(`[agent] MCP server "${name}" connection failed:`, err);
    }

    return entry;
  }

  removeMCPServer(id: string): void {
    const entry = this.mcpServers.get(id);
    if (entry) {
      // Remove display labels
      const safeId = id.replace(/[^a-zA-Z0-9]/g, '');
      for (const t of entry.tools) {
        delete TOOL_DISPLAY_LABELS[`mcp_${safeId}_${t.name}`];
      }
      this.mcpServers.delete(id);
      this.rebuildAgent();
      this.persistMCPServers();
      console.log(`[agent] MCP server "${entry.name}" removed`);
    }
  }

  async reconnectMCPServer(id: string): Promise<MCPServerEntry> {
    const entry = this.mcpServers.get(id);
    if (!entry) throw new Error(`MCP server ${id} not found`);

    entry.status = 'connecting';
    entry.error = undefined;
    entry.tools = [];
    entry.langchainTools = [];

    try {
      const config: MCPServerConfig = { id: entry.id, name: entry.name, url: entry.url, authToken: entry.authToken };
      const tools = await mcpConnect(config);
      entry.status = 'connected';
      entry.tools = tools;
      entry.langchainTools = createMCPServerTools(config, tools);

      const safeId = id.replace(/[^a-zA-Z0-9]/g, '');
      for (const t of tools) {
        TOOL_DISPLAY_LABELS[`mcp_${safeId}_${t.name}`] = `MCP ${entry.name}: ${t.name.replace(/_/g, ' ')}`;
      }

      this.rebuildAgent();
      console.log(`[agent] MCP server "${entry.name}" reconnected with ${tools.length} tools`);
    } catch (err: any) {
      entry.status = 'error';
      entry.error = err.message ?? String(err);
      console.error(`[agent] MCP server "${entry.name}" reconnection failed:`, err);
    }

    return entry;
  }

  getMCPServers(): MCPServerEntry[] {
    return [...this.mcpServers.values()].map(({ langchainTools, ...rest }) => rest);
  }

  async restoreMCPServers(): Promise<void> {
    const saved = await loadSavedServers();
    for (const config of saved) {
      // Don't duplicate if already present
      if (this.mcpServers.has(config.id)) continue;
      // Try to connect in background
      this.addMCPServer(config.name, config.url, config.authToken)
        .catch((err) => console.warn(`[agent] Failed to restore MCP server "${config.name}":`, err));
    }
  }

  private persistMCPServers(): void {
    const configs: MCPServerConfig[] = [...this.mcpServers.values()].map(
      ({ id, name, url, authToken }) => ({ id, name, url, authToken }),
    );
    saveServers(configs);
  }

  // ─── VLM config management ───────────────────────────────────────────

  setVLMConfig(config: VLMConfig): void {
    this.vlmConfig = config;
    console.log('[agent] VLM config set:', config.model, '@', config.baseUrl);
  }

  getVLMConfig(): VLMConfig | null {
    return this.vlmConfig;
  }

  setRecursionLimit(limit: number): void {
    this.recursionLimit = normalizeRecursionLimit(limit);
    console.log('[agent] Recursion limit set to', this.recursionLimit);
  }

  getRecursionLimit(): number {
    return this.recursionLimit;
  }

  setSystemPrompt(prompt: string): void {
    const normalized = prompt.trim() || DEFAULT_SYSTEM_PROMPT;
    this.systemPrompt = normalized;
    if (this.currentAgent) {
      this.rebuildAgent();
    }
    console.log('[agent] System prompt updated');
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  setSkillRegistry(skills: SkillRegistryEntry[]): void {
    this.skillRegistry = normalizeSkillRegistry(skills);
    if (this.currentAgent) {
      this.rebuildAgent();
    }
    console.log('[agent] Skill registry updated:', this.skillRegistry.length, 'skills');
  }

  getSkillRegistry(): SkillRegistryEntry[] {
    return [...this.skillRegistry];
  }

  findSkill(identifier: string): SkillRegistryEntry | null {
    const normalized = identifier.trim().toLowerCase();
    if (!normalized) return null;
    return this.skillRegistry.find((skill) =>
      skill.slug.toLowerCase() === normalized || skill.name.toLowerCase() === normalized,
    ) ?? null;
  }

  // ─── Callback registration ───────────────────────────────────────────

  onToolStep(callback: ToolStepCallback): void {
    this.toolStepCallbacks.push(callback);
  }

  offToolStep(callback: ToolStepCallback): void {
    this.toolStepCallbacks = this.toolStepCallbacks.filter((cb) => cb !== callback);
  }

  onStreamText(callback: StreamTextCallback): void {
    this.streamTextCallbacks.push(callback);
  }

  offStreamText(callback: StreamTextCallback): void {
    this.streamTextCallbacks = this.streamTextCallbacks.filter((cb) => cb !== callback);
  }

  private emitToolSteps(steps: ToolStepEvent[]): void {
    for (const cb of this.toolStepCallbacks) {
      try { cb([...steps]); } catch (e) { console.warn('[agent] toolStep callback error', e); }
    }
  }

  private emitStreamText(text: string): void {
    for (const cb of this.streamTextCallbacks) {
      try { cb(text); } catch (e) { console.warn('[agent] streamText callback error', e); }
    }
  }

  // ─── Abort ──────────────────────────────────────────────────────────

  abort(): void {
    console.log('[agent] Abort requested');
    if (this.queryAbortController) {
      this.queryAbortController.abort();
      this.queryAbortController = null;
    }
  }

  isBusy(): boolean {
    return this.queryAbortController !== null;
  }

  // ─── Pause / Resume ────────────────────────────────────────────────

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    console.log('[agent] Paused');
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    console.log('[agent] Resumed');
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  isPaused(): boolean {
    return this.paused;
  }

  private waitIfPaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
  }

  // ─── Query (streaming, mirrors agent-singleton.ts) ─────────────────

  async query(userQuery: string, history: ChatTurn[] = [], contextTabIds?: number[]): Promise<string> {
    // Lazy re-init if needed
    if (this.currentAgent == null) {
      try {
        await ensureLlm();
        this.rebuildAgent();
      } catch (err: any) {
        console.error('[agent] Failed to init LLM:', err);
      }
      if (this.currentAgent == null) {
        return 'Agent not configured. Please set up your LLM in the config panel.';
      }
    }

    const browserContext = await buildBrowserContextSnapshot(contextTabIds).catch((err: any) => {
      console.warn('[agent] Failed to build browser context snapshot:', err?.message ?? err);
      return 'Browser context snapshot: unavailable.';
    });

    const messages = [
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: 'system', content: browserContext },
      { role: 'user', content: userQuery },
    ];
    let finalContent = '';

    // Tool step tracking
    const toolSteps: ToolStepEvent[] = [];
    const pendingTools = new Map<string, ToolStepEvent>();
    let stepCounter = 0;

    // Abort controller for this query
    this.queryAbortController = new AbortController();
    const abortSignal = this.queryAbortController.signal;

    // Abortable stream helper (from agent-singleton.ts)
    async function* abortableStream<T>(
      stream: AsyncIterable<T>,
      signal: AbortSignal,
    ): AsyncGenerator<T> {
      const iterator = stream[Symbol.asyncIterator]();
      const abortPromise = new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
      try {
        while (true) {
          const result = await Promise.race([iterator.next(), abortPromise]);
          if (result.done) break;
          yield result.value;
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          console.log('[agent] Stream aborted');
          return;
        }
        throw err;
      } finally {
        iterator.return?.();
      }
    }

    try {
      const rawStream = await this.currentAgent.stream(
        { messages },
        { streamMode: 'updates', recursionLimit: this.recursionLimit, signal: abortSignal },
      );

      for await (const chunk of abortableStream(rawStream, abortSignal)) {
        // Pause gate
        await this.waitIfPaused();

        if (abortSignal.aborted) {
          console.log('[agent] Query aborted, breaking stream');
          break;
        }

        // ── Agent messages (tool calls + text content) ──────────────
        if (chunk.agent?.messages) {
          for (const msg of chunk.agent.messages) {
            // Track tool calls
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
              console.log('[agent] tool calls', msg.tool_calls);
              for (const call of msg.tool_calls) {
                const toolName =
                  (call as any)?.name ??
                  (call as any)?.tool ??
                  (call as any)?.function?.name;

                if (toolName) {
                  const callId = (call as any)?.id || `step-${stepCounter}`;
                  const step: ToolStepEvent = {
                    stepIndex: stepCounter++,
                    toolName,
                    label: getToolDisplayLabel(toolName),
                    status: 'running',
                    startTime: Date.now(),
                  };
                  toolSteps.push(step);
                  pendingTools.set(callId, step);
                  this.emitToolSteps(toolSteps);
                }
              }
            }

            // Capture final text content (only from messages without tool calls)
            if (msg.content && typeof msg.content === 'string' && !msg.tool_calls?.length) {
              finalContent = msg.content;
              this.emitStreamText(msg.content);
            }
          }
        }

        // ── Tool completion messages ────────────────────────────────
        if (chunk.tools?.messages) {
          for (const toolMsg of chunk.tools.messages) {
            const toolCallId = (toolMsg as any)?.tool_call_id;
            const toolName = (toolMsg as any)?.name;
            const resultContent = typeof toolMsg.content === 'string' ? toolMsg.content : '';

            // Find matching pending step by callId or by name
            let step: ToolStepEvent | undefined;
            if (toolCallId && pendingTools.has(toolCallId)) {
              step = pendingTools.get(toolCallId);
              pendingTools.delete(toolCallId);
            } else {
              for (const [id, s] of pendingTools.entries()) {
                if (s.toolName === toolName && s.status === 'running') {
                  step = s;
                  pendingTools.delete(id);
                  break;
                }
              }
            }

            if (step) {
              step.status = 'completed';
              step.durationMs = Date.now() - step.startTime;
              step.description = getToolCompletionDescription(step.toolName, resultContent);
              this.emitToolSteps(toolSteps);
            }
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('[agent] Stream error:', err);
        finalContent = `Error: ${err.message ?? err}`;
      }
    }

    // Mark any remaining pending steps as completed
    for (const step of pendingTools.values()) {
      if (step.status === 'running') {
        step.status = 'completed';
        step.durationMs = Date.now() - step.startTime;
        step.description = getToolCompletionDescription(step.toolName);
      }
    }
    if (toolSteps.length > 0) {
      this.emitToolSteps(toolSteps);
    }

    // Cleanup
    this.queryAbortController = null;
    this.paused = false;
    this.pauseResolve = null;

    if (abortSignal.aborted) {
      return 'Agent turn was interrupted.';
    }

    return stripToolCallJson(finalContent) || 'No response from agent.';
  }

  // ─── Rebuild agent graph (mirrors agent-singleton.ts) ──────────────

  private rebuildAgent(): void {
    let llm: ChatOpenAIInstance;
    try {
      llm = getLlmSync();
    } catch {
      console.warn('[agent] LLM not ready — agent rebuild deferred');
      return;
    }

    // Merge builtin + all per-tab WebMCP tools + MCP server tools, filtering out disabled
    const allWebmcpTools: StructuredToolInterface[] = [];
    for (const entry of this.webmcpByTab.values()) {
      allWebmcpTools.push(...entry.tools);
    }
    const allMcpTools: StructuredToolInterface[] = [];
    for (const entry of this.mcpServers.values()) {
      if (entry.status === 'connected') {
        allMcpTools.push(...entry.langchainTools);
      }
    }
    const tools = [...this.builtinTools, ...allWebmcpTools, ...allMcpTools]
      .filter((t) => !this.disabledTools.has((t as any).name));
    console.log('[agent] Rebuilding agent graph with tools:', tools.map((t: any) => t.name));

    // Build dynamic system prompt that includes WebMCP tool info
    const prompt = this.buildSystemPrompt();

    this.currentAgent = createReactAgent({
      llm: llm as any,
      tools: tools as any,
      prompt,
    }) as unknown as ReactAgent;
  }

  /**
   * Build a system prompt that includes currently available WebMCP tools
   * so the LLM knows exactly what page tools it can call.
   */
  private buildSystemPrompt(): string {
    let prompt = this.systemPrompt;

    const activeSkills = this.skillRegistry.filter((skill) => skill.enabled);
    if (activeSkills.length > 0) {
      prompt += `\n\n**Active reusable skills:**`;
      prompt += this.disabledTools.has('skills_load')
        ? `\nThese are user-configured SKILL.md-style helpers currently summarized at a high level.`
        : `\nThese are user-configured SKILL.md-style helpers. If one seems relevant, call skills_load with its slug or name to inspect the full details before relying on it.`;
      for (const skill of activeSkills) {
        const tags = skill.tags.length > 0 ? ` — tags: ${skill.tags.join(', ')}` : '';
        const description = skill.description || 'No description provided.';
        prompt += `\n- ${skill.name} (slug: ${skill.slug}) — ${description}${tags}`;
      }
    }

    if (this.webmcpByTab.size > 0) {
      prompt += `\n\n**Available WebMCP page tools (across all tabs):**`;
      prompt += `\nThese are tools exposed by web pages. Call them directly by their full name (webmcp_t{tabId}_{toolName}).`;

      for (const [tabId, entry] of this.webmcpByTab.entries()) {
        const label = entry.title || entry.url || `tab ${tabId}`;
        prompt += `\n\n_Tab ${tabId} — ${label}:_`;
        for (const d of entry.descriptors) {
          const toolName = `webmcp_t${tabId}_${d.name}`;
          if (this.disabledTools.has(toolName)) continue;
          const schema = d.inputSchema
            ? ` — args: ${JSON.stringify(d.inputSchema.properties ?? {})}`
            : ' — no arguments';
          prompt += `\n- ${toolName}: ${d.description}${schema}`;
        }
      }

      prompt += `\n\nPrefer using these page tools directly instead of webmcp_invoke when the tool is listed above.`;
    }

    // Add MCP server tool info
    const connectedServers = [...this.mcpServers.values()].filter(s => s.status === 'connected');
    if (connectedServers.length > 0) {
      prompt += `\n\n**Available MCP server tools (remote HTTP servers):**`;
      prompt += `\nThese are tools provided by remote MCP servers. Call them directly by their full name (mcp_{serverId}_{toolName}).`;

      for (const server of connectedServers) {
        const safeId = server.id.replace(/[^a-zA-Z0-9]/g, '');
        prompt += `\n\n_MCP Server: ${server.name} (${server.url}):_`;
        for (const t of server.tools) {
          const toolName = `mcp_${safeId}_${t.name}`;
          if (this.disabledTools.has(toolName)) continue;
          const schema = t.inputSchema
            ? ` — args: ${JSON.stringify((t.inputSchema as any).properties ?? {})}`
            : ' — no arguments';
          prompt += `\n- ${toolName}: ${t.description}${schema}`;
        }
      }
    }

    return prompt;
  }
}

// ─── Singleton (mirrors agent-singleton.ts) ────────────────────────────────

let singletonAgent: Agent | null = null;

export function getOrCreateAgent(): Agent {
  if (singletonAgent == null) {
    singletonAgent = new Agent();
  }
  return singletonAgent;
}

export function getAgentApi(): AgentAPI {
  return getOrCreateAgent();
}

/**
 * Reset the agent — called after reconfigureLlm() so the next query
 * rebuilds everything with the new config.
 */
export function resetAgent(): void {
  resetLlm();
  if (singletonAgent) {
    (singletonAgent as any).currentAgent = null;
  }
  console.log('[agent] Agent reset — will re-initialise on next query');
}

/**
 * Configure LLM and rebuild the agent.
 */
export function configureAndRebuild(config: LLMConfigUnion): void {
  reconfigureLlm(config);
  resetAgent();
  // Eagerly try to rebuild
  void ensureLlm()
    .then(() => getOrCreateAgent())
    .catch((err) => console.warn('[agent] Config apply deferred:', err.message));
}
