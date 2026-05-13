import type { BrowserComboboxControlledPopup, BrowserComboboxOption, BrowserComboboxState } from './types';

export interface ComboboxStateInput {
  role?: string | null;
  accessibleName?: string | null;
  currentValue?: string | null;
  placeholder?: string | null;
  ariaExpanded?: string | boolean | null;
  ariaControls?: string | null;
  ariaOwns?: string | null;
  ariaAutocomplete?: string | null;
  ariaActiveDescendant?: string | null;
  hasListAttribute?: boolean;
  controlledPopup?: {
    ref?: string | null;
    role?: string | null;
    visible?: boolean;
    options?: Array<{
      ref?: string | null;
      role?: string | null;
      text?: string | null;
      selected?: boolean;
      disabled?: boolean;
      actionable?: boolean;
    }>;
  } | null;
}

function normalizeText(value: string | null | undefined, max: number): string | undefined {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function normalizeBoolean(value: string | boolean | null | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeText(value, 16)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function normalizePopupOptions(options: NonNullable<ComboboxStateInput['controlledPopup']>['options']): BrowserComboboxOption[] {
  const seen = new Set<string>();
  const normalized: BrowserComboboxOption[] = [];

  for (const option of options ?? []) {
    const text = normalizeText(option?.text ?? null, 160);
    if (!text) continue;
    const ref = normalizeText(option?.ref ?? null, 120);
    const role = normalizeText(option?.role ?? null, 40)?.toLowerCase() ?? 'option';
    const key = `${ref ?? ''}|${role}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      ref,
      role,
      text,
      selected: option?.selected || undefined,
      disabled: option?.disabled || undefined,
      actionable: option?.actionable || undefined,
    });
    if (normalized.length >= 8) break;
  }

  return normalized;
}

export function isComboboxLikeControl(input: ComboboxStateInput): boolean {
  const role = normalizeText(input.role, 40)?.toLowerCase();
  const ariaAutocomplete = normalizeText(input.ariaAutocomplete, 40)?.toLowerCase();
  return role === 'combobox'
    || ariaAutocomplete === 'list'
    || ariaAutocomplete === 'both'
    || Boolean(normalizeText(input.ariaControls, 120))
    || Boolean(normalizeText(input.ariaOwns, 120))
    || Boolean(input.hasListAttribute)
    || Boolean(normalizeText(input.controlledPopup?.role ?? null, 40))
    || (input.controlledPopup?.options?.length ?? 0) > 0;
}

export function buildComboboxState(input: ComboboxStateInput): BrowserComboboxState | undefined {
  if (!isComboboxLikeControl(input)) return undefined;

  const accessibleName = normalizeText(input.accessibleName, 120);
  const currentValue = normalizeText(input.currentValue, 160);
  const placeholder = normalizeText(input.placeholder, 120);
  const ariaExpanded = normalizeBoolean(input.ariaExpanded);
  const ariaControls = normalizeText(input.ariaControls, 120);
  const ariaOwns = normalizeText(input.ariaOwns, 120);
  const ariaAutocomplete = normalizeText(input.ariaAutocomplete, 40)?.toLowerCase();
  const ariaActiveDescendant = normalizeText(input.ariaActiveDescendant, 120);
  const popupOptions = normalizePopupOptions(input.controlledPopup?.options);
  const popupRole = normalizeText(input.controlledPopup?.role ?? null, 40)?.toLowerCase()
    ?? (popupOptions.length > 0 ? 'listbox' : undefined);

  let controlledPopup: BrowserComboboxControlledPopup | undefined;
  if (popupRole || input.controlledPopup?.ref || input.controlledPopup?.visible !== undefined || popupOptions.length > 0) {
    controlledPopup = {
      ref: normalizeText(input.controlledPopup?.ref ?? null, 120),
      role: popupRole ?? 'listbox',
      visible: input.controlledPopup?.visible ?? popupOptions.length > 0,
      options: popupOptions,
    };
  }

  const requiresOptionSelection = popupOptions.length > 0
    || ariaAutocomplete === 'list'
    || ariaAutocomplete === 'both'
    || Boolean(ariaControls || ariaOwns || input.hasListAttribute || controlledPopup);

  return {
    accessibleName,
    currentValue,
    placeholder,
    ariaExpanded,
    ariaControls,
    ariaOwns,
    ariaAutocomplete,
    ariaActiveDescendant,
    requiresOptionSelection: requiresOptionSelection || undefined,
    interactionHint: requiresOptionSelection
      ? 'Typing updates the combobox query, but the task is not complete until you select a matching option from the controlled popup.'
      : undefined,
    controlledPopup,
  };
}