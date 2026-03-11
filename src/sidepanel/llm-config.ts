// ─── LLM Configuration ──────────────────────────────────────────────────────
// Mirrors the proven pattern from agent-singleton / llmaas-config.

import { ChatOpenAI } from '@langchain/openai';
import type { DirectLLMConfig, LMaaSConfig } from '../shared/types';

export type ChatOpenAIInstance = InstanceType<typeof ChatOpenAI>;
export type LLMConfigUnion = DirectLLMConfig | LMaaSConfig;

// ─── Default configs (mirroring in-person-training-samples) ─────────────────

export const DEFAULT_DIRECT_CONFIG: DirectLLMConfig = {
  provider: 'direct',
  baseUrl: 'http://frbucawdl08.av.lab.ge-healthcare.net:4008/v1',
  apiKey: 'test',
  model: 'Qwen/Qwen3-Coder-Next-FP8',
};

export const DEFAULT_LMAAS_CONFIG: LMaaSConfig = {
  provider: 'lmaas',
  clientId: 'YgfOyfUMHU2oQxWQPKiuG4gifPAa',
  clientSecret: 'teflpHu0UUtimxR1jS9lW4xI6jsa',
  audience: '0_b2dJB20TBhxzLIHCMzSG4RiQYa',
  deployment: 'integ-gpt-4.1-2025-04-14',
};

// ─── Runtime config override ───────────────────────────────────────────────

let runtimeConfig: LLMConfigUnion | null = null;

/**
 * Apply a new LLM configuration at runtime.
 * Does NOT recreate the LLM — call `resetLlm()` then queries will
 * lazily rebuild.
 */
export function reconfigureLlm(config: LLMConfigUnion): void {
  runtimeConfig = config;
  console.log('[LLM] Reconfigured:', config.provider);
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
      console.log('[LLM] Initialised:', config.provider);
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
  console.log('[LLM] Reset — will re-initialise on next query');
}

/**
 * Synchronously return the cached LLM instance.
 * Throws if ensureLlm() hasn't resolved yet.
 */
export function getLlmSync(): ChatOpenAIInstance {
  if (!baseLlm) throw new Error('LLM not initialised yet — call ensureLlm() first');
  return baseLlm;
}

/**
 * Create a ChatOpenAI instance for the given configuration.
 */
export async function createLlm(config: LLMConfigUnion): Promise<ChatOpenAIInstance> {
  if (config.provider === 'direct') {
    console.log(`[LLM] Creating Direct LLM → ${config.baseUrl} (model: ${config.model})`);
    return new ChatOpenAI({
      model: config.model,
      apiKey: config.apiKey || 'not-needed',
      temperature: 0,
      configuration: {
        baseURL: config.baseUrl,
      },
    });
  }

  // LMaaS provider
  console.log(`[LLM] Creating LMaaS LLM → deployment: ${config.deployment}`);

  // For LMaaS, we need to fetch an IDAM token first
  // For now, create with placeholder — token refresh handled separately
  const token = await fetchIdamToken(config);

  return new ChatOpenAI({
    model: config.deployment,
    apiKey: token,
    configuration: {
      baseURL: `https://lmaas-integ-int.ailab.gehealthcare.net/openai/deployments/${config.deployment}`,
      defaultQuery: { 'api-version': '2025-04-01-preview' },
    },
  });
}

/**
 * Fetch an IDAM token for LMaaS authentication.
 */
async function fetchIdamToken(config: LMaaSConfig): Promise<string> {
  const tokenEndpoint = config.tokenEndpoint || 'https://idam.gehealthcloud.io/oauth2/token';

  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      audience: config.audience,
    });

    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) throw new Error(`IDAM token request failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.access_token;
  } catch (err: any) {
    console.error('[LLM] IDAM token fetch failed:', err.message);
    return 'idam-token-failed';
  }
}
