# Pre-publish checklist (run before every push to the public GitHub remote)

## 1. Secret scan
```bash
git grep -nEI '(sk-[a-zA-Z0-9]{10,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{30,}|xox[baprs]-|AIza[0-9A-Za-z_-]{20,}|-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----)' -- .
git ls-files | grep -iE '(^|/)\.env'
```
Both should return nothing. If either finds something, rotate the credential first (assume anything committed is burned), then remove it from tracking.

## 2. Known-sensitive paths — confirm still gitignored
- `.vscode/settings.json` — history leaked a real `mimo.apiKey` on 2026-07-11 (commit `fb8068f`). Key was rotated; file is now gitignored. If you ever re-add `.vscode/` tracking, strip secrets from it first.
- `.tiermux/opencode.jsonc`, `.tiermux/opencode/config.json` — may contain provider keys, already gitignored.
- `.claude/`, `.kilo/`, `.kilocode/`, `.benchmarks/` — local tool state, already gitignored.

## 3. Personal/local info sanity check
```bash
git grep -niE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|mainul' -- . ':!package-lock.json' | grep -v node_modules
```
Expect only: GitHub username in `package.json` repo URL, publisher id, and any `process.env.HOME`-based path logic — all fine for a public repo. Anything else (a personal email, local absolute paths, internal URLs) should be removed or genericized.

## 4. Multi-device hygiene
Each device may have its own untracked `.vscode/settings.json`, `.env`, or IDE-local config — none of these should ever be force-added with `git add -A`. Stage files by name, and re-run step 1 before pushing from a new machine, since local uncommitted secrets don't travel with the repo but a careless `git add .` can pull them in.

## 5. Marketplace fields (not secrets, but check before publish)
- `package.json` `repository.url` points at the public repo.
- `LICENSE` and `README.md` exist at repo root.
