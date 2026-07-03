// Stateless DOM helpers extracted from the legacy main.ts (Phase D, PR1).
// Every function here is pure / side-effect-contained with NO closure captures
// on module state — safe to strict-check and import from anywhere in the webview.
// Do NOT add helpers that close over `thread`, `state`, `targets`, etc. here;
// those belong with the rendering/state layer (later Phase D PRs).

/** querySelector shorthand. `root` defaults to `document`. */
export function $(sel: string, root?: ParentNode | null): Element | null {
  return (root || document).querySelector(sel);
}

/** Escape the HTML-significant characters so a string can be safely interpolated. */
export function escapeHtml(s: unknown): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return String(s).replace(/[&<>"]/g, (c) => map[c] ?? c);
}

/**
 * Transient toast tooltip. When `anchor` is given (and reports a rect) it
 * positions the toast just above the anchor (flipping below if there's no
 * room); otherwise it floats centered near the bottom of the viewport.
 * Self-removes after the animation.
 */
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
