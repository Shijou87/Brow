const HTTP_FETCH_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
type HttpFetchMethod = typeof HTTP_FETCH_METHODS[number];

function isTextLikeContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  if (!normalized) return true;
  return normalized.startsWith('text/')
    || normalized.includes('application/json')
    || normalized.includes('application/xml')
    || normalized.includes('application/xhtml+xml')
    || normalized.includes('application/javascript')
    || normalized.includes('application/x-www-form-urlencoded')
    || normalized.includes('image/svg+xml')
    || normalized.includes('+json')
    || normalized.includes('+xml');
}

async function readLimitedResponseText(
  response: Response,
  maxChars: number,
): Promise<{ body: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    const truncated = text.length > maxChars;
    return {
      body: truncated
        ? `${text.slice(0, maxChars)}\n\n[...truncated at ${maxChars} chars]`
        : text,
      truncated,
    };
  }

  const decoder = new TextDecoder();
  let body = '';
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      body += decoder.decode(value, { stream: true });
      if (body.length > maxChars) {
        body = `${body.slice(0, maxChars)}\n\n[...truncated at ${maxChars} chars]`;
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    body += decoder.decode();
  }

  return { body, truncated };
}

function normalizeHttpFetchHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {};

  return Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [key.trim(), String(value).trim()] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0),
  );
}

export async function httpFetch(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    maxChars?: number;
  } = {},
): Promise<{
  ok: boolean;
  message: string;
  request?: {
    url: string;
    method: HttpFetchMethod;
    headers: Record<string, string>;
    bodyLength: number;
    timeoutMs: number;
    maxChars: number;
  };
  response?: {
    url: string;
    status: number;
    statusText: string;
    ok: boolean;
    redirected: boolean;
    contentType: string;
    headers: Record<string, string>;
    body?: string;
    truncated?: boolean;
    binary?: boolean;
    bodyLength?: number;
  };
  error?: string;
}> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      ok: false,
      message: 'HTTP fetch failed',
      error: 'Invalid URL',
    };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return {
      ok: false,
      message: 'HTTP fetch failed',
      error: 'Only http:// and https:// URLs are supported',
    };
  }

  const requestedMethod = String(options.method ?? 'GET').toUpperCase();
  if (!HTTP_FETCH_METHODS.includes(requestedMethod as HttpFetchMethod)) {
    return {
      ok: false,
      message: 'HTTP fetch failed',
      error: `Unsupported method "${requestedMethod}"`,
    };
  }

  const method = requestedMethod as HttpFetchMethod;
  const headers = normalizeHttpFetchHeaders(options.headers);
  const timeoutMs = Math.max(500, Math.min(60_000, Math.floor(options.timeoutMs ?? 15_000)));
  const maxChars = Math.max(200, Math.min(50_000, Math.floor(options.maxChars ?? 20_000)));
  const canSendBody = !['GET', 'HEAD'].includes(method);
  const body = canSendBody ? (options.body ?? '') : '';

  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(parsedUrl.toString(), {
      method,
      headers,
      body: canSendBody && body ? body : undefined,
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
    });

    const responseHeaders = Object.fromEntries(response.headers.entries());
    const contentType = response.headers.get('content-type') ?? '';
    const baseResponse = {
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      redirected: response.redirected,
      contentType,
      headers: responseHeaders,
    };

    const request = {
      url: parsedUrl.toString(),
      method,
      headers,
      bodyLength: body.length,
      timeoutMs,
      maxChars,
    };

    if (method === 'HEAD' || [204, 205, 304].includes(response.status)) {
      return {
        ok: response.ok,
        message: `Fetched ${response.status} ${response.statusText} from ${response.url}`,
        request,
        response: baseResponse,
      };
    }

    if (!isTextLikeContentType(contentType)) {
      return {
        ok: response.ok,
        message: `Fetched ${response.status} ${response.statusText} from ${response.url}`,
        request,
        response: {
          ...baseResponse,
          binary: true,
          bodyLength: Number(response.headers.get('content-length') ?? 0) || undefined,
        },
      };
    }

    const { body: responseBody, truncated } = await readLimitedResponseText(response, maxChars);
    return {
      ok: response.ok,
      message: `Fetched ${response.status} ${response.statusText} from ${response.url}`,
      request,
      response: {
        ...baseResponse,
        body: responseBody,
        truncated,
        bodyLength: responseBody.length,
      },
    };
  } catch (err: any) {
    const errorMessage = err?.name === 'AbortError'
      ? `Request timed out after ${timeoutMs}ms`
      : err?.message ?? 'HTTP fetch failed';
    return {
      ok: false,
      message: 'HTTP fetch failed',
      error: errorMessage,
    };
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

