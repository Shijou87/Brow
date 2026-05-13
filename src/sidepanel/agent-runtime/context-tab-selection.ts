export function getEffectiveContextTabIds(
  contextTabIds: number[] | undefined,
  activeTabId?: number | null,
): number[] {
  const requestedTabIds = contextTabIds ?? [];
  const orderedTabIds = activeTabId !== undefined && activeTabId !== null
    ? [activeTabId, ...requestedTabIds]
    : requestedTabIds;

  return Array.from(
    new Set(
      orderedTabIds.filter((tabId): tabId is number => Number.isInteger(tabId) && tabId >= 0),
    ),
  );
}