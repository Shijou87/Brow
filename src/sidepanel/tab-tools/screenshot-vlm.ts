import type { VLMConfig } from '../../shared/types';
import type { BrowserViewportInfo, BrowserViewportRect } from '../../shared/types';
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

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load screenshot image'));
    image.src = dataUrl;
  });
}

export async function cropImageDataUrlToViewportRect(
  dataUrl: string,
  rect: BrowserViewportRect,
  viewport: BrowserViewportInfo,
  paddingPx = 8,
): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  try {
    const image = await loadImage(dataUrl);
    const scaleX = viewport.width > 0 ? image.naturalWidth / viewport.width : viewport.devicePixelRatio || 1;
    const scaleY = viewport.height > 0 ? image.naturalHeight / viewport.height : viewport.devicePixelRatio || 1;
    const paddedLeft = Math.max(0, rect.left - paddingPx);
    const paddedTop = Math.max(0, rect.top - paddingPx);
    const paddedRight = Math.min(viewport.width, rect.right + paddingPx);
    const paddedBottom = Math.min(viewport.height, rect.bottom + paddingPx);
    const sourceX = Math.max(0, Math.floor(paddedLeft * scaleX));
    const sourceY = Math.max(0, Math.floor(paddedTop * scaleY));
    const sourceWidth = Math.max(1, Math.ceil((paddedRight - paddedLeft) * scaleX));
    const sourceHeight = Math.max(1, Math.ceil((paddedBottom - paddedTop) * scaleY));

    const canvas = document.createElement('canvas');
    canvas.width = Math.min(sourceWidth, image.naturalWidth - sourceX);
    canvas.height = Math.min(sourceHeight, image.naturalHeight - sourceY);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, error: 'Canvas 2D context unavailable' };

    ctx.drawImage(
      image,
      sourceX,
      sourceY,
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    return { ok: true, dataUrl: canvas.toDataURL('image/png') };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to crop screenshot' };
  }
}

export async function tabCaptureScreenshotRegion(
  tabId: number | undefined,
  rect: BrowserViewportRect,
  viewport: BrowserViewportInfo,
  paddingPx = 8,
): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  const screenshot = await tabCaptureScreenshot(tabId);
  if (!screenshot.ok || !screenshot.dataUrl) return screenshot;
  return cropImageDataUrlToViewportRect(screenshot.dataUrl, rect, viewport, paddingPx);
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
