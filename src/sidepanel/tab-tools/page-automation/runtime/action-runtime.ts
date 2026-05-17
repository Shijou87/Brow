import { createBaseRuntime } from './base-runtime';
import { createInteractionRuntime } from './interaction-runtime';
import { createSelectorRuntime } from './selector-runtime';
import type { PageAutomationAction } from './types';

export function createPageAutomationActionRuntime() {
  const base = createBaseRuntime();
  const selectors = createSelectorRuntime(base);
  const interactions = createInteractionRuntime(base);
  const dismissPageAutomationOverlay = (delay?: number) => {
    interactions.dismissOverlay(delay);
  };

  async function runPageAutomationAction(action: PageAutomationAction): Promise<unknown> {
    if (action.kind === 'highlight') {
      const resolved = selectors.resolveActionElement(action.selector);
      if (!resolved) {
        return { ok: false, error: `Element not found for selector: ${action.selector}` };
      }
      const { element: el, resolvedSelector } = resolved;

      const plan = interactions.resolveClickPlan(el);
      if (!plan) {
        return { ok: false, error: 'Matched element has no visible highlight target' };
      }

      const durationMs = base.clamp(Math.round(action.durationMs ?? 2200), 600, 10000);
      const message = (action.message ?? `Brow highlighting ${base.describeElement(el)}`).trim();
      await interactions.previewHighlight(
        el,
        message || `Brow highlighting ${base.describeElement(el)}`,
        action.visualSettings,
      );
      interactions.cleanupOverlay(durationMs);

      return {
        ok: true,
        highlighted: base.summarizeElement(resolvedSelector, el),
        durationMs,
        message: message || `Brow highlighting ${base.describeElement(el)}`,
      };
    }

    if (action.kind === 'hover') {
      const resolved = selectors.resolveActionElement(action.selector);
      if (!resolved) {
        return { ok: false, error: `Element not found for selector: ${action.selector}` };
      }
      const { element: el, resolvedSelector } = resolved;

      const initialPlan = interactions.resolveClickPlan(el);
      if (!initialPlan) {
        return { ok: false, error: 'Matched element has no visible hover target' };
      }

      const durationMs = base.clamp(Math.round(action.durationMs ?? 1400), 500, 10000);
      const message = (action.message ?? `Brow hovering ${base.describeElement(el)}`).trim()
        || `Brow hovering ${base.describeElement(el)}`;
      await interactions.previewHover(el, message);
      const finalPlan = interactions.resolveClickPlan(el) ?? initialPlan;
      interactions.dispatchHover(el, finalPlan);
      interactions.cleanupOverlay(durationMs);

      return {
        ok: true,
        hovered: base.summarizeElement(resolvedSelector, el),
        durationMs,
        message,
      };
    }

    if (action.kind === 'click') {
      const resolved = selectors.resolveActionElement(action.selector);
      if (!resolved) {
        return { ok: false, error: `Element not found for selector: ${action.selector}` };
      }
      const { element: el, resolvedSelector } = resolved;

      if ('disabled' in el && Boolean((el as HTMLInputElement).disabled)) {
        return { ok: false, error: 'Matched element is disabled' };
      }

      el.scrollIntoView({ block: 'center', inline: 'center' });
      await base.sleep(120);

      const initialPlan = interactions.resolveClickPlan(el, action.clickPoint);
      if (!initialPlan) {
        return { ok: false, error: 'Matched element has no visible click target' };
      }

      await interactions.previewClick(el, `Brow clicking ${base.describeElement(el)}`, action.visualSettings);
      const finalPlan = interactions.resolveClickPlan(el, action.clickPoint) ?? initialPlan;
      const dispatchPlan = action.clickMode === 'programmatic'
        ? { ...finalPlan, dispatchMode: 'programmatic' as const }
        : finalPlan;
      dispatchPlan.target.focus({ preventScroll: true });
      interactions.dispatchClick(el, dispatchPlan);
      interactions.cleanupOverlay(action.visualSettings?.animatedBrow === true ? 220 : undefined);

      return {
        ok: true,
        clicked: base.summarizeElement(resolvedSelector, el),
      };
    }

    if (action.kind === 'drag') {
      const source = selectors.resolveActionElement(action.sourceSelector);
      if (!source) {
        return { ok: false, error: `Drag source not found for selector: ${action.sourceSelector}` };
      }
      const destination = selectors.resolveActionElement(action.destinationSelector);
      if (!destination) {
        return { ok: false, error: `Drag destination not found for selector: ${action.destinationSelector}` };
      }

      source.element.scrollIntoView({ block: 'center', inline: 'center' });
      destination.element.scrollIntoView({ block: 'center', inline: 'center' });
      await base.sleep(140);

      const sourcePlan = interactions.resolveClickPlan(source.element, action.sourceClickPoint);
      const destinationPlan = interactions.resolveClickPlan(destination.element, action.destinationClickPoint);
      if (!sourcePlan || !destinationPlan) {
        return { ok: false, error: 'Drag source or destination has no visible interaction point' };
      }

      const dataTransfer = typeof DataTransfer === 'function' ? new DataTransfer() : undefined;
      const eventInit = (point: { x: number; y: number }) => ({
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: point.x,
        clientY: point.y,
        screenX: base.toScreenX(point.x),
        screenY: base.toScreenY(point.y),
        button: 0,
        buttons: 1,
        view: window,
      });
      const dispatchDragEvent = (target: HTMLElement, type: string, point: { x: number; y: number }) => {
        let event: Event;
        if (typeof DragEvent === 'function') {
          event = new DragEvent(type, { ...eventInit(point), dataTransfer });
        } else {
          event = new Event(type, { bubbles: true, cancelable: true, composed: true });
          Object.assign(event, eventInit(point));
        }
        if (dataTransfer && !('dataTransfer' in event)) {
          Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
        }
        return target.dispatchEvent(event);
      };
      const dispatchMouse = (target: HTMLElement, type: string, point: { x: number; y: number }, buttons: number) => {
        target.dispatchEvent(new MouseEvent(type, { ...eventInit(point), buttons }));
      };

      await interactions.previewClick(source.element, `Brow dragging ${base.describeElement(source.element)}`);
      const path = action.pointerPath?.length
        ? action.pointerPath
        : [
          sourcePlan.point,
          {
            x: (sourcePlan.point.x + destinationPlan.point.x) / 2,
            y: (sourcePlan.point.y + destinationPlan.point.y) / 2,
          },
          destinationPlan.point,
        ];

      source.element.focus({ preventScroll: true });
      dispatchMouse(sourcePlan.target, 'mousedown', sourcePlan.point, 1);
      dispatchDragEvent(sourcePlan.target, 'dragstart', sourcePlan.point);
      for (const point of path) {
        const hit = document.elementFromPoint(point.x, point.y);
        const target = base.isHTMLElementLike(hit) ? hit : destinationPlan.target;
        dispatchMouse(target, 'mousemove', point, 1);
        dispatchDragEvent(target, 'drag', point);
        await base.sleep(Math.max(20, Math.min(Math.round((action.durationMs ?? 320) / Math.max(path.length, 1)), 160)));
      }
      dispatchDragEvent(destinationPlan.target, 'dragenter', destinationPlan.point);
      dispatchDragEvent(destinationPlan.target, 'dragover', destinationPlan.point);
      dispatchDragEvent(destinationPlan.target, 'drop', destinationPlan.point);
      dispatchDragEvent(sourcePlan.target, 'dragend', destinationPlan.point);
      dispatchMouse(destinationPlan.target, 'mouseup', destinationPlan.point, 0);
      interactions.cleanupOverlay();

      return {
        ok: true,
        dragged: {
          source: base.summarizeElement(source.resolvedSelector, source.element),
          destination: base.summarizeElement(destination.resolvedSelector, destination.element),
          pointerPathLength: path.length,
        },
      };
    }

    if (action.kind === 'scroll') {
      const resolved = action.selector ? selectors.resolveActionElement(action.selector) : null;
      const target = resolved?.element ?? document.scrollingElement ?? document.documentElement;
      const before = {
        scrollLeft: target === document.scrollingElement || target === document.documentElement ? window.scrollX : (target as HTMLElement).scrollLeft,
        scrollTop: target === document.scrollingElement || target === document.documentElement ? window.scrollY : (target as HTMLElement).scrollTop,
      };

      if (typeof action.top === 'number' || typeof action.left === 'number') {
        if (target === document.scrollingElement || target === document.documentElement) {
          window.scrollTo({
            top: typeof action.top === 'number' ? action.top : window.scrollY,
            left: typeof action.left === 'number' ? action.left : window.scrollX,
            behavior: 'auto',
          });
        } else {
          (target as HTMLElement).scrollTo({
            top: typeof action.top === 'number' ? action.top : (target as HTMLElement).scrollTop,
            left: typeof action.left === 'number' ? action.left : (target as HTMLElement).scrollLeft,
            behavior: 'auto',
          });
        }
      } else if (target === document.scrollingElement || target === document.documentElement) {
        window.scrollBy({ left: action.deltaX ?? 0, top: action.deltaY ?? 0, behavior: 'auto' });
      } else {
        (target as HTMLElement).scrollBy({ left: action.deltaX ?? 0, top: action.deltaY ?? 0, behavior: 'auto' });
      }

      await base.sleep(80);
      const after = {
        scrollLeft: target === document.scrollingElement || target === document.documentElement ? window.scrollX : (target as HTMLElement).scrollLeft,
        scrollTop: target === document.scrollingElement || target === document.documentElement ? window.scrollY : (target as HTMLElement).scrollTop,
      };

      return {
        ok: true,
        scrolled: {
          target: resolved
            ? base.summarizeElement(resolved.resolvedSelector, resolved.element)
            : { selector: 'window', tagName: 'window', text: 'window' },
          before,
          after,
        },
      };
    }

    if (action.kind === 'key') {
      const resolved = action.selector ? selectors.resolveActionElement(action.selector) : null;
      const target = resolved?.element ?? (document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
      target.focus?.({ preventScroll: true });

      if (action.text && !action.key) {
        const typeTarget = interactions.findTypeTarget(target);
        if (!typeTarget) return { ok: false, error: 'No typeable target is focused for text insertion' };
        const currentValue = typeTarget instanceof HTMLInputElement || typeTarget instanceof HTMLTextAreaElement
          ? typeTarget.value
          : typeTarget.textContent ?? '';
        await interactions.animateTypeableElementValue(typeTarget, action.text, { startValue: currentValue });
        return {
          ok: true,
          keyed: {
            target: base.summarizeElement(resolved?.resolvedSelector ?? 'activeElement', target),
            insertedTextLength: action.text.length,
          },
        };
      }

      const key = action.key ?? action.text ?? 'Enter';
      const code = action.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
      const eventBase = {
        key,
        code,
        bubbles: true,
        cancelable: true,
        composed: true,
        altKey: Boolean(action.altKey),
        ctrlKey: Boolean(action.ctrlKey),
        metaKey: Boolean(action.metaKey),
        shiftKey: Boolean(action.shiftKey),
      };
      target.dispatchEvent(new KeyboardEvent('keydown', eventBase));
      if (key.length === 1) {
        target.dispatchEvent(new KeyboardEvent('keypress', eventBase));
      }
      if (key === 'Enter') interactions.dispatchEnter(target);
      target.dispatchEvent(new KeyboardEvent('keyup', eventBase));
      return {
        ok: true,
        keyed: {
          target: base.summarizeElement(resolved?.resolvedSelector ?? 'activeElement', target),
          key,
          code,
          modifiers: {
            altKey: Boolean(action.altKey),
            ctrlKey: Boolean(action.ctrlKey),
            metaKey: Boolean(action.metaKey),
            shiftKey: Boolean(action.shiftKey),
          },
        },
      };
    }

    if (action.kind === 'upload') {
      const resolved = selectors.resolveActionElement(action.selector);
      if (!resolved) {
        return { ok: false, error: `Upload control not found for selector: ${action.selector}` };
      }
      const input = resolved.element.tagName.toLowerCase() === 'input'
        ? resolved.element as HTMLInputElement
        : resolved.element.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input || input.type !== 'file') {
        return { ok: false, error: 'Matched element is not a file input or upload control' };
      }
      input.scrollIntoView({ block: 'center', inline: 'center' });
      await interactions.previewClick(input, `Brow opening file picker for ${base.describeElement(input)}`);
      input.click();
      interactions.cleanupOverlay();
      return {
        ok: false,
        helperRequired: true,
        backend: 'local-helper',
        error: 'Native file selection requires the local helper backend. MV3 can open the picker but cannot set a local file path safely.',
        upload: {
          control: base.summarizeElement(resolved.resolvedSelector, input),
          fileName: action.fileName,
          filePath: action.filePath ? '[redacted path]' : undefined,
        },
      };
    }

    if (action.kind === 'handleDialog') {
      const resolved = action.selector ? selectors.resolveActionElement(action.selector) : null;
      const dialog = resolved?.element
        ?? document.querySelector<HTMLElement>('dialog[open], [role="dialog"], [aria-modal="true"]');
      if (!dialog) {
        return {
          ok: false,
          helperRequired: true,
          backend: 'local-helper',
          error: 'No HTML dialog was found. Native browser dialogs require the local helper backend.',
        };
      }

      if (dialog instanceof HTMLDialogElement && action.action !== 'accept') {
        dialog.close(action.text ?? '');
        return { ok: true, dialog: { action: action.action, target: base.summarizeElement(resolved?.resolvedSelector ?? 'dialog[open]', dialog) } };
      }

      const buttonNeedles = action.action === 'dismiss'
        ? ['cancel', 'close', 'dismiss', 'no']
        : ['ok', 'yes', 'accept', 'confirm', 'continue'];
      const buttons = Array.from(dialog.querySelectorAll<HTMLElement>('button, [role="button"], input[type="button"], input[type="submit"]'));
      const button = buttons.find((candidate) => {
        const text = base.normalizeInlineText(candidate.innerText || candidate.getAttribute('aria-label') || candidate.getAttribute('value'));
        return buttonNeedles.some((needle) => text.toLowerCase().includes(needle));
      }) ?? buttons[0];

      if (!button) {
        return { ok: false, error: 'Dialog was found but no actionable dialog control was available' };
      }
      await interactions.previewClick(button, 'Brow handling dialog');
      button.click();
      interactions.cleanupOverlay();
      return {
        ok: true,
        dialog: {
          action: action.action,
          target: base.summarizeElement(resolved?.resolvedSelector ?? 'dialog', dialog),
          control: base.summarizeElement('dialog control', button),
        },
      };
    }

    if (action.kind === 'type') {
      const resolved = selectors.resolveActionElement(action.selector);
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

      const typeTarget = interactions.findTypeTarget(el);
      if (typeTarget) {
        await interactions.previewFieldEdit(
          typeTarget,
          `Brow typing into ${base.describeElement(typeTarget)}`,
          action.visualSettings,
        );
        typeTarget.focus({ preventScroll: true });
        await interactions.animateTypeableElementValue(typeTarget, action.text);
        if (action.submit) {
          interactions.showBadge('Brow submitting input', 16, 16);
          await base.sleep(40);
          interactions.dispatchEnter(typeTarget);
        }
        interactions.cleanupOverlay(action.visualSettings?.animatedBrow === true ? 220 : undefined);
        return {
          ok: true,
          typed: summarize(typeTarget),
          resolvedFrom: typeTarget === el ? undefined : summarize(el),
        };
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
    const successfulFieldElements: HTMLElement[] = [];

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

      const resolvedField = selectors.resolveActionElement(selector);
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

      const mode = interactions.inferMode(el, field.mode);
      const tagName = el.tagName.toLowerCase();
      const type = el instanceof HTMLInputElement ? el.type : undefined;

      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus({ preventScroll: true });

      if (!formForSubmit) {
        const fieldTag = el.tagName.toLowerCase();
        const closestForm = ['input', 'textarea', 'select'].includes(fieldTag)
          ? (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).form
          : el.closest('form');
        if (closestForm && typeof (closestForm as HTMLFormElement).submit === 'function') {
          formForSubmit = closestForm as HTMLFormElement;
        }
      }

      try {
        if (mode === 'text') {
          if (tagName === 'input' || tagName === 'textarea') {
            await interactions.previewFieldEdit(
              el,
              `Brow typing into ${base.describeElement(el)}`,
              action.visualSettings,
            );
            const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
            await interactions.animateTypeableElementValue(inputEl, String(field.value));
            await interactions.commitFilledTextField(inputEl);
            successfulFieldElements.push(inputEl);
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
            await interactions.previewFieldEdit(
              el,
              `Brow typing into ${base.describeElement(el)}`,
              action.visualSettings,
            );
            await interactions.animateTypeableElementValue(el, String(field.value));
            successfulFieldElements.push(el);
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
          if (tagName === 'select') {
            const selectEl = el as HTMLSelectElement;
            const targetValue = String(field.value).trim();
            const options = Array.from(selectEl.options);
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

            await interactions.previewFieldEdit(
              el,
              `Brow selecting ${option.label || option.text}`,
              action.visualSettings,
            );
            selectEl.value = option.value;
            option.selected = true;
            selectEl.dispatchEvent(new Event('input', { bubbles: true }));
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            successfulFieldElements.push(selectEl);
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
          if (tagName === 'input' && (el as HTMLInputElement).type === mode) {
            const inputEl = el as HTMLInputElement;
            const nextChecked = Boolean(field.value);
            await interactions.previewClick(
              el,
              `${nextChecked ? 'Brow selecting' : 'Brow clearing'} ${base.describeElement(el)}`,
              action.visualSettings,
            );
            if (inputEl.checked !== nextChecked) {
              if (nextChecked) {
                inputEl.click();
              }
              if (inputEl.checked !== nextChecked) {
                interactions.setChecked(inputEl, nextChecked);
              }
            }
            successfulFieldElements.push(inputEl);
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
        const resolvedSubmit = selectors.resolveActionElement(action.submitSelector);
        if (resolvedSubmit?.element && base.isHTMLElementLike(resolvedSubmit.element)) {
          const submitEl = resolvedSubmit.element;
          await interactions.previewClick(
            submitEl,
            `Brow submitting ${base.describeElement(submitEl)}`,
            action.visualSettings,
          );
          submitEl.focus({ preventScroll: true });
          submitEl.click();
          submitted = true;
        } else {
          submitError = `Submit element not found for selector: ${action.submitSelector}`;
        }
      } else if (formForSubmit) {
        interactions.showBadge('Brow submitting form', 16, 16);
        window.setTimeout(() => {
          formForSubmit.requestSubmit?.();
          if (!formForSubmit.requestSubmit) formForSubmit.submit();
        }, 30);
        submitted = true;
      } else {
        const inferredSubmit = interactions.inferSubmitControl(successfulFieldElements);
        if (inferredSubmit) {
          await interactions.previewClick(
            inferredSubmit,
            `Brow submitting ${base.describeElement(inferredSubmit)}`,
            action.visualSettings,
          );
          inferredSubmit.focus({ preventScroll: true });
          inferredSubmit.click();
          submitted = true;
        } else {
          submitError = 'No parent form found to submit';
        }
      }
    }

    interactions.cleanupOverlay(action.visualSettings?.animatedBrow === true ? 220 : 1000);

    const hadFieldErrors = results.some((result) => !result.ok);
    const outcome: { ok: boolean; warning?: string; error?: string } = hadFieldErrors
      ? {
        ok: false,
        error: 'One or more form fields could not be filled',
      }
      : Boolean(action.submit || action.submitSelector) && submitError
        ? !submitted && submitError === 'No parent form found to submit'
          ? {
            ok: true,
            warning: submitError,
          }
          : {
            ok: false,
            error: submitError,
          }
        : {
          ok: true,
        };
    return {
      ok: outcome.ok,
      results,
      submitted,
      warning: outcome.warning,
      error: outcome.error,
    };
  }

  return {
    runPageAutomationAction,
    dismissPageAutomationOverlay,
  };
}
