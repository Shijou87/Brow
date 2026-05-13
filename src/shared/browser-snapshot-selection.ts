import type {
  BrowserSnapshotElement,
  BrowserViewportInfo,
} from './types';

export interface SnapshotDisplaySelectionOptions {
  maxElements: number;
  viewport?: BrowserViewportInfo;
  containerTextRefs?: ReadonlySet<string>;
}

const GENERIC_SNAPSHOT_LABELS = new Set([
  'a',
  'body',
  'button',
  'circle',
  'defs',
  'div',
  'g',
  'line',
  'path',
  'polygon',
  'polyline',
  'rect',
  'span',
  'svg',
  'use',
  'yt-button-shape',
  'yt-icon',
  'yt-icon-badge-shape',
  'yt-icon-button',
  'yt-img-shadow',
  'yt-interaction',
]);

const GENERIC_SNAPSHOT_TAGS = new Set([
  'circle',
  'defs',
  'div',
  'g',
  'line',
  'path',
  'polygon',
  'polyline',
  'rect',
  'span',
  'svg',
  'use',
  'yt-button-shape',
  'yt-icon',
  'yt-icon-badge-shape',
  'yt-icon-button',
  'yt-img-shadow',
  'yt-interaction',
]);

const SNAPSHOT_FORM_ROLES = new Set([
  'checkbox',
  'combobox',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'textbox',
]);

const SNAPSHOT_CORE_ACTION_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'treeitem',
]);

const SNAPSHOT_STRUCTURAL_ROLES = new Set([
  'article',
  'cell',
  'columnheader',
  'contentinfo',
  'dialog',
  'form',
  'heading',
  'image',
  'list',
  'listitem',
  'main',
  'navigation',
  'row',
  'search',
  'table',
]);

function normalizeSnapshotLabel(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isGenericSnapshotLabel(value: string | null | undefined): boolean {
  const normalized = normalizeSnapshotLabel(value);
  if (!normalized) return true;
  if (GENERIC_SNAPSHOT_LABELS.has(normalized)) return true;
  return /^(yt|ytd|tp|paper|iron)-[a-z0-9-]+$/.test(normalized);
}

export function isGenericSnapshotTag(tagName: string | undefined): boolean {
  const normalized = normalizeSnapshotLabel(tagName);
  return GENERIC_SNAPSHOT_TAGS.has(normalized)
    || /^(yt|ytd|tp|paper|iron)-[a-z0-9-]+$/.test(normalized);
}

function snapshotEntryText(entry: BrowserSnapshotElement): string {
  const seen = new Set<string>();
  return [entry.name, entry.combobox?.currentValue, entry.text]
    .map((value) => (value ?? '').replace(/\s+/g, ' ').trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .join(' ')
    .trim();
}

function hasSnapshotIdentityAttribute(entry: BrowserSnapshotElement): boolean {
  const attrs = entry.attributes ?? {};
  return Boolean(
    attrs['aria-label']
      || attrs['data-testid']
      || attrs['data-test']
      || attrs.name
      || attrs.placeholder
      || attrs.title
      || attrs.alt
      || attrs.id,
  );
}

function hasUsefulSnapshotText(entry: BrowserSnapshotElement): boolean {
  const text = snapshotEntryText(entry);
  if (text.length < 2) return false;
  if (isGenericSnapshotLabel(text)) return false;
  return true;
}

function isNativeInteractiveSnapshotEntry(entry: BrowserSnapshotElement): boolean {
  return ['a', 'button', 'input', 'select', 'summary', 'textarea'].includes(entry.tagName)
    || SNAPSHOT_FORM_ROLES.has(entry.role)
    || SNAPSHOT_CORE_ACTION_ROLES.has(entry.role);
}

function getAncestorEntries(
  entry: BrowserSnapshotElement,
  entriesByRef: Map<string, BrowserSnapshotElement>,
): BrowserSnapshotElement[] {
  const ancestors: BrowserSnapshotElement[] = [];
  const seen = new Set<string>();
  let parentRef = entry.parentRef;

  while (parentRef && !seen.has(parentRef)) {
    seen.add(parentRef);
    const parent = entriesByRef.get(parentRef);
    if (!parent) break;
    ancestors.push(parent);
    parentRef = parent.parentRef;
  }

  return ancestors;
}

function hasAncestorRole(
  entry: BrowserSnapshotElement,
  entriesByRef: Map<string, BrowserSnapshotElement>,
  roles: ReadonlySet<string>,
): boolean {
  return getAncestorEntries(entry, entriesByRef).some((ancestor) => roles.has(ancestor.role));
}

function hasActionableAncestor(
  entry: BrowserSnapshotElement,
  entriesByRef: Map<string, BrowserSnapshotElement>,
): boolean {
  return getAncestorEntries(entry, entriesByRef).some((ancestor) =>
    ancestor.actionable
      || SNAPSHOT_CORE_ACTION_ROLES.has(ancestor.role)
      || SNAPSHOT_FORM_ROLES.has(ancestor.role)
      || ['a', 'button', 'input', 'select', 'summary', 'textarea'].includes(ancestor.tagName),
  );
}

function isGenericInteractiveDescendant(
  entry: BrowserSnapshotElement,
  entriesByRef: Map<string, BrowserSnapshotElement>,
): boolean {
  if (!hasActionableAncestor(entry, entriesByRef)) return false;
  if (isNativeInteractiveSnapshotEntry(entry) && !isGenericSnapshotTag(entry.tagName)) return false;
  return isGenericSnapshotTag(entry.tagName) || isGenericSnapshotLabel(entry.name);
}

function isLargeViewportContainer(
  entry: BrowserSnapshotElement,
  viewport: BrowserViewportInfo | undefined,
): boolean {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return false;
  const viewportArea = viewport.width * viewport.height;
  const entryArea = Math.max(entry.bounds.width, 0) * Math.max(entry.bounds.height, 0);
  return entryArea >= viewportArea * 0.45
    || (entry.bounds.width >= viewport.width * 0.85 && entry.bounds.height >= viewport.height * 0.35);
}

export function isLowSignalGenericSnapshotEntry(entry: BrowserSnapshotElement): boolean {
  if (isNativeInteractiveSnapshotEntry(entry) && !isGenericSnapshotTag(entry.tagName)) return false;
  if (hasSnapshotIdentityAttribute(entry) && hasUsefulSnapshotText(entry)) return false;
  if (['path', 'g', 'defs', 'use', 'circle', 'rect', 'line', 'polygon', 'polyline'].includes(entry.tagName)) return true;
  if (isGenericSnapshotTag(entry.tagName) && !hasUsefulSnapshotText(entry) && !hasSnapshotIdentityAttribute(entry)) return true;
  return isGenericSnapshotTag(entry.tagName) && isGenericSnapshotLabel(entry.name);
}

function canDisplaySnapshotEntry(
  entry: BrowserSnapshotElement,
  entriesByRef: Map<string, BrowserSnapshotElement>,
  containerTextRefs: ReadonlySet<string> | undefined,
): boolean {
  if (isGenericInteractiveDescendant(entry, entriesByRef)) return false;
  if (isLowSignalGenericSnapshotEntry(entry)) return false;
  if (entry.actionable) return true;
  if (SNAPSHOT_STRUCTURAL_ROLES.has(entry.role)) return true;
  if (entry.role === 'region') {
    if (['canvas', 'video'].includes(entry.tagName)) return true;
    if (entry.tagName === 'svg') return hasUsefulSnapshotText(entry) || hasSnapshotIdentityAttribute(entry);
    return hasUsefulSnapshotText(entry) && !containerTextRefs?.has(entry.ref);
  }

  const text = snapshotEntryText(entry);
  if (!text || text.length < 2) return false;
  if (containerTextRefs?.has(entry.ref)) return false;
  return ['caption', 'code', 'em', 'label', 'legend', 'li', 'p', 'pre', 'strong', 'td', 'th'].includes(entry.tagName);
}

function scoreSnapshotDisplayEntry(
  entry: BrowserSnapshotElement,
  entriesByRef: Map<string, BrowserSnapshotElement>,
  options: SnapshotDisplaySelectionOptions,
): number {
  let score = 0;

  if (SNAPSHOT_FORM_ROLES.has(entry.role)) score = 940;
  else if (entry.role === 'link') score = 900;
  else if (entry.role === 'button') score = 860;
  else if (SNAPSHOT_CORE_ACTION_ROLES.has(entry.role)) score = 830;
  else if (entry.actionable) score = 760;
  else if (entry.role === 'heading') score = 700;
  else if (entry.role === 'image') score = 640;
  else if (entry.role === 'article') score = 590;
  else if (entry.role === 'listitem' || entry.role === 'row') score = 540;
  else if (['form', 'search', 'main'].includes(entry.role)) score = 500;
  else if (entry.role === 'table' || entry.role === 'list') score = 430;
  else if (entry.role === 'region') score = ['canvas', 'video'].includes(entry.tagName) ? 620 : 260;
  else if (['navigation', 'banner', 'contentinfo'].includes(entry.role)) score = 210;
  else score = 160;

  if (hasUsefulSnapshotText(entry)) score += 80;
  else score -= 70;

  const attrs = entry.attributes ?? {};
  if (attrs['aria-label']) score += 70;
  if (attrs['data-testid'] || attrs['data-test']) score += 55;
  if (attrs.name || attrs.placeholder || attrs.title || attrs.alt) score += 35;
  if (attrs.id) score += 18;

  if (options.containerTextRefs?.has(entry.ref)) score -= 280;
  if (isLargeViewportContainer(entry, options.viewport)) score -= 260;
  if (hasAncestorRole(entry, entriesByRef, new Set(['navigation', 'banner', 'contentinfo']))) score -= 120;
  if (hasAncestorRole(entry, entriesByRef, new Set(['dialog']))) score += 80;
  if ((entry.name?.length ?? 0) > 240 || (entry.text?.length ?? 0) > 240) score -= 120;
  if (entry.bounds.top <= 80 && hasAncestorRole(entry, entriesByRef, new Set(['banner']))) score -= 70;

  score -= Math.min(Math.max(entry.depth, 0), 24) * 2;
  return score;
}

export function selectSnapshotEntriesForDisplay(
  entries: BrowserSnapshotElement[],
  options: SnapshotDisplaySelectionOptions,
): BrowserSnapshotElement[] {
  const entriesByRef = new Map(entries.map((entry) => [entry.ref, entry]));

  return entries
    .map((entry, index) => ({
      entry,
      index,
      score: canDisplaySnapshotEntry(entry, entriesByRef, options.containerTextRefs)
        ? scoreSnapshotDisplayEntry(entry, entriesByRef, options)
        : Number.NEGATIVE_INFINITY,
    }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    })
    .slice(0, Math.max(1, Math.floor(options.maxElements)))
    .map((candidate) => candidate.entry);
}

export function shouldRequireActionableClickResolution(entry: BrowserSnapshotElement | undefined): boolean {
  if (!entry) return false;
  if (entry.actionable && !isLowSignalGenericSnapshotEntry(entry)) return false;
  if (['canvas', 'video'].includes(entry.tagName)) return false;
  if (entry.role === 'region' && !isLowSignalGenericSnapshotEntry(entry) && hasUsefulSnapshotText(entry)) return false;
  return true;
}
