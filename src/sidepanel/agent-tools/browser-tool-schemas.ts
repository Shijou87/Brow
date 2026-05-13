import { z } from 'zod';

import {
  backendPreferenceSchema,
  nullableOptionalBoolean,
  nullableOptionalNumber,
  nullableOptionalString,
  nullableOptionalTargetEvidence,
  postconditionSchema,
} from './input-schemas';
import { nullableOptionalClickPoint, nullableOptionalPointerPath } from './input-schemas';

export const browserFillModeSchema = z.enum([
  'auto',
  'text',
  'checkbox',
  'radio',
  'select',
  'contenteditable',
]).nullable().optional().describe('Optional fill mode override');

export const browserFillFormToolSchema = z.object({
  tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
  fields: z.array(
    z.object({
      ref: z.string().describe('Field ref from browser_snapshot'),
      value: z.union([z.string(), z.number(), z.boolean()]).describe('Value to apply. Use booleans for checkboxes/radios.'),
      mode: browserFillModeSchema,
    }),
  ).describe('Fields to fill by ref'),
  submit: nullableOptionalBoolean('Submit the closest form after filling'),
  submitRef: nullableOptionalString('Optional submit button ref to click after filling'),
  snapshotId: nullableOptionalString('Snapshot id the refs came from'),
  intent: nullableOptionalString('Stable natural-language form intent for Brow Action Memory. Do not include secret field values in the intent.'),
  postconditions: postconditionSchema,
  useActionMemory: nullableOptionalBoolean('Set false to bypass cached action replay/storage for this call'),
  // OpenAI rejects this tool schema when the same complex target-evidence shape
  // appears at both field and root level, so the public tool surface keeps only
  // the top-level fallback copy.
  targetEvidence: nullableOptionalTargetEvidence('Optional Workflow Demonstration target evidence fallback for stale-ref repair.'),
  backendPreference: backendPreferenceSchema,
});

export const browserDragToolSchema = z.object({
  tabId: nullableOptionalNumber('Tab ID (default: active tab)'),
  sourceRef: nullableOptionalString('Source Element Ref from browser_snapshot. Optional when sourceTargetEvidence is provided.'),
  destinationRef: nullableOptionalString('Destination Element Ref from browser_snapshot. Optional when destinationTargetEvidence is provided.'),
  snapshotId: nullableOptionalString('Snapshot id the refs came from'),
  sourceTargetEvidence: nullableOptionalString('Optional JSON-encoded Workflow Demonstration target evidence for the drag source.'),
  destinationTargetEvidence: nullableOptionalString('Optional JSON-encoded Workflow Demonstration target evidence for the drag destination.'),
  sourceClickPoint: nullableOptionalClickPoint('Optional precise source click point from pointer evidence'),
  destinationClickPoint: nullableOptionalClickPoint('Optional precise destination drop point from pointer evidence'),
  pointerPath: nullableOptionalPointerPath('Optional viewport pointer path samples for drag replay'),
  durationMs: nullableOptionalNumber('Approximate drag duration in milliseconds'),
  intent: nullableOptionalString('Stable natural-language drag intent for Brow Action Memory'),
  postconditions: postconditionSchema,
  useActionMemory: nullableOptionalBoolean('Set false to bypass cached action replay/storage for this call'),
  backendPreference: backendPreferenceSchema,
});