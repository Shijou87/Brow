export function getBlockedPageExecutionError(context: string): string {
  return `${context} timed out, likely because a native browser alert/confirm/prompt is open. MV3 cannot continue until the dialog is closed; use the local helper backend to handle native dialogs.`;
}

const PAGE_AUTOMATION_RUNTIME_SCRIPT_FILE = 'page-automation-runtime.js';

export async function executeScriptWithTimeout<Result>(
  details: Parameters<typeof chrome.scripting.executeScript>[0],
  timeoutMs: number,
  timeoutError: string,
): Promise<chrome.scripting.InjectionResult<Result>[]> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      chrome.scripting.executeScript(details) as Promise<chrome.scripting.InjectionResult<Result>[]>,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export async function ensurePageAutomationRuntimeInjected(
  tabId: number,
  timeoutMs = 1200,
): Promise<void> {
  await executeScriptWithTimeout(
    {
      target: { tabId },
      files: [PAGE_AUTOMATION_RUNTIME_SCRIPT_FILE],
    },
    timeoutMs,
    getBlockedPageExecutionError('Page automation runtime injection'),
  );
}
