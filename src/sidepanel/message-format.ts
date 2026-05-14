const HTML_ESCAPE_TABLE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const PLACEHOLDER_PREFIX = '__BROW_SAFE_MESSAGE_TOKEN_';

function createPlaceholderToken(index: number): string {
  return `${PLACEHOLDER_PREFIX}${index}__`;
}

function splitTrailingUrlPunctuation(url: string): { candidate: string; suffix: string } {
  const match = url.match(/[),.!?:;]+$/);
  if (!match) return { candidate: url, suffix: '' };
  return {
    candidate: url.slice(0, -match[0].length),
    suffix: match[0],
  };
}

function toSafeExternalHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function replaceWithPlaceholder(
  placeholders: string[],
  html: string,
): string {
  const token = createPlaceholderToken(placeholders.length);
  placeholders.push(html);
  return token;
}

function restorePlaceholders(text: string, placeholders: string[]): string {
  return placeholders.reduce(
    (current, html, index) => current.split(createPlaceholderToken(index)).join(html),
    text,
  );
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPE_TABLE[char] ?? char);
}

export function formatAssistantMessage(message: string): string {
  const placeholders: string[] = [];

  const tokenized = message
    .replace(/`([^`\n]+?)`/g, (_match, code: string) => replaceWithPlaceholder(
      placeholders,
      `<code>${escapeHtml(code)}</code>`,
    ))
    .replace(/\bhttps?:\/\/[^\s<]+/gi, (rawUrl: string) => {
      const { candidate, suffix } = splitTrailingUrlPunctuation(rawUrl);
      const href = toSafeExternalHref(candidate);
      if (!href) return rawUrl;

      return replaceWithPlaceholder(
        placeholders,
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(candidate)}</a>${escapeHtml(suffix)}`,
      );
    });

  const formatted = escapeHtml(tokenized)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');

  return restorePlaceholders(formatted, placeholders);
}