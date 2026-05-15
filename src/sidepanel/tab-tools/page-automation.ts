import type {
  BrowserFormSnapshot,
  BrowserFormSnapshotOptions,
  BrowserRefResolution,
  BrowserSnapshot,
  BrowserSnapshotOperation,
  BrowserSnapshotOperationResult,
  BrowserSnapshotOptions,
  BrowserViewportRect,
  BrowActionRepairCandidate,
  BrowAutomationBackend,
  BrowBackendPreference,
  BrowActionCacheStatus,
  BrowActionKind,
  BrowActionMemoryField,
  BrowActionMemoryTarget,
  BrowActionPostcondition,
  BrowActionTrace,
  BrowElementSignature,
  BrowPostconditionResult,
  BrowReplayTargetEvidence,
} from '../../shared/types';
import { shouldRequireActionableClickResolution } from '../../shared/browser-snapshot-selection';
import {
  findActionMemoryEntry,
  memoryFieldFromElement,
  memoryTargetFromElement,
  upsertActionMemoryEntry,
} from './action-memory';
import { createActionMemoryRuntime } from './page-automation/action-memory-runtime';
import {
  getUnsafePromotedClickResolutionError,
  getUnsafeEditableClickIntentError,
  shouldRepairForSatisfiedValuePostconditions,
  shouldSkipActionForSatisfiedPostconditions,
} from './click-intent-guards';
import { shouldRetryBodyMediaKey } from './browser-key-retry';
import { createActionPostconditionRuntime } from './page-automation/action-postconditions';
import { createTargetResolutionRuntime } from './page-automation/target-resolution';
import {
  runPageSettlingProbe,
  type BrowserClickPoint,
} from './page-automation/injected-action-runtime';
import {
  tabsListInteractiveElements,
  tabsClick,
  tabsHighlight,
  tabsHover,
  tabsType,
  tabsFillForm,
  tabsDrag,
  tabsScroll,
  tabsKey,
  tabsUploadFile,
  tabsHandleDialog,
  type FormFillMode,
  type FormFillField,
  type FormFillFieldResult,
  type InteractiveElementInfo,
} from './page-automation/tab-action-execution';
import type { BrowserSnapshotOperationMessageResult } from '../../shared/messages';
import {
  ensurePageAutomationRuntimeInjected,
  executeScriptWithTimeout,
  getBlockedPageExecutionError,
} from './page-automation/script-execution';

export { isGenericSnapshotLabel, selectSnapshotEntriesForDisplay, shouldRequireActionableClickResolution } from '../../shared/browser-snapshot-selection';

export type { BrowserRefResolution } from '../../shared/types';
export type { BrowserClickPoint } from './page-automation/injected-action-runtime';
export type { FormFillMode, FormFillField, FormFillFieldResult, InteractiveElementInfo } from './page-automation/tab-action-execution';
export { tabsListInteractiveElements, tabsClick, tabsHighlight, tabsHover, tabsType, tabsFillForm, tabsDrag, tabsScroll, tabsKey, tabsUploadFile, tabsHandleDialog } from './page-automation/tab-action-execution';

export interface BrowserActionOptions {
  intent?: string;
  postconditions?: BrowActionPostcondition[];
  useActionMemory?: boolean;
  clickPoint?: BrowserClickPoint;
  targetEvidence?: BrowReplayTargetEvidence;
  backendPreference?: BrowBackendPreference;
}

export interface BrowserActionRichMetadata {
  backend: BrowAutomationBackend;
  confidence?: number;
  beforeSnapshot?: BrowserSnapshot;
}

type BrowserMemoryResolution = BrowserRefResolution;

const ACTION_BEFORE_SNAPSHOT_MAX_ELEMENTS = 100;
const PAGE_SETTLE_TIMEOUT_SLACK_MS = 400;

export interface BrowserActionResult {
  ok: boolean;
  action?: unknown;
  resolved?: BrowserRefResolution;
  snapshot?: BrowserSnapshot;
  beforeSnapshot?: BrowserSnapshot;
  backend?: BrowAutomationBackend;
  confidence?: number;
  cacheStatus?: BrowActionCacheStatus;
  trace?: BrowActionTrace;
  postconditions?: BrowPostconditionResult[];
  recoveryCandidates?: BrowActionRepairCandidate[];
  repairNeeded?: boolean;
  helperRequired?: boolean;
  warning?: string;
  error?: string;
}

export interface BrowserFormFillField {
  ref: string;
  value: string | number | boolean;
  mode?: FormFillMode;
  targetEvidence?: BrowReplayTargetEvidence;
}

export interface BrowserDragOptions extends BrowserActionOptions {
  sourceClickPoint?: BrowserClickPoint;
  destinationClickPoint?: BrowserClickPoint;
  pointerPath?: Array<{ x: number; y: number }>;
  durationMs?: number;
  destinationTargetEvidence?: BrowReplayTargetEvidence;
}

const SATISFIED_VALUE_REPAIR_ERROR = 'Requested field value already matches the target state. Do not keep acting on this field; take a fresh browser_snapshot with mode="full" or browser_form_snapshot to find the next actionable control.';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureActionBeforeSnapshot(tabId: number): Promise<BrowserSnapshot> {
  return browserSnapshot(tabId, { mode: 'compact', maxElements: ACTION_BEFORE_SNAPSHOT_MAX_ELEMENTS });
}

export async function waitForTabSettled(
  tabId: number,
  timeoutMs = 1600,
): Promise<{ ok: boolean; readyState?: string; quietMs?: number; durationMs?: number; error?: string }> {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab?.status === 'loading') {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const current = await chrome.tabs.get(tabId).catch(() => undefined);
        if (current?.status !== 'loading') break;
        await delay(100);
      }
    }

    await ensurePageAutomationRuntimeInjected(tabId, Math.max(Math.min(timeoutMs, 1200), 600));
    const results = await executeScriptWithTimeout<{ ok: boolean; readyState: string; quietMs: number; durationMs: number; error?: string }>(
      {
        target: { tabId },
        func: runPageSettlingProbe,
        args: [{ timeoutMs }],
      },
      Math.max(timeoutMs + PAGE_SETTLE_TIMEOUT_SLACK_MS, 600),
      getBlockedPageExecutionError('Page settling probe'),
    );

    return (results?.[0]?.result as { ok: boolean; readyState: string; quietMs: number; durationMs: number; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab while waiting for page stability' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to wait for page stability' };
  }
}

function emptyBrowserSnapshot(tabId: number, error: string): BrowserSnapshot {
  return {
    ok: false,
    snapshotId: '',
    tabId,
    url: '',
    title: '',
    generatedAt: Date.now(),
    viewport: { width: 0, height: 0, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    elements: [],
    visibleElementCount: 0,
    displayedElementCount: 0,
    omittedElementCount: 0,
    error,
  };
}

function emptyBrowserFormSnapshot(tabId: number, error: string): BrowserFormSnapshot {
  return {
    ok: false,
    snapshotId: '',
    tabId,
    url: '',
    title: '',
    generatedAt: Date.now(),
    forms: [],
    fields: [],
    fieldCount: 0,
    visibleFieldCount: 0,
    fillTargetCount: 0,
    omittedFieldCount: 0,
    error,
  };
}

function isBrowserSnapshotResult(
  result: BrowserSnapshotOperationResult | undefined,
): result is BrowserSnapshot {
  return Boolean(result && typeof result === 'object' && 'elements' in result);
}

function isBrowserFormSnapshotResult(
  result: BrowserSnapshotOperationResult | undefined,
): result is BrowserFormSnapshot {
  return Boolean(result && typeof result === 'object' && 'forms' in result && 'fields' in result);
}

function isBrowserRefResolutionResult(
  result: BrowserSnapshotOperationResult | undefined,
): result is BrowserRefResolution {
  return Boolean(result && typeof result === 'object' && 'ok' in result && !isBrowserSnapshotResult(result) && !isBrowserFormSnapshotResult(result));
}

async function sendBrowserSnapshotOperation(
  tabId: number,
  operation: BrowserSnapshotOperation,
): Promise<BrowserSnapshotOperationMessageResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'BROWSER_SNAPSHOT_OPERATION', payload: { tabId, operation } },
      (response: BrowserSnapshotOperationMessageResult | undefined) => {
        const runtimeError = chrome.runtime.lastError?.message;
        if (runtimeError) {
          resolve({ ok: false, error: runtimeError });
          return;
        }
        resolve(response ?? { ok: false, error: 'No response from background while running browser snapshot operation' });
      },
    );
  });
}

export async function browserSnapshot(
  tabId: number,
  options: BrowserSnapshotOptions = {},
): Promise<BrowserSnapshot> {
  try {
    await waitForTabSettled(tabId);
    const response = await sendBrowserSnapshotOperation(tabId, { kind: 'snapshot', tabId, options });
    if (response.ok && isBrowserSnapshotResult(response.result)) return response.result;
    return emptyBrowserSnapshot(tabId, response.error ?? 'No response from tab');
  } catch (err: any) {
    return emptyBrowserSnapshot(tabId, err?.message ?? 'Failed to capture browser snapshot');
  }
}

export async function browserFormSnapshot(
  tabId: number,
  options: BrowserFormSnapshotOptions = {},
): Promise<BrowserFormSnapshot> {
  try {
    await waitForTabSettled(tabId);
    const response = await sendBrowserSnapshotOperation(tabId, { kind: 'formSnapshot', tabId, options });
    if (response.ok && isBrowserFormSnapshotResult(response.result)) return response.result;
    return emptyBrowserFormSnapshot(tabId, response.error ?? 'No response from tab');
  } catch (err: any) {
    return emptyBrowserFormSnapshot(tabId, err?.message ?? 'Failed to capture browser form snapshot');
  }
}

export async function browserResolveRef(
  tabId: number,
  ref: string,
  snapshotId?: string,
  requireActionable = false,
): Promise<BrowserRefResolution> {
  try {
    const response = await sendBrowserSnapshotOperation(tabId, {
      kind: 'resolve',
      tabId,
      ref,
      snapshotId,
      requireActionable,
    });
    if (response.ok && isBrowserRefResolutionResult(response.result)) {
      return response.result;
    }
    return { ok: false, ref, snapshotId, error: response.error ?? 'No response from tab' };
  } catch (err: any) {
    return { ok: false, ref, snapshotId, error: err?.message ?? 'Failed to resolve element ref' };
  }
}

const {
  snapshotAfterAction,
  waitForClickPostconditions,
  evaluatePostconditions,
  postconditionsPassed,
  getSuccessfulNavigationWarning,
  getExpectedClickNavigationHref,
  shouldRetryProgrammaticClickForNavigation,
  getMissedClickNavigationError,
  navigateTabToClickedHref,
  recentDownloadAppeared,
} = createActionPostconditionRuntime({
  delay,
  browserSnapshot,
  browserResolveRef,
  waitForTabSettled,
});

const {
  resolveActionTarget,
  browserResolveMemoryTarget,
} = createTargetResolutionRuntime({
  waitForTabSettled,
  browserSnapshot,
  browserResolveRef,
  sendBrowserSnapshotOperation,
});

function createActionTrace(
  tabId: number,
  actionKind: BrowActionKind,
  options?: BrowserActionOptions,
): BrowActionTrace {
  return {
    traceId: globalThis.crypto?.randomUUID?.()
      ?? `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    tabId,
    actionKind,
    intent: options?.intent,
    cacheStatus: options?.intent && options.useActionMemory !== false ? 'miss' : 'disabled',
    startedAt: Date.now(),
  };
}

function completeTrace(trace: BrowActionTrace): BrowActionTrace {
  return {
    ...trace,
    completedAt: Date.now(),
  };
}

const {
  tryReplaySingleTargetAction,
  rememberSingleTargetAction,
} = createActionMemoryRuntime({
  browserSnapshot,
  browserResolveMemoryTarget,
  snapshotAfterAction,
  evaluatePostconditions,
  postconditionsPassed,
  waitForClickPostconditions,
  shouldRetryProgrammaticClickForNavigation,
  getMissedClickNavigationError,
  getExpectedClickNavigationHref,
  navigateTabToClickedHref,
  getSuccessfulNavigationWarning,
  completeTrace,
});

export async function browserClick(
  tabId: number,
  ref?: string,
  snapshotId?: string,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'click', options);
  trace.backend = 'mv3-dom';
  const replayed = await tryReplaySingleTargetAction({
    tabId,
    actionKind: 'click',
    options,
    trace,
    execute: (selector, clickMode) => tabsClick(tabId, selector, options.clickPoint, clickMode),
  });
  if (replayed) return replayed;

  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const precheckedPostconditions = await evaluatePostconditions(tabId, beforeSnapshot, options.postconditions);
  if (shouldRepairForSatisfiedValuePostconditions(precheckedPostconditions)) {
    trace.execution = {
      ok: false,
      skipped: {
        reason: 'Requested value postconditions were already satisfied before click.',
      },
    };
    trace.postconditions = precheckedPostconditions;
    trace.recoveryDecision = SATISFIED_VALUE_REPAIR_ERROR;
    return {
      ok: false,
      action: trace.execution,
      beforeSnapshot,
      snapshot: beforeSnapshot,
      backend: 'mv3-dom',
      cacheStatus: trace.cacheStatus,
      trace: completeTrace(trace),
      postconditions: precheckedPostconditions,
      repairNeeded: true,
      error: SATISFIED_VALUE_REPAIR_ERROR,
    };
  }

  if (shouldSkipActionForSatisfiedPostconditions(precheckedPostconditions)) {
    trace.execution = {
      ok: true,
      skipped: {
        reason: 'Requested postconditions were already satisfied before click.',
      },
    };
    trace.postconditions = precheckedPostconditions;
    trace.recoveryDecision = 'Skipped click because the requested end state was already satisfied.';
    return {
      ok: true,
      action: trace.execution,
      beforeSnapshot,
      snapshot: beforeSnapshot,
      backend: 'mv3-dom',
      cacheStatus: trace.cacheStatus,
      trace: completeTrace(trace),
      postconditions: precheckedPostconditions,
      repairNeeded: false,
    };
  }

  let resolved = await resolveActionTarget({
    tabId,
    ref,
    snapshotId,
    requireActionable: false,
    actionKind: 'click',
    options,
    beforeSnapshot,
  });
  if (resolved.ok && shouldRequireActionableClickResolution(resolved.entry)) {
    resolved = await resolveActionTarget({
      tabId,
      ref: resolved.ref ?? ref,
      snapshotId: resolved.snapshotId ?? snapshotId,
      requireActionable: true,
      actionKind: 'click',
      options,
      beforeSnapshot,
    });
  }
  trace.resolvedRef = resolved.ref;
  trace.originalRef = resolved.originalRef ?? ref;
  trace.snapshotId = resolved.snapshotId;
  trace.matchScore = resolved.matchScore;
  trace.confidence = resolved.confidence ?? resolved.matchScore;
  trace.preconditions = resolved.preconditions;
  trace.recoveryCandidates = resolved.repairCandidates;
  if (!resolved.ok || !resolved.selector) {
    trace.recoveryDecision = resolved.error ?? `Unable to resolve ref ${ref}`;
    return { ok: false, resolved, beforeSnapshot, backend: 'mv3-dom', confidence: trace.confidence, recoveryCandidates: resolved.repairCandidates, cacheStatus: trace.cacheStatus, trace: completeTrace(trace), error: trace.recoveryDecision };
  }

  const unsafePromotionError = getUnsafePromotedClickResolutionError(resolved);
  if (unsafePromotionError) {
    trace.recoveryDecision = unsafePromotionError;
    return {
      ok: false,
      resolved,
      beforeSnapshot,
      backend: 'mv3-dom',
      confidence: trace.confidence,
      recoveryCandidates: resolved.repairCandidates,
      cacheStatus: trace.cacheStatus,
      trace: completeTrace(trace),
      error: unsafePromotionError,
    };
  }

  const unsafeEditableClickError = getUnsafeEditableClickIntentError(resolved.entry, options.intent);
  if (unsafeEditableClickError) {
    trace.recoveryDecision = unsafeEditableClickError;
    return {
      ok: false,
      resolved,
      beforeSnapshot,
      backend: 'mv3-dom',
      confidence: trace.confidence,
      recoveryCandidates: resolved.repairCandidates,
      cacheStatus: trace.cacheStatus,
      trace: completeTrace(trace),
      error: unsafeEditableClickError,
    };
  }

  let action = await tabsClick(tabId, resolved.selector, options.clickPoint);
  let snapshot = await snapshotAfterAction(tabId);
  let postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  if (Boolean((action as any).ok) && !postconditionsPassed(postconditions)) {
    const waited = await waitForClickPostconditions(tabId, snapshot, options.postconditions);
    snapshot = waited.snapshot;
    postconditions = waited.results;
    if (postconditionsPassed(postconditions) && waited.waitedMs > 0) {
      trace.recoveryDecision = `Waited ${waited.waitedMs}ms for click postconditions to settle after the initial post-click snapshot.`;
    }
  }

  if (Boolean((action as any).ok) && shouldRetryProgrammaticClickForNavigation({
    beforeSnapshot,
    snapshot,
    action,
  })) {
    const repairAttempt = await tabsClick(tabId, resolved.selector, options.clickPoint, 'programmatic');
    let repairSnapshot = await snapshotAfterAction(tabId);
    let repairPostconditions = await evaluatePostconditions(tabId, repairSnapshot, options.postconditions);
    if (!postconditionsPassed(repairPostconditions)) {
      const waited = await waitForClickPostconditions(tabId, repairSnapshot, options.postconditions);
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
    trace.recoveryDecision = 'Retried click with programmatic dispatch after the initial click did not navigate to the clicked href.';
  }

  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  const missedNavigationError = actionOk
    ? getMissedClickNavigationError({
      beforeSnapshot,
      snapshot,
      action,
    })
    : undefined;

  if (actionOk && missedNavigationError) {
    const expectedHref = getExpectedClickNavigationHref(action, beforeSnapshot);
    if (expectedHref) {
      const fallback = await navigateTabToClickedHref(tabId, expectedHref, options.postconditions);
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
        trace.recoveryDecision = 'Opened the clicked href via tab URL navigation after DOM click attempts did not leave the current page.';
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

  const finalPostconditionsOk = postconditionsPassed(postconditions);
  const finalMissedNavigationError = actionOk
    ? getMissedClickNavigationError({
      beforeSnapshot,
      snapshot,
      action,
    })
    : undefined;
  const navigationWarning = actionOk && !finalMissedNavigationError
    ? getSuccessfulNavigationWarning({
      beforeSnapshot,
      snapshot,
      action,
      postconditions,
    })
    : undefined;

  if (actionOk && !finalMissedNavigationError && (finalPostconditionsOk || navigationWarning)) {
    const storedStatus = await rememberSingleTargetAction({
      actionKind: 'click',
      options,
      snapshot,
      resolved,
      trace,
    });
    if (trace.cacheStatus !== 'disabled') trace.cacheStatus = storedStatus;
  }

  if (navigationWarning) {
    trace.recoveryDecision = navigationWarning;
  }

  if (finalMissedNavigationError) {
    trace.recoveryDecision = finalMissedNavigationError;
  }

  return {
    ok: actionOk && !finalMissedNavigationError && (finalPostconditionsOk || Boolean(navigationWarning)),
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    confidence: trace.confidence,
    cacheStatus: trace.cacheStatus,
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && (Boolean(finalMissedNavigationError) || (!finalPostconditionsOk && !navigationWarning)),
    warning: navigationWarning,
    error: actionOk
      ? (finalMissedNavigationError ?? (finalPostconditionsOk || navigationWarning ? undefined : 'Click postcondition failed'))
      : ((action as any).error ?? 'Click failed'),
  };
}

export async function browserHover(
  tabId: number,
  ref?: string,
  snapshotId?: string,
  message?: string,
  durationMs?: number,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'hover', options);
  trace.backend = 'mv3-dom';
  const replayed = await tryReplaySingleTargetAction({
    tabId,
    actionKind: 'hover',
    options,
    trace,
    execute: (selector) => tabsHover(tabId, selector, message, durationMs),
  });
  if (replayed) return replayed;

  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const resolved = await resolveActionTarget({ tabId, ref, snapshotId, requireActionable: true, actionKind: 'hover', options, beforeSnapshot });
  trace.resolvedRef = resolved.ref;
  trace.originalRef = resolved.originalRef ?? ref;
  trace.snapshotId = resolved.snapshotId;
  trace.matchScore = resolved.matchScore;
  trace.confidence = resolved.confidence ?? resolved.matchScore;
  trace.preconditions = resolved.preconditions;
  trace.recoveryCandidates = resolved.repairCandidates;
  if (!resolved.ok || !resolved.selector) {
    trace.recoveryDecision = resolved.error ?? `Unable to resolve ref ${ref}`;
    return { ok: false, resolved, beforeSnapshot, backend: 'mv3-dom', confidence: trace.confidence, recoveryCandidates: resolved.repairCandidates, cacheStatus: trace.cacheStatus, trace: completeTrace(trace), error: trace.recoveryDecision };
  }

  const action = await tabsHover(tabId, resolved.selector, message, durationMs);
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  if (actionOk && postconditionsOk) {
    const storedStatus = await rememberSingleTargetAction({
      actionKind: 'hover',
      options,
      snapshot,
      resolved,
      trace,
    });
    if (trace.cacheStatus !== 'disabled') trace.cacheStatus = storedStatus;
  }
  return {
    ok: actionOk && postconditionsOk,
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    confidence: trace.confidence,
    cacheStatus: trace.cacheStatus,
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Hover postcondition failed')
      : ((action as any).error ?? 'Hover failed'),
  };
}

export async function browserType(
  tabId: number,
  ref: string | undefined,
  text: string,
  submit = false,
  snapshotId?: string,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'type', options);
  trace.backend = 'mv3-dom';
  const replayed = await tryReplaySingleTargetAction({
    tabId,
    actionKind: 'type',
    options,
    trace,
    execute: (selector) => tabsType(tabId, selector, text, submit),
  });
  if (replayed) return replayed;

  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const precheckedPostconditions = await evaluatePostconditions(tabId, beforeSnapshot, options.postconditions);
  if (shouldRepairForSatisfiedValuePostconditions(precheckedPostconditions)) {
    trace.execution = {
      ok: false,
      skipped: {
        reason: 'Requested value postconditions were already satisfied before type.',
      },
    };
    trace.postconditions = precheckedPostconditions;
    trace.recoveryDecision = SATISFIED_VALUE_REPAIR_ERROR;
    return {
      ok: false,
      action: trace.execution,
      beforeSnapshot,
      snapshot: beforeSnapshot,
      backend: 'mv3-dom',
      cacheStatus: trace.cacheStatus,
      trace: completeTrace(trace),
      postconditions: precheckedPostconditions,
      repairNeeded: true,
      error: SATISFIED_VALUE_REPAIR_ERROR,
    };
  }

  if (shouldSkipActionForSatisfiedPostconditions(precheckedPostconditions)) {
    trace.execution = {
      ok: true,
      skipped: {
        reason: 'Requested postconditions were already satisfied before type.',
      },
    };
    trace.postconditions = precheckedPostconditions;
    trace.recoveryDecision = 'Skipped type because the requested end state was already satisfied.';
    return {
      ok: true,
      action: trace.execution,
      beforeSnapshot,
      snapshot: beforeSnapshot,
      backend: 'mv3-dom',
      cacheStatus: trace.cacheStatus,
      trace: completeTrace(trace),
      postconditions: precheckedPostconditions,
      repairNeeded: false,
    };
  }

  const resolved = await resolveActionTarget({ tabId, ref, snapshotId, requireActionable: false, actionKind: 'type', options, beforeSnapshot });
  trace.resolvedRef = resolved.ref;
  trace.originalRef = resolved.originalRef ?? ref;
  trace.snapshotId = resolved.snapshotId;
  trace.matchScore = resolved.matchScore;
  trace.confidence = resolved.confidence ?? resolved.matchScore;
  trace.preconditions = resolved.preconditions;
  trace.recoveryCandidates = resolved.repairCandidates;
  if (!resolved.ok || !resolved.selector) {
    trace.recoveryDecision = resolved.error ?? `Unable to resolve ref ${ref}`;
    return { ok: false, resolved, beforeSnapshot, backend: 'mv3-dom', confidence: trace.confidence, recoveryCandidates: resolved.repairCandidates, cacheStatus: trace.cacheStatus, trace: completeTrace(trace), error: trace.recoveryDecision };
  }

  const action = await tabsType(tabId, resolved.selector, text, submit);
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = { ok: (action as any).ok, typed: (action as any).typed, error: (action as any).error };
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  if (actionOk && postconditionsOk) {
    const storedStatus = await rememberSingleTargetAction({
      actionKind: 'type',
      options,
      snapshot,
      resolved,
      trace,
    });
    if (trace.cacheStatus !== 'disabled') trace.cacheStatus = storedStatus;
  }
  return {
    ok: actionOk && postconditionsOk,
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    confidence: trace.confidence,
    cacheStatus: trace.cacheStatus,
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Type postcondition failed')
      : ((action as any).error ?? 'Type failed'),
  };
}

export async function browserFillForm(
  tabId: number,
  fields: BrowserFormFillField[],
  submit = false,
  submitRef?: string,
  snapshotId?: string,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'fillForm', options);
  trace.backend = 'mv3-dom';
  if (options.intent && options.useActionMemory !== false) {
    const activeSnapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 1 });
    const lookup = await findActionMemoryEntry({
      actionKind: 'fillForm',
      intent: options.intent,
      url: activeSnapshot.url,
    });
    trace.cacheKey = lookup.cacheKey;
    if (lookup.entry?.fields && lookup.entry.fields.length === fields.length) {
      trace.cacheStatus = 'hit';
      trace.memoryEntryId = lookup.entry.id;
      const replayFields: FormFillField[] = [];
      const fieldResolutions: BrowserMemoryResolution[] = [];
      let replayFailedBeforeExecution = false;

      for (let index = 0; index < lookup.entry.fields.length; index += 1) {
        const cachedField = lookup.entry.fields[index];
        const resolved = await browserResolveMemoryTarget(tabId, cachedField, true);
        fieldResolutions.push(resolved);
        if (!resolved.ok || !resolved.selector) {
          replayFailedBeforeExecution = true;
          trace.cacheStatus = 'stale';
          trace.recoveryDecision = resolved.error ?? 'cached form field could not be replayed';
          break;
        }
        replayFields.push({
          selector: resolved.selector,
          value: fields[index].value,
          mode: fields[index].mode ?? cachedField.mode,
        });
      }

      if (!replayFailedBeforeExecution) {
        let submitSelector: string | undefined;
        let submitResolution: BrowserMemoryResolution | undefined;
        if (lookup.entry.submitTarget) {
          submitResolution = await browserResolveMemoryTarget(tabId, lookup.entry.submitTarget, true);
          if (submitResolution.ok && submitResolution.selector) {
            submitSelector = submitResolution.selector;
          } else {
            replayFailedBeforeExecution = true;
            trace.cacheStatus = 'stale';
            trace.recoveryDecision = submitResolution.error ?? 'cached submit target could not be replayed';
          }
        }

        if (!replayFailedBeforeExecution) {
          trace.matchScore = Math.min(
            ...fieldResolutions.map((resolution) => resolution.matchScore ?? Number.POSITIVE_INFINITY),
          );
          trace.preconditions = {
            fields: fieldResolutions.map((resolution) => resolution.preconditions),
            submit: submitResolution?.preconditions,
          };
          const action = await tabsFillForm(tabId, replayFields, submit, submitSelector);
          const snapshot = await snapshotAfterAction(tabId);
          const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
          trace.execution = action as Record<string, unknown>;
          trace.postconditions = postconditions;
          const actionOk = Boolean((action as any).ok);
          const postconditionsOk = postconditionsPassed(postconditions);
          if (actionOk && postconditionsOk) {
            return {
              ok: true,
              action,
              snapshot,
              cacheStatus: 'hit',
              trace: completeTrace(trace),
              postconditions,
            };
          }
          trace.cacheStatus = 'stale';
          trace.recoveryDecision = actionOk ? 'cached form postcondition failed' : ((action as any).error ?? 'cached form fill failed');
          return {
            ok: false,
            action,
            snapshot,
            cacheStatus: 'stale',
            trace: completeTrace(trace),
            postconditions,
            repairNeeded: true,
            error: trace.recoveryDecision,
          };
        }
      }
    } else {
      trace.cacheStatus = 'miss';
    }
  }

  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const resolvedFields: FormFillField[] = [];
  const resolutions: BrowserRefResolution[] = [];

  for (const field of fields) {
    const resolved = await resolveActionTarget({
      tabId,
      ref: field.ref,
      snapshotId,
      requireActionable: true,
      actionKind: 'fillForm',
      options: {
        ...options,
        targetEvidence: field.targetEvidence ?? options.targetEvidence,
      },
      beforeSnapshot,
    });
    resolutions.push(resolved);
    if (!resolved.ok || !resolved.selector) {
      trace.resolvedRef = resolved.ref;
      trace.snapshotId = resolved.snapshotId;
      trace.preconditions = resolved.preconditions;
      trace.recoveryDecision = resolved.error ?? `Unable to resolve form field ref ${field.ref}`;
      return {
        ok: false,
        resolved,
        beforeSnapshot,
        backend: 'mv3-dom',
        confidence: resolved.confidence ?? resolved.matchScore,
        recoveryCandidates: resolved.repairCandidates,
        cacheStatus: trace.cacheStatus,
        trace: completeTrace(trace),
        error: trace.recoveryDecision,
      };
    }
    resolvedFields.push({
      selector: resolved.selector,
      value: field.value,
      mode: field.mode,
    });
  }

  let submitSelector: string | undefined;
  let submitResolution: BrowserRefResolution | undefined;
  if (submitRef) {
    submitResolution = await resolveActionTarget({ tabId, ref: submitRef, snapshotId, requireActionable: true, actionKind: 'click', options, beforeSnapshot });
    if (!submitResolution.ok || !submitResolution.selector) {
      trace.resolvedRef = submitResolution.ref;
      trace.snapshotId = submitResolution.snapshotId;
      trace.preconditions = submitResolution.preconditions;
      trace.recoveryDecision = submitResolution.error ?? `Unable to resolve submit ref ${submitRef}`;
      return {
        ok: false,
        resolved: submitResolution,
        beforeSnapshot,
        backend: 'mv3-dom',
        confidence: submitResolution.confidence ?? submitResolution.matchScore,
        recoveryCandidates: submitResolution.repairCandidates,
        cacheStatus: trace.cacheStatus,
        trace: completeTrace(trace),
        error: trace.recoveryDecision,
      };
    }
    submitSelector = submitResolution.selector;
  }

  const action = await tabsFillForm(tabId, resolvedFields, submit, submitSelector);
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  trace.preconditions = {
    fields: resolutions.map((resolution) => resolution.preconditions),
    submit: submitResolution?.preconditions,
  };
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  if (actionOk && postconditionsOk && options.intent && options.useActionMemory !== false) {
    const memoryFields: BrowActionMemoryField[] = resolutions
      .map((resolution, index) =>
        resolution.entry ? memoryFieldFromElement(resolution.entry, fields[index].mode) : null,
      )
      .filter((field): field is BrowActionMemoryField => Boolean(field));
    const saved = await upsertActionMemoryEntry({
      actionKind: 'fillForm',
      intent: options.intent,
      url: snapshot.url,
      fields: memoryFields,
      submitTarget: submitResolution?.entry ? memoryTargetFromElement(submitResolution.entry) : undefined,
    });
    trace.cacheKey = saved.cacheKey ?? trace.cacheKey;
    trace.memoryEntryId = saved.entry?.id ?? trace.memoryEntryId;
    trace.cacheStatus = saved.stored ? 'stored' : 'store_skipped';
  }
  return {
    ok: actionOk && postconditionsOk,
    action: {
      ...action,
      resolvedFields: resolutions,
      submitResolution,
    },
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    confidence: Math.min(...resolutions.map((resolution) => resolution.confidence ?? resolution.matchScore ?? 100)),
    cacheStatus: trace.cacheStatus,
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Form fill postcondition failed')
      : ((action as any).error ?? 'Form fill failed'),
  };
}

export async function browserDrag(
  tabId: number,
  sourceRef: string | undefined,
  destinationRef: string | undefined,
  snapshotId?: string,
  options: BrowserDragOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'drag', options);
  trace.backend = 'mv3-dom';
  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const source = await resolveActionTarget({
    tabId,
    ref: sourceRef,
    snapshotId,
    requireActionable: false,
    actionKind: 'drag',
    options,
    beforeSnapshot,
  });
  if (!source.ok || !source.selector) {
    trace.recoveryDecision = source.error ?? 'Unable to resolve drag source';
    trace.recoveryCandidates = source.repairCandidates;
    return {
      ok: false,
      resolved: source,
      beforeSnapshot,
      backend: 'mv3-dom',
      recoveryCandidates: source.repairCandidates,
      trace: completeTrace(trace),
      error: trace.recoveryDecision,
    };
  }

  const destination = await resolveActionTarget({
    tabId,
    ref: destinationRef,
    snapshotId,
    requireActionable: false,
    actionKind: 'drag',
    options: {
      ...options,
      targetEvidence: options.destinationTargetEvidence,
    },
    beforeSnapshot,
  });
  if (!destination.ok || !destination.selector) {
    trace.recoveryDecision = destination.error ?? 'Unable to resolve drag destination';
    trace.recoveryCandidates = destination.repairCandidates;
    return {
      ok: false,
      resolved: destination,
      beforeSnapshot,
      backend: 'mv3-dom',
      recoveryCandidates: destination.repairCandidates,
      trace: completeTrace(trace),
      error: trace.recoveryDecision,
    };
  }

  trace.resolvedRef = source.ref;
  trace.snapshotId = source.snapshotId;
  trace.matchScore = Math.min(source.matchScore ?? 100, destination.matchScore ?? 100);
  trace.confidence = trace.matchScore;
  trace.preconditions = { source: source.preconditions, destination: destination.preconditions };
  const action = await tabsDrag(tabId, source.selector, destination.selector, {
    sourceClickPoint: options.sourceClickPoint,
    destinationClickPoint: options.destinationClickPoint,
    pointerPath: options.pointerPath,
    durationMs: options.durationMs,
  });
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  return {
    ok: actionOk && postconditionsOk,
    action: {
      ...action,
      source,
      destination,
    },
    resolved: source,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    confidence: trace.confidence,
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Drag postcondition failed')
      : ((action as any).error ?? 'Drag failed'),
  };
}

export async function browserScroll(
  tabId: number,
  options: BrowserActionOptions & {
    ref?: string;
    snapshotId?: string;
    deltaX?: number;
    deltaY?: number;
    top?: number;
    left?: number;
  } = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'scroll', options);
  trace.backend = 'mv3-dom';
  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  let selector: string | undefined;
  let resolved: BrowserRefResolution | undefined;
  if (options.ref || options.targetEvidence) {
    resolved = await resolveActionTarget({
      tabId,
      ref: options.ref,
      snapshotId: options.snapshotId,
      requireActionable: false,
      actionKind: 'scroll',
      options,
      beforeSnapshot,
    });
    if (!resolved.ok || !resolved.selector) {
      trace.recoveryDecision = resolved.error ?? 'Unable to resolve scroll target';
      trace.recoveryCandidates = resolved.repairCandidates;
      return {
        ok: false,
        resolved,
        beforeSnapshot,
        backend: 'mv3-dom',
        recoveryCandidates: resolved.repairCandidates,
        trace: completeTrace(trace),
        error: trace.recoveryDecision,
      };
    }
    selector = resolved.selector;
  }

  const action = await tabsScroll(tabId, {
    selector,
    deltaX: options.deltaX,
    deltaY: options.deltaY ?? 650,
    top: options.top,
    left: options.left,
  });
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  return {
    ok: actionOk && postconditionsOk,
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Scroll postcondition failed')
      : ((action as any).error ?? 'Scroll failed'),
  };
}

export async function browserKey(
  tabId: number,
  options: BrowserActionOptions & {
    ref?: string;
    snapshotId?: string;
    key?: string;
    code?: string;
    text?: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  } = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'key', options);
  trace.backend = 'mv3-dom';
  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  let selector: string | undefined;
  let resolved: BrowserRefResolution | undefined;
  if (options.ref || options.targetEvidence) {
    resolved = await resolveActionTarget({
      tabId,
      ref: options.ref,
      snapshotId: options.snapshotId,
      requireActionable: false,
      actionKind: 'key',
      options,
      beforeSnapshot,
    });
    if (!resolved.ok || !resolved.selector) {
      trace.recoveryDecision = resolved.error ?? 'Unable to resolve key target';
      trace.recoveryCandidates = resolved.repairCandidates;
      return {
        ok: false,
        resolved,
        beforeSnapshot,
        backend: 'mv3-dom',
        recoveryCandidates: resolved.repairCandidates,
        trace: completeTrace(trace),
        error: trace.recoveryDecision,
      };
    }
    selector = resolved.selector;
  }

  const initialAction = await tabsKey(tabId, {
    selector,
    key: options.key,
    code: options.code,
    text: options.text,
    altKey: options.altKey,
    ctrlKey: options.ctrlKey,
    metaKey: options.metaKey,
    shiftKey: options.shiftKey,
  });
  let action: { ok: boolean; keyed?: unknown; error?: string; initialAttempt?: unknown; repairAttempt?: unknown } = initialAction;
  let snapshot = await snapshotAfterAction(tabId);
  let postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);

  if (Boolean((initialAction as any).ok) && shouldRetryBodyMediaKey({
    selector,
    key: options.key,
    code: options.code,
    text: options.text,
    postconditions: options.postconditions,
    postconditionResults: postconditions,
    targetSelector: (initialAction as any)?.keyed?.target?.selector,
    targetTagName: (initialAction as any)?.keyed?.target?.tagName,
  })) {
    const repairAttempt = await tabsKey(tabId, {
      selector: 'body',
      key: options.key,
      code: options.code,
      text: options.text,
      altKey: options.altKey,
      ctrlKey: options.ctrlKey,
      metaKey: options.metaKey,
      shiftKey: options.shiftKey,
    });
    const repairSnapshot = await snapshotAfterAction(tabId);
    const repairPostconditions = await evaluatePostconditions(tabId, repairSnapshot, options.postconditions);
    trace.recoveryDecision = 'Retried key input on document.body after media postcondition failed on the initial target.';

    action = Boolean((repairAttempt as any).ok)
      ? {
        ...(repairAttempt as any),
        initialAttempt: initialAction,
      }
      : {
        ...(initialAction as any),
        repairAttempt,
      };
    snapshot = repairSnapshot;
    postconditions = repairPostconditions;
  }

  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  return {
    ok: actionOk && postconditionsOk,
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Key postcondition failed')
      : ((action as any).error ?? 'Key action failed'),
  };
}

export async function browserUploadFile(
  tabId: number,
  ref: string | undefined,
  fileName?: string,
  filePath?: string,
  snapshotId?: string,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'upload', options);
  trace.backend = options.backendPreference === 'local-helper' ? 'local-helper' : 'mv3-dom';
  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const resolved = await resolveActionTarget({ tabId, ref, snapshotId, requireActionable: false, actionKind: 'upload', options, beforeSnapshot });
  if (!resolved.ok || !resolved.selector) {
    trace.recoveryDecision = resolved.error ?? 'Unable to resolve upload control';
    trace.recoveryCandidates = resolved.repairCandidates;
    return {
      ok: false,
      resolved,
      beforeSnapshot,
      backend: trace.backend,
      recoveryCandidates: resolved.repairCandidates,
      trace: completeTrace(trace),
      error: trace.recoveryDecision,
    };
  }

  const action = await tabsUploadFile(tabId, resolved.selector, fileName, filePath);
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  return {
    ok: Boolean((action as any).ok) && postconditionsPassed(postconditions),
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: (action as any).backend ?? trace.backend,
    trace: completeTrace(trace),
    postconditions,
    helperRequired: Boolean((action as any).helperRequired),
    error: (action as any).error,
  };
}

export async function browserHandleDialog(
  tabId: number,
  options: BrowserActionOptions & {
    ref?: string;
    snapshotId?: string;
    action?: 'accept' | 'dismiss' | 'close';
    text?: string;
  } = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'handleDialog', options);
  trace.backend = options.backendPreference === 'local-helper' ? 'local-helper' : 'mv3-dom';
  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  let selector: string | undefined;
  let resolved: BrowserRefResolution | undefined;
  if (options.ref || options.targetEvidence) {
    resolved = await resolveActionTarget({
      tabId,
      ref: options.ref,
      snapshotId: options.snapshotId,
      requireActionable: false,
      actionKind: 'handleDialog',
      options,
      beforeSnapshot,
    });
    if (!resolved.ok || !resolved.selector) {
      trace.recoveryDecision = resolved.error ?? 'Unable to resolve dialog target';
      return {
        ok: false,
        resolved,
        beforeSnapshot,
        backend: trace.backend,
        recoveryCandidates: resolved.repairCandidates,
        trace: completeTrace(trace),
        error: trace.recoveryDecision,
      };
    }
    selector = resolved.selector;
  }

  const action = await tabsHandleDialog(tabId, {
    selector,
    action: options.action ?? 'accept',
    text: options.text,
  });
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions ?? [{ type: 'dialogClosed', value: options.text }]);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  return {
    ok: Boolean((action as any).ok) && postconditionsPassed(postconditions),
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: (action as any).backend ?? trace.backend,
    trace: completeTrace(trace),
    postconditions,
    helperRequired: Boolean((action as any).helperRequired),
    error: (action as any).error,
  };
}

export async function browserWaitFor(
  tabId: number,
  postconditions: BrowActionPostcondition[],
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'wait');
  trace.backend = 'mv3-dom';
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const timeoutMs = Math.max(250, Math.min(Math.floor(options.timeoutMs ?? 5000), 60000));
  const pollMs = Math.max(100, Math.min(Math.floor(options.pollMs ?? 250), 2000));
  const startedAt = Date.now();
  let snapshot = beforeSnapshot;
  let results = await evaluatePostconditions(tabId, snapshot, postconditions);

  while (!postconditionsPassed(results) && Date.now() - startedAt < timeoutMs) {
    await delay(pollMs);
    snapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 80 });
    results = await evaluatePostconditions(tabId, snapshot, postconditions);
  }

  trace.postconditions = results;
  trace.execution = { waitedMs: Date.now() - startedAt, timeoutMs, pollMs };
  return {
    ok: postconditionsPassed(results),
    action: trace.execution,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    trace: completeTrace(trace),
    postconditions: results,
    error: postconditionsPassed(results) ? undefined : 'Timed out waiting for postconditions',
  };
}

export async function browserDownloadWait(
  tabId: number,
  options: { filenameIncludes?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'downloadWait');
  trace.backend = 'mv3-dom';
  const beforeSnapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 20 });
  const timeoutMs = Math.max(250, Math.min(Math.floor(options.timeoutMs ?? 30000), 120000));
  const pollMs = Math.max(250, Math.min(Math.floor(options.pollMs ?? 500), 5000));
  const startedAt = Date.now();
  let download = await recentDownloadAppeared(options.filenameIncludes);
  while (!download.ok && Date.now() - startedAt < timeoutMs) {
    await delay(pollMs);
    download = await recentDownloadAppeared(options.filenameIncludes);
  }
  const snapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 20 });
  const condition: BrowActionPostcondition = { type: 'downloadAppeared', value: options.filenameIncludes };
  const postconditions = [{ ok: download.ok, condition, actual: download.actual, error: download.error }];
  trace.postconditions = postconditions;
  trace.execution = { waitedMs: Date.now() - startedAt, timeoutMs, pollMs, filenameIncludes: options.filenameIncludes };
  return {
    ok: download.ok,
    action: trace.execution,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    trace: completeTrace(trace),
    postconditions,
    error: download.ok ? undefined : (download.error ?? 'Timed out waiting for download'),
  };
}
