import type {
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
} from '../shared/types';
import type {
  WorkflowRecordingStartResult,
  WorkflowRecordingStatusResult,
  WorkflowRecordingStopResult,
} from '../shared/messages';
import { StepBuilder, type WorkflowRawValueInput } from '../shared/workflow-demonstration';

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
  builder: StepBuilder;
}

export interface WorkflowDemonstrationRecorder {
  start: (options?: RecorderStartOptions) => WorkflowRecordingStartResult;
  stop: () => WorkflowRecordingStopResult;
  getStatus: () => WorkflowRecordingStatusResult;
}

const TEXT_INPUT_TYPES = new Set(['', 'email', 'number', 'search', 'tel', 'text', 'url']);
const PICKER_INPUT_TYPES = new Set(['color', 'date', 'datetime-local', 'month', 'time', 'week']);
const INTERACTIVE_TAG_NAMES = new Set(['a', 'button', 'canvas', 'form', 'input', 'label', 'option', 'select', 'summary', 'textarea']);
const GENERIC_CONTAINER_TAG_NAMES = new Set(['div', 'g', 'path', 'span', 'svg']);

function cleanInlineText(value: string | null | undefined, max = 160): string | undefined {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stableId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

function escapeSelectorValue(value: string): string {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function canUseHashIdSelector(value: string): boolean {
  return /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(value);
}

function buildIdSelector(value: string): string {
  return canUseHashIdSelector(value)
    ? `#${escapeSelectorValue(value)}`
    : `[id="${escapeAttributeValue(value)}"]`;
}

function isUniqueSelectorFor(selector: string, element: Element): boolean {
  try {
    const matches = Array.from(element.ownerDocument.querySelectorAll(selector));
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
}

function buildDomPathSelector(element: Element): string | undefined {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== current.ownerDocument.body && parts.length < 7) {
    const tagName = current.tagName.toLowerCase();
    const parent = current.parentElement;
    let part = tagName;

    if (current.id) {
      const idSelector = buildIdSelector(current.id);
      const anchoredSelector = parts.length > 0 ? `${idSelector} > ${parts.join(' > ')}` : idSelector;
      if (isUniqueSelectorFor(anchoredSelector, element)) return anchoredSelector;
    }

    if (parent) {
      const sameTagSiblings = (Array.from(parent.children) as Element[])
        .filter((sibling) => sibling.tagName === current!.tagName);
      if (sameTagSiblings.length > 1) {
        part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
      }
    }

    parts.unshift(part);
    const candidate = parts.join(' > ');
    if (isUniqueSelectorFor(candidate, element)) return candidate;
    current = parent;
  }

  return parts.length > 0 ? parts.join(' > ') : undefined;
}

function buildSelector(element: Element): string | undefined {
  const tagName = element.tagName.toLowerCase();

  if (element.id) {
    const selector = buildIdSelector(element.id);
    if (isUniqueSelectorFor(selector, element)) return selector;
  }

  const dataTestId = element.getAttribute('data-testid') ?? element.getAttribute('data-test');
  if (dataTestId) {
    for (const attrName of ['data-testid', 'data-test']) {
      const value = element.getAttribute(attrName);
      if (!value) continue;
      const selector = `[${attrName}="${escapeAttributeValue(value)}"]`;
      if (isUniqueSelectorFor(selector, element)) return selector;
      const tagSelector = `${tagName}${selector}`;
      if (isUniqueSelectorFor(tagSelector, element)) return tagSelector;
    }
  }

  const name = element.getAttribute('name');
  if (name) {
    const selector = `${tagName}[name="${escapeAttributeValue(name)}"]`;
    if (isUniqueSelectorFor(selector, element)) return selector;
  }

  for (const attrName of ['aria-label', 'placeholder', 'title', 'alt']) {
    const value = element.getAttribute(attrName);
    if (!value) continue;
    const selector = `${tagName}[${attrName}="${escapeAttributeValue(value)}"]`;
    if (isUniqueSelectorFor(selector, element)) return selector;
  }

  const classes = Array.from(element.classList).slice(0, 2);
  if (classes.length > 0) {
    const selector = `${tagName}.${classes.map((item) => escapeSelectorValue(item)).join('.')}`;
    if (isUniqueSelectorFor(selector, element)) return selector;
  }

  return buildDomPathSelector(element) ?? tagName;
}

function inferRole(element: Element): string {
  const explicitRole = cleanInlineText(element.getAttribute('role'));
  if (explicitRole) return explicitRole;

  const tagName = element.tagName.toLowerCase();
  if (tagName === 'button') return 'button';
  if (tagName === 'a' && (element as HTMLAnchorElement).href) return 'link';
  if (tagName === 'select') return 'combobox';
  if (tagName === 'textarea') return 'textbox';
  if (tagName === 'form') return 'form';
  if (tagName === 'canvas') return 'region';
  if (tagName === 'summary') return 'button';

  if (tagName === 'input') {
    const type = (element as HTMLInputElement).type.toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    if (type === 'file') return 'button';
    return 'textbox';
  }

  if ((element as HTMLElement).isContentEditable) return 'textbox';
  return 'region';
}

function trackedAttributes(element: Element): Record<string, string> | undefined {
  const names = ['id', 'data-testid', 'data-test', 'aria-label', 'name', 'placeholder', 'title', 'alt'];
  const entries = names
    .map((name) => [name, element.getAttribute(name)] as const)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function labelTextForControl(element: Element): string | undefined {
  if (
    element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement
  ) {
    const labelText = Array.from(element.labels ?? [])
      .map((label) => label.textContent ?? '')
      .join(' ');
    return cleanInlineText(labelText, 120);
  }
  return undefined;
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

function defaultTitleForSession(): string {
  const hostname = (() => {
    try {
      return new URL(location.href).hostname.replace(/^www\./, '');
    } catch {
      return location.hostname || 'current page';
    }
  })();
  return `Workflow demonstration on ${hostname}`;
}

export function createWorkflowDemonstrationRecorder(): WorkflowDemonstrationRecorder {
  let session: RecorderSession | null = null;

  const getCurrentTabContext = (tabId = session?.tabId) => currentTabContext(tabId);

  const handleClick = (event: MouseEvent) => {
    if (!session || event.button !== 0) return;
    const element = resolveElementTarget(event.target, event.composedPath());
    if (!element) return;
    if (element instanceof HTMLInputElement && element.type.toLowerCase() === 'file') return;
    session.builder.addEvent({
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
    session.builder.addEvent({
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
    session.builder.addEvent({
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
    session.builder.addEvent({
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
    session.builder.addEvent({
      kind: 'keydown',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
      target: element ? workflowTargetFromElement(element) : undefined,
      keyboard: keyboardEvidenceFromEvent(event),
    });
  };

  const handleScroll = () => {
    if (!session) return;
    session.builder.addEvent({
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
    session.builder.addEvent({
      kind: 'dragstart',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
      target: workflowTargetFromElement(element),
      pointerSample: pointerSampleFromMouseEvent(event),
    });
  };

  const handleDragOver = (event: DragEvent) => {
    if (!session) return;
    session.builder.addEvent({
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
    session.builder.addEvent({
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
    session.builder.addEvent({
      kind: 'navigation',
      timestamp: Date.now(),
      tab: getCurrentTabContext(),
    });
  };

  const attachListeners = () => {
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
  };

  const detachListeners = () => {
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
  };

  const getStatus = (): WorkflowRecordingStatusResult => ({
    ok: true,
    active: Boolean(session),
    workflowDemonstrationId: session?.id,
    stepCount: session?.builder.getStepCount() ?? 0,
    page: getCurrentTabContext(),
    startedAt: session?.startedAt,
  });

  return {
    start(options) {
      if (session) return getStatus();
      const tabContext = currentTabContext(options?.tabId);
      session = {
        id: stableId('workflow-demonstration'),
        title: cleanInlineText(options?.title, 120),
        tabId: options?.tabId,
        startedAt: Date.now(),
        builder: new StepBuilder(tabContext, { captureTypedValues: options?.captureTypedValues !== false }),
      };
      attachListeners();
      return getStatus();
    },
    stop() {
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
    getStatus,
  };
}
