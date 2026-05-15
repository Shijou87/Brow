import type {
  BrowserRefResolution,
  BrowserSnapshot,
  BrowserSnapshotElement,
  BrowserSnapshotOperation,
  BrowserSnapshotOperationResult,
  BrowserSnapshotOptions,
  BrowActionKind,
  BrowActionMemoryTarget,
  BrowActionRepairCandidate,
  BrowReplayTargetEvidence,
} from '../../../shared/types';
import type { BrowserSnapshotOperationMessageResult } from '../../../shared/messages';
import { isIntentRecoveryEntryAllowed } from '../click-intent-guards';

interface TargetResolutionOptions {
  intent?: string;
  targetEvidence?: BrowReplayTargetEvidence;
}

interface ResolveActionTargetParams {
  tabId: number;
  ref?: string;
  snapshotId?: string;
  requireActionable: boolean;
  actionKind?: BrowActionKind;
  options?: TargetResolutionOptions;
  beforeSnapshot?: BrowserSnapshot;
}

interface TargetResolutionRuntimeDeps {
  waitForTabSettled: (tabId: number) => Promise<unknown>;
  browserSnapshot: (tabId: number, options?: BrowserSnapshotOptions) => Promise<BrowserSnapshot>;
  browserResolveRef: (
    tabId: number,
    ref: string,
    snapshotId?: string,
    requireActionable?: boolean,
  ) => Promise<BrowserRefResolution>;
  sendBrowserSnapshotOperation: (
    tabId: number,
    operation: BrowserSnapshotOperation,
  ) => Promise<BrowserSnapshotOperationMessageResult>;
}

const ACTION_EXPANDED_SNAPSHOT_MAX_ELEMENTS = 250;
const INTENT_MATCH_THRESHOLD = 42;
const INTENT_MATCH_MARGIN = 8;

const INTENT_STOP_WORDS = new Set([
  'about',
  'action',
  'button',
  'click',
  'element',
  'find',
  'for',
  'from',
  'into',
  'open',
  'page',
  'play',
  'press',
  'result',
  'search',
  'select',
  'submit',
  'target',
  'the',
  'this',
  'type',
  'video',
  'with',
]);

export function createTargetResolutionRuntime(deps: TargetResolutionRuntimeDeps) {
  async function browserResolveTargetEvidence(
    tabId: number,
    target: BrowReplayTargetEvidence,
    requireActionable = false,
  ): Promise<BrowserRefResolution> {
    try {
      await deps.waitForTabSettled(tabId);
      const response = await deps.sendBrowserSnapshotOperation(tabId, {
        kind: 'resolveTarget',
        tabId,
        target,
        requireActionable,
      });
      if (response.ok && isBrowserRefResolutionResult(response.result)) {
        return response.result;
      }
      return { ok: false, error: response.error ?? 'No response from tab while resolving target evidence' };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Failed to resolve target evidence' };
    }
  }

  async function resolveActionTarget(params: ResolveActionTargetParams): Promise<BrowserRefResolution> {
    let refResolution: BrowserRefResolution | undefined;
    const evidenceRef = params.options?.targetEvidence?.observedRef ?? params.options?.targetEvidence?.ref;
    const candidateRef = params.ref ?? evidenceRef;
    const candidateSnapshotId = params.snapshotId ?? params.options?.targetEvidence?.snapshotId;
    const freshSnapshot = snapshotHasRef(params.beforeSnapshot, candidateRef) ? params.beforeSnapshot : undefined;
    const freshSnapshotId = freshSnapshot?.snapshotId;
    const recoveryCandidates: BrowActionRepairCandidate[] = [];

    if (candidateRef) {
      refResolution = await deps.browserResolveRef(
        params.tabId,
        candidateRef,
        candidateSnapshotId,
        params.requireActionable,
      );
      if (refResolution.ok && refResolution.selector) {
        return {
          ...refResolution,
          backend: 'mv3-dom',
          confidence: refResolution.matchScore ?? 100,
        };
      }

      if (
        freshSnapshotId
        && candidateSnapshotId
        && freshSnapshotId !== candidateSnapshotId
        && refResolution.error?.includes('Unknown element ref')
      ) {
        const freshResolution = await deps.browserResolveRef(
          params.tabId,
          candidateRef,
          freshSnapshotId,
          params.requireActionable,
        );
        if (freshResolution.ok && freshResolution.selector) {
          return {
            ...freshResolution,
            originalRef: candidateRef,
            recovered: true,
            backend: 'mv3-dom',
            confidence: freshResolution.matchScore ?? 100,
            message: `Recovered ref ${candidateRef} from fresh pre-action snapshot after stale snapshotId failed.`,
          };
        }
      }

      if (refResolution.error?.includes('Unknown element ref')) {
        const expandedSnapshot = await deps.browserSnapshot(params.tabId, {
          mode: 'full',
          maxElements: ACTION_EXPANDED_SNAPSHOT_MAX_ELEMENTS,
        });

        const intentMatch = findIntentCandidate(
          expandedSnapshot.ok ? expandedSnapshot : params.beforeSnapshot,
          params.options?.intent,
          params.actionKind,
          params.requireActionable,
        );
        recoveryCandidates.push(...intentMatch.candidates);

        if (intentMatch.candidate && expandedSnapshot.ok) {
          const semanticResolution = await deps.browserResolveRef(
            params.tabId,
            intentMatch.candidate.ref,
            expandedSnapshot.snapshotId,
            params.requireActionable,
          );
          if (semanticResolution.ok && semanticResolution.selector) {
            return {
              ...semanticResolution,
              originalRef: candidateRef,
              recovered: true,
              backend: 'mv3-dom',
              confidence: intentMatch.candidate.score,
              matchScore: intentMatch.candidate.score,
              repairCandidates: intentMatch.candidates,
              message: `Recovered stale ref ${candidateRef} by matching action intent against expanded pre-action snapshot.`,
            };
          }
        }

        if (intentMatch.ambiguous && refResolution) {
          refResolution = {
            ...refResolution,
            snapshot: expandedSnapshot.ok ? expandedSnapshot : refResolution.snapshot,
            repairCandidates: intentMatch.candidates,
            error: `${refResolution.error} Multiple current elements matched the action intent; choose one of the repair candidates from a fresh browser_snapshot.`,
          };
        }
      }
    }

    if (refResolution && recoveryCandidates.length > 0 && !refResolution.repairCandidates) {
      refResolution = {
        ...refResolution,
        repairCandidates: recoveryCandidates,
      };
    }

    if (params.options?.targetEvidence) {
      const evidenceResolution = await browserResolveTargetEvidence(
        params.tabId,
        params.options.targetEvidence,
        params.requireActionable,
      );
      if (evidenceResolution.ok && evidenceResolution.selector) {
        return {
          ...evidenceResolution,
          originalRef: candidateRef,
          backend: 'mv3-dom',
          confidence: evidenceResolution.matchScore,
        };
      }
      return {
        ...evidenceResolution,
        originalRef: candidateRef,
        error: evidenceResolution.error ?? refResolution?.error ?? 'Unable to resolve target evidence',
      };
    }

    return refResolution ?? {
      ok: false,
      ref: params.ref,
      snapshotId: params.snapshotId,
      repairCandidates: recoveryCandidates.length > 0 ? recoveryCandidates : undefined,
      error: 'Provide either a live ref or targetEvidence for this browser action.',
    };
  }

  async function browserResolveMemoryTarget(
    tabId: number,
    target: BrowActionMemoryTarget,
    requireActionable = true,
  ): Promise<BrowserRefResolution> {
    try {
      await deps.waitForTabSettled(tabId);
      const response = await deps.sendBrowserSnapshotOperation(tabId, {
        kind: 'resolveMemory',
        tabId,
        target,
        requireActionable,
      });
      if (response.ok && isBrowserRefResolutionResult(response.result)) {
        return response.result;
      }
      return { ok: false, error: response.error ?? 'No response from tab while resolving cached action target' };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Failed to resolve cached action target' };
    }
  }

  return {
    resolveActionTarget,
    browserResolveMemoryTarget,
  };
}

function normalizeIntentText(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenizeIntent(value: string | undefined): string[] {
  const tokens = normalizeIntentText(value).split(' ').filter(Boolean);
  const unique = new Set<string>();
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (INTENT_STOP_WORDS.has(token)) continue;
    unique.add(token);
  }
  return [...unique];
}

function entryIntentText(entry: BrowserSnapshotElement): string {
  const attrs = entry.attributes ?? {};
  return normalizeIntentText([
    entry.name,
    entry.text,
    entry.role,
    entry.tagName,
    attrs['aria-label'],
    attrs.title,
    attrs.placeholder,
    attrs.name,
    attrs.alt,
  ].filter(Boolean).join(' '));
}

function scoreIntentCandidate(
  entry: BrowserSnapshotElement,
  intentTokens: string[],
  actionKind: BrowActionKind | undefined,
): number {
  if (intentTokens.length === 0) return 0;
  const haystack = entryIntentText(entry);
  if (!haystack) return 0;

  let score = 0;
  let matched = 0;
  for (const token of intentTokens) {
    const tokenPattern = new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    if (tokenPattern.test(haystack)) {
      matched += 1;
      score += 12;
    } else if (haystack.includes(token)) {
      matched += 1;
      score += 7;
    }
  }

  if (matched === 0) return 0;
  const coverage = matched / intentTokens.length;
  score += Math.round(coverage * 24);
  if (coverage >= 0.8) score += 14;
  if (coverage === 1) score += 10;

  if (actionKind === 'type') {
    if (['textbox', 'searchbox', 'combobox'].includes(entry.role)) score += 24;
    if (['input', 'textarea'].includes(entry.tagName)) score += 18;
    const fieldText = haystack;
    if (fieldText.includes('search') || fieldText.includes('rechercher')) score += 14;
  } else if (actionKind === 'click') {
    if (entry.role === 'link') score += 20;
    else if (entry.role === 'button') score += 14;
    else if (entry.role === 'heading') score += 8;
    if (entry.actionable) score += 10;
  }

  const textLength = (entry.name || entry.text || '').length;
  if (textLength > 220) score -= 12;
  return score;
}

function repairCandidateFromSnapshotEntry(entry: BrowserSnapshotElement, score: number): BrowActionRepairCandidate {
  return {
    ref: entry.ref,
    selector: entry.selector,
    role: entry.role,
    name: entry.name,
    tagName: entry.tagName,
    score,
    bounds: entry.bounds,
    attributes: entry.attributes,
  };
}

function findIntentCandidate(
  snapshot: BrowserSnapshot | undefined,
  intent: string | undefined,
  actionKind: BrowActionKind | undefined,
  requireActionable: boolean,
): { candidate?: BrowActionRepairCandidate; candidates: BrowActionRepairCandidate[]; ambiguous?: boolean } {
  if (!snapshot?.ok || !intent || !['click', 'type'].includes(actionKind ?? '')) {
    return { candidates: [] };
  }
  const intentTokens = tokenizeIntent(intent);
  if (intentTokens.length === 0) return { candidates: [] };

  const scored = snapshot.elements
    .filter((entry) => {
      if (requireActionable && !entry.actionable) return false;
      if (!isIntentRecoveryEntryAllowed(entry, actionKind)) return false;
      if (actionKind === 'type') {
        return entry.actionable
          && (
            ['textbox', 'searchbox', 'combobox'].includes(entry.role)
            || ['input', 'textarea'].includes(entry.tagName)
          );
      }
      return true;
    })
    .map((entry) => ({
      entry,
      score: scoreIntentCandidate(entry, intentTokens, actionKind),
    }))
    .filter((item) => item.score >= INTENT_MATCH_THRESHOLD)
    .sort((left, right) => right.score - left.score);

  const candidates = scored.slice(0, 5).map((item) => repairCandidateFromSnapshotEntry(item.entry, item.score));
  const [best, second] = scored;
  if (!best) return { candidates };
  if (second && best.score - second.score < INTENT_MATCH_MARGIN) {
    return { candidates, ambiguous: true };
  }
  return { candidate: candidates[0], candidates };
}

function snapshotHasRef(snapshot: BrowserSnapshot | undefined, ref: string | undefined): boolean {
  return Boolean(ref && snapshot?.elements.some((element) => element.ref === ref));
}

function isBrowserSnapshotResult(
  result: BrowserSnapshotOperationResult | undefined,
): result is BrowserSnapshot {
  return Boolean(result && typeof result === 'object' && 'elements' in result);
}

function isBrowserFormSnapshotResult(
  result: BrowserSnapshotOperationResult | undefined,
): boolean {
  return Boolean(result && typeof result === 'object' && 'forms' in result && 'fields' in result);
}

function isBrowserRefResolutionResult(
  result: BrowserSnapshotOperationResult | undefined,
): result is BrowserRefResolution {
  return Boolean(
    result
    && typeof result === 'object'
    && 'ok' in result
    && !isBrowserSnapshotResult(result)
    && !isBrowserFormSnapshotResult(result),
  );
}
