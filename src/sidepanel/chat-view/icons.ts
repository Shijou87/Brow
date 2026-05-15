export function chevronSvg(expanded: boolean, className = 'tool-steps-chevron'): string {
  return `<svg class="${className}${expanded ? ' rotated' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
}

export function messageCopySvg(): string {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="10" height="10"></rect><path d="M5 15V5h10"></path></svg>';
}

export function messageCopiedSvg(): string {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 13l4 4L19 7"></path></svg>';
}

export function messageCopyFailedSvg(): string {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"></path></svg>';
}

export function checkSvg(): string {
  return `<svg class="tool-step-check" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#5cb582" stroke-width="2"/><path d="M6 10l3 3 5-6" stroke="#5cb582" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function errorSvg(): string {
  return `<svg class="tool-step-error" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="#d86a6a" stroke-width="2"/><path d="M7 7l6 6M13 7l-6 6" stroke="#d86a6a" stroke-width="2" stroke-linecap="round"/></svg>`;
}

export function approvalSvg(): string {
  return `<svg class="tool-step-approval" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8.5" stroke="#e3b341" stroke-width="2"/><path d="M10 5.6v5.1" stroke="#e3b341" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="13.9" r="1" fill="#e3b341"/></svg>`;
}

export function spinnerSvg(): string {
  return `<svg class="tool-step-spinner" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="#5ba8c8" stroke-width="2" stroke-dasharray="38 14" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 10 10" to="360 10 10" dur="0.8s" repeatCount="indefinite"/></circle></svg>`;
}
