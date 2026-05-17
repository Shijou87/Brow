import { CONVERSATIONS_STORAGE_KEY, getStorageValue, setStorageValues } from '../../shared/storage';
import { normalizeWorkflowDemonstration as normalizeWorkflowDemonstrationFromShared } from '../../shared/workflow-demonstration';
import type {
  BrowElementSignature,
  BrowserViewportRect,
  ConversationCompactionState,
  HtmlAppArtifact,
  HtmlAppArtifactMessageRef,
  HtmlAppArtifactRevision,
  SkillMentionReference,
  WorkflowDemonstration,
  WorkflowDemonstrationKeyboardEvidence,
  WorkflowDemonstrationPointer,
  WorkflowDemonstrationPointerSample,
  WorkflowDemonstrationReplayability,
  WorkflowDemonstrationScrollEvidence,
  WorkflowDemonstrationStep,
  WorkflowDemonstrationStepKind,
  WorkflowDemonstrationTabContext,
  WorkflowDemonstrationTarget,
  WorkflowDemonstrationTraceEvidence,
  WorkflowDemonstrationValue,
} from '../../shared/types';
import type { SavedConversation } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([, item]) => typeof item === 'string') as Array<[string, string]>;
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeViewportRect(raw: unknown): BrowserViewportRect | undefined {
  if (!isRecord(raw)) return undefined;
  const { x, y, left, top, right, bottom, width, height } = raw;
  if (
    typeof x !== 'number'
    || typeof y !== 'number'
    || typeof left !== 'number'
    || typeof top !== 'number'
    || typeof right !== 'number'
    || typeof bottom !== 'number'
    || typeof width !== 'number'
    || typeof height !== 'number'
  ) {
    return undefined;
  }
  return { x, y, left, top, right, bottom, width, height };
}

function normalizeMessageRole(value: unknown): SavedConversation['messages'][number]['role'] | undefined {
  if (value === 'user' || value === 'assistant' || value === 'system') return value;
  return undefined;
}

function normalizeSkillMentionReference(raw: unknown): SkillMentionReference | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind !== 'domain' && raw.kind !== 'interaction') return undefined;
  if (
    typeof raw.id !== 'string'
    || typeof raw.slug !== 'string'
    || typeof raw.name !== 'string'
    || !raw.id.trim()
    || !raw.slug.trim()
    || !raw.name.trim()
  ) {
    return undefined;
  }
  return {
    kind: raw.kind,
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
  };
}

function normalizeSavedConversationMessage(raw: unknown): SavedConversation['messages'][number] | undefined {
  if (!isRecord(raw)) return undefined;
  const role = normalizeMessageRole(raw.role);
  if (!role || typeof raw.content !== 'string' || typeof raw.time !== 'string') return undefined;
  const workflowDemonstrationIds = normalizeStringArray(raw.workflowDemonstrationIds);
  const htmlAppArtifactRefs = normalizeHtmlAppArtifactMessageRefs(raw.htmlAppArtifactRefs);
  const skillMention = normalizeSkillMentionReference(raw.skillMention);
  return {
    role,
    content: raw.content,
    time: raw.time,
    ...(workflowDemonstrationIds.length > 0 ? { workflowDemonstrationIds } : {}),
    ...(htmlAppArtifactRefs.length > 0 ? { htmlAppArtifactRefs } : {}),
    ...(skillMention ? { skillMention } : {}),
  };
}

function normalizeHtmlAppArtifactMessageRef(raw: unknown): HtmlAppArtifactMessageRef | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.artifactId !== 'string' || typeof raw.revisionId !== 'string') return undefined;
  if (!raw.artifactId.trim() || !raw.revisionId.trim()) return undefined;
  return {
    artifactId: raw.artifactId,
    revisionId: raw.revisionId,
  };
}

function normalizeHtmlAppArtifactMessageRefs(raw: unknown): HtmlAppArtifactMessageRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizeHtmlAppArtifactMessageRef(entry))
    .filter((entry): entry is HtmlAppArtifactMessageRef => Boolean(entry));
}

function normalizeHtmlAppArtifactRevision(raw: unknown): HtmlAppArtifactRevision | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    typeof raw.id !== 'string'
    || typeof raw.title !== 'string'
    || typeof raw.html !== 'string'
    || typeof raw.createdAt !== 'number'
  ) {
    return undefined;
  }

  const renderTargetHint =
    raw.renderTargetHint === 'inline' || raw.renderTargetHint === 'tab' || raw.renderTargetHint === 'both'
      ? raw.renderTargetHint
      : 'inline';

  return {
    id: raw.id,
    title: raw.title,
    html: raw.html,
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    renderTargetHint,
    createdAt: raw.createdAt,
  };
}

function normalizeHtmlAppArtifact(raw: unknown): HtmlAppArtifact | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    typeof raw.id !== 'string'
    || typeof raw.title !== 'string'
    || typeof raw.latestRevisionId !== 'string'
    || typeof raw.createdAt !== 'number'
    || typeof raw.updatedAt !== 'number'
    || !Array.isArray(raw.revisions)
  ) {
    return undefined;
  }

  const revisions = raw.revisions
    .map((entry) => normalizeHtmlAppArtifactRevision(entry))
    .filter((entry): entry is HtmlAppArtifactRevision => Boolean(entry));
  if (revisions.length === 0) return undefined;

  return {
    id: raw.id,
    title: raw.title,
    latestRevisionId: raw.latestRevisionId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    revisions,
  };
}

function normalizeHtmlAppArtifacts(raw: unknown): HtmlAppArtifact[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizeHtmlAppArtifact(entry))
    .filter((entry): entry is HtmlAppArtifact => Boolean(entry));
}

function normalizeConversationCompactionState(raw: unknown): ConversationCompactionState | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.summary !== 'string') return null;
  if (typeof raw.compactedTurnCount !== 'number' || !Number.isInteger(raw.compactedTurnCount) || raw.compactedTurnCount < 0) {
    return null;
  }
  return {
    summary: raw.summary,
    compactedTurnCount: raw.compactedTurnCount,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

function normalizeChatHistoryEntry(raw: unknown): SavedConversation['chatHistory'][number] | undefined {
  if (!isRecord(raw) || typeof raw.role !== 'string' || typeof raw.content !== 'string') return undefined;
  return { role: raw.role, content: raw.content };
}

function normalizeWorkflowDemonstrationTabContext(raw: unknown): WorkflowDemonstrationTabContext | undefined {
  if (!isRecord(raw) || typeof raw.url !== 'string') return undefined;
  return {
    url: raw.url,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    tabId: typeof raw.tabId === 'number' ? raw.tabId : undefined,
  };
}

function normalizeBrowElementSignature(raw: unknown): BrowElementSignature | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.role !== 'string' || typeof raw.name !== 'string' || typeof raw.tagName !== 'string') {
    return undefined;
  }
  return {
    role: raw.role,
    name: raw.name,
    text: typeof raw.text === 'string' ? raw.text : undefined,
    tagName: raw.tagName,
    type: typeof raw.type === 'string' ? raw.type : undefined,
    selector: typeof raw.selector === 'string' ? raw.selector : undefined,
    attributes: normalizeStringRecord(raw.attributes),
  };
}

function normalizeWorkflowDemonstrationTarget(raw: unknown): WorkflowDemonstrationTarget | undefined {
  if (!isRecord(raw)) return undefined;
  const signature = normalizeBrowElementSignature(raw.signature);
  if (!signature) return undefined;
  return {
    signature,
    observedRef: typeof raw.observedRef === 'string' ? raw.observedRef : undefined,
    selector: typeof raw.selector === 'string' ? raw.selector : undefined,
    snapshotId: typeof raw.snapshotId === 'string' ? raw.snapshotId : undefined,
    framePath: normalizeStringArray(raw.framePath),
    shadowPath: normalizeStringArray(raw.shadowPath),
  };
}

function normalizeWorkflowDemonstrationValue(raw: unknown): WorkflowDemonstrationValue | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.captureMode !== 'redacted' && raw.captureMode !== 'literal' && raw.captureMode !== 'omitted') {
    return undefined;
  }
  return {
    captureMode: raw.captureMode,
    text: typeof raw.text === 'string' ? raw.text : undefined,
  };
}

function normalizeWorkflowDemonstrationPointer(raw: unknown): WorkflowDemonstrationPointer | undefined {
  if (!isRecord(raw) || typeof raw.viewportX !== 'number' || typeof raw.viewportY !== 'number') return undefined;
  return {
    viewportX: raw.viewportX,
    viewportY: raw.viewportY,
    targetOffsetX: typeof raw.targetOffsetX === 'number' ? raw.targetOffsetX : undefined,
    targetOffsetY: typeof raw.targetOffsetY === 'number' ? raw.targetOffsetY : undefined,
    targetPercentX: typeof raw.targetPercentX === 'number' ? raw.targetPercentX : undefined,
    targetPercentY: typeof raw.targetPercentY === 'number' ? raw.targetPercentY : undefined,
    targetBounds: normalizeViewportRect(raw.targetBounds),
  };
}

function normalizeWorkflowDemonstrationPointerSamples(raw: unknown): WorkflowDemonstrationPointerSample[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const samples = raw
    .map((item): WorkflowDemonstrationPointerSample | undefined => {
      if (!isRecord(item) || typeof item.viewportX !== 'number' || typeof item.viewportY !== 'number') return undefined;
      return {
        viewportX: item.viewportX,
        viewportY: item.viewportY,
        elapsedMs: typeof item.elapsedMs === 'number' ? item.elapsedMs : undefined,
      };
    })
    .filter((item): item is WorkflowDemonstrationPointerSample => Boolean(item));
  return samples.length > 0 ? samples : undefined;
}

function normalizeWorkflowDemonstrationKeyboard(raw: unknown): WorkflowDemonstrationKeyboardEvidence | undefined {
  if (!isRecord(raw) || typeof raw.key !== 'string') return undefined;
  return {
    key: raw.key,
    code: typeof raw.code === 'string' ? raw.code : undefined,
    altKey: typeof raw.altKey === 'boolean' ? raw.altKey : undefined,
    ctrlKey: typeof raw.ctrlKey === 'boolean' ? raw.ctrlKey : undefined,
    metaKey: typeof raw.metaKey === 'boolean' ? raw.metaKey : undefined,
    shiftKey: typeof raw.shiftKey === 'boolean' ? raw.shiftKey : undefined,
  };
}

function normalizeWorkflowDemonstrationScroll(raw: unknown): WorkflowDemonstrationScrollEvidence | undefined {
  if (!isRecord(raw) || typeof raw.deltaX !== 'number' || typeof raw.deltaY !== 'number') return undefined;
  return {
    deltaX: raw.deltaX,
    deltaY: raw.deltaY,
    scrollXBefore: typeof raw.scrollXBefore === 'number' ? raw.scrollXBefore : 0,
    scrollYBefore: typeof raw.scrollYBefore === 'number' ? raw.scrollYBefore : 0,
    scrollXAfter: typeof raw.scrollXAfter === 'number' ? raw.scrollXAfter : undefined,
    scrollYAfter: typeof raw.scrollYAfter === 'number' ? raw.scrollYAfter : undefined,
  };
}

function normalizeWorkflowDemonstrationTrace(raw: unknown): WorkflowDemonstrationTraceEvidence | undefined {
  if (!isRecord(raw)) return undefined;
  const trace: WorkflowDemonstrationTraceEvidence = {
    urlBefore: typeof raw.urlBefore === 'string' ? raw.urlBefore : undefined,
    urlAfter: typeof raw.urlAfter === 'string' ? raw.urlAfter : undefined,
    titleBefore: typeof raw.titleBefore === 'string' ? raw.titleBefore : undefined,
    titleAfter: typeof raw.titleAfter === 'string' ? raw.titleAfter : undefined,
    pointerPath: normalizeWorkflowDemonstrationPointerSamples(raw.pointerPath),
    keyboard: normalizeWorkflowDemonstrationKeyboard(raw.keyboard),
    scroll: normalizeWorkflowDemonstrationScroll(raw.scroll),
    successSignal: typeof raw.successSignal === 'string' ? raw.successSignal : undefined,
  };
  return Object.values(trace).some((value) => value !== undefined) ? trace : undefined;
}

function normalizeWorkflowDemonstrationStepKind(raw: unknown): WorkflowDemonstrationStepKind | undefined {
  switch (raw) {
    case 'click':
    case 'type':
    case 'key':
    case 'shortcut':
    case 'fill':
    case 'toggle':
    case 'select':
    case 'submit':
    case 'scroll':
    case 'wait':
    case 'navigate':
    case 'drag':
    case 'download':
    case 'dialog':
    case 'upload':
    case 'picker':
    case 'manual':
      return raw;
    default:
      return undefined;
  }
}

function normalizeWorkflowDemonstrationReplayability(raw: unknown): WorkflowDemonstrationReplayability | undefined {
  if (raw === 'replayable' || raw === 'manual' || raw === 'unsupported') return raw;
  return undefined;
}

function normalizeWorkflowDemonstrationStep(raw: unknown): WorkflowDemonstrationStep | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = normalizeWorkflowDemonstrationStepKind(raw.kind);
  const replayability = normalizeWorkflowDemonstrationReplayability(raw.replayability);
  const tab = normalizeWorkflowDemonstrationTabContext(raw.tab);
  if (!kind || !replayability || !tab || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.startedAt !== 'number') {
    return undefined;
  }

  return {
    id: raw.id,
    kind,
    title: raw.title,
    replayability,
    tab,
    target: normalizeWorkflowDemonstrationTarget(raw.target),
    destination: normalizeWorkflowDemonstrationTarget(raw.destination),
    pointer: normalizeWorkflowDemonstrationPointer(raw.pointer),
    pointerPath: normalizeWorkflowDemonstrationPointerSamples(raw.pointerPath),
    trace: normalizeWorkflowDemonstrationTrace(raw.trace),
    value: normalizeWorkflowDemonstrationValue(raw.value),
    note: typeof raw.note === 'string' ? raw.note : undefined,
    startedAt: raw.startedAt,
    completedAt: typeof raw.completedAt === 'number' ? raw.completedAt : undefined,
  };
}

function normalizeWorkflowDemonstration(raw: unknown): WorkflowDemonstration | undefined {
  return normalizeWorkflowDemonstrationFromShared(raw);
}

function normalizeSavedConversation(raw: unknown): SavedConversation | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string' || !Array.isArray(raw.messages) || !Array.isArray(raw.chatHistory)) {
    return undefined;
  }

  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Date.now();
  const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : createdAt;
  return {
    id: raw.id,
    title: raw.title,
    favorite: raw.favorite === true,
    createdAt,
    updatedAt,
    messages: raw.messages
      .map((message) => normalizeSavedConversationMessage(message))
      .filter((message): message is SavedConversation['messages'][number] => Boolean(message)),
    chatHistory: raw.chatHistory
      .map((entry) => normalizeChatHistoryEntry(entry))
      .filter((entry): entry is SavedConversation['chatHistory'][number] => Boolean(entry)),
    workflowDemonstrations: Array.isArray(raw.workflowDemonstrations)
      ? raw.workflowDemonstrations
        .map((entry) => normalizeWorkflowDemonstration(entry))
        .filter((entry): entry is SavedConversation['workflowDemonstrations'][number] => Boolean(entry))
      : [],
    htmlAppArtifacts: normalizeHtmlAppArtifacts(raw.htmlAppArtifacts),
    stagedWorkflowDemonstrationIds: normalizeStringArray(raw.stagedWorkflowDemonstrationIds),
    compactionState: normalizeConversationCompactionState(raw.compactionState),
  };
}

function normalizeConversations(raw: unknown): SavedConversation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeSavedConversation(item))
    .filter((item): item is SavedConversation => Boolean(item));
}

export async function loadSavedConversations(): Promise<SavedConversation[]> {
  return normalizeConversations(await getStorageValue<unknown>(CONVERSATIONS_STORAGE_KEY));
}

export function sortSavedConversationsForDisplay(conversations: SavedConversation[]): SavedConversation[] {
  return [...conversations].sort((a, b) => {
    const favoriteOrder = Number(b.favorite === true) - Number(a.favorite === true);
    if (favoriteOrder !== 0) return favoriteOrder;

    const updatedAtOrder = b.updatedAt - a.updatedAt;
    if (updatedAtOrder !== 0) return updatedAtOrder;

    return b.createdAt - a.createdAt;
  });
}

export async function upsertSavedConversation(nextConversation: SavedConversation): Promise<void> {
  const conversations = await loadSavedConversations();
  const existingIndex = conversations.findIndex((conversation) => conversation.id === nextConversation.id);
  if (existingIndex >= 0) {
    nextConversation.createdAt = conversations[existingIndex].createdAt;
    conversations[existingIndex] = nextConversation;
  } else {
    conversations.push(nextConversation);
  }
  await setStorageValues({ [CONVERSATIONS_STORAGE_KEY]: conversations });
}

export async function setSavedConversationFavorite(id: string, favorite: boolean): Promise<boolean> {
  const conversations = await loadSavedConversations();
  const existingIndex = conversations.findIndex((conversation) => conversation.id === id);
  if (existingIndex < 0) return false;

  if (conversations[existingIndex].favorite === favorite) {
    return true;
  }

  conversations[existingIndex] = {
    ...conversations[existingIndex],
    favorite,
  };
  await setStorageValues({ [CONVERSATIONS_STORAGE_KEY]: conversations });
  return true;
}

export async function removeSavedConversation(id: string): Promise<void> {
  const conversations = await loadSavedConversations();
  await setStorageValues({
    [CONVERSATIONS_STORAGE_KEY]: conversations.filter((conversation) => conversation.id !== id),
  });
}
