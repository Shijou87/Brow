// ─── Side Panel Entry Point ─────────────────────────────────────────────────
// Bootstraps the chat UI, wires the agent, listens for registry updates.

import './style.scss';

import { ChatView } from './chat-view';
import type { ContextTabOption, SavedConversation } from './chat-view';
import {
  type AutomationApprovalDecision,
  getAgentApi,
  configureAndRebuild,
  type AgentAPI,
  type ChatTurn,
  type ToolStepEvent,
} from './agent';
import {
  SKILL_REGISTRY_STORAGE_KEY,
  normalizeSkillRegistry,
  type SkillRegistryEntry,
} from './skills-registry';
import {
  DEFAULT_AGENT_RECURSION_LIMIT,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_VLM_CONFIG,
} from '../shared/config';
import {
  loadDisabledTools,
  loadSidepanelConfig,
  saveDisabledTools,
  getStorageValue,
} from '../shared/storage';
import type { WebMCPRegistryEntry, DirectLLMConfig } from '../shared/types';
import { logInfo } from '../shared/logger';

// ─── WebMCP registry (mirror of background SW registry) ────────────────────

const registry = new Map<number, WebMCPRegistryEntry>();
let activeTabId: number | undefined;

// ─── Boot ──────────────────────────────────────────────────────────────────

const app = document.getElementById('app')!;

const view = new ChatView(app, {
  onSendMessage: handleSendMessage,
  onStopGeneration: handleStopGeneration,
  onConfigApply: handleConfigApply,
  onSystemPromptApply: handleSystemPromptApply,
  onSkillRegistryApply: handleSkillRegistryApply,
  onVLMConfigApply: handleVLMConfigApply,
  onRefreshWebMCP: handleRefreshWebMCP,
  onToolToggle: handleToolToggle,
  onToolGroupToggle: handleToolGroupToggle,
  onAutomationApprovalDecision: handleAutomationApprovalDecision,
  onConversationLoad: handleConversationLoad,
  onConversationNew: handleConversationNew,
  onConversationDelete: handleConversationDelete,
  onMCPServerAdd: handleMCPServerAdd,
  onMCPServerRemove: handleMCPServerRemove,
  onMCPServerReconnect: handleMCPServerReconnect,
});

// Restore saved config on startup
void restoreSavedConfig();

// Enable input
view.enableInput();

// Wire agent callbacks
const agent = getAgentApi();
const chatHistory: ChatTurn[] = [];

restoreSavedSkills();

agent.onToolStep((steps: ToolStepEvent[]) => view.updateToolSteps(steps));

// Provide tool manifest to ChatView
view.setToolManifestProvider(() => agent.getToolManifest());

// Provide MCP server list to ChatView
view.setMCPServerProvider(() => agent.getMCPServers());

// Restore MCP servers from storage
agent.restoreMCPServers().then(() => {
  logInfo('sidepanel', 'MCP servers restored from storage');
  view.refreshMCPPanel();
}).catch(() => {});

// Restore disabled tools from storage
void loadDisabledTools().then((saved) => {
  if (saved == null) return;
  agent.setDisabledTools(saved);
  logInfo('sidepanel', `Restored ${saved.length} disabled tools from storage`);
});

agent.onStreamText((text: string) => {
  // Each stream text callback delivers the full (latest) content.
  // The ChatView already manages its own streaming — we just set it here.
});

// ─── Message handling ──────────────────────────────────────────────────────

async function handleSendMessage(message: string, contextTabIds: number[]): Promise<void> {
  if (agent.isBusy()) return;

  view.addUserMessage(message);
  chatHistory.push({ role: 'user', content: message });
  view.setAgentBusy(true);
  view.showTypingIndicator();

  try {
    const response = await agent.query(message, chatHistory, contextTabIds);
    if (response === 'Agent turn was interrupted.') {
      view.hideTypingIndicator();
      view.finalizeToolSteps();
      view.addSystemMessage('Generation stopped.');
      view.saveCurrentConversation(chatHistory);
      return;
    }

    chatHistory.push({ role: 'assistant', content: response });
    view.hideTypingIndicator();
    view.finalizeToolSteps();
    view.streamAssistantMessage(response);

    // Wait for streaming to finish then finalize and auto-save
    setTimeout(() => {
      view.finalizeStreaming();
      view.saveCurrentConversation(chatHistory);
    }, Math.min(response.length * 35, 5000) + 500);
  } catch (err: any) {
    view.hideTypingIndicator();
    view.addSystemMessage(`Error: ${err.message ?? err}`);
  } finally {
    view.setAgentBusy(false);
  }
}

function handleStopGeneration(): void {
  if (!agent.isBusy()) return;
  agent.abort();
}

function handleAutomationApprovalDecision(
  requestId: string,
  decision: AutomationApprovalDecision,
): void {
  agent.resolveAutomationApproval(requestId, decision);
}

function toContextTabOption(tab: chrome.tabs.Tab | undefined): ContextTabOption | null {
  if (tab?.id === undefined || tab.id < 0) return null;
  return {
    tabId: tab.id,
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: tab.active ?? false,
  };
}

async function refreshCurrentTabContext(tabId?: number): Promise<void> {
  try {
    const tab = tabId !== undefined
      ? await chrome.tabs.get(tabId)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const nextContext = toContextTabOption(tab);
    view.setCurrentContextTab(nextContext);
  } catch {
    view.setCurrentContextTab(null);
  }
}

// ─── Config handling ───────────────────────────────────────────────────────

function handleConfigApply(config: {
  mode: 'openai' | 'claude';
  fields: Record<string, string>;
  recursionLimit?: number;
  systemPrompt?: string;
}): void {
  const llmConfig: DirectLLMConfig = {
    provider: 'direct',
    baseUrl: config.fields.baseUrl ?? '',
    apiKey: config.fields.apiKey ?? '',
    model: config.fields.model ?? '',
  };
  configureAndRebuild(llmConfig);
  const agentApi = getAgentApi();
  agentApi.setRecursionLimit(config.recursionLimit ?? DEFAULT_AGENT_RECURSION_LIMIT);
  if (config.systemPrompt !== undefined) {
    agentApi.setSystemPrompt(config.systemPrompt || DEFAULT_SYSTEM_PROMPT);
  }
  const label = config.mode === 'openai' ? `OpenAI: ${llmConfig.model}` : `Claude: ${llmConfig.model}`;
  view.updateConnectionStatus(label);
}

function handleVLMConfigApply(config: { baseUrl: string; apiKey: string; model: string }): void {
  agent.setVLMConfig(config);
  console.log('[sidepanel] VLM config applied:', config.model, '@', config.baseUrl);
}

function handleSystemPromptApply(prompt: string): void {
  agent.setSystemPrompt(prompt || DEFAULT_SYSTEM_PROMPT);
}

function handleSkillRegistryApply(skills: SkillRegistryEntry[]): void {
  agent.setSkillRegistry(skills);
}

const DEFAULT_CONFIG = {
  mode: 'openai' as const,
  fields: {
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'not-needed',
    model: 'gpt-4o',
  },
  recursionLimit: DEFAULT_AGENT_RECURSION_LIMIT,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

async function restoreSavedConfig(): Promise<void> {
  const saved = await loadSidepanelConfig().catch(() => null);
  if (!saved) {
    handleConfigApply(DEFAULT_CONFIG);
    handleVLMConfigApply(DEFAULT_VLM_CONFIG);
    return;
  }

  const fields = saved.activeMode === 'openai' ? saved.openai : saved.claude;
  handleConfigApply({
    mode: saved.activeMode,
    fields,
    recursionLimit: saved.runtime.recursionLimit,
    systemPrompt: saved.runtime.systemPrompt,
  });
  handleVLMConfigApply(saved.vlm ?? DEFAULT_VLM_CONFIG);
}

function restoreSavedSkills(): void {
  void getStorageValue<unknown>(SKILL_REGISTRY_STORAGE_KEY).then((value) => {
    const skills = normalizeSkillRegistry(value);
    agent.setSkillRegistry(skills);
  });
}

// ─── MCP Server handling ───────────────────────────────────────────────────

async function handleMCPServerAdd(name: string, url: string, authToken?: string) {
  const entry = await agent.addMCPServer(name, url, authToken);
  if (entry.status === 'connected') {
    view.addSystemMessage(`MCP server "${name}" connected: ${entry.tools.length} tool${entry.tools.length !== 1 ? 's' : ''} available.`);
  } else {
    view.addSystemMessage(`MCP server "${name}" failed: ${entry.error ?? 'unknown error'}`);
  }
  return entry;
}

function handleMCPServerRemove(id: string) {
  agent.removeMCPServer(id);
  view.addSystemMessage('MCP server removed.');
}

async function handleMCPServerReconnect(id: string) {
  const entry = await agent.reconnectMCPServer(id);
  if (entry.status === 'connected') {
    view.addSystemMessage(`MCP server "${entry.name}" reconnected: ${entry.tools.length} tool${entry.tools.length !== 1 ? 's' : ''}.`);
  } else {
    view.addSystemMessage(`MCP server "${entry.name}" reconnection failed: ${entry.error ?? 'unknown error'}`);
  }
  return entry;
}

// ─── WebMCP refresh ────────────────────────────────────────────────────────

async function handleRefreshWebMCP(): Promise<void> {
  if (activeTabId !== undefined) {
    chrome.runtime.sendMessage(
      { type: 'FORCE_DISCOVER', payload: { tabId: activeTabId } },
      () => {},
    );
  }
}

// ─── Tool toggle handling ──────────────────────────────────────────────────

function persistDisabledTools(): void {
  const disabled = Array.from(agent.getDisabledTools());
  void saveDisabledTools(disabled);
}

function handleToolToggle(toolName: string, enabled: boolean): void {
  agent.setToolEnabled(toolName, enabled);
  persistDisabledTools();
  logInfo('sidepanel', `Tool ${toolName} ${enabled ? 'enabled' : 'disabled'}`);
}

function handleToolGroupToggle(toolNames: string[], enabled: boolean): void {
  agent.setToolsEnabled(toolNames, enabled);
  persistDisabledTools();
  logInfo('sidepanel', `${toolNames.length} tools ${enabled ? 'enabled' : 'disabled'}`);
}

// ─── Conversation handling ─────────────────────────────────────────────────

function handleConversationLoad(conversation: SavedConversation): void {
  // Clear current chat and load saved conversation
  chatHistory.length = 0;
  chatHistory.push(...conversation.chatHistory as ChatTurn[]);
  view.loadConversation(conversation);
  view.enableInput();
  logInfo('sidepanel', `Loaded conversation: ${conversation.title}`);
}

function handleConversationNew(): void {
  // Clear current chat and start fresh
  chatHistory.length = 0;
  view.clearMessages();
  view.setCurrentConversationId(null);
  view.enableInput();
  logInfo('sidepanel', 'Started new conversation');
}

function handleConversationDelete(id: string): void {
  view.deleteConversation(id);
  logInfo('sidepanel', `Deleted conversation: ${id}`);
}

// ─── WebMCP annotation helper ─────────────────────────────────────────────

function refreshWebMCPAnnotation(): void {
  let totalTools = 0;
  let tabCount = 0;
  for (const entry of registry.values()) {
    if (entry.available && entry.tools?.length > 0) {
      totalTools += entry.tools.length;
      tabCount++;
    }
  }
  view.updateWebMCPStatusAllTabs(totalTools, tabCount);
}

// ─── Listen for registry updates from background SW ────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'WEBMCP_REGISTRY_UPDATE') {
    const { tabId, entry } = message.payload;
    registry.set(tabId, entry);
    logInfo('sidepanel', `Registry update: tab=${tabId} available=${entry.available} tools=${entry.tools?.length ?? 0}`);

    // Refresh the aggregated annotation (all tabs)
    refreshWebMCPAnnotation();

    // Wire WebMCP tools for this tab into the agent (all tabs, not just active)
    if (entry.available && entry.tools?.length > 0) {
      agent.updateWebMCPTools(tabId, entry.tools, entry.url, entry.title);
      logInfo('sidepanel', `Wired ${entry.tools.length} WebMCP tools into agent for tab ${tabId}`);
    } else {
      agent.removeWebMCPToolsForTab(tabId);
    }
  }
});

// Track active tab
chrome.tabs.onActivated?.addListener(({ tabId }) => {
  activeTabId = tabId;
  void refreshCurrentTabContext(tabId);
});

chrome.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (tabId !== activeTabId) return;
  if (!changeInfo.title && !changeInfo.url && !changeInfo.status) return;
  void refreshCurrentTabContext(tab.id);
});

// When a tab is closed, remove its WebMCP tools from the agent and update annotation
chrome.tabs.onRemoved?.addListener((tabId) => {
  registry.delete(tabId);
  agent.removeWebMCPToolsForTab(tabId);
  view.removeContextTab(tabId);
  refreshWebMCPAnnotation();
  if (tabId === activeTabId) {
    activeTabId = undefined;
    void refreshCurrentTabContext();
  }
});

// Get initial active tab
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (tab?.id !== undefined) {
    activeTabId = tab.id;
    void refreshCurrentTabContext(tab.id);
    // Request full registry from background and wire ALL tabs' WebMCP tools
    chrome.runtime.sendMessage({ type: 'GET_REGISTRY' }, (reg) => {
      if (reg && Object.keys(reg).length > 0) {
        Object.entries(reg).forEach(([k, v]) => {
          const tid = Number(k);
          const ent = v as WebMCPRegistryEntry;
          registry.set(tid, ent);

          // Wire each tab's tools into the agent
          if (ent.available && ent.tools?.length > 0) {
            agent.updateWebMCPTools(tid, ent.tools, ent.url, ent.title);
          }
        });
        refreshWebMCPAnnotation();
      } else {
        // Registry empty — discover all open tabs
        logInfo('sidepanel', 'Registry empty at init, discovering all tabs');
        chrome.runtime.sendMessage({ type: 'DISCOVER_ALL' }, (res) => {
          logInfo('sidepanel', `DISCOVER_ALL complete: ${res?.discovered ?? 0} tabs`);
        });
      }
    });
  } else {
    void refreshCurrentTabContext();
  }
});
