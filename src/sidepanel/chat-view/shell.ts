import bottomNavTemplate from '../templates/chat/bottom-nav.html';
import composerTemplate from '../templates/chat/composer.html';
import configPanelTemplate from '../templates/chat/config-panel.html';
import conversationsPanelTemplate from '../templates/chat/conversations-panel.html';
import headerTemplate from '../templates/chat/header.html';
import mcpPanelTemplate from '../templates/chat/mcp-panel.html';
import promptPanelTemplate from '../templates/chat/prompt-panel.html';
import toolsPanelTemplate from '../templates/chat/tools-panel.html';
import {
  cloneHtmlTemplate,
  getRequiredAction,
  getRequiredElement,
  getRequiredSlot,
} from './template-dom';

export interface ChatViewShell {
  chatHeader: HTMLElement;
  chatBody: HTMLElement;
  messagesContainer: HTMLElement;
  inputContainer: HTMLElement;
  composerMainRow: HTMLElement;
  requestBudgetIndicator: HTMLElement;
  requestBudgetRingFill: SVGCircleElement;
  requestBudgetValue: HTMLElement;
  requestBudgetCopyButton: HTMLButtonElement;
  messageInput: HTMLTextAreaElement;
  recordButton: HTMLButtonElement;
  sendButton: HTMLButtonElement;
  contextTabsContainer: HTMLElement;
  contextAddButton: HTMLButtonElement;
  contextPicker: HTMLElement;
  skillMentionComposerSlot: HTMLElement;
  workflowDemonstrationsDock: HTMLElement;
  webmcpIndicator: HTMLElement;
  newChatButton: HTMLButtonElement;
  refreshWebmcpButton: HTMLButtonElement;
  bottomNav: HTMLElement;
  configPanel: HTMLElement;
  promptPanel: HTMLElement;
  toolsPanel: HTMLElement;
  conversationsPanel: HTMLElement;
  mcpPanel: HTMLElement;
}

export function buildChatViewShell(container: HTMLElement): ChatViewShell {
  container.innerHTML = '';
  container.className = 'chat-container';

  const chatHeader = cloneHtmlTemplate<HTMLElement>(headerTemplate);
  getRequiredSlot<HTMLImageElement>(chatHeader, 'brand-icon').src = chrome.runtime.getURL('icons/extension-icon.png');
  container.appendChild(chatHeader);

  const chatBody = document.createElement('div');
  chatBody.className = 'chat-body';

  const messagesContainer = document.createElement('div');
  messagesContainer.className = 'chat-messages';

  const inputContainer = cloneHtmlTemplate<HTMLElement>(composerTemplate);
  const toolsPanel = cloneHtmlTemplate<HTMLElement>(toolsPanelTemplate);
  const mcpPanel = cloneHtmlTemplate<HTMLElement>(mcpPanelTemplate);
  const conversationsPanel = cloneHtmlTemplate<HTMLElement>(conversationsPanelTemplate);

  chatBody.appendChild(messagesContainer);
  chatBody.appendChild(toolsPanel);
  chatBody.appendChild(mcpPanel);
  chatBody.appendChild(conversationsPanel);
  chatBody.appendChild(inputContainer);
  container.appendChild(chatBody);

  const configPanel = cloneHtmlTemplate<HTMLElement>(configPanelTemplate);
  getRequiredSlot<HTMLImageElement>(configPanel, 'openai-provider-icon').src = chrome.runtime.getURL('icons/openai.png');
  getRequiredSlot<HTMLImageElement>(configPanel, 'claude-provider-icon').src = chrome.runtime.getURL('icons/claude.png');
  container.appendChild(configPanel);

  const promptPanel = cloneHtmlTemplate<HTMLElement>(promptPanelTemplate);
  container.appendChild(promptPanel);

  const bottomNav = cloneHtmlTemplate<HTMLElement>(bottomNavTemplate);
  container.appendChild(bottomNav);

  const requestBudgetIndicator = getRequiredSlot<HTMLElement>(inputContainer, 'request-budget-indicator');

  return {
    chatHeader,
    chatBody,
    messagesContainer,
    inputContainer,
    composerMainRow: getRequiredSlot<HTMLElement>(inputContainer, 'composer-main-row'),
    requestBudgetIndicator,
    requestBudgetRingFill: getRequiredSlot<SVGCircleElement>(inputContainer, 'request-budget-ring-fill'),
    requestBudgetValue: getRequiredSlot<HTMLElement>(inputContainer, 'request-budget-value'),
    requestBudgetCopyButton: getRequiredAction<HTMLButtonElement>(inputContainer, 'copy-context'),
    messageInput: getRequiredSlot<HTMLTextAreaElement>(inputContainer, 'message-input'),
    recordButton: getRequiredSlot<HTMLButtonElement>(inputContainer, 'record-button'),
    sendButton: getRequiredSlot<HTMLButtonElement>(inputContainer, 'send-button'),
    contextTabsContainer: getRequiredSlot<HTMLElement>(inputContainer, 'context-tabs'),
    contextAddButton: getRequiredSlot<HTMLButtonElement>(inputContainer, 'context-add-button'),
    contextPicker: getRequiredSlot<HTMLElement>(inputContainer, 'context-picker'),
    skillMentionComposerSlot: getRequiredSlot<HTMLElement>(inputContainer, 'skill-mention-composer-slot'),
    workflowDemonstrationsDock: getRequiredSlot<HTMLElement>(inputContainer, 'workflow-demonstrations-dock'),
    webmcpIndicator: getRequiredSlot<HTMLElement>(chatHeader, 'webmcp-indicator'),
    newChatButton: getRequiredAction<HTMLButtonElement>(chatHeader, 'new-chat'),
    refreshWebmcpButton: getRequiredAction<HTMLButtonElement>(chatHeader, 'refresh-webmcp'),
    bottomNav,
    configPanel,
    promptPanel,
    toolsPanel,
    conversationsPanel,
    mcpPanel,
  };
}
