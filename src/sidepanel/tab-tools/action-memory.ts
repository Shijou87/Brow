import {
  BROW_ACTION_MEMORY_STORAGE_KEY,
  getStorageValue,
  setStorageValues,
} from '../../shared/storage';
import type {
  BrowserSnapshotElement,
  BrowActionKind,
  BrowActionMemoryEntry,
  BrowActionMemoryField,
  BrowActionMemoryStore,
  BrowActionMemoryTarget,
  BrowElementSignature,
} from '../../shared/types';

const ACTION_MEMORY_VERSION = 1;
const MAX_ACTION_MEMORY_ENTRIES = 200;
const ACTION_MEMORY_MIN_SCORE = 38;
const DYNAMIC_SEGMENT_RE = /^(?:\d+|[0-9a-f]{8,}|[0-9a-f-]{12,}|[A-Za-z0-9_-]{18,})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanInlineText(value: string | undefined | null, max = 160): string | undefined {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function stableId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `action-memory-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeActionIntent(intent: string | undefined | null): string {
  return (intent ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function buildPathPattern(pathname: string): string {
  const path = pathname || '/';
  const parts = path.split('/').map((segment) => {
    if (!segment) return segment;
    return DYNAMIC_SEGMENT_RE.test(segment) ? ':id' : segment.toLowerCase();
  });
  return parts.join('/') || '/';
}

export function buildActionMemoryKey(params: {
  actionKind: BrowActionKind;
  intent?: string;
  url?: string;
}): { key?: string; origin?: string; pathPattern?: string; normalizedIntent: string } {
  const normalizedIntent = normalizeActionIntent(params.intent);
  if (!normalizedIntent || !params.url) return { normalizedIntent };

  try {
    const parsed = new URL(params.url);
    const origin = parsed.origin.toLowerCase();
    const pathPattern = buildPathPattern(parsed.pathname);
    return {
      key: `${origin}|${pathPattern}|${params.actionKind}|${normalizedIntent}`,
      origin,
      pathPattern,
      normalizedIntent,
    };
  } catch {
    return { normalizedIntent };
  }
}

function isTextEntry(element: BrowserSnapshotElement): boolean {
  return ['textbox', 'searchbox'].includes(element.role)
    || ['input', 'textarea'].includes(element.tagName)
    || element.type === 'password';
}

export function signatureFromElement(element: BrowserSnapshotElement): BrowElementSignature {
  const textEntry = isTextEntry(element);
  const attributes = element.attributes ? { ...element.attributes } : undefined;
  const safeName = textEntry
    ? cleanInlineText(
      attributes?.['aria-label']
      ?? attributes?.placeholder
      ?? attributes?.name
      ?? attributes?.title,
      120,
    )
    : cleanInlineText(element.name, 120);

  return {
    role: element.role,
    name: safeName ?? '',
    text: textEntry ? undefined : cleanInlineText(element.text, 120),
    tagName: element.tagName,
    type: element.type,
    selector: cleanInlineText(element.selector, 240),
    attributes,
  };
}

export function scoreElementSignature(
  signature: BrowElementSignature,
  candidate: BrowserSnapshotElement,
): number {
  const candidateSignature = signatureFromElement(candidate);
  let score = 0;

  if (candidateSignature.role === signature.role) score += 16;
  if (candidateSignature.tagName === signature.tagName) score += 10;
  if (signature.type && candidateSignature.type === signature.type) score += 8;
  if (signature.selector && candidateSignature.selector === signature.selector) score += 12;

  if (signature.name && candidateSignature.name) {
    if (candidateSignature.name === signature.name) score += 36;
    else if (candidateSignature.name.toLowerCase() === signature.name.toLowerCase()) score += 24;
  }

  if (signature.text && candidateSignature.text) {
    if (candidateSignature.text === signature.text) score += 14;
    else if (candidateSignature.text.toLowerCase() === signature.text.toLowerCase()) score += 8;
  }

  const attrs = signature.attributes ?? {};
  const candidateAttrs = candidateSignature.attributes ?? {};
  const weightedAttrs: Array<[string, number]> = [
    ['id', 30],
    ['data-testid', 30],
    ['data-test', 26],
    ['aria-label', 22],
    ['name', 16],
    ['placeholder', 16],
    ['title', 14],
    ['alt', 14],
  ];

  for (const [name, weight] of weightedAttrs) {
    if (attrs[name] && attrs[name] === candidateAttrs[name]) {
      score += weight;
    }
  }

  return score;
}

export function isConfidentActionMemoryScore(score: number): boolean {
  return score >= ACTION_MEMORY_MIN_SCORE;
}

function normalizeStore(raw: unknown): BrowActionMemoryStore {
  if (!isRecord(raw) || raw.version !== ACTION_MEMORY_VERSION || !isRecord(raw.entries)) {
    return { version: ACTION_MEMORY_VERSION, entries: {} };
  }

  const entries: Record<string, BrowActionMemoryEntry> = {};
  for (const [key, value] of Object.entries(raw.entries)) {
    if (!isRecord(value)) continue;
    if (value.version !== ACTION_MEMORY_VERSION) continue;
    if (typeof value.id !== 'string' || typeof value.normalizedIntent !== 'string') continue;
    if (!['click', 'hover', 'type', 'fillForm'].includes(String(value.actionKind))) continue;
    entries[key] = value as unknown as BrowActionMemoryEntry;
  }
  return { version: ACTION_MEMORY_VERSION, entries };
}

export async function loadActionMemoryStore(): Promise<BrowActionMemoryStore> {
  return normalizeStore(await getStorageValue<unknown>(BROW_ACTION_MEMORY_STORAGE_KEY));
}

export async function findActionMemoryEntry(params: {
  actionKind: BrowActionKind;
  intent?: string;
  url?: string;
}): Promise<{ cacheKey?: string; entry?: BrowActionMemoryEntry; normalizedIntent: string }> {
  const keyInfo = buildActionMemoryKey(params);
  if (!keyInfo.key) return { normalizedIntent: keyInfo.normalizedIntent };
  const store = await loadActionMemoryStore();
  return {
    cacheKey: keyInfo.key,
    entry: store.entries[keyInfo.key],
    normalizedIntent: keyInfo.normalizedIntent,
  };
}

function targetFromElement(element: BrowserSnapshotElement): BrowActionMemoryTarget {
  return {
    signature: signatureFromElement(element),
    selector: element.selector,
  };
}

export function memoryTargetFromElement(element: BrowserSnapshotElement): BrowActionMemoryTarget {
  return targetFromElement(element);
}

export function memoryFieldFromElement(
  element: BrowserSnapshotElement,
  mode?: BrowActionMemoryField['mode'],
): BrowActionMemoryField {
  return {
    signature: signatureFromElement(element),
    selector: element.selector,
    mode,
  };
}

export async function upsertActionMemoryEntry(params: {
  actionKind: BrowActionKind;
  intent?: string;
  url?: string;
  target?: BrowActionMemoryTarget;
  fields?: BrowActionMemoryField[];
  submitTarget?: BrowActionMemoryTarget;
}): Promise<{ stored: boolean; cacheKey?: string; entry?: BrowActionMemoryEntry; reason?: string }> {
  const keyInfo = buildActionMemoryKey(params);
  if (!keyInfo.key || !keyInfo.origin || !keyInfo.pathPattern) {
    return { stored: false, reason: 'missing stable intent or URL' };
  }

  if (!params.target && (!params.fields || params.fields.length === 0)) {
    return { stored: false, cacheKey: keyInfo.key, reason: 'missing target signature' };
  }

  const store = await loadActionMemoryStore();
  const existing = store.entries[keyInfo.key];
  const now = Date.now();
  const entry: BrowActionMemoryEntry = {
    id: existing?.id ?? stableId(),
    version: ACTION_MEMORY_VERSION,
    origin: keyInfo.origin,
    pathPattern: keyInfo.pathPattern,
    normalizedIntent: keyInfo.normalizedIntent,
    actionKind: params.actionKind,
    target: params.target,
    fields: params.fields,
    submitTarget: params.submitTarget,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    successCount: (existing?.successCount ?? 0) + 1,
  };

  store.entries[keyInfo.key] = entry;

  const sorted = Object.entries(store.entries)
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt);
  store.entries = Object.fromEntries(sorted.slice(0, MAX_ACTION_MEMORY_ENTRIES));

  await setStorageValues({ [BROW_ACTION_MEMORY_STORAGE_KEY]: store });
  return { stored: true, cacheKey: keyInfo.key, entry };
}
