// Generic loading-spinner primitive, covering the three spinner styles already used
// ad hoc across main.css/main.ts:
// - 'glyph' — single rotating-star glyph (Claude-Code-style), today's .agent-spin.
// - 'ring'  — bordered rotating ring, today's .todo-spin / .idx-spinner (same keyframe,
//             `idx-spin`, reused here rather than duplicated).
// - 'dots'  — three staggered bouncing dots, today's .agent-dots.
// New call sites should use this instead of hand-building one of those three again;
// the existing elements keep their own classes for now (see tokens.css's migration note).

export type SpinnerVariant = 'glyph' | 'ring' | 'dots';

export interface SpinnerOptions {
  variant?: SpinnerVariant;
  /** Ring diameter in px (ignored for 'glyph'/'dots'). */
  size?: number;
  className?: string;
}

export function createSpinner(opts: SpinnerOptions = {}): HTMLSpanElement {
  const variant = opts.variant || 'ring';

  if (variant === 'dots') {
    const el = document.createElement('span');
    el.className = ['agent-dots', opts.className].filter(Boolean).join(' ');
    for (let i = 0; i < 3; i++) el.appendChild(document.createElement('span'));
    return el;
  }

  if (variant === 'glyph') {
    const el = document.createElement('span');
    el.className = ['agent-spin', opts.className].filter(Boolean).join(' ');
    return el;
  }

  const el = document.createElement('span');
  el.className = ['tm-spinner-ring', opts.className].filter(Boolean).join(' ');
  if (opts.size) { el.style.width = `${opts.size}px`; el.style.height = `${opts.size}px`; }
  return el;
}
