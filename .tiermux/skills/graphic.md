---
description: Make a banner, OG/social image, poster, card, thumbnail or diagram as a PNG (HTML/SVG rendered with renderImage)
---
Graphic task. The deliverable is a PNG file in the workspace, made by writing HTML/CSS or SVG and rendering it with the renderImage tool. Text and layout graphics come out sharper, editable and on-brand this way; an image model is only for photos and illustrations, which renderImage cannot make — for those use the generateImage tool (never fake them with shapes), and keep text and logos out of its prompt: put them on top with renderImage (`<img src>` the generated file) instead.

STEP 1 — SIZE AND BRAND FIRST
- Canvas size from the destination, unless the user gave one:
  OG / link preview 1200×630 · X/Twitter post 1600×900 · LinkedIn post 1200×627 · Instagram square 1080×1080 · Instagram story 1080×1920 · YouTube thumbnail 1280×720 · X header 1500×500 · LinkedIn banner 1584×396 · GitHub social preview 1280×640 · favicon/app icon 512×512 (transparent).
- Find the project's brand before choosing anything: logo files (`assets/`, `public/`, `media/`, `*.svg`), colour tokens (`:root` custom properties, Tailwind config, theme file), the font the site uses. Reuse them; a graphic in someone else's colours is a defect.
- No brand at all: one dark or light background, ONE accent colour, one font family (system-ui stack, or one Google Font via `<link>`).

STEP 2 — WRITE IT FOR A FIXED CANVAS
- The root element is exactly the canvas: `width:<W>px;height:<H>px;overflow:hidden`. Lay out with flex/grid and `gap`, never absolute-positioned guesses for text.
- Keep a safe margin of ~6% of the short side on every edge; social crops eat the edges (story and banner formats most of all).
- Hierarchy: one headline (large, heavy, ≤ 8 words), at most one supporting line, an optional small label/URL. Long copy belongs in the post, not the image.
- Text at least ~24px on a 1200px-wide canvas; contrast at least 4.5:1 against what is actually behind it (overlay a gradient/scrim when text sits on an image).
- Local images by relative path: from the workspace root for inline `html`/`svg` (`<img src="public/logo.svg">`), from the source file's own folder when rendering a `file` (`design/og.html` → `../public/logo.svg`). Remote images and web fonts over https work too. Nothing on localhost.
- For something the user will iterate on, save the source next to the PNG (e.g. `design/og.html`) and render with `file`, so the next change is an edit, not a rewrite.

STEP 3 — RENDER, READ THE ISSUES, FIX, RENDER AGAIN
- Call renderImage with `out`, `width`, `height` (scale 2 by default — keep it for crisp text).
- The result lists layout problems: content larger than the canvas, text running past the edge, text clipped in its box, broken images, failed fonts. Each is a real defect in the PNG — fix the markup and render again until it reports none.
- If the render comes back as an image you can see, check what the report cannot — contrast, a logo vanishing into the background, overlap, balance — and fix and re-render. If it does not (a text-only model), do not claim how it "looks". Either way, state the file path, the size, what is on it, and anything you could not verify.

NEVER
- Never invent a logo, a product screenshot, a person's photo or a third-party brand mark. Use the project's assets or leave a clearly labelled placeholder and say so.
- Never put tiny text, more than two typefaces, or more than one accent colour on a social graphic.
- Never overwrite an existing image the user did not name — pick a new filename and mention it.

Task (if nothing follows this line, ask what the graphic is for and where it will be posted):
