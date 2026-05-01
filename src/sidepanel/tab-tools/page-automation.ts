import { ensureTabIsActive } from './tabs';
import type {
  BrowserSnapshot,
  BrowserSnapshotElement,
  BrowserSnapshotOptions,
  BrowserViewportInfo,
  BrowserViewportRect,
  BrowserVisualRegion,
  BrowActionCacheStatus,
  BrowActionKind,
  BrowActionMemoryField,
  BrowActionMemoryTarget,
  BrowActionPostcondition,
  BrowActionTrace,
  BrowElementSignature,
  BrowPostconditionResult,
} from '../../shared/types';
import {
  findActionMemoryEntry,
  memoryFieldFromElement,
  memoryTargetFromElement,
  upsertActionMemoryEntry,
} from './action-memory';

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

export interface BrowserActionOptions {
  intent?: string;
  postconditions?: BrowActionPostcondition[];
  useActionMemory?: boolean;
}

interface BrowserMemoryResolution {
  ok: boolean;
  selector?: string;
  ref?: string;
  snapshotId?: string;
  entry?: BrowserSnapshotElement;
  matchScore?: number;
  snapshot?: BrowserSnapshot;
  preconditions?: Record<string, unknown>;
  error?: string;
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

type BrowserSnapshotOperation =
  | {
    kind: 'snapshot';
    tabId: number;
    options?: BrowserSnapshotOptions;
  }
  | {
    kind: 'resolve';
    tabId: number;
    ref: string;
    snapshotId?: string;
    requireActionable?: boolean;
  }
  | {
    kind: 'resolveMemory';
    tabId: number;
    target: BrowActionMemoryTarget;
    requireActionable?: boolean;
  };

async function runBrowserSnapshotOperation(operation: BrowserSnapshotOperation): Promise<unknown> {
  const STATE_KEY = '__browBrowserSnapshotState__';
  const BROW_REF_PREFIX = 'brow-ref://';
  const MAX_STORED_SNAPSHOTS = 5;
  const MAX_REGISTRY_ELEMENTS = 1000;
  const MIN_MEMORY_MATCH_SCORE = 38;

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

  const getState = (): SnapshotState => {
    const target = window as unknown as Record<string, SnapshotState | undefined>;
    if (!target[STATE_KEY]) {
      target[STATE_KEY] = {
        snapshots: {},
        snapshotOrder: [],
      };
    }
    return target[STATE_KEY]!;
  };

  const isElementNode = (value: unknown): value is Element => (
    Boolean(value)
    && typeof value === 'object'
    && (value as Node).nodeType === 1
    && typeof (value as Element).getBoundingClientRect === 'function'
  );

  const cleanText = (value: string | null | undefined, max = 160): string => {
    const cleaned = (value ?? '').replace(/\s+/g, ' ').trim();
    return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
  };

  const round = (value: number): number => Math.round(value * 10) / 10;

  const getViewport = (): BrowserViewportInfo => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    devicePixelRatio: window.devicePixelRatio || 1,
  });

  const getBounds = (el: Element): BrowserViewportRect => {
    const rect = (el as HTMLElement).getBoundingClientRect();
    return {
      x: round(rect.left),
      y: round(rect.top),
      left: round(rect.left),
      top: round(rect.top),
      right: round(rect.right),
      bottom: round(rect.bottom),
      width: round(rect.width),
      height: round(rect.height),
    };
  };

  const isSkippableElement = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'meta', 'link', 'noscript', 'template', 'head'].includes(tag)) return true;
    if ((el as HTMLElement).id === '__brow-automation-overlay__') return true;
    if (el.closest?.('#__brow-automation-overlay__')) return true;
    return false;
  };

  const isVisible = (el: Element): boolean => {
    if (isSkippableElement(el)) return false;
    const htmlEl = el as HTMLElement;
    const rect = htmlEl.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const ownerWindow = htmlEl.ownerDocument.defaultView ?? window;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > ownerWindow.innerHeight || rect.left > ownerWindow.innerWidth) {
      return false;
    }
    const style = ownerWindow.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (htmlEl.getAttribute('aria-hidden') === 'true') return false;
    return true;
  };

  const escapeAttributeValue = (value: string): string => (
    value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  );

  const escapeCss = (value: string): string => {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
    return value.replace(/["\\]/g, '\\$&');
  };

  const hasReliableValue = (value: string | null | undefined): value is string => {
    if (!value) return false;
    const trimmed = value.trim();
    return Boolean(trimmed) && !['undefined', 'null', 'nan'].includes(trimmed.toLowerCase());
  };

  const canUseHashIdSelector = (value: string): boolean => (
    /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(value)
  );

  const buildIdSelector = (value: string): string => (
    canUseHashIdSelector(value)
      ? `#${escapeCss(value)}`
      : `[id="${escapeAttributeValue(value)}"]`
  );

  const isUniqueSelectorFor = (selector: string, el: Element): boolean => {
    try {
      const ownerDocument = el.ownerDocument ?? document;
      const matches = Array.from(ownerDocument.querySelectorAll(selector));
      return matches.length === 1 && matches[0] === el;
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

    while (current && current !== document.body && parts.length < 7) {
      const htmlEl = current as HTMLElement;
      if (hasReliableValue(htmlEl.id)) {
        const idSelector = buildIdSelector(htmlEl.id);
        const anchoredSelector = parts.length > 0 ? `${idSelector} > ${parts.join(' > ')}` : idSelector;
        if (isUniqueSelectorFor(anchoredSelector, el)) return anchoredSelector;
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

    return parts.join(' > ') || el.tagName.toLowerCase();
  };

  const buildSelector = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const htmlEl = el as HTMLElement;
    const attrCandidates: Array<string | null> = [
      hasReliableValue(htmlEl.id) ? buildIdSelector(htmlEl.id) : null,
      buildAttributeSelector(tag, 'data-testid', el.getAttribute('data-testid')),
      buildAttributeSelector(tag, 'data-test', el.getAttribute('data-test')),
      buildAttributeSelector(tag, 'aria-label', el.getAttribute('aria-label')),
      buildAttributeSelector(tag, 'name', el.getAttribute('name')),
      buildAttributeSelector(tag, 'placeholder', el.getAttribute('placeholder')),
      buildAttributeSelector(tag, 'title', el.getAttribute('title')),
    ];

    for (const candidate of attrCandidates) {
      if (candidate && isUniqueSelectorFor(candidate, el)) return candidate;
    }

    return buildDomPath(el);
  };

  const getDepth = (el: Element): number => {
    let depth = 0;
    let current = el.parentElement;
    while (current && current !== document.body) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  };

  const getLabelText = (el: Element): string => {
    const input = el as HTMLInputElement;
    const labels = input.labels ? Array.from(input.labels) : [];
    const labelText = labels.map((label) => cleanText(label.innerText || label.textContent, 80)).find(Boolean);
    if (labelText) return labelText;

    const wrappingLabel = el.closest('label');
    if (wrappingLabel) return cleanText(wrappingLabel.innerText || wrappingLabel.textContent, 80);
    return '';
  };

  const getAriaLabelledByText = (el: Element): string => {
    const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    const ownerDocument = el.ownerDocument ?? document;
    return cleanText(ids.map((id) => ownerDocument.getElementById(id)?.innerText || ownerDocument.getElementById(id)?.textContent || '').join(' '), 120);
  };

  const inferRole = (el: Element): string => {
    const explicit = cleanText(el.getAttribute('role'), 50);
    if (explicit) return explicit;

    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && (el as HTMLAnchorElement).href) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'summary') return 'button';
    if (tag === 'img') return 'image';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'form') return 'form';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'th') return 'columnheader';
    if (tag === 'td') return 'cell';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'article') return 'article';
    if (tag === 'section') return 'region';
    if (tag === 'canvas' || tag === 'svg' || tag === 'video') return 'region';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      return 'textbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    return 'text';
  };

  const getElementText = (el: Element, max = 160): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const input = el as HTMLInputElement;
      return cleanText(input.value || input.placeholder || input.name, max);
    }
    if (tag === 'textarea') {
      const textarea = el as HTMLTextAreaElement;
      return cleanText(textarea.value || textarea.placeholder || textarea.name, max);
    }
    return cleanText((el as HTMLElement).innerText || el.textContent, max);
  };

  const getAccessibleName = (el: Element, role: string): string => {
    const direct = [
      el.getAttribute('aria-label'),
      getAriaLabelledByText(el),
      getLabelText(el),
      el.getAttribute('alt'),
      el.getAttribute('title'),
      el.getAttribute('placeholder'),
      el.getAttribute('name'),
    ].map((value) => cleanText(value, 120)).find(Boolean);
    if (direct) return direct;

    if (role === 'textbox' || role === 'searchbox') {
      const input = el as HTMLInputElement;
      return cleanText(input.placeholder || input.value || input.name, 120);
    }

    return cleanText((el as HTMLElement).innerText || el.textContent, 120);
  };

  const isActionable = (el: Element, role: string): boolean => {
    const tag = el.tagName.toLowerCase();
    const htmlEl = el as HTMLElement;
    if (htmlEl.isContentEditable) return true;
    if (tag === 'a' && (el as HTMLAnchorElement).href) return true;
    if (['button', 'input', 'textarea', 'select', 'summary'].includes(tag)) return true;
    if ([
      'button',
      'link',
      'textbox',
      'searchbox',
      'checkbox',
      'radio',
      'combobox',
      'switch',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'tab',
      'treeitem',
      'slider',
      'spinbutton',
      'gridcell',
      'row',
    ].includes(role)) return true;
    if (typeof (htmlEl as any).onclick === 'function') return true;
    if (htmlEl.hasAttribute('onclick') || htmlEl.hasAttribute('jsaction')) return true;
    if (htmlEl.hasAttribute('aria-haspopup') || htmlEl.hasAttribute('aria-expanded')) return true;
    if ((el.ownerDocument.defaultView ?? window).getComputedStyle(el).cursor === 'pointer') return true;
    const tabIndex = htmlEl.getAttribute('tabindex');
    return tabIndex != null && Number(tabIndex) >= 0;
  };

  const findActionTarget = (el: Element): Element | null => {
    let current: Element | null = el;
    let depth = 0;
    while (current && current !== document.body && depth < 8) {
      if (isVisible(current) && isActionable(current, inferRole(current))) {
        return current;
      }
      current = current.parentElement;
      depth += 1;
    }

    const descendant = Array.from(el.querySelectorAll('*')).find((candidate) =>
      isVisible(candidate) && isActionable(candidate, inferRole(candidate)),
    );
    return descendant ?? null;
  };

  const getAttributes = (el: Element): Record<string, string> | undefined => {
    const names = ['id', 'data-testid', 'data-test', 'aria-label', 'name', 'placeholder', 'title', 'alt'];
    const attrs: Record<string, string> = {};
    for (const name of names) {
      const value = cleanText(el.getAttribute(name), 100);
      if (value) attrs[name] = value;
    }
    return Object.keys(attrs).length > 0 ? attrs : undefined;
  };

  const contextByNode = new Map<Element, { framePath?: string[]; shadowPath?: string[] }>();

  const collectElements = (root: Element): Element[] => {
    const collected: Element[] = [];
    const seen = new Set<Element>();
    const rootContext = contextByNode.get(root) ?? {};

    const visit = (el: Element, context: { framePath?: string[]; shadowPath?: string[] }) => {
      if (seen.has(el) || seen.size >= MAX_REGISTRY_ELEMENTS) return;
      seen.add(el);
      contextByNode.set(el, context);
      if (isVisible(el)) collected.push(el);

      const children = Array.from(el.children);
      for (const child of children) {
        visit(child, context);
      }

      const shadowRoot = (el as HTMLElement).shadowRoot;
      if (shadowRoot) {
        const hostSelector = buildSelector(el);
        const shadowPath = [...(context.shadowPath ?? []), hostSelector];
        for (const child of Array.from(shadowRoot.children)) {
          visit(child, { ...context, shadowPath });
        }
      }

      if (el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement) {
        try {
          const frameDocument = el.contentDocument;
          const frameRoot = frameDocument?.documentElement;
          if (!frameRoot) return;
          const frameSelector = buildSelector(el);
          const framePath = [...(context.framePath ?? []), frameSelector];
          visit(frameRoot, { ...context, framePath });
        } catch {
          // Cross-origin frames are intentionally skipped in MV3-native mode.
        }
      }
    };

    visit(root, rootContext);
    return collected;
  };

  const evaluateActionability = (
    el: Element,
    role: string,
    requireEditable = false,
  ): Record<string, unknown> => {
    const htmlEl = el as HTMLElement;
    const rect = htmlEl.getBoundingClientRect?.();
    const visible = isVisible(el);
    const enabled = !('disabled' in htmlEl) || !Boolean((htmlEl as HTMLInputElement).disabled);
    const editable = htmlEl.isContentEditable
      || (htmlEl instanceof HTMLTextAreaElement && !htmlEl.disabled && !htmlEl.readOnly)
      || (htmlEl instanceof HTMLInputElement && !htmlEl.disabled && !htmlEl.readOnly && !['button', 'submit', 'reset', 'checkbox', 'radio', 'hidden', 'file', 'image'].includes((htmlEl.type || '').toLowerCase()));
    let receivesEvents = false;
    if (rect && rect.width > 0 && rect.height > 0) {
      const ownerDocument = el.ownerDocument ?? document;
      const pointX = Math.max(1, Math.min(rect.left + rect.width / 2, (ownerDocument.defaultView?.innerWidth ?? window.innerWidth) - 1));
      const pointY = Math.max(1, Math.min(rect.top + rect.height / 2, (ownerDocument.defaultView?.innerHeight ?? window.innerHeight) - 1));
      const hit = ownerDocument.elementFromPoint(pointX, pointY);
      receivesEvents = Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
    }
    const actionable = isActionable(el, role);

    return {
      visible,
      enabled,
      editable: requireEditable ? editable : undefined,
      stable: true,
      receivesEvents,
      actionable,
      ok: visible && enabled && receivesEvents && actionable && (!requireEditable || editable),
    };
  };

  const createEntry = (
    el: Element,
    ref: string,
    parentRef?: string,
  ): BrowserSnapshotElement => {
    const role = inferRole(el);
    const text = getElementText(el);
    const name = getAccessibleName(el, role) || text;
    const context = contextByNode.get(el);
    return {
      ref,
      parentRef,
      framePath: context?.framePath,
      shadowPath: context?.shadowPath,
      role,
      name,
      text: text && text !== name ? text : undefined,
      tagName: el.tagName.toLowerCase(),
      type: (el as HTMLInputElement).type || undefined,
      selector: buildSelector(el),
      actionable: isActionable(el, role),
      depth: getDepth(el),
      bounds: getBounds(el),
      attributes: getAttributes(el),
    };
  };

  const isMostlyContainerText = (el: Element, text: string): boolean => {
    if (!text) return false;
    const children = Array.from(el.children).filter((child) => isVisible(child));
    if (children.length === 0) return false;
    const childText = cleanText(children.map((child) => (child as HTMLElement).innerText || child.textContent || '').join(' '), 220);
    return childText.length > 0 && text.startsWith(childText.slice(0, Math.min(80, childText.length)));
  };

  const isMeaningfulEntry = (entry: BrowserSnapshotElement, el: Element): boolean => {
    if (entry.actionable) return true;
    if (['heading', 'image', 'table', 'row', 'list', 'listitem', 'navigation', 'main', 'form', 'search', 'banner', 'contentinfo', 'dialog', 'article'].includes(entry.role)) {
      return true;
    }
    if (entry.role === 'region' && (entry.name || ['canvas', 'svg', 'video', 'section'].includes(entry.tagName))) return true;
    const text = entry.text || entry.name;
    if (!text || text.length < 2) return false;
    if (['div', 'span', 'body'].includes(entry.tagName) && isMostlyContainerText(el, text)) return false;
    return ['p', 'label', 'legend', 'caption', 'strong', 'em', 'code', 'pre', 'td', 'th', 'li', 'span'].includes(entry.tagName);
  };

  const resolveStoredElement = (
    ref: string,
    snapshotId?: string,
  ): { snapshotId: string; snapshot: StoredSnapshot; node?: Element; entry?: BrowserSnapshotElement } | null => {
    const state = getState();
    const candidateIds = snapshotId
      ? [snapshotId]
      : [state.currentSnapshotId, ...state.snapshotOrder.slice().reverse()].filter(Boolean) as string[];

    for (const id of candidateIds) {
      const snapshot = state.snapshots[id];
      if (!snapshot) continue;
      const entry = snapshot.entriesByRef[ref];
      const node = snapshot.nodesByRef[ref];
      if (entry || node) return { snapshotId: id, snapshot, node, entry };
    }
    return null;
  };

  const normalizeOptions = (options?: BrowserSnapshotOptions): Required<Pick<BrowserSnapshotOptions, 'mode' | 'maxElements'>> & BrowserSnapshotOptions => ({
    mode: options?.mode === 'full' ? 'full' : 'compact',
    maxElements: Math.max(1, Math.min(Math.floor(options?.maxElements ?? 70), 250)),
    rootRef: options?.rootRef,
    snapshotId: options?.snapshotId,
  });

  const captureSnapshot = (
    tabId: number,
    options?: BrowserSnapshotOptions,
  ): { snapshot: BrowserSnapshot; allEntries: BrowserSnapshotElement[]; nodesByRef: Record<string, Element> } => {
    const normalized = normalizeOptions(options);
    const storedRoot = normalized.rootRef
      ? resolveStoredElement(normalized.rootRef, normalized.snapshotId)
      : null;
    const root = isElementNode(storedRoot?.node) && isVisible(storedRoot.node)
      ? storedRoot.node
      : document.body;
    contextByNode.clear();
    const allNodes = collectElements(root).slice(0, MAX_REGISTRY_ELEMENTS);

    const refsByNode = new Map<Element, string>();
    allNodes.forEach((node, index) => refsByNode.set(node, `e${index + 1}`));
    const rootRef = root !== document.body ? refsByNode.get(root) : undefined;

    const nodesByRef: Record<string, Element> = {};
    const allEntries = allNodes.map((node) => {
      const ref = refsByNode.get(node)!;
      let parentRef: string | undefined;
      let parent = node.parentElement;
      while (parent) {
        const candidate = refsByNode.get(parent);
        if (candidate) {
          parentRef = candidate;
          break;
        }
        parent = parent.parentElement;
      }
      nodesByRef[ref] = node;
      return createEntry(node, ref, parentRef);
    });

    const displayedEntries = (normalized.mode === 'full'
      ? allEntries
      : allEntries.filter((entry) => isMeaningfulEntry(entry, nodesByRef[entry.ref])))
      .slice(0, normalized.maxElements);

    const snapshotId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const snapshot: BrowserSnapshot = {
      ok: true,
      snapshotId,
      tabId,
      url: location.href,
      title: document.title,
      generatedAt: Date.now(),
      viewport: getViewport(),
      elements: displayedEntries,
      visibleElementCount: allEntries.length,
      displayedElementCount: displayedEntries.length,
      omittedElementCount: Math.max(allEntries.length - displayedEntries.length, 0),
      rootRef,
    };

    const entriesByRef: Record<string, BrowserSnapshotElement> = {};
    for (const entry of allEntries) {
      entriesByRef[entry.ref] = entry;
    }

    const state = getState();
    state.snapshots[snapshotId] = {
      snapshotId,
      entriesByRef,
      nodesByRef,
      order: allEntries.map((entry) => entry.ref),
      createdAt: Date.now(),
    };
    state.currentSnapshotId = snapshotId;
    state.snapshotOrder = [...state.snapshotOrder.filter((id) => id !== snapshotId), snapshotId];
    while (state.snapshotOrder.length > MAX_STORED_SNAPSHOTS) {
      const expired = state.snapshotOrder.shift();
      if (expired) delete state.snapshots[expired];
    }

    return { snapshot, allEntries, nodesByRef };
  };

  const findBySelector = (entry: BrowserSnapshotElement): Element | null => {
    if (!entry.selector) return null;
    try {
      const matches = Array.from(document.querySelectorAll(entry.selector)).filter((candidate) => isVisible(candidate));
      if (matches.length !== 1) return null;
      return matches[0];
    } catch {
      return null;
    }
  };

  const scoreRecoveryCandidate = (
    oldEntry: BrowserSnapshotElement,
    candidate: BrowserSnapshotElement,
  ): number => {
    let score = 0;
    if (candidate.tagName === oldEntry.tagName) score += 4;
    if (candidate.role === oldEntry.role) score += 6;
    if (candidate.type && candidate.type === oldEntry.type) score += 4;
    if (candidate.name && oldEntry.name && candidate.name === oldEntry.name) score += 24;
    if (candidate.text && oldEntry.text && candidate.text === oldEntry.text) score += 10;
    if (candidate.attributes?.id && candidate.attributes.id === oldEntry.attributes?.id) score += 30;
    if (candidate.attributes?.['data-testid'] && candidate.attributes['data-testid'] === oldEntry.attributes?.['data-testid']) score += 30;
    if (candidate.attributes?.name && candidate.attributes.name === oldEntry.attributes?.name) score += 12;
    if (candidate.attributes?.placeholder && candidate.attributes.placeholder === oldEntry.attributes?.placeholder) score += 12;

    const dx = Math.abs(candidate.bounds.left - oldEntry.bounds.left);
    const dy = Math.abs(candidate.bounds.top - oldEntry.bounds.top);
    if (dx <= 4 && dy <= 4) score += 8;
    else if (dx <= 32 && dy <= 32) score += 4;

    return score;
  };

  const signatureFromEntry = (entry: BrowserSnapshotElement): BrowElementSignature => {
    const textEntry = ['textbox', 'searchbox'].includes(entry.role)
      || ['input', 'textarea'].includes(entry.tagName)
      || entry.type === 'password';
    const attrs = entry.attributes ?? {};
    return {
      role: entry.role,
      name: textEntry
        ? cleanText(attrs['aria-label'] ?? attrs.placeholder ?? attrs.name ?? attrs.title, 120)
        : cleanText(entry.name, 120),
      text: textEntry ? undefined : cleanText(entry.text, 120),
      tagName: entry.tagName,
      type: entry.type,
      selector: entry.selector,
      attributes: entry.attributes,
    };
  };

  const scoreMemoryCandidate = (
    signature: BrowElementSignature,
    candidate: BrowserSnapshotElement,
  ): number => {
    const candidateSignature = signatureFromEntry(candidate);
    let score = 0;

    if (candidateSignature.role === signature.role) score += 16;
    if (candidateSignature.tagName === signature.tagName) score += 10;
    if (signature.type && candidateSignature.type === signature.type) score += 8;
    if (signature.selector && candidateSignature.selector === signature.selector) score += 12;
    if (signature.name && candidateSignature.name) {
      if (candidateSignature.name === signature.name) score += 36;
      else if (candidateSignature.name.toLowerCase() === signature.name.toLowerCase()) score += 24;
    }
    if (signature.text && candidateSignature.text) {
      if (candidateSignature.text === signature.text) score += 14;
      else if (candidateSignature.text.toLowerCase() === signature.text.toLowerCase()) score += 8;
    }

    const attrs = signature.attributes ?? {};
    const candidateAttrs = candidateSignature.attributes ?? {};
    const weightedAttrs: Array<[string, number]> = [
      ['id', 30],
      ['data-testid', 30],
      ['data-test', 26],
      ['aria-label', 22],
      ['name', 16],
      ['placeholder', 16],
      ['title', 14],
      ['alt', 14],
    ];
    for (const [name, weight] of weightedAttrs) {
      if (attrs[name] && attrs[name] === candidateAttrs[name]) score += weight;
    }

    return score;
  };

  const recoverRef = (
    oldEntry: BrowserSnapshotElement,
    currentEntries: BrowserSnapshotElement[],
    requireActionable: boolean,
  ): BrowserSnapshotElement | null => {
    const selectorMatch = findBySelector(oldEntry);
    if (selectorMatch) {
      const entry = currentEntries.find((candidate) => candidate.selector === buildSelector(selectorMatch));
      if (entry && (!requireActionable || entry.actionable)) {
        const score = scoreRecoveryCandidate(oldEntry, entry);
        if (score >= 18) return entry;
      }
    }

    const scored = currentEntries
      .filter((candidate) => !requireActionable || candidate.actionable)
      .map((candidate) => ({ candidate, score: scoreRecoveryCandidate(oldEntry, candidate) }))
      .filter((item) => item.score >= 24)
      .sort((left, right) => right.score - left.score);

    if (scored.length === 0) return null;
    const [best, second] = scored;
    if (second && best.score - second.score < 8) return null;
    return best.candidate;
  };

  if (operation.kind === 'snapshot') {
    return captureSnapshot(operation.tabId, operation.options).snapshot;
  }

  if (operation.kind === 'resolveMemory') {
    const current = captureSnapshot(operation.tabId, { mode: 'compact', maxElements: 80 });
    const requireActionable = Boolean(operation.requireActionable);
    const scored = current.allEntries
      .filter((candidate) => !requireActionable || candidate.actionable)
      .map((candidate) => ({
        candidate,
        score: Math.max(
          scoreMemoryCandidate(operation.target.signature, candidate),
          operation.target.selector && candidate.selector === operation.target.selector ? 42 : 0,
        ),
      }))
      .filter((item) => item.score >= MIN_MEMORY_MATCH_SCORE)
      .sort((left, right) => right.score - left.score);

    if (scored.length === 0) {
      return {
        ok: false,
        error: 'Cached action target was not found on the current page.',
        snapshot: current.snapshot,
      } satisfies BrowserMemoryResolution;
    }

    const [best, second] = scored;
    if (second && best.score - second.score < 8) {
      return {
        ok: false,
        error: 'Cached action target matched multiple similar elements.',
        matchScore: best.score,
        snapshot: current.snapshot,
      } satisfies BrowserMemoryResolution;
    }

    const preconditions = evaluateActionability(
      current.nodesByRef[best.candidate.ref],
      best.candidate.role,
      ['textbox', 'searchbox'].includes(best.candidate.role),
    );

    if (preconditions.ok !== true) {
      return {
        ok: false,
        error: 'Cached action target failed actionability checks.',
        ref: best.candidate.ref,
        snapshotId: current.snapshot.snapshotId,
        entry: best.candidate,
        matchScore: best.score,
        snapshot: current.snapshot,
        preconditions,
      } satisfies BrowserMemoryResolution;
    }

    return {
      ok: true,
      selector: `${BROW_REF_PREFIX}${current.snapshot.snapshotId}/${best.candidate.ref}`,
      ref: best.candidate.ref,
      snapshotId: current.snapshot.snapshotId,
      entry: best.candidate,
      matchScore: best.score,
      snapshot: current.snapshot,
      preconditions,
    } satisfies BrowserMemoryResolution;
  }

  const stored = resolveStoredElement(operation.ref, operation.snapshotId);
  const requireActionable = Boolean(operation.requireActionable);

  if (isElementNode(stored?.node) && isVisible(stored.node)) {
    const entry = createEntry(stored.node, operation.ref);
    const preconditions = evaluateActionability(stored.node, entry.role, ['textbox', 'searchbox'].includes(entry.role));
    if (requireActionable && !entry.actionable) {
      const actionTarget = findActionTarget(stored.node);
      if (actionTarget) {
        const targetEntry = createEntry(actionTarget, operation.ref);
        const targetPreconditions = evaluateActionability(actionTarget, targetEntry.role, ['textbox', 'searchbox'].includes(targetEntry.role));
        return {
          ok: true,
          ref: operation.ref,
          snapshotId: stored.snapshotId,
          selector: `${BROW_REF_PREFIX}${stored.snapshotId}/${operation.ref}`,
          entry: targetEntry,
          recovered: false,
          preconditions: targetPreconditions,
          promotedFrom: entry,
          message: `Ref ${operation.ref} pointed at a non-actionable child; using nearest actionable ${targetEntry.role}.`,
          region: {
            source: 'ref',
            ref: operation.ref,
            snapshotId: stored.snapshotId,
            rect: targetEntry.bounds,
            viewport: getViewport(),
          } satisfies BrowserVisualRegion,
        };
      }
      return {
        ok: false,
        error: `Ref ${operation.ref} resolves to a visible element, but it is not actionable.`,
        ref: operation.ref,
        snapshotId: stored.snapshotId,
        entry,
      };
    }
    return {
      ok: true,
      ref: operation.ref,
      snapshotId: stored.snapshotId,
      selector: `${BROW_REF_PREFIX}${stored.snapshotId}/${operation.ref}`,
      entry,
      recovered: false,
      preconditions,
      region: {
        source: 'ref',
        ref: operation.ref,
        snapshotId: stored.snapshotId,
        rect: entry.bounds,
        viewport: getViewport(),
      } satisfies BrowserVisualRegion,
    };
  }

  const oldEntry = stored?.entry;
  if (!oldEntry) {
    return {
      ok: false,
      error: `Unknown element ref: ${operation.ref}. Take a fresh browser_snapshot and try again.`,
      ref: operation.ref,
      snapshotId: operation.snapshotId,
    };
  }

  const current = captureSnapshot(operation.tabId, { mode: 'compact', maxElements: 80 });
  const recovered = recoverRef(oldEntry, current.allEntries, requireActionable);
  if (!recovered) {
    return {
      ok: false,
      error: `Ref ${operation.ref} is stale and could not be safely rematched. Take a fresh browser_snapshot and choose a new ref.`,
      ref: operation.ref,
      snapshotId: operation.snapshotId ?? stored?.snapshotId,
      snapshot: current.snapshot,
    };
  }

  return {
    ok: true,
    ref: recovered.ref,
    originalRef: operation.ref,
    snapshotId: current.snapshot.snapshotId,
    selector: `${BROW_REF_PREFIX}${current.snapshot.snapshotId}/${recovered.ref}`,
    entry: recovered,
    recovered: true,
    snapshot: current.snapshot,
    matchScore: scoreRecoveryCandidate(oldEntry, recovered),
    preconditions: evaluateActionability(current.nodesByRef[recovered.ref], recovered.role, ['textbox', 'searchbox'].includes(recovered.role)),
    region: {
      source: 'ref',
      ref: recovered.ref,
      snapshotId: current.snapshot.snapshotId,
      rect: recovered.bounds,
      viewport: current.snapshot.viewport,
    } satisfies BrowserVisualRegion,
  };
}

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

  const parseBrowRefSelector = (selector: string): { snapshotId: string; ref: string } | null => {
    if (!selector.startsWith(BROW_REF_PREFIX)) return null;
    const rest = selector.slice(BROW_REF_PREFIX.length);
    const slash = rest.lastIndexOf('/');
    if (slash <= 0 || slash >= rest.length - 1) return null;
    return {
      snapshotId: decodeURIComponent(rest.slice(0, slash)),
      ref: decodeURIComponent(rest.slice(slash + 1)),
    };
  };

  const resolveBrowRefElement = (selector: string): HTMLElement | null => {
    const parsed = parseBrowRefSelector(selector);
    if (!parsed) return null;
    const snapshot = getSnapshotState()?.snapshots?.[parsed.snapshotId];
    const node = snapshot?.nodesByRef?.[parsed.ref];
    return isHTMLElementLike(node) && node.isConnected ? node : null;
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

  const parseSimpleLocator = (
    selector: string,
  ): { kind: 'text' | 'heading' | 'title' | 'placeholder'; needle: string } | null => {
    const match = selector.match(/^\s*(text|heading|title|placeholder)\s*(?:=|:)\s*(.+?)\s*$/i);
    if (!match) return null;
    const kind = match[1].toLowerCase() as 'text' | 'heading' | 'title' | 'placeholder';
    const needle = normalizeInlineText(unquoteSelectorText(match[2]));
    if (!needle) return null;
    return { kind, needle };
  };

  const querySimpleLocator = (
    selector: string,
    requireUnique = false,
  ): { element: HTMLElement; resolvedSelector: string } | null => {
    const parsed = parseSimpleLocator(selector);
    if (!parsed) return null;

    const baseSelectors =
      parsed.kind === 'heading'
        ? ['h1, h2, h3, h4, h5, h6, [role="heading"]']
        : parsed.kind === 'title'
          ? ['[title]']
          : parsed.kind === 'placeholder'
            ? ['[placeholder]']
            : ['a, button, input, textarea, select, label, summary, h1, h2, h3, h4, h5, h6, p, span, div, li, dt, dd, article, section, [role="button"], [role="link"], [role="heading"], [title], [placeholder], [aria-label]'];

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
    || part.includes('[id=')
    || part.includes('[data-testid=')
    || part.includes('[aria-label=')
    || part.includes('[name=')
    || part.includes('[placeholder=')
  );

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

  const resolveClickPlan = (matchedEl: HTMLElement): ClickPlan | null => {
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
    const activeTarget = asTypeableElement(document.activeElement);
    if (activeTarget) return activeTarget;

    const directTarget = asTypeableElement(matchedEl);
    if (directTarget) return directTarget;

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
    if (descendantTarget) return descendantTarget;

    let parent = matchedEl.parentElement;
    let depth = 0;
    while (parent && parent !== document.body && depth < 6) {
      const parentTarget = asTypeableElement(parent) ?? findIn(parent);
      if (parentTarget) return parentTarget;
      parent = parent.parentElement;
      depth += 1;
    }

    const visibleTypeTargets = Array.from(document.querySelectorAll(selector))
      .map((candidate) => asTypeableElement(candidate))
      .filter((candidate): candidate is TypeableElement => Boolean(candidate));
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

    const initialPlan = resolveClickPlan(el);
    if (!initialPlan) {
      return { ok: false, error: 'Matched element has no visible click target' };
    }

    await previewClick(el, `Brow clicking ${describeElement(el)}`);
    const finalPlan = resolveClickPlan(el) ?? initialPlan;
    finalPlan.target.focus({ preventScroll: true });
    dispatchClick(el, finalPlan);
    cleanupOverlay();

    return {
      ok: true,
      clicked: summarizeElement(resolvedSelector, el),
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
        await sleep(120);
        dispatchEnter(typeTarget);
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
          setValue(el as HTMLInputElement | HTMLTextAreaElement, String(field.value));
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
      await sleep(140);
      formForSubmit.requestSubmit?.();
      if (!formForSubmit.requestSubmit) formForSubmit.submit();
      submitted = true;
    } else {
      submitError = 'No parent form found to submit';
    }
  }

  cleanupOverlay(1000);

  const hadFieldErrors = results.some((result) => !result.ok);
  return {
    ok: !hadFieldErrors && !submitError,
    results,
    submitted,
    error: submitError ?? (hadFieldErrors ? 'One or more form fields could not be filled' : undefined),
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
): Promise<{ ok: boolean; clicked?: InteractiveElementInfo; error?: string }> {
  try {
    await ensureTabIsActive(tabId);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'click', selector }],
    });

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
      error?: string;
    } | undefined) ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to fill form' };
  }
}

export interface BrowserRefResolution {
  ok: boolean;
  ref?: string;
  originalRef?: string;
  snapshotId?: string;
  selector?: string;
  entry?: BrowserSnapshotElement;
  recovered?: boolean;
  region?: BrowserVisualRegion;
  snapshot?: BrowserSnapshot;
  matchScore?: number;
  preconditions?: Record<string, unknown>;
  error?: string;
}

export interface BrowserActionResult {
  ok: boolean;
  action?: unknown;
  resolved?: BrowserRefResolution;
  snapshot?: BrowserSnapshot;
  cacheStatus?: BrowActionCacheStatus;
  trace?: BrowActionTrace;
  postconditions?: BrowPostconditionResult[];
  repairNeeded?: boolean;
  error?: string;
}

export interface BrowserFormFillField {
  ref: string;
  value: string | number | boolean;
  mode?: FormFillMode;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageSettlingProbe,
      args: [{ timeoutMs }],
    });

    return (results?.[0]?.result as { ok: boolean; readyState: string; quietMs: number; durationMs: number; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab while waiting for page stability' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to wait for page stability' };
  }
}

export async function browserSnapshot(
  tabId: number,
  options: BrowserSnapshotOptions = {},
): Promise<BrowserSnapshot> {
  try {
    await waitForTabSettled(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runBrowserSnapshotOperation,
      args: [{ kind: 'snapshot', tabId, options }],
    });

    return (results?.[0]?.result as BrowserSnapshot | undefined)
      ?? {
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
        error: 'No response from tab',
      };
  } catch (err: any) {
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
      error: err?.message ?? 'Failed to capture browser snapshot',
    };
  }
}

export async function browserResolveRef(
  tabId: number,
  ref: string,
  snapshotId?: string,
  requireActionable = false,
): Promise<BrowserRefResolution> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runBrowserSnapshotOperation,
      args: [{ kind: 'resolve', tabId, ref, snapshotId, requireActionable }],
    });

    return (results?.[0]?.result as BrowserRefResolution | undefined)
      ?? { ok: false, ref, snapshotId, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, ref, snapshotId, error: err?.message ?? 'Failed to resolve element ref' };
  }
}

async function browserResolveMemoryTarget(
  tabId: number,
  target: BrowActionMemoryTarget,
  requireActionable = true,
): Promise<BrowserMemoryResolution> {
  try {
    await waitForTabSettled(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runBrowserSnapshotOperation,
      args: [{ kind: 'resolveMemory', tabId, target, requireActionable }],
    });

    return (results?.[0]?.result as BrowserMemoryResolution | undefined)
      ?? { ok: false, error: 'No response from tab while resolving cached action target' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to resolve cached action target' };
  }
}

async function snapshotAfterAction(tabId: number): Promise<BrowserSnapshot> {
  await delay(180);
  await waitForTabSettled(tabId);
  return browserSnapshot(tabId, { mode: 'compact', maxElements: 80 });
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
        results.push({ ok: actual === condition.value, condition, actual });
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

async function tryReplaySingleTargetAction(params: {
  tabId: number;
  actionKind: Exclude<BrowActionKind, 'fillForm'>;
  options?: BrowserActionOptions;
  trace: BrowActionTrace;
  execute: (selector: string) => Promise<unknown>;
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
  const resolved = await browserResolveMemoryTarget(params.tabId, lookup.entry.target, true);
  params.trace.matchScore = resolved.matchScore;
  params.trace.preconditions = resolved.preconditions;
  params.trace.snapshotId = resolved.snapshotId;
  params.trace.resolvedRef = resolved.ref;

  if (!resolved.ok || !resolved.selector) {
    params.trace.cacheStatus = 'stale';
    params.trace.recoveryDecision = resolved.error ?? 'cached target could not be replayed';
    return null;
  }

  const action = await params.execute(resolved.selector);
  const snapshot = await snapshotAfterAction(params.tabId);
  const postconditions = await evaluatePostconditions(params.tabId, snapshot, params.options.postconditions);
  params.trace.execution = action as Record<string, unknown>;
  params.trace.postconditions = postconditions;

  if (!Boolean((action as any).ok) || !postconditionsPassed(postconditions)) {
    params.trace.cacheStatus = 'stale';
    params.trace.recoveryDecision = !Boolean((action as any).ok)
      ? ((action as any).error ?? 'cached action execution failed')
      : 'cached action postcondition failed';
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
  ref: string,
  snapshotId?: string,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'click', options);
  const replayed = await tryReplaySingleTargetAction({
    tabId,
    actionKind: 'click',
    options,
    trace,
    execute: (selector) => tabsClick(tabId, selector),
  });
  if (replayed) return replayed;

  await waitForTabSettled(tabId);
  const resolved = await browserResolveRef(tabId, ref, snapshotId, true);
  trace.resolvedRef = resolved.ref;
  trace.originalRef = resolved.originalRef ?? ref;
  trace.snapshotId = resolved.snapshotId;
  trace.matchScore = resolved.matchScore;
  trace.preconditions = resolved.preconditions;
  if (!resolved.ok || !resolved.selector) {
    trace.recoveryDecision = resolved.error ?? `Unable to resolve ref ${ref}`;
    return { ok: false, resolved, cacheStatus: trace.cacheStatus, trace: completeTrace(trace), error: trace.recoveryDecision };
  }

  const action = await tabsClick(tabId, resolved.selector);
  const snapshot = await snapshotAfterAction(tabId);
  const postconditions = await evaluatePostconditions(tabId, snapshot, options.postconditions);
  trace.execution = action as Record<string, unknown>;
  trace.postconditions = postconditions;
  const actionOk = Boolean((action as any).ok);
  const postconditionsOk = postconditionsPassed(postconditions);
  if (actionOk && postconditionsOk) {
    const storedStatus = await rememberSingleTargetAction({
      actionKind: 'click',
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
    snapshot,
    cacheStatus: trace.cacheStatus,
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Click postcondition failed')
      : ((action as any).error ?? 'Click failed'),
  };
}

export async function browserHover(
  tabId: number,
  ref: string,
  snapshotId?: string,
  message?: string,
  durationMs?: number,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'hover', options);
  const replayed = await tryReplaySingleTargetAction({
    tabId,
    actionKind: 'hover',
    options,
    trace,
    execute: (selector) => tabsHover(tabId, selector, message, durationMs),
  });
  if (replayed) return replayed;

  await waitForTabSettled(tabId);
  const resolved = await browserResolveRef(tabId, ref, snapshotId, true);
  trace.resolvedRef = resolved.ref;
  trace.originalRef = resolved.originalRef ?? ref;
  trace.snapshotId = resolved.snapshotId;
  trace.matchScore = resolved.matchScore;
  trace.preconditions = resolved.preconditions;
  if (!resolved.ok || !resolved.selector) {
    trace.recoveryDecision = resolved.error ?? `Unable to resolve ref ${ref}`;
    return { ok: false, resolved, cacheStatus: trace.cacheStatus, trace: completeTrace(trace), error: trace.recoveryDecision };
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
    snapshot,
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
  ref: string,
  text: string,
  submit = false,
  snapshotId?: string,
  options: BrowserActionOptions = {},
): Promise<BrowserActionResult> {
  const trace = createActionTrace(tabId, 'type', options);
  const replayed = await tryReplaySingleTargetAction({
    tabId,
    actionKind: 'type',
    options,
    trace,
    execute: (selector) => tabsType(tabId, selector, text, submit),
  });
  if (replayed) return replayed;

  await waitForTabSettled(tabId);
  const resolved = await browserResolveRef(tabId, ref, snapshotId, false);
  trace.resolvedRef = resolved.ref;
  trace.originalRef = resolved.originalRef ?? ref;
  trace.snapshotId = resolved.snapshotId;
  trace.matchScore = resolved.matchScore;
  trace.preconditions = resolved.preconditions;
  if (!resolved.ok || !resolved.selector) {
    trace.recoveryDecision = resolved.error ?? `Unable to resolve ref ${ref}`;
    return { ok: false, resolved, cacheStatus: trace.cacheStatus, trace: completeTrace(trace), error: trace.recoveryDecision };
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
    snapshot,
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
  const resolvedFields: FormFillField[] = [];
  const resolutions: BrowserRefResolution[] = [];

  for (const field of fields) {
    const resolved = await browserResolveRef(tabId, field.ref, snapshotId, true);
    resolutions.push(resolved);
    if (!resolved.ok || !resolved.selector) {
      trace.resolvedRef = resolved.ref;
      trace.snapshotId = resolved.snapshotId;
      trace.preconditions = resolved.preconditions;
      trace.recoveryDecision = resolved.error ?? `Unable to resolve form field ref ${field.ref}`;
      return {
        ok: false,
        resolved,
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
    submitResolution = await browserResolveRef(tabId, submitRef, snapshotId, true);
    if (!submitResolution.ok || !submitResolution.selector) {
      trace.resolvedRef = submitResolution.ref;
      trace.snapshotId = submitResolution.snapshotId;
      trace.preconditions = submitResolution.preconditions;
      trace.recoveryDecision = submitResolution.error ?? `Unable to resolve submit ref ${submitRef}`;
      return {
        ok: false,
        resolved: submitResolution,
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
    snapshot,
    cacheStatus: trace.cacheStatus,
    trace: completeTrace(trace),
    postconditions,
    repairNeeded: actionOk && !postconditionsOk,
    error: actionOk
      ? (postconditionsOk ? undefined : 'Form fill postcondition failed')
      : ((action as any).error ?? 'Form fill failed'),
  };
}
