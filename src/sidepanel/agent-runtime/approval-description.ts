function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getHostLabel(url: string | undefined): string | undefined {
  if (!url) return undefined;

  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function describeHttpFetch(input: Record<string, unknown>): string {
  const method = normalizeString(input.method)?.toUpperCase() ?? 'GET';
  const host = getHostLabel(normalizeString(input.url));

  if (host) {
    return `Awaiting approval to send an HTTP ${method} request to ${host}. This can transfer data off-device.`;
  }

  return `Awaiting approval to send an HTTP ${method} request. This can transfer data off-device.`;
}

function describeVlmTransfer(kind: 'region' | 'tab', vlmBaseUrl?: string | null): string {
  const host = getHostLabel(normalizeString(vlmBaseUrl));
  const target = kind === 'region' ? 'a region screenshot' : 'a tab screenshot';

  if (host) {
    return `Awaiting approval to send ${target} to the VLM endpoint at ${host}. This can transfer page data off-device.`;
  }

  return `Awaiting approval to send ${target} to the configured VLM endpoint. This can transfer page data off-device.`;
}

export function buildApprovalAwaitingDescription(params: {
  toolName: string;
  input: unknown;
  vlmBaseUrl?: string | null;
}): string {
  const { toolName, input, vlmBaseUrl } = params;
  const payload = parseJsonRecord(input) ?? {};

  switch (toolName) {
    case 'http_fetch':
      return describeHttpFetch(payload);
    case 'browser_visual_query':
      return describeVlmTransfer('region', vlmBaseUrl);
    case 'tab_screenshot_vlm':
      return describeVlmTransfer('tab', vlmBaseUrl);
    default:
      return 'Awaiting approval to run this action.';
  }
}