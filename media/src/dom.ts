// Stateless DOM helpers — pure, no closures over module state. Anything that needs `thread`,
// `state` or `targets` belongs with the rendering layer, not here.

/** querySelector shorthand. `root` defaults to `document`. */
export function $(sel: string, root?: ParentNode | null): Element | null {
  return (root || document).querySelector(sel);
}

/** Escape the HTML-significant characters so a string can be safely interpolated. */
export function escapeHtml(s: unknown): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return String(s).replace(/[&<>"]/g, (c) => map[c] ?? c);
}

/** Transient toast: above `anchor` when given (flipping below if no room), else centred near
 *  the bottom. Self-removes after the animation. */
export function showToast(text: string, anchor?: HTMLElement | null): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  const r = anchor && typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null;
  if (r) {
    const tw = t.offsetWidth, th = t.offsetHeight;
    let left = Math.max(6, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 6));
    let top = r.top - th - 6;            // prefer just above the button
    if (top < 6) top = r.bottom + 6;     // flip below if there's no room above
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  } else {
    t.style.left = '50%';
    t.style.bottom = '64px';
    t.style.transform = 'translateX(-50%)';
  }
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 200); }, 1400);
}
