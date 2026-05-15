const selectorUniquenessCacheByDocument: WeakMap<Document, Map<string, Element | null>> = new WeakMap();

export function cleanDomText(value: string | null | undefined, max = 160): string {
  const cleaned = (value ?? '').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

export function cleanOptionalDomText(value: string | null | undefined, max = 160): string | undefined {
  const cleaned = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeCssValue(value: string): string {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

function escapeSelectorValue(value: string): string {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function hasReliableValue(value: string | null | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  return Boolean(trimmed) && !['undefined', 'null', 'nan'].includes(trimmed.toLowerCase());
}

function canUseHashIdSelector(value: string): boolean {
  return /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(value);
}

function buildIdSelector(value: string, mode: 'css' | 'selector'): string {
  const escaped = mode === 'css' ? escapeCssValue(value) : escapeSelectorValue(value);
  return canUseHashIdSelector(value)
    ? `#${escaped}`
    : `[id="${escapeAttributeValue(value)}"]`;
}

export function isUniqueSelectorFor(selector: string, el: Element): boolean {
  try {
    const ownerDocument = el.ownerDocument ?? document;
    let selectorCache = selectorUniquenessCacheByDocument.get(ownerDocument);
    if (!selectorCache) {
      selectorCache = new Map<string, Element | null>();
      selectorUniquenessCacheByDocument.set(ownerDocument, selectorCache);
    }
    if (!selectorCache.has(selector)) {
      const matches = Array.from(ownerDocument.querySelectorAll(selector));
      selectorCache.set(selector, matches.length === 1 ? matches[0] : null);
    }
    return selectorCache.get(selector) === el;
  } catch {
    return false;
  }
}

function buildAttributeSelector(tag: string, attrName: string, attrValue: string | null): string | null {
  return hasReliableValue(attrValue)
    ? `${tag}[${attrName}="${escapeAttributeValue(attrValue)}"]`
    : null;
}

function buildDomPathSelector(el: Element, options: { requireUniquePrefixes?: boolean; idEscapeMode: 'css' | 'selector' }): string {
  const parts: string[] = [];
  let current: Element | null = el;
  const ownerDocument = el.ownerDocument ?? document;

  while (current && current !== ownerDocument.body && parts.length < 7) {
    const htmlEl = current as HTMLElement;
    if (hasReliableValue(htmlEl.id)) {
      const idSelector = buildIdSelector(htmlEl.id, options.idEscapeMode);
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
    if (options.requireUniquePrefixes) {
      const candidate = parts.join(' > ');
      if (isUniqueSelectorFor(candidate, el)) return candidate;
    }
    current = parent;
  }

  return parts.join(' > ') || el.tagName.toLowerCase();
}

export function buildBrowserSnapshotSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const htmlEl = el as HTMLElement;
  const attrCandidates: Array<string | null> = [
    hasReliableValue(htmlEl.id) ? buildIdSelector(htmlEl.id, 'css') : null,
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

  return buildDomPathSelector(el, { idEscapeMode: 'css' });
}

export function buildWorkflowTargetSelector(element: Element): string | undefined {
  const tagName = element.tagName.toLowerCase();

  if (element.id) {
    const selector = buildIdSelector(element.id, 'selector');
    if (isUniqueSelectorFor(selector, element)) return selector;
  }

  const dataTestId = element.getAttribute('data-testid') ?? element.getAttribute('data-test');
  if (dataTestId) {
    for (const attrName of ['data-testid', 'data-test']) {
      const value = element.getAttribute(attrName);
      if (!value) continue;
      const selector = `[${attrName}="${escapeAttributeValue(value)}"]`;
      if (isUniqueSelectorFor(selector, element)) return selector;
      const tagSelector = `${tagName}${selector}`;
      if (isUniqueSelectorFor(tagSelector, element)) return tagSelector;
    }
  }

  const name = element.getAttribute('name');
  if (name) {
    const selector = `${tagName}[name="${escapeAttributeValue(name)}"]`;
    if (isUniqueSelectorFor(selector, element)) return selector;
  }

  for (const attrName of ['aria-label', 'placeholder', 'title', 'alt']) {
    const value = element.getAttribute(attrName);
    if (!value) continue;
    const selector = `${tagName}[${attrName}="${escapeAttributeValue(value)}"]`;
    if (isUniqueSelectorFor(selector, element)) return selector;
  }

  const classes = Array.from(element.classList).slice(0, 2);
  if (classes.length > 0) {
    const selector = `${tagName}.${classes.map((item) => escapeSelectorValue(item)).join('.')}`;
    if (isUniqueSelectorFor(selector, element)) return selector;
  }

  return buildDomPathSelector(element, { idEscapeMode: 'selector', requireUniquePrefixes: true }) || tagName;
}

export function inferBrowserSnapshotRole(el: Element): string {
  const explicit = cleanDomText(el.getAttribute('role'), 50);
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
}

export function inferWorkflowTargetRole(element: Element): string {
  const explicitRole = cleanOptionalDomText(element.getAttribute('role'));
  if (explicitRole) return explicitRole;

  const tagName = element.tagName.toLowerCase();
  if (tagName === 'button') return 'button';
  if (tagName === 'a' && (element as HTMLAnchorElement).href) return 'link';
  if (tagName === 'select') return 'combobox';
  if (tagName === 'textarea') return 'textbox';
  if (tagName === 'form') return 'form';
  if (tagName === 'canvas') return 'region';
  if (tagName === 'summary') return 'button';

  if (tagName === 'input') {
    const type = (element as HTMLInputElement).type.toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    if (type === 'file') return 'button';
    return 'textbox';
  }

  if ((element as HTMLElement).isContentEditable) return 'textbox';
  return 'region';
}

export function getControlLabelText(element: Element, max = 120): string | undefined {
  if (
    element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement
  ) {
    const labelText = Array.from(element.labels ?? [])
      .map((label) => label.textContent ?? '')
      .join(' ');
    return cleanOptionalDomText(labelText, max);
  }
  return undefined;
}

export function getSnapshotLabelText(el: Element): string {
  const input = el as HTMLInputElement;
  const labels = input.labels ? Array.from(input.labels) : [];
  const labelText = labels.map((label) => cleanDomText(label.textContent || label.innerText, 80)).find(Boolean);
  if (labelText) return labelText;

  const wrappingLabel = el.closest('label');
  if (wrappingLabel) return cleanDomText(wrappingLabel.textContent || wrappingLabel.innerText, 80);
  return '';
}

export function getTrackedElementAttributes(element: Element): Record<string, string> | undefined {
  const names = ['id', 'data-testid', 'data-test', 'aria-label', 'name', 'placeholder', 'title', 'alt'];
  const entries = names
    .map((name) => [name, element.getAttribute(name)] as const)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
