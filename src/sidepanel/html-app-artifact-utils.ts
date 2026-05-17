import type {
  HtmlAppArtifact,
  HtmlAppArtifactMessageRef,
  HtmlAppArtifactRevision,
  HtmlAppRenderRequest,
} from '../shared/types';

function sanitizeSlugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function cloneHtmlAppArtifacts(artifacts: HtmlAppArtifact[]): HtmlAppArtifact[] {
  return artifacts.map((artifact) => ({
    ...artifact,
    revisions: artifact.revisions.map((revision) => ({ ...revision })),
  }));
}

export function upsertHtmlAppArtifact(
  artifacts: HtmlAppArtifact[],
  request: HtmlAppRenderRequest,
): { artifact: HtmlAppArtifact; revision: HtmlAppArtifactRevision } {
  const revision: HtmlAppArtifactRevision = {
    id: request.revisionId,
    title: request.title,
    html: request.html,
    summary: request.summary,
    renderTargetHint: request.renderTargetHint,
    createdAt: request.createdAt,
  };

  const existing = artifacts.find((artifact) => artifact.id === request.artifactId);
  if (existing) {
    const existingRevisionIndex = existing.revisions.findIndex((entry) => entry.id === request.revisionId);
    if (existingRevisionIndex >= 0) {
      existing.revisions[existingRevisionIndex] = revision;
    } else {
      existing.revisions.push(revision);
    }
    existing.title = request.title;
    existing.latestRevisionId = request.revisionId;
    existing.updatedAt = request.createdAt;
    return { artifact: existing, revision };
  }

  const artifact: HtmlAppArtifact = {
    id: request.artifactId,
    title: request.title,
    latestRevisionId: request.revisionId,
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
    revisions: [revision],
  };
  artifacts.push(artifact);
  return { artifact, revision };
}

export function resolveHtmlAppArtifactRef(
  artifacts: HtmlAppArtifact[],
  ref: HtmlAppArtifactMessageRef,
  options: { preferLatest?: boolean } = {},
): { artifact: HtmlAppArtifact; revision: HtmlAppArtifactRevision } | undefined {
  const artifact = artifacts.find((entry) => entry.id === ref.artifactId);
  if (!artifact) return undefined;

  const preferredRevisionId = options.preferLatest === false
    ? ref.revisionId
    : artifact.latestRevisionId;
  const revision = artifact.revisions.find((entry) => entry.id === preferredRevisionId)
    ?? artifact.revisions.find((entry) => entry.id === ref.revisionId)
    ?? artifact.revisions[artifact.revisions.length - 1];
  if (!revision) return undefined;

  return { artifact, revision };
}

export function buildHtmlAppDownloadFilename(title: string, fallbackId: string): string {
  const slug = sanitizeSlugPart(title);
  const fallbackSlug = sanitizeSlugPart(fallbackId) || 'html-app-artifact';
  return `${slug || fallbackSlug}.html`;
}

export async function downloadHtmlAppArtifact(
  title: string,
  html: string,
  fallbackId: string,
): Promise<number | undefined> {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    return await chrome.downloads.download({
      url,
      filename: buildHtmlAppDownloadFilename(title, fallbackId),
      saveAs: false,
    });
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
