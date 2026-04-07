export interface SavedConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; time: string }>;
  chatHistory: Array<{ role: string; content: string }>;
}

export interface ContextTabOption {
  tabId: number;
  title: string;
  url: string;
  active?: boolean;
}

