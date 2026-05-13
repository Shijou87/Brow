import type { ConversationCompactionState, SkillMentionReference, WorkflowDemonstration } from '../../shared/types';

export interface SavedConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  time: string;
  workflowDemonstrationIds?: string[];
  skillMention?: SkillMentionReference;
}

export interface SavedConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: SavedConversationMessage[];
  chatHistory: Array<{ role: string; content: string }>;
  workflowDemonstrations: WorkflowDemonstration[];
  stagedWorkflowDemonstrationIds: string[];
  compactionState: ConversationCompactionState | null;
}

export interface ContextTabOption {
  tabId: number;
  title: string;
  url: string;
  active?: boolean;
}
