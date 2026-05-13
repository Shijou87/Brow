import { z } from 'zod';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullishString(value: string): boolean {
  const normalized = value.trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
  return normalized === ''
    || normalized === 'null'
    || normalized === 'undefined'
    || normalized === 'none'
    || normalized === 'nil'
    || normalized === 'n/a'
    || normalized === 'na'
    || normalized === 'not applicable';
}

function normalizeOptionalString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return isNullishString(value) ? undefined : value;
}

function normalizeOptionalNumber(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (isNullishString(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizeOptionalBoolean(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (isNullishString(value)) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
}

export function nullableOptionalString(description: string) {
  return z.preprocess(
    normalizeOptionalString,
    z.string().nullable().optional(),
  ).describe(description);
}

export function nullableOptionalNumber(description: string) {
  return z.preprocess(
    normalizeOptionalNumber,
    z.number().nullable().optional(),
  ).describe(description);
}

export function nullableOptionalBoolean(description: string) {
  return z.preprocess(
    normalizeOptionalBoolean,
    z.boolean().nullable().optional(),
  ).describe(description);
}

export function normalizeOptionalJsonString(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return typeof normalized === 'string' ? normalized : undefined;
}

function parseSerializedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeNumberValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizeClickPointOrigin(value: unknown): 'target' | 'targetFraction' | 'viewport' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();

  if (normalized === 'target' || normalized === 'targetoffset' || normalized === 'targetpixels') {
    return 'target';
  }
  if (
    normalized === 'targetfraction'
    || normalized === 'targetpercent'
    || normalized === 'targetpercentage'
  ) {
    return 'targetFraction';
  }
  if (normalized === 'viewport' || normalized === 'screen') {
    return 'viewport';
  }
  return undefined;
}

function fromCoordinatePair(origin: unknown, x: unknown, y: unknown): unknown {
  const normalizedOrigin = normalizeClickPointOrigin(origin);
  if (!normalizedOrigin) return undefined;
  if (x == null || y == null) return undefined;
  return { origin: normalizedOrigin, x, y };
}

function parseClickPointString(value: string): unknown {
  const trimmed = value.trim();
  const pairMatch = trimmed.match(
    /^(targetOffset|target|targetFraction|targetPercent|viewport)\s*[:=]\s*\(?\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)\s*\)?$/i,
  );
  if (!pairMatch) return value;

  return fromCoordinatePair(pairMatch[1], Number(pairMatch[2]), Number(pairMatch[3])) ?? value;
}

function normalizeClickPoint(value: unknown): unknown {
  const parsed = parseSerializedJson(value);
  if (typeof parsed === 'string' && isNullishString(parsed)) return undefined;
  if (typeof parsed === 'string') return parseClickPointString(parsed);
  if (!isRecord(parsed)) return parsed;

  if (isRecord(parsed.clickPoint)) return normalizeClickPoint(parsed.clickPoint);
  if (isRecord(parsed.pointer)) return normalizeClickPoint(parsed.pointer);

  const explicit = fromCoordinatePair(parsed.origin, parsed.x, parsed.y);
  if (explicit) return explicit;

  const targetFraction = fromCoordinatePair('targetFraction', parsed.targetPercentX, parsed.targetPercentY)
    ?? fromCoordinatePair('targetFraction', parsed.targetFractionX, parsed.targetFractionY);
  if (targetFraction) return targetFraction;

  const targetOffset = fromCoordinatePair('target', parsed.targetOffsetX, parsed.targetOffsetY)
    ?? fromCoordinatePair('target', parsed.offsetX, parsed.offsetY);
  if (targetOffset) return targetOffset;

  const viewport = fromCoordinatePair('viewport', parsed.viewportX, parsed.viewportY)
    ?? fromCoordinatePair('viewport', parsed.clientX, parsed.clientY);
  if (viewport) return viewport;

  return parsed;
}

const clickPointValueSchema = z.object({
  origin: z.enum(['target', 'targetFraction', 'viewport']).describe('Coordinate space: target pixels, target fraction 0..1, or viewport CSS pixels'),
  x: z.preprocess(normalizeNumberValue, z.number()).describe('X coordinate in the chosen origin'),
  y: z.preprocess(normalizeNumberValue, z.number()).describe('Y coordinate in the chosen origin'),
});

export function nullableOptionalClickPoint(description: string) {
  return z.preprocess(
    normalizeClickPoint,
    clickPointValueSchema.nullable().optional(),
  ).describe(description);
}

function normalizePostcondition(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== null && entry[1] !== undefined),
  );
}

function normalizePointerPath(value: unknown): unknown {
  const parsed = parseSerializedJson(value);
  if (typeof parsed === 'string' && isNullishString(parsed)) return undefined;
  if (Array.isArray(parsed)) {
    return parsed.map((item) => {
      const point = parseSerializedJson(item);
      if (isRecord(point)) {
        const x = typeof point.x === 'string' ? Number(point.x) : point.x;
        const y = typeof point.y === 'string' ? Number(point.y) : point.y;
        return { x, y };
      }
      return point;
    });
  }
  return parsed;
}

function normalizePostconditions(value: unknown): unknown {
  const parsed = parseSerializedJson(value);
  if (typeof parsed === 'string' && isNullishString(parsed)) return undefined;
  if (Array.isArray(parsed)) return parsed.map(normalizePostcondition);
  if (isRecord(parsed)) return [normalizePostcondition(parsed)];
  return parsed;
}

function normalizeStringArray(value: unknown): unknown {
  const parsed = parseSerializedJson(value);
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === 'string') {
    return parsed.split(/\s*>\s*|\s*,\s*/).map((item) => item.trim()).filter(Boolean);
  }
  return parsed;
}

function normalizeStringRecordEntries(value: unknown): unknown {
  const parsed = parseSerializedJson(value);
  if (typeof parsed === 'string' && isNullishString(parsed)) return undefined;

  if (Array.isArray(parsed)) {
    return parsed.map((item) => {
      const entry = parseSerializedJson(item);
      if (!isRecord(entry)) return item;

      const name = typeof entry.name === 'string'
        ? entry.name
        : typeof entry.key === 'string'
          ? entry.key
          : undefined;
      const rawValue = entry.value;
      return {
        name,
        value: typeof rawValue === 'string'
          ? rawValue
          : rawValue == null
            ? undefined
            : String(rawValue),
      };
    });
  }

  if (isRecord(parsed)) {
    return Object.entries(parsed).map(([name, rawValue]) => ({
      name,
      value: typeof rawValue === 'string'
        ? rawValue
        : rawValue == null
          ? undefined
          : String(rawValue),
    }));
  }

  return parsed;
}

function denormalizeStringRecordEntries(value: unknown): unknown {
  if (value == null) return value;
  if (!Array.isArray(value)) return undefined;

  const record: Record<string, string> = {};
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== 'string' || item.name.length === 0) continue;
    if (typeof item.value === 'string') {
      record[item.name] = item.value;
    }
  }

  return Object.keys(record).length > 0 ? record : undefined;
}

function normalizeTargetEvidence(value: unknown): unknown {
  const parsed = parseSerializedJson(value);
  if (typeof parsed === 'string' && isNullishString(parsed)) return undefined;
  if (!isRecord(parsed)) return parsed;

  const target = isRecord(parsed.target) ? parsed.target : parsed;
  const signature = isRecord(target.signature)
    ? target.signature
    : isRecord(target)
      ? {
        role: target.role,
        name: target.name,
        text: target.text,
        tagName: target.tagName ?? target.tag,
        type: target.type,
        selector: target.selector,
        attributes: target.attributes,
      }
      : undefined;

  return {
    ref: target.ref,
    observedRef: target.observedRef,
    snapshotId: target.snapshotId,
    selector: target.selector ?? (isRecord(signature) ? signature.selector : undefined),
    signature,
    framePath: target.framePath,
    shadowPath: target.shadowPath,
    bounds: target.bounds ?? target.targetBounds,
  };
}

const viewportRectSchema = z.object({
  x: z.preprocess(normalizeNumberValue, z.number().nullable().optional()),
  y: z.preprocess(normalizeNumberValue, z.number().nullable().optional()),
  left: z.preprocess(normalizeNumberValue, z.number().nullable().optional()),
  top: z.preprocess(normalizeNumberValue, z.number().nullable().optional()),
  width: z.preprocess(normalizeNumberValue, z.number()),
  height: z.preprocess(normalizeNumberValue, z.number()),
});

const stringRecordEntriesSchema = z.preprocess(
  normalizeStringRecordEntries,
  z.array(z.object({
    name: z.string(),
    value: z.string().nullable().optional(),
  })).nullable().optional(),
).transform(denormalizeStringRecordEntries);

const replayTargetEvidenceValueSchema = z.object({
  ref: z.string().nullable().optional(),
  observedRef: z.string().nullable().optional(),
  snapshotId: z.string().nullable().optional(),
  selector: z.string().nullable().optional(),
  signature: z.object({
    role: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    tagName: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    selector: z.string().nullable().optional(),
    attributes: stringRecordEntriesSchema,
  }).nullable().optional(),
  framePath: z.preprocess(normalizeStringArray, z.array(z.string()).nullable().optional()),
  shadowPath: z.preprocess(normalizeStringArray, z.array(z.string()).nullable().optional()),
  bounds: viewportRectSchema.nullable().optional(),
});

export function nullableOptionalPointerPath(description: string) {
  return z.preprocess(
    normalizePointerPath,
    z.array(z.object({ x: z.number(), y: z.number() })).nullable().optional(),
  ).describe(description);
}

export function nullableOptionalTargetEvidence(description: string) {
  return z.preprocess(
    normalizeTargetEvidence,
    replayTargetEvidenceValueSchema.nullable().optional(),
  ).describe(description);
}

export function parseOptionalTargetEvidenceJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  return normalizeTargetEvidence(value);
}

export const backendPreferenceSchema = z.preprocess(
  normalizeOptionalString,
  z.enum(['auto', 'mv3-dom', 'local-helper']).nullable().optional(),
).describe('Preferred execution backend. auto uses MV3 DOM first and reports when a local helper is required.');

export const postconditionSchema = z.preprocess(normalizePostconditions, z.array(
  z.object({
    type: z.enum([
      'urlIncludes',
      'urlMatches',
      'titleIncludes',
      'textVisible',
      'textAbsent',
      'elementVisible',
      'elementHidden',
      'valueEquals',
      'downloadAppeared',
      'dialogClosed',
      'mediaState',
    ]),
    value: z.string().nullable().optional(),
    ref: z.string().nullable().optional(),
    snapshotId: z.string().nullable().optional(),
  }),
)).nullable().optional().describe('Optional checks to verify after the action, such as textVisible, urlIncludes, elementVisible, downloadAppeared, dialogClosed, or mediaState.');
