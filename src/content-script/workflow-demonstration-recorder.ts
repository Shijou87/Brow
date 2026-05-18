// ─── Workflow Demonstration Recorder ───────────────────────────────────────
// Captures live DOM interactions and turns them into replay-oriented Brow
// evidence through the shared workflow step-builder pipeline. This module owns
// the translation from page events into targets, pointer traces, keyboard
// evidence, and safe captured values.

import type {
  WorkflowDemonstration,
  WorkflowDemonstrationKeyboardEvidence,
  WorkflowDemonstrationPointer,
  WorkflowDemonstrationPointerSample,
  WorkflowRecordingStoredSession,
  WorkflowDemonstrationReplayability,
  WorkflowDemonstrationScrollEvidence,
  WorkflowDemonstrationStep,
  WorkflowDemonstrationStepKind,
  WorkflowDemonstrationTabContext,
  WorkflowDemonstrationTarget,
  WorkflowDemonstrationTraceEvidence,
  WorkflowDemonstrationValue,
} from '../shared/types';
import type {
  WorkflowRecordingPersistResult,
  WorkflowRecordingRestoreResult,
  WorkflowRecordingStartResult,
  WorkflowRecordingStatusResult,
  WorkflowRecordingStopResult,
} from '../shared/messages';
import {
  normalizeWorkflowDemonstration,
  StepBuilder,
  type WorkflowRawEvent,
  type WorkflowRawValueInput,
} from '../shared/workflow-demonstration';
import {
  buildWorkflowTargetSelector as buildSelector,
  cleanOptionalDomText as cleanInlineText,
  getControlLabelText as labelTextForControl,
  getTrackedElementAttributes as trackedAttributes,
  inferWorkflowTargetRole as inferRole,
} from './dom-evidence';

interface RecorderStartOptions {
  title?: string;
  captureTypedValues?: boolean;
  tabId?: number;
}

interface RecorderSession {
  id: string;
  title?: string;
  tabId?: number;
  startedAt: number;
  captureTypedValues: boolean;
  initialTab: WorkflowDemonstrationTabContext;
  builder: StepBuilder;
}

export interface WorkflowDemonstrationRecorder {
  start: (options?: RecorderStartOptions) => Promise<WorkflowRecordingStartResult>;
  stop: () => Promise<WorkflowRecordingStopResult>;
  getStatus: () => Promise<WorkflowRecordingStatusResult>;
}

const TEXT_INPUT_TYPES = new Set(['', 'email', 'number', 'search', 'tel', 'text', 'url']);
const PICKER_INPUT_TYPES = new Set(['color', 'date', 'datetime-local', 'month', 'time', 'week']);
const INTERACTIVE_TAG_NAMES = new Set(['a', 'button', 'canvas', 'form', 'input', 'label', 'option', 'select', 'summary', 'textarea']);
const GENERIC_CONTAINER_TAG_NAMES = new Set(['div', 'g', 'path', 'span', 'svg']);

function stableId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function currentTabContext(tabId?: number): WorkflowDemonstrationTabContext {
  return {
    url: location.href,
    title: document.title || undefined,
    tabId,
  };
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function pointerFromMouseEvent(event: MouseEvent, element: Element): WorkflowDemonstrationPointer {
  const rect = (element as HTMLElement).getBoundingClientRect?.();
  const pointer: WorkflowDemonstrationPointer = {
    viewportX: roundCoordinate(event.clientX),
    viewportY: roundCoordinate(event.clientY),
  };

  if (rect && rect.width > 0 && rect.height > 0) {
    const targetOffsetX = event.clientX - rect.left;
    const targetOffsetY = event.clientY - rect.top;
    pointer.targetOffsetX = roundCoordinate(targetOffsetX);
    pointer.targetOffsetY = roundCoordinate(targetOffsetY);
    pointer.targetPercentX = roundCoordinate(targetOffsetX / rect.width);
    pointer.targetPercentY = roundCoordinate(targetOffsetY / rect.height);
    pointer.targetBounds = {
      x: roundCoordinate(rect.left),
      y: roundCoordinate(rect.top),
      left: roundCoordinate(rect.left),
      top: roundCoordinate(rect.top),
      right: roundCoordinate(rect.right),
      bottom: roundCoordinate(rect.bottom),
      width: roundCoordinate(rect.width),
      height: roundCoordinate(rect.height),
    };
  }

  return pointer;
}

function pointerSampleFromMouseEvent(event: MouseEvent, startedAt?: number): WorkflowDemonstrationPointerSample {
  const sample: WorkflowDemonstrationPointerSample = {
    viewportX: roundCoordinate(event.clientX),
    viewportY: roundCoordinate(event.clientY),
  };
  if (typeof startedAt === 'number') {
    sample.elapsedMs = Math.max(0, Date.now() - startedAt);
  }
  return sample;
}

function keyboardEvidenceFromEvent(event: KeyboardEvent): WorkflowDemonstrationKeyboardEvidence {
  return {
    key: event.key,
    code: event.code || undefined,
    altKey: event.altKey || undefined,
    ctrlKey: event.ctrlKey || undefined,
    metaKey: event.metaKey || undefined,
    shiftKey: event.shiftKey || undefined,
  };
}

function directElementName(element: Element, max = 120): string | undefined {
  const inputValue = element instanceof HTMLInputElement
    ? (() => {
        const type = element.type.toLowerCase();
        if (type === 'button' || type === 'submit' || type === 'reset') return element.value;
        return undefined;
      })()
    : undefined;
  const selectValue = element instanceof HTMLSelectElement
    ? element.selectedOptions[0]?.textContent ?? element.value
    : undefined;
  const textContent = (
    element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement
  )
    ? undefined
    : element.textContent;

  return cleanInlineText(
    element.getAttribute('aria-label')
      ?? element.getAttribute('title')
      ?? element.getAttribute('placeholder')
      ?? element.getAttribute('name')
      ?? labelTextForControl(element)
      ?? inputValue
      ?? selectValue
      ?? textContent,
    max,
  );
}

function findAncestorElementName(element: Element): string | undefined {
  let current = element.parentElement;
  let depth = 0;

  while (current && depth < 4) {
    const name = directElementName(current, depth === 0 ? 120 : 80);
    if (name && name !== current.tagName.toLowerCase()) return name;
    current = current.parentElement;
    depth += 1;
  }

  return undefined;
}

function hasDirectMeaningfulName(element: Element): boolean {
  const name = directElementName(element);
  return Boolean(name && name !== element.tagName.toLowerCase());
}

function elementText(element: Element): string | undefined {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return undefined;
  }
  return cleanInlineText(element.textContent, 120) ?? findAncestorElementName(element);
}

function elementName(element: Element): string {
  return directElementName(element, 120)
    ?? findAncestorElementName(element)
    ?? element.tagName.toLowerCase();
}

function hasMeaningfulName(element: Element): boolean {
  const name = elementName(element);
  return Boolean(name && name !== element.tagName.toLowerCase());
}

function isLikelyInteractiveElement(element: Element): boolean {
  if (INTERACTIVE_TAG_NAMES.has(element.tagName.toLowerCase())) return true;
  if (element.getAttribute('role')) return true;

  const htmlElement = element as HTMLElement;
  return htmlElement.isContentEditable
    || element.getAttribute('draggable') === 'true'
    || htmlElement.tabIndex >= 0
    || typeof htmlElement.onclick === 'function';
}

function workflowTargetFromElement(element: Element): WorkflowDemonstrationTarget {
  return {
    signature: {
      role: inferRole(element),
      name: elementName(element),
      text: elementText(element),
      tagName: element.tagName.toLowerCase(),
      type: element instanceof HTMLInputElement ? cleanInlineText(element.type) : undefined,
      selector: buildSelector(element),
      attributes: trackedAttributes(element),
    },
    selector: buildSelector(element),
    framePath: [],
    shadowPath: [],
  };
}

function describeTarget(target: WorkflowDemonstrationTarget | undefined): string {
  if (!target) return 'element';
  const name = cleanInlineText(target.signature.name, 96);
  const role = cleanInlineText(target.signature.role, 40);
  const tagName = cleanInlineText(target.signature.tagName, 40);

  if (name && name !== tagName) {
    if (role && role !== 'region' && role !== tagName) return `"${name}" ${role}`;
    if (tagName && !GENERIC_CONTAINER_TAG_NAMES.has(tagName)) return `"${name}" ${tagName}`;
    return `"${name}"`;
  }

  return target.signature.selector || tagName || 'element';
}

function resolveElementTarget(target: EventTarget | null, eventPath: EventTarget[] = []): Element | null {
  const pathElements = eventPath.filter((entry): entry is Element => entry instanceof Element);

  for (const element of pathElements) {
    if (isLikelyInteractiveElement(element) && hasDirectMeaningfulName(element)) return element;
  }

  for (const element of pathElements) {
    if (isLikelyInteractiveElement(element) && hasMeaningfulName(element)) return element;
  }

  for (const element of pathElements) {
    if (hasDirectMeaningfulName(element)) return element;
  }

  if (target instanceof Element) {
    return target.closest('button, a, input, textarea, select, option, label, form, [role], [contenteditable="true"], [draggable="true"], canvas, summary') ?? target;
  }

  if (target instanceof Node) {
    return target.parentElement ? resolveElementTarget(target.parentElement) : null;
  }

  return null;
}

function sameTarget(left: WorkflowDemonstrationTarget | undefined, right: WorkflowDemonstrationTarget | undefined): boolean {
  if (!left || !right) return false;
  if (left.selector && right.selector) return left.selector === right.selector;
  return left.signature.role === right.signature.role
    && left.signature.name === right.signature.name
    && left.signature.tagName === right.signature.tagName;
}

function textValueForElement(element: Element, captureTypedValues: boolean): WorkflowDemonstrationValue | undefined {
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === 'password' || type === 'file') return { captureMode: 'omitted' };
    if (PICKER_INPUT_TYPES.has(type)) return { captureMode: 'omitted' };
    if (!captureTypedValues) return { captureMode: 'redacted' };
    return { captureMode: 'literal', text: element.value };
  }

  if (element instanceof HTMLTextAreaElement) {
    if (!captureTypedValues) return { captureMode: 'redacted' };
    return { captureMode: 'literal', text: element.value };
  }

  if ((element as HTMLElement).isContentEditable) {
    if (!captureTypedValues) return { captureMode: 'redacted' };
    return { captureMode: 'literal', text: (element.textContent ?? '').trim() };
  }

  return undefined;
}

function rawValueFromElement(element: Element): WorkflowRawValueInput | undefined {
  const autocomplete = element.getAttribute('autocomplete') ?? undefined;

  if (element instanceof HTMLInputElement) {
    return {
      text: element.value,
      inputType: element.type.toLowerCase(),
      autocomplete,
      elementTag: 'input',
      checked: element.checked,
    };
  }

  if (element instanceof HTMLTextAreaElement) {
    return {
      text: element.value,
      autocomplete,
      elementTag: 'textarea',
    };
  }

  if (element instanceof HTMLSelectElement) {
    return {
      text: element.value,
      autocomplete,
      elementTag: 'select',
    };
  }

  if ((element as HTMLElement).isContentEditable) {
    return {
      text: (element.textContent ?? '').trim(),
      autocomplete,
      elementTag: 'other',
      isContentEditable: true,
    };
  }

  return undefined;
}

function normalizeStoredTabContext(raw: unknown): WorkflowDemonstrationTabContext | undefined {
  if (!isRecord(raw) || typeof raw.url !== 'string') return undefined;
  return {
    url: raw.url,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    tabId: typeof raw.tabId === 'number' ? raw.tabId : undefined,
  };
}

function defaultTitleForSession(url = location.href): string {
  const hostname = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return location.hostname || 'current page';
    }
  })();
  return `Workflow demonstration on ${hostname}`;
}

function normalizeStoredRecorderSession(raw: unknown): RecorderSession | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.startedAt !== 'number') return undefined;
  const initialTab = normalizeStoredTabContext(raw.initialTab);
  const partialDemonstration = normalizeWorkflowDemonstration(raw.partialDemonstration);
  if (!initialTab || !partialDemonstration) return undefined;

  const captureTypedValues = raw.captureTypedValues !== false;
  const tabId = typeof raw.tabId === 'number' ? raw.tabId : initialTab.tabId;

  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    tabId,
    startedAt: raw.startedAt,
    captureTypedValues,
    initialTab,
    builder: StepBuilder.fromDemonstration(partialDemonstration, { captureTypedValues }),
  };
}

function sendRuntimeMessage<Response>(message: unknown, fallback: Response): Promise<Response> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve((response ?? fallback) as Response);
    });
  });
}

/**
 * Creates the page-local recorder used by workflow recording bridge messages
 * to start, stop, and inspect a live capture session.
 */
export function createWorkflowDemonstrationRecorder(): WorkflowDemonstrationRecorder {
  let session: RecorderSession | null = null;
  let listenersAttached = false;

  const getCurrentTabContext = (tabId = session?.tabId) => currentTabContext(tabId);

  const buildStatus = (): WorkflowRecordingStatusResult => ({
    ok: true,
    active: Boolean(session),
    workflowDemonstrationId: session?.id,
    stepCount: session?.builder.getStepCount() ?? 0,
    page: getCurrentTabContext(),
    startedAt: session?.startedAt,
  });

  const persistSession = async (): Promise<void> => {
    const currentSession = session;
    if (!currentSession) return;

    const snapshot: WorkflowRecordingStoredSession = {
      id: currentSession.id,
      title: currentSession.title,
      tabId: currentSession.tabId,
      startedAt: currentSession.startedAt,
      captureTypedValues: currentSession.captureTypedValues,
      initialTab: currentSession.initialTab,
      partialDemonstration: currentSession.builder.build({
        id: currentSession.id,
        title: currentSession.title || defaultTitleForSession(currentSession.initialTab.url),
        demonstratedTab: currentSession.initialTab,
        createdAt: currentSession.startedAt,
        updatedAt: Date.now(),
      }),
    };

    await sendRuntimeMessage<WorkflowRecordingPersistResult>(
      {
        type: 'WORKFLOW_RECORDING_PERSIST',
        payload: { session: snapshot },
      },
      { ok: false, error: 'No response' },
    );
  };

  const clearPersistedSession = async (): Promise<void> => {
    await sendRuntimeMessage<WorkflowRecordingPersistResult>(
      { type: 'WORKFLOW_RECORDING_CLEAR' },
      { ok: false, error: 'No response' },
    );
  };

  const restorePersistedSession = async (): Promise<void> => {
    const result = await sendRuntimeMessage<WorkflowRecordingRestoreResult>(
      { type: 'WORKFLOW_RECORDING_RESTORE' },
      { ok: false, active: false, error: 'No response' },
    );
    if (!result.ok || !result.session) return;

    const restored = normalizeStoredRecorderSession(result.session);
    if (!restored) {
      await clearPersistedSession();
      return;
    }

    session = restored;
    attachListeners();
  };

  const ready = restorePersistedSession();

  const recordEvent = (event: WorkflowRawEvent) => {
    if (!session) return;
    session.builder.addEvent(event);
    void persistSession();
  };

  const handleClick = (event: MouseEvent) => {
    if (!session || event.button !== 0) return;
    const element = resolveElementTarget(event.target, event.composedPath());
    if (!element) return;
    if (element instanceof HTMLInputElement && element.type.toLowerCase() === 'file') return;
    recordEvent({
      kind: 'click',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
      target: workflowTargetFromElement(element),
      pointer: pointerFromMouseEvent(event, element),
    });
  };

  const handleInput = (event: Event) => {
    if (!session) return;
    const element = resolveElementTarget(event.target);
    if (!element) return;
    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();
      if (type !== 'password' && !TEXT_INPUT_TYPES.has(type)) return;
    } else if (!(element instanceof HTMLTextAreaElement) && !(element as HTMLElement).isContentEditable) {
      return;
    }

    const value = rawValueFromElement(element);
    if (!value) return;
    recordEvent({
      kind: 'input',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
      target: workflowTargetFromElement(element),
      value,
    });
  };

  const handleChange = (event: Event) => {
    if (!session) return;
    const element = resolveElementTarget(event.target);
    if (!element) return;
    const value = rawValueFromElement(element);
    if (!value) return;
    recordEvent({
      kind: 'change',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
      target: workflowTargetFromElement(element),
      value,
    });
  };

  const handleSubmit = (event: Event) => {
    if (!session) return;
    const element = resolveElementTarget(event.target);
    if (!element) return;
    recordEvent({
      kind: 'submit',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
      target: workflowTargetFromElement(element),
    });
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (!session) return;
    const target = event.target instanceof Element ? event.target : null;
    const editable = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || Boolean(target && (target as HTMLElement).isContentEditable);
    const isShortcut = event.altKey || event.ctrlKey || event.metaKey;
    const isNavigationKey = [
      'Enter',
      'Escape',
      'Tab',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ].includes(event.key);
    if (editable && !isShortcut && !isNavigationKey) return;

    const element = resolveElementTarget(event.target);
    recordEvent({
      kind: 'keydown',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
      target: element ? workflowTargetFromElement(element) : undefined,
      keyboard: keyboardEvidenceFromEvent(event),
    });
  };

  const handleScroll = () => {
    if (!session) return;
    recordEvent({
      kind: 'scroll',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
      scroll: {
        scrollX: roundCoordinate(window.scrollX),
        scrollY: roundCoordinate(window.scrollY),
      },
    });
  };

  const handleDragStart = (event: DragEvent) => {
    if (!session) return;
    const element = resolveElementTarget(event.target);
    if (!element) return;
    recordEvent({
      kind: 'dragstart',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
      target: workflowTargetFromElement(element),
      pointerSample: pointerSampleFromMouseEvent(event),
    });
  };

  const handleDragOver = (event: DragEvent) => {
    if (!session) return;
    recordEvent({
      kind: 'dragover',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
      pointerSample: pointerSampleFromMouseEvent(event),
    });
  };

  const handleDrop = (event: DragEvent) => {
    if (!session) return;
    const element = resolveElementTarget(event.target);
    if (!element) {
      session.builder.clearPendingDrag();
      return;
    }
    recordEvent({
      kind: 'drop',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
      destination: workflowTargetFromElement(element),
      pointerSample: pointerSampleFromMouseEvent(event),
    });
  };

  const clearDragSource = () => {
    if (!session) return;
    session.builder.clearPendingDrag();
  };

  const handleUrlSignal = () => {
    if (!session) return;
    recordEvent({
      kind: 'navigation',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
    });
  };

  const handlePageHide = () => {
    if (!session) return;
    void persistSession();
  };

  const attachListeners = () => {
    if (listenersAttached) return;
    listenersAttached = true;
    document.addEventListener('click', handleClick, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('submit', handleSubmit, true);
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('dragstart', handleDragStart, true);
    document.addEventListener('dragover', handleDragOver, true);
    document.addEventListener('drop', handleDrop, true);
    document.addEventListener('dragend', clearDragSource, true);
    window.addEventListener('hashchange', handleUrlSignal, true);
    window.addEventListener('popstate', handleUrlSignal, true);
    window.addEventListener('pagehide', handlePageHide, true);
  };

  const detachListeners = () => {
    if (!listenersAttached) return;
    listenersAttached = false;
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleChange, true);
    document.removeEventListener('submit', handleSubmit, true);
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('scroll', handleScroll, true);
    document.removeEventListener('dragstart', handleDragStart, true);
    document.removeEventListener('dragover', handleDragOver, true);
    document.removeEventListener('drop', handleDrop, true);
    document.removeEventListener('dragend', clearDragSource, true);
    window.removeEventListener('hashchange', handleUrlSignal, true);
    window.removeEventListener('popstate', handleUrlSignal, true);
    window.removeEventListener('pagehide', handlePageHide, true);
  };

  return {
    async start(options) {
      await ready;
      if (session) return buildStatus();
      const tabContext = currentTabContext(options?.tabId);
      const captureTypedValues = options?.captureTypedValues !== false;
      session = {
        id: stableId('workflow-demonstration'),
        title: cleanInlineText(options?.title, 120),
        tabId: options?.tabId,
        startedAt: Date.now(),
        captureTypedValues,
        initialTab: tabContext,
        builder: new StepBuilder(tabContext, { captureTypedValues }),
      };
      attachListeners();
      await persistSession();
      return buildStatus();
    },
    async stop() {
      await ready;
      if (!session) {
        return { ok: false, active: false, error: 'No active workflow demonstration recording.' };
      }

      session.builder.addEvent({
        kind: 'navigation',
        timestamp: Date.now(),
        tab: getCurrentTabContext(),
      });
      detachListeners();
      const currentSession = session;
      session = null;
      await clearPersistedSession();
      const workflowDemonstration = currentSession.builder.build({
        id: currentSession.id,
        title: currentSession.title || defaultTitleForSession(),
        demonstratedTab: currentTabContext(currentSession.tabId),
        createdAt: currentSession.startedAt,
        updatedAt: Date.now(),
      });
      return {
        ok: true,
        active: false,
        workflowDemonstration,
      };
    },
    async getStatus() {
      await ready;
      return buildStatus();
    },
  };
}
