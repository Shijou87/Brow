import { logError } from '../shared/logger';

let rpcCounter = 0;
const pendingRpcs = new Map<number, {
  resolve: (value: any) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.direction !== 'webmcp-from-page') return;

  const { id, result } = event.data;
  const pending = pendingRpcs.get(id);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingRpcs.delete(id);
  pending.resolve(result);
});

export function callPageBridge(
  action: 'discover' | 'invoke',
  extra: Record<string, unknown> = {},
): Promise<any> {
  return new Promise((resolve) => {
    const id = ++rpcCounter;
    const timer = setTimeout(() => {
      pendingRpcs.delete(id);
      logError('content-script', `Bridge timeout for action="${action}" id=${id}`);
      resolve(action === 'discover'
        ? { available: false, tools: [], error: 'BRIDGE_TIMEOUT' }
        : { ok: false, error: 'BRIDGE_TIMEOUT' });
    }, 5000);

    pendingRpcs.set(id, { resolve, timer });
    window.postMessage({ direction: 'webmcp-from-content', id, action, ...extra }, '*');
  });
}

