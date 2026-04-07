import type { VLMConfig } from '../../shared/types';
import { ensureTabIsActive } from './tabs';

export type { VLMConfig } from '../../shared/types';

export async function tabCaptureScreenshot(
  tabId?: number,
): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  try {
    if (tabId !== undefined) {
      await ensureTabIsActive(tabId);
    }

    const dataUrl: string = await chrome.tabs.captureVisibleTab({
      format: 'png',
    });

    return { ok: true, dataUrl };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to capture screenshot' };
  }
}

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
      headers.Authorization = `Bearer ${config.apiKey}`;
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

