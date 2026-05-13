import { browserSnapshot, tabsGetActive, tabsList } from '../tab-tools';
import type { BrowserSnapshot, WorkflowDemonstration } from '../../shared/types';
import { getEffectiveContextTabIds } from './context-tab-selection';
import {
  buildWorkflowDemonstrationContext as buildWorkflowDemonstrationContextFromShared,
  formatWorkflowDemonstrationForContext as formatWorkflowDemonstrationForContextFromShared,
} from '../../shared/workflow-demonstration';
import { buildBrowserContextSnapshotLayout } from './browser-context-layout';
import { formatBrowserSnapshot } from './tool-result-snapshot';
import {
  invalidateBrowserContextSnapshotCache,
  primeBrowserContextSnapshotCache,
  readBrowserContextSnapshotCache,
} from './browser-context-cache';

export { formatBrowserSnapshot } from './tool-result-snapshot';
export {
  invalidateBrowserContextSnapshotCache,
  primeBrowserContextSnapshotCache,
  readBrowserContextSnapshotCache,
} from './browser-context-cache';

export interface BrowserContextSnapshotMetrics {
  openTabCount: number;
  listedTabCount: number;
  extraTabCount: number;
  selectedTabCount: number;
  attachedTabCount: number;
  omittedAttachedTabCount: number;
  attachedSnapshotCount: number;
  frameChars: number;
  openTabsSectionChars: number;
  activeTabSectionChars: number;
  attachedSnapshotsSectionChars: number;
}

export interface BrowserContextSnapshotResult {
  text: string;
  metrics: BrowserContextSnapshotMetrics;
}

const QUERY_CONTEXT_TAB_LIMIT = 40;
const QUERY_CONTEXT_SELECTED_TAB_LIMIT = 8;

export function stripToolCallJson(text: string): string {
  return text
    .replace(/\s*\{[\s\S]*?"tool"\s*:\s*"[^"]*"[\s\S]*?\}\s*$/g, '')
    .trim();
}

export function formatWorkflowDemonstrationForContext(
  demonstration: WorkflowDemonstration,
  index = 1,
): string {
  return formatWorkflowDemonstrationForContextFromShared(demonstration, index);
}

export function buildWorkflowDemonstrationContext(workflowDemonstrations: WorkflowDemonstration[] = []): string {
  return buildWorkflowDemonstrationContextFromShared(workflowDemonstrations);
}

async function getAttachedSnapshotText(
  tabId: number,
  tab: { url?: string; title?: string } | undefined,
): Promise<string> {
  const cached = readBrowserContextSnapshotCache(tabId, {
    url: tab?.url,
    title: tab?.title,
  });
  if (cached) return cached.snapshotText;

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

  const snapshotText = formatBrowserSnapshot(snapshot);
  if (snapshot.ok) {
    primeBrowserContextSnapshotCache(snapshot, snapshotText);
  }
  return snapshotText;
}

export async function buildBrowserContextSnapshotResult(contextTabIds?: number[]): Promise<BrowserContextSnapshotResult> {
  const [tabs, activeTab] = await Promise.all([
    tabsList().catch(() => []),
    tabsGetActive().catch(() => null),
  ]);

  const visibleTabId = activeTab?.tabId;
  const listedTabs = tabs.slice(0, QUERY_CONTEXT_TAB_LIMIT);
  const extraTabCount = Math.max(tabs.length - listedTabs.length, 0);
  const selectedTabIds = getEffectiveContextTabIds(contextTabIds, activeTab?.tabId);
  const attachedTabIds = selectedTabIds.slice(0, QUERY_CONTEXT_SELECTED_TAB_LIMIT);
  const omittedAttachedTabCount = Math.max(selectedTabIds.length - attachedTabIds.length, 0);
  const tabsById = new Map<number, (typeof tabs)[number]>();
  for (const tab of tabs) {
    tabsById.set(tab.tabId, tab);
  }

  const attachedSnapshotBlocks = await Promise.all(attachedTabIds.map(async (tabId, index) => {
    const tab = tabsById.get(tabId) ?? (activeTab?.tabId === tabId ? activeTab : undefined);
    const snapshotText = await getAttachedSnapshotText(tabId, tab);

    return {
      tabId,
      title: tab?.title,
      url: tab?.url,
      active: tab?.active,
      snapshotText,
    };
  }));

  const layoutResult = buildBrowserContextSnapshotLayout({
    totalTabCount: tabs.length,
    listedTabs,
    extraTabCount,
    visibleTabId,
    activeTab,
    selectedTabCount: selectedTabIds.length,
    omittedAttachedTabCount,
    attachedSnapshotBlocks,
  });

  return {
    text: layoutResult.text,
    metrics: {
      extraTabCount,
      selectedTabCount: selectedTabIds.length,
      openTabCount: tabs.length,
      listedTabCount: listedTabs.length,
      attachedTabCount: attachedTabIds.length,
      omittedAttachedTabCount,
      attachedSnapshotCount: attachedSnapshotBlocks.length,
      frameChars: layoutResult.metrics.frameChars,
      openTabsSectionChars: layoutResult.metrics.openTabsSectionChars,
      activeTabSectionChars: layoutResult.metrics.activeTabSectionChars,
      attachedSnapshotsSectionChars: layoutResult.metrics.attachedSnapshotsSectionChars,
    },
  };
}

export async function buildBrowserContextSnapshot(contextTabIds?: number[]): Promise<string> {
  return (await buildBrowserContextSnapshotResult(contextTabIds)).text;
}
