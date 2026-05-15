import type { PageAutomationBaseRuntime } from './base-runtime';

export interface ResolvedActionElement {
  element: HTMLElement;
  resolvedSelector: string;
}

export interface PageAutomationSelectorRuntime {
  resolveActionElement(selector: string): ResolvedActionElement | null;
}

export function createSelectorRuntime(
  base: PageAutomationBaseRuntime,
): PageAutomationSelectorRuntime {
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
      const matches = Array.from(document.querySelectorAll(selector))
        .filter((match): match is HTMLElement => match instanceof HTMLElement);
      return matches.find((match) => base.isElementVisible(match)) ?? matches[0] ?? null;
    } catch {
      return null;
    }
  };

  const tryQueryUniqueElement = (selector: string): HTMLElement | null => {
    try {
      const matches = Array.from(document.querySelectorAll(selector))
        .filter((match): match is HTMLElement => match instanceof HTMLElement)
        .filter((match) => base.isElementVisible(match));
      if (matches.length !== 1) return null;
      return matches[0];
    } catch {
      return null;
    }
  };

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
    const normalizedNeedle = base.normalizeInlineText(needle).toLowerCase();
    const text = base.normalizeInlineText(
      el.innerText
      || el.textContent
      || el.getAttribute('aria-label')
      || el.getAttribute('title')
      || el.getAttribute('placeholder')
      || el.getAttribute('name'),
    );
    const normalizedText = text.toLowerCase();
    const rect = base.getVisibleRect(el);
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
    const needle = base.normalizeInlineText(unquoteSelectorText(segment.slice(index + token.length, cursor)));
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
  ): ResolvedActionElement | null => {
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
        if (!base.isElementVisible(candidate)) return false;
        const text = collectTextMatchMetadata(candidate, needle).normalizedText;
        return text.includes(base.normalizeInlineText(needle).toLowerCase());
      });

      for (const baseMatch of baseMatches) {
        const relatedTargets = resolveRelativeTextTargets(baseMatch, suffixSelector)
          .filter((target) => base.isElementVisible(target));
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

  const querySimpleLocator = (
    selector: string,
    requireUnique = false,
  ): ResolvedActionElement | null => {
    const parsed = (() => {
      const match = selector.match(/^\s*(text|heading|title|placeholder|link|button|textbox)\s*(?:=|:)\s*(.+?)\s*$/i);
      if (!match) return null;

      const kind = match[1].toLowerCase();
      const needle = base.normalizeInlineText(unquoteSelectorText(match[2]));
      if (!needle) return null;

      return { kind, needle };
    })();
    if (!parsed) return null;

    const baseSelectors = (() => {
      if (parsed.kind === 'heading') return ['h1, h2, h3, h4, h5, h6, [role="heading"]'];
      if (parsed.kind === 'title') return ['[title]'];
      if (parsed.kind === 'placeholder') return ['[placeholder]'];
      if (parsed.kind === 'link') return ['a[href], [role="link"]'];
      if (parsed.kind === 'button') {
        return ['button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]'];
      }
      if (parsed.kind === 'textbox') {
        return ['input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]'];
      }
      return ['a, button, input, textarea, select, label, summary, h1, h2, h3, h4, h5, h6, p, span, div, li, dt, dd, article, section, [role="button"], [role="link"], [role="heading"], [title], [placeholder], [aria-label]'];
    })();

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
  ): ResolvedActionElement | null => {
    const matches: ResolvedActionElement[] = [];

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
  ): ResolvedActionElement | null => {
    const simpleLocatorMatch = querySimpleLocator(selector, requireUnique);
    if (simpleLocatorMatch) return simpleLocatorMatch;

    const segments = splitSelectorList(selector);
    const matches: ResolvedActionElement[] = [];

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
    || /\[\s*(id|data-testid|data-test|aria-label|title|name|placeholder)\s*=/.test(part)
  );

  const extractStableAttributeSelectors = (part: string): string[] => {
    const selectors: string[] = [];
    const seen = new Set<string>();
    const push = (candidate: string) => {
      if (!candidate || seen.has(candidate)) return;
      seen.add(candidate);
      selectors.push(candidate);
    };
    const stableAttrs = [
      'aria-label',
      'title',
      'placeholder',
      'name',
      'data-testid',
      'data-test',
      'id',
    ];
    const attrPattern = /\[\s*([a-zA-Z_:-][\w:.-]*)\s*=\s*(["'])((?:\\.|(?!\2).)*)\2\s*\]/g;
    let match: RegExpExecArray | null;

    while ((match = attrPattern.exec(part)) !== null) {
      const attrName = match[1];
      if (!stableAttrs.includes(attrName)) continue;
      const attrValue = match[3];
      const selector = `[${attrName}="${attrValue}"]`;
      push(selector);
      if (attrName === 'aria-label' || attrName === 'title') {
        push(`text="${attrValue.replace(/\\"/g, '"')}"`);
      }
      if (attrName === 'placeholder') {
        push(`placeholder="${attrValue.replace(/\\"/g, '"')}"`);
      }
    }

    return selectors;
  };

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
      for (const attributeSelector of extractStableAttributeSelectors(part)) {
        push(attributeSelector);
      }
    }

    return candidates;
  };

  const resolveActionElement = (selector: string): ResolvedActionElement | null => {
    const refElement = base.resolveBrowRefElement(selector);
    if (refElement && base.isElementVisible(refElement)) {
      return { element: refElement, resolvedSelector: selector };
    }

    const direct = queryExtendedElement(selector);
    if (direct) {
      return direct;
    }

    for (const candidate of buildSelectorRecoveryCandidates(selector)) {
      const recovered = queryExtendedElement(candidate, true);
      if (recovered && base.isElementVisible(recovered.element)) {
        return recovered;
      }
    }

    return null;
  };

  return {
    resolveActionElement,
  };
}
