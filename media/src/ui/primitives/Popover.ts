// Reusable anchored popover — the shared chrome + behavior for the composer's picker
// popovers (agent type, model). The old hand-rolled pickers each duplicated the same
// open/close recipe (`.hidden` toggle, stopPropagation on the trigger, document
// click-away, window blur, visibilitychange); this primitive owns all of it plus mutual
// exclusion: opening one registered popover closes any other that is open.
//
// Positioning is pure CSS: `.tm-popover` is absolutely positioned relative to this
// wrapper (`.tm-pop-wrap`), anchored above the trigger — the same recipe the old
// `.mode-pop`/`.model-pop` used, now defined once in styles/components/composer.css.

import { el } from '../dom';

export interface PopoverOptions {
  /** Element that toggles the popover on click (aria-expanded is kept in sync). */
  trigger: HTMLElement;
  /** Popover body — built by the caller; the primitive owns it once attached. */
  content: HTMLElement;
  /** Runs after the popover opens (reset the search field, rebuild the list, focus…). */
  onOpen?: () => void;
  /** Runs after the popover closes. */
  onClose?: () => void;
}

export interface PopoverHandle {
  /** Wrapper containing trigger + content — append this into the toolbar row. */
  el: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

// Every live popover — opening one closes the rest (one dropdown visible at a time).
const registry = new Set<PopoverHandle>();

export function createPopover(opts: PopoverOptions): PopoverHandle {
  const { trigger, content } = opts;
  content.classList.add('tm-popover');
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');

  const wrap = el('div', { class: 'tm-pop-wrap' }, trigger, content);
  let open = false;

  const handle: PopoverHandle = {
    el: wrap,
    open() {
      if (open) return;
      registry.forEach((p) => p.close());
      open = true;
      content.classList.add('tm-open');
      trigger.setAttribute('aria-expanded', 'true');
      opts.onOpen?.();
    },
    close() {
      if (!open) return;
      open = false;
      content.classList.remove('tm-open');
      trigger.setAttribute('aria-expanded', 'false');
      opts.onClose?.();
    },
    toggle() {
      if (open) handle.close();
      else handle.open();
    },
    isOpen: () => open,
  };

  registry.add(handle);
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    handle.toggle();
  });
  document.addEventListener('click', (e) => {
    if (open && e.target instanceof Node && !wrap.contains(e.target)) handle.close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) handle.close();
  });
  // Popovers are transient — they never survive the view losing focus (e.g. tab switch).
  window.addEventListener('blur', () => handle.close());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) handle.close();
  });
  return handle;
}
