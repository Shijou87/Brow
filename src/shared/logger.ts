// ─── Logger utility for WebMCP discovery and general extension logging ──────

const PREFIX = '[WebMCP]';

export function logDiscovery(
  tabId: number,
  url: string,
  available: boolean,
  toolCount: number,
  toolNames: string[],
  durationMs: number,
  error?: string,
): void {
  const ts = new Date().toISOString();
  if (available) {
    console.log(
      `${PREFIX}[discover] ${ts} tab=${tabId} url=${url} available=true tools=${toolCount} names=[${toolNames.join(',')}] duration=${durationMs}ms`,
    );
  } else {
    console.warn(
      `${PREFIX}[discover] ${ts} tab=${tabId} url=${url} available=false error=${error ?? 'UNKNOWN'} duration=${durationMs}ms`,
    );
  }
}

export function logInfo(tag: string, message: string, ...args: unknown[]): void {
  console.log(`${PREFIX}[${tag}]`, message, ...args);
}

export function logError(tag: string, message: string, ...args: unknown[]): void {
  console.error(`${PREFIX}[${tag}]`, message, ...args);
}
