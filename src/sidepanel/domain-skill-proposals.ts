import {
  DOMAIN_SKILL_PROPOSALS_STORAGE_KEY,
  getStorageValue,
  setStorageValues,
} from '../shared/storage';
import type { DomainSkillProposal, DomainSkillProposalDraft } from '../shared/types';
import {
  normalizeDomainSkillMatcher,
  parseSkillTagsInput,
  slugifySkillName,
} from './skills-registry';

function generateProposalId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStringList(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const values = raw
      .map((value) => String(value).trim())
      .filter(Boolean);
    return values.length > 0 ? Array.from(new Set(values)) : undefined;
  }
  if (typeof raw === 'string') {
    const values = parseSkillTagsInput(raw);
    return values.length > 0 ? values : undefined;
  }
  return undefined;
}

function normalizeStatus(raw: unknown): DomainSkillProposal['status'] {
  return raw === 'approved' || raw === 'rejected' ? raw : 'pending';
}

function normalizeDomainSkillProposal(record: Record<string, unknown>): DomainSkillProposal | null {
  const name = String(record.name ?? '').trim();
  const description = String(record.description ?? '').trim();
  const content = String(record.content ?? '').trim();
  if (!name || !description || !content) return null;

  const createdAt = Number(record.createdAt) || Date.now();
  const updatedAt = Number(record.updatedAt) || createdAt;
  const tags = normalizeStringList(record.tags) ?? [];
  const evidence = normalizeStringList(record.evidence);
  const domainSkillId = typeof record.domainSkillId === 'string' && record.domainSkillId.trim()
    ? record.domainSkillId.trim()
    : undefined;
  const summary = typeof record.summary === 'string' && record.summary.trim()
    ? record.summary.trim()
    : undefined;

  return {
    id: typeof record.id === 'string' && record.id.trim()
      ? record.id.trim()
      : generateProposalId(createdAt),
    domainSkillId,
    name,
    slug: slugifySkillName(String(record.slug ?? name)),
    description,
    tags,
    content,
    matcher: normalizeDomainSkillMatcher(record),
    summary,
    evidence,
    status: normalizeStatus(record.status),
    createdAt,
    updatedAt,
  };
}

function sortDomainSkillProposals(proposals: DomainSkillProposal[]): DomainSkillProposal[] {
  return [...proposals].sort((left, right) => {
    const leftRank = left.status === 'pending' ? 0 : left.status === 'approved' ? 1 : 2;
    const rightRank = right.status === 'pending' ? 0 : right.status === 'approved' ? 1 : 2;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return right.updatedAt - left.updatedAt;
  });
}

export function normalizeDomainSkillProposalRegistry(raw: unknown): DomainSkillProposal[] {
  if (!Array.isArray(raw)) return [];

  const byId = new Map<string, DomainSkillProposal>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const proposal = normalizeDomainSkillProposal(item as Record<string, unknown>);
    if (!proposal) continue;
    byId.set(proposal.id, proposal);
  }

  return sortDomainSkillProposals([...byId.values()]);
}

export function upsertDomainSkillProposalEntries(
  proposals: DomainSkillProposal[],
  draft: DomainSkillProposalDraft,
  now = Date.now(),
): {
  proposal: DomainSkillProposal;
  proposals: DomainSkillProposal[];
} {
  const normalizedDraft = normalizeDomainSkillProposal({
    ...draft,
    id: undefined,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });
  if (!normalizedDraft) {
    throw new Error('Domain Skill proposals require name, description, and content.');
  }

  const existing = proposals.find((proposal) => proposal.status === 'pending' && (
    (normalizedDraft.domainSkillId && proposal.domainSkillId === normalizedDraft.domainSkillId)
    || proposal.slug === normalizedDraft.slug
  ));

  const proposal: DomainSkillProposal = existing
    ? {
      ...existing,
      ...normalizedDraft,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      status: 'pending',
    }
    : {
      ...normalizedDraft,
      id: generateProposalId(now),
      createdAt: now,
      updatedAt: now,
      status: 'pending',
    };

  return {
    proposal,
    proposals: sortDomainSkillProposals([
      proposal,
      ...proposals.filter((entry) => entry.id !== proposal.id),
    ]),
  };
}

export async function loadDomainSkillProposalEntries(): Promise<DomainSkillProposal[]> {
  const raw = await getStorageValue<unknown>(DOMAIN_SKILL_PROPOSALS_STORAGE_KEY);
  return normalizeDomainSkillProposalRegistry(raw);
}

export async function saveDomainSkillProposalEntries(
  proposals: DomainSkillProposal[],
): Promise<DomainSkillProposal[]> {
  const normalized = normalizeDomainSkillProposalRegistry(proposals);
  await setStorageValues({ [DOMAIN_SKILL_PROPOSALS_STORAGE_KEY]: normalized });
  return normalized;
}

export async function submitDomainSkillProposal(
  draft: DomainSkillProposalDraft,
): Promise<DomainSkillProposal> {
  const proposals = await loadDomainSkillProposalEntries();
  const { proposal, proposals: nextProposals } = upsertDomainSkillProposalEntries(proposals, draft);
  await saveDomainSkillProposalEntries(nextProposals);
  return proposal;
}

export async function updateDomainSkillProposalStatus(
  proposalId: string,
  status: DomainSkillProposal['status'],
): Promise<DomainSkillProposal[]> {
  const proposals = await loadDomainSkillProposalEntries();
  const now = Date.now();
  return saveDomainSkillProposalEntries(proposals.map((proposal) =>
    proposal.id === proposalId
      ? { ...proposal, status, updatedAt: now }
      : proposal,
  ));
}
