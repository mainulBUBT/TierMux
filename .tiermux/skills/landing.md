---
description: Build a landing/marketing page that explains the project and converts, grounded in what the project actually does
triggers: landing page, marketing page, marketing site, homepage, home page, hero section, promo page, product page, splash page, website for
---
Landing/marketing page task. The goal is a page a stranger can read in 30 seconds and come away knowing what this project is, who it is for, and what to do next. Work in this order.

STEP 1 — LEARN THE PRODUCT BEFORE WRITING ONE WORD
- Read the project's README, package.json/manifest, and docs. Skim the actual source if the README is thin. You are writing about THIS project, not a generic SaaS.
- Extract, in the project's own words: what it does, who it is for, the top 3–5 real capabilities, how someone installs or starts it, and the license/price.
- Every claim on the page must trace back to something you read. If you cannot source a claim, cut it.

STEP 2 — NEVER FABRICATE PROOF
- No invented testimonials, customer names, company logos, star ratings, user counts, funding, awards, or benchmark numbers. Not as placeholders, not as "example" content.
- If a section needs social proof that does not exist yet, either drop the section or leave a clearly-marked empty slot the user can fill (`<!-- TODO: real testimonial -->`). A fake quote that ships is a lie with the user's name on it.
- Real, sourceable proof is fine: GitHub stars if you read the count, an actual license, a real supported-provider list.

STEP 3 — STRUCTURE (drop any section you have nothing true to put in)
1. Hero — headline states the OUTCOME in plain words, not the mechanism. One-sentence subhead naming who it is for. One primary call to action, one secondary at most.
2. The problem — one short block naming the pain, in the reader's language.
3. Features as benefits — 3–6 items, each a concrete capability with what it means for the user. Never a bare noun list.
4. How it works — 3 steps, install/config/run, with a real command or code snippet copied from the docs.
5. FAQ — the objections a real evaluator has (cost, lock-in, requirements, maturity).
6. Closing CTA — repeat the primary action. Footer: links, license, repo.

STEP 4 — COPY RULES
- Specific beats grand. "Routes across 18 free providers" beats "revolutionizes your workflow".
- Ban list: seamless, cutting-edge, revolutionize, game-changing, unleash, empower, supercharge, next-generation.
- Second person, active voice, short sentences. Headline under 10 words, subhead under 25.
- Say the price/cost plainly. Evaluators look for it first and distrust a page that hides it.

STEP 5 — BUILD IT
- Match the project's existing stack. Plain HTML/CSS is correct when there is no framework — do not introduce React for a static page.
- Self-contained: no CDN links, no external web fonts, no icon packages. System font stack and inline SVG. Many hosts block third-party requests outright.
- Mobile-first. One column under 640px, real breakpoints, tap targets ≥ 44px, nothing overflowing horizontally.
- Design quality: one accent color, neutrals elsewhere, one 4/8px spacing scale, body contrast ≥ 4.5:1, line-height ≥ 1.5 for paragraphs, max-width ~65ch for reading. Every link and button gets hover and focus-visible styles.
- Semantic markup: one `<h1>`, real heading order, `<nav>`/`<main>`/`<footer>`, alt text on images, a `<title>` and meta description.
- Respect `prefers-color-scheme` and `prefers-reduced-motion`.

BEFORE YOU FINISH
Re-read the page as a stranger and answer: is it obvious in 10 seconds what this is? Is every claim traceable to something you read? Is there a single clear next action? Does it hold up at 375px wide? Any fabricated proof left? Fix anything that answers no. Then list the files you created and any section you deliberately left empty for the user to fill.

Task (if nothing follows this line, ask what the page is for before building):
