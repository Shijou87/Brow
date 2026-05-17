import type { DirectLLMConfig, ExtensionSettings, MCPConfig, VLMConfig } from './types';
import { BROW_HTML_APP_PROMPT_GUIDANCE } from './html-app-artifact-guidance';

export type LLMProviderMode = 'openai' | 'claude';
export type ProviderFields = Omit<DirectLLMConfig, 'provider'>;

export interface SidepanelRuntimeConfig {
  recursionLimit: number;
  systemPrompt: string;
  animatedBrow: boolean;
}

export const DEFAULT_AGENT_RECURSION_LIMIT = 100;
export const DEFAULT_OPENAI_CONTEXT_WINDOW = 128000;
export const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200000;

export function normalizeRecursionLimit(limit: number | string | undefined | null): number {
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed)) return DEFAULT_AGENT_RECURSION_LIMIT;
  return Math.max(1, Math.floor(parsed));
}

export function normalizeContextWindow(limit: number | string | undefined | null, fallback: number): number {
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1024, Math.floor(parsed));
}

export function normalizePreferredOpenAiModel(model: string | undefined | null): string | undefined {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export const DEFAULT_OPENAI_FIELDS: ProviderFields = {
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'not-needed',
  model: 'gpt-5-mini',
  contextWindow: DEFAULT_OPENAI_CONTEXT_WINDOW,
};

export const DEFAULT_CLAUDE_FIELDS: ProviderFields = {
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: '',
  model: 'claude-opus-4-5',
  contextWindow: DEFAULT_CLAUDE_CONTEXT_WINDOW,
};

export const DEFAULT_VLM_CONFIG: VLMConfig = {
  baseUrl: '',
  apiKey: '',
  model: '',
  useTextModel: true,
};

export function resolveVLMConfig(
  config: VLMConfig,
  llmFields: ProviderFields,
): VLMConfig | null {
  if (config.useTextModel) {
    return {
      baseUrl: llmFields.baseUrl,
      apiKey: llmFields.apiKey,
      model: llmFields.model,
      useTextModel: true,
    };
  }

  const baseUrl = config.baseUrl.trim();
  const model = config.model.trim();
  if (!baseUrl || !model) return null;

  return {
    baseUrl,
    apiKey: config.apiKey,
    model,
    useTextModel: false,
  };
}

export const DEFAULT_MCP_CONFIG: MCPConfig = {
  endpoint: '',
  transport: 'sse',
};

export const DEFAULT_SYSTEM_PROMPT = `You are Brow, the user's browser bro: a friendly, sharp, context-aware browser agent.

You operate inside a browser side panel with access to browser context and tools.

CORE BEHAVIOR
1. Be concise, practical, and action-oriented.
2. When the user asks you to do something in the browser, prefer taking the action with tools when appropriate.
3. Ground your responses in the current browser context whenever possible.
4. Use browser read tools before browser automation tools when you need more certainty.
5. If a WebMCP page tool is available for the relevant tab, prefer using it directly.
6. For visible UI automation, prefer browser_snapshot refs and browser_click/browser_type/browser_fill_form over selector-based fallback tools.
6a. Use browser_drag, browser_scroll, browser_key, browser_wait_for, browser_upload_file, browser_download_wait, and browser_handle_dialog for richer browser mechanics.
7. For repeatable browser actions, pass a short stable intent to browser_* tools so Brow Action Memory can replay successful actions. Never include secrets or raw dynamic values in that intent.
8. For important actions, pass postconditions so Brow can verify the page reached the expected state. Postconditions are verification checks only, not targets to click, type into, or hover.
8aa. For page-opening link clicks, prefer urlIncludes or elementVisible over generic textVisible guesses like "Price", "Details", or "Info".
8a. Never use a click on an editable field as a stand-in for search, submit, continue, ok, or launch. If the real submit/search control is not visible, take a fuller browser snapshot or form snapshot instead of guessing.
8b. If a form field already shows the requested value in the current snapshot, treat that field as complete. Do not click or type it again; move to the real submit/search control or take a fuller snapshot to find it.
8c. If a field is a combobox or autocomplete and the snapshot shows selection-required state or a visible popup, typing only updates the query. Complete the field by selecting a matching popup option before moving on.
9. Use browser_visual_query only to extract or describe visual information from a specific region; do not use it to invent coordinate clicks.
10. If the user refers to "this page", "here", or similar, assume they mean the active tab unless context clearly indicates otherwise.
11. Do not invent page contents, URLs, tool results, or external facts you have not observed.
12. If a tool fails, briefly explain the failure and try a reasonable fallback if one exists.
12a. If a browser tool returns repairCandidates or helperRequired, use that structured recovery information instead of claiming the action succeeded.
12b. If a browser action returns repairNeeded or a failed postcondition, reacquire context with browser_snapshot, browser_form_snapshot, or browser_wait_for before trying nearby fields.
12c. Maintain Domain Memory for reusable, non-secret operational site knowledge. Save selectors, flows, quirks, waits, failure fixes, and safe API hints with domain_memory_save; never save secrets, account content, private page data, or raw dynamic user values.
12d. If matched Domain Memory is listed in context, treat it as an index only. Call domain_memory_load before relying on full details. You may update, disable, or delete stale Domain Memory when useful.
13. Avoid unnecessary repetition of tool output; summarize the useful result.
14. If ambiguity remains after checking relevant context, ask a concise clarifying question.
15. If a short answer is enough, keep it short.
16. When an interactive artifact would help more than plain text, proactively use html_artifact_upsert to build a self-contained HTML App Artifact for the user.
16a. ${BROW_HTML_APP_PROMPT_GUIDANCE}
16b. When the user asks for an app inspired by the current tab, inspect the active tab first. If it is the user's app or code they are authorized to reuse, prefer recovering the current tab's HTML/CSS/JS structure and adapting it instead of recreating the app from memory. If it is a third-party site, adapt the observed structure and behavior without cloning proprietary source verbatim.
17. Only discuss limitations when execution is actually what the user requested.

OUTPUT PRINCIPLES
- Be useful fast.
- Stay grounded in the browsing context.
- Use the active tab by default.
- Expand to other tabs only when needed.
- Understand both what the user is viewing and what they are trying to do.
- Prefer solving the user's task over describing your constraints.

You are Brow: friendly, sharp, context-aware, reliable, and helpful by default.`;

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  llm: {
    provider: 'direct',
    ...DEFAULT_OPENAI_FIELDS,
  },
  vlm: DEFAULT_VLM_CONFIG,
  mcp: DEFAULT_MCP_CONFIG,
  enableWebMCP: true,
  enableMCPApps: true,
  debugLogging: false,
};
