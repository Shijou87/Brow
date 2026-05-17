import { ensureTabIsActive } from '../tabs';
import type { BrowAutomationBackend } from '../../../shared/types';
import { loadSidepanelConfig } from '../../../shared/storage';
import {
  runPageAutomationAction,
  type BrowserClickPoint,
  type ClickDispatchMode,
  type PageAutomationAction,
  type PageAutomationVisualSettings,
} from './injected-action-runtime';
import {
  ensurePageAutomationRuntimeInjected,
  executeScriptWithTimeout,
  getBlockedPageExecutionError,
} from './script-execution';

export interface InteractiveElementInfo {
  selector: string;
  tagName: string;
  type?: string;
  text: string;
  role?: string;
  name?: string;
  id?: string;
  href?: string;
  placeholder?: string;
}

export type FormFillMode =
  | 'auto'
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'contenteditable';

export interface FormFillField {
  selector: string;
  value: string | number | boolean;
  mode?: FormFillMode;
}

export interface FormFillFieldResult {
  selector: string;
  ok: boolean;
  mode: FormFillMode | 'unknown';
  tagName?: string;
  type?: string;
  value?: string | number | boolean;
  error?: string;
}

const CLICK_EXECUTION_TIMEOUT_MS = 1200;

async function loadPageAutomationVisualSettings(): Promise<PageAutomationVisualSettings | undefined> {
  const config = await loadSidepanelConfig().catch(() => null);
  if (!config || config.runtime.animatedBrow !== true) return undefined;
  return {
    animatedBrow: config.runtime.animatedBrow === true,
  };
}

async function executePageAutomationAction<Result>(
  tabId: number,
  action: PageAutomationAction,
  timeoutMs = CLICK_EXECUTION_TIMEOUT_MS,
  timeoutErrorContext?: string,
): Promise<chrome.scripting.InjectionResult<Result>[]> {
  await ensurePageAutomationRuntimeInjected(tabId, Math.min(timeoutMs, CLICK_EXECUTION_TIMEOUT_MS));

  if (timeoutErrorContext) {
    return executeScriptWithTimeout<Result>(
      {
        target: { tabId },
        func: runPageAutomationAction,
        args: [action],
      },
      timeoutMs,
      getBlockedPageExecutionError(timeoutErrorContext),
    );
  }

  return chrome.scripting.executeScript({
    target: { tabId },
    func: runPageAutomationAction,
    args: [action],
  }) as Promise<chrome.scripting.InjectionResult<Result>[]>;
}

export async function dismissBrowAutomationOverlays(
  delayMs = 0,
): Promise<{ ok: boolean; dismissedTabIds: number[]; error?: string }> {
  try {
    const tabs = await chrome.tabs.query({});
    const dismissedTabIds: number[] = [];
    const normalizedDelayMs = Math.max(0, Math.round(delayMs));

    await Promise.all(tabs.map(async (tab) => {
      const tabId = tab.id;
      if (typeof tabId !== 'number' || tabId < 0) return;

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (nextDelayMs: number) => {
            const runtime = (globalThis as Record<string, unknown>).__browPageAutomationRuntime__ as {
              dismissPageAutomationOverlay?: (delay?: number) => void;
            } | undefined;

            if (!runtime || typeof runtime.dismissPageAutomationOverlay !== 'function') {
              return false;
            }

            runtime.dismissPageAutomationOverlay(nextDelayMs);
            return true;
          },
          args: [normalizedDelayMs],
        });

        if (results?.[0]?.result === true) {
          dismissedTabIds.push(tabId);
        }
      } catch {
        // Ignore tabs that cannot be scripted or do not host the automation runtime.
      }
    }));

    return { ok: true, dismissedTabIds };
  } catch (err: any) {
    return {
      ok: false,
      dismissedTabIds: [],
      error: err?.message ?? 'Failed to dismiss Brow automation overlays',
    };
  }
}

export async function tabsListInteractiveElements(
  tabId: number,
  limit = 40,
): Promise<{ ok: boolean; elements?: InteractiveElementInfo[]; error?: string }> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (maxResults: number) => {
        const cleanText = (value: string | null | undefined): string =>
          (value ?? '').replace(/\s+/g, ' ').trim();

        const hasReliableValue = (value: string | null | undefined): value is string => {
          const normalized = cleanText(value).toLowerCase();
          return normalized !== ''
            && normalized !== 'undefined'
            && normalized !== 'null'
            && normalized !== 'nan'
            && normalized !== '[object object]';
        };

        const escapeCss = (value: string): string => {
          if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
          return value.replace(/["\\]/g, '\\$&');
        };

        const escapeAttributeValue = (value: string): string => (
          value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        );

        const canUseHashIdSelector = (value: string): boolean => (
          /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(value)
        );

        const buildSelector = (el: Element): string => {
          const htmlEl = el as HTMLElement;
          if (htmlEl.id) {
            return canUseHashIdSelector(htmlEl.id)
              ? `#${htmlEl.id}`
              : `[id="${escapeAttributeValue(htmlEl.id)}"]`;
          }
          const testId = el.getAttribute('data-testid');
          if (testId) return `[data-testid="${escapeAttributeValue(testId)}"]`;
          const ariaLabel = el.getAttribute('aria-label');
          if (ariaLabel) return `${el.tagName.toLowerCase()}[aria-label="${escapeAttributeValue(ariaLabel)}"]`;
          const placeholder = el.getAttribute('placeholder');
          if (placeholder) return `${el.tagName.toLowerCase()}[placeholder="${escapeAttributeValue(placeholder)}"]`;

          const segments: string[] = [];
          let current: Element | null = el;
          while (current && segments.length < 4 && current !== document.body) {
            let segment = current.tagName.toLowerCase();
            const classes = Array.from(current.classList).filter((cls) => cls && !cls.startsWith('ng-')).slice(0, 2);
            if (classes.length > 0) {
              segment += classes.map((cls) => `.${escapeCss(cls)}`).join('');
            } else {
              const parent = current.parentElement;
              if (parent) {
                const siblings = Array.from(parent.children).filter((child) => child.tagName === current!.tagName);
                if (siblings.length > 1) {
                  segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
                }
              }
            }
            segments.unshift(segment);
            current = current.parentElement;
          }
          return segments.join(' > ');
        };

        const candidates = Array.from(document.querySelectorAll<HTMLElement>(
          'a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="menuitem"], [role="option"], [tabindex]',
        ))
          .filter((el) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const hidden = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
            const noSize = rect.width < 2 || rect.height < 2;
            return !hidden && !noSize && !el.closest('#__brow-automation-overlay__');
          })
          .slice(0, Math.max(1, Math.min(maxResults, 100)));

        return candidates.map((el) => {
          const role = el.getAttribute('role') || undefined;
          const label = cleanText(
            el.getAttribute('aria-label')
            || (el as HTMLInputElement).labels?.[0]?.textContent
            || el.textContent
            || (el as HTMLInputElement).value,
          );
          return {
            selector: buildSelector(el),
            tagName: el.tagName.toLowerCase(),
            type: (el as HTMLInputElement).type || undefined,
            text: label,
            role,
            name: hasReliableValue(el.getAttribute('name')) ? el.getAttribute('name')! : undefined,
            id: hasReliableValue(el.id) ? el.id : undefined,
            href: (el as HTMLAnchorElement).href || undefined,
            placeholder: el.getAttribute('placeholder') || undefined,
          };
        });
      },
      args: [Math.max(1, Math.min(limit, 100))],
    });

    const elements = results?.[0]?.result as InteractiveElementInfo[] | undefined;
    return { ok: true, elements: elements ?? [] };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to list interactive elements' };
  }
}

export async function tabsClick(
  tabId: number,
  selector: string,
  clickPoint?: BrowserClickPoint,
  clickMode?: ClickDispatchMode,
): Promise<{ ok: boolean; clicked?: InteractiveElementInfo; error?: string }> {
  try {
    await ensureTabIsActive(tabId);
    const visualSettings = await loadPageAutomationVisualSettings();

    const results = await executePageAutomationAction<{ ok: boolean; clicked?: InteractiveElementInfo; error?: string }>(
      tabId,
      { kind: 'click', selector, clickPoint, clickMode, visualSettings },
      CLICK_EXECUTION_TIMEOUT_MS,
      'Click execution',
    );

    return (results?.[0]?.result as { ok: boolean; clicked?: InteractiveElementInfo; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to click element' };
  }
}

export async function tabsHighlight(
  tabId: number,
  selector: string,
  message?: string,
  durationMs?: number,
): Promise<{
  ok: boolean;
  highlighted?: InteractiveElementInfo;
  durationMs?: number;
  message?: string;
  error?: string;
}> {
  try {
    await ensureTabIsActive(tabId);
    const visualSettings = await loadPageAutomationVisualSettings();

    const results = await executePageAutomationAction<{
      ok: boolean;
      highlighted?: InteractiveElementInfo;
      durationMs?: number;
      message?: string;
      error?: string;
    }>(tabId, { kind: 'highlight', selector, message, durationMs, visualSettings });

    return (results?.[0]?.result as {
      ok: boolean;
      highlighted?: InteractiveElementInfo;
      durationMs?: number;
      message?: string;
      error?: string;
    } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to highlight element' };
  }
}

export async function tabsHover(
  tabId: number,
  selector: string,
  message?: string,
  durationMs?: number,
): Promise<{
  ok: boolean;
  hovered?: InteractiveElementInfo;
  durationMs?: number;
  message?: string;
  error?: string;
}> {
  try {
    await ensureTabIsActive(tabId);

    const results = await executePageAutomationAction<{
      ok: boolean;
      hovered?: InteractiveElementInfo;
      durationMs?: number;
      message?: string;
      error?: string;
    }>(tabId, { kind: 'hover', selector, message, durationMs });

    return (results?.[0]?.result as {
      ok: boolean;
      hovered?: InteractiveElementInfo;
      durationMs?: number;
      message?: string;
      error?: string;
    } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to hover element' };
  }
}

export async function tabsType(
  tabId: number,
  selector: string,
  text: string,
  submit = false,
): Promise<{ ok: boolean; typed?: InteractiveElementInfo & { textLength: number }; error?: string }> {
  try {
    await ensureTabIsActive(tabId);
    const visualSettings = await loadPageAutomationVisualSettings();

    const results = await executePageAutomationAction<{
      ok: boolean;
      typed?: InteractiveElementInfo & { textLength: number };
      error?: string;
    }>(tabId, { kind: 'type', selector, text, submit, visualSettings });

    return (results?.[0]?.result as { ok: boolean; typed?: InteractiveElementInfo & { textLength: number }; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to type into element' };
  }
}

export async function tabsFillForm(
  tabId: number,
  fields: FormFillField[],
  submit = false,
  submitSelector?: string,
): Promise<{
  ok: boolean;
  results?: FormFillFieldResult[];
  submitted?: boolean;
  warning?: string;
  error?: string;
}> {
  try {
    await ensureTabIsActive(tabId);
    const visualSettings = await loadPageAutomationVisualSettings();

    const results = await executePageAutomationAction<{
      ok: boolean;
      results?: FormFillFieldResult[];
      submitted?: boolean;
      warning?: string;
      error?: string;
    }>(tabId, { kind: 'fillForm', fields, submit, submitSelector, visualSettings });

    return (results?.[0]?.result as {
      ok: boolean;
      results?: FormFillFieldResult[];
      submitted?: boolean;
      warning?: string;
      error?: string;
    } | undefined) ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to fill form' };
  }
}

export async function tabsDrag(
  tabId: number,
  sourceSelector: string,
  destinationSelector: string,
  options: {
    sourceClickPoint?: BrowserClickPoint;
    destinationClickPoint?: BrowserClickPoint;
    pointerPath?: Array<{ x: number; y: number }>;
    durationMs?: number;
  } = {},
): Promise<{ ok: boolean; dragged?: unknown; error?: string }> {
  try {
    await ensureTabIsActive(tabId);
    const results = await executePageAutomationAction<{ ok: boolean; dragged?: unknown; error?: string }>(
      tabId,
      {
        kind: 'drag',
        sourceSelector,
        destinationSelector,
        sourceClickPoint: options.sourceClickPoint,
        destinationClickPoint: options.destinationClickPoint,
        pointerPath: options.pointerPath,
        durationMs: options.durationMs,
      },
    );

    return (results?.[0]?.result as { ok: boolean; dragged?: unknown; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to drag element' };
  }
}

export async function tabsScroll(
  tabId: number,
  options: { selector?: string; deltaX?: number; deltaY?: number; top?: number; left?: number },
): Promise<{ ok: boolean; scrolled?: unknown; error?: string }> {
  try {
    await ensureTabIsActive(tabId);
    const results = await executePageAutomationAction<{ ok: boolean; scrolled?: unknown; error?: string }>(
      tabId,
      { kind: 'scroll', ...options },
    );

    return (results?.[0]?.result as { ok: boolean; scrolled?: unknown; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to scroll page' };
  }
}

export async function tabsKey(
  tabId: number,
  options: {
    selector?: string;
    key?: string;
    code?: string;
    text?: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  },
): Promise<{ ok: boolean; keyed?: unknown; error?: string }> {
  try {
    await ensureTabIsActive(tabId);
    const results = await executePageAutomationAction<{ ok: boolean; keyed?: unknown; error?: string }>(
      tabId,
      { kind: 'key', ...options },
    );

    return (results?.[0]?.result as { ok: boolean; keyed?: unknown; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to send key event' };
  }
}

export async function tabsUploadFile(
  tabId: number,
  selector: string,
  fileName?: string,
  filePath?: string,
): Promise<{ ok: boolean; upload?: unknown; helperRequired?: boolean; backend?: BrowAutomationBackend; error?: string }> {
  try {
    await ensureTabIsActive(tabId);
    const results = await executePageAutomationAction<{
      ok: boolean;
      upload?: unknown;
      helperRequired?: boolean;
      backend?: BrowAutomationBackend;
      error?: string;
    }>(tabId, { kind: 'upload', selector, fileName, filePath });

    return (results?.[0]?.result as { ok: boolean; upload?: unknown; helperRequired?: boolean; backend?: BrowAutomationBackend; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to open upload control' };
  }
}

export async function tabsHandleDialog(
  tabId: number,
  options: { selector?: string; action: 'accept' | 'dismiss' | 'close'; text?: string },
): Promise<{ ok: boolean; dialog?: unknown; helperRequired?: boolean; backend?: BrowAutomationBackend; error?: string }> {
  try {
    await ensureTabIsActive(tabId);
    const results = await executePageAutomationAction<{
      ok: boolean;
      dialog?: unknown;
      helperRequired?: boolean;
      backend?: BrowAutomationBackend;
      error?: string;
    }>(tabId, { kind: 'handleDialog', ...options });

    return (results?.[0]?.result as { ok: boolean; dialog?: unknown; helperRequired?: boolean; backend?: BrowAutomationBackend; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to handle dialog' };
  }
}
