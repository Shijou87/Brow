import { marked, Renderer, type Tokens } from 'marked';

const HTML_ESCAPE_TABLE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

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

function renderSafeAnchor(href: string, label: string, title?: string | null): string {
  const safeHref = toSafeExternalHref(href);
  const safeLabel = label || escapeHtml(href);
  if (!safeHref) return safeLabel;

  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${safeLabel}</a>`;
}

const renderer = new Renderer();

renderer.link = function ({ href, title, tokens }: Tokens.Link): string {
  const label = this.parser.parseInline(tokens);
  return renderSafeAnchor(href, label, title);
};

renderer.image = function ({ href, title, text }: Tokens.Image): string {
  const label = escapeHtml(text ?? '');
  const prefix = `![${label}](`;
  const suffix = ')';
  const safeHref = toSafeExternalHref(href);
  if (!safeHref) {
    return `${escapeHtml(prefix)}${escapeHtml(href)}${escapeHtml(suffix)}`;
  }
  return `${escapeHtml(prefix)}${renderSafeAnchor(safeHref, escapeHtml(href), title)}${escapeHtml(suffix)}`;
};

renderer.html = ({ text }: Tokens.HTML | Tokens.Tag): string => escapeHtml(text);

marked.setOptions({
  async: false,
  gfm: true,
  breaks: true,
  renderer,
});

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPE_TABLE[char] ?? char);
}

export function formatAssistantMessage(message: string): string {
  return marked.parse(message) as string;
}
