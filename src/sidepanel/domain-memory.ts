import {
  DOMAIN_MEMORY_STORAGE_KEY,
  getStorageValue,
  setStorageValues,
} from '../shared/storage';
import type {
  DomainMemoryDraft,
  DomainMemoryEntry,
  DomainMemoryOutcome,
  DomainSkillMatcher,
} from '../shared/types';
import {
  formatDomainSkillMatcherSummary,
  matchesDomainMatcherContext,
  parseSkillTagsInput,
} from './skills-registry';

const DOMAIN_MEMORY_VERSION = 1;
const DEFAULT_CONFIDENCE = 0.6;
const MAX_DOMAIN_MEMORY_ENTRIES = 500;
const MAX_MATCHED_MEMORY_INDEX_ENTRIES = 8;
const SECRETISH_PATTERNS = [
  /\b(?:password|passwd|api[_ -]?key|secret|access[_ -]?token|refresh[_ -]?token|cookie|authorization)\b\s*[:=]\s*\S+/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{12,}\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:\d[ -]*?){13,19}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `domain-memory-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampConfidence(value: unknown, fallback = DEFAULT_CONFIDENCE): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizeTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map((value) => normalizeString(value)).filter(Boolean)));
  }
  if (typeof raw === 'string') {
    return parseSkillTagsInput(raw);
  }
  return [];
}

function normalizeMatcher(raw: unknown): DomainSkillMatcher | undefined {
  if (!isRecord(raw)) return undefined;
  const domain = normalizeString(raw.domain).toLowerCase() || undefined;
  const pathPatterns = normalizeTags(raw.pathPatterns);
  const pagePatterns = normalizeTags(raw.pagePatterns);
  if (!domain && pathPatterns.length === 0 && pagePatterns.length === 0) return undefined;
  return {
    domain,
    pathPatterns: pathPatterns.length > 0 ? pathPatterns : undefined,
    pagePatterns: pagePatterns.length > 0 ? pagePatterns : undefined,
  };
}

function normalizeOutcome(value: unknown): DomainMemoryOutcome {
  return value === 'success' || value === 'failure' ? value : 'neutral';
}

function normalizeDomainMemoryEntry(raw: unknown): DomainMemoryEntry | null {
  if (!isRecord(raw)) return null;
  const title = normalizeString(raw.title);
  const lesson = normalizeString(raw.lesson);
  if (!title || !lesson) return null;
  const now = Date.now();
  const createdAt = Number(raw.createdAt) || now;
  const updatedAt = Number(raw.updatedAt) || createdAt;
  const lastUsedAt = Number(raw.lastUsedAt) || undefined;
  const lastSucceededAt = Number(raw.lastSucceededAt) || undefined;
  const lastFailedAt = Number(raw.lastFailedAt) || undefined;

  return {
    id: normalizeString(raw.id) || stableId(),
    version: DOMAIN_MEMORY_VERSION,
    title,
    lesson,
    appliesWhen: normalizeString(raw.appliesWhen) || undefined,
    matcher: normalizeMatcher(raw.matcher),
    tags: normalizeTags(raw.tags),
    evidence: normalizeTags(raw.evidence),
    confidence: clampConfidence(raw.confidence),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    useCount: Math.max(0, Math.floor(Number(raw.useCount) || 0)),
    successCount: Math.max(0, Math.floor(Number(raw.successCount) || 0)),
    failureCount: Math.max(0, Math.floor(Number(raw.failureCount) || 0)),
    createdAt,
    updatedAt,
    lastUsedAt,
    lastSucceededAt,
    lastFailedAt,
  };
}

export function normalizeDomainMemoryRegistry(raw: unknown): DomainMemoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, DomainMemoryEntry>();
  for (const item of raw) {
    const entry = normalizeDomainMemoryEntry(item);
    if (!entry) continue;
    byId.set(entry.id, entry);
  }
  return sortDomainMemoryEntries([...byId.values()]).slice(0, MAX_DOMAIN_MEMORY_ENTRIES);
}

function sortDomainMemoryEntries(entries: DomainMemoryEntry[]): DomainMemoryEntry[] {
  return [...entries].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return right.updatedAt - left.updatedAt;
  });
}

export function hasDisallowedDomainMemoryContent(values: Array<string | undefined>): boolean {
  const text = values.filter(Boolean).join('\n');
  return SECRETISH_PATTERNS.some((pattern) => pattern.test(text));
}

export function validateDomainMemoryDraft(draft: DomainMemoryDraft): { ok: true } | { ok: false; error: string } {
  const title = normalizeString(draft.title);
  const lesson = normalizeString(draft.lesson);
  if (!title || !lesson) {
    return { ok: false, error: 'Domain Memory requires a title and lesson.' };
  }
  if (!draft.matcher?.domain) {
    return { ok: false, error: 'Domain Memory requires a domain scope.' };
  }
  if (hasDisallowedDomainMemoryContent([
    title,
    lesson,
    draft.appliesWhen,
    ...(draft.tags ?? []),
    ...(draft.evidence ?? []),
  ])) {
    return { ok: false, error: 'Domain Memory must not store secrets, credentials, account content, or private user data.' };
  }
  return { ok: true };
}

function normalizeTextKey(value: string | undefined): string {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matcherDedupeKey(matcher: DomainSkillMatcher | undefined): string {
  return [
    matcher?.domain?.toLowerCase() ?? '',
    ...(matcher?.pathPatterns ?? []).map((value) => `path:${value.toLowerCase()}`),
    ...(matcher?.pagePatterns ?? []).map((value) => `page:${value.toLowerCase()}`),
  ].join('|');
}

export function buildDomainMemoryDedupeKey(draft: Pick<DomainMemoryDraft, 'title' | 'lesson' | 'matcher'>): string {
  const title = normalizeTextKey(draft.title);
  const lesson = normalizeTextKey(draft.lesson).slice(0, 96);
  return [
    matcherDedupeKey(draft.matcher),
    title || lesson,
  ].join('|');
}

function mergeLists(left: string[], right: string[] | undefined): string[] {
  return Array.from(new Set([...left, ...(right ?? []).map((value) => normalizeString(value)).filter(Boolean)]));
}

function adjustConfidence(
  current: number,
  draftConfidence: number | undefined,
  outcome: DomainMemoryOutcome,
): number {
  let confidence = typeof draftConfidence === 'number'
    ? clampConfidence(draftConfidence, current)
    : current;
  if (outcome === 'success') confidence += 0.06;
  if (outcome === 'failure') confidence -= 0.18;
  return clampConfidence(confidence, DEFAULT_CONFIDENCE);
}

export function upsertDomainMemoryEntries(
  entries: DomainMemoryEntry[],
  draft: DomainMemoryDraft,
  now = Date.now(),
): {
  entry: DomainMemoryEntry;
  entries: DomainMemoryEntry[];
  merged: boolean;
} {
  const normalizedDraft: DomainMemoryDraft = {
    ...draft,
    title: normalizeString(draft.title),
    lesson: normalizeString(draft.lesson),
    appliesWhen: normalizeString(draft.appliesWhen) || undefined,
    matcher: normalizeMatcher(draft.matcher),
    tags: normalizeTags(draft.tags),
    evidence: normalizeTags(draft.evidence),
    confidence: draft.confidence == null ? undefined : clampConfidence(draft.confidence),
    outcome: normalizeOutcome(draft.outcome),
  };
  const validation = validateDomainMemoryDraft(normalizedDraft);
  if ('error' in validation) throw new Error(validation.error);

  const dedupeKey = buildDomainMemoryDedupeKey(normalizedDraft);
  const existing = normalizedDraft.id
    ? entries.find((entry) => entry.id === normalizedDraft.id)
    : entries.find((entry) => buildDomainMemoryDedupeKey(entry) === dedupeKey);
  const outcome = normalizedDraft.outcome ?? 'neutral';
  const outcomeDelta = outcome === 'neutral' ? 0 : 1;
  const existingConfidence = existing?.confidence ?? DEFAULT_CONFIDENCE;

  const entry: DomainMemoryEntry = existing
    ? {
      ...existing,
      title: normalizedDraft.title,
      lesson: normalizedDraft.lesson,
      appliesWhen: normalizedDraft.appliesWhen ?? existing.appliesWhen,
      matcher: normalizedDraft.matcher ?? existing.matcher,
      tags: mergeLists(existing.tags, normalizedDraft.tags),
      evidence: mergeLists(existing.evidence, normalizedDraft.evidence),
      confidence: adjustConfidence(existingConfidence, normalizedDraft.confidence, outcome),
      enabled: normalizedDraft.enabled ?? existing.enabled,
      useCount: existing.useCount + outcomeDelta,
      successCount: existing.successCount + (outcome === 'success' ? 1 : 0),
      failureCount: existing.failureCount + (outcome === 'failure' ? 1 : 0),
      updatedAt: now,
      lastUsedAt: outcomeDelta ? now : existing.lastUsedAt,
      lastSucceededAt: outcome === 'success' ? now : existing.lastSucceededAt,
      lastFailedAt: outcome === 'failure' ? now : existing.lastFailedAt,
    }
    : {
      id: normalizedDraft.id || stableId(),
      version: DOMAIN_MEMORY_VERSION,
      title: normalizedDraft.title,
      lesson: normalizedDraft.lesson,
      appliesWhen: normalizedDraft.appliesWhen,
      matcher: normalizedDraft.matcher,
      tags: normalizedDraft.tags ?? [],
      evidence: normalizedDraft.evidence ?? [],
      confidence: adjustConfidence(normalizedDraft.confidence ?? DEFAULT_CONFIDENCE, undefined, outcome),
      enabled: normalizedDraft.enabled ?? true,
      useCount: outcomeDelta,
      successCount: outcome === 'success' ? 1 : 0,
      failureCount: outcome === 'failure' ? 1 : 0,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: outcomeDelta ? now : undefined,
      lastSucceededAt: outcome === 'success' ? now : undefined,
      lastFailedAt: outcome === 'failure' ? now : undefined,
    };

  return {
    entry,
    entries: sortDomainMemoryEntries([
      entry,
      ...entries.filter((item) => item.id !== entry.id),
    ]).slice(0, MAX_DOMAIN_MEMORY_ENTRIES),
    merged: Boolean(existing),
  };
}

export async function loadDomainMemoryEntries(): Promise<DomainMemoryEntry[]> {
  return normalizeDomainMemoryRegistry(await getStorageValue<unknown>(DOMAIN_MEMORY_STORAGE_KEY));
}

export async function saveDomainMemoryEntries(entries: DomainMemoryEntry[]): Promise<DomainMemoryEntry[]> {
  const normalized = normalizeDomainMemoryRegistry(entries);
  await setStorageValues({ [DOMAIN_MEMORY_STORAGE_KEY]: normalized });
  return normalized;
}

export async function saveDomainMemoryDraft(draft: DomainMemoryDraft): Promise<{
  entry: DomainMemoryEntry;
  entries: DomainMemoryEntry[];
  merged: boolean;
}> {
  const entries = await loadDomainMemoryEntries();
  const result = upsertDomainMemoryEntries(entries, draft);
  await saveDomainMemoryEntries(result.entries);
  return result;
}

export async function setDomainMemoryEnabled(id: string, enabled: boolean): Promise<DomainMemoryEntry | null> {
  const entries = await loadDomainMemoryEntries();
  const now = Date.now();
  let updated: DomainMemoryEntry | null = null;
  const next = entries.map((entry) => {
    if (entry.id !== id) return entry;
    updated = { ...entry, enabled, updatedAt: now };
    return updated;
  });
  if (!updated) return null;
  await saveDomainMemoryEntries(next);
  return updated;
}

export async function deleteDomainMemoryEntry(id: string): Promise<boolean> {
  const entries = await loadDomainMemoryEntries();
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length === entries.length) return false;
  await saveDomainMemoryEntries(next);
  return true;
}

export function matchesDomainMemoryContext(
  entry: DomainMemoryEntry,
  context: { url?: string; title?: string },
): boolean {
  return entry.enabled && matchesDomainMatcherContext(entry.matcher, context);
}

export function queryDomainMemoryEntries(
  entries: DomainMemoryEntry[],
  filters: {
    id?: string;
    domain?: string;
    query?: string;
    includeDisabled?: boolean;
    limit?: number;
  } = {},
): DomainMemoryEntry[] {
  const normalizedDomain = normalizeString(filters.domain).toLowerCase();
  const normalizedQuery = normalizeTextKey(filters.query);
  const limit = Math.max(1, Math.min(50, Math.floor(Number(filters.limit) || 20)));

  const results = entries.filter((entry) => {
    if (!filters.includeDisabled && !entry.enabled) return false;
    if (filters.id && entry.id !== filters.id) return false;
    if (normalizedDomain) {
      const domain = entry.matcher?.domain?.toLowerCase() ?? '';
      if (!domain || (domain !== normalizedDomain && !normalizedDomain.endsWith(`.${domain}`))) return false;
    }
    if (normalizedQuery) {
      const haystack = normalizeTextKey([
        entry.title,
        entry.lesson,
        entry.appliesWhen,
        ...(entry.tags ?? []),
        ...(entry.evidence ?? []),
        entry.matcher?.domain,
        ...(entry.matcher?.pathPatterns ?? []),
        ...(entry.matcher?.pagePatterns ?? []),
      ].filter(Boolean).join(' '));
      if (!haystack.includes(normalizedQuery)) return false;
    }
    return true;
  });

  return sortDomainMemoryEntries(results).slice(0, limit);
}

export function findMatchedDomainMemoryEntries(
  entries: DomainMemoryEntry[],
  contexts: Array<{ url?: string; title?: string }>,
  limit = MAX_MATCHED_MEMORY_INDEX_ENTRIES,
): DomainMemoryEntry[] {
  const matched = entries.filter((entry) => contexts.some((context) => matchesDomainMemoryContext(entry, context)));
  return sortDomainMemoryEntries(matched).slice(0, limit);
}

export function buildDomainMemoryIndexContext(
  entries: DomainMemoryEntry[],
  contexts: Array<{ url?: string; title?: string }>,
): string {
  const matched = findMatchedDomainMemoryEntries(entries, contexts);
  if (matched.length === 0) return '';

  return [
    'Matched Domain Memory for the selected browser context:',
    'These are local, agent-managed operational notes. They are an index only; call domain_memory_load with an id before relying on full details.',
    ...matched.map((entry) => {
      const scope = formatDomainSkillMatcherSummary(entry.matcher) || 'global';
      const tags = entry.tags.length > 0 ? ` — tags: ${entry.tags.join(', ')}` : '';
      const appliesWhen = entry.appliesWhen ? ` — load when: ${entry.appliesWhen}` : '';
      const confidence = Math.round(entry.confidence * 100);
      return `- ${entry.title} (id: ${entry.id}) — scope: ${scope} — confidence: ${confidence}%${tags}${appliesWhen}`;
    }),
  ].join('\n');
}
