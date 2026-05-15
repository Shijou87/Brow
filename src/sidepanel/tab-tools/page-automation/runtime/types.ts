import type { BrowserSnapshotElement } from '../../../../shared/types';

export interface BrowserClickPoint {
  origin: 'target' | 'targetFraction' | 'viewport';
  x: number;
  y: number;
}

export interface ClickPoint {
  x: number;
  y: number;
}

export interface VisibleRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export interface ClickPlan {
  target: HTMLElement;
  point: ClickPoint;
  rect: VisibleRect;
  dispatchMode: 'synthetic' | 'programmatic';
}

export type ClickDispatchMode = 'programmatic';
export type CursorFrame = 'hand' | 'push' | 'highlight' | 'pencil';

export interface StoredSnapshot {
  snapshotId: string;
  entriesByRef: Record<string, BrowserSnapshotElement>;
  nodesByRef: Record<string, Element>;
  order: string[];
  createdAt: number;
}

export interface SnapshotState {
  currentSnapshotId?: string;
  snapshots: Record<string, StoredSnapshot>;
  snapshotOrder: string[];
}

export type PageAutomationAction =
  | {
    kind: 'highlight';
    selector: string;
    message?: string;
    durationMs?: number;
  }
  | {
    kind: 'hover';
    selector: string;
    message?: string;
    durationMs?: number;
  }
  | {
    kind: 'click';
    selector: string;
    clickPoint?: BrowserClickPoint;
    clickMode?: ClickDispatchMode;
  }
  | {
    kind: 'drag';
    sourceSelector: string;
    destinationSelector: string;
    sourceClickPoint?: BrowserClickPoint;
    destinationClickPoint?: BrowserClickPoint;
    pointerPath?: ClickPoint[];
    durationMs?: number;
  }
  | {
    kind: 'scroll';
    selector?: string;
    deltaX?: number;
    deltaY?: number;
    top?: number;
    left?: number;
  }
  | {
    kind: 'key';
    selector?: string;
    key?: string;
    code?: string;
    text?: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  }
  | {
    kind: 'upload';
    selector: string;
    fileName?: string;
    filePath?: string;
  }
  | {
    kind: 'handleDialog';
    selector?: string;
    action: 'accept' | 'dismiss' | 'close';
    text?: string;
  }
  | {
    kind: 'type';
    selector: string;
    text: string;
    submit: boolean;
  }
  | {
    kind: 'fillForm';
    fields: Array<{
      selector: string;
      value: string | number | boolean;
      mode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable';
    }>;
    submit: boolean;
    submitSelector?: string;
  };

export interface PageSettlingProbeOptions {
  quietMs?: number;
  timeoutMs?: number;
}

export interface PageSettlingProbeResult {
  ok: boolean;
  readyState: string;
  quietMs: number;
  durationMs: number;
  error?: string;
}

export interface InstalledPageAutomationRuntime {
  runPageAutomationAction(action: PageAutomationAction): Promise<unknown>;
  runPageSettlingProbe(options?: PageSettlingProbeOptions): Promise<PageSettlingProbeResult>;
}

export const PAGE_AUTOMATION_RUNTIME_GLOBAL_KEY = '__browPageAutomationRuntime__';

