export interface TabInfo {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  audible: boolean;
  status: string;
}

export async function tabsList(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({
    tabId: tab.id ?? -1,
    windowId: tab.windowId ?? -1,
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: tab.active ?? false,
    audible: tab.audible ?? false,
    status: tab.status ?? 'unknown',
  }));
}

export async function tabsActivate(tabId: number): Promise<{ ok: boolean }> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return { ok: true };
}

export async function tabsCreate(
  url: string,
  active = true,
): Promise<{ tabId: number; ok: boolean }> {
  const tab = await chrome.tabs.create({ url, active });
  return { tabId: tab.id ?? -1, ok: true };
}

export async function tabsUpdateUrl(
  tabId: number,
  url: string,
): Promise<{ ok: boolean }> {
  await chrome.tabs.update(tabId, { url });
  return { ok: true };
}

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
    const MAX = 30_000;
    const truncated = content && content.length > MAX
      ? `${content.slice(0, MAX)}\n\n[...truncated at ${MAX} chars]`
      : content;

    return { ok: true, content: truncated ?? '' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to get tab content' };
  }
}

export async function ensureTabIsActive(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

