// Generic bordered panel primitive — the shared shape behind .cmd-approval, .clarify,
// .todo-list, and .watchdog-card, which today each redefine the same border + radius +
// background + padding rules (and often a title/body/footer split) under their own
// class name. New boxed-panel UI should build on this; existing panels migrate to it
// opportunistically (see tokens.css's migration note).
//
// Encapsulates the title/body/footer layout and the collapsible variant itself, rather
// than just returning a styled empty <div> — a caller building a card from scratch
// shouldn't have to re-derive that structure every time.

import { el, type ElChild } from '../dom';
import { createCollapse } from './Collapse';

export type CardVariant = 'default' | 'accent' | 'success' | 'error';

export interface CardOptions {
  className?: string;
  variant?: CardVariant;
  title?: ElChild;
  body?: ElChild;
  footer?: ElChild;
  /** Renders as a <details>/<summary> — `title` becomes the summary, `body`/`footer`
   *  collapse underneath it (see ui/primitives/Collapse.ts). */
  collapsible?: boolean;
  open?: boolean;
}

export function createCard(opts: CardOptions = {}): HTMLElement {
  const variant = opts.variant && opts.variant !== 'default' ? `tm-card-${opts.variant}` : undefined;
  const className = ['tm-card', variant, opts.collapsible && 'tm-card-collapsible', opts.className].filter(Boolean).join(' ');

  if (opts.collapsible) {
    const body = el('div', { class: 'tm-card-body' }, opts.body, opts.footer && el('div', { class: 'tm-card-footer' }, opts.footer));
    return createCollapse({ className, summary: opts.title ?? '', body, open: opts.open });
  }

  return el('div', { class: className },
    opts.title != null && el('div', { class: 'tm-card-title' }, opts.title),
    opts.body != null && el('div', { class: 'tm-card-body' }, opts.body),
    opts.footer != null && el('div', { class: 'tm-card-footer' }, opts.footer),
  );
}
