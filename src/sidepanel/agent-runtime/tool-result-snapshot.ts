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

function formatSnapshotElement(element: BrowserSnapshotElement): string {
  const depth = Math.max(0, Math.min(element.depth, 5));
  const indent = '  '.repeat(depth);
  const label = element.name || element.text || element.tagName;
  const quotedLabel = label ? ` "${truncateInline(label, 120)}"` : '';
  const ref = `[ref=${element.ref}]`;
  const actionability = element.actionable ? '' : ' [region]';
  const type = element.type ? ` [type=${element.type}]` : '';
  const bounds = ` [bounds=${Math.round(element.bounds.left)},${Math.round(element.bounds.top)},${Math.round(element.bounds.width)}x${Math.round(element.bounds.height)}]`;
  return `${indent}- ${element.role}${quotedLabel} ${ref}${actionability}${type}${bounds}`;
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

export type ToolSnapshotFields = {
  snapshot: BrowserSnapshotSummary;
  snapshotText: string;
};

export type ToolSnapshotPayload<T extends { snapshot?: BrowserSnapshot }> = Omit<T, 'snapshot'> & {
  snapshot?: BrowserSnapshotSummary;
  snapshotText?: string;
};

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

export function buildToolSnapshotFields(snapshot: BrowserSnapshot): {
  snapshot: BrowserSnapshotSummary;
  snapshotText: string;
} {
  return {
    snapshot: summarizeBrowserSnapshot(snapshot),
    snapshotText: formatBrowserSnapshot(snapshot),
  };
}

export function attachToolSnapshotFields<T extends { snapshot?: BrowserSnapshot }>(payload: T): ToolSnapshotPayload<T> {
  const { snapshot, ...rest } = payload;
  return {
    ...rest,
    snapshot: snapshot ? summarizeBrowserSnapshot(snapshot) : undefined,
    snapshotText: snapshot ? formatBrowserSnapshot(snapshot) : undefined,
  } as ToolSnapshotPayload<T>;
}