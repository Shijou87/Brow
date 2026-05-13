import type {
  DomainSkillDraft,
  DomainSkillEntry,
  DomainSkillMatcher,
  InteractionSkillEntry,
  SkillMention,
  SkillMentionKind,
  SkillMentionReference,
} from '../shared/types';

export {
  DOMAIN_SKILL_REGISTRY_STORAGE_KEY,
  LEGACY_SKILL_REGISTRY_STORAGE_KEY,
} from '../shared/storage';

export type SkillRegistryEntry = DomainSkillEntry;
export type SkillDraft = DomainSkillDraft;

export interface SkillMentionPickerOption {
  kind: SkillMentionKind;
  mention: SkillMention;
  matchedContext: boolean;
  className: 'skill-picker-domain' | 'skill-picker-interaction';
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = escapeRegExp(pattern).replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
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

function normalizeMatcherArray(raw: string | string[] | undefined): string[] | undefined {
  const values = normalizeTags(raw);
  return values.length > 0 ? values : undefined;
}

export function normalizeDomainSkillMatcher(record: Record<string, unknown>): DomainSkillMatcher | undefined {
  const rawMatcher = record.matcher;
  const matcherRecord = rawMatcher && typeof rawMatcher === 'object' && !Array.isArray(rawMatcher)
    ? rawMatcher as Record<string, unknown>
    : null;

  const domain = typeof matcherRecord?.domain === 'string'
    ? matcherRecord.domain.trim().toLowerCase()
    : typeof record.domain === 'string'
      ? String(record.domain).trim().toLowerCase()
      : typeof record.matchDomain === 'string'
        ? String(record.matchDomain).trim().toLowerCase()
        : '';

  const pathPatterns = normalizeMatcherArray(
    matcherRecord?.pathPatterns as string | string[] | undefined
      ?? matcherRecord?.paths as string | string[] | undefined
      ?? record.pathPatterns as string | string[] | undefined
      ?? record.matchPaths as string | string[] | undefined,
  );
  const pagePatterns = normalizeMatcherArray(
    matcherRecord?.pagePatterns as string | string[] | undefined
      ?? matcherRecord?.pages as string | string[] | undefined
      ?? record.pagePatterns as string | string[] | undefined
      ?? record.matchPages as string | string[] | undefined,
  );

  if (!domain && !pathPatterns && !pagePatterns) return undefined;
  return {
    domain: domain || undefined,
    pathPatterns,
    pagePatterns,
  };
}

export function formatDomainSkillMatcherSummary(matcher?: DomainSkillMatcher): string {
  if (!matcher) return '';

  const parts = [
    matcher.domain ? `domain: ${matcher.domain}` : '',
    matcher.pathPatterns?.length ? `paths: ${matcher.pathPatterns.join(', ')}` : '',
    matcher.pagePatterns?.length ? `pages: ${matcher.pagePatterns.join(', ')}` : '',
  ].filter(Boolean);

  return parts.join(' | ');
}

export function matchesDomainSkillContext(
  skill: SkillRegistryEntry,
  context: { url?: string; title?: string },
): boolean {
  const matcher = skill.matcher;
  if (!matcher) return true;

  const rawUrl = context.url?.trim();
  let parsedUrl: URL | null = null;
  if (rawUrl) {
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      parsedUrl = null;
    }
  }

  if (matcher.domain) {
    const hostname = parsedUrl?.hostname?.toLowerCase() ?? '';
    const domain = matcher.domain.toLowerCase();
    if (!hostname || (hostname !== domain && !hostname.endsWith(`.${domain}`))) {
      return false;
    }
  }

  if (matcher.pathPatterns?.length) {
    const pathname = parsedUrl?.pathname ?? '';
    if (!pathname || !matcher.pathPatterns.some((pattern) => wildcardToRegExp(pattern).test(pathname))) {
      return false;
    }
  }

  if (matcher.pagePatterns?.length) {
    const haystack = `${context.title ?? ''} ${rawUrl ?? ''}`.toLowerCase();
    if (!matcher.pagePatterns.some((pattern) => haystack.includes(pattern.toLowerCase()))) {
      return false;
    }
  }

  return true;
}

function normalizeSkillMentionQuery(query: string): string {
  const trimmed = query.trim().toLowerCase();
  return trimmed.startsWith('/') ? trimmed.slice(1).trim() : trimmed;
}

function matchesSkillMentionQuery(
  mention: Pick<SkillMention, 'name' | 'slug' | 'description' | 'tags'>,
  query: string,
): boolean {
  const normalizedQuery = normalizeSkillMentionQuery(query);
  if (!normalizedQuery) return true;
  const haystack = [
    mention.name,
    mention.slug,
    mention.description,
    ...mention.tags,
  ].join(' ').toLowerCase();
  return haystack.includes(normalizedQuery);
}

export function toSkillMentionReference(mention: SkillMentionReference): SkillMentionReference {
  return {
    kind: mention.kind,
    id: mention.id,
    slug: mention.slug,
    name: mention.name,
  };
}

export function buildSkillMentionPickerOptions(params: {
  domainSkills: SkillRegistryEntry[];
  interactionSkills: InteractionSkillEntry[];
  query: string;
  context?: { url?: string; title?: string };
}): SkillMentionPickerOption[] {
  const context = params.context ?? {};
  const options: SkillMentionPickerOption[] = [];

  for (const skill of params.domainSkills) {
    if (!skill.enabled) continue;
    const mention: SkillMention = {
      kind: 'domain',
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      tags: [...skill.tags],
      content: skill.content,
    };
    if (!matchesSkillMentionQuery(mention, params.query)) continue;
    options.push({
      kind: 'domain',
      mention,
      matchedContext: matchesDomainSkillContext(skill, context),
      className: 'skill-picker-domain',
    });
  }

  for (const skill of params.interactionSkills) {
    const mention: SkillMention = {
      kind: 'interaction',
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      tags: [...skill.tags],
      content: skill.content,
    };
    if (!matchesSkillMentionQuery(mention, params.query)) continue;
    options.push({
      kind: 'interaction',
      mention,
      matchedContext: false,
      className: 'skill-picker-interaction',
    });
  }

  return options.sort((a, b) => {
    const rank = (option: SkillMentionPickerOption): number => {
      if (option.kind === 'domain' && option.matchedContext) return 0;
      if (option.kind === 'domain') return 1;
      return 2;
    };
    const rankDelta = rank(a) - rank(b);
    if (rankDelta !== 0) return rankDelta;
    return a.mention.name.localeCompare(b.mention.name);
  });
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
    matcher: normalizeDomainSkillMatcher(frontmatter as Record<string, unknown>),
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
      matcher: normalizeDomainSkillMatcher(record),
      enabled: record.enabled !== false,
      createdAt,
      updatedAt,
    });
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
