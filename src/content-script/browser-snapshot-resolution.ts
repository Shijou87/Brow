import { scoreElementSignature } from '../shared/browser-snapshot-signature';
import type {
  BrowserRefResolution,
  BrowserSnapshot,
  BrowserSnapshotElement,
  BrowserSnapshotOperation,
  BrowserViewportInfo,
  BrowserVisualRegion,
  BrowActionRepairCandidate,
  BrowReplayTargetEvidence,
} from '../shared/types';

type StoredSnapshot = {
  snapshotId: string;
  entriesByRef: Record<string, BrowserSnapshotElement>;
  nodesByRef: Record<string, Element>;
  order: string[];
  createdAt: number;
};

type CaptureResult = {
  snapshot: BrowserSnapshot;
  allEntries: BrowserSnapshotElement[];
  nodesByRef: Record<string, Element>;
};

interface ResolutionRuntimeDeps {
  browRefPrefix: string;
  minMemoryMatchScore: number;
  isElementNode: (value: unknown) => value is Element;
  isVisible: (el: Element) => boolean;
  getViewport: () => BrowserViewportInfo;
  createEntry: (el: Element, ref: string, parentRef?: string) => BrowserSnapshotElement;
  findActionTarget: (el: Element) => Element | null;
  evaluateActionability: (
    el: Element | undefined,
    role: string,
    requireEditable?: boolean,
  ) => {
    visible?: boolean;
    enabled?: boolean;
    receivesEvents?: boolean;
    actionable?: boolean;
    editable?: boolean;
    ok?: boolean;
  };
  captureSnapshot: (tabId: number, options?: { mode?: 'compact' | 'full'; maxElements?: number }) => CaptureResult;
  resolveStoredElement: (
    ref: string,
    snapshotId?: string,
  ) => { snapshotId: string; snapshot: StoredSnapshot; node?: Element; entry?: BrowserSnapshotElement } | null;
}

export function createBrowserSnapshotResolutionRuntime(deps: ResolutionRuntimeDeps) {
  function resolveMemory(
    operation: Extract<BrowserSnapshotOperation, { kind: 'resolveMemory' }>,
  ): BrowserRefResolution {
    const current = deps.captureSnapshot(operation.tabId, { mode: 'compact', maxElements: 80 });
    const requireActionable = Boolean(operation.requireActionable);
    const scored = current.allEntries
      .filter((candidate) => !requireActionable || candidate.actionable)
      .map((candidate) => ({
        candidate,
        score: Math.max(
          scoreElementSignature(operation.target.signature, candidate),
          operation.target.selector && candidate.selector === operation.target.selector ? 42 : 0,
        ),
      }))
      .filter((item) => item.score >= deps.minMemoryMatchScore)
      .sort((left, right) => right.score - left.score);

    if (scored.length === 0) {
      return {
        ok: false,
        error: 'Cached action target was not found on the current page.',
        snapshot: current.snapshot,
      };
    }

    const [best, second] = scored;
    if (second && best.score - second.score < 8) {
      return {
        ok: false,
        error: 'Cached action target matched multiple similar elements.',
        matchScore: best.score,
        snapshot: current.snapshot,
      };
    }

    const requireEditable = requireEditableForEntry(best.candidate);
    const preconditions = deps.evaluateActionability(
      current.nodesByRef[best.candidate.ref],
      best.candidate.role,
      requireEditable,
    );

    const passesResolutionPreconditions = preconditions.visible === true
      && preconditions.enabled === true
      && preconditions.receivesEvents === true
      && (!requireActionable || preconditions.actionable === true)
      && (!requireEditable || preconditions.editable === true);

    if (!passesResolutionPreconditions) {
      return {
        ok: false,
        error: 'Cached action target failed actionability checks.',
        ref: best.candidate.ref,
        snapshotId: current.snapshot.snapshotId,
        entry: best.candidate,
        matchScore: best.score,
        snapshot: current.snapshot,
        preconditions,
      };
    }

    return {
      ok: true,
      selector: resolutionSelector(current.snapshot.snapshotId, best.candidate.ref, deps.browRefPrefix),
      ref: best.candidate.ref,
      snapshotId: current.snapshot.snapshotId,
      entry: best.candidate,
      matchScore: best.score,
      snapshot: current.snapshot,
      preconditions,
    };
  }

  function resolveTarget(
    operation: Extract<BrowserSnapshotOperation, { kind: 'resolveTarget' }>,
  ): BrowserRefResolution {
    const current = deps.captureSnapshot(operation.tabId, { mode: 'compact', maxElements: 100 });
    const requireActionable = Boolean(operation.requireActionable);
    const scored = current.allEntries
      .filter((candidate) => !requireActionable || candidate.actionable)
      .map((candidate) => ({
        candidate,
        score: scoreTargetEvidenceCandidate(operation.target, candidate),
      }))
      .filter((item) => item.score >= deps.minMemoryMatchScore)
      .sort((left, right) => right.score - left.score);

    if (scored.length === 0) {
      return {
        ok: false,
        error: 'Target evidence did not match a current visible element.',
        snapshot: current.snapshot,
      };
    }

    const [best, second] = scored;
    const repairCandidates = scored.slice(0, 5).map((item) => repairCandidateFromEntry(item.candidate, item.score));
    if (second && best.score - second.score < 8) {
      return {
        ok: false,
        error: 'Target evidence matched multiple similar current elements.',
        matchScore: best.score,
        snapshot: current.snapshot,
        repairCandidates,
      };
    }

    const requireEditable = requireEditableForEntry(best.candidate);
    const preconditions = deps.evaluateActionability(
      current.nodesByRef[best.candidate.ref],
      best.candidate.role,
      requireEditable,
    );

    return {
      ok: true,
      selector: resolutionSelector(current.snapshot.snapshotId, best.candidate.ref, deps.browRefPrefix),
      ref: best.candidate.ref,
      snapshotId: current.snapshot.snapshotId,
      entry: best.candidate,
      matchScore: best.score,
      snapshot: current.snapshot,
      preconditions,
      repairCandidates,
      region: makeRegion(current.snapshot.snapshotId, best.candidate, current.snapshot.viewport),
    };
  }

  function resolveRef(
    operation: Extract<BrowserSnapshotOperation, { kind: 'resolve' }>,
  ): BrowserRefResolution {
    const stored = deps.resolveStoredElement(operation.ref, operation.snapshotId);
    const requireActionable = Boolean(operation.requireActionable);

    if (deps.isElementNode(stored?.node) && deps.isVisible(stored.node)) {
      const entry = deps.createEntry(stored.node, operation.ref);
      const preconditions = deps.evaluateActionability(stored.node, entry.role, requireEditableForEntry(entry));
      if (requireActionable && !entry.actionable) {
        const actionTarget = deps.findActionTarget(stored.node);
        if (actionTarget) {
          const targetEntry = deps.createEntry(actionTarget, operation.ref);
          const targetPreconditions = deps.evaluateActionability(
            actionTarget,
            targetEntry.role,
            requireEditableForEntry(targetEntry),
          );
          stored.snapshot.nodesByRef[operation.ref] = actionTarget;
          stored.snapshot.entriesByRef[operation.ref] = targetEntry;
          return {
            ok: true,
            ref: operation.ref,
            snapshotId: stored.snapshotId,
            selector: resolutionSelector(stored.snapshotId, operation.ref, deps.browRefPrefix),
            entry: targetEntry,
            recovered: false,
            preconditions: targetPreconditions,
            promotedFrom: entry,
            message: `Ref ${operation.ref} pointed at a non-actionable child; using nearest actionable ${targetEntry.role}.`,
          region: makeRegion(stored.snapshotId, targetEntry, deps.getViewport()),
          } as BrowserRefResolution;
        }
        return {
          ok: false,
          error: `Ref ${operation.ref} resolves to a visible element, but it is not actionable.`,
          ref: operation.ref,
          snapshotId: stored.snapshotId,
          entry,
        };
      }
      return {
        ok: true,
        ref: operation.ref,
        snapshotId: stored.snapshotId,
        selector: resolutionSelector(stored.snapshotId, operation.ref, deps.browRefPrefix),
        entry,
        recovered: false,
        preconditions,
        region: makeRegion(stored.snapshotId, entry, deps.getViewport()),
      };
    }

    const oldEntry = stored?.entry;
    if (!oldEntry) {
      return {
        ok: false,
        error: `Unknown element ref: ${operation.ref}. Take a fresh browser_snapshot and try again.`,
        ref: operation.ref,
        snapshotId: operation.snapshotId,
      };
    }

    const current = deps.captureSnapshot(operation.tabId, { mode: 'compact', maxElements: 80 });
    const recovered = recoverRef(oldEntry, current.allEntries, requireActionable, deps.isVisible);
    if (!recovered) {
      return {
        ok: false,
        error: `Ref ${operation.ref} is stale and could not be safely rematched. Take a fresh browser_snapshot and choose a new ref.`,
        ref: operation.ref,
        snapshotId: operation.snapshotId ?? stored?.snapshotId,
        snapshot: current.snapshot,
      };
    }

    return {
      ok: true,
      ref: recovered.ref,
      originalRef: operation.ref,
      snapshotId: current.snapshot.snapshotId,
      selector: resolutionSelector(current.snapshot.snapshotId, recovered.ref, deps.browRefPrefix),
      entry: recovered,
      recovered: true,
      snapshot: current.snapshot,
      matchScore: scoreRecoveryCandidate(oldEntry, recovered),
      preconditions: deps.evaluateActionability(
        current.nodesByRef[recovered.ref],
        recovered.role,
        requireEditableForEntry(recovered),
      ),
      region: makeRegion(current.snapshot.snapshotId, recovered, current.snapshot.viewport),
    };
  }

  return {
    resolveMemory,
    resolveTarget,
    resolveRef,
  };
}

function findBySelector(
  entry: BrowserSnapshotElement,
  isVisible: (el: Element) => boolean,
): Element | null {
  if (!entry.selector) return null;
  try {
    const matches = Array.from(document.querySelectorAll(entry.selector)).filter((candidate) => isVisible(candidate));
    if (matches.length !== 1) return null;
    return matches[0];
  } catch {
    return null;
  }
}

function scoreRecoveryCandidate(oldEntry: BrowserSnapshotElement, candidate: BrowserSnapshotElement): number {
  let score = 0;
  if (candidate.tagName === oldEntry.tagName) score += 4;
  if (candidate.role === oldEntry.role) score += 6;
  if (candidate.type && candidate.type === oldEntry.type) score += 4;
  if (candidate.name && oldEntry.name && candidate.name === oldEntry.name) score += 24;
  if (candidate.text && oldEntry.text && candidate.text === oldEntry.text) score += 10;
  if (candidate.attributes?.id && candidate.attributes.id === oldEntry.attributes?.id) score += 30;
  if (candidate.attributes?.['data-testid'] && candidate.attributes['data-testid'] === oldEntry.attributes?.['data-testid']) score += 30;
  if (candidate.attributes?.name && candidate.attributes.name === oldEntry.attributes?.name) score += 12;
  if (candidate.attributes?.placeholder && candidate.attributes.placeholder === oldEntry.attributes?.placeholder) score += 12;

  const dx = Math.abs(candidate.bounds.left - oldEntry.bounds.left);
  const dy = Math.abs(candidate.bounds.top - oldEntry.bounds.top);
  if (dx <= 4 && dy <= 4) score += 8;
  else if (dx <= 32 && dy <= 32) score += 4;

  return score;
}

function scoreTargetEvidenceCandidate(
  target: BrowReplayTargetEvidence,
  candidate: BrowserSnapshotElement,
): number {
  const signature = target.signature ?? {};
  let score = 0;

  if (target.selector && candidate.selector === target.selector) score += 42;
  if (signature.selector && candidate.selector === signature.selector) score += 24;
  if (signature.role && candidate.role === signature.role) score += 16;
  if (signature.tagName && candidate.tagName === signature.tagName) score += 10;
  if (signature.type && candidate.type === signature.type) score += 8;

  const candidateName = (candidate.name ?? '').replace(/\s+/g, ' ').trim();
  const signatureName = (signature.name ?? '').replace(/\s+/g, ' ').trim();
  if (signatureName && candidateName) {
    if (candidateName === signatureName) score += 36;
    else if (candidateName.toLowerCase() === signatureName.toLowerCase()) score += 24;
    else if (candidateName.toLowerCase().includes(signatureName.toLowerCase())) score += 10;
  }

  const candidateText = (candidate.text ?? '').replace(/\s+/g, ' ').trim();
  const signatureText = (signature.text ?? '').replace(/\s+/g, ' ').trim();
  if (signatureText && candidateText) {
    if (candidateText === signatureText) score += 14;
    else if (candidateText.toLowerCase() === signatureText.toLowerCase()) score += 8;
    else if (candidateText.toLowerCase().includes(signatureText.toLowerCase())) score += 4;
  }

  const attrs = signature.attributes ?? {};
  const candidateAttrs = candidate.attributes ?? {};
  const weightedAttrs: Array<[string, number]> = [
    ['id', 30],
    ['data-testid', 30],
    ['data-test', 26],
    ['aria-label', 22],
    ['name', 16],
    ['placeholder', 16],
    ['title', 14],
    ['alt', 14],
  ];
  for (const [name, weight] of weightedAttrs) {
    if (attrs[name] && attrs[name] === candidateAttrs[name]) score += weight;
  }

  if (target.bounds) {
    const dx = Math.abs(candidate.bounds.left - target.bounds.left);
    const dy = Math.abs(candidate.bounds.top - target.bounds.top);
    if (dx <= 4 && dy <= 4) score += 8;
    else if (dx <= 32 && dy <= 32) score += 4;
  }

  return score;
}

function repairCandidateFromEntry(entry: BrowserSnapshotElement, score: number): BrowActionRepairCandidate {
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

function recoverRef(
  oldEntry: BrowserSnapshotElement,
  currentEntries: BrowserSnapshotElement[],
  requireActionable: boolean,
  isVisible: (el: Element) => boolean,
): BrowserSnapshotElement | null {
  const selectorMatch = findBySelector(oldEntry, isVisible);
  if (selectorMatch) {
    const entry = currentEntries.find((candidate) => candidate.selector === oldEntry.selector);
    if (entry && (!requireActionable || entry.actionable)) {
      const score = scoreRecoveryCandidate(oldEntry, entry);
      if (score >= 18) return entry;
    }
  }

  const scored = currentEntries
    .filter((candidate) => !requireActionable || candidate.actionable)
    .map((candidate) => ({ candidate, score: scoreRecoveryCandidate(oldEntry, candidate) }))
    .filter((item) => item.score >= 24)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) return null;
  const [best, second] = scored;
  if (second && best.score - second.score < 8) return null;
  return best.candidate;
}

function requireEditableForEntry(entry: BrowserSnapshotElement): boolean {
  return ['textbox', 'searchbox'].includes(entry.role);
}

function resolutionSelector(snapshotId: string, ref: string, browRefPrefix: string): string {
  return `${browRefPrefix}${snapshotId}/${ref}`;
}

function makeRegion(snapshotId: string, entry: BrowserSnapshotElement, viewport: BrowserViewportInfo): BrowserVisualRegion {
  return {
    source: 'ref',
    ref: entry.ref,
    snapshotId,
    rect: entry.bounds,
    viewport,
  };
}
