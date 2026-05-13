export interface RepeatedToolFailureInput {
  toolName: string;
  inputText?: string;
  errorText?: string;
  description?: string;
}

export interface RepeatedToolFailureDecision {
  count: number;
  shouldAbort: boolean;
  message?: string;
}

export interface RepeatedToolFailureTracker {
  recordFailure: (failure: RepeatedToolFailureInput) => RepeatedToolFailureDecision;
  reset: () => void;
}

export function createRepeatedToolFailureTracker(threshold = 3): RepeatedToolFailureTracker {
  let lastSignature: string | undefined;
  let count = 0;

  return {
    recordFailure(failure) {
      const signature = [
        failure.toolName,
        failure.inputText ?? '',
        failure.errorText ?? '',
      ].join('\n');

      if (signature === lastSignature) {
        count += 1;
      } else {
        lastSignature = signature;
        count = 1;
      }

      if (count >= threshold) {
        return {
          count,
          shouldAbort: true,
          message: `Stopped after ${count} identical ${failure.toolName} failures: ${failure.errorText ?? failure.description ?? 'unknown tool error'}`,
        };
      }

      return { count, shouldAbort: false };
    },

    reset() {
      lastSignature = undefined;
      count = 0;
    },
  };
}
