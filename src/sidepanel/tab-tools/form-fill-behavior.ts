export type FormFillTextCommitMode = 'none' | 'enter';
export interface FormFillSubmitCandidate {
  tagName?: string | null;
  type?: string | null;
  role?: string | null;
  text?: string | null;
  name?: string | null;
  id?: string | null;
  testId?: string | null;
}

export interface FormFillTextFieldSemantics {
  tagName?: string | null;
  role?: string | null;
  type?: string | null;
  ariaAutocomplete?: string | null;
  ariaHaspopup?: string | null;
  ariaControls?: string | null;
  hasListAttribute?: boolean;
}

export interface FormFillActionOutcomeInput {
  hadFieldErrors: boolean;
  submitRequested: boolean;
  submitted: boolean;
  submitError?: string;
}

export interface FormFillActionOutcome {
  ok: boolean;
  warning?: string;
  error?: string;
}

const SOFT_SUBMIT_ERROR = 'No parent form found to submit';
const POSITIVE_SUBMIT_PATTERNS: RegExp[] = [
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
const NEGATIVE_SUBMIT_PATTERNS: RegExp[] = [
  /\bcancel\b/i,
  /\bback\b/i,
  /\bclose\b/i,
  /\bdismiss\b/i,
  /\bmenu\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\breset\b/i,
];
const MIN_INFERRED_SUBMIT_SCORE = 75;
const MIN_INFERRED_SUBMIT_GAP = 25;

function normalizeAttributeValue(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}
function scoreSubmitCandidate(candidate: FormFillSubmitCandidate): number {
  const tagName = normalizeAttributeValue(candidate.tagName);
  const type = normalizeAttributeValue(candidate.type);
  const role = normalizeAttributeValue(candidate.role);
  const textSignals = [candidate.text, candidate.name, candidate.id, candidate.testId]
    .map((value) => normalizeAttributeValue(value))
    .filter(Boolean);

  let score = 0;

  if (tagName === 'input' && type === 'submit') score += 110;
  else if (tagName === 'button' && type === 'submit') score += 100;
  else if (tagName === 'button') score += 30;
  else if (tagName === 'input' && type === 'button') score += 20;

  if (role === 'button') score += 12;

  for (const signal of textSignals) {
    if (POSITIVE_SUBMIT_PATTERNS.some((pattern) => pattern.test(signal))) score += 45;
    if (NEGATIVE_SUBMIT_PATTERNS.some((pattern) => pattern.test(signal))) score -= 120;
  }

  return score;
}
export function chooseInferredFormSubmitCandidateIndex(
  candidates: FormFillSubmitCandidate[],
): number | undefined {
  if (candidates.length === 0) return undefined;

  const scored = candidates
    .map((candidate, index) => ({ index, score: scoreSubmitCandidate(candidate) }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (!best || best.score < MIN_INFERRED_SUBMIT_SCORE) return undefined;

  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < MIN_INFERRED_SUBMIT_GAP) return undefined;

  return best.index;
}

export function getFormFillTextCommitMode(field: FormFillTextFieldSemantics): FormFillTextCommitMode {
  const tagName = normalizeAttributeValue(field.tagName);
  if (tagName !== 'input' && tagName !== 'textarea') return 'none';

  const role = normalizeAttributeValue(field.role);
  const ariaAutocomplete = normalizeAttributeValue(field.ariaAutocomplete);
  const ariaHaspopup = normalizeAttributeValue(field.ariaHaspopup);
  const hasAriaControls = Boolean(normalizeAttributeValue(field.ariaControls));

  const isComboboxLike = role === 'combobox'
    || ariaAutocomplete === 'list'
    || ariaAutocomplete === 'both'
    || ariaHaspopup === 'listbox'
    || hasAriaControls
    || Boolean(field.hasListAttribute);

  return isComboboxLike ? 'enter' : 'none';
}

export function getFormFillActionOutcome(input: FormFillActionOutcomeInput): FormFillActionOutcome {
  if (input.hadFieldErrors) {
    return {
      ok: false,
      error: 'One or more form fields could not be filled',
    };
  }

  if (input.submitRequested && input.submitError) {
    if (!input.submitted && input.submitError === SOFT_SUBMIT_ERROR) {
      return {
        ok: true,
        warning: input.submitError,
      };
    }

    return {
      ok: false,
      error: input.submitError,
    };
  }

  return {
    ok: true,
  };
}