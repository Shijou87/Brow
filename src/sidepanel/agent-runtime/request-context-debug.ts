export interface RequestContextDebugMessage {
  role: string;
  content: string;
}

export interface RequestContextDebugEntry {
  label: string;
  content: string;
}

export interface RequestContextDebugSnapshot {
  query: string;
  estimatedTokens: number;
  contextWindow: number;
  rawHistory: RequestContextDebugMessage[];
  exactPromptMessages: RequestContextDebugMessage[];
  requestShape?: RequestContextDebugShape;
  timings?: RequestContextDebugTimings;
  liveUpdates?: RequestContextDebugEntry[];
}

export interface RequestContextDebugShape {
  rawHistoryMessageCount: number;
  rawHistoryChars: number;
  exactPromptMessageCount: number;
  exactPromptChars: number;
  systemPromptChars: number;
  browserContextChars: number;
  browserContextFrameChars: number;
  browserContextOpenTabsChars: number;
  browserContextActiveTabChars: number;
  browserContextAttachedSnapshotsChars: number;
  workflowDemonstrationChars: number;
  matchedDomainSkillsChars: number;
  matchedDomainMemoryChars: number;
  selectedSkillMentionChars: number;
  carriedForwardToolSummaryChars: number;
  selectedContextTabCount: number;
  attachedContextTabCount: number;
  attachedSnapshotCount: number;
}

export interface RequestContextDebugTimings {
  compactionMs?: number;
  requestAssemblyMs?: number;
  firstAgentUpdateMs?: number;
  firstToolCallMs?: number;
  firstAssistantTextMs?: number;
  agentStreamMs?: number;
  toolCount?: number;
  totalToolDurationMs?: number;
  toolWallTimeMs?: number;
  postToolFollowUpMs?: number;
  turnTotalMs?: number;
}

function formatMessageEntries(messages: RequestContextDebugMessage[], startIndex: number): string {
  if (messages.length === 0) return '(empty)';
  return messages.map((message, index) => [
    `[${startIndex + index}] ${message.role.toUpperCase()}`,
    message.content,
  ].join('\n')).join('\n\n');
}

function formatLabeledEntries(entries: RequestContextDebugEntry[]): string {
  if (entries.length === 0) return '(none yet)';
  return entries.map((entry) => [entry.label, entry.content].join('\n')).join('\n\n');
}

function formatNumber(value: number | undefined): string {
  return typeof value === 'number' ? value.toLocaleString() : 'n/a';
}

function formatDuration(value: number | undefined): string {
  return typeof value === 'number' ? `${value.toLocaleString()} ms` : 'n/a';
}

function formatSectionChars(value: number, total: number): string {
  if (total <= 0) return `${value.toLocaleString()} (0%)`;
  return `${value.toLocaleString()} (${Math.round((value / total) * 100)}%)`;
}

function hasTimingData(timings: RequestContextDebugTimings | undefined): boolean {
  if (!timings) return false;
  return Object.values(timings).some((value) => typeof value === 'number');
}

function formatRequestShape(shape: RequestContextDebugShape): string {
  return [
    `Raw history messages: ${shape.rawHistoryMessageCount.toLocaleString()}`,
    `Raw history chars: ${shape.rawHistoryChars.toLocaleString()}`,
    `Exact prompt messages: ${shape.exactPromptMessageCount.toLocaleString()}`,
    `Exact prompt chars: ${shape.exactPromptChars.toLocaleString()}`,
    `System prompt chars: ${shape.systemPromptChars.toLocaleString()}`,
    `Browser context chars: ${shape.browserContextChars.toLocaleString()}`,
    `Browser context frame chars: ${formatSectionChars(shape.browserContextFrameChars, shape.browserContextChars)}`,
    `Open tabs section chars: ${formatSectionChars(shape.browserContextOpenTabsChars, shape.browserContextChars)}`,
    `Active tab section chars: ${formatSectionChars(shape.browserContextActiveTabChars, shape.browserContextChars)}`,
    `Attached snapshot section chars: ${formatSectionChars(shape.browserContextAttachedSnapshotsChars, shape.browserContextChars)}`,
    `Workflow demonstration chars: ${shape.workflowDemonstrationChars.toLocaleString()}`,
    `Matched Domain Skill chars: ${shape.matchedDomainSkillsChars.toLocaleString()}`,
    `Matched Domain Memory chars: ${shape.matchedDomainMemoryChars.toLocaleString()}`,
    `Selected Skill Mention chars: ${shape.selectedSkillMentionChars.toLocaleString()}`,
    `Carried-forward tool summary chars: ${shape.carriedForwardToolSummaryChars.toLocaleString()}`,
    `Selected context tabs: ${shape.selectedContextTabCount.toLocaleString()}`,
    `Attached context tabs: ${shape.attachedContextTabCount.toLocaleString()}`,
    `Attached snapshots: ${shape.attachedSnapshotCount.toLocaleString()}`,
  ].join('\n');
}

function formatTimings(timings: RequestContextDebugTimings): string {
  return [
    `Conversation compaction: ${formatDuration(timings.compactionMs)}`,
    `Request assembly: ${formatDuration(timings.requestAssemblyMs)}`,
    `First agent update: ${formatDuration(timings.firstAgentUpdateMs)}`,
    `First tool call: ${formatDuration(timings.firstToolCallMs)}`,
    `First assistant text: ${formatDuration(timings.firstAssistantTextMs)}`,
    `Agent stream duration: ${formatDuration(timings.agentStreamMs)}`,
    `Tool count: ${formatNumber(timings.toolCount)}`,
    `Total tool duration: ${formatDuration(timings.totalToolDurationMs)}`,
    `Tool wall time: ${formatDuration(timings.toolWallTimeMs)}`,
    `Post-tool follow-up: ${formatDuration(timings.postToolFollowUpMs)}`,
    `Turn total: ${formatDuration(timings.turnTotalMs)}`,
  ].join('\n');
}

export function formatRequestContextDebugText(snapshot: RequestContextDebugSnapshot): string {
  const usagePercent = Math.round((snapshot.estimatedTokens / snapshot.contextWindow) * 100);
  const sections = [
    'Query passed to agent:',
    snapshot.query,
    '',
    `Estimated tokens: ${snapshot.estimatedTokens} / ${snapshot.contextWindow} (${usagePercent}%)`,
    `Messages: ${snapshot.exactPromptMessages.length}`,
    '',
    'Raw carried history:',
    formatMessageEntries(snapshot.rawHistory, 1),
    '',
    'Exact prompt surface passed to the agent:',
    formatMessageEntries(snapshot.exactPromptMessages, 0),
  ];

  if (snapshot.requestShape) {
    sections.push(
      '',
      'Request shape:',
      formatRequestShape(snapshot.requestShape),
    );
  }

  if (hasTimingData(snapshot.timings)) {
    sections.push(
      '',
      'Timing breakdown:',
      formatTimings(snapshot.timings ?? {}),
    );
  }

  if ((snapshot.liveUpdates?.length ?? 0) > 0) {
    sections.push(
      '',
      'Live turn updates captured so far:',
      formatLabeledEntries(snapshot.liveUpdates ?? []),
    );
  }

  return sections.join('\n\n');
}
