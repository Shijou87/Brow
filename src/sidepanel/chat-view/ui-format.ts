import { escapeHtml } from '../message-format';

export function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatSchemaType(schema?: Record<string, unknown>): string {
  if (!schema) return 'value';
  const rawType = schema.type;
  const type = Array.isArray(rawType)
    ? rawType.filter((value): value is string => typeof value === 'string').join(' | ')
    : typeof rawType === 'string' ? rawType : 'value';
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.slice(0, 4).map((value) => truncateText(String(value), 24)).join(' | ')
    : '';
  const enumSuffix = Array.isArray(schema.enum) && schema.enum.length > 4 ? ' | ...' : '';
  return enumValues ? `${type}: ${enumValues}${enumSuffix}` : type;
}

export function renderToolInputParameters(inputSchema?: Record<string, unknown>): string {
  const properties = asRecord(inputSchema?.properties);
  if (!properties || Object.keys(properties).length === 0) {
    return '<div class="tool-card-empty-detail">No arguments.</div>';
  }

  const required = new Set(
    Array.isArray(inputSchema?.required)
      ? inputSchema.required.filter((name): name is string => typeof name === 'string')
      : [],
  );

  return `
    <div class="tool-param-list">
      ${Object.entries(properties).map(([name, schema]) => {
        const prop = asRecord(schema);
        const label = prop?.title && typeof prop.title === 'string' ? prop.title : name;
        const description = prop?.description && typeof prop.description === 'string' ? prop.description : '';
        return `
          <div class="tool-param">
            <div class="tool-param-heading">
              <span class="tool-param-name">${escapeHtml(label)}</span>
              <span class="tool-param-type">${escapeHtml(formatSchemaType(prop))}</span>
              <span class="tool-param-required ${required.has(name) ? 'required' : ''}">${required.has(name) ? 'Required' : 'Optional'}</span>
            </div>
            ${label !== name ? `<div class="tool-param-key">${escapeHtml(name)}</div>` : ''}
            ${description ? `<div class="tool-param-description">${escapeHtml(description)}</div>` : ''}
          </div>`;
      }).join('')}
    </div>`;
}
