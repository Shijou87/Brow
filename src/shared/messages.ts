import type { WebMCPDiscoveryResult, WebMCPRegistryEntry } from './types';

export type RuntimeMessageType =
  | 'GET_REGISTRY'
  | 'FORCE_DISCOVER'
  | 'DISCOVER_ALL'
  | 'WEBMCP_DISCOVER'
  | 'WEBMCP_INVOKE'
  | 'WEBMCP_REGISTRY_UPDATE';

interface BaseRuntimeMessage<T extends RuntimeMessageType, P = undefined> {
  type: T;
  payload: P;
}

export type GetRegistryMessage = {
  type: 'GET_REGISTRY';
};

export type ForceDiscoverMessage = BaseRuntimeMessage<'FORCE_DISCOVER', { tabId: number }>;

export type DiscoverAllMessage = {
  type: 'DISCOVER_ALL';
};

export type WebMCPDiscoverMessage = {
  type: 'WEBMCP_DISCOVER';
};

export type WebMCPInvokeMessage = BaseRuntimeMessage<'WEBMCP_INVOKE', {
  tabId: number;
  toolName: string;
  args: Record<string, unknown>;
}>;

export type WebMCPRegistryUpdateMessage = BaseRuntimeMessage<'WEBMCP_REGISTRY_UPDATE', {
  tabId: number;
  entry: WebMCPRegistryEntry;
}>;

export interface WebMCPInvokeResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type RuntimeMessage =
  | GetRegistryMessage
  | ForceDiscoverMessage
  | DiscoverAllMessage
  | WebMCPDiscoverMessage
  | WebMCPInvokeMessage
  | WebMCPRegistryUpdateMessage;

export function isRuntimeMessageType<T extends RuntimeMessageType>(
  message: unknown,
  type: T,
): message is Extract<RuntimeMessage, { type: T }> {
  return Boolean(message) && typeof message === 'object' && (message as RuntimeMessage).type === type;
}

export function createWebMCPRegistryUpdateMessage(
  tabId: number,
  entry: WebMCPRegistryEntry,
): WebMCPRegistryUpdateMessage {
  return {
    type: 'WEBMCP_REGISTRY_UPDATE',
    payload: { tabId, entry },
  };
}

export function toWebMCPDiscoveryResult(
  entry: WebMCPRegistryEntry,
  tabId: number,
): WebMCPDiscoveryResult {
  return {
    available: entry.available,
    tools: entry.tools,
    page: { url: entry.url, title: entry.title },
    tabId,
  };
}

