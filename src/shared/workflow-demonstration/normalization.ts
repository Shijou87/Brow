import type {
  BrowElementSignature,
  BrowserViewportRect,
  WorkflowDemonstration,
  WorkflowDemonstrationKeyboardEvidence,
  WorkflowDemonstrationPointer,
  WorkflowDemonstrationPointerSample,
  WorkflowDemonstrationReplayability,
  WorkflowDemonstrationScrollEvidence,
  WorkflowDemonstrationStep,
  WorkflowDemonstrationStepKind,
  WorkflowDemonstrationTabContext,
  WorkflowDemonstrationTarget,
  WorkflowDemonstrationTraceEvidence,
  WorkflowDemonstrationValue,
} from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([, item]) => typeof item === 'string') as Array<[string, string]>;
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeViewportRect(raw: unknown): BrowserViewportRect | undefined {
  if (!isRecord(raw)) return undefined;
  const { x, y, left, top, right, bottom, width, height } = raw;
  if (
    typeof x !== 'number'
    || typeof y !== 'number'
    || typeof left !== 'number'
    || typeof top !== 'number'
    || typeof right !== 'number'
    || typeof bottom !== 'number'
    || typeof width !== 'number'
    || typeof height !== 'number'
  ) {
    return undefined;
  }
  return { x, y, left, top, right, bottom, width, height };
}

function normalizeWorkflowDemonstrationTabContext(raw: unknown): WorkflowDemonstrationTabContext | undefined {
  if (!isRecord(raw) || typeof raw.url !== 'string') return undefined;
  return {
    url: raw.url,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    tabId: typeof raw.tabId === 'number' ? raw.tabId : undefined,
  };
}

function normalizeBrowElementSignature(raw: unknown): BrowElementSignature | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.role !== 'string' || typeof raw.name !== 'string' || typeof raw.tagName !== 'string') {
    return undefined;
  }
  return {
    role: raw.role,
    name: raw.name,
    text: typeof raw.text === 'string' ? raw.text : undefined,
    tagName: raw.tagName,
    type: typeof raw.type === 'string' ? raw.type : undefined,
    selector: typeof raw.selector === 'string' ? raw.selector : undefined,
    attributes: normalizeStringRecord(raw.attributes),
  };
}

function normalizeWorkflowDemonstrationTarget(raw: unknown): WorkflowDemonstrationTarget | undefined {
  if (!isRecord(raw)) return undefined;
  const signature = normalizeBrowElementSignature(raw.signature);
  if (!signature) return undefined;
  return {
    signature,
    observedRef: typeof raw.observedRef === 'string' ? raw.observedRef : undefined,
    selector: typeof raw.selector === 'string' ? raw.selector : undefined,
    snapshotId: typeof raw.snapshotId === 'string' ? raw.snapshotId : undefined,
    framePath: normalizeStringArray(raw.framePath),
    shadowPath: normalizeStringArray(raw.shadowPath),
  };
}

function normalizeWorkflowDemonstrationValue(raw: unknown): WorkflowDemonstrationValue | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.captureMode !== 'redacted' && raw.captureMode !== 'literal' && raw.captureMode !== 'omitted') {
    return undefined;
  }
  return {
    captureMode: raw.captureMode,
    text: typeof raw.text === 'string' ? raw.text : undefined,
  };
}

function normalizeWorkflowDemonstrationPointer(raw: unknown): WorkflowDemonstrationPointer | undefined {
  if (!isRecord(raw) || typeof raw.viewportX !== 'number' || typeof raw.viewportY !== 'number') return undefined;
  return {
    viewportX: raw.viewportX,
    viewportY: raw.viewportY,
    targetOffsetX: typeof raw.targetOffsetX === 'number' ? raw.targetOffsetX : undefined,
    targetOffsetY: typeof raw.targetOffsetY === 'number' ? raw.targetOffsetY : undefined,
    targetPercentX: typeof raw.targetPercentX === 'number' ? raw.targetPercentX : undefined,
    targetPercentY: typeof raw.targetPercentY === 'number' ? raw.targetPercentY : undefined,
    targetBounds: normalizeViewportRect(raw.targetBounds),
  };
}

function normalizeWorkflowDemonstrationPointerSamples(raw: unknown): WorkflowDemonstrationPointerSample[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const samples = raw
    .map((item): WorkflowDemonstrationPointerSample | undefined => {
      if (!isRecord(item) || typeof item.viewportX !== 'number' || typeof item.viewportY !== 'number') return undefined;
      return {
        viewportX: item.viewportX,
        viewportY: item.viewportY,
        elapsedMs: typeof item.elapsedMs === 'number' ? item.elapsedMs : undefined,
      };
    })
    .filter((item): item is WorkflowDemonstrationPointerSample => Boolean(item));
  return samples.length > 0 ? samples : undefined;
}

function normalizeWorkflowDemonstrationKeyboard(raw: unknown): WorkflowDemonstrationKeyboardEvidence | undefined {
  if (!isRecord(raw) || typeof raw.key !== 'string') return undefined;
  return {
    key: raw.key,
    code: typeof raw.code === 'string' ? raw.code : undefined,
    altKey: typeof raw.altKey === 'boolean' ? raw.altKey : undefined,
    ctrlKey: typeof raw.ctrlKey === 'boolean' ? raw.ctrlKey : undefined,
    metaKey: typeof raw.metaKey === 'boolean' ? raw.metaKey : undefined,
    shiftKey: typeof raw.shiftKey === 'boolean' ? raw.shiftKey : undefined,
  };
}

function normalizeWorkflowDemonstrationScroll(raw: unknown): WorkflowDemonstrationScrollEvidence | undefined {
  if (!isRecord(raw) || typeof raw.deltaX !== 'number' || typeof raw.deltaY !== 'number') return undefined;
  return {
    deltaX: raw.deltaX,
    deltaY: raw.deltaY,
    scrollXBefore: typeof raw.scrollXBefore === 'number' ? raw.scrollXBefore : 0,
    scrollYBefore: typeof raw.scrollYBefore === 'number' ? raw.scrollYBefore : 0,
    scrollXAfter: typeof raw.scrollXAfter === 'number' ? raw.scrollXAfter : undefined,
    scrollYAfter: typeof raw.scrollYAfter === 'number' ? raw.scrollYAfter : undefined,
  };
}

function normalizeWorkflowDemonstrationTrace(raw: unknown): WorkflowDemonstrationTraceEvidence | undefined {
  if (!isRecord(raw)) return undefined;
  const trace: WorkflowDemonstrationTraceEvidence = {
    urlBefore: typeof raw.urlBefore === 'string' ? raw.urlBefore : undefined,
    urlAfter: typeof raw.urlAfter === 'string' ? raw.urlAfter : undefined,
    titleBefore: typeof raw.titleBefore === 'string' ? raw.titleBefore : undefined,
    titleAfter: typeof raw.titleAfter === 'string' ? raw.titleAfter : undefined,
    pointerPath: normalizeWorkflowDemonstrationPointerSamples(raw.pointerPath),
    keyboard: normalizeWorkflowDemonstrationKeyboard(raw.keyboard),
    scroll: normalizeWorkflowDemonstrationScroll(raw.scroll),
    successSignal: typeof raw.successSignal === 'string' ? raw.successSignal : undefined,
  };
  return Object.values(trace).some((value) => value !== undefined) ? trace : undefined;
}

function normalizeWorkflowDemonstrationStepKind(raw: unknown): WorkflowDemonstrationStepKind | undefined {
  switch (raw) {
    case 'click':
    case 'type':
    case 'key':
    case 'shortcut':
    case 'fill':
    case 'toggle':
    case 'select':
    case 'submit':
    case 'scroll':
    case 'wait':
    case 'navigate':
    case 'drag':
    case 'download':
    case 'dialog':
    case 'upload':
    case 'picker':
    case 'manual':
      return raw;
    default:
      return undefined;
  }
}

function normalizeWorkflowDemonstrationReplayability(raw: unknown): WorkflowDemonstrationReplayability | undefined {
  if (raw === 'replayable' || raw === 'manual' || raw === 'unsupported') return raw;
  return undefined;
}

function normalizeWorkflowDemonstrationStep(raw: unknown): WorkflowDemonstrationStep | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = normalizeWorkflowDemonstrationStepKind(raw.kind);
  const replayability = normalizeWorkflowDemonstrationReplayability(raw.replayability);
  const tab = normalizeWorkflowDemonstrationTabContext(raw.tab);
  if (!kind || !replayability || !tab || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.startedAt !== 'number') {
    return undefined;
  }

  return {
    id: raw.id,
    kind,
    title: raw.title,
    replayability,
    tab,
    target: normalizeWorkflowDemonstrationTarget(raw.target),
    destination: normalizeWorkflowDemonstrationTarget(raw.destination),
    pointer: normalizeWorkflowDemonstrationPointer(raw.pointer),
    pointerPath: normalizeWorkflowDemonstrationPointerSamples(raw.pointerPath),
    trace: normalizeWorkflowDemonstrationTrace(raw.trace),
    value: normalizeWorkflowDemonstrationValue(raw.value),
    note: typeof raw.note === 'string' ? raw.note : undefined,
    startedAt: raw.startedAt,
    completedAt: typeof raw.completedAt === 'number' ? raw.completedAt : undefined,
  };
}

export function normalizeWorkflowDemonstration(raw: unknown): WorkflowDemonstration | undefined {
  if (!isRecord(raw)) return undefined;
  const demonstratedTab = normalizeWorkflowDemonstrationTabContext(raw.demonstratedTab);
  if (!demonstratedTab || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.createdAt !== 'number' || typeof raw.updatedAt !== 'number' || !Array.isArray(raw.steps)) {
    return undefined;
  }

  return {
    id: raw.id,
    title: raw.title,
    note: typeof raw.note === 'string' ? raw.note : undefined,
    demonstratedTab,
    steps: raw.steps
      .map((step) => normalizeWorkflowDemonstrationStep(step))
      .filter((step): step is WorkflowDemonstration['steps'][number] => Boolean(step)),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}