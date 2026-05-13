export interface BrowserContextTabLike {
  tabId: number;
  title?: string;
  url?: string;
  active?: boolean;
  status?: string;
}

export interface BrowserContextAttachedSnapshotBlock {
  tabId: number;
  title?: string;
  url?: string;
  active?: boolean;
  snapshotText: string;
}

export interface BrowserContextSnapshotLayoutInput {
  totalTabCount: number;
  listedTabs: BrowserContextTabLike[];
  extraTabCount: number;
  visibleTabId?: number;
  activeTab?: BrowserContextTabLike | null;
  selectedTabCount: number;
  omittedAttachedTabCount: number;
  attachedSnapshotBlocks: BrowserContextAttachedSnapshotBlock[];
}

export interface BrowserContextSnapshotLayoutMetrics {
  frameChars: number;
  openTabsSectionChars: number;
  activeTabSectionChars: number;
  attachedSnapshotsSectionChars: number;
}

export interface BrowserContextSnapshotLayoutResult {
  text: string;
  metrics: BrowserContextSnapshotLayoutMetrics;
}

const QUERY_CONTEXT_TITLE_LIMIT = 120;
const QUERY_CONTEXT_URL_LIMIT = 160;
const ACTIONABLE_PREVIEW_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'option',
  'slider',
  'spinbutton',
]);

function normalizeInlineText(text: string | undefined | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function truncateInline(text: string | undefined | null, max: number): string {
  const normalized = normalizeInlineText(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

function summarizeTabLocation(url: string | undefined | null): string {
  const normalized = normalizeInlineText(url);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname;
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return truncateInline(`${hostname}${pathname}`, QUERY_CONTEXT_URL_LIMIT);
  } catch {
    return truncateInline(normalized.replace(/^https?:\/\//, '').replace(/[?#].*$/, ''), QUERY_CONTEXT_URL_LIMIT);
  }
}

function getSnapshotPreviewRole(line: string): string | null {
  const match = line.trimStart().match(/^[-*]\s+([a-z0-9_-]+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function compactAttachedSnapshotPreviewLine(line: string): string {
  return line
    .replace(/\s*\[ref=[^\]]+\]/g, '')
    .replace(/\s*\[bounds=[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeAttachedSnapshotText(snapshotText: string): string {
  const lines = snapshotText.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  if (lines.length <= 1) return snapshotText;

  const header = lines[0];
  const bodyLines = lines.slice(1);
  const previewLine = bodyLines.find((line) => {
    const role = getSnapshotPreviewRole(line);
    return role ? ACTIONABLE_PREVIEW_ROLES.has(role) : false;
  }) ?? bodyLines.find((line) => /^[-*]\s+/.test(line.trimStart())) ?? bodyLines[0];

  const compactLine = compactAttachedSnapshotPreviewLine(previewLine);
  return compactLine ? `${header}\n${compactLine}` : header;
}

function formatTabLine(tab: BrowserContextTabLike, index: number, visibleTabId?: number): string {
  const markers = [
    tab.tabId === visibleTabId ? 'ACTIVE' : null,
    tab.active ? 'SELECTED' : null,
  ].filter(Boolean).join(', ');
  const markerPrefix = markers ? `[${markers}] ` : '';
  const title = truncateInline(tab.title || '(untitled tab)', QUERY_CONTEXT_TITLE_LIMIT);
  const location = summarizeTabLocation(tab.url) || '(unknown location)';
  return `${index + 1}. ${markerPrefix}tabId=${tab.tabId} title="${title}" location=${location}`;
}

function formatActiveSection(activeTab?: BrowserContextTabLike | null): string {
  return activeTab
    ? [
      'Current visible/selected tab:',
      `tabId=${activeTab.tabId}`,
      `title="${truncateInline(activeTab.title || '(untitled tab)', QUERY_CONTEXT_TITLE_LIMIT)}"`,
      `url=${truncateInline(activeTab.url || '', QUERY_CONTEXT_URL_LIMIT)}`,
      `status=${activeTab.status}`,
    ].join('\n')
    : 'Current visible/selected tab: unavailable.';
}

function formatAttachedTabsSection(input: BrowserContextSnapshotLayoutInput): string {
  if (input.attachedSnapshotBlocks.length === 0) {
    return 'Attached tab ref snapshots: none selected for this message.';
  }

  const attachedSnapshotText = input.attachedSnapshotBlocks.map((block) => {
    const isPrimarySnapshot = block.tabId === input.visibleTabId || block.active;
    return isPrimarySnapshot
      ? block.snapshotText
      : summarizeAttachedSnapshotText(block.snapshotText);
  }).join('\n\n');

  return [
    `Attached tab ref snapshots (${input.selectedTabCount} selected${input.omittedAttachedTabCount > 0 ? `, showing first ${input.attachedSnapshotBlocks.length}` : ''}):`,
    attachedSnapshotText,
    input.omittedAttachedTabCount > 0 ? `...and ${input.omittedAttachedTabCount} more attached tabs not shown.` : '',
  ].filter(Boolean).join('\n');
}

export function buildBrowserContextSnapshotLayout(input: BrowserContextSnapshotLayoutInput): BrowserContextSnapshotLayoutResult {
  const header = 'Browser context snapshot:';
  const tabLines = input.listedTabs.length > 0
    ? input.listedTabs.map((tab, index) => formatTabLine(tab, index, input.visibleTabId)).join('\n')
    : 'No open tabs found.';
  const openTabsSection = [
    `Open tabs (${input.totalTabCount} total${input.extraTabCount > 0 ? `, showing first ${input.listedTabs.length}` : ''}):`,
    tabLines,
    input.extraTabCount > 0 ? `...and ${input.extraTabCount} more tabs not shown.` : '',
  ].filter(Boolean).join('\n');
  const activeTabSection = formatActiveSection(input.activeTab);
  const attachedSnapshotsSection = formatAttachedTabsSection(input);
  const text = [
    header,
    openTabsSection,
    activeTabSection,
    attachedSnapshotsSection,
  ].join('\n');

  return {
    text,
    metrics: {
      frameChars: text.length - openTabsSection.length - activeTabSection.length - attachedSnapshotsSection.length,
      openTabsSectionChars: openTabsSection.length,
      activeTabSectionChars: activeTabSection.length,
      attachedSnapshotsSectionChars: attachedSnapshotsSection.length,
    },
  };
}

export function buildBrowserContextSnapshotText(input: BrowserContextSnapshotLayoutInput): string {
  return buildBrowserContextSnapshotLayout(input).text;
}