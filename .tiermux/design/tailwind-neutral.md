# DESIGN.md — Tailwind Neutral

This project uses Tailwind. The design system is `tailwind.config.*` plus the class vocabulary —
extend the config when something is missing, never reach for an arbitrary value.

## 1. Visual theme
Restrained product UI: neutral surfaces, one accent, generous whitespace. Deliberate rather than
decorated. No gradients, no glass, no coloured shadows.

## 2. Colour palette & roles
Use semantic classes backed by the config, not raw palette names scattered through markup.

- Page background → `bg-white dark:bg-zinc-950`
- Surface / card → `bg-zinc-50 dark:bg-zinc-900`
- Border → `border-zinc-200 dark:border-zinc-800`
- Body text → `text-zinc-900 dark:text-zinc-50`
- Muted text → `text-zinc-500 dark:text-zinc-400`
- Accent (actions, links, focus) → `blue-600`, hover `blue-700`, dark `blue-500`
- Danger → `red-600` · Success → `green-600`

One accent for the whole product. If the config already defines `primary`/`brand`, use that
instead of `blue` and ignore this section's literal names.

## 3. Typography
- Sans → the config's `fontFamily.sans` (default `ui-sans-serif, system-ui, …`); mono → `fontFamily.mono`.
- Scale: `text-xs / text-sm / text-base / text-lg / text-xl / text-2xl`. Body is `text-sm` in
  dense UI, `text-base` in content.
- Weights: `font-normal` body, `font-medium` labels, `font-semibold` headings. Skip `font-bold`
  outside a hero.
- `leading-relaxed` for prose, `leading-tight` for headings. Cap prose at `max-w-prose`.
- Two families total. No web font unless the project already loads one.

## 4. Spacing scale
Tailwind's own 4px scale: `1 / 2 / 3 / 4 / 6 / 8 / 12`. Lay out with `flex`/`grid` plus `gap-*` —
never `space-y-*` stacked on top of per-child margins. Section padding `p-6`–`p-8`, card `p-4`–`p-5`.

## 5. Radius & elevation
- `rounded` (4px) inputs and chips, `rounded-lg` (8px) buttons and cards, `rounded-xl` panels.
- `shadow-sm` for resting cards, `shadow-md` only for genuinely floating layers.
- Prefer a `border` over a shadow for separation. Never both at full strength.

## 6. Component stylings
- **Button (primary)** — `inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2
  text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50
  disabled:cursor-not-allowed`
- **Button (secondary)** — `… border border-zinc-200 bg-transparent text-zinc-900
  hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-900`
- **Input** — `w-full rounded border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-sm
  placeholder:text-zinc-400 dark:…`
- **Card** — `rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:…`
- **Focus (every interactive element)** — `focus-visible:outline-none focus-visible:ring-2
  focus-visible:ring-blue-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-950`

## 7. Motion
`transition-colors duration-150` on hover states. No entrance animations. Honour
`motion-reduce:transition-none`.

## 8. Responsive behaviour
- Mobile-first: write the base classes for small screens, add `sm: md: lg:` upward.
- Breakpoints are the config's defaults — do not add one.
- Touch targets ≥ 44px (`min-h-11`) on mobile.
- Grids collapse to a single column below `md`. Tables and code get `overflow-x-auto` on a
  wrapper so the page never scrolls sideways.

## 9. Do's and don'ts
- DO extend `tailwind.config.*` when a value is missing, then use the generated class.
- DO build every state: hover, focus-visible, active, disabled, empty, loading, error.
- DON'T use arbitrary values (`bg-[#3b82f6]`, `p-[13px]`) for anything the scale covers.
- DON'T add a component library, icon pack, web font or CDN link to solve a styling problem.
- DON'T repeat a long class string across files — extract a component instead.
- DON'T mix `dark:` variants with a second theming mechanism; pick the one already in use.
