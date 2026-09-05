---
description: Build or restyle UI to a modern, consistent design system, reusing the project's existing tokens
---
UI/design task. Produce real edits that look like a professionally designed product, not a default-styled prototype.

STEP 1 — FIND THE PROJECT'S DESIGN SYSTEM FIRST
- Before writing any styles, grep for the project's existing tokens: CSS custom properties (`--color-`, `--space-`, `--radius-`), a Tailwind config, a theme file, or the main stylesheet's `:root` block. Those values are the answer to "what colour / what spacing / what radius" — do not decide those yourself.
- Read the file(s) you are about to change before writing any styles. Never style markup you have not read.
- If tokens exist, reuse and extend them. A second parallel palette is a defect, not a style choice.
- If the project has no tokens at all, define one small token block once in its main stylesheet (one accent, one neutral scale, one spacing scale, one radius) and reference only tokens below it.

STEP 2 — PICK THE RIGHT MODE
- Restyling working UI → keep the existing structure, class names, and layout. Change values, not architecture. The user wants it to look better, not to be rebuilt.
- Building new UI → match the patterns already in the codebase (same component style, same token names, same file layout) so it does not read as bolted on.
- Unsure which → restyle. Rebuilding working UI you were not asked to rebuild is the most expensive mistake here.

STEP 3 — COPY THE STATES, DON'T INVENT THEM
Read `design/references/preview.html` (relative to this skill's directory) before you write component CSS. It is a plain, framework-free catalogue of the states real UI has and generated UI usually misses. Reproduce its patterns with THIS project's tokens — not its placeholder values.
- Every interactive element: hover, focus-visible, active, disabled. Focus rings stay visible; keyboard users are not optional.
- Every list or async area: empty, loading, and error states. An unhandled empty state is the clearest tell of AI-generated UI.
- Every text container: overflow handled (ellipsis with `min-width: 0`, wrapping, or scroll inside its own container) and long unbroken strings survive.

STEP 4 — LAYOUT
- Flex/grid with `gap`. No margin hacks.
- Consistent left edges, equal gutters, one max-width for readable text.
- Collapse to a single column at the design system's own breakpoint, in source order.
- Hierarchy from size, weight and spacing — not from more colours.

NEVER
- Never add a CSS framework, UI library, icon pack, web font, or CDN link to solve a styling problem. Style with what the project already has.
- Never hard-code a hex or px value that a token in the design system already covers.
- Never restructure markup, rename classes, or drop features as a side effect of restyling.
- Never describe the design instead of implementing it — make the edits.

BEFORE YOU FINISH
Re-read your own diff and answer: tokens instead of literals? one accent? one spacing scale? hover and focus-visible on every interactive element? empty/loading/error handled? both themes work? no new dependency? structure unchanged (if restyling)? Fix anything that answers no. Then state plainly what you changed and what you deliberately left alone.

Task (if nothing follows this line, ask what to design instead of guessing):
