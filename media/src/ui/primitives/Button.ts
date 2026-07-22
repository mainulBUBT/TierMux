// Generic icon button primitive — matches the existing .icon-btn pattern (transparent
// background, hover highlight, inline SVG icon from icons.ts) used throughout the header,
// composer toolbar, and message footer actions, so new call sites don't hand-roll the
// same button + innerHTML wiring again.

export interface ButtonOptions {
  /** Raw SVG markup string, e.g. from ICON.* in icons.ts. */
  icon?: string;
  /** Visible text label, shown after the icon if both are given. */
  label?: string;
  /** Tooltip — wired via the existing [data-tooltip] CSS pattern, not the native title
   *  attribute (see dom.ts's showToast comment: native title isn't rendered by some
   *  webview hosts). */
  tooltip?: string;
  className?: string;
  onClick?: (e: MouseEvent) => void;
}

export function createButton(opts: ButtonOptions = {}): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = ['icon-btn', opts.className].filter(Boolean).join(' ');
  btn.type = 'button';
  if (opts.tooltip) btn.setAttribute('data-tooltip', opts.tooltip);
  if (opts.icon) btn.insertAdjacentHTML('beforeend', opts.icon);
  if (opts.label) {
    const span = document.createElement('span');
    span.textContent = opts.label;
    btn.appendChild(span);
  }
  if (opts.onClick) btn.addEventListener('click', opts.onClick);
  return btn;
}
