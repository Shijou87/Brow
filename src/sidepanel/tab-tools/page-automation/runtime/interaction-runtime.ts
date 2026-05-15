import type { PageAutomationBaseRuntime } from './base-runtime';
import type {
  BrowserClickPoint,
  ClickPlan,
  ClickPoint,
  ClickDispatchMode,
  CursorFrame,
  VisibleRect,
} from './types';

export type FormFillMode =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'contenteditable'
  | 'unknown';

type OverlayParts = {
  root: HTMLDivElement;
  highlight: HTMLDivElement;
  cursor: HTMLDivElement;
  badge: HTMLDivElement;
};

type TypeableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export interface PageAutomationInteractionRuntime {
  resolveClickPlan(matchedEl: HTMLElement, clickPoint?: BrowserClickPoint): ClickPlan | null;
  previewClick(matchedEl: HTMLElement, message: string): Promise<void>;
  previewHighlight(matchedEl: HTMLElement, message: string): Promise<void>;
  previewHover(matchedEl: HTMLElement, message: string): Promise<ClickPlan | null>;
  previewFieldEdit(el: HTMLElement, message: string): Promise<void>;
  dispatchHover(matchedEl: HTMLElement, plan: ClickPlan): void;
  dispatchClick(matchedEl: HTMLElement, plan: ClickPlan): void;
  cleanupOverlay(delay?: number): void;
  showBadge(message: string, anchorX: number, anchorY: number): void;
  dispatchEnter(target: HTMLElement): void;
  findTypeTarget(matchedEl: HTMLElement): TypeableElement | null;
  animateTypeableElementValue(
    target: TypeableElement,
    nextValue: string,
    options?: { startValue?: string },
  ): Promise<void>;
  setTypeableElementValue(target: TypeableElement, nextValue: string): void;
  commitFilledTextField(target: HTMLInputElement | HTMLTextAreaElement): Promise<void>;
  setChecked(el: HTMLInputElement, nextChecked: boolean): void;
  inferMode(
    el: Element,
    requestedMode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable',
  ): FormFillMode;
  inferSubmitControl(elements: HTMLElement[]): HTMLElement | null;
}

export function createInteractionRuntime(
  base: PageAutomationBaseRuntime,
): PageAutomationInteractionRuntime {
  const ensureOverlay = (): OverlayParts => {
    let style = document.getElementById(base.STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = base.STYLE_ID;
      style.textContent = `
        #${base.ROOT_ID} {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 2147483647;
        }
        #${base.ROOT_ID} .brow-automation-cursor {
          position: fixed;
          top: 0;
          left: 0;
          width: ${base.CURSOR_SIZE}px;
          height: ${base.CURSOR_SIZE}px;
          opacity: 0;
          background-image: url("${base.CURSOR_SPRITESHEET_URL}");
          background-repeat: no-repeat;
          background-position: 0 0;
          background-size: ${base.CURSOR_SIZE * 4}px ${base.CURSOR_SIZE}px;
          filter: drop-shadow(0 0 10px rgba(168, 85, 247, 0.5));
          transform-origin: top left;
          transition: transform 160ms ease, opacity 140ms ease, filter 160ms ease;
        }
        #${base.ROOT_ID} .brow-automation-cursor[data-frame="hand"] {
          background-position: 0 0;
        }
        #${base.ROOT_ID} .brow-automation-cursor[data-frame="push"] {
          background-position: -${base.CURSOR_SIZE}px 0;
        }
        #${base.ROOT_ID} .brow-automation-cursor[data-frame="highlight"] {
          background-position: -${base.CURSOR_SIZE * 2}px 0;
        }
        #${base.ROOT_ID} .brow-automation-cursor[data-frame="pencil"] {
          background-position: -${base.CURSOR_SIZE * 3}px 0;
        }
        #${base.ROOT_ID} .brow-automation-cursor.visible {
          opacity: 1;
        }
        #${base.ROOT_ID} .brow-automation-badge {
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
        #${base.ROOT_ID} .brow-automation-badge.visible {
          opacity: 1;
          transform: translateY(0);
        }
        #${base.ROOT_ID} .brow-automation-highlight {
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
        #${base.ROOT_ID} .brow-automation-highlight.visible {
          opacity: 1;
        }
        #${base.ROOT_ID} .brow-automation-highlight.emphasized {
          animation: browAutomationHighlightPulse 1050ms ease-in-out infinite;
        }
        #${base.ROOT_ID} .brow-automation-ripple {
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
        #${base.ROOT_ID} .brow-automation-particle {
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
        @keyframes browAutomationHighlightPulse {
          0%, 100% {
            opacity: 0.92;
            transform: scale(1);
            box-shadow:
              0 0 0 1px rgba(244, 212, 255, 0.22),
              0 0 24px rgba(168, 85, 247, 0.24);
          }
          50% {
            opacity: 1;
            transform: scale(1.012);
            box-shadow:
              0 0 0 1px rgba(244, 212, 255, 0.34),
              0 0 36px rgba(192, 132, 252, 0.34);
          }
        }
      `;
      document.documentElement.appendChild(style);
    }

    let root = document.getElementById(base.ROOT_ID) as HTMLDivElement | null;
    if (!root) {
      root = document.createElement('div');
      root.id = base.ROOT_ID;
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

  const isRelatedElement = (left: Element | null, right: Element | null): boolean => {
    if (!left || !right) return false;
    return left === right || left.contains(right) || right.contains(left);
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
      x: base.clamp(rect.left + rect.width * px, 1, maxX),
      y: base.clamp(rect.top + rect.height * py, 1, maxY),
    }));
  };

  const buildPreferredClickPoint = (
    matchedEl: HTMLElement,
    clickPoint: BrowserClickPoint | undefined,
  ): ClickPlan | null => {
    if (!clickPoint) return null;
    const rect = base.getVisibleRect(matchedEl);
    if (!rect) return null;

    const maxX = Math.max(window.innerWidth - 2, 1);
    const maxY = Math.max(window.innerHeight - 2, 1);
    const point = (() => {
      if (clickPoint.origin === 'viewport') {
        return {
          x: base.clamp(clickPoint.x, 1, maxX),
          y: base.clamp(clickPoint.y, 1, maxY),
        };
      }
      if (clickPoint.origin === 'targetFraction') {
        return {
          x: base.clamp(rect.left + rect.width * clickPoint.x, 1, maxX),
          y: base.clamp(rect.top + rect.height * clickPoint.y, 1, maxY),
        };
      }
      return {
        x: base.clamp(rect.left + clickPoint.x, 1, maxX),
        y: base.clamp(rect.top + clickPoint.y, 1, maxY),
      };
    })();

    const hit = matchedEl.ownerDocument.elementFromPoint(point.x, point.y);
    if (!isRelatedElement(matchedEl, hit)) return null;
    return { target: matchedEl, point, rect, dispatchMode: 'synthetic' };
  };

  const resolveClickPlan = (matchedEl: HTMLElement, clickPoint?: BrowserClickPoint): ClickPlan | null => {
    const preferredPlan = buildPreferredClickPoint(matchedEl, clickPoint);
    if (preferredPlan) return preferredPlan;

    const candidates = [matchedEl, ...Array.from(matchedEl.querySelectorAll<HTMLElement>('*')).slice(0, 80)];
    let fallback: ClickPlan | null = null;

    for (const candidate of candidates) {
      const rect = base.getVisibleRect(candidate);
      if (!rect) continue;

      const points = buildClickPoints(rect);
      for (const point of points) {
        const hit = candidate.ownerDocument.elementFromPoint(point.x, point.y);
        if (isRelatedElement(matchedEl, hit) || isRelatedElement(candidate, hit)) {
          return { target: candidate, point, rect, dispatchMode: 'synthetic' };
        }
      }

      fallback ??= { target: candidate, point: points[0], rect, dispatchMode: 'programmatic' };
    }

    return fallback;
  };

  const positionBadge = (anchorX: number, anchorY: number) => {
    const { badge } = ensureOverlay();
    const left = base.clamp(anchorX, 12, Math.max(window.innerWidth - base.BADGE_WIDTH - 12, 12));
    const top = base.clamp(anchorY, 12, Math.max(window.innerHeight - base.BADGE_HEIGHT - 12, 12));
    badge.style.left = `${left}px`;
    badge.style.top = `${top}px`;
  };

  const positionBadgeNearCursor = (cursorX: number, cursorY: number) => {
    positionBadge(cursorX + base.BADGE_CURSOR_OFFSET_X, cursorY + base.BADGE_CURSOR_OFFSET_Y);
  };

  const positionBadgeNearRect = (rect: VisibleRect) => {
    const anchorX = Math.min(rect.right + 14, window.innerWidth - base.BADGE_WIDTH - 12);
    const anchorY = Math.max(rect.top - 2, 12);
    positionBadge(anchorX, anchorY);
  };

  const setCursorPosition = (
    x: number,
    y: number,
    scale = 1,
    rotationDeg = -8,
    frame: CursorFrame = 'hand',
  ) => {
    const { cursor, badge } = ensureOverlay();
    cursor.classList.add('visible');
    cursor.dataset.frame = frame;
    cursor.style.transform = `translate(${x}px, ${y}px) rotate(${rotationDeg}deg) scale(${scale})`;
    if (badge.dataset.followCursor === 'true') {
      positionBadgeNearCursor(x, y);
    }
  };

  const showBadge = (message: string, anchorX: number, anchorY: number) => {
    const { badge } = ensureOverlay();
    badge.textContent = message;
    badge.classList.add('visible');
    delete badge.dataset.followCursor;
    positionBadge(anchorX, anchorY);
  };

  const showBadgeNearCursor = (message: string, cursorX: number, cursorY: number) => {
    const { badge } = ensureOverlay();
    badge.textContent = message;
    badge.classList.add('visible');
    badge.dataset.followCursor = 'true';
    positionBadgeNearCursor(cursorX, cursorY);
  };

  const showHighlight = (el: HTMLElement, emphasized = false) => {
    const { highlight } = ensureOverlay();
    const rect = base.getVisibleRect(el);
    if (!rect) return;
    const pad = 6;
    highlight.classList.add('visible');
    highlight.classList.toggle('emphasized', emphasized);
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
      highlight.classList.remove('emphasized');
      badge.classList.remove('visible');
      delete badge.dataset.followCursor;
      root.querySelectorAll('.brow-automation-ripple').forEach((node) => node.remove());
      root.querySelectorAll('.brow-automation-particle').forEach((node) => node.remove());
    }, delay);
  };

  const animateCursorTo = async (
    from: ClickPoint,
    to: ClickPoint,
    durationMs: number,
    scale = 1,
    frame: CursorFrame = 'hand',
  ) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const travel = Math.hypot(dx, dy);
    const tilt = base.clamp((Math.atan2(dy, dx) * 180 / Math.PI) * 0.12, -18, 10);
    let lastParticleTs = 0;

    await new Promise<void>((resolve) => {
      const start = performance.now();

      const step = (now: number) => {
        const progress = Math.min((now - start) / durationMs, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const x = from.x + dx * eased;
        const y = from.y + dy * eased;
        setCursorPosition(x, y, scale, -8 + tilt, frame);

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

  const resolvePlanDispatchTarget = (matchedEl: HTMLElement, plan: ClickPlan): HTMLElement => {
    const hit = plan.target.ownerDocument.elementFromPoint(plan.point.x, plan.point.y);
    return base.isHTMLElementLike(hit) && isRelatedElement(matchedEl, hit)
      ? hit
      : plan.target;
  };

  const dispatchHover = (matchedEl: HTMLElement, plan: ClickPlan) => {
    const target = resolvePlanDispatchTarget(matchedEl, plan);
    const previousTarget = base.getLastHoveredElement();
    const ownerWindow = target.ownerDocument.defaultView ?? window;
    const shared = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: ownerWindow,
      clientX: plan.point.x,
      clientY: plan.point.y,
      screenX: base.toScreenX(plan.point.x),
      screenY: base.toScreenY(plan.point.y),
      detail: 0,
    };

    if (previousTarget && previousTarget !== target) {
      if (typeof PointerEvent === 'function') {
        previousTarget.dispatchEvent(new PointerEvent('pointerout', {
          ...shared,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 0,
          relatedTarget: target,
        }));
        previousTarget.dispatchEvent(new PointerEvent('pointerleave', {
          ...shared,
          bubbles: false,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 0,
          relatedTarget: target,
        }));
      }

      previousTarget.dispatchEvent(new MouseEvent('mouseout', {
        ...shared,
        button: 0,
        buttons: 0,
        relatedTarget: target,
      }));
      previousTarget.dispatchEvent(new MouseEvent('mouseleave', {
        ...shared,
        bubbles: false,
        button: 0,
        buttons: 0,
        relatedTarget: target,
      }));
    }

    if (typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent('pointerover', {
        ...shared,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
        relatedTarget: previousTarget,
      }));
      target.dispatchEvent(new PointerEvent('pointerenter', {
        ...shared,
        bubbles: false,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
        relatedTarget: previousTarget,
      }));
      target.dispatchEvent(new PointerEvent('pointermove', {
        ...shared,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0,
        relatedTarget: previousTarget,
      }));
    }

    target.dispatchEvent(new MouseEvent('mouseover', {
      ...shared,
      button: 0,
      buttons: 0,
      relatedTarget: previousTarget,
    }));
    target.dispatchEvent(new MouseEvent('mouseenter', {
      ...shared,
      bubbles: false,
      button: 0,
      buttons: 0,
      relatedTarget: previousTarget,
    }));
    target.dispatchEvent(new MouseEvent('mousemove', {
      ...shared,
      button: 0,
      buttons: 0,
      relatedTarget: previousTarget,
    }));

    base.setLastHoveredElement(target);
  };

  const dispatchClick = (matchedEl: HTMLElement, plan: ClickPlan) => {
    const target = resolvePlanDispatchTarget(matchedEl, plan);
    const ownerWindow = target.ownerDocument.defaultView ?? window;

    target.focus?.({ preventScroll: true });

    if (plan.dispatchMode === 'programmatic') {
      target.click?.();
      return;
    }

    const shared = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: ownerWindow,
      clientX: plan.point.x,
      clientY: plan.point.y,
      screenX: base.toScreenX(plan.point.x),
      screenY: base.toScreenY(plan.point.y),
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

  const previewClick = async (matchedEl: HTMLElement, message: string) => {
    matchedEl.scrollIntoView({ block: 'center', inline: 'center' });
    await base.sleep(90);
    const plan = resolveClickPlan(matchedEl);
    if (!plan) return;
    const startX = base.clamp(
      window.innerWidth / 2 - base.CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - base.CURSOR_WIDTH, 0),
    );
    const startY = base.clamp(
      window.innerHeight / 2 - base.CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - base.CURSOR_HEIGHT, 0),
    );
    const cursorX = base.clamp(
      plan.point.x - base.CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - base.CURSOR_WIDTH, 0),
    );
    const cursorY = base.clamp(
      plan.point.y - base.CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - base.CURSOR_HEIGHT, 0),
    );
    const rippleX = base.clamp(plan.point.x, 10, window.innerWidth - 10);
    const rippleY = base.clamp(plan.point.y, 10, window.innerHeight - 10);

    showHighlight(plan.target);
    showBadgeNearCursor(message, startX, startY);
    setCursorPosition(startX, startY, 0.96, -8, 'hand');
    await base.sleep(60);
    await animateCursorTo(
      { x: startX, y: startY },
      { x: cursorX, y: cursorY },
      360,
      1,
      'hand',
    );
    setCursorPosition(cursorX, cursorY, 0.9, -8, 'push');
    createRipple(rippleX, rippleY);
    burstParticles(rippleX, rippleY, 8, 1.25);
    await base.sleep(90);
    setCursorPosition(cursorX, cursorY, 1, -8, 'hand');
  };

  const previewHighlight = async (matchedEl: HTMLElement, message: string) => {
    matchedEl.scrollIntoView({ block: 'center', inline: 'center' });
    await base.sleep(90);
    const plan = resolveClickPlan(matchedEl);
    if (!plan) return;
    const cursorX = base.clamp(
      plan.point.x - base.HIGHLIGHT_CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - base.CURSOR_WIDTH, 0),
    );
    const cursorY = base.clamp(
      plan.point.y - base.HIGHLIGHT_CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - base.CURSOR_HEIGHT, 0),
    );
    showHighlight(plan.target, true);
    setCursorPosition(cursorX, cursorY, 1, 0, 'highlight');
    showBadge(message, plan.rect.right + 14, plan.rect.top - 2);
    positionBadgeNearRect(plan.rect);
    await base.sleep(180);
  };

  const previewHover = async (matchedEl: HTMLElement, message: string) => {
    matchedEl.scrollIntoView({ block: 'center', inline: 'center' });
    await base.sleep(90);
    const plan = resolveClickPlan(matchedEl);
    if (!plan) return null;
    const startX = base.clamp(
      window.innerWidth / 2 - base.CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - base.CURSOR_WIDTH, 0),
    );
    const startY = base.clamp(
      window.innerHeight / 2 - base.CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - base.CURSOR_HEIGHT, 0),
    );
    const cursorX = base.clamp(
      plan.point.x - base.CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - base.CURSOR_WIDTH, 0),
    );
    const cursorY = base.clamp(
      plan.point.y - base.CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - base.CURSOR_HEIGHT, 0),
    );

    showHighlight(plan.target);
    showBadgeNearCursor(message, startX, startY);
    setCursorPosition(startX, startY, 0.96, -8, 'hand');
    await base.sleep(60);
    await animateCursorTo(
      { x: startX, y: startY },
      { x: cursorX, y: cursorY },
      340,
      1,
      'hand',
    );
    showHighlight(plan.target, true);
    setCursorPosition(cursorX, cursorY, 1, -8, 'hand');
    await base.sleep(140);
    return plan;
  };

  const previewFieldEdit = async (el: HTMLElement, message: string) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await base.sleep(90);
    const rect = base.getVisibleRect(el);
    if (!rect) return;
    const cursorX = base.clamp(
      rect.left + 8 - base.PENCIL_CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - base.CURSOR_WIDTH, 0),
    );
    const cursorY = base.clamp(
      rect.top + rect.height / 2 - base.PENCIL_CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - base.CURSOR_HEIGHT, 0),
    );

    showHighlight(el);
    showBadgeNearCursor(message, cursorX, cursorY);
    setCursorPosition(cursorX, cursorY, 1, 0, 'pencil');
    await base.sleep(180);
  };

  const dispatchEnter = (target: HTMLElement) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      (target as HTMLInputElement | HTMLTextAreaElement).form?.requestSubmit?.();
    }
  };

  const setValue = (
    el: HTMLInputElement | HTMLTextAreaElement,
    nextValue: string,
    options: { dispatchChange?: boolean; inputData?: string | null } = {},
  ) => {
    const { dispatchChange = true, inputData = nextValue } = options;
    const ownerWindow = el.ownerDocument.defaultView ?? window;
    const prototype = el.tagName.toLowerCase() === 'textarea'
      ? ownerWindow.HTMLTextAreaElement.prototype
      : ownerWindow.HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (valueSetter) valueSetter.call(el, nextValue);
    else el.value = nextValue;
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: inputData,
      inputType: 'insertText',
    }));
    if (dispatchChange) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const isTextInput = (el: HTMLInputElement): boolean => {
    if (el.disabled || el.readOnly) return false;
    const type = (el.type || 'text').toLowerCase();
    return ![
      'button',
      'checkbox',
      'color',
      'file',
      'hidden',
      'image',
      'radio',
      'range',
      'reset',
      'submit',
    ].includes(type);
  };

  const asTypeableElement = (candidate: Element | null): TypeableElement | null => {
    if (!base.isHTMLElementLike(candidate)) return null;
    if (!base.isElementVisible(candidate)) return null;
    const tag = candidate.tagName.toLowerCase();
    if (tag === 'input') return isTextInput(candidate as HTMLInputElement) ? candidate : null;
    if (tag === 'textarea') {
      const textarea = candidate as HTMLTextAreaElement;
      return textarea.disabled || textarea.readOnly ? null : candidate;
    }
    if (candidate.isContentEditable) return candidate;
    return null;
  };

  const findTypeTarget = (matchedEl: HTMLElement): TypeableElement | null => {
    const directTarget = asTypeableElement(matchedEl);
    const selector = [
      'input:not([type="hidden"])',
      'textarea',
      '[contenteditable="true"]',
      '[contenteditable=""]',
      '[contenteditable="plaintext-only"]',
    ].join(', ');

    const findIn = (root: Element): TypeableElement | null => (
      Array.from(root.querySelectorAll(selector))
        .map((candidate) => asTypeableElement(candidate))
        .find((candidate): candidate is TypeableElement => Boolean(candidate)) ?? null
    );

    const descendantTarget = findIn(matchedEl);

    let ancestorTarget: TypeableElement | null = null;
    let parent = matchedEl.parentElement;
    let depth = 0;
    while (parent && parent !== document.body && depth < 6) {
      const parentTarget = asTypeableElement(parent) ?? findIn(parent);
      if (parentTarget) {
        ancestorTarget = parentTarget;
        break;
      }
      parent = parent.parentElement;
      depth += 1;
    }

    const activeTarget = asTypeableElement(document.activeElement);
    const visibleTypeTargets = Array.from(document.querySelectorAll(selector))
      .map((candidate) => asTypeableElement(candidate))
      .filter((candidate): candidate is TypeableElement => Boolean(candidate));

    if (directTarget) return directTarget;
    if (descendantTarget) return descendantTarget;
    if (ancestorTarget) return ancestorTarget;
    if (
      activeTarget
      && (activeTarget === matchedEl || matchedEl.contains(activeTarget) || activeTarget.contains(matchedEl))
    ) {
      return activeTarget;
    }

    return visibleTypeTargets.length === 1 ? visibleTypeTargets[0] : null;
  };

  const setTypeableElementValue = (
    target: TypeableElement,
    nextValue: string,
    options: { dispatchChange?: boolean; inputData?: string | null } = {},
  ) => {
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      setValue(target as HTMLInputElement | HTMLTextAreaElement, nextValue, options);
      return;
    }

    target.textContent = nextValue;
    target.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: options.inputData ?? nextValue,
      inputType: 'insertText',
    }));
    if (options.dispatchChange ?? true) {
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const animateTypeableElementValue = async (
    target: TypeableElement,
    nextValue: string,
    options: { startValue?: string } = {},
  ): Promise<void> => {
    const startValue = options.startValue ?? '';
    const characters = Array.from(nextValue);
    const cadenceMs = characters.length > 24 ? 14 : 20;

    if (characters.length === 0) {
      setTypeableElementValue(target, '', { inputData: null });
      return;
    }

    let partial = startValue;
    for (let index = 0; index < characters.length; index += 1) {
      partial += characters[index];
      setTypeableElementValue(target, partial, {
        dispatchChange: false,
        inputData: characters[index],
      });
      if (index < characters.length - 1) {
        await base.sleep(cadenceMs);
      }
    }

    target.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const commitFilledTextField = async (target: HTMLInputElement | HTMLTextAreaElement) => {
    const normalizedTagName = (target.tagName ?? '').trim().toLowerCase();
    const normalizedRole = (target.getAttribute('role') ?? '').trim().toLowerCase();
    const normalizedAriaAutocomplete = (target.getAttribute('aria-autocomplete') ?? '').trim().toLowerCase();
    const normalizedAriaHaspopup = (target.getAttribute('aria-haspopup') ?? '').trim().toLowerCase();
    const hasAriaControls = Boolean((target.getAttribute('aria-controls') ?? '').trim());
    const commitMode = (
      (normalizedTagName === 'input' || normalizedTagName === 'textarea')
      && (
        normalizedRole === 'combobox'
        || normalizedAriaAutocomplete === 'list'
        || normalizedAriaAutocomplete === 'both'
        || normalizedAriaHaspopup === 'listbox'
        || hasAriaControls
        || target.hasAttribute('list')
      )
    )
      ? 'enter'
      : 'none';

    if (commitMode === 'enter') {
      await base.sleep(30);
      dispatchEnter(target);
      await base.sleep(30);
    }
  };

  const setChecked = (el: HTMLInputElement, nextChecked: boolean) => {
    const ownerWindow = el.ownerDocument.defaultView ?? window;
    const checkedSetter = Object.getOwnPropertyDescriptor(
      ownerWindow.HTMLInputElement.prototype,
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
  ): FormFillMode => {
    if (requestedMode && requestedMode !== 'auto') return requestedMode;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return 'select';
    if (tag === 'input' && (el as HTMLInputElement).type === 'checkbox') return 'checkbox';
    if (tag === 'input' && (el as HTMLInputElement).type === 'radio') return 'radio';
    if (tag === 'input' || tag === 'textarea') return 'text';
    if (base.isHTMLElementLike(el) && el.isContentEditable) return 'contenteditable';
    return 'unknown';
  };

  const findCommonAncestor = (elements: HTMLElement[]): HTMLElement | null => {
    const [first, ...rest] = elements;
    if (!first) return null;

    let current: HTMLElement | null = first;
    while (current) {
      const candidate = current;
      if (rest.every((element) => candidate === element || candidate.contains(element))) {
        return candidate;
      }
      current = candidate.parentElement;
    }

    return null;
  };

  const inferSubmitControl = (elements: HTMLElement[]): HTMLElement | null => {
    if (elements.length === 0) return null;

    const normalizeSubmitCandidateValue = (value: string | null | undefined): string => (
      (value ?? '').trim().toLowerCase()
    );

    const scoreSubmitCandidate = (candidate: {
      tagName?: string | null;
      type?: string | null;
      role?: string | null;
      text?: string | null;
      name?: string | null;
      id?: string | null;
      testId?: string | null;
    }): number => {
      const positivePatterns: RegExp[] = [
        /\bcontinue\b/i,
        /\bsubmit\b/i,
        /\bnext\b/i,
        /\bsearch\b/i,
        /\bsave\b/i,
        /\bapply\b/i,
        /\breview\b/i,
        /\bcheckout\b/i,
        /\bplace order\b/i,
        /\bfinish\b/i,
        /\blog in\b/i,
        /\bsign in\b/i,
      ];
      const negativePatterns: RegExp[] = [
        /\bcancel\b/i,
        /\bback\b/i,
        /\bclose\b/i,
        /\bdismiss\b/i,
        /\bmenu\b/i,
        /\bdelete\b/i,
        /\bremove\b/i,
        /\breset\b/i,
      ];

      const tagName = normalizeSubmitCandidateValue(candidate.tagName);
      const type = normalizeSubmitCandidateValue(candidate.type);
      const role = normalizeSubmitCandidateValue(candidate.role);
      const textSignals = [candidate.text, candidate.name, candidate.id, candidate.testId]
        .map((value) => normalizeSubmitCandidateValue(value))
        .filter(Boolean);

      let score = 0;
      if (tagName === 'input' && type === 'submit') score += 110;
      else if (tagName === 'button' && type === 'submit') score += 100;
      else if (tagName === 'button') score += 30;
      else if (tagName === 'input' && type === 'button') score += 20;

      if (role === 'button') score += 12;

      for (const signal of textSignals) {
        if (positivePatterns.some((pattern) => pattern.test(signal))) score += 45;
        if (negativePatterns.some((pattern) => pattern.test(signal))) score -= 120;
      }

      return score;
    };

    const chooseSubmitCandidateIndex = (
      candidates: Array<Parameters<typeof scoreSubmitCandidate>[0]>,
    ): number | undefined => {
      if (candidates.length === 0) return undefined;

      const scored = candidates
        .map((candidate, index) => ({ index, score: scoreSubmitCandidate(candidate) }))
        .sort((left, right) => right.score - left.score);

      const best = scored[0];
      if (!best || best.score < 75) return undefined;

      const runnerUp = scored[1];
      if (runnerUp && best.score - runnerUp.score < 25) return undefined;

      return best.index;
    };

    const searchRoots: HTMLElement[] = [];
    const seenRoots = new Set<HTMLElement>();
    let root = findCommonAncestor(elements) ?? document.body;
    let depth = 0;

    while (root && depth < 5) {
      if (!seenRoots.has(root)) {
        searchRoots.push(root);
        seenRoots.add(root);
      }
      if (root === document.body) break;
      root = root.parentElement ?? document.body;
      depth += 1;
    }

    if (!seenRoots.has(document.body)) searchRoots.push(document.body);

    const selector = [
      'button',
      'input[type="submit"]',
      'input[type="button"]',
      '[role="button"]',
    ].join(', ');

    for (const searchRoot of searchRoots) {
      const controls = Array.from(searchRoot.querySelectorAll(selector))
        .filter((candidate): candidate is HTMLElement => base.isHTMLElementLike(candidate))
        .filter((candidate) => base.isElementVisible(candidate))
        .filter((candidate) => !elements.includes(candidate))
        .filter((candidate) => candidate.getAttribute('aria-disabled') !== 'true')
        .filter((candidate) => !('disabled' in candidate) || !(candidate as HTMLInputElement | HTMLButtonElement).disabled);

      const inferredIndex = chooseSubmitCandidateIndex(controls.map((candidate) => ({
        tagName: candidate.tagName,
        type: candidate instanceof HTMLInputElement || candidate instanceof HTMLButtonElement
          ? candidate.type
          : candidate.getAttribute('type'),
        role: candidate.getAttribute('role'),
        text: candidate.innerText || candidate.getAttribute('aria-label') || candidate.getAttribute('value'),
        name: candidate.getAttribute('name'),
        id: candidate.id,
        testId: candidate.getAttribute('data-testid') || candidate.getAttribute('data-test'),
      })));

      if (typeof inferredIndex === 'number') {
        return controls[inferredIndex] ?? null;
      }
    }

    return null;
  };

  return {
    resolveClickPlan,
    previewClick,
    previewHighlight,
    previewHover,
    previewFieldEdit,
    dispatchHover,
    dispatchClick,
    cleanupOverlay,
    showBadge,
    dispatchEnter,
    findTypeTarget,
    animateTypeableElementValue,
    setTypeableElementValue,
    commitFilledTextField,
    setChecked,
    inferMode,
    inferSubmitControl,
  };
}
