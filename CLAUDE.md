# Publishing to GitHub

Before staging/committing anything intended for a push to the public GitHub remote (`mainulBUBT/TierMux`), run the checklist in [PUBLISHING.md](PUBLISHING.md) — secret scan, known-sensitive-path check, personal-info sanity check. This applies on every device this repo is cloned on, not just the one the check was written on.

# The agent core is a mechanical execution engine (2026-08-24 reset)

Before touching `src/agent/core/loop.ts`, adding any "quality"/retry/detector logic, or editing the system prompt, read [docs/SIMPLE_CORE_RESET_2026-08-24.md](docs/SIMPLE_CORE_RESET_2026-08-24.md). Short version: the loop executes tools/models, preserves the ONE `CoreMessage[]` transcript, rotates providers, and recovers from provider failures with exactly ONE mechanical continuation. It never judges answer quality, never detects "narration", never retries on weak-looking output. Any new guard needs a live repro cited in its comment — one targeted guard at a time, never a tower. Verify with `npm run test:e2e:simple-turn` plus the suites listed in that doc.
