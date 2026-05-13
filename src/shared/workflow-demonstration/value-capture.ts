import type { WorkflowDemonstrationValue } from '../types';
import type { StepBuilderOptions, WorkflowRawValueInput } from './types';

const PICKER_INPUT_TYPES = new Set(['color', 'date', 'datetime-local', 'month', 'time', 'week']);
const OMITTED_AUTOCOMPLETE_TOKENS = new Set([
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-number',
  'cc-type',
  'current-password',
  'new-password',
  'one-time-code',
]);

function normalizeInputType(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeAutocompleteTokens(value: string | undefined): string[] {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function shouldOmitAutocomplete(autocomplete: string | undefined): boolean {
  const tokens = normalizeAutocompleteTokens(autocomplete);
  return tokens.some((token) => OMITTED_AUTOCOMPLETE_TOKENS.has(token) || token.startsWith('cc-'));
}

export function resolveWorkflowValueCapture(
  rawValue: WorkflowRawValueInput,
  options: StepBuilderOptions = {},
): WorkflowDemonstrationValue {
  const inputType = normalizeInputType(rawValue.inputType);

  if (inputType === 'password' || inputType === 'file') {
    return { captureMode: 'omitted' };
  }

  if (PICKER_INPUT_TYPES.has(inputType) || shouldOmitAutocomplete(rawValue.autocomplete)) {
    return { captureMode: 'omitted' };
  }

  if (options.captureTypedValues === false) {
    return { captureMode: 'redacted' };
  }

  return {
    captureMode: 'literal',
    text: rawValue.text ?? '',
  };
}