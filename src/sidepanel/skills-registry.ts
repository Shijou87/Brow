export { SKILL_REGISTRY_STORAGE_KEY } from '../shared/storage';

export interface SkillRegistryEntry {
  id: string;
  name: string;
  slug: string;
  description: string;
  tags: string[];
  content: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SkillDraft {
  name: string;
  slug: string;
  description: string;
  tags: string[];
  content: string;
}

export function slugifySkillName(value: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'skill';
}

export function parseSkillTagsInput(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

export function formatSkillTagsInput(tags: string[]): string {
  return tags.join(', ');
}

function stripYamlValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatterBlock(block: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const lines = block.split(/\r?\n/);
  let currentKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      const [, key, rawValue] = keyMatch;
      currentKey = key;
      const value = stripYamlValue(rawValue);
      if (!value) {
        result[key] = '';
      } else if (value.startsWith('[') && value.endsWith(']')) {
        result[key] = value
          .slice(1, -1)
          .split(',')
          .map((entry) => stripYamlValue(entry))
          .filter(Boolean);
      } else {
        result[key] = value;
      }
      continue;
    }

    if (!currentKey) continue;
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch) {
      const existing = result[currentKey];
      const nextItem = stripYamlValue(listMatch[1]);
      if (!nextItem) continue;
      if (Array.isArray(existing)) {
        existing.push(nextItem);
      } else if (typeof existing === 'string' && existing) {
        result[currentKey] = [existing, nextItem];
      } else {
        result[currentKey] = [nextItem];
      }
      continue;
    }

    if (typeof result[currentKey] === 'string' && line.trim()) {
      result[currentKey] = `${result[currentKey]} ${line.trim()}`.trim();
    }
  }

  return result;
}

function extractFrontmatter(markdown: string): {
  frontmatter: Record<string, string | string[]>;
  body: string;
} {
  const trimmedStart = markdown.trimStart();
  if (!trimmedStart.startsWith('---')) {
    return { frontmatter: {}, body: markdown.trim() };
  }

  const lines = trimmedStart.split(/\r?\n/);
  if (lines[0].trim() !== '---') {
    return { frontmatter: {}, body: markdown.trim() };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closingIndex === -1) {
    return { frontmatter: {}, body: markdown.trim() };
  }

  const block = lines.slice(1, closingIndex).join('\n');
  const body = lines.slice(closingIndex + 1).join('\n').trim();
  return {
    frontmatter: parseFrontmatterBlock(block),
    body,
  };
}

function inferSkillName(body: string, sourceName?: string): string {
  const headingMatch = body.match(/^#\s+(.+)$/m);
  if (headingMatch?.[1]) return headingMatch[1].trim();
  if (sourceName) {
    return sourceName
      .replace(/\.md$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return 'Imported Skill';
}

function inferSkillDescription(body: string): string {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#') && !line.startsWith('```') && !line.startsWith('>'));
  return lines[0] ?? '';
}

function normalizeTags(raw: string | string[] | undefined): string[] {
  if (Array.isArray(raw)) {
    return raw.map((tag) => tag.trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return parseSkillTagsInput(raw);
  }
  return [];
}

export function parseSkillMarkdownImport(markdown: string, sourceName?: string): SkillDraft {
  const normalizedMarkdown = markdown.replace(/\r\n/g, '\n').trim();
  const { frontmatter, body } = extractFrontmatter(normalizedMarkdown);
  const frontmatterName = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const inferredName = frontmatterName || inferSkillName(body, sourceName);
  const explicitSlug = typeof frontmatter.slug === 'string' ? frontmatter.slug.trim() : '';
  const description = typeof frontmatter.description === 'string'
    ? frontmatter.description.trim()
    : inferSkillDescription(body);
  const tags = normalizeTags(frontmatter.tags);

  return {
    name: inferredName,
    slug: slugifySkillName(explicitSlug || inferredName),
    description,
    tags,
    content: body || normalizedMarkdown,
  };
}

export function normalizeSkillRegistry(raw: unknown): SkillRegistryEntry[] {
  if (!Array.isArray(raw)) return [];

  const byId = new Map<string, SkillRegistryEntry>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = String(record.name ?? '').trim();
    const content = String(record.content ?? '').trim();
    if (!name || !content) continue;

    const id = String(record.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const slug = slugifySkillName(String(record.slug ?? name));
    const tags = Array.isArray(record.tags)
      ? record.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : [];
    const createdAt = Number(record.createdAt) || Date.now();
    const updatedAt = Number(record.updatedAt) || createdAt;

    byId.set(id, {
      id,
      name,
      slug,
      description: String(record.description ?? '').trim(),
      tags,
      content,
      enabled: record.enabled !== false,
      createdAt,
      updatedAt,
    });
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
