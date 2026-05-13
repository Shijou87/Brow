export type SimpleLocatorKind = 'text' | 'heading' | 'title' | 'placeholder' | 'link' | 'button' | 'textbox';

export interface ParsedSimpleLocator {
  kind: SimpleLocatorKind;
  needle: string;
}

export interface ParsedSnapshotRefSelector {
  snapshotId?: string;
  ref: string;
}

const BROW_REF_PREFIX = 'brow-ref://';

function normalizeInlineText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function unquoteSelectorText(value: string): string {
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
}

export function parseSnapshotRefSelector(selector: string): ParsedSnapshotRefSelector | null {
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
}

export function parseSimpleLocator(selector: string): ParsedSimpleLocator | null {
  const match = selector.match(/^\s*(text|heading|title|placeholder|link|button|textbox)\s*(?:=|:)\s*(.+?)\s*$/i);
  if (!match) return null;

  const kind = match[1].toLowerCase() as SimpleLocatorKind;
  const needle = normalizeInlineText(unquoteSelectorText(match[2]));
  if (!needle) return null;

  return { kind, needle };
}

export function simpleLocatorBaseSelectors(kind: SimpleLocatorKind): string[] {
  if (kind === 'heading') return ['h1, h2, h3, h4, h5, h6, [role="heading"]'];
  if (kind === 'title') return ['[title]'];
  if (kind === 'placeholder') return ['[placeholder]'];
  if (kind === 'link') return ['a[href], [role="link"]'];
  if (kind === 'button') return ['button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]'];
  if (kind === 'textbox') {
    return ['input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]'];
  }
  return ['a, button, input, textarea, select, label, summary, h1, h2, h3, h4, h5, h6, p, span, div, li, dt, dd, article, section, [role="button"], [role="link"], [role="heading"], [title], [placeholder], [aria-label]'];
}