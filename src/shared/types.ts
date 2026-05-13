// ─── Shared types for Agent WebMCP Chrome Extension ─────────────────────────

// ─── WebMCP ─────────────────────────────────────────────────────────────────

export interface WebMCPToolDescriptor {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface WebMCPDiscoveryResult {
  available: boolean;
  tools: WebMCPToolDescriptor[];
  page: { url: string; title: string };
  tabId: number;
  error?: string;
}

export interface WebMCPRegistryEntry {
  url: string;
  title: string;
  discoveredAt: number;
  available: boolean;
  tools: WebMCPToolDescriptor[];
}

// ─── Browser Snapshot Automation ───────────────────────────────────────────

export interface BrowserViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface BrowserViewportInfo {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
}

export interface BrowserComboboxOption {
  ref?: string;
  role: string;
  text: string;
  selected?: boolean;
  disabled?: boolean;
  actionable?: boolean;
}

export interface BrowserComboboxControlledPopup {
  ref?: string;
  role: string;
  visible: boolean;
  options: BrowserComboboxOption[];
}

export interface BrowserComboboxState {
  accessibleName?: string;
  currentValue?: string;
  placeholder?: string;
  ariaExpanded?: boolean;
  ariaControls?: string;
  ariaOwns?: string;
  ariaAutocomplete?: string;
  ariaActiveDescendant?: string;
  requiresOptionSelection?: boolean;
  interactionHint?: string;
  controlledPopup?: BrowserComboboxControlledPopup;
}

export interface BrowserSnapshotElement {
  ref: string;
  parentRef?: string;
  framePath?: string[];
  shadowPath?: string[];
  role: string;
  name: string;
  text?: string;
  tagName: string;
  type?: string;
  selector: string;
  actionable: boolean;
  depth: number;
  bounds: BrowserViewportRect;
  attributes?: Record<string, string>;
  combobox?: BrowserComboboxState;
}

export interface BrowserSnapshot {
  ok: boolean;
  snapshotId: string;
  tabId: number;
  url: string;
  title: string;
  generatedAt: number;
  viewport: BrowserViewportInfo;
  elements: BrowserSnapshotElement[];
  visibleElementCount: number;
  displayedElementCount: number;
  omittedElementCount: number;
  rootRef?: string;
  error?: string;
}

export interface BrowserSnapshotOptions {
  mode?: 'compact' | 'full';
  maxElements?: number;
  rootRef?: string;
  snapshotId?: string;
}

export interface BrowserFormSnapshotOptions {
  maxFields?: number;
  includeHidden?: boolean;
  formRef?: string;
  snapshotId?: string;
}

export type BrowserFormFieldPurpose =
  | 'email'
  | 'fullName'
  | 'givenName'
  | 'familyName'
  | 'company'
  | 'search'
  | 'addressLine1'
  | 'addressLine2'
  | 'city'
  | 'region'
  | 'postalCode'
  | 'country'
  | 'phone'
  | 'url'
  | 'username'
  | 'password'
  | 'oneTimeCode'
  | 'creditCardNumber'
  | 'creditCardExpiry'
  | 'creditCardCvc'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'submit'
  | 'unknown';

export interface BrowserFormSnapshotPurposeEvidence {
  source: 'autocomplete' | 'label' | 'name' | 'id' | 'placeholder' | 'aria' | 'type' | 'text' | 'tag';
  value: string;
  weight: number;
}

export interface BrowserFormSnapshotFieldPurposeInfo {
  purpose: BrowserFormFieldPurpose;
  confidence: number;
  evidence: BrowserFormSnapshotPurposeEvidence[];
}

export interface BrowserFormSnapshotFieldValue {
  captureMode: 'safe' | 'omitted';
  text?: string;
  reason?: string;
}

export interface BrowserFormSnapshotOption {
  ref?: string;
  value: string;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  source?: 'native-select' | 'controlled-popup';
}

export interface BrowserFormSnapshotValidationCue {
  required?: boolean;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
  step?: string;
  inputMode?: string;
  ariaInvalid?: string;
  describedBy?: string;
  describedByText?: string;
}

export interface BrowserFormSnapshotField {
  ref: string;
  snapshotId: string;
  selector: string;
  formRef?: string;
  role: string;
  tagName: string;
  type?: string;
  name?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  autocomplete?: string;
  required?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  hidden?: boolean;
  visible?: boolean;
  actionable?: boolean;
  fillTarget?: boolean;
  value?: BrowserFormSnapshotFieldValue;
  combobox?: BrowserComboboxState;
  purpose: BrowserFormSnapshotFieldPurposeInfo;
  validation?: BrowserFormSnapshotValidationCue;
  bounds?: BrowserViewportRect;
  options?: BrowserFormSnapshotOption[];
  attributes?: Record<string, string>;
}

export interface BrowserFormSnapshotForm {
  ref: string;
  selector: string;
  name?: string;
  id?: string;
  label?: string;
  action?: string;
  method?: string;
  fieldRefs: string[];
  submitRefs: string[];
}

export interface BrowserFormSnapshot {
  ok: boolean;
  snapshotId: string;
  tabId: number;
  url: string;
  title: string;
  generatedAt: number;
  forms: BrowserFormSnapshotForm[];
  fields: BrowserFormSnapshotField[];
  fieldCount: number;
  visibleFieldCount: number;
  fillTargetCount: number;
  omittedFieldCount: number;
  error?: string;
}

export type BrowserSnapshotOperation =
  | {
    kind: 'snapshot';
    tabId: number;
    options?: BrowserSnapshotOptions;
  }
  | {
    kind: 'formSnapshot';
    tabId: number;
    options?: BrowserFormSnapshotOptions;
  }
  | {
    kind: 'resolve';
    tabId: number;
    ref: string;
    snapshotId?: string;
    requireActionable?: boolean;
  }
  | {
    kind: 'resolveMemory';
    tabId: number;
    target: BrowActionMemoryTarget;
    requireActionable?: boolean;
  }
  | {
    kind: 'resolveTarget';
    tabId: number;
    target: BrowReplayTargetEvidence;
    requireActionable?: boolean;
  };

export interface BrowserVisualRegion {
  source: 'ref' | 'rect';
  ref?: string;
  snapshotId?: string;
  rect: BrowserViewportRect;
  viewport: BrowserViewportInfo;
}

export interface BrowserRefResolution {
  ok: boolean;
  ref?: string;
  originalRef?: string;
  snapshotId?: string;
  selector?: string;
  entry?: BrowserSnapshotElement;
  promotedFrom?: BrowserSnapshotElement;
  recovered?: boolean;
  region?: BrowserVisualRegion;
  snapshot?: BrowserSnapshot;
  matchScore?: number;
  repairCandidates?: BrowActionRepairCandidate[];
  preconditions?: Record<string, unknown>;
  backend?: BrowAutomationBackend;
  confidence?: number;
  helperRequired?: boolean;
  message?: string;
  error?: string;
}

export type BrowserSnapshotOperationResult = BrowserSnapshot | BrowserFormSnapshot | BrowserRefResolution;

export type BrowAutomationBackend =
  | 'mv3-dom'
  | 'local-helper'
  | 'webmcp';

export type BrowBackendPreference =
  | 'auto'
  | 'mv3-dom'
  | 'local-helper';

export type BrowActionKind =
  | 'click'
  | 'hover'
  | 'type'
  | 'fillForm'
  | 'drag'
  | 'scroll'
  | 'key'
  | 'wait'
  | 'upload'
  | 'downloadWait'
  | 'handleDialog';

export type BrowActionCacheStatus =
  | 'disabled'
  | 'miss'
  | 'hit'
  | 'stale'
  | 'stored'
  | 'store_skipped';

export interface BrowElementSignature {
  role: string;
  name: string;
  text?: string;
  tagName: string;
  type?: string;
  selector?: string;
  attributes?: Record<string, string>;
}

export interface BrowReplayTargetEvidence {
  ref?: string;
  observedRef?: string;
  snapshotId?: string;
  selector?: string;
  signature?: Partial<BrowElementSignature>;
  framePath?: string[];
  shadowPath?: string[];
  bounds?: BrowserViewportRect;
}

export interface BrowActionRepairCandidate {
  ref: string;
  selector?: string;
  role: string;
  name: string;
  tagName: string;
  score: number;
  bounds: BrowserViewportRect;
  attributes?: Record<string, string>;
}

export type BrowActionPostcondition =
  | { type: 'urlIncludes'; value: string }
  | { type: 'urlMatches'; value: string }
  | { type: 'titleIncludes'; value: string }
  | { type: 'textVisible'; value: string }
  | { type: 'textAbsent'; value: string }
  | { type: 'elementVisible'; ref: string; snapshotId?: string }
  | { type: 'elementHidden'; ref: string; snapshotId?: string }
  | { type: 'valueEquals'; ref: string; value: string; snapshotId?: string }
  | { type: 'downloadAppeared'; value?: string }
  | { type: 'dialogClosed'; value?: string }
  | { type: 'mediaState'; value: 'playing' | 'paused' };

export interface BrowPostconditionResult {
  ok: boolean;
  condition: BrowActionPostcondition;
  actual?: string;
  error?: string;
}

export interface BrowActionTrace {
  traceId: string;
  tabId: number;
  actionKind: BrowActionKind;
  intent?: string;
  backend?: BrowAutomationBackend;
  confidence?: number;
  cacheStatus: BrowActionCacheStatus;
  startedAt: number;
  completedAt?: number;
  cacheKey?: string;
  memoryEntryId?: string;
  resolvedRef?: string;
  originalRef?: string;
  snapshotId?: string;
  matchScore?: number;
  preconditions?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  postconditions?: BrowPostconditionResult[];
  recoveryCandidates?: BrowActionRepairCandidate[];
  recoveryDecision?: string;
}

export interface BrowActionMemoryTarget {
  signature: BrowElementSignature;
  selector?: string;
}

export interface BrowActionMemoryField {
  signature: BrowElementSignature;
  selector?: string;
  mode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable';
}

export interface BrowActionMemoryEntry {
  id: string;
  version: 1;
  origin: string;
  pathPattern: string;
  normalizedIntent: string;
  actionKind: BrowActionKind;
  target?: BrowActionMemoryTarget;
  fields?: BrowActionMemoryField[];
  submitTarget?: BrowActionMemoryTarget;
  createdAt: number;
  updatedAt: number;
  successCount: number;
}

export interface BrowActionMemoryStore {
  version: 1;
  entries: Record<string, BrowActionMemoryEntry>;
}

// ─── Brow Workflow Demonstrations ──────────────────────────────────────────

export interface WorkflowDemonstrationTabContext {
  url: string;
  title?: string;
  tabId?: number;
}

export interface WorkflowDemonstrationTarget {
  signature: BrowElementSignature;
  observedRef?: string;
  selector?: string;
  snapshotId?: string;
  framePath?: string[];
  shadowPath?: string[];
}

export interface WorkflowDemonstrationPointer {
  viewportX: number;
  viewportY: number;
  targetOffsetX?: number;
  targetOffsetY?: number;
  targetPercentX?: number;
  targetPercentY?: number;
  targetBounds?: BrowserViewportRect;
}

export interface WorkflowDemonstrationPointerSample {
  viewportX: number;
  viewportY: number;
  elapsedMs?: number;
}

export interface WorkflowDemonstrationKeyboardEvidence {
  key: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface WorkflowDemonstrationScrollEvidence {
  deltaX: number;
  deltaY: number;
  scrollXBefore: number;
  scrollYBefore: number;
  scrollXAfter?: number;
  scrollYAfter?: number;
}

export interface WorkflowDemonstrationTraceEvidence {
  urlBefore?: string;
  urlAfter?: string;
  titleBefore?: string;
  titleAfter?: string;
  pointerPath?: WorkflowDemonstrationPointerSample[];
  keyboard?: WorkflowDemonstrationKeyboardEvidence;
  scroll?: WorkflowDemonstrationScrollEvidence;
  successSignal?: string;
}

export type WorkflowDemonstrationValueCaptureMode = 'redacted' | 'literal' | 'omitted';

export interface WorkflowDemonstrationValue {
  captureMode: WorkflowDemonstrationValueCaptureMode;
  text?: string;
}

export type WorkflowDemonstrationStepKind =
  | 'click'
  | 'type'
  | 'key'
  | 'shortcut'
  | 'fill'
  | 'toggle'
  | 'select'
  | 'submit'
  | 'scroll'
  | 'wait'
  | 'navigate'
  | 'drag'
  | 'download'
  | 'dialog'
  | 'upload'
  | 'picker'
  | 'manual';

export type WorkflowDemonstrationReplayability = 'replayable' | 'manual' | 'unsupported';

export interface WorkflowDemonstrationStep {
  id: string;
  kind: WorkflowDemonstrationStepKind;
  title: string;
  replayability: WorkflowDemonstrationReplayability;
  tab: WorkflowDemonstrationTabContext;
  target?: WorkflowDemonstrationTarget;
  destination?: WorkflowDemonstrationTarget;
  pointer?: WorkflowDemonstrationPointer;
  pointerPath?: WorkflowDemonstrationPointerSample[];
  trace?: WorkflowDemonstrationTraceEvidence;
  value?: WorkflowDemonstrationValue;
  note?: string;
  startedAt: number;
  completedAt?: number;
}

export interface WorkflowDemonstration {
  id: string;
  title: string;
  note?: string;
  demonstratedTab: WorkflowDemonstrationTabContext;
  steps: WorkflowDemonstrationStep[];
  createdAt: number;
  updatedAt: number;
}

// ─── Brow Domain Skills ────────────────────────────────────────────────────

export interface DomainSkillMatcher {
  domain?: string;
  pathPatterns?: string[];
  pagePatterns?: string[];
}

export interface DomainSkillEntry {
  id: string;
  name: string;
  slug: string;
  description: string;
  tags: string[];
  content: string;
  matcher?: DomainSkillMatcher;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DomainSkillDraft {
  name: string;
  slug: string;
  description: string;
  tags: string[];
  content: string;
  matcher?: DomainSkillMatcher;
}

export interface DomainSkillProposal {
  id: string;
  domainSkillId?: string;
  name: string;
  slug: string;
  description: string;
  tags: string[];
  content: string;
  matcher?: DomainSkillMatcher;
  summary?: string;
  evidence?: string[];
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  updatedAt: number;
}

export interface DomainSkillProposalDraft {
  domainSkillId?: string;
  name: string;
  slug?: string;
  description: string;
  tags?: string[];
  content: string;
  matcher?: DomainSkillMatcher;
  summary?: string;
  evidence?: string[];
}

export interface DomainTrustSetting {
  id: string;
  domain: string;
  autoApply: boolean;
  createdAt: number;
  updatedAt: number;
}

// ─── Brow Interaction Skills ───────────────────────────────────────────────

export interface InteractionSkillEntry {
  id: string;
  name: string;
  slug: string;
  description: string;
  tags: string[];
  content: string;
  createdAt: number;
  updatedAt: number;
}

export type SkillMentionKind = 'domain' | 'interaction';

export interface SkillMentionReference {
  kind: SkillMentionKind;
  id: string;
  slug: string;
  name: string;
}

export interface SkillMention extends SkillMentionReference {
  description: string;
  tags: string[];
  content: string;
}

// ─── MCP Config ─────────────────────────────────────────────────────────────

export interface MCPConfig {
  endpoint: string;
  transport: 'http' | 'sse' | 'streamable-http';
  authToken?: string;
}

// ─── LLM Config ─────────────────────────────────────────────────────────────

export interface DirectLLMConfig {
  provider: 'direct';
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
}

export type LLMConfig = DirectLLMConfig;

// ─── VLM Config ─────────────────────────────────────────────────────────────

export interface VLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// ─── Extension settings (stored via chrome.storage) ─────────────────────────

export interface ExtensionSettings {
  llm: LLMConfig;
  vlm: VLMConfig;
  mcp: MCPConfig;
  enableWebMCP: boolean;
  enableMCPApps: boolean;
  debugLogging: boolean;
}

export interface ConversationCompactionState {
  summary: string;
  compactedTurnCount: number;
  updatedAt: number;
}

// ─── Chat ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  toolName?: string;
  toolSteps?: ToolStepInfo[];
}

export interface ToolStepInfo {
  label: string;
  description?: string;
  status: 'running' | 'awaiting_approval' | 'completed' | 'error';
  durationMs?: number;
}

// ─── Tool response types ────────────────────────────────────────────────────

export type ToolResponseType = 'text' | 'mcp_app' | 'data' | 'error';

export interface ToolResponse {
  type: ToolResponseType;
  content?: string;
  app?: Record<string, unknown>;
  json?: Record<string, unknown>;
  error?: { message: string; code?: string };
}
