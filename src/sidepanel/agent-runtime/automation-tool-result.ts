import type {
  BrowserRefResolution,
  BrowserSnapshot,
  BrowserSnapshotElement,
  BrowActionRepairCandidate,
  BrowPostconditionResult,
} from '../../shared/types';

export interface AutomationToolResultLike {
  ok?: boolean;
  action?: unknown;
  resolved?: BrowserRefResolution;
  snapshot?: BrowserSnapshot;
  beforeSnapshot?: BrowserSnapshot;
  backend?: string;
  confidence?: number;
  cacheStatus?: string;
  trace?: unknown;
  postconditions?: BrowPostconditionResult[];
  recoveryCandidates?: BrowActionRepairCandidate[];
  repairNeeded?: boolean;
  helperRequired?: boolean;
  warning?: string;
  error?: string;
  [key: string]: unknown;
}

export interface AutomationToolResultTextLike extends Omit<AutomationToolResultLike, 'snapshot' | 'beforeSnapshot' | 'postconditions' | 'recoveryCandidates'> {
  snapshot?: unknown;
  beforeSnapshot?: unknown;
  snapshotText?: string;
  postconditions?: unknown;
  recoveryCandidates?: unknown;
}

const ACTION_ENTRY_KEYS = [
  'clicked',
  'hovered',
  'typed',
  'highlighted',
  'source',
  'destination',
  'target',
  'control',
  'dialog',
  'resolvedFrom',
] as const;

const TOOL_ACTION_LABELS: Record<string, string> = {
  browser_click: 'clicked',
  browser_hover: 'hovered',
  browser_type: 'typed',
  browser_fill_form: 'filled form',
  browser_drag: 'dragged',
  browser_scroll: 'scrolled',
  browser_key: 'sent key',
  browser_wait_for: 'waited',
  browser_upload_file: 'uploaded file',
  browser_download_wait: 'waited for download',
  browser_handle_dialog: 'handled dialog',
};

function allPostconditionsPassed(results: BrowPostconditionResult[] | undefined): boolean {
  return Array.isArray(results) && results.length > 0 && results.every((result) => result.ok);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInlineText(text: string | undefined | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function truncateInline(text: string | undefined | null, max: number): string {
  const normalized = normalizeInlineText(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

function formatScalarValue(value: unknown, max = 80): string | undefined {
  if (typeof value === 'string') return `"${truncateInline(value, max)}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function formatToolActionLabel(toolName: string | undefined): string {
  if (!toolName) return 'action';
  return TOOL_ACTION_LABELS[toolName] ?? toolName.replace(/^browser_/, '').replace(/_/g, ' ');
}

function getActionEntry(action: unknown): { kind: string; details: Record<string, unknown> } | undefined {
  if (!isRecord(action)) return undefined;

  for (const key of ACTION_ENTRY_KEYS) {
    const value = action[key];
    if (isRecord(value)) {
      return { kind: key, details: value };
    }
  }

  return undefined;
}

function getResolvedRef(resolved: unknown): string | undefined {
  if (!isRecord(resolved) || typeof resolved.ref !== 'string') return undefined;
  return resolved.ref;
}

function formatTargetDescriptor(resolved: unknown, actionDetails: Record<string, unknown> | undefined): string | undefined {
  const resolvedRecord = isRecord(resolved) ? resolved : undefined;
  const targetRecord = isRecord(resolvedRecord?.target) ? resolvedRecord.target : undefined;
  const ref = getResolvedRef(resolved) ?? (typeof targetRecord?.ref === 'string' ? targetRecord.ref : undefined);
  const role = typeof targetRecord?.role === 'string'
    ? targetRecord.role
    : typeof actionDetails?.role === 'string'
      ? actionDetails.role
      : undefined;
  const label = typeof targetRecord?.name === 'string'
    ? targetRecord.name
    : typeof actionDetails?.name === 'string'
      ? actionDetails.name
      : typeof actionDetails?.id === 'string'
        ? actionDetails.id
        : typeof actionDetails?.selector === 'string'
          ? actionDetails.selector
          : undefined;

  const parts = [
    ref ? `[${ref}]` : undefined,
    role,
    label ? `"${truncateInline(label, 80)}"` : undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' ') : undefined;
}

function formatSummaryLine(payload: AutomationToolResultTextLike, toolName: string | undefined): string | undefined {
  const actionEntry = getActionEntry(payload.action);
  const actionLabel = actionEntry?.kind ?? formatToolActionLabel(toolName);
  const targetDescriptor = formatTargetDescriptor(payload.resolved, actionEntry?.details);
  const recovered = isRecord(payload.resolved) && payload.resolved.recovered === true ? ' [recovered]' : '';

  if (payload.ok === false) {
    return [`failed ${actionLabel}`, targetDescriptor].filter(Boolean).join(' ') + recovered;
  }

  if (payload.ok === true) {
    return [`ok ${actionLabel}`, targetDescriptor].filter(Boolean).join(' ') + recovered;
  }

  return targetDescriptor ? `${actionLabel} ${targetDescriptor}${recovered}` : `${actionLabel}${recovered}`;
}

function isLowSignalSuccessfulCondition(condition: Record<string, unknown> | undefined, resolvedRef: string | undefined): boolean {
  if (!condition || typeof condition.type !== 'string') return false;
  if (condition.type === 'valueEquals') {
    return typeof condition.ref !== 'string' || condition.ref === resolvedRef;
  }
  if (condition.type === 'elementVisible') {
    return typeof condition.ref === 'string' && condition.ref === resolvedRef;
  }
  return false;
}

function formatConditionSummary(condition: Record<string, unknown> | undefined, resolvedRef: string | undefined): string | undefined {
  if (!condition || typeof condition.type !== 'string') return undefined;

  const parts = [condition.type];
  if (typeof condition.ref === 'string' && condition.ref !== resolvedRef) {
    parts.push(`[${condition.ref}]`);
  }

  const formattedValue = formatScalarValue(condition.value, 80);
  if (formattedValue && condition.type !== 'valueEquals') {
    parts.push(formattedValue);
  }

  return parts.join(' ');
}

function formatPostconditionSummary(postconditions: unknown, resolvedRef: string | undefined): string | undefined {
  const postconditionEntries = Array.isArray(postconditions)
    ? postconditions.filter(isRecord)
    : [];
  if (postconditionEntries.length === 0) return undefined;

  const failedEntries = postconditionEntries.filter((entry) => entry.ok === false);
  if (failedEntries.length === 0) {
    const highSignalEntries = postconditionEntries.filter((entry) => !isLowSignalSuccessfulCondition(isRecord(entry.condition) ? entry.condition : undefined, resolvedRef));
    if (highSignalEntries.length === 0) return undefined;

    const rendered = highSignalEntries.slice(0, 2).map((entry) => formatConditionSummary(isRecord(entry.condition) ? entry.condition : undefined, resolvedRef) ?? 'condition');
    const moreCount = highSignalEntries.length - rendered.length;
    return `verified: ${rendered.join('; ')}${moreCount > 0 ? `; +${moreCount} more` : ''}`;
  }

  const rendered = failedEntries.slice(0, 2).map((entry) => {
    const parts = [formatConditionSummary(isRecord(entry.condition) ? entry.condition : undefined, resolvedRef) ?? 'condition'];
    const actualValue = formatScalarValue(entry.actual, 80);
    if (actualValue) parts.push(`actual=${actualValue}`);
    if (typeof entry.error === 'string') parts.push(`error="${truncateInline(entry.error, 100)}"`);
    return parts.join(' ');
  });
  const moreCount = failedEntries.length - rendered.length;
  return `postconditions: ${rendered.join('; ')}${moreCount > 0 ? `; +${moreCount} more` : ''}`;
}

function formatCandidateDescriptor(candidate: Record<string, unknown>): string {
  const parts = [
    typeof candidate.ref === 'string' ? `[${candidate.ref}]` : undefined,
    typeof candidate.role === 'string' ? candidate.role : undefined,
    typeof candidate.name === 'string' ? `"${truncateInline(candidate.name, 80)}"` : undefined,
  ].filter(Boolean);

  if (parts.length > 0) return parts.join(' ');
  if (typeof candidate.selector === 'string') return truncateInline(candidate.selector, 120);
  return 'candidate';
}

function formatRepairCandidates(payload: AutomationToolResultTextLike): string | undefined {
  const candidates = new Map<string, string>();
  const resolvedCandidates = isRecord(payload.resolved) && Array.isArray(payload.resolved.repairCandidates)
    ? payload.resolved.repairCandidates.filter(isRecord)
    : [];
  const payloadCandidates = Array.isArray(payload.recoveryCandidates)
    ? payload.recoveryCandidates.filter(isRecord)
    : [];

  for (const candidate of [...resolvedCandidates, ...payloadCandidates]) {
    const key = typeof candidate.ref === 'string'
      ? candidate.ref
      : typeof candidate.selector === 'string'
        ? candidate.selector
        : `${candidates.size}`;
    if (!candidates.has(key)) {
      candidates.set(key, formatCandidateDescriptor(candidate));
    }
  }

  const rendered = Array.from(candidates.values());
  if (rendered.length === 0) return undefined;
  const visible = rendered.slice(0, 3);
  const moreCount = rendered.length - visible.length;
  return `candidates: ${visible.join('; ')}${moreCount > 0 ? `; +${moreCount} more` : ''}`;
}

function parseSnapshotHeader(snapshotText: string): string | undefined {
  const firstLine = snapshotText.split('\n', 1)[0]?.trim();
  if (!firstLine) return undefined;

  const snapshotId = firstLine.match(/snapshotId=([^\s]+)/)?.[1];
  const title = firstLine.match(/title="([^"]+)"/)?.[1];
  const url = firstLine.match(/url=([^\s]+)/)?.[1];

  const parts = [
    'page:',
    snapshotId,
    title ? `"${truncateInline(title, 80)}"` : undefined,
    url ? truncateInline(url, 140) : undefined,
  ].filter(Boolean);

  return parts.length > 1 ? parts.join(' ') : undefined;
}

function formatSnapshotSection(payload: AutomationToolResultTextLike): string | undefined {
  const snapshotText = typeof payload.snapshotText === 'string' ? payload.snapshotText : undefined;
  if (!snapshotText) {
    if (!isRecord(payload.snapshot)) return undefined;
    const parts = [
      'page:',
      typeof payload.snapshot.snapshotId === 'string' ? payload.snapshot.snapshotId : undefined,
      typeof payload.snapshot.title === 'string' ? `"${truncateInline(payload.snapshot.title, 80)}"` : undefined,
      typeof payload.snapshot.url === 'string' ? truncateInline(payload.snapshot.url, 140) : undefined,
    ].filter(Boolean);
    return parts.length > 1 ? parts.join(' ') : undefined;
  }

  const header = parseSnapshotHeader(snapshotText);
  const rawLines = snapshotText.split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
  const refLines = rawLines.filter((line) => line.startsWith('- ')).map((line) => line.replace(/^-\s+/, '').replace(/\s+/g, ' '));
  const omittedLine = rawLines.find((line) => line.startsWith('... '));
  const omittedCount = omittedLine ? Number(omittedLine.match(/(\d+)/)?.[1] ?? 0) : 0;
  const refsText = refLines.length > 0
    ? `refs: ${refLines.join('; ')}${omittedCount > 0 ? `; +${omittedCount} more` : ''}`
    : omittedCount > 0
      ? `refs: +${omittedCount} more`
      : undefined;

  return [header, refsText].filter(Boolean).join('\n') || undefined;
}

export function formatAutomationToolResultText(payload: AutomationToolResultTextLike, toolName?: string): string {
  const lines: string[] = [];
  const summaryLine = formatSummaryLine(payload, toolName);
  if (summaryLine) lines.push(summaryLine);

  const resolvedRef = getResolvedRef(payload.resolved);
  const postconditionSummary = formatPostconditionSummary(payload.postconditions, resolvedRef);
  if (postconditionSummary) lines.push(postconditionSummary);

  if (typeof payload.warning === 'string' && payload.warning.trim()) {
    lines.push(`warning: ${truncateInline(payload.warning, 160)}`);
  }

  if (payload.helperRequired === true) {
    lines.push('helper required');
  }

  if (payload.repairNeeded === true) {
    lines.push('repair needed');
  }

  const candidateSummary = formatRepairCandidates(payload);
  if (candidateSummary) lines.push(candidateSummary);

  if (typeof payload.error === 'string' && payload.error.trim()) {
    lines.push(`error: ${truncateInline(payload.error, 180)}`);
  } else if (isRecord(payload.resolved) && typeof payload.resolved.error === 'string' && payload.resolved.error.trim()) {
    lines.push(`error: ${truncateInline(payload.resolved.error, 180)}`);
  }

  const snapshotSection = formatSnapshotSection(payload);
  if (snapshotSection) lines.push(snapshotSection);

  return lines.filter(Boolean).join('\n') || (payload.ok === false ? 'failed action' : 'ok');
}

function compactInteractiveSummary(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const compacted: Record<string, unknown> = {};
  if (typeof value.selector === 'string') compacted.selector = value.selector;
  if (typeof value.tagName === 'string') compacted.tagName = value.tagName;
  if (typeof value.role === 'string') compacted.role = value.role;
  if (typeof value.name === 'string') compacted.name = truncateInline(value.name, 160);
  if (typeof value.text === 'string') compacted.text = truncateInline(value.text, 160);
  if (typeof value.type === 'string') compacted.type = value.type;
  if (typeof value.id === 'string') compacted.id = value.id;
  if (typeof value.href === 'string') compacted.href = truncateInline(value.href, 200);
  if (typeof value.placeholder === 'string') compacted.placeholder = truncateInline(value.placeholder, 120);

  return Object.keys(compacted).length > 0 ? compacted : value;
}

function compactAction(action: unknown): unknown {
  if (!isRecord(action)) return action;

  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action)) {
    if (key === 'ok' && typeof value === 'boolean') continue;
    compacted[key] = [
      'clicked',
      'hovered',
      'typed',
      'highlighted',
      'source',
      'destination',
      'target',
      'control',
      'dialog',
      'resolvedFrom',
    ].includes(key)
      ? compactInteractiveSummary(value)
      : value;
  }

  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function summarizeSnapshotElement(element: BrowserSnapshotElement | undefined): Record<string, unknown> | undefined {
  if (!element) return undefined;

  const summary: Record<string, unknown> = {
    ref: element.ref,
    role: element.role,
    name: truncateInline(element.name || element.text || '', 160),
    tagName: element.tagName,
  };
  if (element.type) summary.type = element.type;
  if (element.actionable === true) summary.actionable = true;
  if (element.actionable === false) summary.actionable = false;
  if (element.selector) summary.selector = truncateInline(element.selector, 180);
  return summary;
}

function summarizeRepairCandidate(candidate: BrowActionRepairCandidate): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    ref: candidate.ref,
    role: candidate.role,
    name: truncateInline(candidate.name, 160),
    tagName: candidate.tagName,
    score: candidate.score,
  };
  if (candidate.selector) summary.selector = truncateInline(candidate.selector, 180);
  return summary;
}

function compactFailedPreconditions(preconditions: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!preconditions) return undefined;

  const failed = Object.entries(preconditions).filter(([key, value]) =>
    key === 'ok'
      ? value === false
      : value === false,
  );
  if (failed.length === 0) return undefined;
  return Object.fromEntries(failed);
}

function compactResolved(resolved: BrowserRefResolution | undefined): Record<string, unknown> | undefined {
  if (!resolved) return undefined;

  const compacted: Record<string, unknown> = {
    ok: resolved.ok,
  };
  if (resolved.ref) compacted.ref = resolved.ref;
  if (resolved.originalRef && resolved.originalRef !== resolved.ref) compacted.originalRef = resolved.originalRef;
  if (resolved.snapshotId) compacted.snapshotId = resolved.snapshotId;
  if (resolved.recovered) compacted.recovered = true;
  if (typeof resolved.matchScore === 'number') compacted.matchScore = resolved.matchScore;
  if (resolved.message) compacted.message = resolved.message;
  if (resolved.error) compacted.error = resolved.error;
  if (resolved.helperRequired) compacted.helperRequired = true;

  const target = summarizeSnapshotElement(resolved.entry);
  if (target) compacted.target = target;

  const promotedFrom = summarizeSnapshotElement(resolved.promotedFrom);
  if (promotedFrom) compacted.promotedFrom = promotedFrom;

  const failedPreconditions = compactFailedPreconditions(resolved.preconditions);
  if (failedPreconditions) compacted.failedPreconditions = failedPreconditions;

  if ((resolved.repairCandidates?.length ?? 0) > 0) {
    compacted.repairCandidates = resolved.repairCandidates
      ?.slice(0, 3)
      .map(summarizeRepairCandidate);
  }

  return compacted;
}

function compactPostcondition(result: BrowPostconditionResult): Record<string, unknown> {
  const compacted: Record<string, unknown> = {
    ok: result.ok,
    condition: result.condition,
  };
  if (!result.ok && typeof result.actual === 'string') compacted.actual = truncateInline(result.actual, 180);
  if (result.error) compacted.error = truncateInline(result.error, 180);
  return compacted;
}

export function compactAutomationToolResult<T extends AutomationToolResultLike>(payload: T): T {
  const compacted: AutomationToolResultLike = {
    ...payload,
    action: compactAction(payload.action),
    resolved: compactResolved(payload.resolved),
    postconditions: Array.isArray(payload.postconditions)
      ? payload.postconditions.map(compactPostcondition)
      : payload.postconditions,
    recoveryCandidates: Array.isArray(payload.recoveryCandidates)
      ? payload.recoveryCandidates.slice(0, 3).map(summarizeRepairCandidate)
      : payload.recoveryCandidates,
  };

  delete compacted.trace;
  delete compacted.backend;
  delete compacted.confidence;
  delete compacted.cacheStatus;

  if (compacted.ok === true && compacted.repairNeeded !== true && !compacted.error && allPostconditionsPassed(payload.postconditions)) {
    delete compacted.beforeSnapshot;
  }

  if (!compacted.action) delete compacted.action;
  if (!compacted.resolved) delete compacted.resolved;
  if ((compacted.postconditions?.length ?? 0) === 0) delete compacted.postconditions;
  if ((compacted.recoveryCandidates?.length ?? 0) === 0) delete compacted.recoveryCandidates;

  return compacted as T;
}