import type {
  WorkflowRecordingStartResult,
  WorkflowRecordingStatusResult,
  WorkflowRecordingStopResult,
} from '../../shared/messages';

export async function workflowRecordingStart(
  tabId: number,
  options: { title?: string; captureTypedValues?: boolean } = {},
): Promise<WorkflowRecordingStartResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'WORKFLOW_RECORDING_START', payload: { tabId, ...options } },
      (response) => {
        resolve(response ?? {
          ok: false,
          active: false,
          stepCount: 0,
          page: { url: '', title: '' },
          error: 'No response',
        });
      },
    );
  });
}

export async function workflowRecordingStop(tabId: number): Promise<WorkflowRecordingStopResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'WORKFLOW_RECORDING_STOP', payload: { tabId } },
      (response) => {
        resolve(response ?? { ok: false, active: false, error: 'No response' });
      },
    );
  });
}

export async function workflowRecordingStatus(tabId: number): Promise<WorkflowRecordingStatusResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'WORKFLOW_RECORDING_STATUS', payload: { tabId } },
      (response) => {
        resolve(response ?? {
          ok: false,
          active: false,
          stepCount: 0,
          page: { url: '', title: '' },
          error: 'No response',
        });
      },
    );
  });
}