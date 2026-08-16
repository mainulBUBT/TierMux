---
description: Build or restyle UI to a modern, consistent design system, reusing the project's existing tokens
triggers: restyle, design system, make it look, looks ugly, looks bad, look better, ui polish, polish the ui, style the, styling, css, dark mode, light mode, responsive, spacing, hover state, focus state, design the
---
UI/design task. Produce real edits that look like a professionally designed product, not a default-styled prototype. Work in this order and do not skip step 1.

STEP 1 — LOOK BEFORE YOU STYLE (tools first, always)
- Read the file(s) you are about to change. Never write styles for markup you have not read.
- Grep for an existing design system before inventing anything: CSS custom properties (`--*`), a theme/tokens file, `tailwind.config.*`, a styled-components theme, or the host's own variables (e.g. `--vscode-*` in a VS Code webview).
- If tokens exist, reuse and extend them. A second parallel palette is a defect, not a style choice.
- If none exist, define one small token block once (color, spacing, radius, font), then reference only tokens below it.

STEP 2 — PICK THE RIGHT MODE
- Restyling working UI → keep the existing structure, class names, and layout. Change values, not architecture. The user wants it to look better, not to be rebuilt.
- Building new UI → match the patterns already in the codebase (same component style, same token names, same file layout) so it does not read as bolted on.
- Unsure which → restyle. Rebuilding working UI you were not asked to rebuild is the most expensive mistake here.

STEP 3 — THE RULES
- Spacing: one 4/8px scale. Generous padding, clear grouping, no cramped edges. Whitespace is a feature.
- Type: max 2 families. Hierarchy from size/weight (13/14/16/20/24), body line-height ≥ 1.4. Never all-caps body text.
- Color: one accent; neutrals for everything else. Body text contrast ≥ 4.5:1. Secondary text muted, never gray-on-gray.
- Depth: subtle — 6–12px radii, 1px low-contrast borders, small shadows. No heavy drop shadows, no gradients unless the product already uses them.
- States: every interactive element needs hover, focus-visible, active, and disabled. Focus rings must stay visible — keyboard users are not optional.
- Motion: 120–200ms ease, on hover/expand only. No gratuitous animation.
- Theming: derive every color from theme variables when the host has them. Never assume a background color; light and dark must both work.

STEP 4 — LAYOUT
- Flex/grid with `gap`. No margin hacks.
- Consistent left edges, equal gutters, one max-width for readable text.
- Handle the ugly cases: overflow (ellipsis or scroll inside its own container), long unbroken strings, empty states, loading states.

NEVER
- Never add a CSS framework, UI library, icon pack, web font, or CDN link to solve a styling problem. Style with what the project already has.
- Never hard-code a hex or px value that an existing token already covers.
- Never restructure markup, rename classes, or drop features as a side effect of restyling.
- Never describe the design instead of implementing it — make the edits.

BEFORE YOU FINISH
Re-read your own diff and answer: one spacing scale? one accent? tokens instead of literals? hover and focus-visible on every interactive element? theme-safe colors? no new dependency? structure unchanged (if restyling)? Fix anything that answers no. Then state plainly what you changed and what you deliberately left alone.

Task (if nothing follows this line, ask what to design instead of guessing):
