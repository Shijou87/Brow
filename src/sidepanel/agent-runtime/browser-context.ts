import { tabsGetActive, tabsGetContent, tabsList } from '../tab-tools';

const QUERY_CONTEXT_TAB_LIMIT = 40;
const QUERY_CONTEXT_TITLE_LIMIT = 120;
const QUERY_CONTEXT_URL_LIMIT = 160;
const QUERY_CONTEXT_CONTENT_LIMIT = 12_000;
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

  const attachedContentBlocks = await Promise.all(attachedTabIds.map(async (tabId, index) => {
    const tab = tabsById.get(tabId) ?? (activeTab?.tabId === tabId ? activeTab : undefined);
    const contentResult: { ok: boolean; content?: string; error?: string } =
      await tabsGetContent(tabId, 'text').catch(() => ({
        ok: false,
        error: 'Failed to read tab content',
      }));

    const markers = [
      tabId === visibleTabId ? 'ACTIVE' : null,
      tab?.active ? 'SELECTED' : null,
    ].filter(Boolean).join(', ');
    const markerPrefix = markers ? `[${markers}] ` : '';
    const header = `${index + 1}. ${markerPrefix}tabId=${tabId} title="${truncateInline(tab?.title || '(untitled tab)', QUERY_CONTEXT_TITLE_LIMIT)}" url=${truncateInline(tab?.url || '', QUERY_CONTEXT_URL_LIMIT)}`;

    if (!contentResult.ok) {
      return `${header}\nContent unavailable (${contentResult.error ?? 'unknown error'}).`;
    }

    const rawContent = (contentResult.content ?? '').trim();
    if (!rawContent) {
      return `${header}\nContent (text): [empty]`;
    }

    const truncated = rawContent.length > QUERY_CONTEXT_CONTENT_LIMIT
      ? `${rawContent.slice(0, QUERY_CONTEXT_CONTENT_LIMIT)}\n\n[...truncated at ${QUERY_CONTEXT_CONTENT_LIMIT} chars]`
      : rawContent;
    return `${header}\nContent (text):\n${truncated}`;
  }));

  const attachedTabsSection = attachedContentBlocks.length > 0
    ? [
      `Attached tab content (${selectedTabIds.length} selected${omittedAttachedTabCount > 0 ? `, showing first ${attachedContentBlocks.length}` : ''}):`,
      attachedContentBlocks.join('\n\n'),
      omittedAttachedTabCount > 0 ? `...and ${omittedAttachedTabCount} more attached tabs not shown.` : '',
    ].filter(Boolean).join('\n')
    : 'Attached tab content: none selected for this message.';

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

