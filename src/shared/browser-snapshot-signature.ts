import type {
  BrowserSnapshotElement,
  BrowElementSignature,
} from './types';

const ACTION_MEMORY_MIN_SCORE = 38;

function cleanInlineText(value: string | undefined | null, max = 160): string | undefined {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function isTextEntry(element: BrowserSnapshotElement): boolean {
  return ['textbox', 'searchbox'].includes(element.role)
    || ['input', 'textarea'].includes(element.tagName)
    || element.type === 'password';
}

export function signatureFromElement(element: BrowserSnapshotElement): BrowElementSignature {
  const textEntry = isTextEntry(element);
  const attributes = element.attributes ? { ...element.attributes } : undefined;
  const safeName = textEntry
    ? cleanInlineText(
      attributes?.['aria-label']
      ?? attributes?.placeholder
      ?? attributes?.name
      ?? attributes?.title,
      120,
    )
    : cleanInlineText(element.name, 120);

  return {
    role: element.role,
    name: safeName ?? '',
    text: textEntry ? undefined : cleanInlineText(element.text, 120),
    tagName: element.tagName,
    type: element.type,
    selector: cleanInlineText(element.selector, 240),
    attributes,
  };
}

export function scoreElementSignature(
  signature: BrowElementSignature,
  candidate: BrowserSnapshotElement,
): number {
  const candidateSignature = signatureFromElement(candidate);
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
    if (attrs[name] && attrs[name] === candidateAttrs[name]) {
      score += weight;
    }
  }

  return score;
}

export function isConfidentActionMemoryScore(score: number): boolean {
  return score >= ACTION_MEMORY_MIN_SCORE;
}
