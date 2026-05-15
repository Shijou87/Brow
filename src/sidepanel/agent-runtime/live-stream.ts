type LangGraphStreamMode = 'updates' | 'messages' | string;

export type DecodedLangGraphStreamChunk = {
  mode: LangGraphStreamMode;
  payload: unknown;
};

type MessageStreamMetadata = {
  langgraph_node?: string;
  name?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function decodeLangGraphStreamChunk(raw: unknown): DecodedLangGraphStreamChunk {
  if (Array.isArray(raw) && raw.length === 2 && typeof raw[0] === 'string') {
    return {
      mode: raw[0],
      payload: raw[1],
    };
  }

  return {
    mode: 'updates',
    payload: raw,
  };
}

export function extractLlmText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (isRecord(item) && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join('');
  }
  if (isRecord(value) && typeof value.content !== 'undefined') {
    return extractLlmText(value.content);
  }
  return '';
}

export function extractAssistantMessageStreamText(payload: unknown): string {
  if (!Array.isArray(payload) || payload.length === 0) return '';

  const [message, rawMetadata] = payload;
  const metadata: MessageStreamMetadata = isRecord(rawMetadata) ? rawMetadata : {};
  const nodeName = metadata.langgraph_node ?? metadata.name;

  if (nodeName && nodeName !== 'agent') return '';
  if (!isRecord(message)) return '';
  if (typeof message.tool_call_id === 'string' && message.tool_call_id.trim()) return '';

  return extractLlmText(message.content);
}
