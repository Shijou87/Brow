import type { BrowserSnapshot } from '../../shared/types';

export interface CachedBrowserContextSnapshotEntry {
  snapshotText: string;
  version: number;
  url: string;
  title: string;
  generatedAt: number;
}

export interface CachedBrowserContextSnapshotLookup {
  version: number;
  url?: string | null;
  title?: string | null;
}

const attachedSnapshotCache = new Map<number, CachedBrowserContextSnapshotEntry>();
const invalidationVersions = new Map<number, number>();

export function getBrowserContextSnapshotInvalidationVersion(tabId: number): number {
  return invalidationVersions.get(tabId) ?? 0;
}

export function shouldReuseCachedBrowserContextSnapshot(
  entry: CachedBrowserContextSnapshotEntry | undefined,
  lookup: CachedBrowserContextSnapshotLookup,
): entry is CachedBrowserContextSnapshotEntry {
  if (!entry) return false;
  if (entry.version !== lookup.version) return false;
  if (entry.url !== (lookup.url ?? '')) return false;
  if (entry.title !== (lookup.title ?? '')) return false;
  return true;
}

export function readBrowserContextSnapshotCache(
  tabId: number,
  lookup: Omit<CachedBrowserContextSnapshotLookup, 'version'>,
): CachedBrowserContextSnapshotEntry | undefined {
  const entry = attachedSnapshotCache.get(tabId);
  const version = getBrowserContextSnapshotInvalidationVersion(tabId);
  return shouldReuseCachedBrowserContextSnapshot(entry, { ...lookup, version })
    ? entry
    : undefined;
}

export function primeBrowserContextSnapshotCache(snapshot: BrowserSnapshot, snapshotText: string): void {
  if (!snapshot.ok) return;

  attachedSnapshotCache.set(snapshot.tabId, {
    snapshotText,
    version: getBrowserContextSnapshotInvalidationVersion(snapshot.tabId),
    url: snapshot.url,
    title: snapshot.title,
    generatedAt: snapshot.generatedAt,
  });
}

export function invalidateBrowserContextSnapshotCache(tabId?: number): void {
  if (typeof tabId !== 'number') {
    attachedSnapshotCache.clear();
    invalidationVersions.clear();
    return;
  }

  attachedSnapshotCache.delete(tabId);
  invalidationVersions.set(tabId, getBrowserContextSnapshotInvalidationVersion(tabId) + 1);
}

export function resetBrowserContextSnapshotCacheForTests(): void {
  attachedSnapshotCache.clear();
  invalidationVersions.clear();
}