import type {
  ConversationCompactionState,
  HtmlAppArtifact,
  HtmlAppArtifactMessageRef,
  SkillMentionReference,
  WorkflowDemonstration,
} from '../../shared/types';

export interface SavedConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  time: string;
  workflowDemonstrationIds?: string[];
  htmlAppArtifactRefs?: HtmlAppArtifactMessageRef[];
  skillMention?: SkillMentionReference;
}

export interface SavedConversation {
  id: string;
  title: string;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  messages: SavedConversationMessage[];
  chatHistory: Array<{ role: string; content: string }>;
  workflowDemonstrations: WorkflowDemonstration[];
  htmlAppArtifacts: HtmlAppArtifact[];
  stagedWorkflowDemonstrationIds: string[];
  compactionState: ConversationCompactionState | null;
}

export interface ContextTabOption {
  tabId: number;
  title: string;
  url: string;
  active?: boolean;
}
