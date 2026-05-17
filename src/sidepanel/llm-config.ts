// ─── LLM Configuration ──────────────────────────────────────────────────────
// Mirrors the proven pattern from agent-singleton / llmaas-config.

import { ChatOpenAI } from '@langchain/openai';
import type { DirectLLMConfig } from '../shared/types';
import { DEFAULT_CLAUDE_FIELDS, DEFAULT_OPENAI_FIELDS } from '../shared/config';
import { logInfo } from '../shared/logger';

export type ChatOpenAIInstance = InstanceType<typeof ChatOpenAI>;
export type LLMConfigUnion = DirectLLMConfig;

// ─── Default configs ──────────────────────────────────────────────────────

export const DEFAULT_OPENAI_CONFIG: DirectLLMConfig = {
  provider: 'direct',
  ...DEFAULT_OPENAI_FIELDS,
};

export const DEFAULT_CLAUDE_CONFIG: DirectLLMConfig = {
  provider: 'direct',
  ...DEFAULT_CLAUDE_FIELDS,
};

// Backwards-compat alias used by index.ts
export const DEFAULT_DIRECT_CONFIG = DEFAULT_OPENAI_CONFIG;

// ─── Runtime config override ───────────────────────────────────────────────

let runtimeConfig: LLMConfigUnion | null = null;

/**
 * Apply a new LLM configuration at runtime.
 * Does NOT recreate the LLM — call `resetLlm()` then queries will
 * lazily rebuild.
 */
export function reconfigureLlm(config: LLMConfigUnion): void {
  runtimeConfig = config;
  logInfo('llm', 'Reconfigured:', config.provider);
}

export function getRuntimeLlmConfig(): LLMConfigUnion | null {
  return runtimeConfig;
}

// ─── Lazy LLM singleton ───────────────────────────────────────────────────

let baseLlm: ChatOpenAIInstance | null = null;
let llmReady: Promise<ChatOpenAIInstance> | null = null;

/**
 * Ensure the LLM singleton is initialised.
 * Returns the ChatOpenAI instance, creating it on first call.
 */
export async function ensureLlm(): Promise<ChatOpenAIInstance> {
  if (baseLlm) return baseLlm;
  if (!llmReady) {
    llmReady = (async () => {
      const config = runtimeConfig ?? DEFAULT_DIRECT_CONFIG;
      baseLlm = await createLlm(config);
      logInfo('llm', 'Initialised:', config.provider);
      return baseLlm;
    })();
  }
  return llmReady;
}

/**
 * Reset the LLM singleton so the next query rebuilds it with
 * current configuration.
 */
export function resetLlm(): void {
  baseLlm = null;
  llmReady = null;
  logInfo('llm', 'Reset — will re-initialise on next query');
}

/**
 * Synchronously return the cached LLM instance.
 * Throws if ensureLlm() hasn't resolved yet.
 */
export function getLlmSync(): ChatOpenAIInstance {
  if (!baseLlm) throw new Error('LLM not initialised yet — call ensureLlm() first');
  return baseLlm;
}

function shouldOmitTemperature(model: string): boolean {
  return /^gpt-5(?:$|[-.])/.test(model);
}

/**
 * Create a ChatOpenAI instance for the given configuration.
 */
export async function createLlm(config: LLMConfigUnion): Promise<ChatOpenAIInstance> {
  logInfo('llm', `Creating LLM → ${config.baseUrl} (model: ${config.model})`);
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey || 'not-needed',
    ...(shouldOmitTemperature(config.model) ? {} : { temperature: 0 }),
    configuration: {
      baseURL: config.baseUrl,
    },
  });
}
