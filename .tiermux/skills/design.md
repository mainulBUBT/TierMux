---
description: Build or restyle UI with a modern, consistent design system
---
You are doing UI/design work. Follow these rules strictly — the result must look like a modern, professionally designed product, not a default-styled prototype.

FOUNDATION (do this before writing any styles):
- Reuse the project's existing design tokens/variables (colors, spacing, radii, fonts) if any exist — grep for CSS variables, a theme file, or a tailwind config FIRST. Extend them; never invent a parallel palette.
- If no tokens exist, define them once at the top (CSS custom properties or theme object) and reference only tokens in components. No hard-coded hex/px scattered in markup.

VISUAL RULES:
- Spacing: use a consistent scale (4/8px steps). Whitespace is a feature — generous padding, clear grouping, no cramped edges.
- Type: max 2 font families; establish hierarchy with size/weight (e.g. 13/14/16/20/24), line-height ≥1.4 for body. Never all-caps body text.
- Color: one accent color, neutral grays for everything else. Text contrast ≥4.5:1. Muted secondary text, not pure gray-on-gray.
- Depth: subtle — small shadows, 6–12px radii, 1px borders in a low-contrast neutral. No heavy drop shadows, no gradients unless the product already uses them.
- States: every interactive element gets hover, focus-visible, active, and disabled styles. Focus rings must be visible (keyboard a11y).
- Motion: 120–200ms ease transitions on hover/expand only. No gratuitous animation.
- Dark/light: if the host supports themes (e.g. VS Code webview), derive every color from theme variables so both modes work — never assume a background color.

LAYOUT:
- Flexbox/grid with gap — no margin-hack layouts. Content must handle overflow (ellipsis or scroll within its own container), long strings, and empty states.
- Align to a grid: consistent left edges, equal gutters, one max-width for readable content.

QUALITY BAR:
- Before finishing, re-read the rendered structure and check: consistent spacing scale? single accent? visible focus? theme-safe colors? If any answer is no, fix it.
- Keep the existing layout/structure when modifying working UI — restyle minimally and invisibly unless a redesign was explicitly requested.

Task:
