// Minimal hyperscript-style element builder for ui/** components — cuts down the
// `const x = document.createElement(...); x.className = ...; x.append(...)` repetition
// that would otherwise recur in every new primitive/component.
//
// Distinct from the top-level media/src/dom.ts (which holds `$`/escapeHtml/showToast,
// generic helpers used by main.ts directly): this one is specifically the DOM-building
// primitive for the ui/** layer. Stateless, no closure captures — safe to import from
// anywhere in the webview.

export type ElChild = Node | string | number | null | undefined | false;

export interface ElProps {
  /** CSS class name(s) — named `class` (not `className`) to match the `el("div", {class:
   *  "tm-card"})` hyperscript convention, not the DOM property name. */
  class?: string;
  dataset?: Record<string, string>;
  /** Any other prop is either an event handler (`onClick`, `onInput`, …, matched by a
   *  leading "on" + function value) or set via setAttribute. */
  [attr: string]: unknown;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps | null,
  ...children: ElChild[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value as Record<string, string>);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  appendChildren(node, children);
  return node;
}

/** Append a mix of Nodes/strings/falsy-skips to an existing element — the same child
 *  handling `el()` does, exposed separately for primitives that build up children across
 *  more than one call (e.g. a collapsible card appending its body after construction). */
export function appendChildren(node: Element, children: ElChild[]): void {
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
}
