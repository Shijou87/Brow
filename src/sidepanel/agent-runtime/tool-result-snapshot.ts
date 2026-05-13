import type {
  BrowserSnapshot,
  BrowserSnapshotElement,
  BrowserViewportInfo,
} from '../../shared/types';

const QUERY_CONTEXT_TITLE_LIMIT = 120;
const QUERY_CONTEXT_URL_LIMIT = 160;

function normalizeInlineText(text: string | undefined | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function truncateInline(text: string | undefined | null, max: number): string {
  const normalized = normalizeInlineText(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

function formatComboboxValue(element: BrowserSnapshotElement): string | undefined {
  const label = normalizeInlineText(element.name || element.text || element.tagName);
  const currentValue = normalizeInlineText(element.combobox?.currentValue);
  if (!currentValue || currentValue === label) return undefined;
  return `[value="${truncateInline(currentValue, 80)}"]`;
}

function formatSnapshotElement(element: BrowserSnapshotElement): string {
  const depth = Math.max(0, Math.min(element.depth, 5));
  const indent = '  '.repeat(depth);
  const label = element.name || element.text || element.tagName;
  const quotedLabel = label ? ` "${truncateInline(label, 120)}"` : '';
  const parts = [
    `${indent}- ${element.role}${quotedLabel}`,
    `[ref=${element.ref}]`,
    element.actionable ? undefined : '[region]',
    element.type ? `[type=${element.type}]` : undefined,
    formatComboboxValue(element),
    element.combobox?.requiresOptionSelection ? '[select-option]' : undefined,
    element.combobox?.ariaExpanded === true ? '[expanded]' : undefined,
    element.combobox?.ariaExpanded === false ? '[collapsed]' : undefined,
    element.combobox?.controlledPopup?.visible
      ? `[popup=${element.combobox.controlledPopup.role}:${element.combobox.controlledPopup.options.length}]`
      : undefined,
    `[bounds=${Math.round(element.bounds.left)},${Math.round(element.bounds.top)},${Math.round(element.bounds.width)}x${Math.round(element.bounds.height)}]`,
  ].filter(Boolean);
  const line = parts.join(' ');

  const popupOptions = element.combobox?.controlledPopup?.visible
    ? element.combobox.controlledPopup.options.slice(0, 6)
    : [];
  if (popupOptions.length === 0) return line;

  const optionIndent = `${indent}  `;
  const optionLines = popupOptions.map((option) => [
    `${optionIndent}* ${option.role}`,
    option.text ? `"${truncateInline(option.text, 100)}"` : undefined,
    option.ref ? `[ref=${option.ref}]` : undefined,
    option.selected ? '[selected]' : undefined,
    option.disabled ? '[disabled]' : undefined,
  ].filter(Boolean).join(' '));

  return [line, ...optionLines].join('\n');
}

export function formatBrowserSnapshot(snapshot: BrowserSnapshot): string {
  if (!snapshot.ok) {
    return `Browser snapshot unavailable for tabId=${snapshot.tabId}: ${snapshot.error ?? 'unknown error'}`;
  }

  const header = [
    `Browser snapshot snapshotId=${snapshot.snapshotId} tabId=${snapshot.tabId}`,
    `title="${truncateInline(snapshot.title || '(untitled tab)', QUERY_CONTEXT_TITLE_LIMIT)}"`,
    `url=${truncateInline(snapshot.url || '', QUERY_CONTEXT_URL_LIMIT)}`,
    `viewport=${snapshot.viewport.width}x${snapshot.viewport.height}`,
  ].join(' ');

  const body = snapshot.elements.length > 0
    ? snapshot.elements.map(formatSnapshotElement).join('\n')
    : '- No visible meaningful elements found.';

  const omitted = snapshot.omittedElementCount > 0
    ? `\n... ${snapshot.omittedElementCount} additional visible nodes are refable internally. Use browser_snapshot with mode="full" or rootRef for a deeper view.`
    : '';

  return `${header}\n${body}${omitted}`;
}

export interface BrowserSnapshotSummary {
  ok: boolean;
  snapshotId: string;
  tabId: number;
  url: string;
  title: string;
  generatedAt: number;
  viewport: BrowserViewportInfo;
  visibleElementCount: number;
  displayedElementCount: number;
  omittedElementCount: number;
  rootRef?: string;
  error?: string;
}

export interface ToolResultSnapshotSummary {
  ok: boolean;
  snapshotId: string;
  url: string;
  title: string;
  visibleElementCount: number;
  omittedElementCount: number;
  error?: string;
}

export type ToolSnapshotFields = {
  snapshot: BrowserSnapshotSummary;
  snapshotText: string;
};

export type ToolSnapshotPayload<T extends { snapshot?: BrowserSnapshot; beforeSnapshot?: BrowserSnapshot }> = Omit<T, 'snapshot' | 'beforeSnapshot'> & {
  beforeSnapshot?: ToolResultSnapshotSummary;
  snapshot?: ToolResultSnapshotSummary;
  snapshotText?: string;
};

function formatSnapshotElementForToolResult(element: BrowserSnapshotElement): string {
  const depth = Math.max(0, Math.min(element.depth, 3));
  const indent = '  '.repeat(depth);
  const label = element.name || element.text || element.tagName;
  const quotedLabel = label ? ` "${truncateInline(label, 120)}"` : '';
  const parts = [
    `${indent}- ${element.role}${quotedLabel}`,
    `[ref=${element.ref}]`,
    element.type ? `[type=${element.type}]` : undefined,
    formatComboboxValue(element),
    element.combobox?.requiresOptionSelection ? '[select-option]' : undefined,
    element.combobox?.ariaExpanded === true ? '[expanded]' : undefined,
    element.combobox?.ariaExpanded === false ? '[collapsed]' : undefined,
    element.combobox?.controlledPopup?.visible
      ? `[popup=${element.combobox.controlledPopup.role}:${element.combobox.controlledPopup.options.length}]`
      : undefined,
  ].filter(Boolean);
  const line = parts.join(' ');

  const popupOptions = element.combobox?.controlledPopup?.visible
    ? element.combobox.controlledPopup.options.slice(0, 4)
    : [];
  if (popupOptions.length === 0) return line;

  const optionIndent = `${indent}  `;
  const optionLines = popupOptions.map((option) => [
    `${optionIndent}* ${option.role}`,
    option.text ? `"${truncateInline(option.text, 80)}"` : undefined,
    option.ref ? `[ref=${option.ref}]` : undefined,
    option.selected ? '[selected]' : undefined,
    option.disabled ? '[disabled]' : undefined,
  ].filter(Boolean).join(' '));

  return [line, ...optionLines].join('\n');
}

export function formatBrowserSnapshotForToolResult(snapshot: BrowserSnapshot): string {
  if (!snapshot.ok) {
    return `Browser snapshot unavailable: ${snapshot.error ?? 'unknown error'}`;
  }

  const header = [
    `Browser snapshot snapshotId=${snapshot.snapshotId}`,
    `title="${truncateInline(snapshot.title || '(untitled tab)', QUERY_CONTEXT_TITLE_LIMIT)}"`,
    `url=${truncateInline(snapshot.url || '', QUERY_CONTEXT_URL_LIMIT)}`,
  ].join(' ');

  const body = snapshot.elements.length > 0
    ? snapshot.elements.map(formatSnapshotElementForToolResult).join('\n')
    : '- No visible meaningful elements found.';

  const omitted = snapshot.omittedElementCount > 0
    ? `\n... ${snapshot.omittedElementCount} more nodes omitted. Use browser_snapshot for a deeper view.`
    : '';

  return `${header}\n${body}${omitted}`;
}

export function summarizeBrowserSnapshot(snapshot: BrowserSnapshot): BrowserSnapshotSummary {
  return {
    ok: snapshot.ok,
    snapshotId: snapshot.snapshotId,
    tabId: snapshot.tabId,
    url: snapshot.url,
    title: snapshot.title,
    generatedAt: snapshot.generatedAt,
    viewport: snapshot.viewport,
    visibleElementCount: snapshot.visibleElementCount,
    displayedElementCount: snapshot.displayedElementCount,
    omittedElementCount: snapshot.omittedElementCount,
    rootRef: snapshot.rootRef,
    error: snapshot.error,
  };
}

export function summarizeBrowserSnapshotForToolResult(snapshot: BrowserSnapshot): ToolResultSnapshotSummary {
  return {
    ok: snapshot.ok,
    snapshotId: snapshot.snapshotId,
    url: snapshot.url,
    title: snapshot.title,
    visibleElementCount: snapshot.visibleElementCount,
    omittedElementCount: snapshot.omittedElementCount,
    error: snapshot.error,
  };
}

export function buildToolSnapshotFields(snapshot: BrowserSnapshot): {
  snapshot: BrowserSnapshotSummary;
  snapshotText: string;
} {
  return {
    snapshot: summarizeBrowserSnapshot(snapshot),
    snapshotText: formatBrowserSnapshot(snapshot),
  };
}

export function attachToolSnapshotFields<T extends { snapshot?: BrowserSnapshot; beforeSnapshot?: BrowserSnapshot }>(payload: T): ToolSnapshotPayload<T> {
  const { snapshot, beforeSnapshot, ...rest } = payload;
  return {
    ...rest,
    beforeSnapshot: beforeSnapshot ? summarizeBrowserSnapshotForToolResult(beforeSnapshot) : undefined,
    snapshot: snapshot ? summarizeBrowserSnapshotForToolResult(snapshot) : undefined,
    snapshotText: snapshot ? formatBrowserSnapshotForToolResult(snapshot) : undefined,
  } as ToolSnapshotPayload<T>;
}