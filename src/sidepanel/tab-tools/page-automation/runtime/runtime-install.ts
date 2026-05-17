import { createPageAutomationActionRuntime } from './action-runtime';
import { runPageSettlingProbe } from './settling-probe';
import {
  PAGE_AUTOMATION_RUNTIME_GLOBAL_KEY,
  type InstalledPageAutomationRuntime,
} from './types';

export function getInstalledPageAutomationRuntime(
  targetGlobal: typeof globalThis = globalThis,
): InstalledPageAutomationRuntime | null {
  const runtime = (targetGlobal as typeof globalThis & Record<string, unknown>)[PAGE_AUTOMATION_RUNTIME_GLOBAL_KEY];
  if (!runtime || typeof runtime !== 'object') return null;

  const candidate = runtime as Partial<InstalledPageAutomationRuntime>;
  return typeof candidate.runPageAutomationAction === 'function'
    && typeof candidate.runPageSettlingProbe === 'function'
    ? candidate as InstalledPageAutomationRuntime
    : null;
}

export function installPageAutomationRuntime(
  targetGlobal: typeof globalThis = globalThis,
): InstalledPageAutomationRuntime {
  const existing = getInstalledPageAutomationRuntime(targetGlobal);
  if (existing) return existing;

  const { runPageAutomationAction, dismissPageAutomationOverlay } = createPageAutomationActionRuntime();
  const runtime: InstalledPageAutomationRuntime = {
    runPageAutomationAction,
    runPageSettlingProbe,
    dismissPageAutomationOverlay,
  };
  (targetGlobal as typeof globalThis & Record<string, unknown>)[PAGE_AUTOMATION_RUNTIME_GLOBAL_KEY] = runtime;
  return runtime;
}

