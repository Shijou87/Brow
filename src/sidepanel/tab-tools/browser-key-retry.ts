import type { BrowActionPostcondition, BrowPostconditionResult } from '../../shared/types';

export function shouldRetryBodyMediaKey(params: {
  selector?: string;
  key?: string | null;
  code?: string | null;
  text?: string | null;
  postconditions?: BrowActionPostcondition[] | null;
  postconditionResults: BrowPostconditionResult[];
  targetSelector?: string | null;
  targetTagName?: string | null;
}): boolean {
  if (params.selector) return false;
  if (params.text && !params.key) return false;

  const mediaPostconditions = (params.postconditions ?? []).filter((condition) => condition.type === 'mediaState');
  if (mediaPostconditions.length === 0) return false;
  if (params.postconditionResults.some((result) => result.condition.type === 'mediaState' && result.ok)) return false;

  const normalizedKey = (params.key ?? params.text ?? '').trim().toLowerCase();
  const normalizedCode = (params.code ?? '').trim().toLowerCase();
  const isLikelyMediaToggleKey = normalizedKey === 'k'
    || normalizedKey === 'space'
    || normalizedCode === 'keyk'
    || normalizedCode === 'space'
    || normalizedKey === 'mediaplaypause'
    || normalizedCode === 'mediaplaypause';
  if (!isLikelyMediaToggleKey) return false;

  const normalizedTargetSelector = (params.targetSelector ?? '').trim().toLowerCase();
  const normalizedTargetTagName = (params.targetTagName ?? '').trim().toLowerCase();
  if (normalizedTargetSelector === 'body' || normalizedTargetTagName === 'body') return false;

  return true;
}