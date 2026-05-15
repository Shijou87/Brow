export function cloneHtmlTemplate<T extends HTMLElement = HTMLElement>(html: string): T {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const element = template.content.firstElementChild;
  if (!element) {
    throw new Error('Expected template HTML to contain a root element.');
  }
  return element as T;
}

export function cloneHtmlFragment(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.cloneNode(true) as DocumentFragment;
}

export function getRequiredElement<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Missing required element for selector "${selector}".`);
  }
  return element as T;
}

export function getRequiredSlot<T extends Element = HTMLElement>(
  root: ParentNode,
  slot: string,
): T {
  return getRequiredElement<T>(root, `[data-slot="${slot}"]`);
}

export function getRequiredAction<T extends Element = HTMLElement>(
  root: ParentNode,
  action: string,
): T {
  return getRequiredElement<T>(root, `[data-action="${action}"]`);
}

export function setSlotText(root: ParentNode, slot: string, text: string): void {
  getRequiredSlot(root, slot).textContent = text;
}

export function setSlotHtml(root: ParentNode, slot: string, html: string): void {
  getRequiredSlot(root, slot).innerHTML = html;
}

export function setSlotValue(root: ParentNode, slot: string, value: string): void {
  const input = getRequiredSlot<HTMLInputElement | HTMLTextAreaElement>(root, slot);
  input.value = value;
}

export function toggleHidden(element: HTMLElement, hidden: boolean): void {
  element.style.display = hidden ? 'none' : '';
}

export function removeElement(element: Element | null | undefined): void {
  element?.remove();
}
