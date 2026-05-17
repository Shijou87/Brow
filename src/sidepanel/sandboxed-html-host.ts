import {
  clampSandboxedHtmlHeight,
  createSandboxedHtmlReadyMessage,
  isSandboxFrameMetricsMessage,
  isSandboxProxyReadyMessage,
  isSandboxResourceLoadedMessage,
  type SandboxedHtmlResource,
} from './sandboxed-html';

const SANDBOX_STARTUP_TIMEOUT_MS = 10_000;

export interface SandboxedHtmlMountOptions {
  onSizeChange?: (height: number) => void;
  onError?: (message: string) => void;
}

type MountedSandboxedHtmlSession = {
  dispose: () => void;
};

export class SandboxedHtmlHost {
  private mountedSessions = new Map<string, MountedSandboxedHtmlSession>();

  async mount(
    sessionId: string,
    iframe: HTMLIFrameElement,
    sandboxUrl: string,
    resource: SandboxedHtmlResource,
    options: SandboxedHtmlMountOptions = {},
  ): Promise<void> {
    this.teardown(sessionId);

    const focusIframe = () => {
      try {
        iframe.focus({ preventScroll: true });
        iframe.contentWindow?.focus();
      } catch {
        // Ignore focus failures from transient iframe states.
      }
    };
    const handlePointerFocus = () => {
      window.setTimeout(focusIframe, 0);
    };
    iframe.tabIndex = 0;
    iframe.addEventListener('pointerdown', handlePointerFocus);
    iframe.addEventListener('click', handlePointerFocus);

    const startupTimer = window.setTimeout(() => {
      options.onError?.('HTML App sandbox did not finish loading.');
    }, SANDBOX_STARTUP_TIMEOUT_MS);

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;

      if (isSandboxProxyReadyMessage(event.data)) {
        iframe.contentWindow?.postMessage(createSandboxedHtmlReadyMessage(resource), '*');
        return;
      }

      if (isSandboxResourceLoadedMessage(event.data) && event.data.sessionId === sessionId) {
        window.clearTimeout(startupTimer);
        return;
      }

      if (isSandboxFrameMetricsMessage(event.data) && event.data.sessionId === sessionId) {
        window.clearTimeout(startupTimer);
        options.onSizeChange?.(clampSandboxedHtmlHeight(event.data.height));
      }
    };

    const dispose = () => {
      window.clearTimeout(startupTimer);
      window.removeEventListener('message', handleMessage);
      iframe.removeEventListener('pointerdown', handlePointerFocus);
      iframe.removeEventListener('click', handlePointerFocus);
    };

    window.addEventListener('message', handleMessage);
    this.mountedSessions.set(sessionId, { dispose });
    iframe.src = sandboxUrl;
  }

  teardown(sessionId: string): void {
    const mounted = this.mountedSessions.get(sessionId);
    if (!mounted) return;
    this.mountedSessions.delete(sessionId);
    mounted.dispose();
  }

  teardownAll(): void {
    for (const sessionId of [...this.mountedSessions.keys()]) {
      this.teardown(sessionId);
    }
  }
}
