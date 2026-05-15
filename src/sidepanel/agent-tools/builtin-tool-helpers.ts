import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  attachToolSnapshotFields,
  buildToolSnapshotFields,
  type ToolSnapshotPayload,
} from '../agent-runtime/tool-result-snapshot';
import { compactAutomationToolResult, formatAutomationToolResultText } from '../agent-runtime/automation-tool-result';
import {
  invalidateBrowserContextSnapshotCache,
  primeBrowserContextSnapshotCache,
} from '../agent-runtime/browser-context';
import { browserSnapshot, tabsGetActive } from '../tab-tools';
import type { BrowserSnapshot, BrowserViewportRect } from '../../shared/types';

export function markToolAlias(
  toolInstance: StructuredToolInterface,
  aliasOf: string,
): StructuredToolInterface {
  (toolInstance as any).__hidden = true;
  (toolInstance as any).__aliasOf = aliasOf;
  return toolInstance;
}

export async function resolveAliasTabId(tabId?: number): Promise<number | { ok: false; error: string }> {
  if (typeof tabId === 'number' && Number.isFinite(tabId)) return tabId;
  const activeTab = await tabsGetActive();
  if (activeTab?.tabId != null && activeTab.tabId >= 0) return activeTab.tabId;
  return {
    ok: false,
    error: 'No active tab is available for this browser automation action.',
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeOptional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

export function normalizeStringList(value: string[] | string | null | undefined): string[] | undefined {
  if (Array.isArray(value)) {
    const items = Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'string') {
    const items = Array.from(new Set(value.split(',').map((item) => item.trim()).filter(Boolean)));
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

export async function inferActiveDomain(): Promise<string | undefined> {
  const activeTab = await tabsGetActive().catch(() => null);
  if (!activeTab?.url) return undefined;
  try {
    return new URL(activeTab.url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function normalizeOptionalJsonRecord(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') return value;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeOptionalStringRecord(value: Record<string, string> | string | null | undefined): Record<string, string> | undefined {
  const parsed = normalizeOptionalJsonRecord(value as Record<string, unknown> | string | null | undefined);
  if (!parsed) return undefined;

  const record: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(parsed)) {
    if (typeof entryValue === 'string') {
      record[key] = entryValue;
      continue;
    }
    if (entryValue != null) {
      record[key] = String(entryValue);
    }
  }

  return Object.keys(record).length > 0 ? record : undefined;
}

export function stringifyCompact(value: unknown): string {
  return JSON.stringify(value);
}

export function primeBrowserContextFromSnapshot(snapshot: BrowserSnapshot | undefined): void {
  if (!snapshot?.ok) return;
  const snapshotFields = buildToolSnapshotFields(snapshot);
  primeBrowserContextSnapshotCache(snapshot, snapshotFields.snapshotText);
}

export async function appendFreshSnapshot<T extends object>(
  tabId: number,
  payload: T,
  waitMs = 250,
): Promise<ToolSnapshotPayload<T & { snapshot?: BrowserSnapshot }>> {
  if (waitMs > 0) await sleep(waitMs);
  const snapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 80 });
  invalidateBrowserContextSnapshotCache(tabId);
  primeBrowserContextFromSnapshot(snapshot);
  return attachToolSnapshotFields({ ...payload, snapshot });
}

export function finalizeAutomationSnapshotPayload<T extends { snapshot?: BrowserSnapshot; beforeSnapshot?: BrowserSnapshot }>(
  tabId: number,
  payload: T,
): ToolSnapshotPayload<T> {
  invalidateBrowserContextSnapshotCache(tabId);
  primeBrowserContextFromSnapshot(payload.snapshot);
  return attachToolSnapshotFields(compactAutomationToolResult(payload as any) as T);
}

export function formatAutomationToolOutput(toolName: string, payload: unknown): string {
  return formatAutomationToolResultText(payload as any, toolName);
}

export async function runAutomationTool<T extends { snapshot?: BrowserSnapshot; beforeSnapshot?: BrowserSnapshot }>(
  toolName: string,
  tabId: number | null | undefined,
  invoke: (resolvedTabId: number) => Promise<T>,
): Promise<string> {
  const resolvedTabId = await resolveAliasTabId(normalizeOptional(tabId));
  if (typeof resolvedTabId !== 'number') {
    return formatAutomationToolOutput(toolName, resolvedTabId);
  }

  return formatAutomationToolOutput(
    toolName,
    finalizeAutomationSnapshotPayload(resolvedTabId, await invoke(resolvedTabId)),
  );
}

export function normalizeViewportRect(input: {
  x?: number;
  y?: number;
  left?: number;
  top?: number;
  width: number;
  height: number;
}): BrowserViewportRect {
  const left = Number.isFinite(input.left) ? Number(input.left) : Number(input.x ?? 0);
  const top = Number.isFinite(input.top) ? Number(input.top) : Number(input.y ?? 0);
  const width = Number(input.width);
  const height = Number(input.height);
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}
