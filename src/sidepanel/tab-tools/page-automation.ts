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

interface VisibleRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface ClickPlan {
  target: HTMLElement;
  point: ClickPoint;
  rect: VisibleRect;
  dispatchMode: 'synthetic' | 'programmatic';
}

type PageAutomationAction =
  | {
    kind: 'highlight';
    selector: string;
    message?: string;
    durationMs?: number;
  }
  | {
    kind: 'hover';
    selector: string;
    message?: string;
    durationMs?: number;
  }
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
  const CURSOR_WIDTH = 28;
  const CURSOR_HEIGHT = 34;
  const CURSOR_HOTSPOT_X = 12;
  const CURSOR_HOTSPOT_Y = 10;
  const BADGE_WIDTH = 300;
  const BADGE_HEIGHT = 60;
  const BADGE_CURSOR_OFFSET_X = CURSOR_WIDTH + 10;
  const BADGE_CURSOR_OFFSET_Y = -2;
  const LAST_HOVERED_KEY = '__browLastHoveredElement__';

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
        #${ROOT_ID} .brow-automation-highlight.emphasized {
          animation: browAutomationHighlightPulse 1050ms ease-in-out infinite;
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

  const isElementVisible = (el: Element): boolean => {
    const rect = (el as HTMLElement).getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };

  const escapeAttributeValue = (value: string): string => (
    value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  );

  const decodeCssIdentifier = (value: string): string => {
    let result = '';
    let index = 0;

    while (index < value.length) {
      const char = value[index];
      if (char !== '\\') {
        result += char;
        index += 1;
        continue;
      }

      index += 1;
      if (index >= value.length) break;

      // CSS.escape() encodes leading digits as \3N with a required terminator
      // space. If that space is dropped by the model, recover the intended digit.
      if (result.length === 0 && value[index] === '3' && /[0-9]/.test(value[index + 1] ?? '')) {
        result += String.fromCharCode(parseInt(value.slice(index, index + 2), 16));
        index += 2;
        if (value[index] === ' ') index += 1;
        continue;
      }

      let hex = '';
      while (index < value.length && hex.length < 6 && /[0-9a-fA-F]/.test(value[index])) {
        hex += value[index];
        index += 1;
      }

      if (hex) {
        result += String.fromCodePoint(parseInt(hex, 16));
        if (value[index] === ' ') index += 1;
        continue;
      }

      result += value[index];
      index += 1;
    }

    return result;
  };

  const toIdAttributeSelector = (rawId: string): string => `[id="${escapeAttributeValue(rawId)}"]`;

  const normalizeIdSelectorPart = (part: string): string | null => {
    if (!part.startsWith('#')) return null;
    const rawId = decodeCssIdentifier(part.slice(1).trim());
    if (!rawId) return null;
    return toIdAttributeSelector(rawId);
  };

  const tryQueryElement = (selector: string): HTMLElement | null => {
    try {
      const match = document.querySelector(selector);
      return match instanceof HTMLElement ? match : null;
    } catch {
      return null;
    }
  };

  const tryQueryUniqueElement = (selector: string): HTMLElement | null => {
    try {
      const matches = Array.from(document.querySelectorAll(selector))
        .filter((match): match is HTMLElement => match instanceof HTMLElement);
      if (matches.length !== 1) return null;
      return matches[0];
    } catch {
      return null;
    }
  };

  const normalizeInlineText = (value: string | null | undefined): string => (
    (value ?? '').replace(/\s+/g, ' ').trim()
  );

  const unquoteSelectorText = (value: string): string => {
    const trimmed = value.trim();
    if (trimmed.length < 2) return trimmed;

    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    const quotePairs: Array<[string, string]> = [
      ['"', '"'],
      ['\'', '\''],
      ['“', '”'],
      ['‘', '’'],
    ];

    const match = quotePairs.find(([open, close]) => first === open && last === close);
    if (!match) return trimmed;
    return trimmed.slice(1, -1);
  };

  const splitSelectorList = (selector: string): string[] => {
    const parts: string[] = [];
    let current = '';
    let parenDepth = 0;
    let bracketDepth = 0;
    let quote: string | null = null;

    for (let index = 0; index < selector.length; index += 1) {
      const char = selector[index];

      if (quote) {
        current += char;
        if (char === quote && selector[index - 1] !== '\\') {
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === '\'' || char === '“' || char === '‘') {
        quote = char === '“' ? '”' : char === '‘' ? '’' : char;
        current += char;
        continue;
      }

      if (char === '[') bracketDepth += 1;
      else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (char === '(') parenDepth += 1;
      else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);

      if (char === ',' && parenDepth === 0 && bracketDepth === 0) {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = '';
        continue;
      }

      current += char;
    }

    const tail = current.trim();
    if (tail) parts.push(tail);
    return parts;
  };

  const collectTextMatchMetadata = (el: HTMLElement, needle: string) => {
    const normalizedNeedle = normalizeInlineText(needle).toLowerCase();
    const text = normalizeInlineText(
      el.innerText
      || el.textContent
      || el.getAttribute('aria-label')
      || el.getAttribute('title')
      || el.getAttribute('placeholder')
      || el.getAttribute('name'),
    );
    const normalizedText = text.toLowerCase();
    const rect = getVisibleRect(el);
    const area = rect ? rect.width * rect.height : Number.POSITIVE_INFINITY;
    let depth = 0;
    let current: HTMLElement | null = el;
    while (current) {
      depth += 1;
      current = current.parentElement;
    }

    return {
      text,
      normalizedText,
      exact: normalizedText === normalizedNeedle,
      startsWith: normalizedText.startsWith(normalizedNeedle),
      index: normalizedText.indexOf(normalizedNeedle),
      lengthDelta: Math.abs(text.length - needle.length),
      area,
      depth,
    };
  };

  const pruneAndSortTextMatches = (elements: HTMLElement[], needle: string): HTMLElement[] => {
    const deduped = elements.filter((element, index) =>
      elements.findIndex((candidate) => candidate === element) === index,
    );
    const innermost = deduped.filter((element) =>
      !deduped.some((candidate) => candidate !== element && element.contains(candidate)),
    );
    const pool = innermost.length > 0 ? innermost : deduped;

    return [...pool].sort((left, right) => {
      const leftMeta = collectTextMatchMetadata(left, needle);
      const rightMeta = collectTextMatchMetadata(right, needle);
      if (leftMeta.exact !== rightMeta.exact) return leftMeta.exact ? -1 : 1;
      if (leftMeta.startsWith !== rightMeta.startsWith) return leftMeta.startsWith ? -1 : 1;
      if (leftMeta.index !== rightMeta.index) return leftMeta.index - rightMeta.index;
      if (leftMeta.lengthDelta !== rightMeta.lengthDelta) return leftMeta.lengthDelta - rightMeta.lengthDelta;
      if (leftMeta.area !== rightMeta.area) return leftMeta.area - rightMeta.area;
      return rightMeta.depth - leftMeta.depth;
    });
  };

  const parseTextSelectorPseudo = (
    segment: string,
  ): { baseSelector: string; needle: string; suffixSelector?: string } | null => {
    const tokens = [':contains(', ':has-text('];
    const matches = tokens
      .map((token) => ({ token, index: segment.indexOf(token) }))
      .filter((match) => match.index >= 0)
      .sort((left, right) => left.index - right.index);
    if (matches.length === 0) return null;

    const { token, index } = matches[0];

    let depth = 1;
    let quote: string | null = null;
    let cursor = index + token.length;

    for (; cursor < segment.length; cursor += 1) {
      const char = segment[cursor];

      if (quote) {
        if (char === quote && segment[cursor - 1] !== '\\') {
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === '\'' || char === '“' || char === '‘') {
        quote = char === '“' ? '”' : char === '‘' ? '’' : char;
        continue;
      }

      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    if (depth !== 0) return null;

    const baseSelector = segment.slice(0, index).trim() || '*';
    const needle = normalizeInlineText(unquoteSelectorText(segment.slice(index + token.length, cursor)));
    if (!needle) return null;

    const suffixSelector = segment.slice(cursor + 1).trim() || undefined;
    return { baseSelector, needle, suffixSelector };
  };

  const expandContainsBaseSelectors = (baseSelector: string): string[] => {
    const normalized = baseSelector.trim() || '*';
    const variants = [normalized];
    const seen = new Set(variants);
    const push = (candidate: string) => {
      const trimmed = candidate.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      variants.push(trimmed);
    };

    if (/^h[1-6]$/i.test(normalized)) {
      push(':is(h1, h2, h3, h4, h5, h6, [role="heading"])');
    }

    const headingSuffixVariant = normalized.replace(
      /(^|[\s>+~])h[1-6]$/i,
      '$1:is(h1, h2, h3, h4, h5, h6, [role="heading"])',
    );
    if (headingSuffixVariant !== normalized) {
      push(headingSuffixVariant);
    }

    return variants;
  };

  const resolveRelativeTextTargets = (baseElement: HTMLElement, suffixSelector?: string): HTMLElement[] => {
    const suffix = suffixSelector?.trim();
    if (!suffix) return [baseElement];

    const collectScoped = (selector: string): HTMLElement[] => {
      try {
        return Array.from(baseElement.querySelectorAll(selector))
          .filter((match): match is HTMLElement => match instanceof HTMLElement);
      } catch {
        return [];
      }
    };

    if (suffix.startsWith('+')) {
      const siblingSelector = suffix.slice(1).trim() || '*';
      const sibling = baseElement.nextElementSibling;
      return sibling instanceof HTMLElement && sibling.matches(siblingSelector) ? [sibling] : [];
    }

    if (suffix.startsWith('~')) {
      const siblingSelector = suffix.slice(1).trim() || '*';
      const matches: HTMLElement[] = [];
      let sibling = baseElement.nextElementSibling;
      while (sibling) {
        if (sibling instanceof HTMLElement && sibling.matches(siblingSelector)) {
          matches.push(sibling);
        }
        sibling = sibling.nextElementSibling;
      }
      return matches;
    }

    if (suffix.startsWith('>')) {
      const childSelector = suffix.slice(1).trim() || '*';
      return collectScoped(`:scope > ${childSelector}`);
    }

    return collectScoped(suffix);
  };

  const queryTextMatchesForBaseSelectors = (
    baseSelectors: string[],
    needle: string,
    resolvedSelector: string,
    requireUnique = false,
    suffixSelector?: string,
  ): { element: HTMLElement; resolvedSelector: string } | null => {
    const matches: HTMLElement[] = [];

    for (const baseSelector of baseSelectors) {
      let candidates: HTMLElement[] = [];
      try {
        candidates = Array.from(document.querySelectorAll(baseSelector))
          .filter((match): match is HTMLElement => match instanceof HTMLElement);
      } catch {
        continue;
      }

      const baseMatches = candidates.filter((candidate) => {
        if (!isElementVisible(candidate)) return false;
        const text = collectTextMatchMetadata(candidate, needle).normalizedText;
        return text.includes(normalizeInlineText(needle).toLowerCase());
      });

      for (const baseMatch of baseMatches) {
        const relatedTargets = resolveRelativeTextTargets(baseMatch, suffixSelector)
          .filter((target) => isElementVisible(target));
        matches.push(...relatedTargets);
      }

      if (!requireUnique && matches.length > 0) {
        const ranked = pruneAndSortTextMatches(matches, needle);
        if (ranked.length > 0) {
          return { element: ranked[0], resolvedSelector };
        }
      }
    }

    const ranked = pruneAndSortTextMatches(matches, needle);
    if (!requireUnique) {
      return ranked.length > 0 ? { element: ranked[0], resolvedSelector } : null;
    }

    return ranked.length === 1 ? { element: ranked[0], resolvedSelector } : null;
  };

  const parseSimpleLocator = (
    selector: string,
  ): { kind: 'text' | 'heading' | 'title' | 'placeholder'; needle: string } | null => {
    const match = selector.match(/^\s*(text|heading|title|placeholder)\s*(?:=|:)\s*(.+?)\s*$/i);
    if (!match) return null;
    const kind = match[1].toLowerCase() as 'text' | 'heading' | 'title' | 'placeholder';
    const needle = normalizeInlineText(unquoteSelectorText(match[2]));
    if (!needle) return null;
    return { kind, needle };
  };

  const querySimpleLocator = (
    selector: string,
    requireUnique = false,
  ): { element: HTMLElement; resolvedSelector: string } | null => {
    const parsed = parseSimpleLocator(selector);
    if (!parsed) return null;

    const baseSelectors =
      parsed.kind === 'heading'
        ? ['h1, h2, h3, h4, h5, h6, [role="heading"]']
        : parsed.kind === 'title'
          ? ['[title]']
          : parsed.kind === 'placeholder'
            ? ['[placeholder]']
            : ['a, button, input, textarea, select, label, summary, h1, h2, h3, h4, h5, h6, p, span, div, li, dt, dd, article, section, [role="button"], [role="link"], [role="heading"], [title], [placeholder], [aria-label]'];

    return queryTextMatchesForBaseSelectors(
      baseSelectors,
      parsed.needle,
      `${parsed.kind}="${parsed.needle}"`,
      requireUnique,
    );
  };

  const queryTextPseudoElement = (
    selector: string,
    requireUnique = false,
  ): { element: HTMLElement; resolvedSelector: string } | null => {
    const matches: Array<{ element: HTMLElement; resolvedSelector: string }> = [];

    for (const segment of splitSelectorList(selector)) {
      const parsed = parseTextSelectorPseudo(segment);
      if (!parsed) continue;

      const baseSelectors = expandContainsBaseSelectors(parsed.baseSelector);
      const match = queryTextMatchesForBaseSelectors(
        baseSelectors,
        parsed.needle,
        segment,
        requireUnique,
        parsed.suffixSelector,
      );

      if (!requireUnique && match) return match;
      if (requireUnique && match) matches.push(match);
    }

    if (!requireUnique) return null;
    return matches.length === 1 ? matches[0] : null;
  };

  const queryExtendedElement = (
    selector: string,
    requireUnique = false,
  ): { element: HTMLElement; resolvedSelector: string } | null => {
    const simpleLocatorMatch = querySimpleLocator(selector, requireUnique);
    if (simpleLocatorMatch) return simpleLocatorMatch;

    const segments = splitSelectorList(selector);
    const matches: Array<{ element: HTMLElement; resolvedSelector: string }> = [];

    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;

      if (trimmed.includes(':contains(') || trimmed.includes(':has-text(')) {
        const textPseudoMatch = queryTextPseudoElement(trimmed, requireUnique);
        if (!requireUnique && textPseudoMatch) return textPseudoMatch;
        if (requireUnique && textPseudoMatch) matches.push(textPseudoMatch);
        continue;
      }

      const element = requireUnique
        ? tryQueryUniqueElement(trimmed)
        : tryQueryElement(trimmed);
      if (!element) continue;

      const match = { element, resolvedSelector: trimmed };
      if (!requireUnique) return match;
      matches.push(match);
    }

    if (!requireUnique) return null;

    const uniqueElements = matches.filter((match, index) =>
      matches.findIndex((candidate) => candidate.element === match.element) === index,
    );
    return uniqueElements.length === 1 ? uniqueElements[0] : null;
  };

  const isSuspiciousSelectorPart = (part: string): boolean => {
    const normalized = part
      .replace(/\s+/g, ' ')
      .replace(/["']/g, '')
      .replace(/\\([^\s])/g, '$1')
      .trim()
      .toLowerCase();

    return normalized === '#undefined'
      || normalized === '#null'
      || normalized === '#nan'
      || normalized.includes('[id=undefined]')
      || normalized.includes('[id=null]')
      || normalized.includes('[name=undefined]')
      || normalized.includes('[name=null]')
      || normalized.includes('[data-testid=undefined]')
      || normalized.includes('[data-testid=null]');
  };

  const hasStableSelectorAnchor = (part: string): boolean => (
    part.includes('#')
    || part.includes('[id=')
    || part.includes('[data-testid=')
    || part.includes('[aria-label=')
    || part.includes('[name=')
    || part.includes('[placeholder=')
  );

  const buildSelectorRecoveryCandidates = (selector: string): string[] => {
    const rawParts = selector.split(/\s*>\s*/).map((part) => part.trim()).filter(Boolean);
    if (rawParts.length === 0) return [];

    const cleanedParts = rawParts.filter((part) => !isSuspiciousSelectorPart(part));
    const candidates: string[] = [];
    const seen = new Set<string>();
    const push = (candidate: string) => {
      const trimmed = candidate.trim();
      if (!trimmed || trimmed === selector || seen.has(trimmed)) return;
      seen.add(trimmed);
      candidates.push(trimmed);
    };

    if (cleanedParts.length > 0 && cleanedParts.length !== rawParts.length) {
      push(cleanedParts.join(' > '));
    }

    const normalizedIdParts = cleanedParts.map((part) => normalizeIdSelectorPart(part) ?? part);
    if (normalizedIdParts.some((part, index) => part !== cleanedParts[index])) {
      push(normalizedIdParts.join(' > '));
      for (let index = normalizedIdParts.length - 1; index >= 0; index -= 1) {
        const part = normalizedIdParts[index];
        if (!hasStableSelectorAnchor(part)) continue;
        push(normalizedIdParts.slice(index).join(' > '));
        push(part);
      }
    }

    for (let index = cleanedParts.length - 1; index >= 0; index -= 1) {
      const part = cleanedParts[index];
      if (!hasStableSelectorAnchor(part)) continue;
      push(cleanedParts.slice(index).join(' > '));
      push(part);
    }

    return candidates;
  };

  const resolveActionElement = (selector: string): { element: HTMLElement; resolvedSelector: string } | null => {
    const direct = queryExtendedElement(selector);
    if (direct) {
      return direct;
    }

    for (const candidate of buildSelectorRecoveryCandidates(selector)) {
      const recovered = queryExtendedElement(candidate, true);
      if (recovered && isElementVisible(recovered.element)) {
        return recovered;
      }
    }

    return null;
  };

  const isRelatedElement = (left: Element | null, right: Element | null): boolean => {
    if (!left || !right) return false;
    return left === right || left.contains(right) || right.contains(left);
  };

  const getVisibleRect = (el: Element): VisibleRect | null => {
    const htmlEl = el as HTMLElement;
    const bounding = htmlEl.getBoundingClientRect?.();
    const rects = typeof htmlEl.getClientRects === 'function'
      ? Array.from(htmlEl.getClientRects())
      : [];
    const chosen = (
      bounding && bounding.width > 0 && bounding.height > 0
        ? bounding
        : rects.find((rect) => rect.width > 0 && rect.height > 0)
    );
    if (!chosen || chosen.width <= 0 || chosen.height <= 0) return null;

    const left = Math.max(chosen.left, 0);
    const top = Math.max(chosen.top, 0);
    const right = Math.min(chosen.right, window.innerWidth);
    const bottom = Math.min(chosen.bottom, window.innerHeight);
    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) return null;

    return {
      left,
      top,
      width,
      height,
      right,
      bottom,
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

  const resolveClickPlan = (matchedEl: HTMLElement): ClickPlan | null => {
    const candidates = [matchedEl, ...Array.from(matchedEl.querySelectorAll<HTMLElement>('*')).slice(0, 80)];
    let fallback: ClickPlan | null = null;

    for (const candidate of candidates) {
      const rect = getVisibleRect(candidate);
      if (!rect) continue;

      const points = buildClickPoints(rect);
      for (const point of points) {
        const hit = document.elementFromPoint(point.x, point.y);
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
    const left = clamp(anchorX, 12, Math.max(window.innerWidth - BADGE_WIDTH - 12, 12));
    const top = clamp(anchorY, 12, Math.max(window.innerHeight - BADGE_HEIGHT - 12, 12));
    badge.style.left = `${left}px`;
    badge.style.top = `${top}px`;
  };

  const positionBadgeNearCursor = (cursorX: number, cursorY: number) => {
    positionBadge(cursorX + BADGE_CURSOR_OFFSET_X, cursorY + BADGE_CURSOR_OFFSET_Y);
  };

  const positionBadgeNearRect = (rect: VisibleRect) => {
    const anchorX = Math.min(rect.right + 14, window.innerWidth - BADGE_WIDTH - 12);
    const anchorY = Math.max(rect.top - 2, 12);
    positionBadge(anchorX, anchorY);
  };

  const setCursorPosition = (x: number, y: number, scale = 1, rotationDeg = -8) => {
    const { cursor, badge } = ensureOverlay();
    cursor.classList.add('visible');
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

  const hideCursor = () => {
    const { cursor, badge } = ensureOverlay();
    cursor.classList.remove('visible');
    delete badge.dataset.followCursor;
  };

  const showHighlight = (el: HTMLElement, emphasized = false) => {
    const { highlight } = ensureOverlay();
    const rect = getVisibleRect(el);
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

  const getLastHoveredElement = (): HTMLElement | null => {
    const current = (window as Window & { [LAST_HOVERED_KEY]?: Element | null })[LAST_HOVERED_KEY];
    if (current instanceof HTMLElement && current.isConnected) {
      return current;
    }

    delete (window as Window & { [LAST_HOVERED_KEY]?: Element | null })[LAST_HOVERED_KEY];
    return null;
  };

  const setLastHoveredElement = (el: HTMLElement | null) => {
    const hoverWindow = window as Window & { [LAST_HOVERED_KEY]?: Element | null };
    if (el && el.isConnected) {
      hoverWindow[LAST_HOVERED_KEY] = el;
      return;
    }

    delete hoverWindow[LAST_HOVERED_KEY];
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

  const resolvePlanDispatchTarget = (matchedEl: HTMLElement, plan: ClickPlan): HTMLElement => {
    const hit = document.elementFromPoint(plan.point.x, plan.point.y);
    return hit instanceof HTMLElement && isRelatedElement(matchedEl, hit)
      ? hit
      : plan.target;
  };

  const dispatchHover = (matchedEl: HTMLElement, plan: ClickPlan) => {
    const target = resolvePlanDispatchTarget(matchedEl, plan);
    const previousTarget = getLastHoveredElement();
    const shared = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: plan.point.x,
      clientY: plan.point.y,
      screenX: toScreenX(plan.point.x),
      screenY: toScreenY(plan.point.y),
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

    setLastHoveredElement(target);
  };

  const dispatchClick = (matchedEl: HTMLElement, plan: ClickPlan) => {
    const target = resolvePlanDispatchTarget(matchedEl, plan);

    target.focus?.({ preventScroll: true });

    if (plan.dispatchMode === 'programmatic') {
      target.click?.();
      return;
    }

    const shared = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: plan.point.x,
      clientY: plan.point.y,
      screenX: toScreenX(plan.point.x),
      screenY: toScreenY(plan.point.y),
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
    await sleep(90);
    const plan = resolveClickPlan(matchedEl);
    if (!plan) return;
    const startX = clamp(
      window.innerWidth / 2 - CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - CURSOR_WIDTH, 0),
    );
    const startY = clamp(
      window.innerHeight / 2 - CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - CURSOR_HEIGHT, 0),
    );
    const cursorX = clamp(
      plan.point.x - CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - CURSOR_WIDTH, 0),
    );
    const cursorY = clamp(
      plan.point.y - CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - CURSOR_HEIGHT, 0),
    );
    const rippleX = clamp(plan.point.x, 10, window.innerWidth - 10);
    const rippleY = clamp(plan.point.y, 10, window.innerHeight - 10);

    showHighlight(plan.target);
    showBadgeNearCursor(message, startX, startY);
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

  const previewHighlight = async (matchedEl: HTMLElement, message: string) => {
    matchedEl.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(90);
    const plan = resolveClickPlan(matchedEl);
    if (!plan) return;
    hideCursor();
    showHighlight(plan.target, true);
    showBadge(message, plan.rect.right + 14, plan.rect.top - 2);
    positionBadgeNearRect(plan.rect);
    await sleep(180);
  };

  const previewHover = async (matchedEl: HTMLElement, message: string) => {
    matchedEl.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(90);
    const plan = resolveClickPlan(matchedEl);
    if (!plan) return null;
    const startX = clamp(
      window.innerWidth / 2 - CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - CURSOR_WIDTH, 0),
    );
    const startY = clamp(
      window.innerHeight / 2 - CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - CURSOR_HEIGHT, 0),
    );
    const cursorX = clamp(
      plan.point.x - CURSOR_HOTSPOT_X,
      0,
      Math.max(window.innerWidth - CURSOR_WIDTH, 0),
    );
    const cursorY = clamp(
      plan.point.y - CURSOR_HOTSPOT_Y,
      0,
      Math.max(window.innerHeight - CURSOR_HEIGHT, 0),
    );

    showHighlight(plan.target);
    showBadgeNearCursor(message, startX, startY);
    setCursorPosition(startX, startY, 0.96);
    await sleep(60);
    await animateCursorTo(
      { x: startX, y: startY },
      { x: cursorX, y: cursorY },
      340,
      1,
    );
    showHighlight(plan.target, true);
    setCursorPosition(cursorX, cursorY, 1);
    await sleep(140);
    return plan;
  };

  const previewFieldEdit = async (el: HTMLElement, message: string) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(90);
    const rect = getVisibleRect(el);
    if (!rect) return;
    const cursorX = clamp(rect.left + 8, 10, window.innerWidth - 26);
    const cursorY = clamp(rect.top + rect.height / 2 - 8, 10, window.innerHeight - 34);

    showHighlight(el);
    showBadgeNearCursor(message, cursorX, cursorY);
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

  const summarizeElement = (selector: string, el: HTMLElement): InteractiveElementInfo => ({
    selector,
    tagName: el.tagName.toLowerCase(),
    type: (el as HTMLInputElement).type || undefined,
    text: (el.innerText || el.getAttribute('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120),
    role: el.getAttribute('role') || undefined,
    name: el.getAttribute('name') || undefined,
    id: el.id || undefined,
    href: (el as HTMLAnchorElement).href || undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
  });

  if (action.kind === 'highlight') {
    const resolved = resolveActionElement(action.selector);
    if (!resolved) {
      return { ok: false, error: `Element not found for selector: ${action.selector}` };
    }
    const { element: el, resolvedSelector } = resolved;

    const plan = resolveClickPlan(el);
    if (!plan) {
      return { ok: false, error: 'Matched element has no visible highlight target' };
    }

    const durationMs = clamp(Math.round(action.durationMs ?? 2200), 600, 10000);
    const message = (action.message ?? `Brow highlighting ${describeElement(el)}`).trim();
    await previewHighlight(el, message || `Brow highlighting ${describeElement(el)}`);
    cleanupOverlay(durationMs);

    return {
      ok: true,
      highlighted: summarizeElement(resolvedSelector, el),
      durationMs,
      message: message || `Brow highlighting ${describeElement(el)}`,
    };
  }

  if (action.kind === 'hover') {
    const resolved = resolveActionElement(action.selector);
    if (!resolved) {
      return { ok: false, error: `Element not found for selector: ${action.selector}` };
    }
    const { element: el, resolvedSelector } = resolved;

    const initialPlan = resolveClickPlan(el);
    if (!initialPlan) {
      return { ok: false, error: 'Matched element has no visible hover target' };
    }

    const durationMs = clamp(Math.round(action.durationMs ?? 1400), 500, 10000);
    const message = (action.message ?? `Brow hovering ${describeElement(el)}`).trim()
      || `Brow hovering ${describeElement(el)}`;
    await previewHover(el, message);
    const finalPlan = resolveClickPlan(el) ?? initialPlan;
    dispatchHover(el, finalPlan);
    cleanupOverlay(durationMs);

    return {
      ok: true,
      hovered: summarizeElement(resolvedSelector, el),
      durationMs,
      message,
    };
  }

  if (action.kind === 'click') {
    const resolved = resolveActionElement(action.selector);
    if (!resolved) {
      return { ok: false, error: `Element not found for selector: ${action.selector}` };
    }
    const { element: el, resolvedSelector } = resolved;

    if ('disabled' in el && Boolean((el as HTMLInputElement).disabled)) {
      return { ok: false, error: 'Matched element is disabled' };
    }

    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(120);

    const initialPlan = resolveClickPlan(el);
    if (!initialPlan) {
      return { ok: false, error: 'Matched element has no visible click target' };
    }

    await previewClick(el, `Brow clicking ${describeElement(el)}`);
    const finalPlan = resolveClickPlan(el) ?? initialPlan;
    finalPlan.target.focus({ preventScroll: true });
    dispatchClick(el, finalPlan);
    cleanupOverlay();

    return {
      ok: true,
      clicked: summarizeElement(resolvedSelector, el),
    };
  }

  if (action.kind === 'type') {
    const resolved = resolveActionElement(action.selector);
    if (!resolved) {
      return { ok: false, error: `Element not found for selector: ${action.selector}` };
    }
    const { element: el, resolvedSelector } = resolved;

    const summarize = (target: HTMLElement) => ({
      selector: resolvedSelector,
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

    const resolvedField = resolveActionElement(selector);
    if (!resolvedField) {
      results.push({
        selector,
        ok: false,
        mode: field?.mode ?? 'auto',
        value: field?.value,
        error: `Element not found for selector: ${selector}`,
      });
      continue;
    }
    const { element: el, resolvedSelector } = resolvedField;

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
          results.push({ selector: resolvedSelector, ok: true, mode, tagName, type, value: field.value });
          continue;
        }
        results.push({
          selector: resolvedSelector,
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
          results.push({ selector: resolvedSelector, ok: true, mode, tagName, type, value: field.value });
          continue;
        }
        results.push({
          selector: resolvedSelector,
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
              selector: resolvedSelector,
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
          results.push({ selector: resolvedSelector, ok: true, mode, tagName, type, value: option.value });
          continue;
        }

        results.push({
          selector: resolvedSelector,
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
          results.push({ selector: resolvedSelector, ok: true, mode, tagName, type, value: nextChecked });
          continue;
        }

        results.push({
          selector: resolvedSelector,
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
        selector: resolvedSelector,
        ok: false,
        mode,
        tagName,
        type,
        value: field.value,
        error: 'Could not infer how to fill this element',
      });
    } catch (err: any) {
      results.push({
        selector: resolvedSelector,
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
      const resolvedSubmit = resolveActionElement(action.submitSelector);
      if (resolvedSubmit?.element instanceof HTMLElement) {
        const submitEl = resolvedSubmit.element;
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

        const hasReliableValue = (value: string | null | undefined): value is string => {
          const normalized = cleanText(value).toLowerCase();
          return normalized !== ''
            && normalized !== 'undefined'
            && normalized !== 'null'
            && normalized !== 'nan'
            && normalized !== '[object object]';
        };

        const escapeCss = (value: string): string => {
          if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
          return value.replace(/["\\]/g, '\\$&');
        };

        const escapeAttributeValue = (value: string): string => (
          value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        );

        const canUseHashIdSelector = (value: string): boolean => (
          /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(value)
        );

        const buildIdSelector = (value: string): string => (
          canUseHashIdSelector(value)
            ? `#${escapeCss(value)}`
            : `[id="${escapeAttributeValue(value)}"]`
        );

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

        const matchesExactly = (selector: string, el: Element): boolean => {
          try {
            return document.querySelector(selector) === el && isUnique(selector);
          } catch {
            return false;
          }
        };

        const buildAttributeSelector = (
          tag: string,
          attrName: string,
          attrValue: string | null,
        ): string | null => (
          hasReliableValue(attrValue)
            ? `${tag}[${attrName}="${escapeAttributeValue(attrValue)}"]`
            : null
        );

        const buildDomPath = (el: Element): string => {
          const parts: string[] = [];
          let current: Element | null = el;

          while (current && current !== document.body && parts.length < 6) {
            const htmlEl = current as HTMLElement;
            if (hasReliableValue(htmlEl.id)) {
              const idSelector = buildIdSelector(htmlEl.id);
              if (matchesExactly(idSelector, current)) {
                const anchoredSelector = parts.length > 0 ? `${idSelector} > ${parts.join(' > ')}` : idSelector;
                if (matchesExactly(anchoredSelector, el)) return anchoredSelector;
              }
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
            hasReliableValue((el as HTMLElement).id) ? buildIdSelector((el as HTMLElement).id) : null,
            buildAttributeSelector(tag, 'data-testid', el.getAttribute('data-testid')),
            buildAttributeSelector(tag, 'aria-label', el.getAttribute('aria-label')),
            buildAttributeSelector(tag, 'name', el.getAttribute('name')),
            buildAttributeSelector(tag, 'placeholder', el.getAttribute('placeholder')),
          ];

          for (const candidate of attrCandidates) {
            if (candidate && matchesExactly(candidate, el)) return candidate;
          }

          const domPath = buildDomPath(el);
          return domPath;
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

export async function tabsHighlight(
  tabId: number,
  selector: string,
  message?: string,
  durationMs?: number,
): Promise<{
  ok: boolean;
  highlighted?: InteractiveElementInfo;
  durationMs?: number;
  message?: string;
  error?: string;
}> {
  try {
    await ensureTabIsActive(tabId);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'highlight', selector, message, durationMs }],
    });

    return (results?.[0]?.result as {
      ok: boolean;
      highlighted?: InteractiveElementInfo;
      durationMs?: number;
      message?: string;
      error?: string;
    } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to highlight element' };
  }
}

export async function tabsHover(
  tabId: number,
  selector: string,
  message?: string,
  durationMs?: number,
): Promise<{
  ok: boolean;
  hovered?: InteractiveElementInfo;
  durationMs?: number;
  message?: string;
  error?: string;
}> {
  try {
    await ensureTabIsActive(tabId);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: runPageAutomationAction,
      args: [{ kind: 'hover', selector, message, durationMs }],
    });

    return (results?.[0]?.result as {
      ok: boolean;
      hovered?: InteractiveElementInfo;
      durationMs?: number;
      message?: string;
      error?: string;
    } | undefined)
      ?? { ok: false, error: 'No response from tab' };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Failed to hover element' };
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
