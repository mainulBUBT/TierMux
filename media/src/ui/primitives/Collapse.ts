// Generic <details><summary>…</summary>…</details> factory — the shared shape behind
// .tool-more, .think-block > details, .work, .reasoning, and .work-summary, which each
// currently build this same three-node structure by hand with their own className.
// Stateless, side-effect free — safe to import from anywhere in the webview (see dom.ts).

import { el, appendChildren, type ElChild } from '../dom';

export interface CollapseOptions {
  /** Class name(s) for the <details> element itself — carries the caller's existing
   *  visual styling (e.g. 'tool-more', 'think-block'); this factory adds no styling of
   *  its own beyond the plain element structure. */
  className?: string;
  summary: ElChild;
  body?: ElChild;
  open?: boolean;
}

export function createCollapse(opts: CollapseOptions): HTMLDetailsElement {
  const det = el('details', opts.className ? { class: opts.className } : null);
  if (opts.open) det.open = true;

  const sum = el('summary', null, opts.summary);
  det.appendChild(sum);

  appendChildren(det, [opts.body]);
  return det;
}
