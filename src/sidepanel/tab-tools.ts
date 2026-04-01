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

// ─── Screenshot & VLM Tools ─────────────────────────────────────────────────

/**
 * Capture a screenshot of the given tab.
 * Activates the tab first, waits briefly for rendering, then captures.
 * Returns a base64-encoded PNG data URL.
 */
export async function tabCaptureScreenshot(
  tabId?: number,
): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  try {
    // If a specific tab is requested, activate it first
    if (tabId !== undefined) {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.active) {
        await chrome.tabs.update(tabId, { active: true });
        if (tab.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        // Brief delay to allow rendering after activation
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const dataUrl: string = await chrome.tabs.captureVisibleTab({
      format: 'png',
    });

    return { ok: true, dataUrl };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to capture screenshot' };
  }
}

export interface VLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Send a screenshot (base64 data URL) + text query to a VLM endpoint
 * using the OpenAI-compatible chat/completions vision API format.
 */
export async function vlmQuery(
  config: VLMConfig,
  imageDataUrl: string,
  query: string,
): Promise<{ ok: boolean; result?: string; error?: string }> {
  try {
    const base = config.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const body = {
      model: config.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: query },
            {
              type: 'image_url',
              image_url: { url: imageDataUrl },
            },
          ],
        },
      ],
      max_tokens: 4096,
    };

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`VLM request failed: HTTP ${res.status} — ${errText}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    return { ok: true, result: content };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'VLM query failed' };
  }
}

// ─── Bookmarks & History Tools ──────────────────────────────────────────────

export interface BookmarkInfo {
  id: string;
  title: string;
  url?: string;
  parentId?: string;
  dateAdded?: number;
  children?: BookmarkInfo[];
}

function flattenBookmarks(nodes: chrome.bookmarks.BookmarkTreeNode[]): BookmarkInfo[] {
  const result: BookmarkInfo[] = [];
  for (const node of nodes) {
    result.push({
      id: node.id,
      title: node.title,
      url: node.url,
      parentId: node.parentId,
      dateAdded: node.dateAdded,
    });
    if (node.children) {
      result.push(...flattenBookmarks(node.children));
    }
  }
  return result;
}

/** bookmarks.getAll — return all bookmarks (flattened) */
export async function bookmarksGetAll(): Promise<BookmarkInfo[]> {
  const tree = await chrome.bookmarks.getTree();
  return flattenBookmarks(tree);
}

/** bookmarks.search — search bookmarks by query string */
export async function bookmarksSearch(query: string): Promise<BookmarkInfo[]> {
  const results = await chrome.bookmarks.search(query);
  return results.map((b) => ({
    id: b.id,
    title: b.title,
    url: b.url,
    parentId: b.parentId,
    dateAdded: b.dateAdded,
  }));
}

export interface HistoryItem {
  id: string;
  url: string;
  title: string;
  lastVisitTime?: number;
  visitCount?: number;
}

/** history.search — search browser history */
export async function historySearch(
  query: string,
  maxResults = 50,
  startTime?: number,
): Promise<HistoryItem[]> {
  const results = await chrome.history.search({
    text: query,
    maxResults,
    startTime: startTime ?? 0,
  });
  return results.map((h) => ({
    id: h.id ?? '',
    url: h.url ?? '',
    title: h.title ?? '',
    lastVisitTime: h.lastVisitTime,
    visitCount: h.visitCount,
  }));
}

// ─── WebMCP Tools ───────────────────────────────────────────────────────────

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
