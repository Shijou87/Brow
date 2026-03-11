// ─── Tab Management Tools ───────────────────────────────────────────────────
// Extension-native tools exposed to the LangGraph agent for tab management.

export interface TabInfo {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  audible: boolean;
  status: string;
}

/** tabs.list — returns all open tabs */
export async function tabsList(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    tabId: t.id ?? -1,
    windowId: t.windowId ?? -1,
    title: t.title ?? '',
    url: t.url ?? '',
    active: t.active ?? false,
    audible: t.audible ?? false,
    status: t.status ?? 'unknown',
  }));
}

/** tabs.activate — activate (switch to) a tab */
export async function tabsActivate(tabId: number): Promise<{ ok: boolean }> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return { ok: true };
}

/** tabs.create — create a new tab */
export async function tabsCreate(
  url: string,
  active = true,
): Promise<{ tabId: number; ok: boolean }> {
  const tab = await chrome.tabs.create({ url, active });
  return { tabId: tab.id ?? -1, ok: true };
}

/** tabs.updateUrl — navigate a tab to a new URL */
export async function tabsUpdateUrl(
  tabId: number,
  url: string,
): Promise<{ ok: boolean }> {
  await chrome.tabs.update(tabId, { url });
  return { ok: true };
}

/** tabs.getActive — return info about the currently active tab */
export async function tabsGetActive(): Promise<TabInfo | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  return {
    tabId: tab.id ?? -1,
    windowId: tab.windowId ?? -1,
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: tab.active ?? true,
    audible: tab.audible ?? false,
    status: tab.status ?? 'unknown',
  };
}

/** tabs.getContent — get the text content / HTML of a tab */
export async function tabsGetContent(
  tabId: number,
  format: 'text' | 'html' = 'text',
): Promise<{ ok: boolean; content?: string; error?: string }> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (fmt: string) => {
        if (fmt === 'html') return document.documentElement.outerHTML;
        return document.body.innerText;
      },
      args: [format],
    });
    const content = results?.[0]?.result as string | undefined;
    // Truncate very large content to avoid blowing up the LLM context
    const MAX = 30_000;
    const truncated = content && content.length > MAX
      ? content.slice(0, MAX) + `\n\n[...truncated at ${MAX} chars]`
      : content;
    return { ok: true, content: truncated ?? '' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to get tab content' };
  }
}

/** webmcp.discover — discover WebMCP tools on a tab */
export async function webmcpDiscover(
  tabId?: number,
): Promise<unknown> {
  // If no tabId provided, use the active tab
  let targetTabId = tabId;
  if (targetTabId === undefined) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = activeTab?.id;
  }
  if (targetTabId === undefined) {
    return { available: false, error: 'NO_ACTIVE_TAB' };
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'FORCE_DISCOVER', payload: { tabId: targetTabId } },
      () => {
        chrome.runtime.sendMessage({ type: 'GET_REGISTRY' }, (registry) => {
          const entry = registry?.[targetTabId!];
          if (entry) {
            resolve({
              available: entry.available,
              tools: entry.tools,
              page: { url: entry.url, title: entry.title },
              tabId: targetTabId,
            });
          } else {
            resolve({ available: false, tools: [], tabId: targetTabId });
          }
        });
      },
    );
  });
}

/** webmcp.invoke — invoke a WebMCP tool on a tab */
export async function webmcpInvoke(
  tabId: number,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'WEBMCP_INVOKE', payload: { tabId, toolName, args } },
      (response) => {
        resolve(response ?? { ok: false, error: 'No response' });
      },
    );
  });
}
