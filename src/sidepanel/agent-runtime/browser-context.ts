import { browserSnapshot, tabsGetActive, tabsList } from '../tab-tools';
import type { BrowserSnapshot } from '../../shared/types';
import { formatBrowserSnapshot } from './tool-result-snapshot';

export { formatBrowserSnapshot } from './tool-result-snapshot';

const QUERY_CONTEXT_TAB_LIMIT = 40;
const QUERY_CONTEXT_TITLE_LIMIT = 120;
const QUERY_CONTEXT_URL_LIMIT = 160;
const QUERY_CONTEXT_SELECTED_TAB_LIMIT = 8;

function normalizeInlineText(text: string | undefined | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function truncateInline(text: string | undefined | null, max: number): string {
  const normalized = normalizeInlineText(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

export function stripToolCallJson(text: string): string {
  return text
    .replace(/\s*\{[\s\S]*?"tool"\s*:\s*"[^"]*"[\s\S]*?\}\s*$/g, '')
    .trim();
}

export async function buildBrowserContextSnapshot(contextTabIds?: number[]): Promise<string> {
  const [tabs, activeTab] = await Promise.all([
    tabsList().catch(() => []),
    tabsGetActive().catch(() => null),
  ]);

  const visibleTabId = activeTab?.tabId;
  const listedTabs = tabs.slice(0, QUERY_CONTEXT_TAB_LIMIT);
  const extraTabCount = Math.max(tabs.length - listedTabs.length, 0);
  const selectedTabIds = Array.from(
    new Set(
      (contextTabIds === undefined
        ? (activeTab?.tabId !== undefined ? [activeTab.tabId] : [])
        : contextTabIds
      ).filter((tabId): tabId is number => Number.isInteger(tabId) && tabId >= 0),
    ),
  );
  const attachedTabIds = selectedTabIds.slice(0, QUERY_CONTEXT_SELECTED_TAB_LIMIT);
  const omittedAttachedTabCount = Math.max(selectedTabIds.length - attachedTabIds.length, 0);
  const tabsById = new Map<number, (typeof tabs)[number]>();
  for (const tab of tabs) {
    tabsById.set(tab.tabId, tab);
  }

  const tabLines = listedTabs.length > 0
    ? listedTabs.map((tab, index) => {
      const markers = [
        tab.tabId === visibleTabId ? 'ACTIVE' : null,
        tab.active ? 'SELECTED' : null,
      ].filter(Boolean).join(', ');
      const markerPrefix = markers ? `[${markers}] ` : '';
      const title = truncateInline(tab.title || '(untitled tab)', QUERY_CONTEXT_TITLE_LIMIT);
      const url = truncateInline(tab.url || '', QUERY_CONTEXT_URL_LIMIT);
      return `${index + 1}. ${markerPrefix}tabId=${tab.tabId} title="${title}" url=${url}`;
    }).join('\n')
    : 'No open tabs found.';

  const activeSection = activeTab
    ? [
      'Current visible/selected tab:',
      `tabId=${activeTab.tabId}`,
      `title="${truncateInline(activeTab.title || '(untitled tab)', QUERY_CONTEXT_TITLE_LIMIT)}"`,
      `url=${truncateInline(activeTab.url || '', QUERY_CONTEXT_URL_LIMIT)}`,
      `status=${activeTab.status}`,
    ].join('\n')
    : 'Current visible/selected tab: unavailable.';

  const attachedSnapshotBlocks = await Promise.all(attachedTabIds.map(async (tabId, index) => {
    const tab = tabsById.get(tabId) ?? (activeTab?.tabId === tabId ? activeTab : undefined);
    const snapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 70 }).catch((err: any): BrowserSnapshot => ({
      ok: false,
      snapshotId: '',
      tabId,
      url: tab?.url ?? '',
      title: tab?.title ?? '',
      generatedAt: Date.now(),
      viewport: { width: 0, height: 0, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
      elements: [],
      visibleElementCount: 0,
      displayedElementCount: 0,
      omittedElementCount: 0,
      error: err?.message ?? 'Failed to capture browser snapshot',
    }));

    const markers = [
      tabId === visibleTabId ? 'ACTIVE' : null,
      tab?.active ? 'SELECTED' : null,
    ].filter(Boolean).join(', ');
    const markerPrefix = markers ? `[${markers}] ` : '';
    const header = `${index + 1}. ${markerPrefix}tabId=${tabId} title="${truncateInline(tab?.title || '(untitled tab)', QUERY_CONTEXT_TITLE_LIMIT)}" url=${truncateInline(tab?.url || '', QUERY_CONTEXT_URL_LIMIT)}`;

    return `${header}\n${formatBrowserSnapshot(snapshot)}`;
  }));

  const attachedTabsSection = attachedSnapshotBlocks.length > 0
    ? [
      `Attached tab ref snapshots (${selectedTabIds.length} selected${omittedAttachedTabCount > 0 ? `, showing first ${attachedSnapshotBlocks.length}` : ''}):`,
      attachedSnapshotBlocks.join('\n\n'),
      omittedAttachedTabCount > 0 ? `...and ${omittedAttachedTabCount} more attached tabs not shown.` : '',
    ].filter(Boolean).join('\n')
    : 'Attached tab ref snapshots: none selected for this message.';

  return [
    'Browser context snapshot:',
    '',
    `Open tabs (${tabs.length} total${extraTabCount > 0 ? `, showing first ${listedTabs.length}` : ''}):`,
    tabLines,
    extraTabCount > 0 ? `...and ${extraTabCount} more tabs not shown.` : '',
    '',
    activeSection,
    '',
    attachedTabsSection,
  ]
    .filter(Boolean)
    .join('\n');
}
