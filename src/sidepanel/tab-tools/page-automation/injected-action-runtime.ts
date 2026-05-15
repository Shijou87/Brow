export type {
  BrowserClickPoint,
  ClickDispatchMode,
  PageAutomationAction,
  PageSettlingProbeOptions,
  PageSettlingProbeResult,
} from './runtime/types';

import type { PageAutomationAction, PageSettlingProbeOptions, PageSettlingProbeResult } from './runtime/types';

export async function runPageAutomationAction(action: PageAutomationAction): Promise<unknown> {
  const PAGE_AUTOMATION_RUNTIME_GLOBAL_KEY = '__browPageAutomationRuntime__';
  const runtime = (globalThis as Record<string, unknown>)[PAGE_AUTOMATION_RUNTIME_GLOBAL_KEY] as {
    runPageAutomationAction?: (nextAction: PageAutomationAction) => Promise<unknown>;
  } | undefined;
  if (!runtime || typeof runtime.runPageAutomationAction !== 'function') {
    throw new Error('Page automation runtime is not installed in this tab');
  }

  return runtime.runPageAutomationAction(action);
}

export async function runPageSettlingProbe(
  options?: PageSettlingProbeOptions,
): Promise<PageSettlingProbeResult> {
  const PAGE_AUTOMATION_RUNTIME_GLOBAL_KEY = '__browPageAutomationRuntime__';
  const runtime = (globalThis as Record<string, unknown>)[PAGE_AUTOMATION_RUNTIME_GLOBAL_KEY] as {
    runPageSettlingProbe?: (nextOptions?: PageSettlingProbeOptions) => Promise<PageSettlingProbeResult>;
  } | undefined;
  if (!runtime || typeof runtime.runPageSettlingProbe !== 'function') {
    throw new Error('Page automation runtime is not installed in this tab');
  }

  return runtime.runPageSettlingProbe(options);
}
