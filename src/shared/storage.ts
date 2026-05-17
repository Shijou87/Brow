// ─── Shared Storage Helpers ────────────────────────────────────────────────
// Centralizes chrome.storage keys and normalization logic for Brow's persisted
// runtime state. Cross-runtime callers should prefer these helpers over raw
// storage access so schema drift and migration logic stay contained here.

import {
  DEFAULT_AGENT_RECURSION_LIMIT,
  DEFAULT_CLAUDE_FIELDS,
  DEFAULT_EXTENSION_SETTINGS,
  DEFAULT_OPENAI_FIELDS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_VLM_CONFIG,
  normalizeContextWindow,
  normalizePreferredOpenAiModel,
  normalizeRecursionLimit,
  type LLMProviderMode,
  type ProviderFields,
  type SidepanelRuntimeConfig,
} from './config';
import type {
  DirectLLMConfig,
  ExtensionSettings,
  HtmlAppExecutionPreferences,
  MCPConfig,
  VLMConfig,
} from './types';

export const SIDEPANEL_CONFIG_STORAGE_KEY = 'agent-webmcp-config';
export const EXTENSION_SETTINGS_STORAGE_KEY = 'agent-webmcp-settings';
export const DISABLED_TOOLS_STORAGE_KEY = 'agent-webmcp-disabled-tools';
export const CONVERSATIONS_STORAGE_KEY = 'agent-webmcp-conversations';
export const MCP_SERVERS_STORAGE_KEY = 'agent-webmcp-mcp-servers';
export const SKILL_REGISTRY_STORAGE_KEY = 'agent-webmcp-skills';
export const DOMAIN_SKILL_REGISTRY_STORAGE_KEY = 'agent-webmcp-domain-skills';
export const LEGACY_SKILL_REGISTRY_STORAGE_KEY = SKILL_REGISTRY_STORAGE_KEY;
export const DOMAIN_SKILL_PROPOSALS_STORAGE_KEY = 'agent-webmcp-domain-skill-proposals';
export const DOMAIN_MEMORY_STORAGE_KEY = 'agent-webmcp-domain-memory';
export const DOMAIN_TRUST_SETTINGS_STORAGE_KEY = 'agent-webmcp-domain-trust-settings';
export const BROW_ACTION_MEMORY_STORAGE_KEY = 'agent-webmcp-action-memory';
export const HTML_APP_EXECUTION_PREFERENCES_STORAGE_KEY = 'agent-webmcp-html-app-execution-preferences';

export interface SidepanelConfigRecord {
  activeMode: LLMProviderMode;
  openai: ProviderFields;
  claude: ProviderFields;
  runtime: SidepanelRuntimeConfig;
  vlm: VLMConfig;
}

type LooseRecord = Record<string, unknown>;

function isRecord(value: unknown): value is LooseRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toProviderFields(value: unknown, defaults: ProviderFields): ProviderFields {
  const record = isRecord(value) ? value : {};
  return {
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : defaults.baseUrl,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : defaults.apiKey,
    model: typeof record.model === 'string' ? record.model : defaults.model,
    contextWindow: normalizeContextWindow(record.contextWindow as number | string | undefined, defaults.contextWindow),
  };
}

function toVLMConfig(value: unknown): VLMConfig {
  const record = isRecord(value) ? value : {};
  return {
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : DEFAULT_VLM_CONFIG.baseUrl,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : DEFAULT_VLM_CONFIG.apiKey,
    model: typeof record.model === 'string' ? record.model : DEFAULT_VLM_CONFIG.model,
    useTextModel: typeof record.useTextModel === 'boolean'
      ? record.useTextModel
      : DEFAULT_VLM_CONFIG.useTextModel,
  };
}

function toMcpConfig(value: unknown): MCPConfig {
  const record = isRecord(value) ? value : {};
  const transport = record.transport;
  return {
    endpoint: typeof record.endpoint === 'string' ? record.endpoint : DEFAULT_EXTENSION_SETTINGS.mcp.endpoint,
    transport: transport === 'http' || transport === 'sse' || transport === 'streamable-http'
      ? transport
      : DEFAULT_EXTENSION_SETTINGS.mcp.transport,
    authToken: typeof record.authToken === 'string' && record.authToken
      ? record.authToken
      : undefined,
  };
}

function toDirectLlmConfig(fields: ProviderFields): DirectLLMConfig {
  return {
    provider: 'direct',
    ...fields,
  };
}

function normalizeSettings(raw: unknown, sidepanelConfig: SidepanelConfigRecord): ExtensionSettings {
  const record = isRecord(raw) ? raw : {};
  const llmFallback = sidepanelConfig.activeMode === 'claude'
    ? sidepanelConfig.claude
    : sidepanelConfig.openai;

  return {
    llm: toDirectLlmConfig(toProviderFields(record.llm, llmFallback)),
    vlm: toVLMConfig(record.vlm ?? sidepanelConfig.vlm),
    mcp: toMcpConfig(record.mcp),
    enableWebMCP: typeof record.enableWebMCP === 'boolean'
      ? record.enableWebMCP
      : DEFAULT_EXTENSION_SETTINGS.enableWebMCP,
    enableMCPApps: typeof record.enableMCPApps === 'boolean'
      ? record.enableMCPApps
      : DEFAULT_EXTENSION_SETTINGS.enableMCPApps,
    debugLogging: typeof record.debugLogging === 'boolean'
      ? record.debugLogging
      : DEFAULT_EXTENSION_SETTINGS.debugLogging,
  };
}

function normalizeSidepanelConfig(rawConfig: unknown, rawSettings: unknown): SidepanelConfigRecord {
  const config = isRecord(rawConfig) ? rawConfig : {};
  const settings = isRecord(rawSettings) ? rawSettings : {};
  const settingsLlm = settings.llm;

  const openai = toProviderFields(config.openai ?? config.direct ?? settingsLlm, DEFAULT_OPENAI_FIELDS);
  openai.model = normalizePreferredOpenAiModel(openai.model) ?? DEFAULT_OPENAI_FIELDS.model;
  const claude = toProviderFields(config.claude, DEFAULT_CLAUDE_FIELDS);
  const runtimeRecord = isRecord(config.runtime) ? config.runtime : {};
  const systemPrompt = typeof runtimeRecord.systemPrompt === 'string'
    ? runtimeRecord.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT
    : DEFAULT_SYSTEM_PROMPT;
  const recursionLimitValue =
    typeof runtimeRecord.recursionLimit === 'number' || typeof runtimeRecord.recursionLimit === 'string'
      ? runtimeRecord.recursionLimit
      : DEFAULT_AGENT_RECURSION_LIMIT;

  return {
    activeMode: config.activeMode === 'claude' ? 'claude' : 'openai',
    openai,
    claude,
    runtime: {
      recursionLimit: normalizeRecursionLimit(recursionLimitValue),
      systemPrompt,
      animatedBrow: typeof runtimeRecord.animatedBrow === 'boolean'
        ? runtimeRecord.animatedBrow
        : false,
    },
    vlm: toVLMConfig(config.vlm ?? settings.vlm),
  };
}

function serializeSidepanelConfig(config: SidepanelConfigRecord): LooseRecord {
  return {
    activeMode: config.activeMode,
    openai: config.openai,
    direct: config.openai,
    claude: config.claude,
    runtime: {
      recursionLimit: normalizeRecursionLimit(config.runtime.recursionLimit),
      systemPrompt: config.runtime.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
      animatedBrow: config.runtime.animatedBrow === true,
    },
    vlm: config.vlm,
  };
}

function normalizeHtmlAppExecutionPreferences(raw: unknown): HtmlAppExecutionPreferences {
  const record = isRecord(raw) ? raw : {};
  return {
    alwaysAllowExecution: typeof record.alwaysAllowExecution === 'boolean'
      ? record.alwaysAllowExecution
      : false,
  };
}

/**
 * Reads one value from chrome.storage.local and preserves the caller's target
 * type at the API boundary.
 */
export function getStorageValue<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      resolve(result[key] as T | undefined);
    });
  });
}

export function getStorageValues(keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result as Record<string, unknown>);
    });
  });
}

/**
 * Writes one or more values to chrome.storage.local.
 */
export function setStorageValues(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, () => resolve());
  });
}

/**
 * Loads the side-panel configuration record and normalizes legacy or partial
 * stored values into the current runtime shape.
 */
export async function loadSidepanelConfig(): Promise<SidepanelConfigRecord> {
  const values = await getStorageValues([SIDEPANEL_CONFIG_STORAGE_KEY, EXTENSION_SETTINGS_STORAGE_KEY]);
  return normalizeSidepanelConfig(
    values[SIDEPANEL_CONFIG_STORAGE_KEY],
    values[EXTENSION_SETTINGS_STORAGE_KEY],
  );
}

export async function saveSidepanelConfig(config: SidepanelConfigRecord): Promise<void> {
  const existingSettings = await getStorageValue<unknown>(EXTENSION_SETTINGS_STORAGE_KEY);
  const sidepanelConfig = normalizeSidepanelConfig(config, existingSettings);
  const nextSettings = normalizeSettings(existingSettings, sidepanelConfig);
  nextSettings.llm = toDirectLlmConfig(
    sidepanelConfig.activeMode === 'claude' ? sidepanelConfig.claude : sidepanelConfig.openai,
  );
  nextSettings.vlm = sidepanelConfig.vlm;

  await setStorageValues({
    [SIDEPANEL_CONFIG_STORAGE_KEY]: serializeSidepanelConfig(sidepanelConfig),
    [EXTENSION_SETTINGS_STORAGE_KEY]: nextSettings,
  });
}

export async function loadExtensionSettings(): Promise<ExtensionSettings> {
  const values = await getStorageValues([SIDEPANEL_CONFIG_STORAGE_KEY, EXTENSION_SETTINGS_STORAGE_KEY]);
  const sidepanelConfig = normalizeSidepanelConfig(
    values[SIDEPANEL_CONFIG_STORAGE_KEY],
    values[EXTENSION_SETTINGS_STORAGE_KEY],
  );
  return normalizeSettings(values[EXTENSION_SETTINGS_STORAGE_KEY], sidepanelConfig);
}

export async function saveExtensionSettings(settings: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const values = await getStorageValues([SIDEPANEL_CONFIG_STORAGE_KEY, EXTENSION_SETTINGS_STORAGE_KEY]);
  const currentSidepanelConfig = normalizeSidepanelConfig(
    values[SIDEPANEL_CONFIG_STORAGE_KEY],
    values[EXTENSION_SETTINGS_STORAGE_KEY],
  );
  const currentSettings = normalizeSettings(values[EXTENSION_SETTINGS_STORAGE_KEY], currentSidepanelConfig);
  const nextSettings = normalizeSettings({ ...currentSettings, ...settings }, currentSidepanelConfig);

  const llmFields = toProviderFields(settings.llm, currentSidepanelConfig.openai);
  const nextSidepanelConfig: SidepanelConfigRecord = {
    ...currentSidepanelConfig,
    openai: settings.llm
      ? {
        ...llmFields,
        model: normalizePreferredOpenAiModel(llmFields.model) ?? DEFAULT_OPENAI_FIELDS.model,
      }
      : currentSidepanelConfig.openai,
    vlm: settings.vlm ? toVLMConfig(settings.vlm) : currentSidepanelConfig.vlm,
  };

  await setStorageValues({
    [EXTENSION_SETTINGS_STORAGE_KEY]: nextSettings,
    [SIDEPANEL_CONFIG_STORAGE_KEY]: serializeSidepanelConfig(nextSidepanelConfig),
  });

  return nextSettings;
}

export async function loadDisabledTools(): Promise<string[] | null> {
  const saved = await getStorageValue<unknown>(DISABLED_TOOLS_STORAGE_KEY);
  if (saved === undefined) return null;
  return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string') : [];
}

export function saveDisabledTools(disabledTools: string[]): Promise<void> {
  return setStorageValues({ [DISABLED_TOOLS_STORAGE_KEY]: disabledTools });
}

export async function loadHtmlAppExecutionPreferences(): Promise<HtmlAppExecutionPreferences> {
  const saved = await getStorageValue<unknown>(HTML_APP_EXECUTION_PREFERENCES_STORAGE_KEY);
  return normalizeHtmlAppExecutionPreferences(saved);
}

export async function saveHtmlAppExecutionPreferences(
  updates: Partial<HtmlAppExecutionPreferences>,
): Promise<HtmlAppExecutionPreferences> {
  const current = await loadHtmlAppExecutionPreferences();
  const next = normalizeHtmlAppExecutionPreferences({
    ...current,
    ...updates,
  });
  await setStorageValues({
    [HTML_APP_EXECUTION_PREFERENCES_STORAGE_KEY]: next,
  });
  return next;
}
