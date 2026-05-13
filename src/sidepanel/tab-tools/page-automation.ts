import { ensureTabIsActive } from './tabs';
import type {
  BrowserFormSnapshot,
  BrowserFormSnapshotOptions,
  BrowserRefResolution,
  BrowserSnapshot,
  BrowserSnapshotElement,
  BrowserSnapshotOperation,
  BrowserSnapshotOperationResult,
  BrowserSnapshotOptions,
  BrowserViewportRect,
  BrowActionRepairCandidate,
  BrowAutomationBackend,
  BrowBackendPreference,
  BrowActionCacheStatus,
  BrowActionKind,
  BrowActionMemoryField,
  BrowActionMemoryTarget,
  BrowActionPostcondition,
  BrowActionTrace,
  BrowElementSignature,
  BrowPostconditionResult,
  BrowReplayTargetEvidence,
} from '../../shared/types';
import { shouldRequireActionableClickResolution } from '../../shared/browser-snapshot-selection';
import {
  findActionMemoryEntry,
  memoryFieldFromElement,
  memoryTargetFromElement,
  upsertActionMemoryEntry,
} from './action-memory';
import {
  getUnsafePromotedClickResolutionError,
  getUnsafeEditableClickIntentError,
  isIntentRecoveryEntryAllowed,
  shouldRepairForSatisfiedValuePostconditions,
  shouldSkipActionForSatisfiedPostconditions,
} from './click-intent-guards';
import { shouldRetryBodyMediaKey } from './browser-key-retry';
import type { BrowserSnapshotOperationMessageResult } from '../../shared/messages';

export {
  isGenericSnapshotLabel,
  selectSnapshotEntriesForDisplay,
  shouldRequireActionableClickResolution,
} from '../../shared/browser-snapshot-selection';

export type { BrowserRefResolution } from '../../shared/types';

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

export interface BrowserClickPoint {
  origin: 'target' | 'targetFraction' | 'viewport';
  x: number;
  y: number;
}

interface ClickPoint {
  x: number;
  y: number;
}

interface VisibleRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface ClickPlan {
  target: HTMLElement;
  point: ClickPoint;
  rect: VisibleRect;
  dispatchMode: 'synthetic' | 'programmatic';
}

type ClickDispatchMode = 'programmatic';

export interface BrowserActionOptions {
  intent?: string;
  postconditions?: BrowActionPostcondition[];
  useActionMemory?: boolean;
  clickPoint?: BrowserClickPoint;
  targetEvidence?: BrowReplayTargetEvidence;
  backendPreference?: BrowBackendPreference;
}

export interface BrowserActionRichMetadata {
  backend: BrowAutomationBackend;
  confidence?: number;
  beforeSnapshot?: BrowserSnapshot;
}

type BrowserMemoryResolution = BrowserRefResolution;

const ACTION_BEFORE_SNAPSHOT_MAX_ELEMENTS = 100;
const ACTION_EXPANDED_SNAPSHOT_MAX_ELEMENTS = 250;
const INTENT_MATCH_THRESHOLD = 42;
const INTENT_MATCH_MARGIN = 8;
const CLICK_EXECUTION_TIMEOUT_MS = 1200;
const PAGE_SETTLE_TIMEOUT_SLACK_MS = 400;

function getBlockedPageExecutionError(context: string): string {
  return `${context} timed out, likely because a native browser alert/confirm/prompt is open. MV3 cannot continue until the dialog is closed; use the local helper backend to handle native dialogs.`;
}

async function executeScriptWithTimeout<Result>(
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

type PageAutomationAction =
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

async function runPageAutomationAction(action: PageAutomationAction): Promise<unknown> {
  const ROOT_ID = '__brow-automation-overlay__';
  const STYLE_ID = '__brow-automation-style__';
  const SNAPSHOT_STATE_KEY = '__browBrowserSnapshotState__';
  const BROW_REF_PREFIX = 'brow-ref://';
  type CursorFrame = 'hand' | 'push' | 'highlight' | 'pencil';
  type StoredSnapshot = {
    snapshotId: string;
    entriesByRef: Record<string, BrowserSnapshotElement>;
    nodesByRef: Record<string, Element>;
    order: string[];
    createdAt: number;
  };
  type SnapshotState = {
    currentSnapshotId?: string;
    snapshots: Record<string, StoredSnapshot>;
    snapshotOrder: string[];
  };
  const CURSOR_SIZE = 40;
  const CURSOR_WIDTH = CURSOR_SIZE;
  const CURSOR_HEIGHT = CURSOR_SIZE;
  const CURSOR_SPRITESHEET_URL = chrome.runtime.getURL('icons/cursors.png');
  const CURSOR_HOTSPOT_X = 18;
  const CURSOR_HOTSPOT_Y = 6;
  const HIGHLIGHT_CURSOR_HOTSPOT_X = 20;
  const HIGHLIGHT_CURSOR_HOTSPOT_Y = 20;
  const PENCIL_CURSOR_HOTSPOT_X = 8;
  const PENCIL_CURSOR_HOTSPOT_Y = 32;
  const BADGE_WIDTH = 300;
  const BADGE_HEIGHT = 60;
  const BADGE_CURSOR_OFFSET_X = CURSOR_WIDTH + 10;
  const BADGE_CURSOR_OFFSET_Y = -2;
  const LAST_HOVERED_KEY = '__browLastHoveredElement__';

  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const toScreenX = (clientX: number) => (window.screenX ?? window.screenLeft ?? 0) + clientX;
  const toScreenY = (clientY: number) => (window.screenY ?? window.screenTop ?? 0) + clientY;
  const getSnapshotState = (): SnapshotState | undefined => (
    (window as unknown as Record<string, SnapshotState | undefined>)[SNAPSHOT_STATE_KEY]
  );
  const isHTMLElementLike = (value: unknown): value is HTMLElement => (
    Boolean(value)
    && typeof value === 'object'
    && (value as Node).nodeType === 1
    && typeof (value as HTMLElement).getBoundingClientRect === 'function'
    && typeof (value as HTMLElement).tagName === 'string'
  );

  const resolveBrowRefElement = (selector: string): HTMLElement | null => {
    const parsed = (() => {
      const trimmed = selector.trim();
      if (trimmed.startsWith(BROW_REF_PREFIX)) {
        const rest = trimmed.slice(BROW_REF_PREFIX.length);
        const slash = rest.lastIndexOf('/');
        if (slash <= 0 || slash >= rest.length - 1) return null;

        return {
          snapshotId: decodeURIComponent(rest.slice(0, slash)),
          ref: decodeURIComponent(rest.slice(slash + 1)),
        };
      }

      const bracketMatch = trimmed.match(/^\[\s*ref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]$/i);
      if (bracketMatch) {
        const ref = (bracketMatch[1] ?? bracketMatch[2] ?? bracketMatch[3] ?? '').trim();
        return ref ? { ref } : null;
      }

      const inlineMatch = trimmed.match(/^ref\s*=\s*(?:"([^"]+)"|'([^']+)'|(.+))$/i);
      if (inlineMatch) {
        const ref = (inlineMatch[1] ?? inlineMatch[2] ?? inlineMatch[3] ?? '').trim();
        return ref ? { ref } : null;
      }

      return null;
    })();
    if (!parsed) return null;

    const state = getSnapshotState();
    const candidateIds = parsed.snapshotId
      ? [parsed.snapshotId]
      : [state?.currentSnapshotId, ...(state?.snapshotOrder.slice().reverse() ?? [])]
        .filter((value): value is string => Boolean(value));

    const seen = new Set<string>();
    for (const snapshotId of candidateIds) {
      if (seen.has(snapshotId)) continue;
      seen.add(snapshotId);
      const snapshot = state?.snapshots?.[snapshotId];
      const node = snapshot?.nodesByRef?.[parsed.ref];
      if (isHTMLElementLike(node) && node.isConnected) return node;
    }

    return null;
  };

  const ensureOverlay = () => {
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        #${ROOT_ID} {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 2147483647;
        }
        #${ROOT_ID} .brow-automation-cursor {
          position: fixed;
          top: 0;
          left: 0;
          width: ${CURSOR_SIZE}px;
          height: ${CURSOR_SIZE}px;
          opacity: 0;
          background-image: url("${CURSOR_SPRITESHEET_URL}");
          background-repeat: no-repeat;
          background-position: 0 0;
          background-size: ${CURSOR_SIZE * 4}px ${CURSOR_SIZE}px;
          filter: drop-shadow(0 0 10px rgba(168, 85, 247, 0.5));
          transform-origin: top left;
          transition: transform 160ms ease, opacity 140ms ease, filter 160ms ease;
        }
        #${ROOT_ID} .brow-automation-cursor[data-frame="hand"] {
          background-position: 0 0;
        }
        #${ROOT_ID} .brow-automation-cursor[data-frame="push"] {
          background-position: -${CURSOR_SIZE}px 0;
        }
        #${ROOT_ID} .brow-automation-cursor[data-frame="highlight"] {
          background-position: -${CURSOR_SIZE * 2}px 0;
        }
        #${ROOT_ID} .brow-automation-cursor[data-frame="pencil"] {
          background-position: -${CURSOR_SIZE * 3}px 0;
        }
        #${ROOT_ID} .brow-automation-cursor.visible {
          opacity: 1;
        }
        #${ROOT_ID} .brow-automation-badge {
          position: fixed;
          top: 0;
          left: 0;
          max-width: min(300px, calc(100vw - 24px));
          padding: 8px 10px;
          border-radius: 10px;
          border: 2px solid rgba(192, 132, 252, 0.92);
          background: rgba(24, 10, 36, 0.96);
          color: #f5e9ff;
          font: 600 12px/1.35 "Space Grotesk", "Segoe UI", sans-serif;
          letter-spacing: 0.01em;
          box-shadow: 0 10px 34px rgba(168, 85, 247, 0.28);
          opacity: 0;
          transform: translateY(-4px);
          transition: opacity 180ms ease, transform 180ms ease;
          backdrop-filter: blur(6px);
        }
        #${ROOT_ID} .brow-automation-badge.visible {
          opacity: 1;
          transform: translateY(0);
        }
        #${ROOT_ID} .brow-automation-highlight {
          position: fixed;
          top: 0;
          left: 0;
          border-radius: 12px;
          border: 2px solid rgba(192, 132, 252, 0.98);
          background: rgba(168, 85, 247, 0.10);
          box-shadow:
            0 0 0 1px rgba(244, 212, 255, 0.22),
            0 0 24px rgba(168, 85, 247, 0.24);
          opacity: 0;
          transition: opacity 180ms ease;
        }
        #${ROOT_ID} .brow-automation-highlight.visible {
          opacity: 1;
        }
        #${ROOT_ID} .brow-automation-highlight.emphasized {
          animation: browAutomationHighlightPulse 1050ms ease-in-out infinite;
        }
        #${ROOT_ID} .brow-automation-ripple {
          position: fixed;
          top: 0;
          left: 0;
          width: 18px;
          height: 18px;
          margin-left: -9px;
          margin-top: -9px;
          border-radius: 999px;
          border: 2px solid rgba(216, 180, 254, 0.95);
          background: rgba(216, 180, 254, 0.12);
          box-shadow: 0 0 20px rgba(168, 85, 247, 0.25);
          animation: browAutomationRipple 460ms ease-out forwards;
        }
        #${ROOT_ID} .brow-automation-particle {
          position: fixed;
          top: 0;
          left: 0;
          width: 8px;
          height: 8px;
          border-radius: 999px;
          pointer-events: none;
          background:
            radial-gradient(circle at 35% 35%, rgba(255,255,255,0.95), rgba(255,255,255,0.18) 35%, transparent 36%),
            radial-gradient(circle, rgba(216, 180, 254, 0.95), rgba(168, 85, 247, 0.32) 58%, transparent 74%);
          box-shadow:
            0 0 10px rgba(216, 180, 254, 0.55),
            0 0 18px rgba(168, 85, 247, 0.35);
          transform: translate(-50%, -50%);
          animation: browAutomationParticle var(--particle-duration, 420ms) ease-out forwards;
        }
        @keyframes browAutomationRipple {
          0% {
            opacity: 0.95;
            transform: scale(0.45);
          }
          100% {
            opacity: 0;
            transform: scale(4.8);
          }
        }
        @keyframes browAutomationParticle {
          0% {
            opacity: 0.92;
            transform: translate(-50%, -50%) translate3d(0, 0, 0) scale(1);
          }
          100% {
            opacity: 0;
            transform:
              translate(-50%, -50%)
              translate3d(var(--particle-dx, 0px), var(--particle-dy, 0px), 0)
              scale(0.2);
          }
        }
        @keyframes browAutomationHighlightPulse {
          0%, 100% {
            opacity: 0.92;
            transform: scale(1);
            box-shadow:
              0 0 0 1px rgba(244, 212, 255, 0.22),
              0 0 24px rgba(168, 85, 247, 0.24);
          }
          50% {
            opacity: 1;
            transform: scale(1.012);
            box-shadow:
              0 0 0 1px rgba(244, 212, 255, 0.34),
              0 0 36px rgba(192, 132, 252, 0.34);
          }
        }
      `;
      document.documentElement.appendChild(style);
    }

    let root = document.getElementById(ROOT_ID) as HTMLDivElement | null;
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.setAttribute('aria-hidden', 'true');

      const highlight = document.createElement('div');
      highlight.className = 'brow-automation-highlight';

      const cursor = document.createElement('div');
      cursor.className = 'brow-automation-cursor';

      const badge = document.createElement('div');
      badge.className = 'brow-automation-badge';

      root.appendChild(highlight);
      root.appendChild(cursor);
      root.appendChild(badge);
      document.documentElement.appendChild(root);
    }

    return {
      root,
      highlight: root.querySelector('.brow-automation-highlight') as HTMLDivElement,
      cursor: root.querySelector('.brow-automation-cursor') as HTMLDivElement,
      badge: root.querySelector('.brow-automation-badge') as HTMLDivElement,
    };
  };

  const describeElement = (el: HTMLElement): string => {
    const label = [
      el.getAttribute('aria-label'),
      el.getAttribute('name'),
      el.getAttribute('placeholder'),
      el.id,
      el.innerText,
      el.textContent,
    ]
      .map((value) => (value ?? '').replace(/\s+/g, ' ').trim())
      .find(Boolean);

    if (label) return label.slice(0, 40);

    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return `${(el as HTMLInputElement).type || 'input'} field`;
    if (tag === 'textarea') return 'text area';
    return tag;
  };

  const isElementVisible = (el: Element): boolean => {
    const rect = (el as HTMLElement).getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const ownerWindow = el.ownerDocument?.defaultView ?? window;
    const style = ownerWindow.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };

  const escapeAttributeValue = (value: string): string => (
    value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  );

  const decodeCssIdentifier = (value: string): string => {
    let result = '';
    let index = 0;

    while (index < value.length) {
      const char = value[index];
      if (char !== '\\') {
        result += char;
        index += 1;
        continue;
      }

      index += 1;
      if (index >= value.length) break;

      // CSS.escape() encodes leading digits as \3N with a required terminator
      // space. If that space is dropped by the model, recover the intended digit.
      if (result.length === 0 && value[index] === '3' && /[0-9]/.test(value[index + 1] ?? '')) {
        result += String.fromCharCode(parseInt(value.slice(index, index + 2), 16));
        index += 2;
        if (value[index] === ' ') index += 1;
        continue;
      }

      let hex = '';
      while (index < value.length && hex.length < 6 && /[0-9a-fA-F]/.test(value[index])) {
        hex += value[index];
        index += 1;
      }

      if (hex) {
        result += String.fromCodePoint(parseInt(hex, 16));
        if (value[index] === ' ') index += 1;
        continue;
      }

      result += value[index];
      index += 1;
    }

    return result;
  };

  const toIdAttributeSelector = (rawId: string): string => `[id="${escapeAttributeValue(rawId)}"]`;

  const normalizeIdSelectorPart = (part: string): string | null => {
    if (!part.startsWith('#')) return null;
    const rawId = decodeCssIdentifier(part.slice(1).trim());
    if (!rawId) return null;
    return toIdAttributeSelector(rawId);
  };

  const tryQueryElement = (selector: string): HTMLElement | null => {
    try {
      const matches = Array.from(document.querySelectorAll(selector))
        .filter((match): match is HTMLElement => match instanceof HTMLElement);
      return matches.find((match) => isElementVisible(match)) ?? matches[0] ?? null;
    } catch {
      return null;
    }
  };

  const tryQueryUniqueElement = (selector: string): HTMLElement | null => {
    try {
      const matches = Array.from(document.querySelectorAll(selector))
        .filter((match): match is HTMLElement => match instanceof HTMLElement)
        .filter((match) => isElementVisible(match));
      if (matches.length !== 1) return null;
      return matches[0];
    } catch {
      return null;
    }
  };

  const normalizeInlineText = (value: string | null | undefined): string => (
    (value ?? '').replace(/\s+/g, ' ').trim()
  );

  const unquoteSelectorText = (value: string): string => {
    const trimmed = value.trim();
    if (trimmed.length < 2) return trimmed;

    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    const quotePairs: Array<[string, string]> = [
      ['"', '"'],
      ['\'', '\''],
      ['“', '”'],
      ['‘', '’'],
    ];

    const match = quotePairs.find(([open, close]) => first === open && last === close);
    if (!match) return trimmed;
    return trimmed.slice(1, -1);
  };

  const splitSelectorList = (selector: string): string[] => {
    const parts: string[] = [];
    let current = '';
    let parenDepth = 0;
    let bracketDepth = 0;
    let quote: string | null = null;

    for (let index = 0; index < selector.length; index += 1) {
      const char = selector[index];

      if (quote) {
        current += char;
        if (char === quote && selector[index - 1] !== '\\') {
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === '\'' || char === '“' || char === '‘') {
        quote = char === '“' ? '”' : char === '‘' ? '’' : char;
        current += char;
        continue;
      }

      if (char === '[') bracketDepth += 1;
      else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (char === '(') parenDepth += 1;
      else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);

      if (char === ',' && parenDepth === 0 && bracketDepth === 0) {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = '';
        continue;
      }

      current += char;
    }

    const tail = current.trim();
    if (tail) parts.push(tail);
    return parts;
  };

  const collectTextMatchMetadata = (el: HTMLElement, needle: string) => {
    const normalizedNeedle = normalizeInlineText(needle).toLowerCase();
    const text = normalizeInlineText(
      el.innerText
      || el.textContent
      || el.getAttribute('aria-label')
      || el.getAttribute('title')
      || el.getAttribute('placeholder')
      || el.getAttribute('name'),
    );
    const normalizedText = text.toLowerCase();
    const rect = getVisibleRect(el);
    const area = rect ? rect.width * rect.height : Number.POSITIVE_INFINITY;
    let depth = 0;
    let current: HTMLElement | null = el;
    while (current) {
      depth += 1;
      current = current.parentElement;
    }

    return {
      text,
      normalizedText,
      exact: normalizedText === normalizedNeedle,
      startsWith: normalizedText.startsWith(normalizedNeedle),
      index: normalizedText.indexOf(normalizedNeedle),
      lengthDelta: Math.abs(text.length - needle.length),
      area,
      depth,
    };
  };

  const pruneAndSortTextMatches = (elements: HTMLElement[], needle: string): HTMLElement[] => {
    const deduped = elements.filter((element, index) =>
      elements.findIndex((candidate) => candidate === element) === index,
    );
    const innermost = deduped.filter((element) =>
      !deduped.some((candidate) => candidate !== element && element.contains(candidate)),
    );
    const pool = innermost.length > 0 ? innermost : deduped;

    return [...pool].sort((left, right) => {
      const leftMeta = collectTextMatchMetadata(left, needle);
      const rightMeta = collectTextMatchMetadata(right, needle);
      if (leftMeta.exact !== rightMeta.exact) return leftMeta.exact ? -1 : 1;
      if (leftMeta.startsWith !== rightMeta.startsWith) return leftMeta.startsWith ? -1 : 1;
      if (leftMeta.index !== rightMeta.index) return leftMeta.index - rightMeta.index;
      if (leftMeta.lengthDelta !== rightMeta.lengthDelta) return leftMeta.lengthDelta - rightMeta.lengthDelta;
      if (leftMeta.area !== rightMeta.area) return leftMeta.area - rightMeta.area;
      return rightMeta.depth - leftMeta.depth;
    });
  };

  const parseTextSelectorPseudo = (
    segment: string,
  ): { baseSelector: string; needle: string; suffixSelector?: string } | null => {
    const tokens = [':contains(', ':has-text('];
    const matches = tokens
      .map((token) => ({ token, index: segment.indexOf(token) }))
      .filter((match) => match.index >= 0)
      .sort((left, right) => left.index - right.index);
    if (matches.length === 0) return null;

    const { token, index } = matches[0];

    let depth = 1;
    let quote: string | null = null;
    let cursor = index + token.length;

    for (; cursor < segment.length; cursor += 1) {
      const char = segment[cursor];

      if (quote) {
        if (char === quote && segment[cursor - 1] !== '\\') {
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === '\'' || char === '“' || char === '‘') {
        quote = char === '“' ? '”' : char === '‘' ? '’' : char;
        continue;
      }

      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    if (depth !== 0) return null;

    const baseSelector = segment.slice(0, index).trim() || '*';
    const needle = normalizeInlineText(unquoteSelectorText(segment.slice(index + token.length, cursor)));
    if (!needle) return null;

    const suffixSelector = segment.slice(cursor + 1).trim() || undefined;
    return { baseSelector, needle, suffixSelector };
  };

  const expandContainsBaseSelectors = (baseSelector: string): string[] => {
    const normalized = baseSelector.trim() || '*';
    const variants = [normalized];
    const seen = new Set(variants);
    const push = (candidate: string) => {
      const trimmed = candidate.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      variants.push(trimmed);
    };

    if (/^h[1-6]$/i.test(normalized)) {
      push(':is(h1, h2, h3, h4, h5, h6, [role="heading"])');
    }

    const headingSuffixVariant = normalized.replace(
      /(^|[\s>+~])h[1-6]$/i,
      '$1:is(h1, h2, h3, h4, h5, h6, [role="heading"])',
    );
    if (headingSuffixVariant !== normalized) {
      push(headingSuffixVariant);
    }

    return variants;
  };

  const resolveRelativeTextTargets = (baseElement: HTMLElement, suffixSelector?: string): HTMLElement[] => {
    const suffix = suffixSelector?.trim();
    if (!suffix) return [baseElement];

    const collectScoped = (selector: string): HTMLElement[] => {
      try {
        return Array.from(baseElement.querySelectorAll(selector))
          .filter((match): match is HTMLElement => match instanceof HTMLElement);
      } catch {
        return [];
      }
    };

    if (suffix.startsWith('+')) {
      const siblingSelector = suffix.slice(1).trim() || '*';
      const sibling = baseElement.nextElementSibling;
      return sibling instanceof HTMLElement && sibling.matches(siblingSelector) ? [sibling] : [];
    }

    if (suffix.startsWith('~')) {
      const siblingSelector = suffix.slice(1).trim() || '*';
      const matches: HTMLElement[] = [];
      let sibling = baseElement.nextElementSibling;
      while (sibling) {
        if (sibling instanceof HTMLElement && sibling.matches(siblingSelector)) {
          matches.push(sibling);
        }
        sibling = sibling.nextElementSibling;
      }
      return matches;
    }

    if (suffix.startsWith('>')) {
      const childSelector = suffix.slice(1).trim() || '*';
      return collectScoped(`:scope > ${childSelector}`);
    }

    return collectScoped(suffix);
  };

  const queryTextMatchesForBaseSelectors = (
    baseSelectors: string[],
    needle: string,
    resolvedSelector: string,
    requireUnique = false,
    suffixSelector?: string,
  ): { element: HTMLElement; resolvedSelector: string } | null => {
    const matches: HTMLElement[] = [];

    for (const baseSelector of baseSelectors) {
      let candidates: HTMLElement[] = [];
      try {
        candidates = Array.from(document.querySelectorAll(baseSelector))
          .filter((match): match is HTMLElement => match instanceof HTMLElement);
      } catch {
        continue;
      }

      const baseMatches = candidates.filter((candidate) => {
        if (!isElementVisible(candidate)) return false;
        const text = collectTextMatchMetadata(candidate, needle).normalizedText;
        return text.includes(normalizeInlineText(needle).toLowerCase());
      });

      for (const baseMatch of baseMatches) {
        const relatedTargets = resolveRelativeTextTargets(baseMatch, suffixSelector)
          .filter((target) => isElementVisible(target));
        matches.push(...relatedTargets);
      }

      if (!requireUnique && matches.length > 0) {
        const ranked = pruneAndSortTextMatches(matches, needle);
        if (ranked.length > 0) {
          return { element: ranked[0], resolvedSelector };
        }
      }
    }

    const ranked = pruneAndSortTextMatches(matches, needle);
    if (!requireUnique) {
      return ranked.length > 0 ? { element: ranked[0], resolvedSelector } : null;
    }

    return ranked.length === 1 ? { element: ranked[0], resolvedSelector } : null;
  };

  const querySimpleLocator = (
    selector: string,
    requireUnique = false,
  ): { element: HTMLElement; resolvedSelector: string } | null => {
    const parsed = (() => {
      const match = selector.match(/^\s*(text|heading|title|placeholder|link|button|textbox)\s*(?:=|:)\s*(.+?)\s*$/i);
      if (!match) return null;

      const kind = match[1].toLowerCase();
      const needle = normalizeInlineText(unquoteSelectorText(match[2]));
      if (!needle) return null;

      return { kind, needle };
    })();
    if (!parsed) return null;

    const baseSelectors = (() => {
      if (parsed.kind === 'heading') return ['h1, h2, h3, h4, h5, h6, [role="heading"]'];
      if (parsed.kind === 'title') return ['[title]'];
      if (parsed.kind === 'placeholder') return ['[placeholder]'];
      if (parsed.kind === 'link') return ['a[href], [role="link"]'];
      if (parsed.kind === 'button') {
        return ['button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]'];
      }
      if (parsed.kind === 'textbox') {
        return ['input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]'];
      }
      return ['a, button, input, textarea, select, label, summary, h1, h2, h3, h4, h5, h6, p, span, div, li, dt, dd, article, section, [role="button"], [role="link"], [role="heading"], [title], [placeholder], [aria-label]'];
    })();

    return queryTextMatchesForBaseSelectors(
      baseSelectors,
      parsed.needle,
      `${parsed.kind}="${parsed.needle}"`,
      requireUnique,
    );
  };

  const queryTextPseudoElement = (
    selector: string,
    requireUnique = false,
  ): { element: HTMLElement; resolvedSelector: string } | null => {
    const matches: Array<{ element: HTMLElement; resolvedSelector: string }> = [];

    for (const segment of splitSelectorList(selector)) {
      const parsed = parseTextSelectorPseudo(segment);
      if (!parsed) continue;

      const baseSelectors = expandContainsBaseSelectors(parsed.baseSelector);
      const match = queryTextMatchesForBaseSelectors(
        baseSelectors,
        parsed.needle,
        segment,
        requireUnique,
        parsed.suffixSelector,
      );

      if (!requireUnique && match) return match;
      if (requireUnique && match) matches.push(match);
    }

    if (!requireUnique) return null;
    return matches.length === 1 ? matches[0] : null;
  };

  const queryExtendedElement = (
    selector: string,
    requireUnique = false,
  ): { element: HTMLElement; resolvedSelector: string } | null => {
    const simpleLocatorMatch = querySimpleLocator(selector, requireUnique);
    if (simpleLocatorMatch) return simpleLocatorMatch;

    const segments = splitSelectorList(selector);
    const matches: Array<{ element: HTMLElement; resolvedSelector: string }> = [];

    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;

      if (trimmed.includes(':contains(') || trimmed.includes(':has-text(')) {
        const textPseudoMatch = queryTextPseudoElement(trimmed, requireUnique);
        if (!requireUnique && textPseudoMatch) return textPseudoMatch;
        if (requireUnique && textPseudoMatch) matches.push(textPseudoMatch);
        continue;
      }

      const element = requireUnique
        ? tryQueryUniqueElement(trimmed)
        : tryQueryElement(trimmed);
      if (!element) continue;

      const match = { element, resolvedSelector: trimmed };
      if (!requireUnique) return match;
      matches.push(match);
    }

    if (!requireUnique) return null;

    const uniqueElements = matches.filter((match, index) =>
      matches.findIndex((candidate) => candidate.element === match.element) === index,
    );
    return uniqueElements.length === 1 ? uniqueElements[0] : null;
  };

  const isSuspiciousSelectorPart = (part: string): boolean => {
    const normalized = part
      .replace(/\s+/g, ' ')
      .replace(/["']/g, '')
      .replace(/\\([^\s])/g, '$1')
      .trim()
      .toLowerCase();

    return normalized === '#undefined'
      || normalized === '#null'
      || normalized === '#nan'
      || normalized.includes('[id=undefined]')
      || normalized.includes('[id=null]')
      || normalized.includes('[name=undefined]')
      || normalized.includes('[name=null]')
      || normalized.includes('[data-testid=undefined]')
      || normalized.includes('[data-testid=null]');
  };

  const hasStableSelectorAnchor = (part: string): boolean => (
    part.includes('#')
    || /\[\s*(id|data-testid|data-test|aria-label|title|name|placeholder)\s*=/.test(part)
  );

  const extractStableAttributeSelectors = (part: string): string[] => {
    const selectors: string[] = [];
    const seen = new Set<string>();
    const push = (candidate: string) => {
      if (!candidate || seen.has(candidate)) return;
      seen.add(candidate);
      selectors.push(candidate);
    };
    const stableAttrs = [
      'aria-label',
      'title',
      'placeholder',
      'name',
      'data-testid',
      'data-test',
      'id',
    ];
    const attrPattern = /\[\s*([a-zA-Z_:-][\w:.-]*)\s*=\s*(["'])((?:\\.|(?!\2).)*)\2\s*\]/g;
    let match: RegExpExecArray | null;

    while ((match = attrPattern.exec(part)) !== null) {
      const attrName = match[1];
      if (!stableAttrs.includes(attrName)) continue;
      const attrValue = match[3];
      const selector = `[${attrName}="${attrValue}"]`;
      push(selector);
      if (attrName === 'aria-label' || attrName === 'title') {
        push(`text="${attrValue.replace(/\\"/g, '"')}"`);
      }
      if (attrName === 'placeholder') {
        push(`placeholder="${attrValue.replace(/\\"/g, '"')}"`);
      }
    }

    return selectors;
  };

  const buildSelectorRecoveryCandidates = (selector: string): string[] => {
    const rawParts = selector.split(/\s*>\s*/).map((part) => part.trim()).filter(Boolean);
    if (rawParts.length === 0) return [];

    const cleanedParts = rawParts.filter((part) => !isSuspiciousSelectorPart(part));
    const candidates: string[] = [];
    const seen = new Set<string>();
    const push = (candidate: string) => {
      const trimmed = candidate.trim();
      if (!trimmed || trimmed === selector || seen.has(trimmed)) return;
      seen.add(trimmed);
      candidates.push(trimmed);
    };

    if (cleanedParts.length > 0 && cleanedParts.length !== rawParts.length) {
      push(cleanedParts.join(' > '));
    }

    const normalizedIdParts = cleanedParts.map((part) => normalizeIdSelectorPart(part) ?? part);
    if (normalizedIdParts.some((part, index) => part !== cleanedParts[index])) {
      push(normalizedIdParts.join(' > '));
      for (let index = normalizedIdParts.length - 1; index >= 0; index -= 1) {
        const part = normalizedIdParts[index];
        if (!hasStableSelectorAnchor(part)) continue;
        push(normalizedIdParts.slice(index).join(' > '));
        push(part);
      }
    }

    for (let index = cleanedParts.length - 1; index >= 0; index -= 1) {
      const part = cleanedParts[index];
      if (!hasStableSelectorAnchor(part)) continue;
      push(cleanedParts.slice(index).join(' > '));
      push(part);
      for (const attributeSelector of extractStableAttributeSelectors(part)) {
        push(attributeSelector);
      }
    }

    return candidates;
  };

  const resolveActionElement = (selector: string): { element: HTMLElement; resolvedSelector: string } | null => {
    const refElement = resolveBrowRefElement(selector);
    if (refElement && isElementVisible(refElement)) {
      return { element: refElement, resolvedSelector: selector };
    }

    const direct = queryExtendedElement(selector);
    if (direct) {
      return direct;
    }

    for (const candidate of buildSelectorRecoveryCandidates(selector)) {
      const recovered = queryExtendedElement(candidate, true);
      if (recovered && isElementVisible(recovered.element)) {
        return recovered;
      }
    }

    return null;
  };

  const isRelatedElement = (left: Element | null, right: Element | null): boolean => {
    if (!left || !right) return false;
    return left === right || left.contains(right) || right.contains(left);
  };

  const getVisibleRect = (el: Element): VisibleRect | null => {
    const htmlEl = el as HTMLElement;
    const bounding = htmlEl.getBoundingClientRect?.();
    const rects = typeof htmlEl.getClientRects === 'function'
      ? Array.from(htmlEl.getClientRects())
      : [];
    const chosen = (
      bounding && bounding.width > 0 && bounding.height > 0
        ? bounding
        : rects.find((rect) => rect.width > 0 && rect.height > 0)
    );
    if (!chosen || chosen.width <= 0 || chosen.height <= 0) return null;

    const left = Math.max(chosen.left, 0);
    const top = Math.max(chosen.top, 0);
    const right = Math.min(chosen.right, window.innerWidth);
    const bottom = Math.min(chosen.bottom, window.innerHeight);
    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) return null;

    return {
      left,
      top,
      width,
      height,
      right,
      bottom,
    };
  };

  const buildClickPoints = (rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): ClickPoint[] => {
    const maxX = Math.max(window.innerWidth - 2, 1);
    const maxY = Math.max(window.innerHeight - 2, 1);
    const candidatePairs: Array<[number, number]> = [
      [0.5, 0.5],
      [0.35, 0.5],
      [0.65, 0.5],
      [0.5, 0.35],
      [0.5, 0.65],
    ];

    return candidatePairs.map(([px, py]) => ({
      x: clamp(rect.left + rect.width * px, 1, maxX),
      y: clamp(rect.top + rect.height * py, 1, maxY),
    }));
  };

  const buildPreferredClickPoint = (
    matchedEl: HTMLElement,
    clickPoint: BrowserClickPoint | undefined,
  ): ClickPlan | null => {
    if (!clickPoint) return null;
    const rect = getVisibleRect(matchedEl);
    if (!rect) return null;

    const maxX = Math.max(window.innerWidth - 2, 1);
    const maxY = Math.max(window.innerHeight - 2, 1);
    const point = (() => {
      if (clickPoint.origin === 'viewport') {
        return {
          x: clamp(clickPoint.x, 1, maxX),
          y: clamp(clickPoint.y, 1, maxY),
        };
      }
      if (clickPoint.origin === 'targetFraction') {
        return {
          x: clamp(rect.left + rect.width * clickPoint.x, 1, maxX),
          y: clamp(rect.top + rect.height * clickPoint.y, 1, maxY),
        };
      }
      return {
        x: clamp(rect.left + clickPoint.x, 1, maxX),
        y: clamp(rect.top + clickPoint.y, 1, maxY),
      };
    })();

    const hit = matchedEl.ownerDocument.elementFromPoint(point.x, point.y);
    if (!isRelatedElement(matchedEl, hit)) return null;
    return { target: matchedEl, point, rect, dispatchMode: 'synthetic' };
  };

  const resolveClickPlan = (matchedEl: HTMLElement, clickPoint?: BrowserClickPoint): ClickPlan | null => {
    const preferredPlan = buildPreferredClickPoint(matchedEl, clickPoint);
    if (preferredPlan) return preferredPlan;

    const candidates = [matchedEl, ...Array.from(matchedEl.querySelectorAll<HTMLElement>('*')).slice(0, 80)];
    let fallback: ClickPlan | null = null;

    for (const candidate of candidates) {
      const rect = getVisibleRect(candidate);
      if (!rect) continue;

      const points = buildClickPoints(rect);
      for (const point of points) {
        const hit = candidate.ownerDocument.elementFromPoint(point.x, point.y);
        if (isRelatedElement(matchedEl, hit) || isRelatedElement(candidate, hit)) {
          return { target: candidate, point, rect, dispatchMode: 'synthetic' };
        }
      }

      fallback ??= { target: candidate, point: points[0], rect, dispatchMode: 'programmatic' };
    }

    return fallback;
  };

  const positionBadge = (anchorX: number, anchorY: number) => {
    const { badge } = ensureOverlay();
    const left = clamp(anchorX, 12, Math.max(window.innerWidth - BADGE_WIDTH - 12, 12));
    const top = clamp(anchorY, 12, Math.max(window.innerHeight - BADGE_HEIGHT - 12, 12));
    badge.style.left = `${left}px`;
    badge.style.top = `${top}px`;
  };

  const positionBadgeNearCursor = (cursorX: number, cursorY: number) => {
    positionBadge(cursorX + BADGE_CURSOR_OFFSET_X, cursorY + BADGE_CURSOR_OFFSET_Y);
  };

  const positionBadgeNearRect = (rect: VisibleRect) => {
    const anchorX = Math.min(rect.right + 14, window.innerWidth - BADGE_WIDTH - 12);
    const anchorY = Math.max(rect.top - 2, 12);
    positionBadge(anchorX, anchorY);
  };

  const setCursorPosition = (
    x: number,
    y: number,
    scale = 1,
    rotationDeg = -8,
    frame: CursorFrame = 'hand',
  ) => {
    const { cursor, badge } = ensureOverlay();
    cursor.classList.add('visible');
    cursor.dataset.frame = frame;
    cursor.style.transform = `translate(${x}px, ${y}px) rotate(${rotationDeg}deg) scale(${scale})`;
    if (badge.dataset.followCursor === 'true') {
      positionBadgeNearCursor(x, y);
    }
  };

  const showBadge = (message: string, anchorX: number, anchorY: number) => {
    const { badge } = ensureOverlay();
    badge.textContent = message;
    badge.classList.add('visible');
    delete badge.dataset.followCursor;
    positionBadge(anchorX, anchorY);
  };

  const showBadgeNearCursor = (message: string, cursorX: number, cursorY: number) => {
    const { badge } = ensureOverlay();
    badge.textContent = message;
    badge.classList.add('visible');
    badge.dataset.followCursor = 'true';
    positionBadgeNearCursor(cursorX, cursorY);
  };

  const showHighlight = (el: HTMLElement, emphasized = false) => {
    const { highlight } = ensureOverlay();
    const rect = getVisibleRect(el);
    if (!rect) return;
    const pad = 6;
    highlight.classList.add('visible');
    highlight.classList.toggle('emphasized', emphasized);
    highlight.style.left = `${Math.max(rect.left - pad, 0)}px`;
    highlight.style.top = `${Math.max(rect.top - pad, 0)}px`;
    highlight.style.width = `${Math.min(rect.width + pad * 2, window.innerWidth)}px`;
    highlight.style.height = `${Math.min(rect.height + pad * 2, window.innerHeight)}px`;
  };

  const createRipple = (x: number, y: number) => {
    const { root } = ensureOverlay();
    const ripple = document.createElement('div');
    ripple.className = 'brow-automation-ripple';
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    root.appendChild(ripple);
    window.setTimeout(() => ripple.remove(), 500);
  };

  const createParticle = (x: number, y: number, intensity = 1) => {
    const { root } = ensureOverlay();
    const particle = document.createElement('div');
    particle.className = 'brow-automation-particle';
    const size = 4 + Math.random() * 7 * intensity;
    const driftX = (-18 + Math.random() * 36) * intensity;
    const driftY = (-14 + Math.random() * 28) * intensity;
    const duration = 220 + Math.random() * 180;
    particle.style.left = `${x}px`;
    particle.style.top = `${y}px`;
    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;
    particle.style.setProperty('--particle-dx', `${driftX}px`);
    particle.style.setProperty('--particle-dy', `${driftY}px`);
    particle.style.setProperty('--particle-duration', `${duration}ms`);
    root.appendChild(particle);
    window.setTimeout(() => particle.remove(), duration + 40);
  };

  const burstParticles = (x: number, y: number, count = 8, intensity = 1) => {
    for (let i = 0; i < count; i += 1) {
      createParticle(
        x + (-4 + Math.random() * 8),
        y + (-4 + Math.random() * 8),
        intensity,
      );
    }
  };

  const cleanupOverlay = (delay = 900) => {
    const { cursor, highlight, badge, root } = ensureOverlay();
    window.setTimeout(() => {
      cursor.classList.remove('visible');
      highlight.classList.remove('visible');
      highlight.classList.remove('emphasized');
      badge.classList.remove('visible');
      delete badge.dataset.followCursor;
      root.querySelectorAll('.brow-automation-ripple').forEach((node) => node.remove());
      root.querySelectorAll('.brow-automation-particle').forEach((node) => node.remove());
    }, delay);
  };

  const getLastHoveredElement = (): HTMLElement | null => {
    const current = (window as Window & { [LAST_HOVERED_KEY]?: Element | null })[LAST_HOVERED_KEY];
    if (current instanceof HTMLElement && current.isConnected) {
      return current;
    }

    delete (window as Window & { [LAST_HOVERED_KEY]?: Element | null })[LAST_HOVERED_KEY];
    return null;
  };

  const setLastHoveredElement = (el: HTMLElement | null) => {
    const hoverWindow = window as Window & { [LAST_HOVERED_KEY]?: Element | null };
    if (el && el.isConnected) {
      hoverWindow[LAST_HOVERED_KEY] = el;
      return;
    }

    delete hoverWindow[LAST_HOVERED_KEY];
  };

  const animateCursorTo = async (
    from: ClickPoint,
    to: ClickPoint,
    durationMs: number,
    scale = 1,
    frame: CursorFrame = 'hand',
  ) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const travel = Math.hypot(dx, dy);
    const tilt = clamp((Math.atan2(dy, dx) * 180 / Math.PI) * 0.12, -18, 10);
    let lastParticleTs = 0;

    await new Promise<void>((resolve) => {
      const start = performance.now();

      const step = (now: number) => {
        const progress = Math.min((now - start) / durationMs, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const x = from.x + dx * eased;
        const y = from.y + dy * eased;
        setCursorPosition(x, y, scale, -8 + tilt, frame);

        if (now - lastParticleTs >= 18) {
          const hotspotX = x + 12;
          const hotspotY = y + 10;
          burstParticles(
            hotspotX,
            hotspotY,
            travel > 180 ? 2 : 1,
            progress < 0.65 ? 1 : 0.7,
          );
          lastParticleTs = now;
        }

        if (progress < 1) {
          window.requestAnimationFrame(step);
          return;
        }

        resolve();
      };

      window.requestAnimationFrame(step);
    });
  };

  const resolvePlanDispatchTarget = (matchedEl: HTMLElement, plan: ClickPlan): HTMLElement => {
    const hit = plan.target.ownerDocument.elementFromPoint(plan.point.x, plan.point.y);
    return isHTMLElementLike(hit) && isRelatedElement(matchedEl, hit)
      ? hit
      : plan.target;
  };

  const dispatchHover = (matchedEl: HTMLElement, plan: ClickPlan) => {
    const target = resolvePlanDispatchTarget(matchedEl, plan);
    const previousTarget = getLastHoveredElement();
    const ownerWindow = target.ownerDocument.defaultView ?? window;
    const shared = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: ownerWindow,
      clientX: plan.point.x,
      clientY: plan.point.y,
      screenX: toScreenX(plan.point.x),
      screenY: toScreenY(plan.point.y),
      detail: 0,
    };

    if (previousTarget && previousTarget !== target) {
      if (typeof PointerEvent === 'function') {
        previousTarget.dispatchEvent(new PointerEvent('pointerout', {
          ...shared,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 0,
          relatedTarget: target,
        }));
        previousTarget.dispatchEvent(new PointerEvent('pointerleave', {
          ...shared,
          bubbles: false,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 0,
          relatedTarget: target,
        }));
      }

      previousTarget.dispatchEvent(new MouseEvent('mouseout', {
        ...shared,
        button: 0,
        buttons: 0,
        relatedTarget: target,
      }));
      previousTarget.dispatchEvent(new MouseEvent('mouseleave', {
        ...shared,
        bubbles: false,
        button: 0,
        buttons: 0,
        relatedTarget: target,
      }));
    }

    if (typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent('pointerover', {
        ...shared,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
        relatedTarget: previousTarget,
      }));
      target.dispatchEvent(new PointerEvent('pointerenter', {
        ...shared,
        bubbles: false,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
        relatedTarget: previousTarget,
      }));
      target.dispatchEvent(new PointerEvent('pointermove', {
        ...shared,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
        relatedTarget: previousTarget,
      }));
    }

    target.dispatchEvent(new MouseEvent('mouseover', {
      ...shared,
      button: 0,
      buttons: 0,
      relatedTarget: previousTarget,
    }));
    target.dispatchEvent(new MouseEvent('mouseenter', {
      ...shared,
      bubbles: false,
      button: 0,
      buttons: 0,
      relatedTarget: previousTarget,
    }));
    target.dispatchEvent(new MouseEvent('mousemove', {
      ...shared,
      button: 0,
      buttons: 0,
      relatedTarget: previousTarget,
    }));

    setLastHoveredElement(target);
  };

  const dispatchClick = (matchedEl: HTMLElement, plan: ClickPlan) => {
    const target = resolvePlanDispatchTarget(matchedEl, plan);
    const ownerWindow = target.ownerDocument.defaultView ?? window;

    target.focus?.({ preventScroll: true });

    if (plan.dispatchMode === 'programmatic') {
      target.click?.();
      return;
    }

    const shared = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: ownerWindow,
      clientX: plan.point.x,
      clientY: plan.point.y,
      screenX: toScreenX(plan.point.x),
      screenY: toScreenY(plan.point.y),
      detail: 1,
    };

    if (typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent('pointerover', {
        ...shared,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
      }));
      target.dispatchEvent(new PointerEvent('pointerdown', {
        ...shared,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 1,
      }));
    }

    target.dispatchEvent(new MouseEvent('mouseover', {
      ...shared,
      button: 0,
      buttons: 0,
    }));
    target.dispatchEvent(new MouseEvent('mousemove', {
      ...shared,
      button: 0,
      buttons: 0,
    }));
    target.dispatchEvent(new MouseEvent('mousedown', {
      ...shared,
      button: 0,
      buttons: 1,
    }));

    if (typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent('pointerup', {
        ...shared,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
      }));
    }

    target.dispatchEvent(new MouseEvent('mouseup', {
      ...shared,
      button: 0,
      buttons: 0,
    }));
    target.dispatchEvent(new MouseEvent('click', {
      ...shared,
      button: 0,
      buttons: 0,
    }));
  };

  const previewClick = async (matchedEl: HTMLElement, message: string) => {
    matchedEl.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(90);
    const plan = resolveClickPlan(matchedEl);
    if (!plan) return;
    const startX = clamp(
      window.innerWidth / 2 - CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - CURSOR_WIDTH, 0),
    );
    const startY = clamp(
      window.innerHeight / 2 - CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - CURSOR_HEIGHT, 0),
    );
    const cursorX = clamp(
      plan.point.x - CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - CURSOR_WIDTH, 0),
    );
    const cursorY = clamp(
      plan.point.y - CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - CURSOR_HEIGHT, 0),
    );
    const rippleX = clamp(plan.point.x, 10, window.innerWidth - 10);
    const rippleY = clamp(plan.point.y, 10, window.innerHeight - 10);

    showHighlight(plan.target);
    showBadgeNearCursor(message, startX, startY);
    setCursorPosition(startX, startY, 0.96, -8, 'hand');
    await sleep(60);
    await animateCursorTo(
      { x: startX, y: startY },
      { x: cursorX, y: cursorY },
      360,
      1,
      'hand',
    );
    setCursorPosition(cursorX, cursorY, 0.9, -8, 'push');
    createRipple(rippleX, rippleY);
    burstParticles(rippleX, rippleY, 8, 1.25);
    await sleep(90);
    setCursorPosition(cursorX, cursorY, 1, -8, 'hand');
  };

  const previewHighlight = async (matchedEl: HTMLElement, message: string) => {
    matchedEl.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(90);
    const plan = resolveClickPlan(matchedEl);
    if (!plan) return;
    const cursorX = clamp(
      plan.point.x - HIGHLIGHT_CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - CURSOR_WIDTH, 0),
    );
    const cursorY = clamp(
      plan.point.y - HIGHLIGHT_CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - CURSOR_HEIGHT, 0),
    );
    showHighlight(plan.target, true);
    setCursorPosition(cursorX, cursorY, 1, 0, 'highlight');
    showBadge(message, plan.rect.right + 14, plan.rect.top - 2);
    positionBadgeNearRect(plan.rect);
    await sleep(180);
  };

  const previewHover = async (matchedEl: HTMLElement, message: string) => {
    matchedEl.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(90);
    const plan = resolveClickPlan(matchedEl);
    if (!plan) return null;
    const startX = clamp(
      window.innerWidth / 2 - CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - CURSOR_WIDTH, 0),
    );
    const startY = clamp(
      window.innerHeight / 2 - CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - CURSOR_HEIGHT, 0),
    );
    const cursorX = clamp(
      plan.point.x - CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - CURSOR_WIDTH, 0),
    );
    const cursorY = clamp(
      plan.point.y - CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - CURSOR_HEIGHT, 0),
    );

    showHighlight(plan.target);
    showBadgeNearCursor(message, startX, startY);
    setCursorPosition(startX, startY, 0.96, -8, 'hand');
    await sleep(60);
    await animateCursorTo(
      { x: startX, y: startY },
      { x: cursorX, y: cursorY },
      340,
      1,
      'hand',
    );
    showHighlight(plan.target, true);
    setCursorPosition(cursorX, cursorY, 1, -8, 'hand');
    await sleep(140);
    return plan;
  };

  const previewFieldEdit = async (el: HTMLElement, message: string) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(90);
    const rect = getVisibleRect(el);
    if (!rect) return;
    const cursorX = clamp(
      rect.left + 8 - PENCIL_CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - CURSOR_WIDTH, 0),
    );
    const cursorY = clamp(
      rect.top + rect.height / 2 - PENCIL_CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - CURSOR_HEIGHT, 0),
    );

    showHighlight(el);
    showBadgeNearCursor(message, cursorX, cursorY);
    setCursorPosition(cursorX, cursorY, 1, 0, 'pencil');
    await sleep(180);
  };

  const dispatchEnter = (target: HTMLElement) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      (target as HTMLInputElement | HTMLTextAreaElement).form?.requestSubmit?.();
    }
  };

  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, nextValue: string) => {
    const ownerWindow = el.ownerDocument.defaultView ?? window;
    const prototype = el.tagName.toLowerCase() === 'textarea'
      ? ownerWindow.HTMLTextAreaElement.prototype
      : ownerWindow.HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (valueSetter) valueSetter.call(el, nextValue);
    else el.value = nextValue;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  type TypeableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

  const isTextInput = (el: HTMLInputElement): boolean => {
    if (el.disabled || el.readOnly) return false;
    const type = (el.type || 'text').toLowerCase();
    return ![
      'button',
      'checkbox',
      'color',
      'file',
      'hidden',
      'image',
      'radio',
      'range',
      'reset',
      'submit',
    ].includes(type);
  };

  const asTypeableElement = (candidate: Element | null): TypeableElement | null => {
    if (!isHTMLElementLike(candidate)) return null;
    if (!isElementVisible(candidate)) return null;
    const tag = candidate.tagName.toLowerCase();
    if (tag === 'input') return isTextInput(candidate as HTMLInputElement) ? candidate : null;
    if (tag === 'textarea') {
      const textarea = candidate as HTMLTextAreaElement;
      return textarea.disabled || textarea.readOnly ? null : candidate;
    }
    if (candidate.isContentEditable) return candidate;
    return null;
  };

  const findTypeTarget = (matchedEl: HTMLElement): TypeableElement | null => {
    const directTarget = asTypeableElement(matchedEl);

    const selector = [
      'input:not([type="hidden"])',
      'textarea',
      '[contenteditable="true"]',
      '[contenteditable=""]',
      '[contenteditable="plaintext-only"]',
    ].join(', ');

    const findIn = (root: Element): TypeableElement | null => (
      Array.from(root.querySelectorAll(selector))
        .map((candidate) => asTypeableElement(candidate))
        .find((candidate): candidate is TypeableElement => Boolean(candidate)) ?? null
    );

    const descendantTarget = findIn(matchedEl);

    let ancestorTarget: TypeableElement | null = null;
    let parent = matchedEl.parentElement;
    let depth = 0;
    while (parent && parent !== document.body && depth < 6) {
      const parentTarget = asTypeableElement(parent) ?? findIn(parent);
      if (parentTarget) {
        ancestorTarget = parentTarget;
        break;
      }
      parent = parent.parentElement;
      depth += 1;
    }

    const activeTarget = asTypeableElement(document.activeElement);
    const visibleTypeTargets = Array.from(document.querySelectorAll(selector))
      .map((candidate) => asTypeableElement(candidate))
      .filter((candidate): candidate is TypeableElement => Boolean(candidate));

    if (directTarget) return directTarget;
    if (descendantTarget) return descendantTarget;
    if (ancestorTarget) return ancestorTarget;
    if (
      activeTarget
      && (activeTarget === matchedEl || matchedEl.contains(activeTarget) || activeTarget.contains(matchedEl))
    ) {
      return activeTarget;
    }

    return visibleTypeTargets.length === 1 ? visibleTypeTargets[0] : null;
  };

  const setTypeableElementValue = (target: TypeableElement, nextValue: string) => {
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      setValue(target as HTMLInputElement | HTMLTextAreaElement, nextValue);
      return;
    }

    target.textContent = nextValue;
    target.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: nextValue,
      inputType: 'insertText',
    }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const commitFilledTextField = async (target: HTMLInputElement | HTMLTextAreaElement) => {
    const normalizedTagName = (target.tagName ?? '').trim().toLowerCase();
    const normalizedRole = (target.getAttribute('role') ?? '').trim().toLowerCase();
    const normalizedAriaAutocomplete = (target.getAttribute('aria-autocomplete') ?? '').trim().toLowerCase();
    const normalizedAriaHaspopup = (target.getAttribute('aria-haspopup') ?? '').trim().toLowerCase();
    const hasAriaControls = Boolean((target.getAttribute('aria-controls') ?? '').trim());
    const commitMode = (
      (normalizedTagName === 'input' || normalizedTagName === 'textarea')
      && (
        normalizedRole === 'combobox'
        || normalizedAriaAutocomplete === 'list'
        || normalizedAriaAutocomplete === 'both'
        || normalizedAriaHaspopup === 'listbox'
        || hasAriaControls
        || target.hasAttribute('list')
      )
    )
      ? 'enter'
      : 'none';

    if (commitMode === 'enter') {
      await sleep(30);
      dispatchEnter(target);
      await sleep(30);
    }
  };

  const setChecked = (el: HTMLInputElement, nextChecked: boolean) => {
    const ownerWindow = el.ownerDocument.defaultView ?? window;
    const checkedSetter = Object.getOwnPropertyDescriptor(
      ownerWindow.HTMLInputElement.prototype,
      'checked',
    )?.set;
    if (checkedSetter) checkedSetter.call(el, nextChecked);
    else el.checked = nextChecked;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const inferMode = (
    el: Element,
    requestedMode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable',
  ): 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable' | 'unknown' => {
    if (requestedMode && requestedMode !== 'auto') return requestedMode;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return 'select';
    if (tag === 'input' && (el as HTMLInputElement).type === 'checkbox') return 'checkbox';
    if (tag === 'input' && (el as HTMLInputElement).type === 'radio') return 'radio';
    if (tag === 'input' || tag === 'textarea') return 'text';
    if (isHTMLElementLike(el) && el.isContentEditable) return 'contenteditable';
    return 'unknown';
  };

  const summarizeElement = (selector: string, el: HTMLElement): InteractiveElementInfo => ({
    selector,
    tagName: el.tagName.toLowerCase(),
    type: (el as HTMLInputElement).type || undefined,
    text: (el.innerText || el.getAttribute('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120),
    role: el.getAttribute('role') || undefined,
    name: el.getAttribute('name') || undefined,
    id: el.id || undefined,
    href: (el as HTMLAnchorElement).href || undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
  });

  const findCommonAncestor = (elements: HTMLElement[]): HTMLElement | null => {
    const [first, ...rest] = elements;
    if (!first) return null;

    let current: HTMLElement | null = first;
    while (current) {
      const candidate = current;
      if (rest.every((element) => candidate === element || candidate.contains(element))) {
        return candidate;
      }
      current = candidate.parentElement;
    }

    return null;
  };

  const inferSubmitControl = (elements: HTMLElement[]): HTMLElement | null => {
    if (elements.length === 0) return null;

    const normalizeSubmitCandidateValue = (value: string | null | undefined): string => (
      (value ?? '').trim().toLowerCase()
    );

    const scoreSubmitCandidate = (candidate: {
      tagName?: string | null;
      type?: string | null;
      role?: string | null;
      text?: string | null;
      name?: string | null;
      id?: string | null;
      testId?: string | null;
    }): number => {
      const positivePatterns: RegExp[] = [
        /\bcontinue\b/i,
        /\bsubmit\b/i,
        /\bnext\b/i,
        /\bsearch\b/i,
        /\bsave\b/i,
        /\bapply\b/i,
        /\breview\b/i,
        /\bcheckout\b/i,
        /\bplace order\b/i,
        /\bfinish\b/i,
        /\blog in\b/i,
        /\bsign in\b/i,
      ];
      const negativePatterns: RegExp[] = [
        /\bcancel\b/i,
        /\bback\b/i,
        /\bclose\b/i,
        /\bdismiss\b/i,
        /\bmenu\b/i,
        /\bdelete\b/i,
        /\bremove\b/i,
        /\breset\b/i,
      ];

      const tagName = normalizeSubmitCandidateValue(candidate.tagName);
      const type = normalizeSubmitCandidateValue(candidate.type);
      const role = normalizeSubmitCandidateValue(candidate.role);
      const textSignals = [candidate.text, candidate.name, candidate.id, candidate.testId]
        .map((value) => normalizeSubmitCandidateValue(value))
        .filter(Boolean);

      let score = 0;
      if (tagName === 'input' && type === 'submit') score += 110;
      else if (tagName === 'button' && type === 'submit') score += 100;
      else if (tagName === 'button') score += 30;
      else if (tagName === 'input' && type === 'button') score += 20;

      if (role === 'button') score += 12;

      for (const signal of textSignals) {
        if (positivePatterns.some((pattern) => pattern.test(signal))) score += 45;
        if (negativePatterns.some((pattern) => pattern.test(signal))) score -= 120;
      }

      return score;
    };

    const chooseSubmitCandidateIndex = (candidates: Array<Parameters<typeof scoreSubmitCandidate>[0]>): number | undefined => {
      if (candidates.length === 0) return undefined;

      const scored = candidates
        .map((candidate, index) => ({ index, score: scoreSubmitCandidate(candidate) }))
        .sort((left, right) => right.score - left.score);

      const best = scored[0];
      if (!best || best.score < 75) return undefined;

      const runnerUp = scored[1];
      if (runnerUp && best.score - runnerUp.score < 25) return undefined;

      return best.index;
    };

    const searchRoots: HTMLElement[] = [];
    const seenRoots = new Set<HTMLElement>();
    let root = findCommonAncestor(elements) ?? document.body;
    let depth = 0;

    while (root && depth < 5) {
      if (!seenRoots.has(root)) {
        searchRoots.push(root);
        seenRoots.add(root);
      }
      if (root === document.body) break;
      root = root.parentElement ?? document.body;
      depth += 1;
    }

    if (!seenRoots.has(document.body)) searchRoots.push(document.body);

    const selector = [
      'button',
      'input[type="submit"]',
      'input[type="button"]',
      '[role="button"]',
    ].join(', ');

    for (const searchRoot of searchRoots) {
      const controls = Array.from(searchRoot.querySelectorAll(selector))
        .filter((candidate): candidate is HTMLElement => isHTMLElementLike(candidate))
        .filter((candidate) => isElementVisible(candidate))
        .filter((candidate) => !elements.includes(candidate))
        .filter((candidate) => candidate.getAttribute('aria-disabled') !== 'true')
        .filter((candidate) => !('disabled' in candidate) || !(candidate as HTMLInputElement | HTMLButtonElement).disabled);

      const inferredIndex = chooseSubmitCandidateIndex(controls.map((candidate) => ({
        tagName: candidate.tagName,
        type: candidate instanceof HTMLInputElement || candidate instanceof HTMLButtonElement
          ? candidate.type
          : candidate.getAttribute('type'),
        role: candidate.getAttribute('role'),
        text: candidate.innerText || candidate.getAttribute('aria-label') || candidate.getAttribute('value'),
        name: candidate.getAttribute('name'),
        id: candidate.id,
        testId: candidate.getAttribute('data-testid') || candidate.getAttribute('data-test'),
      })));

      if (typeof inferredIndex === 'number') {
        return controls[inferredIndex] ?? null;
      }
    }

    return null;
  };

  if (action.kind === 'highlight') {
    const resolved = resolveActionElement(action.selector);
    if (!resolved) {
      return { ok: false, error: `Element not found for selector: ${action.selector}` };
    }
    const { element: el, resolvedSelector } = resolved;

    const plan = resolveClickPlan(el);
    if (!plan) {
      return { ok: false, error: 'Matched element has no visible highlight target' };
    }

    const durationMs = clamp(Math.round(action.durationMs ?? 2200), 600, 10000);
    const message = (action.message ?? `Brow highlighting ${describeElement(el)}`).trim();
    await previewHighlight(el, message || `Brow highlighting ${describeElement(el)}`);
    cleanupOverlay(durationMs);

    return {
      ok: true,
      highlighted: summarizeElement(resolvedSelector, el),
      durationMs,
      message: message || `Brow highlighting ${describeElement(el)}`,
    };
  }

  if (action.kind === 'hover') {
    const resolved = resolveActionElement(action.selector);
    if (!resolved) {
      return { ok: false, error: `Element not found for selector: ${action.selector}` };
    }
    const { element: el, resolvedSelector } = resolved;

    const initialPlan = resolveClickPlan(el);
    if (!initialPlan) {
      return { ok: false, error: 'Matched element has no visible hover target' };
    }

    const durationMs = clamp(Math.round(action.durationMs ?? 1400), 500, 10000);
    const message = (action.message ?? `Brow hovering ${describeElement(el)}`).trim()
      || `Brow hovering ${describeElement(el)}`;
    await previewHover(el, message);
    const finalPlan = resolveClickPlan(el) ?? initialPlan;
    dispatchHover(el, finalPlan);
    cleanupOverlay(durationMs);

    return {
      ok: true,
      hovered: summarizeElement(resolvedSelector, el),
      durationMs,
      message,
    };
  }

  if (action.kind === 'click') {
    const resolved = resolveActionElement(action.selector);
    if (!resolved) {
      return { ok: false, error: `Element not found for selector: ${action.selector}` };
    }
    const { element: el, resolvedSelector } = resolved;

    if ('disabled' in el && Boolean((el as HTMLInputElement).disabled)) {
      return { ok: false, error: 'Matched element is disabled' };
    }

    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(120);

    const initialPlan = resolveClickPlan(el, action.clickPoint);
    if (!initialPlan) {
      return { ok: false, error: 'Matched element has no visible click target' };
    }

    await previewClick(el, `Brow clicking ${describeElement(el)}`);
    const finalPlan = resolveClickPlan(el, action.clickPoint) ?? initialPlan;
    const dispatchPlan = action.clickMode === 'programmatic'
      ? { ...finalPlan, dispatchMode: 'programmatic' as const }
      : finalPlan;
    dispatchPlan.target.focus({ preventScroll: true });
    dispatchClick(el, dispatchPlan);
    cleanupOverlay();

    return {
      ok: true,
      clicked: summarizeElement(resolvedSelector, el),
    };
  }

  if (action.kind === 'drag') {
    const source = resolveActionElement(action.sourceSelector);
    if (!source) {
      return { ok: false, error: `Drag source not found for selector: ${action.sourceSelector}` };
    }
    const destination = resolveActionElement(action.destinationSelector);
    if (!destination) {
      return { ok: false, error: `Drag destination not found for selector: ${action.destinationSelector}` };
    }

    source.element.scrollIntoView({ block: 'center', inline: 'center' });
    destination.element.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(140);

    const sourcePlan = resolveClickPlan(source.element, action.sourceClickPoint);
    const destinationPlan = resolveClickPlan(destination.element, action.destinationClickPoint);
    if (!sourcePlan || !destinationPlan) {
      return { ok: false, error: 'Drag source or destination has no visible interaction point' };
    }

    const dataTransfer = typeof DataTransfer === 'function' ? new DataTransfer() : undefined;
    const eventInit = (point: ClickPoint) => ({
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      screenX: toScreenX(point.x),
      screenY: toScreenY(point.y),
      button: 0,
      buttons: 1,
      view: window,
    });
    const dispatchDragEvent = (target: HTMLElement, type: string, point: ClickPoint) => {
      let event: Event;
      if (typeof DragEvent === 'function') {
        event = new DragEvent(type, { ...eventInit(point), dataTransfer });
      } else {
        event = new Event(type, { bubbles: true, cancelable: true, composed: true });
        Object.assign(event, eventInit(point));
      }
      if (dataTransfer && !('dataTransfer' in event)) {
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      }
      return target.dispatchEvent(event);
    };
    const dispatchMouse = (target: HTMLElement, type: string, point: ClickPoint, buttons: number) => {
      target.dispatchEvent(new MouseEvent(type, { ...eventInit(point), buttons }));
    };

    await previewClick(source.element, `Brow dragging ${describeElement(source.element)}`);
    const path = action.pointerPath?.length
      ? action.pointerPath
      : [
        sourcePlan.point,
        {
          x: (sourcePlan.point.x + destinationPlan.point.x) / 2,
          y: (sourcePlan.point.y + destinationPlan.point.y) / 2,
        },
        destinationPlan.point,
      ];

    source.element.focus({ preventScroll: true });
    dispatchMouse(sourcePlan.target, 'mousedown', sourcePlan.point, 1);
    dispatchDragEvent(sourcePlan.target, 'dragstart', sourcePlan.point);
    for (const point of path) {
      const hit = document.elementFromPoint(point.x, point.y);
      const target = isHTMLElementLike(hit) ? hit : destinationPlan.target;
      dispatchMouse(target, 'mousemove', point, 1);
      dispatchDragEvent(target, 'drag', point);
      await sleep(Math.max(20, Math.min(Math.round((action.durationMs ?? 320) / Math.max(path.length, 1)), 160)));
    }
    dispatchDragEvent(destinationPlan.target, 'dragenter', destinationPlan.point);
    dispatchDragEvent(destinationPlan.target, 'dragover', destinationPlan.point);
    dispatchDragEvent(destinationPlan.target, 'drop', destinationPlan.point);
    dispatchDragEvent(sourcePlan.target, 'dragend', destinationPlan.point);
    dispatchMouse(destinationPlan.target, 'mouseup', destinationPlan.point, 0);
    cleanupOverlay();

    return {
      ok: true,
      dragged: {
        source: summarizeElement(source.resolvedSelector, source.element),
        destination: summarizeElement(destination.resolvedSelector, destination.element),
        pointerPathLength: path.length,
      },
    };
  }

  if (action.kind === 'scroll') {
    const resolved = action.selector ? resolveActionElement(action.selector) : null;
    const target = resolved?.element ?? document.scrollingElement ?? document.documentElement;
    const before = {
      scrollLeft: target === document.scrollingElement || target === document.documentElement ? window.scrollX : (target as HTMLElement).scrollLeft,
      scrollTop: target === document.scrollingElement || target === document.documentElement ? window.scrollY : (target as HTMLElement).scrollTop,
    };

    if (typeof action.top === 'number' || typeof action.left === 'number') {
      if (target === document.scrollingElement || target === document.documentElement) {
        window.scrollTo({
          top: typeof action.top === 'number' ? action.top : window.scrollY,
          left: typeof action.left === 'number' ? action.left : window.scrollX,
          behavior: 'auto',
        });
      } else {
        (target as HTMLElement).scrollTo({
          top: typeof action.top === 'number' ? action.top : (target as HTMLElement).scrollTop,
          left: typeof action.left === 'number' ? action.left : (target as HTMLElement).scrollLeft,
          behavior: 'auto',
        });
      }
    } else if (target === document.scrollingElement || target === document.documentElement) {
      window.scrollBy({ left: action.deltaX ?? 0, top: action.deltaY ?? 0, behavior: 'auto' });
    } else {
      (target as HTMLElement).scrollBy({ left: action.deltaX ?? 0, top: action.deltaY ?? 0, behavior: 'auto' });
    }

    await sleep(80);
    const after = {
      scrollLeft: target === document.scrollingElement || target === document.documentElement ? window.scrollX : (target as HTMLElement).scrollLeft,
      scrollTop: target === document.scrollingElement || target === document.documentElement ? window.scrollY : (target as HTMLElement).scrollTop,
    };

    return {
      ok: true,
      scrolled: {
        target: resolved ? summarizeElement(resolved.resolvedSelector, resolved.element) : { selector: 'window', tagName: 'window', text: 'window' },
        before,
        after,
      },
    };
  }

  if (action.kind === 'key') {
    const resolved = action.selector ? resolveActionElement(action.selector) : null;
    const target = resolved?.element ?? (document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
    target.focus?.({ preventScroll: true });

    if (action.text && !action.key) {
      const typeTarget = findTypeTarget(target);
      if (!typeTarget) return { ok: false, error: 'No typeable target is focused for text insertion' };
      const currentValue = typeTarget instanceof HTMLInputElement || typeTarget instanceof HTMLTextAreaElement
        ? typeTarget.value
        : typeTarget.textContent ?? '';
      setTypeableElementValue(typeTarget, `${currentValue}${action.text}`);
      return {
        ok: true,
        keyed: {
          target: summarizeElement(resolved?.resolvedSelector ?? 'activeElement', target),
          insertedTextLength: action.text.length,
        },
      };
    }

    const key = action.key ?? action.text ?? 'Enter';
    const code = action.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
    const eventBase = {
      key,
      code,
      bubbles: true,
      cancelable: true,
      composed: true,
      altKey: Boolean(action.altKey),
      ctrlKey: Boolean(action.ctrlKey),
      metaKey: Boolean(action.metaKey),
      shiftKey: Boolean(action.shiftKey),
    };
    target.dispatchEvent(new KeyboardEvent('keydown', eventBase));
    if (key.length === 1) {
      target.dispatchEvent(new KeyboardEvent('keypress', eventBase));
    }
    if (key === 'Enter') dispatchEnter(target);
    target.dispatchEvent(new KeyboardEvent('keyup', eventBase));
    return {
      ok: true,
      keyed: {
        target: summarizeElement(resolved?.resolvedSelector ?? 'activeElement', target),
        key,
        code,
        modifiers: {
          altKey: Boolean(action.altKey),
          ctrlKey: Boolean(action.ctrlKey),
          metaKey: Boolean(action.metaKey),
          shiftKey: Boolean(action.shiftKey),
        },
      },
    };
  }

  if (action.kind === 'upload') {
    const resolved = resolveActionElement(action.selector);
    if (!resolved) {
      return { ok: false, error: `Upload control not found for selector: ${action.selector}` };
    }
    const input = resolved.element.tagName.toLowerCase() === 'input'
      ? resolved.element as HTMLInputElement
      : resolved.element.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input || input.type !== 'file') {
      return { ok: false, error: 'Matched element is not a file input or upload control' };
    }
    input.scrollIntoView({ block: 'center', inline: 'center' });
    await previewClick(input, `Brow opening file picker for ${describeElement(input)}`);
    input.click();
    cleanupOverlay();
    return {
      ok: false,
      helperRequired: true,
      backend: 'local-helper',
      error: 'Native file selection requires the local helper backend. MV3 can open the picker but cannot set a local file path safely.',
      upload: {
        control: summarizeElement(resolved.resolvedSelector, input),
        fileName: action.fileName,
        filePath: action.filePath ? '[redacted path]' : undefined,
      },
    };
  }

  if (action.kind === 'handleDialog') {
    const resolved = action.selector ? resolveActionElement(action.selector) : null;
    const dialog = resolved?.element
      ?? document.querySelector<HTMLElement>('dialog[open], [role="dialog"], [aria-modal="true"]');
    if (!dialog) {
      return {
        ok: false,
        helperRequired: true,
        backend: 'local-helper',
        error: 'No HTML dialog was found. Native browser dialogs require the local helper backend.',
      };
    }

    if (dialog instanceof HTMLDialogElement && action.action !== 'accept') {
      dialog.close(action.text ?? '');
      return { ok: true, dialog: { action: action.action, target: summarizeElement(resolved?.resolvedSelector ?? 'dialog[open]', dialog) } };
    }

    const buttonNeedles = action.action === 'dismiss'
      ? ['cancel', 'close', 'dismiss', 'no']
      : ['ok', 'yes', 'accept', 'confirm', 'continue'];
    const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button, [role="button"], input[type="button"], input[type="submit"]'));
    const button = buttons.find((candidate) => {
      const text = normalizeInlineText(candidate.innerText || candidate.getAttribute('aria-label') || candidate.getAttribute('value'));
      return buttonNeedles.some((needle) => text.toLowerCase().includes(needle));
    }) ?? buttons[0];

    if (!button) {
      return { ok: false, error: 'Dialog was found but no actionable dialog control was available' };
    }
    await previewClick(button, `Brow handling dialog`);
    button.click();
    cleanupOverlay();
    return {
      ok: true,
      dialog: {
        action: action.action,
        target: summarizeElement(resolved?.resolvedSelector ?? 'dialog', dialog),
        control: summarizeElement('dialog control', button),
      },
    };
  }

  if (action.kind === 'type') {
    const resolved = resolveActionElement(action.selector);
    if (!resolved) {
      return { ok: false, error: `Element not found for selector: ${action.selector}` };
    }
    const { element: el, resolvedSelector } = resolved;

    const summarize = (target: HTMLElement) => ({
      selector: resolvedSelector,
      tagName: target.tagName.toLowerCase(),
      type: (target as HTMLInputElement).type || undefined,
      text: (target.innerText || target.getAttribute('aria-label') || action.text)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120),
      role: target.getAttribute('role') || undefined,
      name: target.getAttribute('name') || undefined,
      id: target.id || undefined,
      href: (target as HTMLAnchorElement).href || undefined,
      placeholder: target.getAttribute('placeholder') || undefined,
      textLength: action.text.length,
    });

    const typeTarget = findTypeTarget(el);
    if (typeTarget) {
      await previewFieldEdit(typeTarget, `Brow typing into ${describeElement(typeTarget)}`);
      typeTarget.focus({ preventScroll: true });
      setTypeableElementValue(typeTarget, action.text);
      if (action.submit) {
        showBadge('Brow submitting input', 16, 16);
        window.setTimeout(() => dispatchEnter(typeTarget), 30);
      }
      cleanupOverlay();
      return {
        ok: true,
        typed: summarize(typeTarget),
        resolvedFrom: typeTarget === el ? undefined : summarize(el),
      };
    }

    return { ok: false, error: 'Matched element is not typeable' };
  }

  const results: Array<{
    selector: string;
    ok: boolean;
    mode: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable' | 'unknown';
    tagName?: string;
    type?: string;
    value?: string | number | boolean;
    error?: string;
  }> = [];
  let formForSubmit: HTMLFormElement | null = null;
  const successfulFieldElements: HTMLElement[] = [];

  for (const field of action.fields) {
    const selector = typeof field?.selector === 'string' ? field.selector : '';
    if (!selector) {
      results.push({
        selector: '',
        ok: false,
        mode: field?.mode ?? 'auto',
        error: 'Missing selector',
      });
      continue;
    }

    const resolvedField = resolveActionElement(selector);
    if (!resolvedField) {
      results.push({
        selector,
        ok: false,
        mode: field?.mode ?? 'auto',
        value: field?.value,
        error: `Element not found for selector: ${selector}`,
      });
      continue;
    }
    const { element: el, resolvedSelector } = resolvedField;

    const mode = inferMode(el, field.mode);
    const tagName = el.tagName.toLowerCase();
    const type = el instanceof HTMLInputElement ? el.type : undefined;

    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus({ preventScroll: true });

    if (!formForSubmit) {
      const fieldTag = el.tagName.toLowerCase();
      const closestForm = ['input', 'textarea', 'select'].includes(fieldTag)
        ? (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).form
        : el.closest('form');
      if (closestForm && typeof (closestForm as HTMLFormElement).submit === 'function') {
        formForSubmit = closestForm as HTMLFormElement;
      }
    }

    try {
      if (mode === 'text') {
        if (tagName === 'input' || tagName === 'textarea') {
          await previewFieldEdit(el, `Brow typing into ${describeElement(el)}`);
          const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
          setValue(inputEl, String(field.value));
          await commitFilledTextField(inputEl);
          successfulFieldElements.push(inputEl);
          results.push({ selector: resolvedSelector, ok: true, mode, tagName, type, value: field.value });
          continue;
        }
        results.push({
          selector: resolvedSelector,
          ok: false,
          mode,
          tagName,
          type,
          value: field.value,
          error: 'Matched element is not a text input',
        });
        continue;
      }

      if (mode === 'contenteditable') {
        if (el.isContentEditable) {
          await previewFieldEdit(el, `Brow typing into ${describeElement(el)}`);
          el.textContent = String(field.value);
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: String(field.value),
            inputType: 'insertText',
          }));
          successfulFieldElements.push(el);
          results.push({ selector: resolvedSelector, ok: true, mode, tagName, type, value: field.value });
          continue;
        }
        results.push({
          selector: resolvedSelector,
          ok: false,
          mode,
          tagName,
          type,
          value: field.value,
          error: 'Matched element is not contenteditable',
        });
        continue;
      }

      if (mode === 'select') {
        if (tagName === 'select') {
          const selectEl = el as HTMLSelectElement;
          const targetValue = String(field.value).trim();
          const options = Array.from(selectEl.options);
          const option = options.find((candidate) =>
            candidate.value === targetValue ||
            candidate.label === targetValue ||
            candidate.text.trim() === targetValue ||
            candidate.label.toLowerCase() === targetValue.toLowerCase() ||
            candidate.text.trim().toLowerCase() === targetValue.toLowerCase(),
          );

          if (!option) {
            results.push({
              selector: resolvedSelector,
              ok: false,
              mode,
              tagName,
              type,
              value: field.value,
              error: `No option matches "${targetValue}"`,
            });
            continue;
          }

          await previewFieldEdit(el, `Brow selecting ${option.label || option.text}`);
          selectEl.value = option.value;
          option.selected = true;
          selectEl.dispatchEvent(new Event('input', { bubbles: true }));
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
          successfulFieldElements.push(selectEl);
          results.push({ selector: resolvedSelector, ok: true, mode, tagName, type, value: option.value });
          continue;
        }

        results.push({
          selector: resolvedSelector,
          ok: false,
          mode,
          tagName,
          type,
          value: field.value,
          error: 'Matched element is not a select element',
        });
        continue;
      }

      if (mode === 'checkbox' || mode === 'radio') {
        if (tagName === 'input' && (el as HTMLInputElement).type === mode) {
          const inputEl = el as HTMLInputElement;
          const nextChecked = Boolean(field.value);
          await previewClick(el, `${nextChecked ? 'Brow selecting' : 'Brow clearing'} ${describeElement(el)}`);
          if (inputEl.checked !== nextChecked) {
            if (nextChecked) {
              inputEl.click();
            }
            if (inputEl.checked !== nextChecked) {
              setChecked(inputEl, nextChecked);
            }
          }
          successfulFieldElements.push(inputEl);
          results.push({ selector: resolvedSelector, ok: true, mode, tagName, type, value: nextChecked });
          continue;
        }

        results.push({
          selector: resolvedSelector,
          ok: false,
          mode,
          tagName,
          type,
          value: field.value,
          error: `Matched element is not a ${mode} input`,
        });
        continue;
      }

      results.push({
        selector: resolvedSelector,
        ok: false,
        mode,
        tagName,
        type,
        value: field.value,
        error: 'Could not infer how to fill this element',
      });
    } catch (err: any) {
      results.push({
        selector: resolvedSelector,
        ok: false,
        mode,
        tagName,
        type,
        value: field.value,
        error: err?.message ?? 'Failed to fill field',
      });
    }
  }

  let submitted = false;
  let submitError: string | undefined;

  if ((action.submit || action.submitSelector) && results.every((result) => result.ok)) {
    if (action.submitSelector) {
      const resolvedSubmit = resolveActionElement(action.submitSelector);
      if (resolvedSubmit?.element && isHTMLElementLike(resolvedSubmit.element)) {
        const submitEl = resolvedSubmit.element;
        await previewClick(submitEl, `Brow submitting ${describeElement(submitEl)}`);
        submitEl.focus({ preventScroll: true });
        submitEl.click();
        submitted = true;
      } else {
        submitError = `Submit element not found for selector: ${action.submitSelector}`;
      }
    } else if (formForSubmit) {
      showBadge('Brow submitting form', 16, 16);
      window.setTimeout(() => {
        formForSubmit.requestSubmit?.();
        if (!formForSubmit.requestSubmit) formForSubmit.submit();
      }, 30);
      submitted = true;
    } else {
      const inferredSubmit = inferSubmitControl(successfulFieldElements);
      if (inferredSubmit) {
        await previewClick(inferredSubmit, `Brow submitting ${describeElement(inferredSubmit)}`);
        inferredSubmit.focus({ preventScroll: true });
        inferredSubmit.click();
        submitted = true;
      } else {
        submitError = 'No parent form found to submit';
      }
    }
  }

  cleanupOverlay(1000);

  const hadFieldErrors = results.some((result) => !result.ok);
  const outcome: { ok: boolean; warning?: string; error?: string } = hadFieldErrors
    ? {
      ok: false,
      error: 'One or more form fields could not be filled',
    }
    : Boolean(action.submit || action.submitSelector) && submitError
      ? !submitted && submitError === 'No parent form found to submit'
        ? {
          ok: true,
          warning: submitError,
        }
        : {
          ok: false,
          error: submitError,
        }
      : {
        ok: true,
      };
  return {
    ok: outcome.ok,
    results,
    submitted,
    warning: outcome.warning,
    error: outcome.error,
  };
}

async function runPageSettlingProbe(options?: {
  quietMs?: number;
  timeoutMs?: number;
}): Promise<{ ok: boolean; readyState: string; quietMs: number; durationMs: number; error?: string }> {
  const quietMs = Math.max(50, Math.min(Math.floor(options?.quietMs ?? 180), 1000));
  const timeoutMs = Math.max(250, Math.min(Math.floor(options?.timeoutMs ?? 1600), 5000));
  const startedAt = performance.now();

  const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, timeoutMs);
      document.addEventListener('DOMContentLoaded', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  let lastMutationAt = performance.now();
  const observer = new MutationObserver(() => {
    lastMutationAt = performance.now();
  });

  try {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    while (performance.now() - startedAt < timeoutMs) {
      await wait(50);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (performance.now() - lastMutationAt >= quietMs) break;
    }
  } finally {
    observer.disconnect();
  }

  return {
    ok: true,
    readyState: document.readyState,
    quietMs,
    durationMs: Math.round(performance.now() - startedAt),
  };
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

        const buildIdSelector = (value: string): string => (
          canUseHashIdSelector(value)
            ? `#${escapeCss(value)}`
            : `[id="${escapeAttributeValue(value)}"]`
        );

        const isVisible = (el: Element): boolean => {
          const rect = (el as HTMLElement).getBoundingClientRect?.();
          if (!rect || rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };

        const isUnique = (selector: string): boolean => {
          try {
            return document.querySelectorAll(selector).length === 1;
          } catch {
            return false;
          }
        };

        const matchesExactly = (selector: string, el: Element): boolean => {
          try {
            return document.querySelector(selector) === el && isUnique(selector);
          } catch {
            return false;
          }
        };

        const buildAttributeSelector = (
          tag: string,
          attrName: string,
          attrValue: string | null,
        ): string | null => (
          hasReliableValue(attrValue)
            ? `${tag}[${attrName}="${escapeAttributeValue(attrValue)}"]`
            : null
        );

        const buildDomPath = (el: Element): string => {
          const parts: string[] = [];
          let current: Element | null = el;

          while (current && current !== document.body && parts.length < 6) {
            const htmlEl = current as HTMLElement;
            if (hasReliableValue(htmlEl.id)) {
              const idSelector = buildIdSelector(htmlEl.id);
              if (matchesExactly(idSelector, current)) {
                const anchoredSelector = parts.length > 0 ? `${idSelector} > ${parts.join(' > ')}` : idSelector;
                if (matchesExactly(anchoredSelector, el)) return anchoredSelector;
              }
            }

            let part = current.tagName.toLowerCase();
            const parent = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children as HTMLCollectionOf<Element>).filter(
                (child: Element) => child.tagName === current!.tagName,
              );
              if (siblings.length > 1) {
                part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
              }
            }

            parts.unshift(part);
            current = parent;
          }

          return parts.join(' > ');
        };

        const buildSelector = (el: Element): string => {
          const tag = el.tagName.toLowerCase();
          const attrCandidates: Array<string | null> = [
            hasReliableValue((el as HTMLElement).id) ? buildIdSelector((el as HTMLElement).id) : null,
            buildAttributeSelector(tag, 'data-testid', el.getAttribute('data-testid')),
            buildAttributeSelector(tag, 'aria-label', el.getAttribute('aria-label')),
            buildAttributeSelector(tag, 'name', el.getAttribute('name')),
            buildAttributeSelector(tag, 'placeholder', el.getAttribute('placeholder')),
          ];

          for (const candidate of attrCandidates) {
            if (candidate && matchesExactly(candidate, el)) return candidate;
          }

          const domPath = buildDomPath(el);
          return domPath;
        };

        const selector = [
          'a[href]',
          'button',
          'input',
          'textarea',
          'select',
          '[role="button"]',
          '[role="link"]',
          '[contenteditable="true"]',
          '[tabindex]:not([tabindex="-1"])',
        ].join(', ');

        const elements = Array.from(document.querySelectorAll(selector))
          .filter((el) => isVisible(el))
          .slice(0, maxResults)
          .map((el) => {
            const htmlEl = el as HTMLElement;
            const text = cleanText(
              htmlEl.innerText ||
              el.getAttribute('aria-label') ||
              (el as HTMLInputElement).value ||
              el.getAttribute('placeholder') ||
              el.getAttribute('name'),
            ).slice(0, 120);

            return {
              selector: buildSelector(el),
              tagName: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type || undefined,
              text,
              role: el.getAttribute('role') || undefined,
              name: el.getAttribute('name') || undefined,
              id: htmlEl.id || undefined,
              href: (el as HTMLAnchorElement).href || undefined,
              placeholder: el.getAttribute('placeholder') || undefined,
            };
          });

        return elements;
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

    const results = await executeScriptWithTimeout<{ ok: boolean; clicked?: InteractiveElementInfo; error?: string }>(
      {
        target: { tabId },
        func: runPageAutomationAction,
        args: [{ kind: 'click', selector, clickPoint, clickMode }],
      },
      CLICK_EXECUTION_TIMEOUT_MS,
      getBlockedPageExecutionError('Click execution'),
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

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'highlight', selector, message, durationMs }],
    });

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

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'hover', selector, message, durationMs }],
    });

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

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'type', selector, text, submit }],
    });

    return (results?.[0]?.result as { ok: boolean; typed?: InteractiveElementInfo & { textLength: number }; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to type into element' };
  }
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

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'fillForm', fields, submit, submitSelector }],
    });

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
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{
        kind: 'drag',
        sourceSelector,
        destinationSelector,
        sourceClickPoint: options.sourceClickPoint,
        destinationClickPoint: options.destinationClickPoint,
        pointerPath: options.pointerPath,
        durationMs: options.durationMs,
      }],
    });

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
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'scroll', ...options }],
    });

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
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'key', ...options }],
    });

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
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'upload', selector, fileName, filePath }],
    });

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
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'handleDialog', ...options }],
    });

    return (results?.[0]?.result as { ok: boolean; dialog?: unknown; helperRequired?: boolean; backend?: BrowAutomationBackend; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to handle dialog' };
  }
}

export interface BrowserActionResult {
  ok: boolean;
  action?: unknown;
  resolved?: BrowserRefResolution;
  snapshot?: BrowserSnapshot;
  beforeSnapshot?: BrowserSnapshot;
  backend?: BrowAutomationBackend;
  confidence?: number;
  cacheStatus?: BrowActionCacheStatus;
  trace?: BrowActionTrace;
  postconditions?: BrowPostconditionResult[];
  recoveryCandidates?: BrowActionRepairCandidate[];
  repairNeeded?: boolean;
  helperRequired?: boolean;
  warning?: string;
  error?: string;
}

export interface BrowserFormFillField {
  ref: string;
  value: string | number | boolean;
  mode?: FormFillMode;
  targetEvidence?: BrowReplayTargetEvidence;
}

export interface BrowserDragOptions extends BrowserActionOptions {
  sourceClickPoint?: BrowserClickPoint;
  destinationClickPoint?: BrowserClickPoint;
  pointerPath?: Array<{ x: number; y: number }>;
  durationMs?: number;
  destinationTargetEvidence?: BrowReplayTargetEvidence;
}

const SATISFIED_VALUE_REPAIR_ERROR = 'Requested field value already matches the target state. Do not keep acting on this field; take a fresh browser_snapshot with mode="full" or browser_form_snapshot to find the next actionable control.';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureActionBeforeSnapshot(tabId: number): Promise<BrowserSnapshot> {
  return browserSnapshot(tabId, { mode: 'compact', maxElements: ACTION_BEFORE_SNAPSHOT_MAX_ELEMENTS });
}

function snapshotHasRef(snapshot: BrowserSnapshot | undefined, ref: string | undefined): boolean {
  return Boolean(ref && snapshot?.elements.some((element) => element.ref === ref));
}

const INTENT_STOP_WORDS = new Set([
  'about',
  'action',
  'button',
  'click',
  'element',
  'find',
  'for',
  'from',
  'into',
  'open',
  'page',
  'play',
  'press',
  'result',
  'search',
  'select',
  'submit',
  'target',
  'the',
  'this',
  'type',
  'video',
  'with',
]);

function normalizeIntentText(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tokenizeIntent(value: string | undefined): string[] {
  const tokens = normalizeIntentText(value).split(' ').filter(Boolean);
  const unique = new Set<string>();
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (INTENT_STOP_WORDS.has(token)) continue;
    unique.add(token);
  }
  return [...unique];
}

function entryIntentText(entry: BrowserSnapshotElement): string {
  const attrs = entry.attributes ?? {};
  return normalizeIntentText([
    entry.name,
    entry.text,
    entry.role,
    entry.tagName,
    attrs['aria-label'],
    attrs.title,
    attrs.placeholder,
    attrs.name,
    attrs.alt,
  ].filter(Boolean).join(' '));
}

function scoreIntentCandidate(
  entry: BrowserSnapshotElement,
  intentTokens: string[],
  actionKind: BrowActionKind | undefined,
): number {
  if (intentTokens.length === 0) return 0;
  const haystack = entryIntentText(entry);
  if (!haystack) return 0;

  let score = 0;
  let matched = 0;
  for (const token of intentTokens) {
    const tokenPattern = new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    if (tokenPattern.test(haystack)) {
      matched += 1;
      score += 12;
    } else if (haystack.includes(token)) {
      matched += 1;
      score += 7;
    }
  }

  if (matched === 0) return 0;
  const coverage = matched / intentTokens.length;
  score += Math.round(coverage * 24);
  if (coverage >= 0.8) score += 14;
  if (coverage === 1) score += 10;

  if (actionKind === 'type') {
    if (['textbox', 'searchbox', 'combobox'].includes(entry.role)) score += 24;
    if (['input', 'textarea'].includes(entry.tagName)) score += 18;
    const fieldText = haystack;
    if (fieldText.includes('search') || fieldText.includes('rechercher')) score += 14;
  } else if (actionKind === 'click') {
    if (entry.role === 'link') score += 20;
    else if (entry.role === 'button') score += 14;
    else if (entry.role === 'heading') score += 8;
    if (entry.actionable) score += 10;
  }

  const textLength = (entry.name || entry.text || '').length;
  if (textLength > 220) score -= 12;
  return score;
}

function repairCandidateFromSnapshotEntry(entry: BrowserSnapshotElement, score: number): BrowActionRepairCandidate {
  return {
    ref: entry.ref,
    selector: entry.selector,
    role: entry.role,
    name: entry.name,
    tagName: entry.tagName,
    score,
    bounds: entry.bounds,
    attributes: entry.attributes,
  };
}

function findIntentCandidate(
  snapshot: BrowserSnapshot | undefined,
  intent: string | undefined,
  actionKind: BrowActionKind | undefined,
  requireActionable: boolean,
): { candidate?: BrowActionRepairCandidate; candidates: BrowActionRepairCandidate[]; ambiguous?: boolean } {
  if (!snapshot?.ok || !intent || !['click', 'type'].includes(actionKind ?? '')) {
    return { candidates: [] };
  }
  const intentTokens = tokenizeIntent(intent);
  if (intentTokens.length === 0) return { candidates: [] };

  const scored = snapshot.elements
    .filter((entry) => {
      if (requireActionable && !entry.actionable) return false;
      if (!isIntentRecoveryEntryAllowed(entry, actionKind)) return false;
      if (actionKind === 'type') {
        return entry.actionable
          && (['textbox', 'searchbox', 'combobox'].includes(entry.role) || ['input', 'textarea'].includes(entry.tagName));
      }
      return true;
    })
    .map((entry) => ({
      entry,
      score: scoreIntentCandidate(entry, intentTokens, actionKind),
    }))
    .filter((item) => item.score >= INTENT_MATCH_THRESHOLD)
    .sort((left, right) => right.score - left.score);

  const candidates = scored.slice(0, 5).map((item) => repairCandidateFromSnapshotEntry(item.entry, item.score));
  const [best, second] = scored;
  if (!best) return { candidates };
  if (second && best.score - second.score < INTENT_MATCH_MARGIN) {
    return { candidates, ambiguous: true };
  }
  return { candidate: candidates[0], candidates };
}

export async function waitForTabSettled(
  tabId: number,
  timeoutMs = 1600,
): Promise<{ ok: boolean; readyState?: string; quietMs?: number; durationMs?: number; error?: string }> {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab?.status === 'loading') {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const current = await chrome.tabs.get(tabId).catch(() => undefined);
        if (current?.status !== 'loading') break;
        await delay(100);
      }
    }

    const results = await executeScriptWithTimeout<{ ok: boolean; readyState: string; quietMs: number; durationMs: number; error?: string }>(
      {
        target: { tabId },
        func: runPageSettlingProbe,
        args: [{ timeoutMs }],
      },
      Math.max(timeoutMs + PAGE_SETTLE_TIMEOUT_SLACK_MS, 600),
      getBlockedPageExecutionError('Page settling probe'),
    );

    return (results?.[0]?.result as { ok: boolean; readyState: string; quietMs: number; durationMs: number; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab while waiting for page stability' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to wait for page stability' };
  }
}

function emptyBrowserSnapshot(tabId: number, error: string): BrowserSnapshot {
  return {
    ok: false,
    snapshotId: '',
    tabId,
    url: '',
    title: '',
    generatedAt: Date.now(),
    viewport: { width: 0, height: 0, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    elements: [],
    visibleElementCount: 0,
    displayedElementCount: 0,
    omittedElementCount: 0,
    error,
  };
}

function emptyBrowserFormSnapshot(tabId: number, error: string): BrowserFormSnapshot {
  return {
    ok: false,
    snapshotId: '',
    tabId,
    url: '',
    title: '',
    generatedAt: Date.now(),
    forms: [],
    fields: [],
    fieldCount: 0,
    visibleFieldCount: 0,
    fillTargetCount: 0,
    omittedFieldCount: 0,
    error,
  };
}

function isBrowserSnapshotResult(
  result: BrowserSnapshotOperationResult | undefined,
): result is BrowserSnapshot {
  return Boolean(result && typeof result === 'object' && 'elements' in result);
}

function isBrowserFormSnapshotResult(
  result: BrowserSnapshotOperationResult | undefined,
): result is BrowserFormSnapshot {
  return Boolean(result && typeof result === 'object' && 'forms' in result && 'fields' in result);
}

function isBrowserRefResolutionResult(
  result: BrowserSnapshotOperationResult | undefined,
): result is BrowserRefResolution {
  return Boolean(result && typeof result === 'object' && 'ok' in result && !isBrowserSnapshotResult(result) && !isBrowserFormSnapshotResult(result));
}

async function sendBrowserSnapshotOperation(
  tabId: number,
  operation: BrowserSnapshotOperation,
): Promise<BrowserSnapshotOperationMessageResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'BROWSER_SNAPSHOT_OPERATION', payload: { tabId, operation } },
      (response: BrowserSnapshotOperationMessageResult | undefined) => {
        const runtimeError = chrome.runtime.lastError?.message;
        if (runtimeError) {
          resolve({ ok: false, error: runtimeError });
          return;
        }
        resolve(response ?? { ok: false, error: 'No response from background while running browser snapshot operation' });
      },
    );
  });
}

export async function browserSnapshot(
  tabId: number,
  options: BrowserSnapshotOptions = {},
): Promise<BrowserSnapshot> {
  try {
    await waitForTabSettled(tabId);
    const response = await sendBrowserSnapshotOperation(tabId, { kind: 'snapshot', tabId, options });
    if (response.ok && isBrowserSnapshotResult(response.result)) return response.result;
    return emptyBrowserSnapshot(tabId, response.error ?? 'No response from tab');
  } catch (err: any) {
    return emptyBrowserSnapshot(tabId, err?.message ?? 'Failed to capture browser snapshot');
  }
}

export async function browserFormSnapshot(
  tabId: number,
  options: BrowserFormSnapshotOptions = {},
): Promise<BrowserFormSnapshot> {
  try {
    await waitForTabSettled(tabId);
    const response = await sendBrowserSnapshotOperation(tabId, { kind: 'formSnapshot', tabId, options });
    if (response.ok && isBrowserFormSnapshotResult(response.result)) return response.result;
    return emptyBrowserFormSnapshot(tabId, response.error ?? 'No response from tab');
  } catch (err: any) {
    return emptyBrowserFormSnapshot(tabId, err?.message ?? 'Failed to capture browser form snapshot');
  }
}

export async function browserResolveRef(
  tabId: number,
  ref: string,
  snapshotId?: string,
  requireActionable = false,
): Promise<BrowserRefResolution> {
  try {
    const response = await sendBrowserSnapshotOperation(tabId, {
      kind: 'resolve',
      tabId,
      ref,
      snapshotId,
      requireActionable,
    });
    if (response.ok && isBrowserRefResolutionResult(response.result)) {
      return response.result;
    }
    return { ok: false, ref, snapshotId, error: response.error ?? 'No response from tab' };
  } catch (err: any) {
    return { ok: false, ref, snapshotId, error: err?.message ?? 'Failed to resolve element ref' };
  }
}

async function browserResolveTargetEvidence(
  tabId: number,
  target: BrowReplayTargetEvidence,
  requireActionable = false,
): Promise<BrowserRefResolution> {
  try {
    await waitForTabSettled(tabId);
    const response = await sendBrowserSnapshotOperation(tabId, {
      kind: 'resolveTarget',
      tabId,
      target,
      requireActionable,
    });
    if (response.ok && isBrowserRefResolutionResult(response.result)) {
      return response.result;
    }
    return { ok: false, error: response.error ?? 'No response from tab while resolving target evidence' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to resolve target evidence' };
  }
}

async function resolveActionTarget(params: {
  tabId: number;
  ref?: string;
  snapshotId?: string;
  requireActionable: boolean;
  actionKind?: BrowActionKind;
  options?: BrowserActionOptions;
  beforeSnapshot?: BrowserSnapshot;
}): Promise<BrowserRefResolution> {
  let refResolution: BrowserRefResolution | undefined;
  const evidenceRef = params.options?.targetEvidence?.observedRef ?? params.options?.targetEvidence?.ref;
  const candidateRef = params.ref ?? evidenceRef;
  const candidateSnapshotId = params.snapshotId ?? params.options?.targetEvidence?.snapshotId;
  const freshSnapshot = snapshotHasRef(params.beforeSnapshot, candidateRef) ? params.beforeSnapshot : undefined;
  const freshSnapshotId = freshSnapshot
    ? freshSnapshot.snapshotId
    : undefined;
  const recoveryCandidates: BrowActionRepairCandidate[] = [];

  if (candidateRef) {
    refResolution = await browserResolveRef(
      params.tabId,
      candidateRef,
      candidateSnapshotId,
      params.requireActionable,
    );
    if (refResolution.ok && refResolution.selector) {
      return {
        ...refResolution,
        backend: 'mv3-dom',
        confidence: refResolution.matchScore ?? 100,
      };
    }

    if (
      freshSnapshotId
      && candidateSnapshotId
      && freshSnapshotId !== candidateSnapshotId
      && refResolution.error?.includes('Unknown element ref')
    ) {
      const freshResolution = await browserResolveRef(
        params.tabId,
        candidateRef,
        freshSnapshotId,
        params.requireActionable,
      );
      if (freshResolution.ok && freshResolution.selector) {
        return {
          ...freshResolution,
          originalRef: candidateRef,
          recovered: true,
          backend: 'mv3-dom',
          confidence: freshResolution.matchScore ?? 100,
          message: `Recovered ref ${candidateRef} from fresh pre-action snapshot after stale snapshotId failed.`,
        };
      }
    }

    if (refResolution.error?.includes('Unknown element ref')) {
      const expandedSnapshot = await browserSnapshot(params.tabId, {
        mode: 'full',
        maxElements: ACTION_EXPANDED_SNAPSHOT_MAX_ELEMENTS,
      });

      const intentMatch = findIntentCandidate(
        expandedSnapshot.ok ? expandedSnapshot : params.beforeSnapshot,
        params.options?.intent,
        params.actionKind,
        params.requireActionable,
      );
      recoveryCandidates.push(...intentMatch.candidates);

      if (intentMatch.candidate && expandedSnapshot.ok) {
        const semanticResolution = await browserResolveRef(
          params.tabId,
          intentMatch.candidate.ref,
          expandedSnapshot.snapshotId,
          params.requireActionable,
        );
        if (semanticResolution.ok && semanticResolution.selector) {
          return {
            ...semanticResolution,
            originalRef: candidateRef,
            recovered: true,
            backend: 'mv3-dom',
            confidence: intentMatch.candidate.score,
            matchScore: intentMatch.candidate.score,
            repairCandidates: intentMatch.candidates,
            message: `Recovered stale ref ${candidateRef} by matching action intent against expanded pre-action snapshot.`,
          };
        }
      }

      if (intentMatch.ambiguous && refResolution) {
        refResolution = {
          ...refResolution,
          snapshot: expandedSnapshot.ok ? expandedSnapshot : refResolution.snapshot,
          repairCandidates: intentMatch.candidates,
          error: `${refResolution.error} Multiple current elements matched the action intent; choose one of the repair candidates from a fresh browser_snapshot.`,
        };
      }
    }
  }

  if (refResolution && recoveryCandidates.length > 0 && !refResolution.repairCandidates) {
    refResolution = {
      ...refResolution,
      repairCandidates: recoveryCandidates,
    };
  }

  if (params.options?.targetEvidence) {
    const evidenceResolution = await browserResolveTargetEvidence(
      params.tabId,
      params.options.targetEvidence,
      params.requireActionable,
    );
    if (evidenceResolution.ok && evidenceResolution.selector) {
      return {
        ...evidenceResolution,
        originalRef: candidateRef,
        backend: 'mv3-dom',
        confidence: evidenceResolution.matchScore,
      };
    }
    return {
      ...evidenceResolution,
      originalRef: candidateRef,
      error: evidenceResolution.error ?? refResolution?.error ?? 'Unable to resolve target evidence',
    };
  }

  return refResolution ?? {
    ok: false,
    ref: params.ref,
    snapshotId: params.snapshotId,
    repairCandidates: recoveryCandidates.length > 0 ? recoveryCandidates : undefined,
    error: 'Provide either a live ref or targetEvidence for this browser action.',
  };
}

async function browserResolveMemoryTarget(
  tabId: number,
  target: BrowActionMemoryTarget,
  requireActionable = true,
): Promise<BrowserMemoryResolution> {
  try {
    await waitForTabSettled(tabId);
    const response = await sendBrowserSnapshotOperation(tabId, {
      kind: 'resolveMemory',
      tabId,
      target,
      requireActionable,
    });
    if (response.ok && isBrowserRefResolutionResult(response.result)) {
      return response.result;
    }
    return { ok: false, error: response.error ?? 'No response from tab while resolving cached action target' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to resolve cached action target' };
  }
}

async function snapshotAfterAction(tabId: number): Promise<BrowserSnapshot> {
  await delay(180);
  await waitForTabSettled(tabId);
  return browserSnapshot(tabId, { mode: 'compact', maxElements: 80 });
}

async function waitForClickPostconditions(
  tabId: number,
  snapshot: BrowserSnapshot,
  postconditions: BrowActionPostcondition[] | undefined,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ snapshot: BrowserSnapshot; results: BrowPostconditionResult[]; waitedMs: number }> {
  let currentSnapshot = snapshot;
  let results = await evaluatePostconditions(tabId, currentSnapshot, postconditions);

  if (postconditionsPassed(results) || !postconditions || postconditions.length === 0) {
    return { snapshot: currentSnapshot, results, waitedMs: 0 };
  }

  const timeoutMs = Math.max(250, Math.min(Math.floor(options.timeoutMs ?? 1800), 5000));
  const pollMs = Math.max(100, Math.min(Math.floor(options.pollMs ?? 250), 1000));
  const startedAt = Date.now();

  while (!postconditionsPassed(results) && Date.now() - startedAt < timeoutMs) {
    await delay(pollMs);
    currentSnapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 80 });
    results = await evaluatePostconditions(tabId, currentSnapshot, postconditions);
  }

  return {
    snapshot: currentSnapshot,
    results,
    waitedMs: Date.now() - startedAt,
  };
}

function createActionTrace(
  tabId: number,
  actionKind: BrowActionKind,
  options?: BrowserActionOptions,
): BrowActionTrace {
  return {
    traceId: globalThis.crypto?.randomUUID?.()
      ?? `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    tabId,
    actionKind,
    intent: options?.intent,
    cacheStatus: options?.intent && options.useActionMemory !== false ? 'miss' : 'disabled',
    startedAt: Date.now(),
  };
}

function completeTrace(trace: BrowActionTrace): BrowActionTrace {
  return {
    ...trace,
    completedAt: Date.now(),
  };
}

function snapshotContainsText(snapshot: BrowserSnapshot, needle: string): boolean {
  const normalizedNeedle = needle.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalizedNeedle) return true;
  return snapshot.elements.some((element) =>
    `${element.name ?? ''} ${element.text ?? ''}`.replace(/\s+/g, ' ').trim().toLowerCase().includes(normalizedNeedle),
  );
}

async function recentDownloadAppeared(needle?: string): Promise<{ ok: boolean; actual?: string; error?: string }> {
  try {
    if (!chrome.downloads?.search) {
      return { ok: false, error: 'chrome.downloads permission/API is unavailable' };
    }
    const downloads = await chrome.downloads.search({
      limit: 25,
      orderBy: ['-startTime'],
      startedAfter: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    const normalizedNeedle = (needle ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const match = downloads.find((item) => {
      const haystack = `${item.filename ?? ''} ${item.url ?? ''} ${item.finalUrl ?? ''}`.toLowerCase();
      return !normalizedNeedle || haystack.includes(normalizedNeedle);
    });
    return {
      ok: Boolean(match),
      actual: match?.filename ?? match?.url,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to inspect downloads' };
  }
}

async function readMediaState(tabId: number): Promise<{ ok: boolean; actual?: string; error?: string }> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const media = Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'))
          .filter((element) => element.offsetWidth > 0 || element.offsetHeight > 0);
        const target = media[0];
        if (!target) return { ok: false, error: 'No visible media element found' };
        return { ok: true, actual: target.paused ? 'paused' : 'playing' };
      },
    });
    return (results?.[0]?.result as { ok: boolean; actual?: string; error?: string } | undefined)
      ?? { ok: false, error: 'No response while reading media state' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to read media state' };
  }
}

// ─── Date-aware valueEquals fallback ────────────────────────────────────────
// Date inputs often reformat typed values (e.g. "10/05/2026" → "dim. 10 mai").
// This helper tries to parse both sides as dates and compares day+month+year
// so postconditions set by the LLM don't spuriously fail after reformatting.

const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0, janvier: 0, ene: 0, enero: 0,
  feb: 1, february: 1, février: 1, fevrier: 1,
  mar: 2, march: 2, mars: 2, marzo: 2,
  apr: 3, april: 3, avril: 3, abr: 3, abril: 3,
  may: 4, mai: 4, mayo: 4,
  jun: 5, june: 5, juin: 5, junio: 5,
  jul: 6, july: 6, juillet: 6, julio: 6,
  aug: 7, august: 7, août: 7, aout: 7, ago: 7, agosto: 7,
  sep: 8, sept: 8, september: 8, septembre: 8, septiembre: 8,
  oct: 9, october: 9, octobre: 9, octubre: 9,
  nov: 10, november: 10, novembre: 10, noviembre: 10,
  dec: 11, december: 11, décembre: 11, decembre: 11, dic: 11, diciembre: 11,
};

function extractDateParts(value: string): { day: number; month: number; year?: number } | null {
  // Try numeric formats: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, DD-MM-YYYY
  const slashDot = value.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (slashDot) {
    const [, a, b, c] = slashDot;
    const n1 = Number(a); const n2 = Number(b); const n3 = Number(c);
    const year = n3 < 100 ? n3 + 2000 : n3;
    // DD/MM/YYYY (European) when first number ≤ 31 and second ≤ 12
    if (n1 <= 31 && n2 >= 1 && n2 <= 12) return { day: n1, month: n2 - 1, year };
    // MM/DD/YYYY (US) fallback
    if (n1 >= 1 && n1 <= 12 && n2 <= 31) return { day: n2, month: n1 - 1, year };
  }
  const isoDash = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoDash) {
    return { day: Number(isoDash[3]), month: Number(isoDash[2]) - 1, year: Number(isoDash[1]) };
  }

  // Try localized text: "dim. 10 mai", "10 mai", "May 10", "10 May 2026"
  const words = value.replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;
  for (const word of words) {
    const num = Number(word);
    if (Number.isFinite(num) && num >= 1 && num <= 31 && day === undefined) { day = num; continue; }
    if (Number.isFinite(num) && num >= 1900 && num <= 2100) { year = num; continue; }
    const m = MONTH_NAMES[word.toLowerCase()];
    if (m !== undefined) { month = m; continue; }
  }
  if (day !== undefined && month !== undefined) return { day, month, year };
  return null;
}

function valuesMatchAfterReformat(expected: string, actual: string): boolean {
  const e = extractDateParts(expected);
  const a = extractDateParts(actual);
  if (!e || !a) return false;
  if (e.day !== a.day || e.month !== a.month) return false;
  // If both have years, they must match; if only one has a year, accept
  if (e.year !== undefined && a.year !== undefined && e.year !== a.year) return false;
  return true;
}

async function evaluatePostconditions(
  tabId: number,
  snapshot: BrowserSnapshot,
  postconditions: BrowActionPostcondition[] | undefined,
): Promise<BrowPostconditionResult[]> {
  if (!postconditions || postconditions.length === 0) return [];

  const results: BrowPostconditionResult[] = [];
  for (const condition of postconditions) {
    try {
      if (condition.type === 'urlIncludes') {
        const actual = snapshot.url;
        results.push({ ok: actual.includes(condition.value), condition, actual });
        continue;
      }
      if (condition.type === 'urlMatches') {
        const actual = snapshot.url;
        results.push({ ok: new RegExp(condition.value).test(actual), condition, actual });
        continue;
      }
      if (condition.type === 'titleIncludes') {
        const actual = snapshot.title;
        results.push({ ok: actual.toLowerCase().includes(condition.value.toLowerCase()), condition, actual });
        continue;
      }
      if (condition.type === 'textVisible') {
        results.push({ ok: snapshotContainsText(snapshot, condition.value), condition });
        continue;
      }
      if (condition.type === 'textAbsent') {
        results.push({ ok: !snapshotContainsText(snapshot, condition.value), condition });
        continue;
      }
      if (condition.type === 'elementVisible') {
        const resolution = await browserResolveRef(tabId, condition.ref, condition.snapshotId, false);
        results.push({ ok: resolution.ok && Boolean(resolution.region), condition, actual: resolution.entry?.name });
        continue;
      }
      if (condition.type === 'elementHidden') {
        const resolution = await browserResolveRef(tabId, condition.ref, condition.snapshotId, false);
        results.push({ ok: !resolution.ok || !resolution.region, condition, actual: resolution.entry?.name });
        continue;
      }
      if (condition.type === 'valueEquals') {
        const resolution = await browserResolveRef(tabId, condition.ref, condition.snapshotId, false);
        const actual = resolution.entry?.text ?? resolution.entry?.name ?? '';
        const normalizedActual = actual.replace(/\s+/g, ' ').trim().toLowerCase();
        const normalizedExpected = (condition.value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        const matched = actual === condition.value
          || normalizedActual === normalizedExpected
          || normalizedActual.includes(normalizedExpected)
          || normalizedExpected.includes(normalizedActual)
          || valuesMatchAfterReformat(normalizedExpected, normalizedActual);
        results.push({ ok: matched, condition, actual });
        continue;
      }
      if (condition.type === 'downloadAppeared') {
        const download = await recentDownloadAppeared(condition.value);
        results.push({ ok: download.ok, condition, actual: download.actual, error: download.error });
        continue;
      }
      if (condition.type === 'dialogClosed') {
        const normalized = (condition.value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        const openDialog = snapshot.elements.some((element) => {
          if (element.role !== 'dialog' && element.attributes?.['aria-modal'] !== 'true') return false;
          if (!normalized) return true;
          return `${element.name ?? ''} ${element.text ?? ''}`.toLowerCase().includes(normalized);
        });
        results.push({ ok: !openDialog, condition, actual: openDialog ? 'dialog still visible' : 'closed' });
        continue;
      }
      if (condition.type === 'mediaState') {
        const media = await readMediaState(tabId);
        results.push({ ok: media.ok && media.actual === condition.value, condition, actual: media.actual, error: media.error });
      }
    } catch (err: any) {
      results.push({ ok: false, condition, error: err?.message ?? 'Postcondition check failed' });
    }
  }

  return results;
}

function postconditionsPassed(results: BrowPostconditionResult[]): boolean {
  return results.every((result) => result.ok);
}

function normalizeNavigatedUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    }
    return parsed.toString();
  } catch {
    return value.trim() || undefined;
  }
}

function urlsMatchAfterNavigation(actualUrl: string | undefined, expectedUrl: string | undefined): boolean {
  const normalizedActual = normalizeNavigatedUrl(actualUrl);
  const normalizedExpected = normalizeNavigatedUrl(expectedUrl);
  if (!normalizedActual || !normalizedExpected) return false;
  return normalizedActual === normalizedExpected;
}

function hasOnlyTextPostconditionFailures(results: BrowPostconditionResult[]): boolean {
  const failed = results.filter((result) => !result.ok);
  return failed.length > 0
    && failed.every((result) => result.condition.type === 'textVisible' || result.condition.type === 'textAbsent');
}

function getSuccessfulNavigationWarning(params: {
  beforeSnapshot?: BrowserSnapshot;
  snapshot: BrowserSnapshot;
  action: unknown;
  postconditions: BrowPostconditionResult[];
}): string | undefined {
  const clickedHref = (params.action as any)?.clicked?.href as string | undefined;
  const beforeUrl = params.beforeSnapshot?.url;
  const afterUrl = params.snapshot.url;

  if (!clickedHref || !beforeUrl || !afterUrl) return undefined;
  if (normalizeNavigatedUrl(beforeUrl) === normalizeNavigatedUrl(afterUrl)) return undefined;
  if (!urlsMatchAfterNavigation(afterUrl, clickedHref)) return undefined;
  if (!hasOnlyTextPostconditionFailures(params.postconditions)) return undefined;

  return 'Click navigated to the clicked href, but the requested text postconditions did not match the destination page. Continue from the returned snapshot or prefer urlIncludes/elementVisible for page-opening clicks.';
}

function getExpectedClickNavigationHref(
  action: unknown,
  beforeSnapshot?: BrowserSnapshot,
): string | undefined {
  const clickedHref = (action as any)?.clicked?.href as string | undefined;
  const beforeUrl = beforeSnapshot?.url;
  if (!clickedHref || !beforeUrl) return undefined;

  try {
    const parsedHref = new URL(clickedHref);
    if (!['http:', 'https:'].includes(parsedHref.protocol)) return undefined;
    const normalizedHref = normalizeNavigatedUrl(parsedHref.toString());
    const normalizedBefore = normalizeNavigatedUrl(beforeUrl);
    if (!normalizedHref || !normalizedBefore || normalizedHref === normalizedBefore) return undefined;
    return parsedHref.toString();
  } catch {
    return undefined;
  }
}

function shouldRetryProgrammaticClickForNavigation(params: {
  beforeSnapshot?: BrowserSnapshot;
  snapshot: BrowserSnapshot;
  action: unknown;
}): boolean {
  const expectedHref = getExpectedClickNavigationHref(params.action, params.beforeSnapshot);
  const beforeUrl = params.beforeSnapshot?.url;
  const afterUrl = params.snapshot.url;
  if (!expectedHref || !beforeUrl || !afterUrl) return false;
  if (urlsMatchAfterNavigation(afterUrl, expectedHref)) return false;
  return normalizeNavigatedUrl(beforeUrl) === normalizeNavigatedUrl(afterUrl);
}

function getMissedClickNavigationError(params: {
  beforeSnapshot?: BrowserSnapshot;
  snapshot: BrowserSnapshot;
  action: unknown;
}): string | undefined {
  const expectedHref = getExpectedClickNavigationHref(params.action, params.beforeSnapshot);
  const beforeUrl = params.beforeSnapshot?.url;
  const afterUrl = params.snapshot.url;
  if (!expectedHref || !beforeUrl || !afterUrl) return undefined;
  if (urlsMatchAfterNavigation(afterUrl, expectedHref)) return undefined;
  if (normalizeNavigatedUrl(beforeUrl) === normalizeNavigatedUrl(afterUrl)) {
    return 'Click targeted a navigable link, but the page stayed on the current URL instead of opening the clicked href.';
  }
  return 'Click targeted a navigable link, but the page did not reach the clicked href.';
}

async function navigateTabToClickedHref(
  tabId: number,
  href: string,
  postconditions: BrowActionPostcondition[] | undefined,
): Promise<{
  ok: boolean;
  snapshot?: BrowserSnapshot;
  postconditions?: BrowPostconditionResult[];
  error?: string;
}> {
  try {
    await chrome.tabs.update(tabId, { url: href });
    let snapshot = await snapshotAfterAction(tabId);
    let results = await evaluatePostconditions(tabId, snapshot, postconditions);
    if (!postconditionsPassed(results)) {
      const waited = await waitForClickPostconditions(tabId, snapshot, postconditions);
      snapshot = waited.snapshot;
      results = waited.results;
    }
    return {
      ok: true,
      snapshot,
      postconditions: results,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message ?? 'Failed to open the clicked href via tab navigation fallback',
    };
  }
}

function actionKindRequiresActionableRef(actionKind: BrowActionKind): boolean {
  return actionKind !== 'click';
}

async function tryReplaySingleTargetAction(params: {
  tabId: number;
  actionKind: Exclude<BrowActionKind, 'fillForm'>;
  options?: BrowserActionOptions;
  trace: BrowActionTrace;
  execute: (selector: string, clickMode?: ClickDispatchMode) => Promise<unknown>;
}): Promise<BrowserActionResult | null> {
  if (!params.options?.intent || params.options.useActionMemory === false) {
    params.trace.cacheStatus = 'disabled';
    return null;
  }

  const activeSnapshot = await browserSnapshot(params.tabId, { mode: 'compact', maxElements: 1 });
  const lookup = await findActionMemoryEntry({
    actionKind: params.actionKind,
    intent: params.options.intent,
    url: activeSnapshot.url,
  });
  params.trace.cacheKey = lookup.cacheKey;
  if (!lookup.entry?.target) {
    params.trace.cacheStatus = 'miss';
    return null;
  }

  params.trace.cacheStatus = 'hit';
  params.trace.memoryEntryId = lookup.entry.id;
  const resolved = await browserResolveMemoryTarget(
    params.tabId,
    lookup.entry.target,
    actionKindRequiresActionableRef(params.actionKind),
  );
  params.trace.matchScore = resolved.matchScore;
  params.trace.preconditions = resolved.preconditions;
  params.trace.snapshotId = resolved.snapshotId;
  params.trace.resolvedRef = resolved.ref;

  if (!resolved.ok || !resolved.selector) {
    params.trace.cacheStatus = 'stale';
    params.trace.recoveryDecision = resolved.error ?? 'cached target could not be replayed';
    return null;
  }

  let action = await params.execute(resolved.selector);
  let snapshot = await snapshotAfterAction(params.tabId);
  let postconditions = await evaluatePostconditions(params.tabId, snapshot, params.options.postconditions);
  if (params.actionKind === 'click' && Boolean((action as any).ok) && !postconditionsPassed(postconditions)) {
    const waited = await waitForClickPostconditions(params.tabId, snapshot, params.options.postconditions);
    snapshot = waited.snapshot;
    postconditions = waited.results;
    if (postconditionsPassed(postconditions) && waited.waitedMs > 0) {
      params.trace.recoveryDecision = `Waited ${waited.waitedMs}ms for click postconditions to settle after cached action replay.`;
    }
  }

  if (params.actionKind === 'click' && Boolean((action as any).ok) && shouldRetryProgrammaticClickForNavigation({
    beforeSnapshot: activeSnapshot,
    snapshot,
    action,
  })) {
    const repairAttempt = await params.execute(resolved.selector, 'programmatic');
    let repairSnapshot = await snapshotAfterAction(params.tabId);
    let repairPostconditions = await evaluatePostconditions(params.tabId, repairSnapshot, params.options.postconditions);
    if (!postconditionsPassed(repairPostconditions)) {
      const waited = await waitForClickPostconditions(params.tabId, repairSnapshot, params.options.postconditions);
      repairSnapshot = waited.snapshot;
      repairPostconditions = waited.results;
    }
    action = Boolean((repairAttempt as any).ok)
      ? {
        ...(repairAttempt as any),
        initialAttempt: action,
      }
      : {
        ...(action as any),
        repairAttempt,
      };
    snapshot = repairSnapshot;
    postconditions = repairPostconditions;
    params.trace.recoveryDecision = 'Retried click with programmatic dispatch after the initial click did not navigate to the clicked href.';
  }

  params.trace.execution = action as Record<string, unknown>;
  params.trace.postconditions = postconditions;

  const missedNavigationError = params.actionKind === 'click' && Boolean((action as any).ok)
    ? getMissedClickNavigationError({
      beforeSnapshot: activeSnapshot,
      snapshot,
      action,
    })
    : undefined;

  if (params.actionKind === 'click' && Boolean((action as any).ok) && missedNavigationError) {
    const expectedHref = getExpectedClickNavigationHref(action, activeSnapshot);
    if (expectedHref) {
      const fallback = await navigateTabToClickedHref(params.tabId, expectedHref, params.options.postconditions);
      if (fallback.ok && fallback.snapshot && fallback.postconditions) {
        action = {
          ...(action as any),
          navigationFallback: {
            ok: true,
            method: 'tabs.update',
            url: expectedHref,
          },
        };
        snapshot = fallback.snapshot;
        postconditions = fallback.postconditions;
        params.trace.recoveryDecision = 'Opened the clicked href via tab URL navigation after DOM click attempts did not leave the current page.';
      } else {
        action = {
          ...(action as any),
          navigationFallback: {
            ok: false,
            method: 'tabs.update',
            url: expectedHref,
            error: fallback.error,
          },
        };
      }
    }
  }

  const finalMissedNavigationError = params.actionKind === 'click' && Boolean((action as any).ok)
    ? getMissedClickNavigationError({
      beforeSnapshot: activeSnapshot,
      snapshot,
      action,
    })
    : undefined;

  const navigationWarning = params.actionKind === 'click' && Boolean((action as any).ok) && !finalMissedNavigationError
    ? getSuccessfulNavigationWarning({
      beforeSnapshot: activeSnapshot,
      snapshot,
      action,
      postconditions,
    })
    : undefined;

  if (navigationWarning) {
    params.trace.recoveryDecision = navigationWarning;
    return {
      ok: true,
      action,
      snapshot,
      cacheStatus: params.trace.cacheStatus,
      trace: completeTrace(params.trace),
      postconditions,
      repairNeeded: false,
      warning: navigationWarning,
      resolved: {
        ok: true,
        ref: resolved.ref,
        snapshotId: resolved.snapshotId,
        selector: resolved.selector,
        entry: resolved.entry,
        backend: resolved.backend,
        confidence: resolved.confidence,
        matchScore: resolved.matchScore,
        preconditions: resolved.preconditions,
      },
    };
  }

  if (!Boolean((action as any).ok) || finalMissedNavigationError || !postconditionsPassed(postconditions)) {
    params.trace.cacheStatus = 'stale';
    params.trace.recoveryDecision = !Boolean((action as any).ok)
      ? ((action as any).error ?? 'cached action execution failed')
      : (finalMissedNavigationError ?? 'cached action postcondition failed');
    return {
      ok: false,
      action,
      snapshot,
      cacheStatus: 'stale',
      trace: completeTrace(params.trace),
      postconditions,
      repairNeeded: true,
      error: params.trace.recoveryDecision,
    };
  }

  return {
    ok: true,
    action,
    snapshot,
    resolved: {
      ok: true,
      ref: resolved.ref,
      snapshotId: resolved.snapshotId,
      selector: resolved.selector,
      entry: resolved.entry,
      matchScore: resolved.matchScore,
      preconditions: resolved.preconditions,
    },
    cacheStatus: 'hit',
    trace: completeTrace(params.trace),
    postconditions,
  };
}

async function rememberSingleTargetAction(params: {
  actionKind: Exclude<BrowActionKind, 'fillForm'>;
  options?: BrowserActionOptions;
  snapshot: BrowserSnapshot;
  resolved: BrowserRefResolution;
  trace: BrowActionTrace;
}): Promise<BrowActionCacheStatus> {
  if (!params.options?.intent || params.options.useActionMemory === false || !params.resolved.entry) {
    return 'store_skipped';
  }

  const saved = await upsertActionMemoryEntry({
    actionKind: params.actionKind,
    intent: params.options.intent,
    url: params.snapshot.url,
    target: memoryTargetFromElement(params.resolved.entry),
  });
  params.trace.cacheKey = saved.cacheKey ?? params.trace.cacheKey;
  params.trace.memoryEntryId = saved.entry?.id ?? params.trace.memoryEntryId;
  return saved.stored ? 'stored' : 'store_skipped';
}

export async function browserClick(
  tabId: number,
  ref?: string,
  snapshotId?: string,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'click', options);
  trace.backend = 'mv3-dom';
  const replayed = await tryReplaySingleTargetAction({
    tabId,
    actionKind: 'click',
    options,
    trace,
    execute: (selector, clickMode) => tabsClick(tabId, selector, options.clickPoint, clickMode),
  });
  if (replayed) return replayed;

  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const precheckedPostconditions = await evaluatePostconditions(tabId, beforeSnapshot, options.postconditions);
  if (shouldRepairForSatisfiedValuePostconditions(precheckedPostconditions)) {
    trace.execution = {
      ok: false,
      skipped: {
        reason: 'Requested value postconditions were already satisfied before click.',
      },
    };
    trace.postconditions = precheckedPostconditions;
    trace.recoveryDecision = SATISFIED_VALUE_REPAIR_ERROR;
    return {
      ok: false,
      action: trace.execution,
      beforeSnapshot,
      snapshot: beforeSnapshot,
      backend: 'mv3-dom',
      cacheStatus: trace.cacheStatus,
      trace: completeTrace(trace),
      postconditions: precheckedPostconditions,
      repairNeeded: true,
      error: SATISFIED_VALUE_REPAIR_ERROR,
    };
  }

  if (shouldSkipActionForSatisfiedPostconditions(precheckedPostconditions)) {
    trace.execution = {
      ok: true,
      skipped: {
        reason: 'Requested postconditions were already satisfied before click.',
      },
    };
    trace.postconditions = precheckedPostconditions;
    trace.recoveryDecision = 'Skipped click because the requested end state was already satisfied.';
    return {
      ok: true,
      action: trace.execution,
      beforeSnapshot,
      snapshot: beforeSnapshot,
      backend: 'mv3-dom',
      cacheStatus: trace.cacheStatus,
      trace: completeTrace(trace),
      postconditions: precheckedPostconditions,
      repairNeeded: false,
    };
  }

  let resolved = await resolveActionTarget({
    tabId,
    ref,
    snapshotId,
    requireActionable: actionKindRequiresActionableRef('click'),
    actionKind: 'click',
    options,
    beforeSnapshot,
  });
  if (resolved.ok && shouldRequireActionableClickResolution(resolved.entry)) {
    resolved = await resolveActionTarget({
      tabId,
      ref: resolved.ref ?? ref,
      snapshotId: resolved.snapshotId ?? snapshotId,
      requireActionable: true,
      actionKind: 'click',
      options,
      beforeSnapshot,
    });
  }
  trace.resolvedRef = resolved.ref;
  trace.originalRef = resolved.originalRef ?? ref;
  trace.snapshotId = resolved.snapshotId;
  trace.matchScore = resolved.matchScore;
  trace.confidence = resolved.confidence ?? resolved.matchScore;
  trace.preconditions = resolved.preconditions;
  trace.recoveryCandidates = resolved.repairCandidates;
  if (!resolved.ok || !resolved.selector) {
    trace.recoveryDecision = resolved.error ?? `Unable to resolve ref ${ref}`;
    return { ok: false, resolved, beforeSnapshot, backend: 'mv3-dom', confidence: trace.confidence, recoveryCandidates: resolved.repairCandidates, cacheStatus: trace.cacheStatus, trace: completeTrace(trace), error: trace.recoveryDecision };
  }

  const unsafePromotionError = getUnsafePromotedClickResolutionError(resolved);
  if (unsafePromotionError) {
    trace.recoveryDecision = unsafePromotionError;
    return {
      ok: false,
      resolved,
      beforeSnapshot,
      backend: 'mv3-dom',
      confidence: trace.confidence,
      recoveryCandidates: resolved.repairCandidates,
      cacheStatus: trace.cacheStatus,
      trace: completeTrace(trace),
      error: unsafePromotionError,
    };
  }

  const unsafeEditableClickError = getUnsafeEditableClickIntentError(resolved.entry, options.intent);
  if (unsafeEditableClickError) {
    trace.recoveryDecision = unsafeEditableClickError;
    return {
      ok: false,
      resolved,
      beforeSnapshot,
      backend: 'mv3-dom',
      confidence: trace.confidence,
      recoveryCandidates: resolved.repairCandidates,
      cacheStatus: trace.cacheStatus,
      trace: completeTrace(trace),
      error: unsafeEditableClickError,
    };
  }

  let action = await tabsClick(tabId, resolved.selector, options.clickPoint);
  let snapshot = await snapshotAfterAction(tabId);
  let postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  if (Boolean((action as any).ok) && !postconditionsPassed(postconditions)) {
    const waited = await waitForClickPostconditions(tabId, snapshot, options.postconditions);
    snapshot = waited.snapshot;
    postconditions = waited.results;
    if (postconditionsPassed(postconditions) && waited.waitedMs > 0) {
      trace.recoveryDecision = `Waited ${waited.waitedMs}ms for click postconditions to settle after the initial post-click snapshot.`;
    }
  }

  if (Boolean((action as any).ok) && shouldRetryProgrammaticClickForNavigation({
    beforeSnapshot,
    snapshot,
    action,
  })) {
    const repairAttempt = await tabsClick(tabId, resolved.selector, options.clickPoint, 'programmatic');
    let repairSnapshot = await snapshotAfterAction(tabId);
    let repairPostconditions = await evaluatePostconditions(tabId, repairSnapshot, options.postconditions);
    if (!postconditionsPassed(repairPostconditions)) {
      const waited = await waitForClickPostconditions(tabId, repairSnapshot, options.postconditions);
      repairSnapshot = waited.snapshot;
      repairPostconditions = waited.results;
    }
    action = Boolean((repairAttempt as any).ok)
      ? {
        ...(repairAttempt as any),
        initialAttempt: action,
      }
      : {
        ...(action as any),
        repairAttempt,
      };
    snapshot = repairSnapshot;
    postconditions = repairPostconditions;
    trace.recoveryDecision = 'Retried click with programmatic dispatch after the initial click did not navigate to the clicked href.';
  }

  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  const missedNavigationError = actionOk
    ? getMissedClickNavigationError({
      beforeSnapshot,
      snapshot,
      action,
    })
    : undefined;

  if (actionOk && missedNavigationError) {
    const expectedHref = getExpectedClickNavigationHref(action, beforeSnapshot);
    if (expectedHref) {
      const fallback = await navigateTabToClickedHref(tabId, expectedHref, options.postconditions);
      if (fallback.ok && fallback.snapshot && fallback.postconditions) {
        action = {
          ...(action as any),
          navigationFallback: {
            ok: true,
            method: 'tabs.update',
            url: expectedHref,
          },
        };
        snapshot = fallback.snapshot;
        postconditions = fallback.postconditions;
        trace.recoveryDecision = 'Opened the clicked href via tab URL navigation after DOM click attempts did not leave the current page.';
      } else {
        action = {
          ...(action as any),
          navigationFallback: {
            ok: false,
            method: 'tabs.update',
            url: expectedHref,
            error: fallback.error,
          },
        };
      }
    }
  }

  const finalPostconditionsOk = postconditionsPassed(postconditions);
  const finalMissedNavigationError = actionOk
    ? getMissedClickNavigationError({
      beforeSnapshot,
      snapshot,
      action,
    })
    : undefined;
  const navigationWarning = actionOk && !finalMissedNavigationError
    ? getSuccessfulNavigationWarning({
      beforeSnapshot,
      snapshot,
      action,
      postconditions,
    })
    : undefined;

  if (actionOk && !finalMissedNavigationError && (finalPostconditionsOk || navigationWarning)) {
    const storedStatus = await rememberSingleTargetAction({
      actionKind: 'click',
      options,
      snapshot,
      resolved,
      trace,
    });
    if (trace.cacheStatus !== 'disabled') trace.cacheStatus = storedStatus;
  }

  if (navigationWarning) {
    trace.recoveryDecision = navigationWarning;
  }

  if (finalMissedNavigationError) {
    trace.recoveryDecision = finalMissedNavigationError;
  }

  return {
    ok: actionOk && !finalMissedNavigationError && (finalPostconditionsOk || Boolean(navigationWarning)),
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    confidence: trace.confidence,
    cacheStatus: trace.cacheStatus,
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && (Boolean(finalMissedNavigationError) || (!finalPostconditionsOk && !navigationWarning)),
    warning: navigationWarning,
    error: actionOk
      ? (finalMissedNavigationError ?? (finalPostconditionsOk || navigationWarning ? undefined : 'Click postcondition failed'))
      : ((action as any).error ?? 'Click failed'),
  };
}

export async function browserHover(
  tabId: number,
  ref?: string,
  snapshotId?: string,
  message?: string,
  durationMs?: number,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'hover', options);
  trace.backend = 'mv3-dom';
  const replayed = await tryReplaySingleTargetAction({
    tabId,
    actionKind: 'hover',
    options,
    trace,
    execute: (selector) => tabsHover(tabId, selector, message, durationMs),
  });
  if (replayed) return replayed;

  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const resolved = await resolveActionTarget({ tabId, ref, snapshotId, requireActionable: true, actionKind: 'hover', options, beforeSnapshot });
  trace.resolvedRef = resolved.ref;
  trace.originalRef = resolved.originalRef ?? ref;
  trace.snapshotId = resolved.snapshotId;
  trace.matchScore = resolved.matchScore;
  trace.confidence = resolved.confidence ?? resolved.matchScore;
  trace.preconditions = resolved.preconditions;
  trace.recoveryCandidates = resolved.repairCandidates;
  if (!resolved.ok || !resolved.selector) {
    trace.recoveryDecision = resolved.error ?? `Unable to resolve ref ${ref}`;
    return { ok: false, resolved, beforeSnapshot, backend: 'mv3-dom', confidence: trace.confidence, recoveryCandidates: resolved.repairCandidates, cacheStatus: trace.cacheStatus, trace: completeTrace(trace), error: trace.recoveryDecision };
  }

  const action = await tabsHover(tabId, resolved.selector, message, durationMs);
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  if (actionOk && postconditionsOk) {
    const storedStatus = await rememberSingleTargetAction({
      actionKind: 'hover',
      options,
      snapshot,
      resolved,
      trace,
    });
    if (trace.cacheStatus !== 'disabled') trace.cacheStatus = storedStatus;
  }
  return {
    ok: actionOk && postconditionsOk,
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    confidence: trace.confidence,
    cacheStatus: trace.cacheStatus,
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Hover postcondition failed')
      : ((action as any).error ?? 'Hover failed'),
  };
}

export async function browserType(
  tabId: number,
  ref: string | undefined,
  text: string,
  submit = false,
  snapshotId?: string,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'type', options);
  trace.backend = 'mv3-dom';
  const replayed = await tryReplaySingleTargetAction({
    tabId,
    actionKind: 'type',
    options,
    trace,
    execute: (selector) => tabsType(tabId, selector, text, submit),
  });
  if (replayed) return replayed;

  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const precheckedPostconditions = await evaluatePostconditions(tabId, beforeSnapshot, options.postconditions);
  if (shouldRepairForSatisfiedValuePostconditions(precheckedPostconditions)) {
    trace.execution = {
      ok: false,
      skipped: {
        reason: 'Requested value postconditions were already satisfied before type.',
      },
    };
    trace.postconditions = precheckedPostconditions;
    trace.recoveryDecision = SATISFIED_VALUE_REPAIR_ERROR;
    return {
      ok: false,
      action: trace.execution,
      beforeSnapshot,
      snapshot: beforeSnapshot,
      backend: 'mv3-dom',
      cacheStatus: trace.cacheStatus,
      trace: completeTrace(trace),
      postconditions: precheckedPostconditions,
      repairNeeded: true,
      error: SATISFIED_VALUE_REPAIR_ERROR,
    };
  }

  if (shouldSkipActionForSatisfiedPostconditions(precheckedPostconditions)) {
    trace.execution = {
      ok: true,
      skipped: {
        reason: 'Requested postconditions were already satisfied before type.',
      },
    };
    trace.postconditions = precheckedPostconditions;
    trace.recoveryDecision = 'Skipped type because the requested end state was already satisfied.';
    return {
      ok: true,
      action: trace.execution,
      beforeSnapshot,
      snapshot: beforeSnapshot,
      backend: 'mv3-dom',
      cacheStatus: trace.cacheStatus,
      trace: completeTrace(trace),
      postconditions: precheckedPostconditions,
      repairNeeded: false,
    };
  }

  const resolved = await resolveActionTarget({ tabId, ref, snapshotId, requireActionable: false, actionKind: 'type', options, beforeSnapshot });
  trace.resolvedRef = resolved.ref;
  trace.originalRef = resolved.originalRef ?? ref;
  trace.snapshotId = resolved.snapshotId;
  trace.matchScore = resolved.matchScore;
  trace.confidence = resolved.confidence ?? resolved.matchScore;
  trace.preconditions = resolved.preconditions;
  trace.recoveryCandidates = resolved.repairCandidates;
  if (!resolved.ok || !resolved.selector) {
    trace.recoveryDecision = resolved.error ?? `Unable to resolve ref ${ref}`;
    return { ok: false, resolved, beforeSnapshot, backend: 'mv3-dom', confidence: trace.confidence, recoveryCandidates: resolved.repairCandidates, cacheStatus: trace.cacheStatus, trace: completeTrace(trace), error: trace.recoveryDecision };
  }

  const action = await tabsType(tabId, resolved.selector, text, submit);
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = { ok: (action as any).ok, typed: (action as any).typed, error: (action as any).error };
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  if (actionOk && postconditionsOk) {
    const storedStatus = await rememberSingleTargetAction({
      actionKind: 'type',
      options,
      snapshot,
      resolved,
      trace,
    });
    if (trace.cacheStatus !== 'disabled') trace.cacheStatus = storedStatus;
  }
  return {
    ok: actionOk && postconditionsOk,
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    confidence: trace.confidence,
    cacheStatus: trace.cacheStatus,
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Type postcondition failed')
      : ((action as any).error ?? 'Type failed'),
  };
}

export async function browserFillForm(
  tabId: number,
  fields: BrowserFormFillField[],
  submit = false,
  submitRef?: string,
  snapshotId?: string,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'fillForm', options);
  trace.backend = 'mv3-dom';
  if (options.intent && options.useActionMemory !== false) {
    const activeSnapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 1 });
    const lookup = await findActionMemoryEntry({
      actionKind: 'fillForm',
      intent: options.intent,
      url: activeSnapshot.url,
    });
    trace.cacheKey = lookup.cacheKey;
    if (lookup.entry?.fields && lookup.entry.fields.length === fields.length) {
      trace.cacheStatus = 'hit';
      trace.memoryEntryId = lookup.entry.id;
      const replayFields: FormFillField[] = [];
      const fieldResolutions: BrowserMemoryResolution[] = [];
      let replayFailedBeforeExecution = false;

      for (let index = 0; index < lookup.entry.fields.length; index += 1) {
        const cachedField = lookup.entry.fields[index];
        const resolved = await browserResolveMemoryTarget(tabId, cachedField, true);
        fieldResolutions.push(resolved);
        if (!resolved.ok || !resolved.selector) {
          replayFailedBeforeExecution = true;
          trace.cacheStatus = 'stale';
          trace.recoveryDecision = resolved.error ?? 'cached form field could not be replayed';
          break;
        }
        replayFields.push({
          selector: resolved.selector,
          value: fields[index].value,
          mode: fields[index].mode ?? cachedField.mode,
        });
      }

      if (!replayFailedBeforeExecution) {
        let submitSelector: string | undefined;
        let submitResolution: BrowserMemoryResolution | undefined;
        if (lookup.entry.submitTarget) {
          submitResolution = await browserResolveMemoryTarget(tabId, lookup.entry.submitTarget, true);
          if (submitResolution.ok && submitResolution.selector) {
            submitSelector = submitResolution.selector;
          } else {
            replayFailedBeforeExecution = true;
            trace.cacheStatus = 'stale';
            trace.recoveryDecision = submitResolution.error ?? 'cached submit target could not be replayed';
          }
        }

        if (!replayFailedBeforeExecution) {
          trace.matchScore = Math.min(
            ...fieldResolutions.map((resolution) => resolution.matchScore ?? Number.POSITIVE_INFINITY),
          );
          trace.preconditions = {
            fields: fieldResolutions.map((resolution) => resolution.preconditions),
            submit: submitResolution?.preconditions,
          };
          const action = await tabsFillForm(tabId, replayFields, submit, submitSelector);
          const snapshot = await snapshotAfterAction(tabId);
          const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
          trace.execution = action as Record<string, unknown>;
          trace.postconditions = postconditions;
          const actionOk = Boolean((action as any).ok);
          const postconditionsOk = postconditionsPassed(postconditions);
          if (actionOk && postconditionsOk) {
            return {
              ok: true,
              action,
              snapshot,
              cacheStatus: 'hit',
              trace: completeTrace(trace),
              postconditions,
            };
          }
          trace.cacheStatus = 'stale';
          trace.recoveryDecision = actionOk ? 'cached form postcondition failed' : ((action as any).error ?? 'cached form fill failed');
          return {
            ok: false,
            action,
            snapshot,
            cacheStatus: 'stale',
            trace: completeTrace(trace),
            postconditions,
            repairNeeded: true,
            error: trace.recoveryDecision,
          };
        }
      }
    } else {
      trace.cacheStatus = 'miss';
    }
  }

  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const resolvedFields: FormFillField[] = [];
  const resolutions: BrowserRefResolution[] = [];

  for (const field of fields) {
    const resolved = await resolveActionTarget({
      tabId,
      ref: field.ref,
      snapshotId,
      requireActionable: true,
      actionKind: 'fillForm',
      options: {
        ...options,
        targetEvidence: field.targetEvidence ?? options.targetEvidence,
      },
      beforeSnapshot,
    });
    resolutions.push(resolved);
    if (!resolved.ok || !resolved.selector) {
      trace.resolvedRef = resolved.ref;
      trace.snapshotId = resolved.snapshotId;
      trace.preconditions = resolved.preconditions;
      trace.recoveryDecision = resolved.error ?? `Unable to resolve form field ref ${field.ref}`;
      return {
        ok: false,
        resolved,
        beforeSnapshot,
        backend: 'mv3-dom',
        confidence: resolved.confidence ?? resolved.matchScore,
        recoveryCandidates: resolved.repairCandidates,
        cacheStatus: trace.cacheStatus,
        trace: completeTrace(trace),
        error: trace.recoveryDecision,
      };
    }
    resolvedFields.push({
      selector: resolved.selector,
      value: field.value,
      mode: field.mode,
    });
  }

  let submitSelector: string | undefined;
  let submitResolution: BrowserRefResolution | undefined;
  if (submitRef) {
    submitResolution = await resolveActionTarget({ tabId, ref: submitRef, snapshotId, requireActionable: true, actionKind: 'click', options, beforeSnapshot });
    if (!submitResolution.ok || !submitResolution.selector) {
      trace.resolvedRef = submitResolution.ref;
      trace.snapshotId = submitResolution.snapshotId;
      trace.preconditions = submitResolution.preconditions;
      trace.recoveryDecision = submitResolution.error ?? `Unable to resolve submit ref ${submitRef}`;
      return {
        ok: false,
        resolved: submitResolution,
        beforeSnapshot,
        backend: 'mv3-dom',
        confidence: submitResolution.confidence ?? submitResolution.matchScore,
        recoveryCandidates: submitResolution.repairCandidates,
        cacheStatus: trace.cacheStatus,
        trace: completeTrace(trace),
        error: trace.recoveryDecision,
      };
    }
    submitSelector = submitResolution.selector;
  }

  const action = await tabsFillForm(tabId, resolvedFields, submit, submitSelector);
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  trace.preconditions = {
    fields: resolutions.map((resolution) => resolution.preconditions),
    submit: submitResolution?.preconditions,
  };
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  if (actionOk && postconditionsOk && options.intent && options.useActionMemory !== false) {
    const memoryFields: BrowActionMemoryField[] = resolutions
      .map((resolution, index) =>
        resolution.entry ? memoryFieldFromElement(resolution.entry, fields[index].mode) : null,
      )
      .filter((field): field is BrowActionMemoryField => Boolean(field));
    const saved = await upsertActionMemoryEntry({
      actionKind: 'fillForm',
      intent: options.intent,
      url: snapshot.url,
      fields: memoryFields,
      submitTarget: submitResolution?.entry ? memoryTargetFromElement(submitResolution.entry) : undefined,
    });
    trace.cacheKey = saved.cacheKey ?? trace.cacheKey;
    trace.memoryEntryId = saved.entry?.id ?? trace.memoryEntryId;
    trace.cacheStatus = saved.stored ? 'stored' : 'store_skipped';
  }
  return {
    ok: actionOk && postconditionsOk,
    action: {
      ...action,
      resolvedFields: resolutions,
      submitResolution,
    },
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    confidence: Math.min(...resolutions.map((resolution) => resolution.confidence ?? resolution.matchScore ?? 100)),
    cacheStatus: trace.cacheStatus,
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Form fill postcondition failed')
      : ((action as any).error ?? 'Form fill failed'),
  };
}

export async function browserDrag(
  tabId: number,
  sourceRef: string | undefined,
  destinationRef: string | undefined,
  snapshotId?: string,
  options: BrowserDragOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'drag', options);
  trace.backend = 'mv3-dom';
  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const source = await resolveActionTarget({
    tabId,
    ref: sourceRef,
    snapshotId,
    requireActionable: false,
    actionKind: 'drag',
    options,
    beforeSnapshot,
  });
  if (!source.ok || !source.selector) {
    trace.recoveryDecision = source.error ?? 'Unable to resolve drag source';
    trace.recoveryCandidates = source.repairCandidates;
    return {
      ok: false,
      resolved: source,
      beforeSnapshot,
      backend: 'mv3-dom',
      recoveryCandidates: source.repairCandidates,
      trace: completeTrace(trace),
      error: trace.recoveryDecision,
    };
  }

  const destination = await resolveActionTarget({
    tabId,
    ref: destinationRef,
    snapshotId,
    requireActionable: false,
    actionKind: 'drag',
    options: {
      ...options,
      targetEvidence: options.destinationTargetEvidence,
    },
    beforeSnapshot,
  });
  if (!destination.ok || !destination.selector) {
    trace.recoveryDecision = destination.error ?? 'Unable to resolve drag destination';
    trace.recoveryCandidates = destination.repairCandidates;
    return {
      ok: false,
      resolved: destination,
      beforeSnapshot,
      backend: 'mv3-dom',
      recoveryCandidates: destination.repairCandidates,
      trace: completeTrace(trace),
      error: trace.recoveryDecision,
    };
  }

  trace.resolvedRef = source.ref;
  trace.snapshotId = source.snapshotId;
  trace.matchScore = Math.min(source.matchScore ?? 100, destination.matchScore ?? 100);
  trace.confidence = trace.matchScore;
  trace.preconditions = { source: source.preconditions, destination: destination.preconditions };
  const action = await tabsDrag(tabId, source.selector, destination.selector, {
    sourceClickPoint: options.sourceClickPoint,
    destinationClickPoint: options.destinationClickPoint,
    pointerPath: options.pointerPath,
    durationMs: options.durationMs,
  });
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  return {
    ok: actionOk && postconditionsOk,
    action: {
      ...action,
      source,
      destination,
    },
    resolved: source,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    confidence: trace.confidence,
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Drag postcondition failed')
      : ((action as any).error ?? 'Drag failed'),
  };
}

export async function browserScroll(
  tabId: number,
  options: BrowserActionOptions & {
    ref?: string;
    snapshotId?: string;
    deltaX?: number;
    deltaY?: number;
    top?: number;
    left?: number;
  } = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'scroll', options);
  trace.backend = 'mv3-dom';
  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  let selector: string | undefined;
  let resolved: BrowserRefResolution | undefined;
  if (options.ref || options.targetEvidence) {
    resolved = await resolveActionTarget({
      tabId,
      ref: options.ref,
      snapshotId: options.snapshotId,
      requireActionable: false,
      actionKind: 'scroll',
      options,
      beforeSnapshot,
    });
    if (!resolved.ok || !resolved.selector) {
      trace.recoveryDecision = resolved.error ?? 'Unable to resolve scroll target';
      trace.recoveryCandidates = resolved.repairCandidates;
      return {
        ok: false,
        resolved,
        beforeSnapshot,
        backend: 'mv3-dom',
        recoveryCandidates: resolved.repairCandidates,
        trace: completeTrace(trace),
        error: trace.recoveryDecision,
      };
    }
    selector = resolved.selector;
  }

  const action = await tabsScroll(tabId, {
    selector,
    deltaX: options.deltaX,
    deltaY: options.deltaY ?? 650,
    top: options.top,
    left: options.left,
  });
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  return {
    ok: actionOk && postconditionsOk,
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Scroll postcondition failed')
      : ((action as any).error ?? 'Scroll failed'),
  };
}

export async function browserKey(
  tabId: number,
  options: BrowserActionOptions & {
    ref?: string;
    snapshotId?: string;
    key?: string;
    code?: string;
    text?: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  } = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'key', options);
  trace.backend = 'mv3-dom';
  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  let selector: string | undefined;
  let resolved: BrowserRefResolution | undefined;
  if (options.ref || options.targetEvidence) {
    resolved = await resolveActionTarget({
      tabId,
      ref: options.ref,
      snapshotId: options.snapshotId,
      requireActionable: false,
      actionKind: 'key',
      options,
      beforeSnapshot,
    });
    if (!resolved.ok || !resolved.selector) {
      trace.recoveryDecision = resolved.error ?? 'Unable to resolve key target';
      trace.recoveryCandidates = resolved.repairCandidates;
      return {
        ok: false,
        resolved,
        beforeSnapshot,
        backend: 'mv3-dom',
        recoveryCandidates: resolved.repairCandidates,
        trace: completeTrace(trace),
        error: trace.recoveryDecision,
      };
    }
    selector = resolved.selector;
  }

  const initialAction = await tabsKey(tabId, {
    selector,
    key: options.key,
    code: options.code,
    text: options.text,
    altKey: options.altKey,
    ctrlKey: options.ctrlKey,
    metaKey: options.metaKey,
    shiftKey: options.shiftKey,
  });
  let action: { ok: boolean; keyed?: unknown; error?: string; initialAttempt?: unknown; repairAttempt?: unknown } = initialAction;
  let snapshot = await snapshotAfterAction(tabId);
  let postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);

  if (Boolean((initialAction as any).ok) && shouldRetryBodyMediaKey({
    selector,
    key: options.key,
    code: options.code,
    text: options.text,
    postconditions: options.postconditions,
    postconditionResults: postconditions,
    targetSelector: (initialAction as any)?.keyed?.target?.selector,
    targetTagName: (initialAction as any)?.keyed?.target?.tagName,
  })) {
    const repairAttempt = await tabsKey(tabId, {
      selector: 'body',
      key: options.key,
      code: options.code,
      text: options.text,
      altKey: options.altKey,
      ctrlKey: options.ctrlKey,
      metaKey: options.metaKey,
      shiftKey: options.shiftKey,
    });
    const repairSnapshot = await snapshotAfterAction(tabId);
    const repairPostconditions = await evaluatePostconditions(tabId, repairSnapshot, options.postconditions);
    trace.recoveryDecision = 'Retried key input on document.body after media postcondition failed on the initial target.';

    action = Boolean((repairAttempt as any).ok)
      ? {
        ...(repairAttempt as any),
        initialAttempt: initialAction,
      }
      : {
        ...(initialAction as any),
        repairAttempt,
      };
    snapshot = repairSnapshot;
    postconditions = repairPostconditions;
  }

  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  return {
    ok: actionOk && postconditionsOk,
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Key postcondition failed')
      : ((action as any).error ?? 'Key action failed'),
  };
}

export async function browserUploadFile(
  tabId: number,
  ref: string | undefined,
  fileName?: string,
  filePath?: string,
  snapshotId?: string,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'upload', options);
  trace.backend = options.backendPreference === 'local-helper' ? 'local-helper' : 'mv3-dom';
  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const resolved = await resolveActionTarget({ tabId, ref, snapshotId, requireActionable: false, actionKind: 'upload', options, beforeSnapshot });
  if (!resolved.ok || !resolved.selector) {
    trace.recoveryDecision = resolved.error ?? 'Unable to resolve upload control';
    trace.recoveryCandidates = resolved.repairCandidates;
    return {
      ok: false,
      resolved,
      beforeSnapshot,
      backend: trace.backend,
      recoveryCandidates: resolved.repairCandidates,
      trace: completeTrace(trace),
      error: trace.recoveryDecision,
    };
  }

  const action = await tabsUploadFile(tabId, resolved.selector, fileName, filePath);
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  return {
    ok: Boolean((action as any).ok) && postconditionsPassed(postconditions),
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: (action as any).backend ?? trace.backend,
    trace: completeTrace(trace),
    postconditions,
    helperRequired: Boolean((action as any).helperRequired),
    error: (action as any).error,
  };
}

export async function browserHandleDialog(
  tabId: number,
  options: BrowserActionOptions & {
    ref?: string;
    snapshotId?: string;
    action?: 'accept' | 'dismiss' | 'close';
    text?: string;
  } = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'handleDialog', options);
  trace.backend = options.backendPreference === 'local-helper' ? 'local-helper' : 'mv3-dom';
  await waitForTabSettled(tabId);
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  let selector: string | undefined;
  let resolved: BrowserRefResolution | undefined;
  if (options.ref || options.targetEvidence) {
    resolved = await resolveActionTarget({
      tabId,
      ref: options.ref,
      snapshotId: options.snapshotId,
      requireActionable: false,
      actionKind: 'handleDialog',
      options,
      beforeSnapshot,
    });
    if (!resolved.ok || !resolved.selector) {
      trace.recoveryDecision = resolved.error ?? 'Unable to resolve dialog target';
      return {
        ok: false,
        resolved,
        beforeSnapshot,
        backend: trace.backend,
        recoveryCandidates: resolved.repairCandidates,
        trace: completeTrace(trace),
        error: trace.recoveryDecision,
      };
    }
    selector = resolved.selector;
  }

  const action = await tabsHandleDialog(tabId, {
    selector,
    action: options.action ?? 'accept',
    text: options.text,
  });
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions ?? [{ type: 'dialogClosed', value: options.text }]);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  return {
    ok: Boolean((action as any).ok) && postconditionsPassed(postconditions),
    action,
    resolved,
    beforeSnapshot,
    snapshot,
    backend: (action as any).backend ?? trace.backend,
    trace: completeTrace(trace),
    postconditions,
    helperRequired: Boolean((action as any).helperRequired),
    error: (action as any).error,
  };
}

export async function browserWaitFor(
  tabId: number,
  postconditions: BrowActionPostcondition[],
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'wait');
  trace.backend = 'mv3-dom';
  const beforeSnapshot = await captureActionBeforeSnapshot(tabId);
  const timeoutMs = Math.max(250, Math.min(Math.floor(options.timeoutMs ?? 5000), 60000));
  const pollMs = Math.max(100, Math.min(Math.floor(options.pollMs ?? 250), 2000));
  const startedAt = Date.now();
  let snapshot = beforeSnapshot;
  let results = await evaluatePostconditions(tabId, snapshot, postconditions);

  while (!postconditionsPassed(results) && Date.now() - startedAt < timeoutMs) {
    await delay(pollMs);
    snapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 80 });
    results = await evaluatePostconditions(tabId, snapshot, postconditions);
  }

  trace.postconditions = results;
  trace.execution = { waitedMs: Date.now() - startedAt, timeoutMs, pollMs };
  return {
    ok: postconditionsPassed(results),
    action: trace.execution,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    trace: completeTrace(trace),
    postconditions: results,
    error: postconditionsPassed(results) ? undefined : 'Timed out waiting for postconditions',
  };
}

export async function browserDownloadWait(
  tabId: number,
  options: { filenameIncludes?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'downloadWait');
  trace.backend = 'mv3-dom';
  const beforeSnapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 20 });
  const timeoutMs = Math.max(250, Math.min(Math.floor(options.timeoutMs ?? 30000), 120000));
  const pollMs = Math.max(250, Math.min(Math.floor(options.pollMs ?? 500), 5000));
  const startedAt = Date.now();
  let download = await recentDownloadAppeared(options.filenameIncludes);
  while (!download.ok && Date.now() - startedAt < timeoutMs) {
    await delay(pollMs);
    download = await recentDownloadAppeared(options.filenameIncludes);
  }
  const snapshot = await browserSnapshot(tabId, { mode: 'compact', maxElements: 20 });
  const condition: BrowActionPostcondition = { type: 'downloadAppeared', value: options.filenameIncludes };
  const postconditions = [{ ok: download.ok, condition, actual: download.actual, error: download.error }];
  trace.postconditions = postconditions;
  trace.execution = { waitedMs: Date.now() - startedAt, timeoutMs, pollMs, filenameIncludes: options.filenameIncludes };
  return {
    ok: download.ok,
    action: trace.execution,
    beforeSnapshot,
    snapshot,
    backend: 'mv3-dom',
    trace: completeTrace(trace),
    postconditions,
    error: download.ok ? undefined : (download.error ?? 'Timed out waiting for download'),
  };
}
