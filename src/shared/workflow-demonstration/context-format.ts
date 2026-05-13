import type { WorkflowDemonstration } from '../types';

const QUERY_CONTEXT_TITLE_LIMIT = 120;
const QUERY_CONTEXT_URL_LIMIT = 160;
const QUERY_WORKFLOW_DEMONSTRATION_LIMIT = 10;

function normalizeInlineText(text: string | undefined | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function truncateInline(text: string | undefined | null, max: number): string {
  const normalized = normalizeInlineText(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

function quoteInline(text: string | undefined | null, max = 240): string {
  return JSON.stringify(truncateInline(text, max));
}

function formatTabContext(tab: WorkflowDemonstration['demonstratedTab']): string {
  return [
    typeof tab.tabId === 'number' ? `tabId=${tab.tabId}` : '',
    tab.title ? `title=${quoteInline(tab.title, QUERY_CONTEXT_TITLE_LIMIT)}` : '',
    `url=${truncateInline(tab.url, QUERY_CONTEXT_URL_LIMIT)}`,
  ].filter(Boolean).join(' ');
}

function formatTargetEvidence(label: string, target: WorkflowDemonstration['steps'][number]['target']): string[] {
  if (!target) return [];
  const signature = target.signature;
  const selector = target.selector ?? signature.selector;

  // Build a ready-to-use targetEvidence JSON object the LLM can pass directly
  // to browser_click/browser_type/browser_drag tool calls.
  // Exclude historical observedRef and snapshotId — they are not live-executable.
  const evidence: Record<string, unknown> = {};
  if (selector) evidence.selector = selector;
  const sig: Record<string, unknown> = {};
  if (signature.role) sig.role = truncateInline(signature.role, 80);
  if (signature.name) sig.name = truncateInline(signature.name, 160);
  if (signature.text) sig.text = truncateInline(signature.text, 220);
  if (signature.tagName) sig.tagName = truncateInline(signature.tagName, 40);
  if (signature.type) sig.type = truncateInline(signature.type, 40);
  if (signature.attributes && Object.keys(signature.attributes).length > 0) {
    sig.attributes = signature.attributes;
  }
  if (Object.keys(sig).length > 0) evidence.signature = sig;
  if (target.framePath?.length) evidence.framePath = target.framePath;
  if (target.shadowPath?.length) evidence.shadowPath = target.shadowPath;

  return [
    `${label}: role=${quoteInline(signature.role, 80)} name=${quoteInline(signature.name, 160)} tag=${quoteInline(signature.tagName, 40)}${signature.type ? ` type=${quoteInline(signature.type, 40)}` : ''}`,
    `${label}Evidence=${JSON.stringify(evidence)}`,
  ];
}

function formatWorkflowValue(step: WorkflowDemonstration['steps'][number]): string | undefined {
  if (!step.value) return undefined;
  if (step.value.captureMode === 'literal') {
    return `value: literal ${quoteInline(step.value.text ?? '', 500)}`;
  }
  return `value: ${step.value.captureMode}`;
}

function formatClickPoint(origin: 'target' | 'targetFraction' | 'viewport', x: number, y: number): string {
  return JSON.stringify({ origin, x, y });
}

function formatWorkflowPointer(step: WorkflowDemonstration['steps'][number]): string | undefined {
  const pointer = step.pointer;
  if (!pointer) return undefined;

  const parts = [
    `viewport=(${pointer.viewportX},${pointer.viewportY})`,
    pointer.targetOffsetX !== undefined && pointer.targetOffsetY !== undefined
      ? `targetOffset=(${pointer.targetOffsetX},${pointer.targetOffsetY})`
      : '',
    pointer.targetPercentX !== undefined && pointer.targetPercentY !== undefined
      ? `targetPercent=(${pointer.targetPercentX},${pointer.targetPercentY})`
      : '',
    pointer.targetBounds
      ? `targetBounds=${Math.round(pointer.targetBounds.left)},${Math.round(pointer.targetBounds.top)},${Math.round(pointer.targetBounds.width)}x${Math.round(pointer.targetBounds.height)}`
      : '',
    pointer.targetPercentX !== undefined && pointer.targetPercentY !== undefined
      ? `clickPoint=${formatClickPoint('targetFraction', pointer.targetPercentX, pointer.targetPercentY)}`
      : '',
    pointer.targetOffsetX !== undefined && pointer.targetOffsetY !== undefined
      ? `fallbackClickPoint=${formatClickPoint('target', pointer.targetOffsetX, pointer.targetOffsetY)}`
      : '',
    `viewportClickPoint=${formatClickPoint('viewport', pointer.viewportX, pointer.viewportY)}`,
  ].filter(Boolean);

  return parts.length > 0 ? `pointer: ${parts.join(' ')}` : undefined;
}

function formatWorkflowTrace(step: WorkflowDemonstration['steps'][number]): string[] {
  const lines: string[] = [];
  if (step.pointerPath?.length) {
    lines.push(`pointerPath=${JSON.stringify(step.pointerPath.slice(0, 12))}${step.pointerPath.length > 12 ? ` plus ${step.pointerPath.length - 12} more` : ''}`);
  }
  if (step.trace?.keyboard) {
    lines.push(`keyboard=${JSON.stringify(step.trace.keyboard)}`);
  }
  if (step.trace?.scroll) {
    lines.push(`scroll=${JSON.stringify(step.trace.scroll)}`);
  }
  if (step.trace?.urlBefore && step.trace.urlBefore !== step.trace.urlAfter) {
    lines.push(`urlTransition=${quoteInline(step.trace.urlBefore, 120)} -> ${quoteInline(step.trace.urlAfter, 120)}`);
  }
  return lines;
}

function formatStepSummaryLine(step: WorkflowDemonstration['steps'][number], stepIndex: number): string {
  const num = stepIndex + 1;
  const target = step.target;
  const sig = target?.signature;
  const targetLabel = sig
    ? `${sig.role ?? 'element'}${sig.name ? ` "${truncateInline(sig.name, 60)}"` : ''}`
    : '';

  if (step.kind === 'navigate') {
    return `${num}. navigate (wait for page)`;
  }
  if (step.kind === 'type' && step.value) {
    const val = step.value.captureMode === 'literal'
      ? `"${truncateInline(step.value.text ?? '', 40)}"`
      : `(${step.value.captureMode})`;
    return `${num}. type ${val} → ${targetLabel} [SUBSTITUTE user value]`;
  }
  if (step.kind === 'click' && sig) {
    const hasLiteralValue = sig.text && /^\d/.test(sig.text);
    const suffix = hasLiteralValue ? ' [SUBSTITUTE user value]' : '';
    return `${num}. click → ${targetLabel}${suffix}`;
  }
  return `${num}. ${step.kind} → ${targetLabel}`;
}

export function formatWorkflowDemonstrationForContext(
  demonstration: WorkflowDemonstration,
  index = 1,
): string {
  const stepLines = demonstration.steps.flatMap((step, stepIndex) => [
    `Step ${stepIndex + 1}: kind=${step.kind} replayability=${step.replayability} title=${quoteInline(step.title, 220)}`,
    `tab: ${formatTabContext(step.tab)}`,
    ...formatTargetEvidence('target', step.target),
    ...formatTargetEvidence('destination', step.destination),
    formatWorkflowPointer(step),
    ...formatWorkflowTrace(step),
    formatWorkflowValue(step),
    step.note ? `note=${quoteInline(step.note, 240)}` : undefined,
  ].filter((line): line is string => Boolean(line)));

  const executionPlan = demonstration.steps.map((step, i) => formatStepSummaryLine(step, i));

  return [
    `Workflow Demonstration ${index}: ${demonstration.title}`,
    `demonstratedTab: ${formatTabContext(demonstration.demonstratedTab)}`,
    demonstration.note ? `note=${quoteInline(demonstration.note, 240)}` : '',
    `steps: ${demonstration.steps.length}`,
    ...stepLines,
    '',
    'EXECUTION PLAN (follow exactly in order, use same interaction pattern as demo):',
    ...executionPlan,
  ].filter(Boolean).join('\n');
}

export function buildWorkflowDemonstrationContext(workflowDemonstrations: WorkflowDemonstration[] = []): string {
  if (workflowDemonstrations.length === 0) return '';

  const selected = workflowDemonstrations.slice(-QUERY_WORKFLOW_DEMONSTRATION_LIMIT);
  const omittedCount = Math.max(workflowDemonstrations.length - selected.length, 0);
  const blocks = selected.map((demonstration, index) => formatWorkflowDemonstrationForContext(demonstration, index + 1));

  return [
    `Attached workflow demonstrations: ${selected.map((demonstration) => demonstration.title).join(', ')}${omittedCount > 0 ? ` (plus ${omittedCount} earlier demonstration${omittedCount !== 1 ? 's' : ''})` : ''}.`,
    blocks.join('\n\n'),
    'Replay guidance: a Workflow Demonstration is a TEMPLATE showing HOW to accomplish a task on a site — the same navigation steps and UI targets, but with the user\'s values substituted for the demo\'s recorded values. Compare the user\'s request to the demo: map each demo value (cities, dates, quantities, search terms, options) to the corresponding user-requested value, then follow the demo steps in order using the user\'s values instead.',
    'Step execution: for each step: 1) take a fresh browser_snapshot, 2) find the current ref matching the step role/name/attributes, 3) call the matching browser tool with that ref AND pass the step targetEvidence JSON as-is into the targetEvidence parameter for recovery. When the step has a recorded value (e.g. value: literal "Paris"), replace it with the user\'s corresponding value (e.g. the user\'s departure city). When a step clicks a date or option that was specific to the demo, pick the equivalent for the user\'s request instead.',
    'For canvas/SVG/region clicks and drags, also pass the provided clickPoint or pointerPath. If the recorded target is absent from the compact snapshot, request mode="full" or rely on the targetEvidence for selector/signature fallback rather than guessing a nearby ref. Manual/omitted values require user confirmation before replay.',
  ].filter(Boolean).join('\n');
}