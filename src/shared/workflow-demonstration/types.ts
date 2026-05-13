import type {
  WorkflowDemonstration,
  WorkflowDemonstrationKeyboardEvidence,
  WorkflowDemonstrationPointer,
  WorkflowDemonstrationPointerSample,
  WorkflowDemonstrationTabContext,
  WorkflowDemonstrationTarget,
} from '../types';

export interface WorkflowRawValueInput {
  text?: string;
  inputType?: string;
  autocomplete?: string;
  elementTag: 'input' | 'textarea' | 'select' | 'other';
  isContentEditable?: boolean;
  checked?: boolean;
}

export interface WorkflowRawScrollState {
  scrollX: number;
  scrollY: number;
}

export interface StepBuilderOptions {
  captureTypedValues?: boolean;
}

export interface StepBuilderBuildParams {
  id: string;
  title: string;
  note?: string;
  demonstratedTab: WorkflowDemonstrationTabContext;
  createdAt: number;
  updatedAt?: number;
}

interface WorkflowRawEventBase {
  kind: string;
  timestamp: number;
  tab: WorkflowDemonstrationTabContext;
}

export type WorkflowRawEvent =
  | (WorkflowRawEventBase & {
    kind: 'click';
    target: WorkflowDemonstrationTarget;
    pointer?: WorkflowDemonstrationPointer;
  })
  | (WorkflowRawEventBase & {
    kind: 'input';
    target: WorkflowDemonstrationTarget;
    value: WorkflowRawValueInput;
  })
  | (WorkflowRawEventBase & {
    kind: 'change';
    target: WorkflowDemonstrationTarget;
    value: WorkflowRawValueInput;
  })
  | (WorkflowRawEventBase & {
    kind: 'keydown';
    target?: WorkflowDemonstrationTarget;
    keyboard: WorkflowDemonstrationKeyboardEvidence;
  })
  | (WorkflowRawEventBase & {
    kind: 'scroll';
    scroll: WorkflowRawScrollState;
  })
  | (WorkflowRawEventBase & {
    kind: 'dragstart';
    target: WorkflowDemonstrationTarget;
    pointerSample: WorkflowDemonstrationPointerSample;
  })
  | (WorkflowRawEventBase & {
    kind: 'dragover';
    pointerSample: WorkflowDemonstrationPointerSample;
  })
  | (WorkflowRawEventBase & {
    kind: 'drop';
    destination: WorkflowDemonstrationTarget;
    pointerSample: WorkflowDemonstrationPointerSample;
  })
  | (WorkflowRawEventBase & {
    kind: 'dragend';
  })
  | (WorkflowRawEventBase & {
    kind: 'submit';
    target: WorkflowDemonstrationTarget;
  })
  | (WorkflowRawEventBase & {
    kind: 'navigation';
  });

export interface WorkflowStepBuilder {
  addEvent: (event: WorkflowRawEvent) => void;
  clearPendingDrag: () => void;
  getStepCount: () => number;
  build: (params: StepBuilderBuildParams) => WorkflowDemonstration;
}