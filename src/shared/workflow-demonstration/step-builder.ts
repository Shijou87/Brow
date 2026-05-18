import type {
  WorkflowDemonstration,
  WorkflowDemonstrationPointerSample,
  WorkflowDemonstrationReplayability,
  WorkflowDemonstrationScrollEvidence,
  WorkflowDemonstrationStep,
  WorkflowDemonstrationTabContext,
  WorkflowDemonstrationTarget,
  WorkflowDemonstrationTraceEvidence,
  WorkflowDemonstrationValue,
} from '../types';
import type {
  StepBuilderBuildParams,
  StepBuilderOptions,
  WorkflowRawEvent,
  WorkflowRawValueInput,
  WorkflowStepBuilder,
} from './types';
import { resolveWorkflowValueCapture } from './value-capture';

const TEXT_MERGE_WINDOW_MS = 1500;
const SCROLL_MERGE_WINDOW_MS = 700;
const MAX_DRAG_POINTER_SAMPLES = 24;
const PICKER_INPUT_TYPES = new Set(['color', 'date', 'datetime-local', 'month', 'time', 'week']);
const TEXT_INPUT_TYPES = new Set(['', 'email', 'number', 'search', 'tel', 'text', 'url']);

interface PendingDragState {
  startedAt: number;
  tab: WorkflowDemonstrationTabContext;
  target: WorkflowDemonstrationTarget;
  label: string;
  pointerPath: WorkflowDemonstrationPointerSample[];
}

interface LastScrollState extends WorkflowDemonstrationScrollEvidence {
  recordedAt: number;
}

function stableId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanInlineText(value: string | null | undefined, max = 160): string | undefined {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describeTarget(target: WorkflowDemonstrationTarget | undefined): string {
  if (!target) return 'element';
  const name = cleanInlineText(target.signature.name, 96);
  const role = cleanInlineText(target.signature.role, 40);
  const tagName = cleanInlineText(target.signature.tagName, 40);

  if (name && name !== tagName) {
    if (role && role !== 'region' && role !== tagName) return `"${name}" ${role}`;
    if (tagName && !['div', 'g', 'path', 'span', 'svg'].includes(tagName)) return `"${name}" ${tagName}`;
    return `"${name}"`;
  }

  return target.signature.selector || tagName || 'element';
}

function sameTarget(left: WorkflowDemonstrationTarget | undefined, right: WorkflowDemonstrationTarget | undefined): boolean {
  if (!left || !right) return false;
  if (left.selector && right.selector) return left.selector === right.selector;
  return left.signature.role === right.signature.role
    && left.signature.name === right.signature.name
    && left.signature.tagName === right.signature.tagName;
}

function withElapsedMs(sample: WorkflowDemonstrationPointerSample, startedAt: number, now: number): WorkflowDemonstrationPointerSample {
  return {
    viewportX: sample.viewportX,
    viewportY: sample.viewportY,
    elapsedMs: sample.elapsedMs ?? Math.max(0, now - startedAt),
  };
}

function omittedValueNote(rawValue: WorkflowRawValueInput): string | undefined {
  const inputType = (rawValue.inputType ?? '').trim().toLowerCase();
  if (inputType === 'password') return 'Password value omitted from recording.';
  if (inputType === 'file') return 'File selection omitted from recording.';
  if (PICKER_INPUT_TYPES.has(inputType)) return 'Picker value omitted from recording.';
  return 'Sensitive value omitted from recording.';
}

function isTextEntryValue(rawValue: WorkflowRawValueInput): boolean {
  const inputType = (rawValue.inputType ?? '').trim().toLowerCase();
  return rawValue.elementTag === 'textarea'
    || rawValue.isContentEditable === true
    || (rawValue.elementTag === 'input' && (inputType === 'password' || TEXT_INPUT_TYPES.has(inputType)));
}

export class StepBuilder implements WorkflowStepBuilder {
  private readonly options: StepBuilderOptions;

  private readonly steps: WorkflowDemonstrationStep[];

  private lastTab: WorkflowDemonstrationTabContext;

  private pendingDrag: PendingDragState | undefined;

  private lastScroll: LastScrollState | undefined;

  constructor(
    initialTab: WorkflowDemonstrationTabContext,
    options: StepBuilderOptions = {},
    seed?: {
      steps?: WorkflowDemonstrationStep[];
      lastTab?: WorkflowDemonstrationTabContext;
    },
  ) {
    this.steps = (seed?.steps ?? []).map((step) => ({
      ...step,
      tab: { ...step.tab },
      target: step.target ? { ...step.target, signature: { ...step.target.signature } } : undefined,
      destination: step.destination ? { ...step.destination, signature: { ...step.destination.signature } } : undefined,
      pointer: step.pointer ? { ...step.pointer } : undefined,
      pointerPath: step.pointerPath ? step.pointerPath.map((sample) => ({ ...sample })) : undefined,
      trace: step.trace ? { ...step.trace } : undefined,
      value: step.value ? { ...step.value } : undefined,
    }));
    this.lastTab = seed?.lastTab ? { ...seed.lastTab } : { ...initialTab };
    this.options = options;
  }

  static fromDemonstration(
    demonstration: WorkflowDemonstration,
    options: StepBuilderOptions = {},
  ): StepBuilder {
    const lastStepTab = demonstration.steps[demonstration.steps.length - 1]?.tab;
    return new StepBuilder(demonstration.demonstratedTab, options, {
      steps: demonstration.steps,
      lastTab: lastStepTab ?? demonstration.demonstratedTab,
    });
  }

  addEvent(event: WorkflowRawEvent): void {
    this.recordNavigationIfNeeded(event.tab, event.timestamp);

    switch (event.kind) {
      case 'click':
        this.appendActionStep({
          kind: 'click',
          title: `Click ${describeTarget(event.target)}`,
          replayability: 'replayable',
          target: event.target,
          pointer: event.pointer,
          tab: event.tab,
          startedAt: event.timestamp,
          completedAt: event.timestamp,
        });
        return;
      case 'input':
        this.handleInputEvent(event.target, event.value, event.tab, event.timestamp);
        return;
      case 'change':
        this.handleChangeEvent(event.target, event.value, event.tab, event.timestamp);
        return;
      case 'keydown': {
        const isShortcut = Boolean(
          event.keyboard.altKey
            || event.keyboard.ctrlKey
            || event.keyboard.metaKey,
        );
        this.appendActionStep({
          kind: isShortcut ? 'shortcut' : 'key',
          title: `${isShortcut ? 'Use shortcut' : 'Press key'} ${event.keyboard.key}`,
          replayability: 'replayable',
          target: event.target,
          tab: event.tab,
          trace: { keyboard: event.keyboard },
          startedAt: event.timestamp,
          completedAt: event.timestamp,
        });
        return;
      }
      case 'scroll':
        this.handleScrollEvent(event.tab, event.timestamp, event.scroll.scrollX, event.scroll.scrollY);
        return;
      case 'dragstart':
        this.pendingDrag = {
          startedAt: event.timestamp,
          tab: event.tab,
          target: event.target,
          label: describeTarget(event.target),
          pointerPath: [withElapsedMs(event.pointerSample, event.timestamp, event.timestamp)],
        };
        return;
      case 'dragover':
        if (!this.pendingDrag || this.pendingDrag.pointerPath.length >= MAX_DRAG_POINTER_SAMPLES) return;
        this.pendingDrag.pointerPath.push(withElapsedMs(event.pointerSample, this.pendingDrag.startedAt, event.timestamp));
        return;
      case 'drop':
        if (!this.pendingDrag) return;
        this.appendActionStep({
          kind: 'drag',
          title: `Drag ${this.pendingDrag.label} to ${describeTarget(event.destination)}`,
          replayability: 'replayable',
          target: this.pendingDrag.target,
          destination: event.destination,
          pointerPath: [
            ...this.pendingDrag.pointerPath,
            withElapsedMs(event.pointerSample, this.pendingDrag.startedAt, event.timestamp),
          ],
          tab: event.tab,
          startedAt: this.pendingDrag.startedAt,
          completedAt: event.timestamp,
        });
        this.pendingDrag = undefined;
        return;
      case 'dragend':
        this.pendingDrag = undefined;
        return;
      case 'submit':
        this.appendActionStep({
          kind: 'submit',
          title: `Submit ${describeTarget(event.target)}`,
          replayability: 'replayable',
          target: event.target,
          tab: event.tab,
          startedAt: event.timestamp,
          completedAt: event.timestamp,
        });
        return;
      case 'navigation':
        return;
      default:
        return;
    }
  }

  clearPendingDrag(): void {
    this.pendingDrag = undefined;
  }

  getStepCount(): number {
    return this.steps.length;
  }

  build(params: StepBuilderBuildParams): WorkflowDemonstration {
    return {
      id: params.id,
      title: params.title,
      note: params.note,
      demonstratedTab: params.demonstratedTab,
      steps: [...this.steps],
      createdAt: params.createdAt,
      updatedAt: params.updatedAt ?? Date.now(),
    };
  }

  private recordNavigationIfNeeded(tab: WorkflowDemonstrationTabContext, now: number): void {
    if (tab.url === this.lastTab.url && tab.title === this.lastTab.title) return;

    this.steps.push({
      id: stableId('workflow-step'),
      kind: 'navigate',
      title: `Navigate to ${cleanInlineText(tab.title || tab.url, 96) ?? 'page'}`,
      replayability: 'replayable',
      tab,
      startedAt: now,
      completedAt: now,
    });
    this.lastTab = tab;
  }

  private appendActionStep(params: {
    kind: WorkflowDemonstrationStep['kind'];
    title: string;
    replayability: WorkflowDemonstrationReplayability;
    tab: WorkflowDemonstrationTabContext;
    target?: WorkflowDemonstrationTarget;
    destination?: WorkflowDemonstrationTarget;
    pointer?: WorkflowDemonstrationStep['pointer'];
    pointerPath?: WorkflowDemonstrationPointerSample[];
    trace?: WorkflowDemonstrationTraceEvidence;
    value?: WorkflowDemonstrationValue;
    note?: string;
    startedAt: number;
    completedAt: number;
  }): void {
    const trace = {
      urlBefore: this.lastTab.url,
      urlAfter: params.tab.url,
      titleBefore: this.lastTab.title,
      titleAfter: params.tab.title,
      pointerPath: params.pointerPath,
      ...params.trace,
    };

    this.steps.push({
      id: stableId('workflow-step'),
      kind: params.kind,
      title: params.title,
      replayability: params.replayability,
      tab: params.tab,
      target: params.target,
      destination: params.destination,
      pointer: params.pointer,
      pointerPath: params.pointerPath,
      trace,
      value: params.value,
      note: params.note,
      startedAt: params.startedAt,
      completedAt: params.completedAt,
    });
    this.lastTab = params.tab;
  }

  private mergeTextEntry(
    target: WorkflowDemonstrationTarget,
    title: string,
    value: WorkflowDemonstrationValue,
    note: string | undefined,
    replayability: WorkflowDemonstrationReplayability,
    tab: WorkflowDemonstrationTabContext,
    now: number,
  ): boolean {
    const lastStep = this.steps[this.steps.length - 1];
    if (!lastStep || lastStep.kind !== 'type' || !sameTarget(lastStep.target, target)) return false;
    const lastCompletedAt = lastStep.completedAt ?? lastStep.startedAt;
    if (now - lastCompletedAt > TEXT_MERGE_WINDOW_MS) return false;
    lastStep.completedAt = now;
    lastStep.value = value;
    lastStep.note = note;
    lastStep.replayability = replayability;
    lastStep.title = title;
    lastStep.tab = tab;
    this.lastTab = tab;
    return true;
  }

  private handleInputEvent(
    target: WorkflowDemonstrationTarget,
    rawValue: WorkflowRawValueInput,
    tab: WorkflowDemonstrationTabContext,
    now: number,
  ): void {
    const value = resolveWorkflowValueCapture(rawValue, this.options);
    const title = `Type into ${describeTarget(target)}`;
    const replayability = value.captureMode === 'omitted' ? 'manual' : 'replayable';
    const note = value.captureMode === 'omitted' ? omittedValueNote(rawValue) : undefined;

    if (this.mergeTextEntry(target, title, value, note, replayability, tab, now)) return;

    this.appendActionStep({
      kind: 'type',
      title,
      replayability,
      target,
      tab,
      value,
      note,
      startedAt: now,
      completedAt: now,
    });
  }

  private handleChangeEvent(
    target: WorkflowDemonstrationTarget,
    rawValue: WorkflowRawValueInput,
    tab: WorkflowDemonstrationTabContext,
    now: number,
  ): void {
    const inputType = (rawValue.inputType ?? '').trim().toLowerCase();

    if (rawValue.elementTag === 'input' && (inputType === 'checkbox' || inputType === 'radio')) {
      this.appendActionStep({
        kind: 'toggle',
        title: `Toggle ${describeTarget(target)}`,
        replayability: 'replayable',
        target,
        tab,
        value: { captureMode: 'literal', text: rawValue.checked ? 'checked' : 'unchecked' },
        startedAt: now,
        completedAt: now,
      });
      return;
    }

    if (rawValue.elementTag === 'input' && inputType === 'file') {
      this.appendActionStep({
        kind: 'upload',
        title: `Upload file with ${describeTarget(target)}`,
        replayability: 'manual',
        target,
        tab,
        value: { captureMode: 'omitted' },
        startedAt: now,
        completedAt: now,
      });
      return;
    }

    if (rawValue.elementTag === 'input' && PICKER_INPUT_TYPES.has(inputType)) {
      this.appendActionStep({
        kind: 'picker',
        title: `Use picker for ${describeTarget(target)}`,
        replayability: 'manual',
        target,
        tab,
        value: { captureMode: 'omitted' },
        startedAt: now,
        completedAt: now,
      });
      return;
    }

    if (rawValue.elementTag === 'select') {
      this.appendActionStep({
        kind: 'select',
        title: `Select ${describeTarget(target)}`,
        replayability: 'replayable',
        target,
        tab,
        value: resolveWorkflowValueCapture(rawValue, this.options),
        startedAt: now,
        completedAt: now,
      });
      return;
    }

    if (isTextEntryValue(rawValue)) {
      this.handleInputEvent(target, rawValue, tab, now);
    }
  }

  private handleScrollEvent(tab: WorkflowDemonstrationTabContext, now: number, scrollX: number, scrollY: number): void {
    const previous = this.lastScroll;
    const scrollXBefore = previous?.scrollXAfter ?? previous?.scrollXBefore ?? scrollX;
    const scrollYBefore = previous?.scrollYAfter ?? previous?.scrollYBefore ?? scrollY;
    const scroll: LastScrollState = {
      deltaX: scrollX - scrollXBefore,
      deltaY: scrollY - scrollYBefore,
      scrollXBefore,
      scrollYBefore,
      scrollXAfter: scrollX,
      scrollYAfter: scrollY,
      recordedAt: now,
    };
    this.lastScroll = scroll;

    if (Math.abs(scroll.deltaX) < 1 && Math.abs(scroll.deltaY) < 1) return;

    const lastStep = this.steps[this.steps.length - 1];
    if (lastStep?.kind === 'scroll' && now - (lastStep.completedAt ?? lastStep.startedAt) < SCROLL_MERGE_WINDOW_MS) {
      lastStep.completedAt = now;
      lastStep.trace = { ...(lastStep.trace ?? {}), scroll };
      lastStep.title = `Scroll page by ${Math.round(scroll.deltaY)}px`;
      lastStep.tab = tab;
      this.lastTab = tab;
      return;
    }

    this.appendActionStep({
      kind: 'scroll',
      title: `Scroll page by ${Math.round(scroll.deltaY)}px`,
      replayability: 'replayable',
      tab,
      trace: { scroll },
      startedAt: now,
      completedAt: now,
    });
  }
}
