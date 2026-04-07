import { DEFAULT_SYSTEM_PROMPT } from '../../shared/config';
import {
  SKILL_REGISTRY_STORAGE_KEY,
  getStorageValue,
  loadSidepanelConfig,
  saveSidepanelConfig,
  setStorageValues,
  type SidepanelConfigRecord,
} from '../../shared/storage';
import {
  normalizeSkillRegistry,
  type SkillRegistryEntry,
} from '../skills-registry';

export async function loadPromptEditorState(): Promise<{
  systemPrompt: string;
  skills: SkillRegistryEntry[];
}> {
  const [config, rawSkills] = await Promise.all([
    loadSidepanelConfig(),
    getStorageValue<unknown>(SKILL_REGISTRY_STORAGE_KEY),
  ]);

  return {
    systemPrompt: config.runtime.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    skills: normalizeSkillRegistry(rawSkills),
  };
}

export async function saveSystemPrompt(systemPrompt: string): Promise<void> {
  const config = await loadSidepanelConfig();
  config.runtime = {
    ...config.runtime,
    systemPrompt: systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
  };
  await saveSidepanelConfig(config);
}

export async function loadConfigEditorState(): Promise<SidepanelConfigRecord> {
  return loadSidepanelConfig();
}

export async function saveConfigEditorState(params: {
  mode: 'openai' | 'claude';
  fields: Record<string, string>;
  recursionLimit: number;
  vlm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}): Promise<void> {
  const config = await loadSidepanelConfig();
  if (params.mode === 'openai') {
    config.openai = {
      ...config.openai,
      ...params.fields,
    };
  } else {
    config.claude = {
      ...config.claude,
      ...params.fields,
    };
  }
  config.activeMode = params.mode;
  config.runtime = {
    ...config.runtime,
    recursionLimit: params.recursionLimit,
  };
  config.vlm = {
    ...config.vlm,
    ...params.vlm,
  };
  await saveSidepanelConfig(config);
}

export async function saveSkillRegistryEntries(skills: SkillRegistryEntry[]): Promise<SkillRegistryEntry[]> {
  const normalized = normalizeSkillRegistry(skills);
  await setStorageValues({ [SKILL_REGISTRY_STORAGE_KEY]: normalized });
  return normalized;
}
