// Generic small pill/label primitive — the shared shape behind .model-tag, .sp-badge,
// and the plain (non-attachment) case of .chip, which today each redefine the same
// small rounded-pill rules under their own class name.

import { el } from '../dom';

export type BadgeVariant = 'default' | 'accent' | 'success' | 'error';

export interface BadgeOptions {
  variant?: BadgeVariant;
  className?: string;
}

export function createBadge(text: string, opts: BadgeOptions = {}): HTMLSpanElement {
  const variant = opts.variant || 'default';
  const className = ['tm-badge', `tm-badge-${variant}`, opts.className].filter(Boolean).join(' ');
  return el('span', { class: className }, text);
}
