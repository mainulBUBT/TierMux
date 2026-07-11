#!/usr/bin/env node
// Pre-publish safety gate. Mirrors PUBLISHING.md:
//   1. Secret scan over tracked files      -> FAIL on hit
//   2. Known-sensitive paths tracked        -> FAIL on hit
//   3. Personal/local info sanity           -> WARN only (too noisy to block)
// Intended to run as a git pre-push hook (via husky) and is also safe to run
// manually: `node scripts/prepublish-check.mjs`.
//
// Allowlist: a few patterns appear legitimately (e.g. an "xoxb-…" example label
// in the MCP registry). Add the {file, line} pair here when a hit is reviewed
// and confirmed safe, so the gate stays quiet without weakening real detection.

import { execSync } from "node:child_process";

const NO_ADVISORY = process.argv.includes("--no-advisory");

const SECRET_PATTERNS = [
  "sk-[a-zA-Z0-9]{10,}",
  "AKIA[0-9A-Z]{16}",
  "ghp_[a-zA-Z0-9]{30,}",
  "xox[baprs]-",
  "AIza[0-9A-Za-z_-]{20,}",
  "-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----",
];

// Confirmed-safe {path, snippet-substring} pairs. Matched by path + a substring
// of the matched line, so a new real secret on the same path still trips the gate.
const SECRET_ALLOWLIST = [
  { path: "media/mcp-registry.json", contains: "xoxb-…" }, // example label, not a token
  { path: "scripts/prepublish-check.mjs", contains: "xoxb-…" }, // this file's own allowlist docs/entry
];

// Paths that must never be tracked. Matched as ls-files entries.
const SENSITIVE_PATH_PATTERNS = [
  /^\.env$/,
  /(^|\/)\.vscode\/settings\.json$/,
  /(^|\/)\.tiermux\/opencode(\.jsonc|\/config\.json)$/,
  /(^|\/)\.claude\//,
  /(^|\/)\.kilo(code)?\//,
  /(^|\/)\.benchmarks\//,
];

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function git(args) {
  try {
    return execSync(`git ${args}`, { encoding: "utf8", maxBuffer: 1 << 26 });
  } catch {
    return "";
  }
}

function parseGrep(out) {
  // git grep -n output: `path:line:match`
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const idx1 = line.indexOf(":");
      const idx2 = line.indexOf(":", idx1 + 1);
      return { path: line.slice(0, idx1), line: line.slice(idx2 + 1) };
    });
}

function isAllowed({ path, line }) {
  return SECRET_ALLOWLIST.some(
    (a) => path === a.path && line.includes(a.contains),
  );
}

function fail(msg) {
  console.error(`${RED}✖${RESET} ${msg}`);
  process.exit(1);
}

let blocking = false;

// --- 1. Secret scan ----------------------------------------------------------
const grepOut = git(
  `grep -nEI '${SECRET_PATTERNS.join("|")}' -- .`,
);
const secretHits = parseGrep(grepOut).filter((h) => !isAllowed(h));
if (secretHits.length) {
  console.error(`${RED}✖ Secret scan: ${secretHits.length} suspicious hit(s) in tracked files${RESET}`);
  for (const h of secretHits) {
    console.error(`  ${RED}${h.path}${RESET}: ${h.line.trim()}`);
  }
  console.error(
    `\nRotate the credential first (assume anything committed is burned), then remove it from tracking.`,
  );
  blocking = true;
} else {
  console.log(`${GREEN}✓${RESET} Secret scan clean`);
}

// --- 2. Sensitive tracked paths ---------------------------------------------
const tracked = git(`ls-files`).split("\n").filter(Boolean);
const sensitiveTracked = tracked.filter((p) =>
  SENSITIVE_PATH_PATTERNS.some((re) => re.test(p)),
);
if (sensitiveTracked.length) {
  console.error(
    `${RED}✖ Sensitive path(s) are tracked (should be gitignored)${RESET}`,
  );
  for (const p of sensitiveTracked) console.error(`  ${RED}${p}${RESET}`);
  blocking = true;
} else {
  console.log(`${GREEN}✓${RESET} No sensitive paths tracked`);
}

// --- 3. Personal/local info (advisory) --------------------------------------
if (!NO_ADVISORY) {
const personalOut = git(
  `grep -niE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}|mainul' -- . ':!package-lock.json'`,
);
const personalHits = parseGrep(personalOut).filter(
  // expected/allowed: GitHub repo URL + publisher id in package.json, env-var path logic
  (h) =>
    !(
      (h.path === "package.json" &&
        /(mainulBUBT|mainul-islam|TierMux)/.test(h.line)) ||
      /process\.env\.HOME/.test(h.line)
    ),
);
if (personalHits.length) {
  console.log(
    `${YELLOW}⚠ Personal-info review: ${personalHits.length} hit(s) — check these aren't a real email / local path${RESET}`,
  );
  for (const h of personalHits.slice(0, 20)) {
    console.log(`  ${YELLOW}${h.path}${RESET} ${DIM}${h.line.trim().slice(0, 120)}${RESET}`);
  }
  if (personalHits.length > 20)
    console.log(`  …and ${personalHits.length - 20} more`);
} else {
  console.log(`${GREEN}✓${RESET} Personal-info scan clean`);
}
} // end if (!NO_ADVISORY)

if (blocking) {
  console.error(
    `\n${RED}Push blocked.${RESET} Fix the issue(s) above, or bypass for this push with \`git push --no-verify\` only if you are certain.`,
  );
  process.exit(1);
}
console.log(`\n${GREEN}Pre-publish checks passed.${RESET}`);
