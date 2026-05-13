import type { BrowserFormFieldPurpose } from '../shared/types';

export interface FormSnapshotControlPriorityInput {
  index: number;
  visible: boolean;
  hidden: boolean;
  disabled: boolean;
  readonly: boolean;
  fillControl: boolean;
  purpose: BrowserFormFieldPurpose;
  tagName: string;
  role: string;
  type?: string;
  hasForm: boolean;
}

function isTextEntryControl(control: FormSnapshotControlPriorityInput): boolean {
  const tagName = control.tagName.toLowerCase();
  const role = control.role.toLowerCase();
  const type = (control.type ?? '').toLowerCase();

  if (tagName === 'textarea') return true;
  if (tagName === 'input') {
    return !['button', 'submit', 'reset', 'hidden', 'file', 'image', 'checkbox', 'radio'].includes(type);
  }

  return ['textbox', 'searchbox'].includes(role);
}

export function getFormSnapshotControlPriority(control: FormSnapshotControlPriorityInput): number {
  let score = 0;

  score += control.visible ? 160 : -80;
  score += control.hidden ? -80 : 80;
  score += control.disabled ? -120 : 40;
  score += control.readonly ? -40 : 20;
  score += control.fillControl ? 220 : -60;
  score += control.hasForm ? 15 : 0;

  if (control.purpose === 'submit') {
    score -= 120;
  } else if (control.purpose !== 'unknown') {
    score += 25;
  }

  if (isTextEntryControl(control)) {
    score += 120;
  } else if (control.fillControl) {
    score += 20;
  }

  return score;
}

export function prioritizeFormSnapshotControls<T extends FormSnapshotControlPriorityInput>(controls: T[]): T[] {
  return controls
    .slice()
    .sort((left, right) => getFormSnapshotControlPriority(right) - getFormSnapshotControlPriority(left) || left.index - right.index);
}