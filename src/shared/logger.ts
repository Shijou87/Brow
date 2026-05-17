// ─── Logger utility for WebMCP discovery and general extension logging ──────

const PREFIX = '[WebMCP]';
const DEBUG_LOGGING_STORAGE_KEY = 'agent-webmcp-settings';
const DEBUG_LOGGING_GLOBAL_KEY = '__browDebugLoggingEnabled__';
const DEBUG_LOGGING_INIT_KEY = '__browDebugLoggingHydrated__';
const DEFAULT_DEBUG_LOGGING = false;

type LoggerScope = typeof globalThis & {
  [DEBUG_LOGGING_GLOBAL_KEY]?: boolean;
  [DEBUG_LOGGING_INIT_KEY]?: boolean;
};

function getLoggerScope(): LoggerScope {
  return globalThis as LoggerScope;
}

function readStoredDebugLogging(value: unknown): boolean {
  if (!value || typeof value !== 'object') return DEFAULT_DEBUG_LOGGING;
  const record = value as { debugLogging?: unknown };
  return typeof record.debugLogging === 'boolean'
    ? record.debugLogging
    : DEFAULT_DEBUG_LOGGING;
}

export function setDebugLoggingEnabled(enabled: boolean): void {
  getLoggerScope()[DEBUG_LOGGING_GLOBAL_KEY] = enabled;
}

export function isDebugLoggingEnabled(): boolean {
  const enabled = getLoggerScope()[DEBUG_LOGGING_GLOBAL_KEY];
  return typeof enabled === 'boolean' ? enabled : DEFAULT_DEBUG_LOGGING;
}

function hydrateDebugLoggingFromStorage(): void {
  const scope = getLoggerScope();
  if (scope[DEBUG_LOGGING_INIT_KEY]) return;
  scope[DEBUG_LOGGING_INIT_KEY] = true;

  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }

  chrome.storage.local.get(DEBUG_LOGGING_STORAGE_KEY, (result) => {
    if (chrome.runtime?.lastError) return;
    setDebugLoggingEnabled(readStoredDebugLogging(result?.[DEBUG_LOGGING_STORAGE_KEY]));
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const nextSettings = changes[DEBUG_LOGGING_STORAGE_KEY]?.newValue;
    if (nextSettings === undefined) return;
    setDebugLoggingEnabled(readStoredDebugLogging(nextSettings));
  });
}

hydrateDebugLoggingFromStorage();

export function logDiscovery(
  tabId: number,
  url: string,
  available: boolean,
  toolCount: number,
  toolNames: string[],
  durationMs: number,
  error?: string,
): void {
  if (!isDebugLoggingEnabled()) return;

  const ts = new Date().toISOString();
  if (available) {
    console.log(
      `${PREFIX}[discover] ${ts} tab=${tabId} url=${url} available=true tools=${toolCount} names=[${toolNames.join(',')}] duration=${durationMs}ms`,
    );
  } else {
    console.log(
      `${PREFIX}[discover] ${ts} tab=${tabId} url=${url} available=false error=${error ?? 'UNKNOWN'} duration=${durationMs}ms`,
    );
  }
}

export function logInfo(tag: string, message: string, ...args: unknown[]): void {
  if (!isDebugLoggingEnabled()) return;
  console.log(`${PREFIX}[${tag}]`, message, ...args);
}

export function logError(tag: string, message: string, ...args: unknown[]): void {
  console.error(`${PREFIX}[${tag}]`, message, ...args);
}
