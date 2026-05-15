import type { PageSettlingProbeOptions, PageSettlingProbeResult } from './types';

export async function runPageSettlingProbe(
  options?: PageSettlingProbeOptions,
): Promise<PageSettlingProbeResult> {
  const quietMs = Math.max(50, Math.min(Math.floor(options?.quietMs ?? 180), 1000));
  const timeoutMs = Math.max(250, Math.min(Math.floor(options?.timeoutMs ?? 1600), 5000));
  const startedAt = performance.now();

  const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  let lastMutationAt = performance.now();
  let disconnected = false;
  const observer = new MutationObserver(() => {
    lastMutationAt = performance.now();
  });

  try {
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    while (performance.now() - startedAt < timeoutMs) {
      const now = performance.now();
      const readyState = document.readyState;
      const quietForMs = now - lastMutationAt;
      if (readyState === 'complete' && quietForMs >= quietMs) {
        observer.disconnect();
        disconnected = true;
        return {
          ok: true,
          readyState,
          quietMs: Math.round(quietForMs),
          durationMs: Math.round(now - startedAt),
        };
      }

      await wait(Math.min(quietMs, 120));
    }

    const finalNow = performance.now();
    const quietForMs = finalNow - lastMutationAt;
    return {
      ok: document.readyState === 'complete' && quietForMs >= quietMs,
      readyState: document.readyState,
      quietMs: Math.round(quietForMs),
      durationMs: Math.round(finalNow - startedAt),
      error: document.readyState === 'complete'
        ? `Timed out before page became quiet for ${quietMs}ms`
        : `Timed out waiting for document readiness (${document.readyState})`,
    };
  } finally {
    if (!disconnected) observer.disconnect();
  }
}
