import type { DirectLLMConfig, ExtensionSettings, MCPConfig, VLMConfig } from './types';

export type LLMProviderMode = 'openai' | 'claude';
export type ProviderFields = Omit<DirectLLMConfig, 'provider'>;

export interface SidepanelRuntimeConfig {
  recursionLimit: number;
  systemPrompt: string;
}

export const DEFAULT_AGENT_RECURSION_LIMIT = 100;

export function normalizeRecursionLimit(limit: number | string | undefined | null): number {
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed)) return DEFAULT_AGENT_RECURSION_LIMIT;
  return Math.max(1, Math.floor(parsed));
}

export const DEFAULT_OPENAI_FIELDS: ProviderFields = {
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'not-needed',
  model: 'gpt-4o',
};

export const DEFAULT_CLAUDE_FIELDS: ProviderFields = {
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: '',
  model: 'claude-opus-4-5',
};

export const DEFAULT_VLM_CONFIG: VLMConfig = {
  baseUrl: 'http://frbucawdl08.av.lab.ge-healthcare.net:4010/v1',
  apiKey: '',
  model: 'Qwen3-VL-30B-A3B-Thinking',
};

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
6. If the user refers to "this page", "here", or similar, assume they mean the active tab unless context clearly indicates otherwise.
7. Do not invent page contents, URLs, tool results, or external facts you have not observed.
8. If a tool fails, briefly explain the failure and try a reasonable fallback if one exists.
9. Avoid unnecessary repetition of tool output; summarize the useful result.
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

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  llm: {
    provider: 'direct',
    ...DEFAULT_OPENAI_FIELDS,
  },
  vlm: DEFAULT_VLM_CONFIG,
  mcp: DEFAULT_MCP_CONFIG,
  enableWebMCP: true,
  enableMCPApps: true,
  debugLogging: true,
};

