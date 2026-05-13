import { DEFAULT_SYSTEM_PROMPT } from '../../shared/config';
import {
  DOMAIN_SKILL_REGISTRY_STORAGE_KEY,
  LEGACY_SKILL_REGISTRY_STORAGE_KEY,
  getStorageValue,
  getStorageValues,
  loadSidepanelConfig,
  saveSidepanelConfig,
  setStorageValues,
  type SidepanelConfigRecord,
} from '../../shared/storage';
import type { ProviderFields } from '../../shared/config';
import { getInteractionSkillRegistry } from '../interaction-skills';
import {
  normalizeSkillRegistry,
  type SkillRegistryEntry,
} from '../skills-registry';
import { loadDomainSkillProposalEntries } from '../domain-skill-proposals';
import type { InteractionSkillEntry } from '../../shared/types';
import type { DomainSkillProposal } from '../../shared/types';

export async function loadDomainSkillRegistryEntries(): Promise<SkillRegistryEntry[]> {
  const values = await getStorageValues([
    DOMAIN_SKILL_REGISTRY_STORAGE_KEY,
    LEGACY_SKILL_REGISTRY_STORAGE_KEY,
  ]);
  const storedDomainSkills = normalizeSkillRegistry(values[DOMAIN_SKILL_REGISTRY_STORAGE_KEY]);
  if (storedDomainSkills.length > 0) return storedDomainSkills;

  const legacySkills = normalizeSkillRegistry(values[LEGACY_SKILL_REGISTRY_STORAGE_KEY]);
  if (legacySkills.length > 0) {
    await setStorageValues({ [DOMAIN_SKILL_REGISTRY_STORAGE_KEY]: legacySkills });
  }
  return legacySkills;
}

export async function loadPromptEditorState(): Promise<{
  systemPrompt: string;
  domainSkills: SkillRegistryEntry[];
  domainSkillProposals: DomainSkillProposal[];
  interactionSkills: InteractionSkillEntry[];
}> {
  const [config, domainSkills, domainSkillProposals] = await Promise.all([
    loadSidepanelConfig(),
    loadDomainSkillRegistryEntries(),
    loadDomainSkillProposalEntries(),
  ]);

  return {
    systemPrompt: config.runtime.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    domainSkills,
    domainSkillProposals,
    interactionSkills: getInteractionSkillRegistry(),
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
  fields: ProviderFields;
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

export async function saveDomainSkillRegistryEntries(skills: SkillRegistryEntry[]): Promise<SkillRegistryEntry[]> {
  const normalized = normalizeSkillRegistry(skills);
  await setStorageValues({ [DOMAIN_SKILL_REGISTRY_STORAGE_KEY]: normalized });
  return normalized;
}

export const saveSkillRegistryEntries = saveDomainSkillRegistryEntries;
