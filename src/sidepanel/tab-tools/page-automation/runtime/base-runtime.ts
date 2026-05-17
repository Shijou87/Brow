import type { ClickPoint, SnapshotState, VisibleRect } from './types';

export interface PageAutomationBaseRuntime {
  ROOT_ID: string;
  STYLE_ID: string;
  SNAPSHOT_STATE_KEY: string;
  BROW_REF_PREFIX: string;
  CURSOR_SIZE: number;
  CURSOR_WIDTH: number;
  CURSOR_HEIGHT: number;
  CURSOR_SPRITESHEET_URL: string;
  BROW_CHARACTER_CELL_SIZE: number;
  BROW_CHARACTER_DISPLAY_WIDTH: number;
  BROW_CHARACTER_DISPLAY_HEIGHT: number;
  BROW_CHARACTER_COLUMNS: number;
  BROW_CHARACTER_ROWS: number;
  BROW_CHARACTER_SPRITESHEET_URL: string;
  BROW_CHARACTER_FEET_X: number;
  BROW_CHARACTER_FEET_Y: number;
  BROW_CHARACTER_IDLE_ROW: number;
  BROW_CHARACTER_JUMP_ROW: number;
  BROW_CHARACTER_RUN_ROW: number;
  BROW_CHARACTER_POINT_ROW: number;
  BROW_CHARACTER_WALK_DOWN_ROW: number;
  BROW_CHARACTER_WALK_UP_ROW: number;
  CURSOR_HOTSPOT_X: number;
  CURSOR_HOTSPOT_Y: number;
  HIGHLIGHT_CURSOR_HOTSPOT_X: number;
  HIGHLIGHT_CURSOR_HOTSPOT_Y: number;
  PENCIL_CURSOR_HOTSPOT_X: number;
  PENCIL_CURSOR_HOTSPOT_Y: number;
  BADGE_WIDTH: number;
  BADGE_HEIGHT: number;
  BADGE_CURSOR_OFFSET_X: number;
  BADGE_CURSOR_OFFSET_Y: number;
  LAST_HOVERED_KEY: string;
  sleep(ms: number): Promise<void>;
  clamp(value: number, min: number, max: number): number;
  toScreenX(clientX: number): number;
  toScreenY(clientY: number): number;
  getSnapshotState(): SnapshotState | undefined;
  isHTMLElementLike(value: unknown): value is HTMLElement;
  resolveBrowRefElement(selector: string): HTMLElement | null;
  describeElement(el: HTMLElement): string;
  isElementVisible(el: Element): boolean;
  normalizeInlineText(value: string | null | undefined): string;
  getVisibleRect(el: Element): VisibleRect | null;
  summarizeElement(selector: string, el: HTMLElement): {
    selector: string;
    tagName: string;
    type?: string;
    text: string;
    role?: string;
    name?: string;
    id?: string;
    href?: string;
    placeholder?: string;
  };
  getLastHoveredElement(): HTMLElement | null;
  setLastHoveredElement(el: HTMLElement | null): void;
}

export function createBaseRuntime(): PageAutomationBaseRuntime {
  const ROOT_ID = '__brow-automation-overlay__';
  const STYLE_ID = '__brow-automation-style__';
  const SNAPSHOT_STATE_KEY = '__browBrowserSnapshotState__';
  const BROW_REF_PREFIX = 'brow-ref://';
  const CURSOR_SIZE = 40;
  const CURSOR_WIDTH = CURSOR_SIZE;
  const CURSOR_HEIGHT = CURSOR_SIZE;
  const CURSOR_SPRITESHEET_URL = chrome.runtime.getURL('icons/cursors.png');
  const BROW_CHARACTER_CELL_SIZE = 256;
  const BROW_CHARACTER_DISPLAY_WIDTH = 96;
  const BROW_CHARACTER_DISPLAY_HEIGHT = 96;
  const BROW_CHARACTER_COLUMNS = 12;
  const BROW_CHARACTER_ROWS = 6;
  const BROW_CHARACTER_SPRITESHEET_URL = chrome.runtime.getURL('icons/brow-spritesheet.png');
  const BROW_CHARACTER_FEET_X = 48;
  const BROW_CHARACTER_FEET_Y = 90;
  const BROW_CHARACTER_IDLE_ROW = 0;
  const BROW_CHARACTER_JUMP_ROW = 1;
  const BROW_CHARACTER_RUN_ROW = 2;
  const BROW_CHARACTER_POINT_ROW = 3;
  const BROW_CHARACTER_WALK_DOWN_ROW = 4;
  const BROW_CHARACTER_WALK_UP_ROW = 5;
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
  const normalizeInlineText = (value: string | null | undefined): string => (
    (value ?? '').replace(/\s+/g, ' ').trim()
  );
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

  const describeElement = (el: HTMLElement): string => {
    const label = [
      el.getAttribute('aria-label'),
      el.getAttribute('name'),
      el.getAttribute('placeholder'),
      el.id,
      el.innerText,
      el.textContent,
    ]
      .map((value) => normalizeInlineText(value))
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

  const summarizeElement = (selector: string, el: HTMLElement) => ({
    selector,
    tagName: el.tagName.toLowerCase(),
    type: (el as HTMLInputElement).type || undefined,
    text: normalizeInlineText(el.innerText || el.getAttribute('aria-label') || '').slice(0, 120),
    role: el.getAttribute('role') || undefined,
    name: el.getAttribute('name') || undefined,
    id: el.id || undefined,
    href: (el as HTMLAnchorElement).href || undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
  });

  const getLastHoveredElement = (): HTMLElement | null => {
    const current = (window as unknown as Window & Record<string, Element | null | undefined>)[LAST_HOVERED_KEY];
    if (current instanceof HTMLElement && current.isConnected) {
      return current;
    }

    delete (window as unknown as Window & Record<string, Element | null | undefined>)[LAST_HOVERED_KEY];
    return null;
  };

  const setLastHoveredElement = (el: HTMLElement | null) => {
    const hoverWindow = window as unknown as Window & Record<string, Element | null | undefined>;
    if (el && el.isConnected) {
      hoverWindow[LAST_HOVERED_KEY] = el;
      return;
    }

    delete hoverWindow[LAST_HOVERED_KEY];
  };

  return {
    ROOT_ID,
    STYLE_ID,
    SNAPSHOT_STATE_KEY,
    BROW_REF_PREFIX,
    CURSOR_SIZE,
    CURSOR_WIDTH,
    CURSOR_HEIGHT,
    CURSOR_SPRITESHEET_URL,
    BROW_CHARACTER_CELL_SIZE,
    BROW_CHARACTER_DISPLAY_WIDTH,
    BROW_CHARACTER_DISPLAY_HEIGHT,
    BROW_CHARACTER_COLUMNS,
    BROW_CHARACTER_ROWS,
    BROW_CHARACTER_SPRITESHEET_URL,
    BROW_CHARACTER_FEET_X,
    BROW_CHARACTER_FEET_Y,
    BROW_CHARACTER_IDLE_ROW,
    BROW_CHARACTER_JUMP_ROW,
    BROW_CHARACTER_RUN_ROW,
    BROW_CHARACTER_POINT_ROW,
    BROW_CHARACTER_WALK_DOWN_ROW,
    BROW_CHARACTER_WALK_UP_ROW,
    CURSOR_HOTSPOT_X,
    CURSOR_HOTSPOT_Y,
    HIGHLIGHT_CURSOR_HOTSPOT_X,
    HIGHLIGHT_CURSOR_HOTSPOT_Y,
    PENCIL_CURSOR_HOTSPOT_X,
    PENCIL_CURSOR_HOTSPOT_Y,
    BADGE_WIDTH,
    BADGE_HEIGHT,
    BADGE_CURSOR_OFFSET_X,
    BADGE_CURSOR_OFFSET_Y,
    LAST_HOVERED_KEY,
    sleep,
    clamp,
    toScreenX,
    toScreenY,
    getSnapshotState,
    isHTMLElementLike,
    resolveBrowRefElement,
    describeElement,
    isElementVisible,
    normalizeInlineText,
    getVisibleRect,
    summarizeElement,
    getLastHoveredElement,
    setLastHoveredElement,
  };
}
