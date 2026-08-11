/* Regression test for the "⚠️ Unverified" badge's biggest credibility risk: over-firing.
 *
 * verifyNoteFor (formatDiagnostics.ts) already runs INSIDE writeFile/createFile/editFile's own
 * execute() on every call, success or not — but the badge's `verifiedAfterMutation` flag used to
 * only flip true on a SEPARATE, later runCommand/getDiagnostics call. That meant the badge fired
 * on every clean, single-edit turn that didn't ALSO make an extra top-level verify call — which is
 * most simple edits — training users to distrust a warning that was usually wrong. Asked directly
 * by the user, holding up a real screenshot of exactly this: "this show any user will trust?" The
 * honest answer at the time was no — the screenshot showed two files genuinely changed on disk
 * ("2 files changed" / Undo-all in the UI) while the badge-adjacent fallback text implied nothing
 * had happened.
 *
 * The decision under test — SELF_VERIFYING_TOOLS + the tool-result handler in loop.ts — can't be
 * driven through a full live runTurn() in this headless harness without either a real model or a
 * fake router entangled with the AI SDK's own step/tool-execution timing (which several other
 * contract tests in this codebase, e.g. shouldNudge/shouldForceTools in budgetNudge.e2e.ts and
 * stripToolCallAttempt in synthShrink.e2e.ts, deliberately avoid for the same reason). Mirrors the
 * exact decision logic instead — the same pattern, same reasoning.
 *
 * Run: npm run test:e2e:unverified-badge
 */
import { MUTATING_TOOLS } from '../src/agent/core/policies/permission';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const VERIFY_TOOLS = new Set(['runCommand', 'getDiagnostics']);
const SELF_VERIFYING_TOOLS = new Set(['writeFile', 'createFile', 'editFile']);
const COMPLETION_CLAIM_RE = new RegExp([
  /\b(?:(?:is|are|now|both|all|issues?|bugs?|problems?)\s+fixed|fixed(?:\s+(?:it|this|that|both|all|the\s+\w+))?\.|resolved|should (?:now )?work|now works?|works? now|that (?:should|will) (?:fix|do) it|problem solved|all set|done\.)/.source,
].join('|'), 'i');

type Event = { kind: 'call' | 'result' | 'error'; tool: string };

/** Mirrors loop.ts's tool-call/tool-result handling: hadMutatingToolCall + verifiedAfterMutation
 *  bookkeeping, followed by the final gate that decides whether the badge is appended. */
function wouldShowBadge(events: Event[], finalText: string): boolean {
  let hadMutatingToolCall = false;
  let verifiedAfterMutation = false;
  for (const e of events) {
    if (e.kind === 'call') {
      if (MUTATING_TOOLS.has(e.tool)) { hadMutatingToolCall = true; verifiedAfterMutation = false; }
      else if (hadMutatingToolCall && VERIFY_TOOLS.has(e.tool)) verifiedAfterMutation = true;
    } else if (e.kind === 'result') {
      if (SELF_VERIFYING_TOOLS.has(e.tool) && hadMutatingToolCall) verifiedAfterMutation = true;
    }
    // 'error' intentionally does nothing — a failed call earns no verification credit either way.
  }
  return hadMutatingToolCall && !verifiedAfterMutation && COMPLETION_CLAIM_RE.test(finalText);
}

// --- The actual regression: a real, SUCCESSFUL editFile call, then a "Fixed" claim. ---
// This is the screenshot's shape: verifyNoteFor already ran as part of the edit itself.
ok(
  'successful editFile + "Fixed" claim: NO badge (self-verified)',
  !wouldShowBadge([{ kind: 'call', tool: 'editFile' }, { kind: 'result', tool: 'editFile' }], 'Fixed the bug in target.ts.'),
);

// writeFile/createFile get the same treatment.
ok('successful writeFile + "Fixed" claim: NO badge', !wouldShowBadge([{ kind: 'call', tool: 'writeFile' }, { kind: 'result', tool: 'writeFile' }], 'Fixed it.'));
ok('successful createFile + "Fixed" claim: NO badge', !wouldShowBadge([{ kind: 'call', tool: 'createFile' }, { kind: 'result', tool: 'createFile' }], 'Fixed the missing config file.'));

// --- Must still catch the real problem: a mutation that is NOT self-verifying. ---
// runCommand (a shell command claiming a fix genuinely needs external proof) + a "Fixed" claim +
// no separate verify call -> the badge MUST still appear. Confirms the fix didn't silently make
// every mutation "self-verifying".
ok(
  'runCommand (not self-verifying) + "Fixed" claim, no verify call: badge STILL appears',
  wouldShowBadge([{ kind: 'call', tool: 'runCommand' }, { kind: 'result', tool: 'runCommand' }], 'The deployment is fixed.'),
);

// deleteFile is also not self-verifying (nothing left to lint).
ok(
  'deleteFile + "Fixed" claim, no verify call: badge STILL appears',
  wouldShowBadge([{ kind: 'call', tool: 'deleteFile' }, { kind: 'result', tool: 'deleteFile' }], 'Removed the stale file, all fixed.'),
);

// --- A FAILED editFile call (search text not found, etc.) + a "Fixed" claim. ---
// A failed edit earns no self-verification credit — only 'result' (success) sets the flag, not
// 'error'.
ok(
  'a FAILED editFile call + "Fixed" claim: badge STILL appears (no credit for a failed edit)',
  wouldShowBadge([{ kind: 'call', tool: 'editFile' }, { kind: 'error', tool: 'editFile' }], 'Fixed it.'),
);

// --- A genuinely unverified mutation still gets the explicit top-level verify credit too. ---
ok(
  'runCommand mutation + a SEPARATE getDiagnostics call + "Fixed" claim: NO badge',
  !wouldShowBadge([{ kind: 'call', tool: 'runCommand' }, { kind: 'result', tool: 'runCommand' }, { kind: 'call', tool: 'getDiagnostics' }, { kind: 'result', tool: 'getDiagnostics' }], 'Fixed and confirmed clean.'),
);

// --- Two edits in sequence: only the LATEST mutation's verification status should count. ---
// An editFile that succeeds, then a SECOND editFile that also succeeds -> still self-verified
// (the second call's own result re-confirms).
ok(
  'two successful edits in sequence: still self-verified, no badge',
  !wouldShowBadge(
    [{ kind: 'call', tool: 'editFile' }, { kind: 'result', tool: 'editFile' }, { kind: 'call', tool: 'editFile' }, { kind: 'result', tool: 'editFile' }],
    'Fixed both spots.',
  ),
);

// --- No mutation at all: the badge never applies regardless of claim wording. ---
ok('no mutating call at all + "Fixed" claim: badge never applies (nothing to verify)', !wouldShowBadge([], 'Fixed.'));

// --- No completion claim at all: badge never applies regardless of verification status. ---
ok(
  'unverified mutation but no completion CLAIM in the text: no badge',
  !wouldShowBadge([{ kind: 'call', tool: 'editFile' }, { kind: 'result', tool: 'editFile' }], 'I made a change; here is what it does.'),
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
