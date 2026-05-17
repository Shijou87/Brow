import { loadSavedConversations } from '../sidepanel/chat-view/conversation-store';
import { downloadHtmlAppArtifact } from '../sidepanel/html-app-artifact-utils';
import { createLockedDownHtmlResource } from '../sidepanel/sandboxed-html';
import { SandboxedHtmlHost } from '../sidepanel/sandboxed-html-host';

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function generateRuntimeId(prefix: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${suffix}`;
}

async function main(): Promise<void> {
  const titleEl = requireElement<HTMLElement>('[data-role="title"]');
  const metaEl = requireElement<HTMLElement>('[data-role="meta"]');
  const errorEl = requireElement<HTMLElement>('[data-role="error"]');
  const iframe = requireElement<HTMLIFrameElement>('[data-role="iframe"]');
  const downloadButton = requireElement<HTMLButtonElement>('[data-action="download"]');

  const params = new URLSearchParams(window.location.search);
  const conversationId = params.get('conversation');
  const artifactId = params.get('artifact');
  const revisionId = params.get('revision');

  if (!conversationId || !artifactId || !revisionId) {
    throw new Error('Missing HTML App Artifact query parameters.');
  }

  const conversations = await loadSavedConversations();
  const conversation = conversations.find((entry) => entry.id === conversationId);
  if (!conversation) {
    throw new Error('The requested conversation could not be found.');
  }

  const artifact = conversation.htmlAppArtifacts.find((entry) => entry.id === artifactId);
  if (!artifact) {
    throw new Error('The requested HTML App Artifact could not be found.');
  }

  const revision = artifact.revisions.find((entry) => entry.id === revisionId)
    ?? artifact.revisions.find((entry) => entry.id === artifact.latestRevisionId)
    ?? artifact.revisions[artifact.revisions.length - 1];
  if (!revision) {
    throw new Error('The requested HTML App Artifact revision could not be found.');
  }

  titleEl.textContent = revision.title;
  metaEl.textContent = `Conversation ${conversation.title} · Revision ${revision.id}`;
  document.title = `${revision.title} · Brow HTML App`;

  downloadButton.addEventListener('click', () => {
    void downloadHtmlAppArtifact(revision.title, revision.html, revision.id);
  });

  const host = new SandboxedHtmlHost();
  const sessionId = generateRuntimeId('html-app-tab');
  await host.mount(
    sessionId,
    iframe,
    `${chrome.runtime.getURL('mcp-app-sandbox.html')}?session=${encodeURIComponent(sessionId)}`,
    createLockedDownHtmlResource(revision.html),
    {
      onError: (message) => {
        errorEl.textContent = message;
        errorEl.hidden = false;
      },
    },
  );
}

void main().catch((err: any) => {
  const errorEl = document.querySelector<HTMLElement>('[data-role="error"]');
  if (errorEl) {
    errorEl.textContent = err?.message ?? String(err);
    errorEl.hidden = false;
  }
});
