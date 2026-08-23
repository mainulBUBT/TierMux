# DESIGN.md — Neutral Pro

A restrained, product-grade default for a project that has no design system yet. One accent,
neutral everything else, generous spacing. Chosen because it reads as deliberate in both light
and dark, and because every value below is concrete — there is nothing here to derive.

## 1. Visual theme
Calm and dense-but-breathable, closer to Linear/Stripe than to a marketing template. Content
first: colour carries meaning (state, action), never decoration. No gradients, no glassmorphism,
no coloured drop shadows.

## 2. Colour palette & roles
Define these once at `:root`, then reference only the token names.

**Light (base)**
- `--bg` → `#ffffff` — page background
- `--surface` → `#f7f7f8` — cards, panels, inset areas
- `--border` → `#e4e4e7` — 1px dividers and control outlines
- `--text` → `#18181b` — body copy
- `--text-muted` → `#71717a` — secondary copy, captions, placeholders
- `--accent` → `#2563eb` — primary action, links, focus ring
- `--accent-hover` → `#1d4ed8`
- `--accent-fg` → `#ffffff` — text on accent
- `--danger` → `#dc2626`
- `--success` → `#16a34a`

**Dark (override under `prefers-color-scheme: dark` and/or `[data-theme="dark"]`)**
- `--bg` → `#09090b`
- `--surface` → `#18181b`
- `--border` → `#27272a`
- `--text` → `#fafafa`
- `--text-muted` → `#a1a1aa`
- `--accent` → `#3b82f6`
- `--accent-hover` → `#60a5fa`

Body text against `--bg` clears 4.5:1 in both themes. Keep it that way if you change anything.

## 3. Typography
- `--font-sans` → `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
- `--font-mono` → `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`
- Scale: `12 / 13 / 14 / 16 / 20 / 24 / 32` px. Body is 14 or 16, never below 13.
- Weights: 400 body, 500 UI labels, 600 headings. No 700+ except a hero.
- Body `line-height: 1.5`; headings `1.25`. Never all-caps body text.
- Two families maximum — sans and mono. That is the whole type system.

## 4. Spacing scale
- `--space-1` → `4px`
- `--space-2` → `8px`
- `--space-3` → `12px`
- `--space-4` → `16px`
- `--space-6` → `24px`
- `--space-8` → `32px`
- `--space-12` → `48px`
Compose with flex/grid `gap`. Section padding 24–32px; card padding 16–20px. Readable text
column caps at `--measure` → `68ch`.

## 5. Radius & elevation
- `--radius-sm` → `4px` (inputs, chips)
- `--radius` → `8px` (buttons, cards)
- `--radius-lg` → `12px` (modals, panels)
- `--shadow-sm` → `0 1px 2px rgba(0,0,0,.06)`
- `--shadow` → `0 4px 12px rgba(0,0,0,.08)`
Elevation is carried by `--border` first and shadow second. Never both at full strength.

## 6. Component stylings
- **Button (primary)** — `--accent` bg, `--accent-fg` text, `--radius`, padding `8px 14px`,
  weight 500. Hover `--accent-hover`. Active: same bg, no transform. Disabled: 50% opacity,
  `cursor: not-allowed`.
- **Button (secondary)** — transparent bg, 1px `--border`, `--text`. Hover: `--surface` bg.
- **Input** — `--surface` bg, 1px `--border`, `--radius-sm`, padding `8px 10px`. Focus:
  `--accent` border plus the focus ring below.
- **Card** — `--surface` bg, 1px `--border`, `--radius`, padding `--space-4`.
- **Focus ring (every focusable element)** — `outline: 2px solid var(--accent);
  outline-offset: 2px;` on `:focus-visible`. Never `outline: none` without a replacement.

## 7. Motion
`--ease` → `cubic-bezier(.2,0,0,1)`, duration 120–200ms, on colour/opacity/transform only.
Hover and expand transitions only. Respect `prefers-reduced-motion: reduce`.

## 8. Responsive behaviour
- Breakpoints: `640px`, `768px`, `1024px`, `1280px`. Do not invent a fifth.
- Touch targets ≥ 44×44px below 768px.
- Multi-column layouts collapse to one column at 768px, in source order.
- Long strings get `overflow-wrap: anywhere`; wide tables and code scroll inside their own
  `overflow-x: auto` container so the page body never scrolls sideways.

## 9. Do's and don'ts
- DO define the tokens above once, then reference only token names below that block.
- DO handle overflow, empty, loading and error states — an unhandled empty state is the single
  most common tell of AI-generated UI.
- DON'T hard-code a hex or px value that a token above already covers.
- DON'T add a CSS framework, UI library, icon pack, web font or CDN link to solve a styling
  problem. Style with what the project already has.
- DON'T use more than one accent colour, one spacing scale, or two type families.
- DON'T animate anything the user did not trigger.
