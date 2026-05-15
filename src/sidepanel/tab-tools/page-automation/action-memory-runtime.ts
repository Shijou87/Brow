import type {
  BrowserRefResolution,
  BrowserSnapshot,
  BrowserSnapshotOptions,
  BrowActionCacheStatus,
  BrowActionKind,
  BrowActionPostcondition,
  BrowActionTrace,
  BrowPostconditionResult,
} from '../../../shared/types';
import {
  findActionMemoryEntry,
  memoryTargetFromElement,
  upsertActionMemoryEntry,
} from '../action-memory';

type ClickDispatchMode = 'programmatic';

interface SingleTargetActionOptions {
  intent?: string;
  postconditions?: BrowActionPostcondition[];
  useActionMemory?: boolean;
}

interface ClickPostconditionWaitResult {
  snapshot: BrowserSnapshot;
  results: BrowPostconditionResult[];
  waitedMs: number;
}

interface ClickNavigationFallbackResult {
  ok: boolean;
  snapshot?: BrowserSnapshot;
  postconditions?: BrowPostconditionResult[];
  error?: string;
}

interface SingleTargetReplayParams {
  tabId: number;
  actionKind: Exclude<BrowActionKind, 'fillForm'>;
  options?: SingleTargetActionOptions;
  trace: BrowActionTrace;
  execute: (selector: string, clickMode?: ClickDispatchMode) => Promise<unknown>;
}

interface SingleTargetReplayResult {
  ok: boolean;
  action?: unknown;
  snapshot?: BrowserSnapshot;
  resolved?: BrowserRefResolution;
  cacheStatus?: BrowActionCacheStatus;
  trace?: BrowActionTrace;
  postconditions?: BrowPostconditionResult[];
  repairNeeded?: boolean;
  warning?: string;
  error?: string;
}

interface RememberSingleTargetParams {
  actionKind: Exclude<BrowActionKind, 'fillForm'>;
  options?: SingleTargetActionOptions;
  snapshot: BrowserSnapshot;
  resolved: BrowserRefResolution;
  trace: BrowActionTrace;
}

interface ActionMemoryRuntimeDeps {
  browserSnapshot: (tabId: number, options?: BrowserSnapshotOptions) => Promise<BrowserSnapshot>;
  browserResolveMemoryTarget: (
    tabId: number,
    target: ReturnType<typeof memoryTargetFromElement>,
    requireActionable?: boolean,
  ) => Promise<BrowserRefResolution>;
  snapshotAfterAction: (tabId: number) => Promise<BrowserSnapshot>;
  evaluatePostconditions: (
    tabId: number,
    snapshot: BrowserSnapshot,
    postconditions: BrowActionPostcondition[] | undefined,
  ) => Promise<BrowPostconditionResult[]>;
  postconditionsPassed: (results: BrowPostconditionResult[]) => boolean;
  waitForClickPostconditions: (
    tabId: number,
    snapshot: BrowserSnapshot,
    postconditions: BrowActionPostcondition[] | undefined,
    options?: { timeoutMs?: number; pollMs?: number },
  ) => Promise<ClickPostconditionWaitResult>;
  shouldRetryProgrammaticClickForNavigation: (params: {
    beforeSnapshot?: BrowserSnapshot;
    snapshot: BrowserSnapshot;
    action: unknown;
  }) => boolean;
  getMissedClickNavigationError: (params: {
    beforeSnapshot?: BrowserSnapshot;
    snapshot: BrowserSnapshot;
    action: unknown;
  }) => string | undefined;
  getExpectedClickNavigationHref: (
    action: unknown,
    beforeSnapshot?: BrowserSnapshot,
  ) => string | undefined;
  navigateTabToClickedHref: (
    tabId: number,
    href: string,
    postconditions: BrowActionPostcondition[] | undefined,
  ) => Promise<ClickNavigationFallbackResult>;
  getSuccessfulNavigationWarning: (params: {
    beforeSnapshot?: BrowserSnapshot;
    snapshot: BrowserSnapshot;
    action: unknown;
    postconditions: BrowPostconditionResult[];
  }) => string | undefined;
  completeTrace: (trace: BrowActionTrace) => BrowActionTrace;
}

export function createActionMemoryRuntime(deps: ActionMemoryRuntimeDeps) {
  async function tryReplaySingleTargetAction(
    params: SingleTargetReplayParams,
  ): Promise<SingleTargetReplayResult | null> {
    if (!params.options?.intent || params.options.useActionMemory === false) {
      params.trace.cacheStatus = 'disabled';
      return null;
    }

    const activeSnapshot = await deps.browserSnapshot(params.tabId, { mode: 'compact', maxElements: 1 });
    const lookup = await findActionMemoryEntry({
      actionKind: params.actionKind,
      intent: params.options.intent,
      url: activeSnapshot.url,
    });
    params.trace.cacheKey = lookup.cacheKey;
    if (!lookup.entry?.target) {
      params.trace.cacheStatus = 'miss';
      return null;
    }

    params.trace.cacheStatus = 'hit';
    params.trace.memoryEntryId = lookup.entry.id;
    const resolved = await deps.browserResolveMemoryTarget(
      params.tabId,
      lookup.entry.target,
      actionKindRequiresActionableRef(params.actionKind),
    );
    params.trace.matchScore = resolved.matchScore;
    params.trace.preconditions = resolved.preconditions;
    params.trace.snapshotId = resolved.snapshotId;
    params.trace.resolvedRef = resolved.ref;

    if (!resolved.ok || !resolved.selector) {
      params.trace.cacheStatus = 'stale';
      params.trace.recoveryDecision = resolved.error ?? 'cached target could not be replayed';
      return null;
    }

    let action = await params.execute(resolved.selector);
    let snapshot = await deps.snapshotAfterAction(params.tabId);
    let postconditions = await deps.evaluatePostconditions(params.tabId, snapshot, params.options.postconditions);
    if (params.actionKind === 'click' && Boolean((action as any).ok) && !deps.postconditionsPassed(postconditions)) {
      const waited = await deps.waitForClickPostconditions(params.tabId, snapshot, params.options.postconditions);
      snapshot = waited.snapshot;
      postconditions = waited.results;
      if (deps.postconditionsPassed(postconditions) && waited.waitedMs > 0) {
        params.trace.recoveryDecision = `Waited ${waited.waitedMs}ms for click postconditions to settle after cached action replay.`;
      }
    }

    if (params.actionKind === 'click' && Boolean((action as any).ok) && deps.shouldRetryProgrammaticClickForNavigation({
      beforeSnapshot: activeSnapshot,
      snapshot,
      action,
    })) {
      const repairAttempt = await params.execute(resolved.selector, 'programmatic');
      let repairSnapshot = await deps.snapshotAfterAction(params.tabId);
      let repairPostconditions = await deps.evaluatePostconditions(
        params.tabId,
        repairSnapshot,
        params.options.postconditions,
      );
      if (!deps.postconditionsPassed(repairPostconditions)) {
        const waited = await deps.waitForClickPostconditions(
          params.tabId,
          repairSnapshot,
          params.options.postconditions,
        );
        repairSnapshot = waited.snapshot;
        repairPostconditions = waited.results;
      }
      action = Boolean((repairAttempt as any).ok)
        ? {
          ...(repairAttempt as any),
          initialAttempt: action,
        }
        : {
          ...(action as any),
          repairAttempt,
        };
      snapshot = repairSnapshot;
      postconditions = repairPostconditions;
      params.trace.recoveryDecision = 'Retried click with programmatic dispatch after the initial click did not navigate to the clicked href.';
    }

    params.trace.execution = action as Record<string, unknown>;
    params.trace.postconditions = postconditions;

    const missedNavigationError = params.actionKind === 'click' && Boolean((action as any).ok)
      ? deps.getMissedClickNavigationError({
        beforeSnapshot: activeSnapshot,
        snapshot,
        action,
      })
      : undefined;

    if (params.actionKind === 'click' && Boolean((action as any).ok) && missedNavigationError) {
      const expectedHref = deps.getExpectedClickNavigationHref(action, activeSnapshot);
      if (expectedHref) {
        const fallback = await deps.navigateTabToClickedHref(
          params.tabId,
          expectedHref,
          params.options.postconditions,
        );
        if (fallback.ok && fallback.snapshot && fallback.postconditions) {
          action = {
            ...(action as any),
            navigationFallback: {
              ok: true,
              method: 'tabs.update',
              url: expectedHref,
            },
          };
          snapshot = fallback.snapshot;
          postconditions = fallback.postconditions;
          params.trace.recoveryDecision = 'Opened the clicked href via tab URL navigation after DOM click attempts did not leave the current page.';
        } else {
          action = {
            ...(action as any),
            navigationFallback: {
              ok: false,
              method: 'tabs.update',
              url: expectedHref,
              error: fallback.error,
            },
          };
        }
      }
    }

    const finalMissedNavigationError = params.actionKind === 'click' && Boolean((action as any).ok)
      ? deps.getMissedClickNavigationError({
        beforeSnapshot: activeSnapshot,
        snapshot,
        action,
      })
      : undefined;

    const navigationWarning = params.actionKind === 'click' && Boolean((action as any).ok) && !finalMissedNavigationError
      ? deps.getSuccessfulNavigationWarning({
        beforeSnapshot: activeSnapshot,
        snapshot,
        action,
        postconditions,
      })
      : undefined;

    if (navigationWarning) {
      params.trace.recoveryDecision = navigationWarning;
      return {
        ok: true,
        action,
        snapshot,
        cacheStatus: params.trace.cacheStatus,
        trace: deps.completeTrace(params.trace),
        postconditions,
        repairNeeded: false,
        warning: navigationWarning,
        resolved: {
          ok: true,
          ref: resolved.ref,
          snapshotId: resolved.snapshotId,
          selector: resolved.selector,
          entry: resolved.entry,
          backend: resolved.backend,
          confidence: resolved.confidence,
          matchScore: resolved.matchScore,
          preconditions: resolved.preconditions,
        },
      };
    }

    if (!Boolean((action as any).ok) || finalMissedNavigationError || !deps.postconditionsPassed(postconditions)) {
      params.trace.cacheStatus = 'stale';
      params.trace.recoveryDecision = !Boolean((action as any).ok)
        ? ((action as any).error ?? 'cached action execution failed')
        : (finalMissedNavigationError ?? 'cached action postcondition failed');
      return {
        ok: false,
        action,
        snapshot,
        cacheStatus: 'stale',
        trace: deps.completeTrace(params.trace),
        postconditions,
        repairNeeded: true,
        error: params.trace.recoveryDecision,
      };
    }

    return {
      ok: true,
      action,
      snapshot,
      resolved: {
        ok: true,
        ref: resolved.ref,
        snapshotId: resolved.snapshotId,
        selector: resolved.selector,
        entry: resolved.entry,
        matchScore: resolved.matchScore,
        preconditions: resolved.preconditions,
      },
      cacheStatus: 'hit',
      trace: deps.completeTrace(params.trace),
      postconditions,
    };
  }

  async function rememberSingleTargetAction(
    params: RememberSingleTargetParams,
  ): Promise<BrowActionCacheStatus> {
    if (!params.options?.intent || params.options.useActionMemory === false || !params.resolved.entry) {
      return 'store_skipped';
    }

    const saved = await upsertActionMemoryEntry({
      actionKind: params.actionKind,
      intent: params.options.intent,
      url: params.snapshot.url,
      target: memoryTargetFromElement(params.resolved.entry),
    });
    params.trace.cacheKey = saved.cacheKey ?? params.trace.cacheKey;
    params.trace.memoryEntryId = saved.entry?.id ?? params.trace.memoryEntryId;
    return saved.stored ? 'stored' : 'store_skipped';
  }

  return {
    tryReplaySingleTargetAction,
    rememberSingleTargetAction,
  };
}

function actionKindRequiresActionableRef(actionKind: BrowActionKind): boolean {
  return actionKind !== 'click';
}
