import { ensureTabIsActive } from './tabs';

export interface InteractiveElementInfo {
  selector: string;
  tagName: string;
  type?: string;
  text: string;
  role?: string;
  name?: string;
  id?: string;
  href?: string;
  placeholder?: string;
}

interface ClickPoint {
  x: number;
  y: number;
}

type PageAutomationAction =
  | {
    kind: 'click';
    selector: string;
  }
  | {
    kind: 'type';
    selector: string;
    text: string;
    submit: boolean;
  }
  | {
    kind: 'fillForm';
    fields: Array<{
      selector: string;
      value: string | number | boolean;
      mode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable';
    }>;
    submit: boolean;
    submitSelector?: string;
  };

async function runPageAutomationAction(action: PageAutomationAction): Promise<unknown> {
  const ROOT_ID = '__brow-automation-overlay__';
  const STYLE_ID = '__brow-automation-style__';

  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const toScreenX = (clientX: number) => (window.screenX ?? window.screenLeft ?? 0) + clientX;
  const toScreenY = (clientY: number) => (window.screenY ?? window.screenTop ?? 0) + clientY;

  const ensureOverlay = () => {
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        #${ROOT_ID} {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 2147483647;
        }
        #${ROOT_ID} .brow-automation-cursor {
          position: fixed;
          top: 0;
          left: 0;
          width: 28px;
          height: 34px;
          opacity: 0;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 40'%3E%3Cpath d='M11.7 2.4c1.85 0 3.35 1.5 3.35 3.35v9.1h1.2V4.9c0-1.85 1.5-3.35 3.35-3.35S22.95 3.05 22.95 4.9v9.95h1.2V7.9c0-1.85 1.5-3.35 3.35-3.35s3.35 1.5 3.35 3.35v13.45c0 8.95-5.1 15.55-13.35 15.55-5.35 0-8.4-2.95-10.05-6.7L2.65 19.35c-.8-1.75-.05-3.8 1.65-4.65 1.7-.85 3.8-.25 4.75 1.4l2.65 4.5V5.75c0-1.85 1.5-3.35 3.35-3.35Z' fill='%23d8b4fe' stroke='%237c3aed' stroke-width='2.15' stroke-linejoin='round'/%3E%3Cpath d='M15.05 14.85V6.35M22.95 14.85V7.4M24.15 14.85h-7.9' stroke='%23f5e9ff' stroke-width='1.4' stroke-linecap='round' opacity='.85'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: center;
          background-size: contain;
          filter: drop-shadow(0 0 10px rgba(168, 85, 247, 0.5));
          transform-origin: top left;
          transition: transform 160ms ease, opacity 140ms ease, filter 160ms ease;
        }
        #${ROOT_ID} .brow-automation-cursor.visible {
          opacity: 1;
        }
        #${ROOT_ID} .brow-automation-badge {
          position: fixed;
          top: 0;
          left: 0;
          max-width: min(300px, calc(100vw - 24px));
          padding: 8px 10px;
          border-radius: 10px;
          border: 2px solid rgba(192, 132, 252, 0.92);
          background: rgba(24, 10, 36, 0.96);
          color: #f5e9ff;
          font: 600 12px/1.35 "Space Grotesk", "Segoe UI", sans-serif;
          letter-spacing: 0.01em;
          box-shadow: 0 10px 34px rgba(168, 85, 247, 0.28);
          opacity: 0;
          transform: translateY(-4px);
          transition: opacity 180ms ease, transform 180ms ease;
          backdrop-filter: blur(6px);
        }
        #${ROOT_ID} .brow-automation-badge.visible {
          opacity: 1;
          transform: translateY(0);
        }
        #${ROOT_ID} .brow-automation-highlight {
          position: fixed;
          top: 0;
          left: 0;
          border-radius: 12px;
          border: 2px solid rgba(192, 132, 252, 0.98);
          background: rgba(168, 85, 247, 0.10);
          box-shadow:
            0 0 0 1px rgba(244, 212, 255, 0.22),
            0 0 24px rgba(168, 85, 247, 0.24);
          opacity: 0;
          transition: opacity 180ms ease;
        }
        #${ROOT_ID} .brow-automation-highlight.visible {
          opacity: 1;
        }
        #${ROOT_ID} .brow-automation-ripple {
          position: fixed;
          top: 0;
          left: 0;
          width: 18px;
          height: 18px;
          margin-left: -9px;
          margin-top: -9px;
          border-radius: 999px;
          border: 2px solid rgba(216, 180, 254, 0.95);
          background: rgba(216, 180, 254, 0.12);
          box-shadow: 0 0 20px rgba(168, 85, 247, 0.25);
          animation: browAutomationRipple 460ms ease-out forwards;
        }
        #${ROOT_ID} .brow-automation-particle {
          position: fixed;
          top: 0;
          left: 0;
          width: 8px;
          height: 8px;
          border-radius: 999px;
          pointer-events: none;
          background:
            radial-gradient(circle at 35% 35%, rgba(255,255,255,0.95), rgba(255,255,255,0.18) 35%, transparent 36%),
            radial-gradient(circle, rgba(216, 180, 254, 0.95), rgba(168, 85, 247, 0.32) 58%, transparent 74%);
          box-shadow:
            0 0 10px rgba(216, 180, 254, 0.55),
            0 0 18px rgba(168, 85, 247, 0.35);
          transform: translate(-50%, -50%);
          animation: browAutomationParticle var(--particle-duration, 420ms) ease-out forwards;
        }
        @keyframes browAutomationRipple {
          0% {
            opacity: 0.95;
            transform: scale(0.45);
          }
          100% {
            opacity: 0;
            transform: scale(4.8);
          }
        }
        @keyframes browAutomationParticle {
          0% {
            opacity: 0.92;
            transform: translate(-50%, -50%) translate3d(0, 0, 0) scale(1);
          }
          100% {
            opacity: 0;
            transform:
              translate(-50%, -50%)
              translate3d(var(--particle-dx, 0px), var(--particle-dy, 0px), 0)
              scale(0.2);
          }
        }
      `;
      document.documentElement.appendChild(style);
    }

    let root = document.getElementById(ROOT_ID) as HTMLDivElement | null;
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.setAttribute('aria-hidden', 'true');

      const highlight = document.createElement('div');
      highlight.className = 'brow-automation-highlight';

      const cursor = document.createElement('div');
      cursor.className = 'brow-automation-cursor';

      const badge = document.createElement('div');
      badge.className = 'brow-automation-badge';

      root.appendChild(highlight);
      root.appendChild(cursor);
      root.appendChild(badge);
      document.documentElement.appendChild(root);
    }

    return {
      root,
      highlight: root.querySelector('.brow-automation-highlight') as HTMLDivElement,
      cursor: root.querySelector('.brow-automation-cursor') as HTMLDivElement,
      badge: root.querySelector('.brow-automation-badge') as HTMLDivElement,
    };
  };

  const describeElement = (el: HTMLElement): string => {
    const label = [
      el.getAttribute('aria-label'),
      el.getAttribute('name'),
      el.getAttribute('placeholder'),
      el.id,
      el.innerText,
      el.textContent,
    ]
      .map((value) => (value ?? '').replace(/\s+/g, ' ').trim())
      .find(Boolean);

    if (label) return label.slice(0, 40);

    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return `${(el as HTMLInputElement).type || 'input'} field`;
    if (tag === 'textarea') return 'text area';
    return tag;
  };

  const isRelatedElement = (left: Element | null, right: Element | null): boolean => {
    if (!left || !right) return false;
    return left === right || left.contains(right) || right.contains(left);
  };

  const getVisibleRect = (el: Element): {
    left: number;
    top: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
  } | null => {
    const htmlEl = el as HTMLElement;
    const rects = typeof htmlEl.getClientRects === 'function'
      ? Array.from(htmlEl.getClientRects())
      : [];
    const chosen = rects.find((rect) => rect.width > 0 && rect.height > 0)
      ?? htmlEl.getBoundingClientRect?.();
    if (!chosen || chosen.width <= 0 || chosen.height <= 0) return null;
    return {
      left: chosen.left,
      top: chosen.top,
      width: chosen.width,
      height: chosen.height,
      right: chosen.right,
      bottom: chosen.bottom,
    };
  };

  const buildClickPoints = (rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): ClickPoint[] => {
    const maxX = Math.max(window.innerWidth - 2, 1);
    const maxY = Math.max(window.innerHeight - 2, 1);
    const candidatePairs: Array<[number, number]> = [
      [0.5, 0.5],
      [0.35, 0.5],
      [0.65, 0.5],
      [0.5, 0.35],
      [0.5, 0.65],
    ];

    return candidatePairs.map(([px, py]) => ({
      x: clamp(rect.left + rect.width * px, 1, maxX),
      y: clamp(rect.top + rect.height * py, 1, maxY),
    }));
  };

  const resolveClickPlan = (matchedEl: HTMLElement): {
    target: HTMLElement;
    point: ClickPoint;
    rect: {
      left: number;
      top: number;
      width: number;
      height: number;
      right: number;
      bottom: number;
    };
  } | null => {
    const candidates = [matchedEl, ...Array.from(matchedEl.querySelectorAll<HTMLElement>('*')).slice(0, 80)];
    let fallback: {
      target: HTMLElement;
      point: ClickPoint;
      rect: {
        left: number;
        top: number;
        width: number;
        height: number;
        right: number;
        bottom: number;
      };
    } | null = null;

    for (const candidate of candidates) {
      const rect = getVisibleRect(candidate);
      if (!rect) continue;

      const points = buildClickPoints(rect);
      for (const point of points) {
        const hit = document.elementFromPoint(point.x, point.y);
        if (isRelatedElement(matchedEl, hit) || isRelatedElement(candidate, hit)) {
          return { target: candidate, point, rect };
        }
      }

      fallback ??= { target: candidate, point: points[0], rect };
    }

    return fallback;
  };

  const setCursorPosition = (x: number, y: number, scale = 1, rotationDeg = -8) => {
    const { cursor } = ensureOverlay();
    cursor.classList.add('visible');
    cursor.style.transform = `translate(${x}px, ${y}px) rotate(${rotationDeg}deg) scale(${scale})`;
  };

  const showBadge = (message: string, anchorX: number, anchorY: number) => {
    const { badge } = ensureOverlay();
    badge.textContent = message;
    badge.classList.add('visible');
    const left = clamp(anchorX, 12, window.innerWidth - 312);
    const top = clamp(anchorY, 12, window.innerHeight - 72);
    badge.style.left = `${left}px`;
    badge.style.top = `${top}px`;
  };

  const showHighlight = (el: HTMLElement) => {
    const { highlight } = ensureOverlay();
    const rect = getVisibleRect(el);
    if (!rect) return;
    const pad = 6;
    highlight.classList.add('visible');
    highlight.style.left = `${Math.max(rect.left - pad, 0)}px`;
    highlight.style.top = `${Math.max(rect.top - pad, 0)}px`;
    highlight.style.width = `${Math.min(rect.width + pad * 2, window.innerWidth)}px`;
    highlight.style.height = `${Math.min(rect.height + pad * 2, window.innerHeight)}px`;
  };

  const createRipple = (x: number, y: number) => {
    const { root } = ensureOverlay();
    const ripple = document.createElement('div');
    ripple.className = 'brow-automation-ripple';
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    root.appendChild(ripple);
    window.setTimeout(() => ripple.remove(), 500);
  };

  const createParticle = (x: number, y: number, intensity = 1) => {
    const { root } = ensureOverlay();
    const particle = document.createElement('div');
    particle.className = 'brow-automation-particle';
    const size = 4 + Math.random() * 7 * intensity;
    const driftX = (-18 + Math.random() * 36) * intensity;
    const driftY = (-14 + Math.random() * 28) * intensity;
    const duration = 220 + Math.random() * 180;
    particle.style.left = `${x}px`;
    particle.style.top = `${y}px`;
    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;
    particle.style.setProperty('--particle-dx', `${driftX}px`);
    particle.style.setProperty('--particle-dy', `${driftY}px`);
    particle.style.setProperty('--particle-duration', `${duration}ms`);
    root.appendChild(particle);
    window.setTimeout(() => particle.remove(), duration + 40);
  };

  const burstParticles = (x: number, y: number, count = 8, intensity = 1) => {
    for (let i = 0; i < count; i += 1) {
      createParticle(
        x + (-4 + Math.random() * 8),
        y + (-4 + Math.random() * 8),
        intensity,
      );
    }
  };

  const cleanupOverlay = (delay = 900) => {
    const { cursor, highlight, badge, root } = ensureOverlay();
    window.setTimeout(() => {
      cursor.classList.remove('visible');
      highlight.classList.remove('visible');
      badge.classList.remove('visible');
      root.querySelectorAll('.brow-automation-ripple').forEach((node) => node.remove());
      root.querySelectorAll('.brow-automation-particle').forEach((node) => node.remove());
    }, delay);
  };

  const animateCursorTo = async (
    from: ClickPoint,
    to: ClickPoint,
    durationMs: number,
    scale = 1,
  ) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const travel = Math.hypot(dx, dy);
    const tilt = clamp((Math.atan2(dy, dx) * 180 / Math.PI) * 0.12, -18, 10);
    let lastParticleTs = 0;

    await new Promise<void>((resolve) => {
      const start = performance.now();

      const step = (now: number) => {
        const progress = Math.min((now - start) / durationMs, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const x = from.x + dx * eased;
        const y = from.y + dy * eased;
        setCursorPosition(x, y, scale, -8 + tilt);

        if (now - lastParticleTs >= 18) {
          const hotspotX = x + 12;
          const hotspotY = y + 10;
          burstParticles(
            hotspotX,
            hotspotY,
            travel > 180 ? 2 : 1,
            progress < 0.65 ? 1 : 0.7,
          );
          lastParticleTs = now;
        }

        if (progress < 1) {
          window.requestAnimationFrame(step);
          return;
        }

        resolve();
      };

      window.requestAnimationFrame(step);
    });
  };

  const dispatchSyntheticMouseClick = (matchedEl: HTMLElement, point: ClickPoint) => {
    const hit = document.elementFromPoint(point.x, point.y);
    const target = hit instanceof HTMLElement && isRelatedElement(matchedEl, hit)
      ? hit
      : matchedEl;

    target.focus?.({ preventScroll: true });

    const shared = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: point.x,
      clientY: point.y,
      screenX: toScreenX(point.x),
      screenY: toScreenY(point.y),
      detail: 1,
    };

    if (typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent('pointerover', {
        ...shared,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
      }));
      target.dispatchEvent(new PointerEvent('pointerdown', {
        ...shared,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 1,
      }));
    }

    target.dispatchEvent(new MouseEvent('mouseover', {
      ...shared,
      button: 0,
      buttons: 0,
    }));
    target.dispatchEvent(new MouseEvent('mousemove', {
      ...shared,
      button: 0,
      buttons: 0,
    }));
    target.dispatchEvent(new MouseEvent('mousedown', {
      ...shared,
      button: 0,
      buttons: 1,
    }));

    if (typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent('pointerup', {
        ...shared,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
      }));
    }

    target.dispatchEvent(new MouseEvent('mouseup', {
      ...shared,
      button: 0,
      buttons: 0,
    }));
    target.dispatchEvent(new MouseEvent('click', {
      ...shared,
      button: 0,
      buttons: 0,
    }));
  };

  const previewClick = async (el: HTMLElement, message: string) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(90);
    const rect = getVisibleRect(el);
    if (!rect) return;
    const startX = clamp(window.innerWidth / 2 - 14, 10, window.innerWidth - 26);
    const startY = clamp(window.innerHeight / 2 - 17, 10, window.innerHeight - 34);
    const cursorX = clamp(rect.left + Math.min(rect.width * 0.35, 18), 10, window.innerWidth - 26);
    const cursorY = clamp(rect.top + Math.min(rect.height * 0.4, 18), 10, window.innerHeight - 34);
    const rippleX = clamp(rect.left + rect.width / 2, 10, window.innerWidth - 10);
    const rippleY = clamp(rect.top + rect.height / 2, 10, window.innerHeight - 10);

    showHighlight(el);
    showBadge(message, rect.left + 10, rect.top - 54);
    setCursorPosition(startX, startY, 0.96);
    await sleep(60);
    await animateCursorTo(
      { x: startX, y: startY },
      { x: cursorX, y: cursorY },
      360,
      1,
    );
    createRipple(rippleX, rippleY);
    burstParticles(rippleX, rippleY, 8, 1.25);
    setCursorPosition(cursorX, cursorY, 0.88);
    await sleep(90);
    setCursorPosition(cursorX, cursorY, 1);
  };

  const previewFieldEdit = async (el: HTMLElement, message: string) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(90);
    const rect = getVisibleRect(el);
    if (!rect) return;
    const cursorX = clamp(rect.left + 8, 10, window.innerWidth - 26);
    const cursorY = clamp(rect.top + rect.height / 2 - 8, 10, window.innerHeight - 34);

    showHighlight(el);
    showBadge(message, rect.left + 10, rect.top - 54);
    setCursorPosition(cursorX, cursorY, 1);
    await sleep(180);
  };

  const dispatchEnter = (target: HTMLElement) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.form?.requestSubmit?.();
    }
  };

  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, nextValue: string) => {
    const prototype = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (valueSetter) valueSetter.call(el, nextValue);
    else el.value = nextValue;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const setChecked = (el: HTMLInputElement, nextChecked: boolean) => {
    const checkedSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'checked',
    )?.set;
    if (checkedSetter) checkedSetter.call(el, nextChecked);
    else el.checked = nextChecked;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const inferMode = (
    el: Element,
    requestedMode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable',
  ): 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable' | 'unknown' => {
    if (requestedMode && requestedMode !== 'auto') return requestedMode;
    if (el instanceof HTMLSelectElement) return 'select';
    if (el instanceof HTMLInputElement && el.type === 'checkbox') return 'checkbox';
    if (el instanceof HTMLInputElement && el.type === 'radio') return 'radio';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return 'text';
    if (el instanceof HTMLElement && el.isContentEditable) return 'contenteditable';
    return 'unknown';
  };

  if (action.kind === 'click') {
    const el = document.querySelector(action.selector);
    if (!el) {
      return { ok: false, error: `Element not found for selector: ${action.selector}` };
    }

    if (!(el instanceof HTMLElement)) {
      return { ok: false, error: 'Matched element is not an HTMLElement' };
    }

    if ('disabled' in el && Boolean((el as HTMLInputElement).disabled)) {
      return { ok: false, error: 'Matched element is disabled' };
    }

    const text = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(120);

    const initialPlan = resolveClickPlan(el);
    if (!initialPlan) {
      return { ok: false, error: 'Matched element has no visible click target' };
    }

    await previewClick(initialPlan.target, `Brow clicking ${describeElement(el)}`);
    const finalPlan = resolveClickPlan(el) ?? initialPlan;
    finalPlan.target.focus({ preventScroll: true });
    dispatchSyntheticMouseClick(el, finalPlan.point);
    cleanupOverlay();

    return {
      ok: true,
      clicked: {
        selector: action.selector,
        tagName: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type || undefined,
        text,
        role: el.getAttribute('role') || undefined,
        name: el.getAttribute('name') || undefined,
        id: el.id || undefined,
        href: (el as HTMLAnchorElement).href || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
      },
    };
  }

  if (action.kind === 'type') {
    const el = document.querySelector(action.selector);
    if (!el) {
      return { ok: false, error: `Element not found for selector: ${action.selector}` };
    }

    const summarize = (target: HTMLElement) => ({
      selector: action.selector,
      tagName: target.tagName.toLowerCase(),
      type: (target as HTMLInputElement).type || undefined,
      text: (target.innerText || target.getAttribute('aria-label') || action.text)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120),
      role: target.getAttribute('role') || undefined,
      name: target.getAttribute('name') || undefined,
      id: target.id || undefined,
      href: (target as HTMLAnchorElement).href || undefined,
      placeholder: target.getAttribute('placeholder') || undefined,
      textLength: action.text.length,
    });

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      await previewFieldEdit(el, `Brow typing into ${describeElement(el)}`);
      el.focus({ preventScroll: true });
      setValue(el, action.text);
      if (action.submit) {
        showBadge('Brow submitting input', 16, 16);
        await sleep(120);
        dispatchEnter(el);
      }
      cleanupOverlay();
      return { ok: true, typed: summarize(el) };
    }

    if (el instanceof HTMLElement && el.isContentEditable) {
      await previewFieldEdit(el, `Brow typing into ${describeElement(el)}`);
      el.focus({ preventScroll: true });
      el.textContent = action.text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: action.text, inputType: 'insertText' }));
      if (action.submit) {
        showBadge('Brow submitting input', 16, 16);
        await sleep(120);
        dispatchEnter(el);
      }
      cleanupOverlay();
      return { ok: true, typed: summarize(el) };
    }

    return { ok: false, error: 'Matched element is not typeable' };
  }

  const results: Array<{
    selector: string;
    ok: boolean;
    mode: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable' | 'unknown';
    tagName?: string;
    type?: string;
    value?: string | number | boolean;
    error?: string;
  }> = [];
  let formForSubmit: HTMLFormElement | null = null;

  for (const field of action.fields) {
    const selector = typeof field?.selector === 'string' ? field.selector : '';
    if (!selector) {
      results.push({
        selector: '',
        ok: false,
        mode: field?.mode ?? 'auto',
        error: 'Missing selector',
      });
      continue;
    }

    const el = document.querySelector(selector);
    if (!el) {
      results.push({
        selector,
        ok: false,
        mode: field?.mode ?? 'auto',
        value: field?.value,
        error: `Element not found for selector: ${selector}`,
      });
      continue;
    }

    if (!(el instanceof HTMLElement)) {
      results.push({
        selector,
        ok: false,
        mode: field?.mode ?? 'auto',
        value: field?.value,
        error: 'Matched element is not an HTMLElement',
      });
      continue;
    }

    const mode = inferMode(el, field.mode);
    const tagName = el.tagName.toLowerCase();
    const type = el instanceof HTMLInputElement ? el.type : undefined;

    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus({ preventScroll: true });

    if (!formForSubmit) {
      const closestForm = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
        ? el.form
        : el.closest('form');
      if (closestForm instanceof HTMLFormElement) {
        formForSubmit = closestForm;
      }
    }

    try {
      if (mode === 'text') {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          await previewFieldEdit(el, `Brow typing into ${describeElement(el)}`);
          setValue(el, String(field.value));
          results.push({ selector, ok: true, mode, tagName, type, value: field.value });
          continue;
        }
        results.push({
          selector,
          ok: false,
          mode,
          tagName,
          type,
          value: field.value,
          error: 'Matched element is not a text input',
        });
        continue;
      }

      if (mode === 'contenteditable') {
        if (el.isContentEditable) {
          await previewFieldEdit(el, `Brow typing into ${describeElement(el)}`);
          el.textContent = String(field.value);
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: String(field.value),
            inputType: 'insertText',
          }));
          results.push({ selector, ok: true, mode, tagName, type, value: field.value });
          continue;
        }
        results.push({
          selector,
          ok: false,
          mode,
          tagName,
          type,
          value: field.value,
          error: 'Matched element is not contenteditable',
        });
        continue;
      }

      if (mode === 'select') {
        if (el instanceof HTMLSelectElement) {
          const targetValue = String(field.value).trim();
          const options = Array.from(el.options);
          const option = options.find((candidate) =>
            candidate.value === targetValue ||
            candidate.label === targetValue ||
            candidate.text.trim() === targetValue ||
            candidate.label.toLowerCase() === targetValue.toLowerCase() ||
            candidate.text.trim().toLowerCase() === targetValue.toLowerCase(),
          );

          if (!option) {
            results.push({
              selector,
              ok: false,
              mode,
              tagName,
              type,
              value: field.value,
              error: `No option matches "${targetValue}"`,
            });
            continue;
          }

          await previewFieldEdit(el, `Brow selecting ${option.label || option.text}`);
          el.value = option.value;
          option.selected = true;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          results.push({ selector, ok: true, mode, tagName, type, value: option.value });
          continue;
        }

        results.push({
          selector,
          ok: false,
          mode,
          tagName,
          type,
          value: field.value,
          error: 'Matched element is not a select element',
        });
        continue;
      }

      if (mode === 'checkbox' || mode === 'radio') {
        if (el instanceof HTMLInputElement && el.type === mode) {
          const nextChecked = Boolean(field.value);
          await previewClick(el, `${nextChecked ? 'Brow selecting' : 'Brow clearing'} ${describeElement(el)}`);
          if (el.checked !== nextChecked) {
            if (nextChecked) {
              el.click();
            }
            if (el.checked !== nextChecked) {
              setChecked(el, nextChecked);
            }
          }
          results.push({ selector, ok: true, mode, tagName, type, value: nextChecked });
          continue;
        }

        results.push({
          selector,
          ok: false,
          mode,
          tagName,
          type,
          value: field.value,
          error: `Matched element is not a ${mode} input`,
        });
        continue;
      }

      results.push({
        selector,
        ok: false,
        mode,
        tagName,
        type,
        value: field.value,
        error: 'Could not infer how to fill this element',
      });
    } catch (err: any) {
      results.push({
        selector,
        ok: false,
        mode,
        tagName,
        type,
        value: field.value,
        error: err?.message ?? 'Failed to fill field',
      });
    }
  }

  let submitted = false;
  let submitError: string | undefined;

  if ((action.submit || action.submitSelector) && results.every((result) => result.ok)) {
    if (action.submitSelector) {
      const submitEl = document.querySelector(action.submitSelector);
      if (submitEl instanceof HTMLElement) {
        await previewClick(submitEl, `Brow submitting ${describeElement(submitEl)}`);
        submitEl.focus({ preventScroll: true });
        submitEl.click();
        submitted = true;
      } else {
        submitError = `Submit element not found for selector: ${action.submitSelector}`;
      }
    } else if (formForSubmit) {
      showBadge('Brow submitting form', 16, 16);
      await sleep(140);
      formForSubmit.requestSubmit?.();
      if (!formForSubmit.requestSubmit) formForSubmit.submit();
      submitted = true;
    } else {
      submitError = 'No parent form found to submit';
    }
  }

  cleanupOverlay(1000);

  const hadFieldErrors = results.some((result) => !result.ok);
  return {
    ok: !hadFieldErrors && !submitError,
    results,
    submitted,
    error: submitError ?? (hadFieldErrors ? 'One or more form fields could not be filled' : undefined),
  };
}

export async function tabsListInteractiveElements(
  tabId: number,
  limit = 40,
): Promise<{ ok: boolean; elements?: InteractiveElementInfo[]; error?: string }> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (maxResults: number) => {
        const cleanText = (value: string | null | undefined): string =>
          (value ?? '').replace(/\s+/g, ' ').trim();

        const escapeCss = (value: string): string => {
          if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
          return value.replace(/["\\]/g, '\\$&');
        };

        const isVisible = (el: Element): boolean => {
          const rect = (el as HTMLElement).getBoundingClientRect?.();
          if (!rect || rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };

        const isUnique = (selector: string): boolean => {
          try {
            return document.querySelectorAll(selector).length === 1;
          } catch {
            return false;
          }
        };

        const buildDomPath = (el: Element): string => {
          const parts: string[] = [];
          let current: Element | null = el;

          while (current && current !== document.body && parts.length < 6) {
            const htmlEl = current as HTMLElement;
            if (htmlEl.id) {
              const idSelector = `#${escapeCss(htmlEl.id)}`;
              parts.unshift(idSelector);
              if (isUnique(idSelector)) return parts.join(' > ');
            }

            let part = current.tagName.toLowerCase();
            const parent = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children as HTMLCollectionOf<Element>).filter(
                (child: Element) => child.tagName === current!.tagName,
              );
              if (siblings.length > 1) {
                part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
              }
            }

            parts.unshift(part);
            current = parent;
          }

          return parts.join(' > ');
        };

        const buildSelector = (el: Element): string => {
          const tag = el.tagName.toLowerCase();
          const attrCandidates: Array<string | null> = [
            (el as HTMLElement).id ? `#${escapeCss((el as HTMLElement).id)}` : null,
            el.getAttribute('data-testid')
              ? `${tag}[data-testid="${escapeCss(el.getAttribute('data-testid')!)}"]`
              : null,
            el.getAttribute('aria-label')
              ? `${tag}[aria-label="${escapeCss(el.getAttribute('aria-label')!)}"]`
              : null,
            el.getAttribute('name')
              ? `${tag}[name="${escapeCss(el.getAttribute('name')!)}"]`
              : null,
            el.getAttribute('placeholder')
              ? `${tag}[placeholder="${escapeCss(el.getAttribute('placeholder')!)}"]`
              : null,
          ];

          for (const candidate of attrCandidates) {
            if (candidate && isUnique(candidate)) return candidate;
          }

          return buildDomPath(el);
        };

        const selector = [
          'a[href]',
          'button',
          'input',
          'textarea',
          'select',
          '[role="button"]',
          '[role="link"]',
          '[contenteditable="true"]',
          '[tabindex]:not([tabindex="-1"])',
        ].join(', ');

        const elements = Array.from(document.querySelectorAll(selector))
          .filter((el) => isVisible(el))
          .slice(0, maxResults)
          .map((el) => {
            const htmlEl = el as HTMLElement;
            const text = cleanText(
              htmlEl.innerText ||
              el.getAttribute('aria-label') ||
              (el as HTMLInputElement).value ||
              el.getAttribute('placeholder') ||
              el.getAttribute('name'),
            ).slice(0, 120);

            return {
              selector: buildSelector(el),
              tagName: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type || undefined,
              text,
              role: el.getAttribute('role') || undefined,
              name: el.getAttribute('name') || undefined,
              id: htmlEl.id || undefined,
              href: (el as HTMLAnchorElement).href || undefined,
              placeholder: el.getAttribute('placeholder') || undefined,
            };
          });

        return elements;
      },
      args: [Math.max(1, Math.min(limit, 100))],
    });

    const elements = results?.[0]?.result as InteractiveElementInfo[] | undefined;
    return { ok: true, elements: elements ?? [] };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to list interactive elements' };
  }
}

export async function tabsClick(
  tabId: number,
  selector: string,
): Promise<{ ok: boolean; clicked?: InteractiveElementInfo; error?: string }> {
  try {
    await ensureTabIsActive(tabId);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'click', selector }],
    });

    return (results?.[0]?.result as { ok: boolean; clicked?: InteractiveElementInfo; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to click element' };
  }
}

export async function tabsType(
  tabId: number,
  selector: string,
  text: string,
  submit = false,
): Promise<{ ok: boolean; typed?: InteractiveElementInfo & { textLength: number }; error?: string }> {
  try {
    await ensureTabIsActive(tabId);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'type', selector, text, submit }],
    });

    return (results?.[0]?.result as { ok: boolean; typed?: InteractiveElementInfo & { textLength: number }; error?: string } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to type into element' };
  }
}

export type FormFillMode =
  | 'auto'
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'contenteditable';

export interface FormFillField {
  selector: string;
  value: string | number | boolean;
  mode?: FormFillMode;
}

export interface FormFillFieldResult {
  selector: string;
  ok: boolean;
  mode: FormFillMode | 'unknown';
  tagName?: string;
  type?: string;
  value?: string | number | boolean;
  error?: string;
}

export async function tabsFillForm(
  tabId: number,
  fields: FormFillField[],
  submit = false,
  submitSelector?: string,
): Promise<{
  ok: boolean;
  results?: FormFillFieldResult[];
  submitted?: boolean;
  error?: string;
}> {
  try {
    await ensureTabIsActive(tabId);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'fillForm', fields, submit, submitSelector }],
    });

    return (results?.[0]?.result as {
      ok: boolean;
      results?: FormFillFieldResult[];
      submitted?: boolean;
      error?: string;
    } | undefined) ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to fill form' };
  }
}

