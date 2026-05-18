import type {
  BrowserSnapshotOperation,
  BrowserSnapshotOperationResult,
  WebMCPDiscoveryResult,
  WebMCPRegistryEntry,
  WorkflowDemonstration,
  WorkflowRecordingStoredSession,
  WorkflowDemonstrationTabContext,
} from './types';

export type RuntimeMessageType =
  | 'GET_REGISTRY'
  | 'FORCE_DISCOVER'
  | 'DISCOVER_ALL'
  | 'WEBMCP_DISCOVER'
  | 'WEBMCP_INVOKE'
  | 'WEBMCP_REGISTRY_UPDATE'
  | 'BROWSER_SNAPSHOT_OPERATION'
  | 'WORKFLOW_RECORDING_START'
  | 'WORKFLOW_RECORDING_STOP'
  | 'WORKFLOW_RECORDING_STATUS'
  | 'WORKFLOW_RECORDING_RESTORE'
  | 'WORKFLOW_RECORDING_PERSIST'
  | 'WORKFLOW_RECORDING_CLEAR';

interface BaseRuntimeMessage<T extends RuntimeMessageType, P = undefined> {
  type: T;
  payload: P;
}

export type GetRegistryMessage = {
  type: 'GET_REGISTRY';
};

export type ForceDiscoverMessage = BaseRuntimeMessage<'FORCE_DISCOVER', { tabId: number }>;

export type DiscoverAllMessage = {
  type: 'DISCOVER_ALL';
};

export type WebMCPDiscoverMessage = {
  type: 'WEBMCP_DISCOVER';
};

export type WebMCPInvokeMessage = BaseRuntimeMessage<'WEBMCP_INVOKE', {
  tabId: number;
  toolName: string;
  args: Record<string, unknown>;
}>;

export type WebMCPRegistryUpdateMessage = BaseRuntimeMessage<'WEBMCP_REGISTRY_UPDATE', {
  tabId: number;
  entry: WebMCPRegistryEntry;
}>;

export type BrowserSnapshotOperationMessage = BaseRuntimeMessage<'BROWSER_SNAPSHOT_OPERATION', {
  tabId: number;
  operation: BrowserSnapshotOperation;
}>;

export type WorkflowRecordingStartMessage = BaseRuntimeMessage<'WORKFLOW_RECORDING_START', {
  tabId: number;
  title?: string;
  captureTypedValues?: boolean;
}>;

export type WorkflowRecordingStopMessage = BaseRuntimeMessage<'WORKFLOW_RECORDING_STOP', {
  tabId: number;
}>;

export type WorkflowRecordingStatusMessage = BaseRuntimeMessage<'WORKFLOW_RECORDING_STATUS', {
  tabId: number;
}>;

export type WorkflowRecordingRestoreMessage = {
  type: 'WORKFLOW_RECORDING_RESTORE';
};

export type WorkflowRecordingPersistMessage = BaseRuntimeMessage<'WORKFLOW_RECORDING_PERSIST', {
  session: WorkflowRecordingStoredSession;
}>;

export type WorkflowRecordingClearMessage = {
  type: 'WORKFLOW_RECORDING_CLEAR';
};

export interface WebMCPInvokeResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BrowserSnapshotOperationMessageResult {
  ok: boolean;
  result?: BrowserSnapshotOperationResult;
  error?: string;
}

export interface WorkflowRecordingState {
  active: boolean;
  workflowDemonstrationId?: string;
  stepCount: number;
  page: WorkflowDemonstrationTabContext;
  startedAt?: number;
}

export interface WorkflowRecordingStatusResult extends WorkflowRecordingState {
  ok: boolean;
  error?: string;
}

export interface WorkflowRecordingStartResult extends WorkflowRecordingStatusResult {}

export interface WorkflowRecordingStopResult {
  ok: boolean;
  active: boolean;
  workflowDemonstration?: WorkflowDemonstration;
  error?: string;
}

export interface WorkflowRecordingRestoreResult {
  ok: boolean;
  active: boolean;
  session?: WorkflowRecordingStoredSession;
  error?: string;
}

export interface WorkflowRecordingPersistResult {
  ok: boolean;
  error?: string;
}

export type RuntimeMessage =
  | GetRegistryMessage
  | ForceDiscoverMessage
  | DiscoverAllMessage
  | WebMCPDiscoverMessage
  | WebMCPInvokeMessage
  | WebMCPRegistryUpdateMessage
  | BrowserSnapshotOperationMessage
  | WorkflowRecordingStartMessage
  | WorkflowRecordingStopMessage
  | WorkflowRecordingStatusMessage
  | WorkflowRecordingRestoreMessage
  | WorkflowRecordingPersistMessage
  | WorkflowRecordingClearMessage;

export function isRuntimeMessageType<T extends RuntimeMessageType>(
  message: unknown,
  type: T,
): message is Extract<RuntimeMessage, { type: T }> {
  return Boolean(message) && typeof message === 'object' && (message as RuntimeMessage).type === type;
}

export function createWebMCPRegistryUpdateMessage(
  tabId: number,
  entry: WebMCPRegistryEntry,
): WebMCPRegistryUpdateMessage {
  return {
    type: 'WEBMCP_REGISTRY_UPDATE',
    payload: { tabId, entry },
  };
}

export function toWebMCPDiscoveryResult(
  entry: WebMCPRegistryEntry,
  tabId: number,
): WebMCPDiscoveryResult {
  return {
    available: entry.available,
    tools: entry.tools,
    page: { url: entry.url, title: entry.title },
    tabId,
  };
}
