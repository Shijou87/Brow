export interface TypeTargetSelectionOptions<T> {
  directTarget?: T | null;
  descendantTarget?: T | null;
  ancestorTarget?: T | null;
  activeTarget?: T | null;
  activeRelatedToMatched?: boolean;
  visibleTargets?: T[];
}

export function chooseTypeTarget<T>(options: TypeTargetSelectionOptions<T>): T | null {
  if (options.directTarget) return options.directTarget;
  if (options.descendantTarget) return options.descendantTarget;
  if (options.ancestorTarget) return options.ancestorTarget;
  if (options.activeTarget && options.activeRelatedToMatched) return options.activeTarget;

  const visibleTargets = options.visibleTargets ?? [];
  return visibleTargets.length === 1 ? visibleTargets[0] : null;
}