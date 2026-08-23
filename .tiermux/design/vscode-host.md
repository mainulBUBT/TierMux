# DESIGN.md — VS Code Host

This project renders inside VS Code (webview, panel, or editor UI). The user's colour theme is
the design system — the extension's job is to inherit it exactly, not to paint over it. An
extension that looks like itself instead of like the editor reads as broken.

## 1. Visual theme
Native, quiet, dense. It should be impossible to tell where the editor's chrome ends and this UI
begins. No brand colours, no gradients, no custom shadows, no rounded-everything.

## 2. Colour palette & roles
Never write a literal colour. Every colour is a `--vscode-*` theme variable, so light, dark and
high-contrast themes all work with no extra code.

- Page background → `var(--vscode-sideBar-background)` (view) or `var(--vscode-editor-background)` (editor)
- Body text → `var(--vscode-foreground)`
- Muted text → `var(--vscode-descriptionForeground)`
- Error text → `var(--vscode-errorForeground)`
- Borders / dividers → `var(--vscode-panel-border)` or `var(--vscode-widget-border)`
- Accent / links → `var(--vscode-textLink-foreground)`, hover `var(--vscode-textLink-activeForeground)`
- Primary button → bg `var(--vscode-button-background)`, text `var(--vscode-button-foreground)`,
  hover `var(--vscode-button-hoverBackground)`
- Secondary button → `var(--vscode-button-secondaryBackground)` / `…-secondaryForeground`
- Input → bg `var(--vscode-input-background)`, text `var(--vscode-input-foreground)`,
  border `var(--vscode-input-border)`, placeholder `var(--vscode-input-placeholderForeground)`
- List row hover → `var(--vscode-list-hoverBackground)`; selected → `var(--vscode-list-activeSelectionBackground)`
- Inline code / pre → `var(--vscode-textCodeBlock-background)`
- Badge → `var(--vscode-badge-background)` / `var(--vscode-badge-foreground)`
- Focus ring → `var(--vscode-focusBorder)`

If a needed role has no variable, derive it with `color-mix(in srgb, var(--vscode-foreground) 12%, transparent)`
rather than picking a hex.

## 3. Typography
- Body → `var(--vscode-font-family)` at `var(--vscode-font-size)`. Do not override the size;
  the user chose it.
- Code → `var(--vscode-editor-font-family)` at `var(--vscode-editor-font-size)`.
- Hierarchy from weight (400/600) and spacing, not from new sizes or families.
- No web fonts. Ever — a webview has no business downloading a typeface.

## 4. Spacing scale
`4 / 8 / 12 / 16 / 24` px, on a 4px grid. VS Code UI is dense: 8px is the common gap, 12–16px is
container padding. Anything above 24px looks like a different application.

## 5. Radius & elevation
- Radius `2px` for inputs and buttons, `4px` for cards and popovers. Nothing larger.
- No shadows except on a genuinely floating layer (dropdown, hover card), and then
  `var(--vscode-widget-shadow)`.
- Separation comes from `var(--vscode-panel-border)` and background steps, not elevation.

## 6. Component stylings
- **Button** — 2px radius, `4px 12px` padding, no border, theme bg/fg as above. Hover swaps to
  the hover variable only; no transform, no scale.
- **Input** — full-width, 2px radius, `4px 8px` padding, 1px `--vscode-input-border`.
- **List row** — 4–6px vertical padding, full-bleed hover background, no internal borders.
- **Icons** — use the bundled Codicon set already in the project. Never add an icon pack.
- **Focus** — `outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;` on
  `:focus-visible`. Keyboard navigation is a first-class path in VS Code.

## 7. Motion
Effectively none. Colour transitions up to 100ms; no entrance animations, no easing curves the
editor itself does not use.

## 8. Responsive behaviour
A sidebar view can be dragged to ~170px wide and to full editor width. Every layout must survive
both: single column, `min-width: 0` on flex children, text truncates with ellipsis or wraps, and
wide content (tables, code) scrolls inside its own container. Never rely on a fixed pixel width.

## 9. Do's and don'ts
- DO check the result in a light theme, a dark theme AND a high-contrast theme.
- DO let the container size the UI; the panel width is not yours to choose.
- DON'T hard-code any colour, including "just" a border or a shadow.
- DON'T set `font-family`, `font-size`, or a fixed line-height on body text.
- DON'T add a CSS framework, UI library, icon pack, web font or CDN link.
- DON'T use `outline: none` without an immediate replacement focus style.
