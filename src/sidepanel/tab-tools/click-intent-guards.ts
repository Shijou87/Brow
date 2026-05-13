import type {
  BrowserRefResolution,
  BrowserSnapshotElement,
  BrowActionPostcondition,
  BrowActionKind,
  BrowPostconditionResult,
} from '../../shared/types';

const GENERIC_CONTAINER_ROLES = new Set([
  'article',
  'form',
  'list',
  'main',
  'navigation',
  'region',
  'search',
  'table',
  'text',
]);

const GENERIC_CONTAINER_TAGS = new Set([
  'article',
  'aside',
  'body',
  'div',
  'form',
  'main',
  'nav',
  'section',
  'ytd-browse',
  'ytd-page-manager',
  'ytd-search',
  'ytd-two-column-browse-results-renderer',
]);

const SKIP_SAFE_POSTCONDITION_TYPES = new Set<BrowActionPostcondition['type']>([
  'elementHidden',
  'mediaState',
  'titleIncludes',
  'urlIncludes',
  'urlMatches',
  'valueEquals',
]);

const EDITABLE_CLICK_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
]);

const EDITABLE_CLICK_TAGS = new Set([
  'input',
  'textarea',
  'select',
]);

const SUBMIT_LIKE_CLICK_INTENT_PATTERNS = [
  /\bsearch button\b/i,
  /\bsearch results?\b/i,
  /\bshow results?\b/i,
  /\bview results?\b/i,
  /\bsubmit\b/i,
  /\bcontinue\b/i,
  /\bconfirm\b/i,
  /\bapply\b/i,
  /\blaunch\b/i,
  /\bbook\b/i,
  /\brechercher\b/i,
  /\bvalider\b/i,
  /\bcontinuer\b/i,
  /\bconfirmer\b/i,
  /\blancer\b/i,
  /\bbouton ok\b/i,
  /\bbouton rechercher\b/i,
  /\bcliquer sur ok\b/i,
];

function entryArea(entry: BrowserSnapshotElement | undefined): number {
  if (!entry) return 0;
  return Math.max(entry.bounds.width, 0) * Math.max(entry.bounds.height, 0);
}

export function isIntentRecoveryEntryAllowed(
  entry: BrowserSnapshotElement,
  actionKind: BrowActionKind | undefined,
): boolean {
  if (actionKind !== 'click') return true;
  if (EDITABLE_CLICK_ROLES.has(entry.role)) return false;
  if (['input', 'textarea', 'select', 'option'].includes(entry.tagName)) return false;
  return true;
}

export function shouldSkipActionForSatisfiedPostconditions(results: BrowPostconditionResult[]): boolean {
  return results.length > 0
    && results.every((result) => result.ok && SKIP_SAFE_POSTCONDITION_TYPES.has(result.condition.type));
}

export function shouldRepairForSatisfiedValuePostconditions(results: BrowPostconditionResult[]): boolean {
  return results.length > 0
    && results.every((result) => result.ok)
    && results.some((result) => result.condition.type === 'valueEquals');
}

export function getUnsafePromotedClickResolutionError(
  resolution: Pick<BrowserRefResolution, 'entry' | 'promotedFrom'>,
): string | undefined {
  const promotedFrom = resolution.promotedFrom;
  const targetEntry = resolution.entry;
  if (!promotedFrom || !targetEntry) return undefined;

  const promotedArea = entryArea(promotedFrom);
  const targetArea = entryArea(targetEntry);
  if (promotedArea <= 0 || targetArea <= 0) return undefined;

  const sourceLooksLikeContainer = GENERIC_CONTAINER_ROLES.has(promotedFrom.role)
    || GENERIC_CONTAINER_TAGS.has(promotedFrom.tagName)
    || promotedFrom.selector === '#page-manager';

  const sourceMuchLargerThanTarget = promotedArea >= targetArea * 8
    && promotedFrom.bounds.width >= targetEntry.bounds.width * 1.5
    && promotedFrom.bounds.height >= targetEntry.bounds.height * 1.5;

  if (!sourceLooksLikeContainer || !sourceMuchLargerThanTarget) return undefined;

  return 'Resolved click ref pointed at a large non-actionable container and was promoted to a smaller descendant target. Take a fresh browser_snapshot and choose an actionable ref directly.';
}

export function getUnsafeEditableClickIntentError(
  entry: BrowserSnapshotElement | undefined,
  intent: string | undefined,
): string | undefined {
  if (!entry || !intent) return undefined;

  const looksEditable = EDITABLE_CLICK_ROLES.has(entry.role) || EDITABLE_CLICK_TAGS.has(entry.tagName);
  if (!looksEditable) return undefined;

  const normalizedIntent = intent.trim();
  if (!normalizedIntent) return undefined;
  if (!SUBMIT_LIKE_CLICK_INTENT_PATTERNS.some((pattern) => pattern.test(normalizedIntent))) return undefined;

  return 'Resolved click target is an editable field, but the click intent looks like submit/search. Do not use browser_click on textboxes or comboboxes as a stand-in for search or submit; take a fresh browser_snapshot with mode="full", use browser_form_snapshot to find the real submit control, or use browser_key Enter only when the focused field is known to submit.';
}