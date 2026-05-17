// ─── Browser Snapshot Engine ───────────────────────────────────────────────
// Converts the live DOM into Brow's ref-based Browser Snapshot and Form
// Snapshot contracts, keeps the short-lived ref registry needed for execution,
// and resolves/executes snapshot operations requested from the extension.

import { buildComboboxState } from '../shared/combobox-state';
import {
  isGenericSnapshotLabel,
  isGenericSnapshotTag,
  selectSnapshotEntriesForDisplay,
} from '../shared/browser-snapshot-selection';
import { prioritizeFormSnapshotControls } from './form-snapshot-priority';
import { createBrowserSnapshotResolutionRuntime } from './browser-snapshot-resolution';
import {
  buildBrowserSnapshotSelector as buildSelector,
  cleanDomText as cleanText,
  getSnapshotLabelText as getLabelText,
  inferBrowserSnapshotRole as inferRole,
} from './dom-evidence';
import type {
  BrowserComboboxControlledPopup,
  BrowserComboboxOption,
  BrowserFormFieldPurpose,
  BrowserFormSnapshot,
  BrowserFormSnapshotField,
  BrowserFormSnapshotFieldPurposeInfo,
  BrowserFormSnapshotForm,
  BrowserFormSnapshotOptions,
  BrowserFormSnapshotPurposeEvidence,
  BrowserRefResolution,
  BrowserSnapshot,
  BrowserSnapshotElement,
  BrowserSnapshotOperation,
  BrowserSnapshotOperationResult,
  BrowserSnapshotOptions,
  BrowserViewportInfo,
  BrowserViewportRect,
} from '../shared/types';

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

type CaptureResult = {
  snapshot: BrowserSnapshot;
  allEntries: BrowserSnapshotElement[];
  nodesByRef: Record<string, Element>;
};

function getState(): SnapshotState {
  const target = window as unknown as Record<string, SnapshotState | undefined>;
  if (!target[STATE_KEY]) {
    target[STATE_KEY] = {
      snapshots: {},
      snapshotOrder: [],
    };
  }
  return target[STATE_KEY]!;
}

function isElementNode(value: unknown): value is Element {
  return Boolean(value)
    && typeof value === 'object'
    && (value as Node).nodeType === 1
    && typeof (value as Element).getBoundingClientRect === 'function';
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function getViewport(): BrowserViewportInfo {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function getBounds(el: Element): BrowserViewportRect {
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
}

function isSkippableElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (['script', 'style', 'meta', 'link', 'noscript', 'template', 'head'].includes(tag)) return true;
  if ((el as HTMLElement).id === '__brow-automation-overlay__') return true;
  if (el.closest?.('#__brow-automation-overlay__')) return true;
  return false;
}

function isVisible(el: Element): boolean {
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
}

function getDepth(el: Element): number {
  let depth = 0;
  let current = el.parentElement;
  while (current && current !== document.body) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

function getAriaLabelledByText(el: Element): string {
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  const ownerDocument = el.ownerDocument ?? document;
  return cleanText(ids.map((id) => {
    const target = ownerDocument.getElementById(id);
    return target?.textContent || target?.innerText || '';
  }).join(' '), 120);
}

function getAriaDescribedByText(el: Element): string {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const ownerDocument = el.ownerDocument ?? document;
  return cleanText(ids.map((id) => {
    const target = ownerDocument.getElementById(id);
    return target?.textContent || target?.innerText || '';
  }).join(' '), 180);
}

function getElementText(el: Element, max = 160): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    return cleanText(input.value || input.placeholder || input.name, max);
  }
  if (tag === 'textarea') {
    const textarea = el as HTMLTextAreaElement;
    return cleanText(textarea.value || textarea.placeholder || textarea.name, max);
  }
  return cleanText(el.textContent || (el as HTMLElement).innerText, max);
}

function getAccessibleName(el: Element, role: string): string {
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

  return cleanText(el.textContent || (el as HTMLElement).innerText, 120);
}

function hasExplicitInteractiveSemantics(el: Element, role: string): boolean {
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
  const tabIndex = htmlEl.getAttribute('tabindex');
  return tabIndex != null && Number(tabIndex) >= 0;
}

function hasExplicitInteractiveAncestor(el: Element): boolean {
  let current = el.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < 8) {
    if (hasExplicitInteractiveSemantics(current, inferRole(current))) return true;
    current = current.parentElement;
    depth += 1;
  }
  return false;
}

function isActionable(el: Element, role: string): boolean {
  if (hasExplicitInteractiveSemantics(el, role)) return true;

  const tag = el.tagName.toLowerCase();
  const pointerCursor = (el.ownerDocument.defaultView ?? window).getComputedStyle(el).cursor === 'pointer';
  if (!pointerCursor) return false;
  if (isGenericSnapshotTag(tag) && hasExplicitInteractiveAncestor(el)) return false;
  if (['path', 'g', 'defs', 'use', 'circle', 'rect', 'line', 'polygon', 'polyline'].includes(tag)) return false;

  const name = getAccessibleName(el, role) || getElementText(el, 80);
  return Boolean(name && !isGenericSnapshotLabel(name));
}

function findActionTarget(el: Element): Element | null {
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
}

function getAttributes(el: Element): Record<string, string> | undefined {
  const names = [
    'id',
    'data-testid',
    'data-test',
    'aria-label',
    'aria-controls',
    'aria-owns',
    'aria-expanded',
    'aria-autocomplete',
    'aria-activedescendant',
    'name',
    'placeholder',
    'title',
    'alt',
  ];
  const attrs: Record<string, string> = {};
  for (const name of names) {
    const value = cleanText(el.getAttribute(name), 100);
    if (value) attrs[name] = value;
  }
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function getComboboxCurrentValue(el: Element): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return cleanText(el.value, 160) || undefined;
  }
  if (el instanceof HTMLSelectElement) {
    const selected = Array.from(el.selectedOptions)
      .map((option) => cleanText(option.label || option.textContent || option.value, 120))
      .filter(Boolean);
    return selected.length > 0 ? selected.join(', ') : undefined;
  }
  if ((el as HTMLElement).isContentEditable) {
    return cleanText(el.textContent || (el as HTMLElement).innerText, 160) || undefined;
  }
  return undefined;
}

function getReferencedElementIds(value: string | null | undefined): string[] {
  return Array.from(new Set((value ?? '')
    .split(/\s+/)
    .map((part) => cleanText(part, 120))
    .filter(Boolean)));
}

function getComboboxPopupIds(el: Element): string[] {
  const ids = [
    ...getReferencedElementIds(el.getAttribute('aria-controls')),
    ...getReferencedElementIds(el.getAttribute('aria-owns')),
  ];

  if (el instanceof HTMLInputElement) {
    const listId = cleanText(el.getAttribute('list') || el.list?.id, 120);
    if (listId) ids.push(listId);
  }

  return Array.from(new Set(ids));
}

function collectPopupOptionElements(popup: Element): Element[] {
  const optionSelector = [
    '[role="option"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    'li',
    'button',
  ].join(', ');
  const candidates = popup.matches(optionSelector)
    ? [popup, ...Array.from(popup.querySelectorAll(optionSelector))]
    : Array.from(popup.querySelectorAll(optionSelector));
  const seen = new Set<Element>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return isVisible(candidate);
  });
}

function getControlledPopup(
  el: Element,
  refsByNode: Map<Element, string>,
  entriesByNode: Map<Element, BrowserSnapshotElement>,
): BrowserComboboxControlledPopup | undefined {
  const ownerDocument = el.ownerDocument ?? document;
  const activeDescendantId = cleanText(el.getAttribute('aria-activedescendant'), 120);

  for (const popupId of getComboboxPopupIds(el)) {
    const popup = ownerDocument.getElementById(popupId);
    if (!popup) continue;

    const options: BrowserComboboxOption[] = [];
    for (const candidate of collectPopupOptionElements(popup)) {
      const entry = entriesByNode.get(candidate);
      const role = entry?.role || inferRole(candidate);
      const text = cleanText(getAccessibleName(candidate, role) || getElementText(candidate, 120), 120);
      if (!text) continue;
      const selected = candidate.getAttribute('aria-selected') === 'true'
        || Boolean(activeDescendantId && candidate.id === activeDescendantId)
        || (candidate instanceof HTMLOptionElement && candidate.selected);
      const disabled = candidate.getAttribute('aria-disabled') === 'true'
        || ('disabled' in candidate && Boolean((candidate as HTMLInputElement | HTMLButtonElement).disabled));
      const actionable = entry?.actionable || isActionable(candidate, role);
      options.push({
        ref: refsByNode.get(candidate),
        role,
        text,
        selected: selected || undefined,
        disabled: disabled || undefined,
        actionable: actionable || undefined,
      });
      if (options.length >= 8) break;
    }

    const visible = isVisible(popup) || options.length > 0;
    if (!visible && options.length === 0) continue;

    return {
      ref: refsByNode.get(popup),
      role: inferRole(popup),
      visible,
      options,
    };
  }

  return undefined;
}

function getComboboxStateForEntry(
  el: Element,
  entry: BrowserSnapshotElement,
  refsByNode: Map<Element, string>,
  entriesByNode: Map<Element, BrowserSnapshotElement>,
): BrowserSnapshotElement['combobox'] {
  return buildComboboxState({
    role: entry.role,
    accessibleName: entry.name,
    currentValue: getComboboxCurrentValue(el),
    placeholder: el.getAttribute('placeholder'),
    ariaExpanded: el.getAttribute('aria-expanded'),
    ariaControls: el.getAttribute('aria-controls'),
    ariaOwns: el.getAttribute('aria-owns'),
    ariaAutocomplete: el.getAttribute('aria-autocomplete'),
    ariaActiveDescendant: el.getAttribute('aria-activedescendant'),
    hasListAttribute: el instanceof HTMLInputElement && (el.hasAttribute('list') || Boolean(el.list)),
    controlledPopup: getControlledPopup(el, refsByNode, entriesByNode),
  });
}

const contextByNode = new Map<Element, { framePath?: string[]; shadowPath?: string[] }>();

function collectElements(root: Element): Element[] {
  const collected: Element[] = [];
  const seen = new Set<Element>();
  const rootContext = contextByNode.get(root) ?? {};

  const visit = (el: Element, context: { framePath?: string[]; shadowPath?: string[] }) => {
    if (seen.has(el) || seen.size >= MAX_REGISTRY_ELEMENTS) return;
    seen.add(el);
    contextByNode.set(el, context);
    if (isVisible(el)) collected.push(el);

    for (const child of Array.from(el.children)) {
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
}

function evaluateActionability(
  el: Element,
  role: string,
  requireEditable = false,
): Record<string, unknown> {
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
}

function createEntry(el: Element, ref: string, parentRef?: string): BrowserSnapshotElement {
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
}

function isMostlyContainerText(el: Element, text: string): boolean {
  if (!text) return false;
  const children = Array.from(el.children).filter((child) => isVisible(child));
  if (children.length === 0) return false;
  const childText = cleanText(children.map((child) => child.textContent || (child as HTMLElement).innerText || '').join(' '), 220);
  return childText.length > 0 && text.startsWith(childText.slice(0, Math.min(80, childText.length)));
}

function resolveStoredElement(
  ref: string,
  snapshotId?: string,
): { snapshotId: string; snapshot: StoredSnapshot; node?: Element; entry?: BrowserSnapshotElement } | null {
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
}

function normalizeOptions(options?: BrowserSnapshotOptions): Required<Pick<BrowserSnapshotOptions, 'mode' | 'maxElements'>> & BrowserSnapshotOptions {
  return {
    mode: options?.mode === 'full' ? 'full' : 'compact',
    maxElements: Math.max(1, Math.min(Math.floor(options?.maxElements ?? 70), 250)),
    rootRef: options?.rootRef,
    snapshotId: options?.snapshotId,
  };
}

function captureSnapshot(tabId: number, options?: BrowserSnapshotOptions): CaptureResult {
  const normalized = normalizeOptions(options);
  const storedRoot = normalized.rootRef
    ? resolveStoredElement(normalized.rootRef, normalized.snapshotId)
    : null;
  const defaultRoot = document.body ?? document.documentElement;
  const root = isElementNode(storedRoot?.node) && isVisible(storedRoot.node)
    ? storedRoot.node
    : defaultRoot;
  contextByNode.clear();
  const allNodes = collectElements(root).slice(0, MAX_REGISTRY_ELEMENTS);

  const refsByNode = new Map<Element, string>();
  allNodes.forEach((node, index) => refsByNode.set(node, `e${index + 1}`));
  const rootRef = root !== defaultRoot ? refsByNode.get(root) : undefined;

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
  const entriesByNode = new Map<Element, BrowserSnapshotElement>();
  allNodes.forEach((node, index) => {
    const entry = allEntries[index];
    entriesByNode.set(node, entry);
  });
  for (const node of allNodes) {
    const entry = entriesByNode.get(node);
    if (!entry) continue;
    const combobox = getComboboxStateForEntry(node, entry, refsByNode, entriesByNode);
    if (combobox) entry.combobox = combobox;
  }

  const viewport = getViewport();
  const containerTextRefs = new Set<string>();
  for (const entry of allEntries) {
    const node = nodesByRef[entry.ref];
    const text = entry.text || entry.name;
    if (node && isMostlyContainerText(node, text)) {
      containerTextRefs.add(entry.ref);
    }
  }

  const displayedEntries = normalized.mode === 'full'
    ? allEntries.slice(0, normalized.maxElements)
    : selectSnapshotEntriesForDisplay(allEntries, {
      maxElements: normalized.maxElements,
      viewport,
      containerTextRefs,
    });

  const snapshotId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const snapshot: BrowserSnapshot = {
    ok: true,
    snapshotId,
    tabId,
    url: location.href,
    title: document.title,
    generatedAt: Date.now(),
    viewport,
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
}

const FORM_CONTROL_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
].join(', ');

const SENSITIVE_FIELD_PURPOSES = new Set<BrowserFormFieldPurpose>([
  'password',
  'oneTimeCode',
  'creditCardNumber',
  'creditCardExpiry',
  'creditCardCvc',
]);

function normalizeFormSnapshotOptions(options?: BrowserFormSnapshotOptions): Required<Pick<BrowserFormSnapshotOptions, 'maxFields' | 'includeHidden'>> & BrowserFormSnapshotOptions {
  return {
    maxFields: Math.max(1, Math.min(Math.floor(options?.maxFields ?? 120), 300)),
    includeHidden: options?.includeHidden ?? true,
    formRef: options?.formRef,
    snapshotId: options?.snapshotId,
  };
}

function emptyFormSnapshot(tabId: number, error: string): BrowserFormSnapshot {
  return {
    ok: false,
    snapshotId: '',
    tabId,
    url: location.href,
    title: document.title,
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

function isFormControlCandidate(el: Element): boolean {
  if (isSkippableElement(el)) return false;
  const tag = el.tagName.toLowerCase();
  if (['input', 'textarea', 'select', 'button'].includes(tag)) return true;
  const role = cleanText(el.getAttribute('role'), 50);
  return (el as HTMLElement).isContentEditable
    || ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch'].includes(role);
}

function isSubmitControl(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (el instanceof HTMLButtonElement) return (el.type || 'submit').toLowerCase() === 'submit';
  if (el instanceof HTMLInputElement) return ['submit', 'image'].includes((el.type || '').toLowerCase());
  return tag === 'button';
}

function getControlForm(el: Element): HTMLFormElement | null {
  if (
    el instanceof HTMLInputElement
    || el instanceof HTMLTextAreaElement
    || el instanceof HTMLSelectElement
    || el instanceof HTMLButtonElement
  ) {
    return el.form;
  }
  return el.closest('form');
}

function isStructurallyHidden(el: Element): boolean {
  if (el instanceof HTMLInputElement && (el.type || '').toLowerCase() === 'hidden') return true;
  const htmlEl = el as HTMLElement;
  if (htmlEl.hidden || htmlEl.getAttribute('aria-hidden') === 'true') return true;
  const ownerWindow = htmlEl.ownerDocument.defaultView ?? window;
  const style = ownerWindow.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
  const rect = htmlEl.getBoundingClientRect?.();
  return !rect || rect.width <= 0 || rect.height <= 0;
}

function isControlDisabled(el: Element): boolean {
  if ((el as HTMLElement).getAttribute('aria-disabled') === 'true') return true;
  return 'disabled' in el && Boolean((el as HTMLInputElement).disabled);
}

function isControlReadonly(el: Element): boolean {
  return 'readOnly' in el && Boolean((el as HTMLInputElement).readOnly);
}

function isFillControl(el: Element): boolean {
  if (isSubmitControl(el)) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['button', 'submit', 'reset', 'hidden', 'file', 'image'].includes((el.type || '').toLowerCase());
  }
  if ((el as HTMLElement).isContentEditable) return true;
  return ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch'].includes(cleanText(el.getAttribute('role'), 50));
}

function normalizeSemanticText(value: string | null | undefined): string {
  return cleanText(value, 180)
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function roundConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

function inferFieldPurpose(el: Element, label: string): BrowserFormSnapshotFieldPurposeInfo {
  const scores = new Map<BrowserFormFieldPurpose, { score: number; evidence: BrowserFormSnapshotPurposeEvidence[] }>();
  const add = (
    purpose: BrowserFormFieldPurpose,
    source: BrowserFormSnapshotPurposeEvidence['source'],
    rawValue: string | null | undefined,
    weight: number,
  ) => {
    const value = cleanText(rawValue, 120);
    if (!value) return;
    const current = scores.get(purpose) ?? { score: 0, evidence: [] };
    current.score += weight;
    current.evidence.push({ source, value, weight });
    scores.set(purpose, current);
  };
  const addIf = (
    purpose: BrowserFormFieldPurpose,
    source: BrowserFormSnapshotPurposeEvidence['source'],
    rawValue: string | null | undefined,
    patterns: RegExp[],
    weight: number,
  ) => {
    const normalized = normalizeSemanticText(rawValue);
    if (normalized && patterns.some((pattern) => pattern.test(normalized))) {
      add(purpose, source, rawValue, weight);
    }
  };

  const tag = el.tagName.toLowerCase();
  const type = el instanceof HTMLInputElement ? (el.type || 'text').toLowerCase() : cleanText(el.getAttribute('type'), 40).toLowerCase();
  const autocomplete = normalizeSemanticText(el.getAttribute('autocomplete'));
  const name = el.getAttribute('name');
  const id = el.id;
  const placeholder = el.getAttribute('placeholder');
  const aria = [el.getAttribute('aria-label'), getAriaLabelledByText(el)].filter(Boolean).join(' ');
  const text = getElementText(el, 120);

  if (autocomplete) {
    const autocompleteMap: Array<[RegExp, BrowserFormFieldPurpose]> = [
      [/\bcc number\b/, 'creditCardNumber'],
      [/\bcc exp\b|\bcc exp month\b|\bcc exp year\b/, 'creditCardExpiry'],
      [/\bcc csc\b|\bcc cvv\b|\bcvc\b/, 'creditCardCvc'],
      [/\bone time code\b/, 'oneTimeCode'],
      [/\bcurrent password\b|\bnew password\b|\bpassword\b/, 'password'],
      [/\bemail\b/, 'email'],
      [/\bgiven name\b|\bfirst name\b/, 'givenName'],
      [/\bfamily name\b|\blast name\b|\bsurname\b/, 'familyName'],
      [/^name$|\bfull name\b/, 'fullName'],
      [/\borganization\b|\borg\b|\bcompany\b/, 'company'],
      [/\baddress line1\b|\baddress line 1\b|\bstreet address\b|\baddress 1\b/, 'addressLine1'],
      [/\baddress line2\b|\baddress line 2\b|\baddress 2\b/, 'addressLine2'],
      [/\bpostal code\b|\bzip\b/, 'postalCode'],
      [/\bcountry\b/, 'country'],
      [/\baddress level2\b|\bcity\b/, 'city'],
      [/\baddress level1\b|\bstate\b|\bprovince\b|\bregion\b/, 'region'],
      [/\btel\b|\bphone\b/, 'phone'],
      [/\burl\b/, 'url'],
      [/\busername\b|\bnickname\b/, 'username'],
    ];
    for (const [pattern, purpose] of autocompleteMap) {
      if (pattern.test(autocomplete)) add(purpose, 'autocomplete', el.getAttribute('autocomplete'), 0.85);
    }
  }

  if (type === 'email') add('email', 'type', type, 0.65);
  if (type === 'password') add('password', 'type', type, 0.8);
  if (type === 'search') add('search', 'type', type, 0.65);
  if (type === 'tel') add('phone', 'type', type, 0.65);
  if (type === 'url') add('url', 'type', type, 0.65);
  if (type === 'checkbox') add('checkbox', 'type', type, 0.75);
  if (type === 'radio') add('radio', 'type', type, 0.75);
  if (tag === 'select') add('select', 'tag', tag, 0.75);
  if (isSubmitControl(el)) add('submit', 'type', type || tag, 0.8);

  const semanticSources: Array<[BrowserFormSnapshotPurposeEvidence['source'], string | null | undefined, number]> = [
    ['label', label, 0.5],
    ['name', name, 0.45],
    ['id', id, 0.4],
    ['placeholder', placeholder, 0.42],
    ['aria', aria, 0.45],
    ['text', text, 0.35],
  ];
  for (const [source, value, weight] of semanticSources) {
    addIf('email', source, value, [/\be mail\b|\bemail\b|\bmail\b/], weight);
    addIf('fullName', source, value, [/^name$|\bfull name\b|\byour name\b/], weight);
    addIf('givenName', source, value, [/\bfirst name\b|\bgiven name\b/], weight);
    addIf('familyName', source, value, [/\blast name\b|\bfamily name\b|\bsurname\b/], weight);
    addIf('company', source, value, [/\bcompany\b|\borganization\b|\borg\b|\bbusiness\b/], weight);
    addIf('search', source, value, [/\bsearch\b|\bquery\b|\bkeyword\b/], weight);
    addIf('addressLine1', source, value, [/\bstreet\b|\baddress 1\b|\baddress line 1\b|\baddress line1\b/], weight);
    addIf('addressLine2', source, value, [/\baddress 2\b|\baddress line 2\b|\baddress line2\b|\bapt\b|\bsuite\b/], weight);
    addIf('city', source, value, [/\bcity\b|\btown\b/], weight);
    addIf('region', source, value, [/\bstate\b|\bprovince\b|\bregion\b|\bcounty\b/], weight);
    addIf('postalCode', source, value, [/\bpostal\b|\bpostcode\b|\bzip\b/], weight);
    addIf('country', source, value, [/\bcountry\b/], weight);
    addIf('phone', source, value, [/\bphone\b|\bmobile\b|\btel\b|\btelephone\b/], weight);
    addIf('url', source, value, [/\burl\b|\bwebsite\b|\blink\b/], weight);
    addIf('username', source, value, [/\busername\b|\blogin\b|\buser id\b|\bhandle\b/], weight);
    addIf('password', source, value, [/\bpassword\b|\bpasscode\b/], weight);
    addIf('oneTimeCode', source, value, [/\bone time\b|\botp\b|\bverification code\b|\bauthentication code\b/], weight);
    addIf('creditCardNumber', source, value, [/\bcard number\b|\bcredit card\b|\bcc number\b/], weight);
    addIf('creditCardExpiry', source, value, [/\bexpiry\b|\bexpiration\b|\bcc exp\b/], weight);
    addIf('creditCardCvc', source, value, [/\bcvc\b|\bcvv\b|\bsecurity code\b|\bcc csc\b/], weight);
  }

  let bestPurpose: BrowserFormFieldPurpose = 'unknown';
  let bestScore = 0;
  let bestEvidence: BrowserFormSnapshotPurposeEvidence[] = [];
  for (const [purpose, scored] of scores) {
    if (scored.score > bestScore) {
      bestPurpose = purpose;
      bestScore = scored.score;
      bestEvidence = scored.evidence;
    }
  }

  return {
    purpose: bestPurpose,
    confidence: bestPurpose === 'unknown' ? 0.1 : roundConfidence(bestScore),
    evidence: bestEvidence.sort((a, b) => b.weight - a.weight).slice(0, 5),
  };
}

function getSafeFieldValue(
  el: Element,
  purpose: BrowserFormFieldPurpose,
  hidden: boolean,
  combobox?: BrowserFormSnapshotField['combobox'],
): BrowserFormSnapshotField['value'] | undefined {
  if (hidden) return { captureMode: 'omitted', reason: 'hidden-field' };
  if (SENSITIVE_FIELD_PURPOSES.has(purpose)) return { captureMode: 'omitted', reason: 'sensitive-purpose' };
  if (combobox?.currentValue) return { captureMode: 'safe', text: combobox.currentValue };
  if (el instanceof HTMLInputElement) {
    const type = (el.type || '').toLowerCase();
    if (['file', 'password', 'hidden'].includes(type)) return { captureMode: 'omitted', reason: `${type || 'input'}-field` };
    if (type === 'checkbox' || type === 'radio') return { captureMode: 'safe', text: el.checked ? 'checked' : 'unchecked' };
    if (['button', 'submit', 'reset'].includes(type)) return { captureMode: 'safe', text: cleanText(el.value || getElementText(el, 80), 80) };
    return { captureMode: 'omitted', reason: 'free-text-value' };
  }
  if (el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) {
    return { captureMode: 'omitted', reason: 'free-text-value' };
  }
  if (el instanceof HTMLSelectElement) {
    const selected = Array.from(el.selectedOptions).map((option) => cleanText(option.label || option.textContent || option.value, 80)).filter(Boolean);
    return { captureMode: 'safe', text: selected.join(', ') };
  }
  return undefined;
}

function getSelectOptions(
  el: Element,
  combobox?: BrowserFormSnapshotField['combobox'],
): BrowserFormSnapshotField['options'] | undefined {
  if (el instanceof HTMLSelectElement) {
    return Array.from(el.options).slice(0, 80).map((option) => ({
      value: cleanText(option.value, 120),
      label: cleanText(option.label || option.textContent || option.value, 120),
      selected: option.selected || undefined,
      disabled: option.disabled || undefined,
      source: 'native-select' as const,
    }));
  }

  const popupOptions = combobox?.controlledPopup?.visible
    ? combobox.controlledPopup.options.slice(0, 80)
    : [];
  if (popupOptions.length === 0) return undefined;

  return popupOptions.map((option) => ({
    ref: option.ref,
    value: option.text,
    label: option.text,
    selected: option.selected || undefined,
    disabled: option.disabled || undefined,
    source: 'controlled-popup' as const,
  }));
}

function getValidationCue(el: Element): BrowserFormSnapshotField['validation'] | undefined {
  const required = 'required' in el ? Boolean((el as HTMLInputElement).required) : undefined;
  const minLength = 'minLength' in el && (el as HTMLInputElement).minLength >= 0 ? (el as HTMLInputElement).minLength : undefined;
  const maxLength = 'maxLength' in el && (el as HTMLInputElement).maxLength >= 0 ? (el as HTMLInputElement).maxLength : undefined;
  const cue = {
    required: required || undefined,
    pattern: cleanText(el.getAttribute('pattern'), 120) || undefined,
    minLength,
    maxLength,
    min: cleanText(el.getAttribute('min'), 80) || undefined,
    max: cleanText(el.getAttribute('max'), 80) || undefined,
    step: cleanText(el.getAttribute('step'), 80) || undefined,
    inputMode: cleanText(el.getAttribute('inputmode'), 80) || undefined,
    ariaInvalid: cleanText(el.getAttribute('aria-invalid'), 40) || undefined,
    describedBy: cleanText(el.getAttribute('aria-describedby'), 120) || undefined,
    describedByText: getAriaDescribedByText(el) || undefined,
  };
  return Object.values(cue).some((value) => value !== undefined) ? cue : undefined;
}

function captureFormSnapshot(tabId: number, options?: BrowserFormSnapshotOptions): BrowserFormSnapshot {
  const normalized = normalizeFormSnapshotOptions(options);
  const baseCapture = captureSnapshot(tabId, { mode: 'full', maxElements: 250 });
  const stored = getState().snapshots[baseCapture.snapshot.snapshotId];
  if (!stored) return emptyFormSnapshot(tabId, 'Unable to create backing browser snapshot');

  const refsByNode = new Map<Element, string>();
  for (const ref of stored.order) {
    const node = stored.nodesByRef[ref];
    if (node) refsByNode.set(node, ref);
  }

  const ensureStoredEntry = (node: Element): BrowserSnapshotElement => {
    const existingRef = refsByNode.get(node);
    if (existingRef && stored.entriesByRef[existingRef]) return stored.entriesByRef[existingRef];

    let nextIndex = stored.order.length + 1;
    let ref = `e${nextIndex}`;
    while (stored.entriesByRef[ref]) {
      nextIndex += 1;
      ref = `e${nextIndex}`;
    }

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

    const entry = createEntry(node, ref, parentRef);
    stored.entriesByRef[ref] = entry;
    stored.nodesByRef[ref] = node;
    stored.order.push(ref);
    baseCapture.nodesByRef[ref] = node;
    baseCapture.allEntries.push(entry);
    refsByNode.set(node, ref);
    return entry;
  };

  let targetForm: HTMLFormElement | null = null;
  if (normalized.formRef) {
    const resolved = resolveStoredElement(normalized.formRef, normalized.snapshotId);
    const node = resolved?.node;
    targetForm = node instanceof HTMLFormElement ? node : node ? getControlForm(node) : null;
    if (!targetForm) {
      return emptyFormSnapshot(tabId, `No form found for ref ${normalized.formRef}`);
    }
  }

  const allControls = Array.from(document.querySelectorAll(FORM_CONTROL_SELECTOR))
    .filter(isFormControlCandidate)
    .filter((node) => !targetForm || getControlForm(node) === targetForm);
  const uniqueControls = Array.from(new Set(allControls));
  const includedControls = uniqueControls.filter((node) => normalized.includeHidden || isVisible(node));
  const selectedControls = prioritizeFormSnapshotControls(
    includedControls.map((control, index) => {
      const role = inferRole(control);
      const label = getLabelText(control) || getAccessibleName(control, role);
      const form = getControlForm(control);
      const purposeInfo = inferFieldPurpose(control, label);
      return {
        index,
        control,
        form,
        label,
        purpose: purposeInfo.purpose,
        purposeInfo,
        hidden: isStructurallyHidden(control),
        visible: isVisible(control),
        disabled: isControlDisabled(control),
        readonly: isControlReadonly(control),
        fillControl: isFillControl(control),
        hasForm: Boolean(form),
        tagName: control.tagName.toLowerCase(),
        role,
        type: control instanceof HTMLInputElement
          ? (control.type || '').toLowerCase()
          : cleanText(control.getAttribute('type'), 40).toLowerCase() || undefined,
      };
    }),
  ).slice(0, normalized.maxFields);
  const formsByRef = new Map<string, BrowserFormSnapshotForm>();

  const ensureFormSnapshot = (form: HTMLFormElement): BrowserFormSnapshotForm => {
    const entry = ensureStoredEntry(form);
    const existing = formsByRef.get(entry.ref);
    if (existing) return existing;
    const formSnapshot: BrowserFormSnapshotForm = {
      ref: entry.ref,
      selector: entry.selector,
      name: cleanText(form.getAttribute('name'), 120) || undefined,
      id: cleanText(form.id, 120) || undefined,
      label: cleanText(form.getAttribute('aria-label') || form.getAttribute('title') || form.querySelector('legend')?.textContent, 120) || undefined,
      action: cleanText(form.getAttribute('action') || form.action, 240) || undefined,
      method: cleanText(form.method, 30) || undefined,
      fieldRefs: [],
      submitRefs: [],
    };
    formsByRef.set(entry.ref, formSnapshot);
    return formSnapshot;
  };

  if (targetForm) ensureFormSnapshot(targetForm);

  const fields: BrowserFormSnapshotField[] = [];
  for (const selectedControl of selectedControls) {
    const {
      control,
      form,
      label,
      purposeInfo,
      hidden,
      visible,
      disabled,
      readonly,
      fillControl,
    } = selectedControl;
    const entry = ensureStoredEntry(control);
    const formSnapshot = form ? ensureFormSnapshot(form) : null;
    const fillTarget = visible && !hidden && !disabled && !readonly && fillControl;
    const field: BrowserFormSnapshotField = {
      ref: entry.ref,
      snapshotId: baseCapture.snapshot.snapshotId,
      selector: entry.selector,
      formRef: formSnapshot?.ref,
      role: entry.role,
      tagName: entry.tagName,
      type: entry.type,
      name: cleanText(control.getAttribute('name'), 120) || undefined,
      id: cleanText((control as HTMLElement).id, 120) || undefined,
      label: cleanText(label, 160) || undefined,
      placeholder: cleanText(control.getAttribute('placeholder'), 160) || undefined,
      autocomplete: cleanText(control.getAttribute('autocomplete'), 120) || undefined,
      required: 'required' in control ? Boolean((control as HTMLInputElement).required) : undefined,
      disabled: disabled || undefined,
      readonly: readonly || undefined,
      hidden: hidden || undefined,
      visible,
      actionable: entry.actionable,
      fillTarget,
      value: getSafeFieldValue(control, purposeInfo.purpose, hidden, entry.combobox),
      combobox: entry.combobox,
      purpose: purposeInfo,
      validation: getValidationCue(control),
      bounds: entry.bounds,
      options: getSelectOptions(control, entry.combobox),
      attributes: entry.attributes,
    };
    fields.push(field);
    if (formSnapshot) {
      formSnapshot.fieldRefs.push(entry.ref);
      if (purposeInfo.purpose === 'submit') formSnapshot.submitRefs.push(entry.ref);
    }
  }

  return {
    ok: true,
    snapshotId: baseCapture.snapshot.snapshotId,
    tabId,
    url: location.href,
    title: document.title,
    generatedAt: Date.now(),
    forms: Array.from(formsByRef.values()),
    fields,
    fieldCount: includedControls.length,
    visibleFieldCount: fields.filter((field) => field.visible).length,
    fillTargetCount: fields.filter((field) => field.fillTarget).length,
    omittedFieldCount: Math.max(includedControls.length - selectedControls.length, 0),
  };
}

const {
  resolveMemory,
  resolveTarget,
  resolveRef,
} = createBrowserSnapshotResolutionRuntime({
  browRefPrefix: BROW_REF_PREFIX,
  minMemoryMatchScore: MIN_MEMORY_MATCH_SCORE,
  isElementNode,
  isVisible,
  getViewport,
  createEntry,
  findActionTarget,
  evaluateActionability: (el, role, requireEditable) => {
    if (!el) {
      return {
        visible: false,
        enabled: false,
        receivesEvents: false,
        actionable: false,
        editable: false,
        ok: false,
      };
    }
    return evaluateActionability(el, role, requireEditable);
  },
  captureSnapshot,
  resolveStoredElement,
});

/**
 * Executes one Browser Snapshot operation against the current page runtime.
 *
 * This is the content-script entry point used by the background worker and
 * side-panel tools to capture snapshots, resolve stored refs or memory, and
 * perform ref-based execution without exposing DOM internals to higher layers.
 */
export function runBrowserSnapshotOperation(operation: BrowserSnapshotOperation): BrowserSnapshotOperationResult {
  if (operation.kind === 'snapshot') {
    return captureSnapshot(operation.tabId, operation.options).snapshot;
  }

  if (operation.kind === 'formSnapshot') {
    return captureFormSnapshot(operation.tabId, operation.options);
  }

  if (operation.kind === 'resolveMemory') {
    return resolveMemory(operation);
  }

  if (operation.kind === 'resolveTarget') {
    return resolveTarget(operation);
  }

  return resolveRef(operation);
}
