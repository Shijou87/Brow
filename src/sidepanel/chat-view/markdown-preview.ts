import { escapeHtml } from '../message-format';

function renderMarkdownPreviewInline(text: string): string {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s),]+)/gi, '<a href="$1" target="_blank">$1</a>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>');
}

export function renderMarkdownPreview(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      if (listType !== 'ol') {
        closeList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${renderMarkdownPreviewInline(orderedMatch[1])}</li>`);
      continue;
    }

    const unorderedMatch = trimmed.match(/^-\s+(.*)$/);
    if (unorderedMatch) {
      if (listType !== 'ul') {
        closeList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${renderMarkdownPreviewInline(unorderedMatch[1])}</li>`);
      continue;
    }

    closeList();

    if (/^[A-Z][A-Z0-9 /&-]{2,}$/.test(trimmed) && trimmed.length <= 48) {
      html.push(`<h4>${escapeHtml(trimmed)}</h4>`);
      continue;
    }

    html.push(`<p>${renderMarkdownPreviewInline(trimmed)}</p>`);
  }

  closeList();
  return html.join('');
}
