// Tool-approval policy, passed to streamText as `toolApproval`.
//
// Priority chain, ALWAYS in this order:
//   1. alwaysDeny  — hard block; even full-auto cannot bypass it.
//   2. alwaysAllow — user-pinned allow; beats everything except deny.
//   3. READ_ONLY   — non-mutating tools are always safe.
//   4. mode        — 'full-auto' approves the rest; 'auto' approves allowlisted shell commands;
//                    `autoApproveWrites` approves file mutation.
//   5. ask         — prompt the user via the approval channel.
//
// policyFromSettings reads vscode config; resolvePolicy is pure so e2e drives it directly.

import * as vscode from 'vscode';
import type { ToolApprovalStatus } from 'ai';
import { READ_ONLY_TOOLS } from '../agent/core/tools/v3';
import { commandFromInput, isDangerous, isReadOnlyCommand, matchesAllowlist, DEFAULT_COMMAND_ALLOWLIST } from '../edits/commandClassify';

export type PermissionMode = 'ask' | 'auto' | 'full-auto';

/** The tools that write to disk — denied outright in plan and ask session modes. */
const MUTATING_FILE_TOOLS = new Set(['editFile', 'writeFile', 'deleteFile', 'editMatch']);

export interface PolicyConfig {
  mode: PermissionMode;
  /** 'plan' applies §12's profile: read/search auto-allow, shell ASKS, edit/delete/write
   *  hard-deny — approval of a plan is never a blanket approval to mutate. */
  sessionMode?: 'plan' | 'agent' | 'ask';
  alwaysAllow: Set<string>;
  alwaysDeny: Set<string>;
  /** Command PREFIXES `commandApproval: 'allowlist'` auto-runs (on top of the built-in safe
   *  defaults). Until 2026-09-05 this set was compared against TOOL NAMES, so 'allowlist'
   *  mode never auto-ran anything. */
  autoModeAllowlist: Set<string>;
  /** `commandApproval: 'never'` — the shell is OFF, not auto-approved. Kept separate from
   *  `mode` because 'never' means both "never ask" AND "never run", and folding it into
   *  full-auto lost the second half entirely (see resolvePolicy). */
  shellDisabled?: boolean;
  /** `agent.requireWriteConfirmation: false` — file writes in agent mode run without a prompt.
   *  Until 2026-09-05 the setting only reached inline chat's EditGate; the agent's own
   *  editFile/writeFile/deleteFile never read it, so its description was false. */
  autoApproveWrites?: boolean;
}

export const defaultPolicy: PolicyConfig = {
  mode: 'ask',
  alwaysAllow: new Set(),
  alwaysDeny: new Set(),
  autoModeAllowlist: new Set(),
};

export type ApprovalDecision = 'allow' | 'allow-always' | 'deny';

export interface PolicyCall {
  toolName: string;
  input?: unknown;
}

/** The pure decision core — no vscode, no I/O. e2e drives this directly. */
export function resolvePolicy(
  call: PolicyCall,
  config: PolicyConfig,
  requestApproval?: (req: { tool: string; input?: unknown }) => Promise<ApprovalDecision | undefined>,
): Promise<ToolApprovalStatus> {
  if (config.alwaysDeny.has(call.toolName)) {
    return Promise.resolve({ type: 'denied', reason: `tool "${call.toolName}" is in the alwaysDeny list` });
  }

  // §12 Plan-mode profile: read-only work is free, shell ASKS (git/ls are legitimately
  // useful while planning), every mutation is hard-denied — alwaysAllow does NOT unlock
  // mutation here, so an approved plan never doubles as a blanket edit approval.
  if (config.sessionMode === 'plan') {
    if (READ_ONLY_TOOLS.has(call.toolName)) return Promise.resolve({ type: 'approved' });
    if (call.toolName === 'runCommand') {
      if (!requestApproval) return Promise.resolve({ type: 'denied', reason: 'no approval channel configured' });
      return requestApproval({ tool: call.toolName, input: call.input }).then((d) => {
        if (d === 'allow-always') config.alwaysAllow.add(call.toolName);
        return d === 'allow' || d === 'allow-always'
          ? { type: 'approved' as const }
          : { type: 'denied' as const, reason: 'user denied' };
      });
    }
    return Promise.resolve({ type: 'denied', reason: 'plan mode is read-only — edits are disabled until the plan is approved' });
  }

  // Ask mode: read-only Q&A. File mutators are hard-denied (toolset withholds them too).
  // Shell is allowed READ-ONLY: a confidently read-only command (ls, git log/status/diff)
  // auto-runs so "what did the last commit do?" is answerable from real output; a dangerous
  // command (rm -rf, push --force) is hard-denied; anything ambiguous falls through to the
  // normal approval chain below. alwaysAllow from an earlier agent-mode turn is ignored for
  // shell here — ask-mode approval is per-turn, never blanket.
  if (config.sessionMode === 'ask' && MUTATING_FILE_TOOLS.has(call.toolName)) {
    return Promise.resolve({ type: 'denied', reason: 'ask mode answers questions — file edits are disabled; switch to agent mode to change files' });
  }
  if (config.sessionMode === 'ask' && call.toolName === 'runCommand') {
    const cmd = commandFromInput(call.input);
    if (cmd && isDangerous(cmd)) {
      return Promise.resolve({ type: 'denied', reason: 'ask mode never runs destructive commands — switch to agent mode for that' });
    }
    if (cmd && isReadOnlyCommand(cmd)) return Promise.resolve({ type: 'approved' });
    if (!requestApproval) return Promise.resolve({ type: 'denied', reason: 'no approval channel configured' });
    return requestApproval({ tool: call.toolName, input: call.input }).then((d) => {
      return d === 'allow'
        ? { type: 'approved' as const }
        : { type: 'denied' as const, reason: 'user denied' };
    });
  }

  if (config.alwaysAllow.has(call.toolName)) {
    // A session-scoped "Always" grant from an agent-mode turn must never unlock mutation
    // in ask mode — plan mode returned above before reaching here, and ask-mode mutating
    // tools were denied above, so this is defense-in-depth. Shell is exempt: ask mode
    // handles runCommand in its own branch above (read-only auto, dangerous deny).
    if (config.sessionMode === 'ask' && MUTATING_FILE_TOOLS.has(call.toolName)) {
      return Promise.resolve({ type: 'denied', reason: 'ask mode is read-only — a prior "Always" grant does not carry over' });
    }
    return Promise.resolve({ type: 'approved' });
  }
  if (READ_ONLY_TOOLS.has(call.toolName)) {
    return Promise.resolve({ type: 'approved' });
  }
  // `commandApproval: 'never'` = "disable terminal command execution entirely". Until
  // 2026-09-05 policyFromSettings folded it into full-auto, so the one setting that switches the
  // shell OFF auto-approved every command. `shellDisabled` keeps the "don't ask" half and
  // restores the "don't run" half.
  if (config.shellDisabled === true && call.toolName === 'runCommand') {
    return Promise.resolve({
      type: 'denied',
      reason: 'terminal command execution is disabled (tiermux.agent.commandApproval = "never")',
    });
  }
  if (config.mode === 'full-auto') {
    return Promise.resolve({ type: 'approved' });
  }
  if (config.autoApproveWrites === true && MUTATING_FILE_TOOLS.has(call.toolName)) {
    return Promise.resolve({ type: 'approved' });
  }
  if (config.mode === 'auto' && call.toolName === 'runCommand') {
    const cmd = commandFromInput(call.input);
    if (cmd && !isDangerous(cmd)
      && (matchesAllowlist(cmd, DEFAULT_COMMAND_ALLOWLIST) || matchesAllowlist(cmd, config.autoModeAllowlist) || isReadOnlyCommand(cmd))) {
      return Promise.resolve({ type: 'approved' });
    }
  }
  if (!requestApproval) {
    return Promise.resolve({ type: 'denied', reason: 'no approval channel configured' });
  }
  return requestApproval({ tool: call.toolName, input: call.input }).then((d) => {
    if (d === 'allow-always') config.alwaysAllow.add(call.toolName);
    return d === 'allow' || d === 'allow-always'
      ? { type: 'approved' as const }
      : { type: 'denied' as const, reason: 'user denied' };
  });
}

/** Live config snapshot from vscode settings + the legacy per-session auto-approve flag.
 *  `sessionId` keys the module-level grant store: the ALWAYS-ALLOW/ALWAYS-DENY sets returned
 *  are the STORED set REFERENCES, not copies — resolvePolicy's `config.alwaysAllow.add(...)`
 *  (the 'allow-always' path) mutates the store directly, so a grant survives across turns.
 *  Callers that omit sessionId share the 'workspace' key. */
const sessionGrants = new Map<string, { allow: Set<string>; deny: Set<string> }>();
function grantsFor(sessionId?: string): { allow: Set<string>; deny: Set<string> } {
  const key = sessionId ?? 'workspace';
  let grants = sessionGrants.get(key);
  if (!grants) {
    grants = { allow: new Set(), deny: new Set() };
    sessionGrants.set(key, grants);
  }
  return grants;
}

/** Test/teardown hook — drops a session's accumulated always-allow/deny grants. */
export function clearSessionGrants(sessionId?: string): void {
  sessionGrants.delete(sessionId ?? 'workspace');
}

export function policyFromSettings(
  autoApproveSession = false,
  sessionMode: 'plan' | 'agent' | 'ask' = 'agent',
  sessionId?: string,
): PolicyConfig {
  const cfg = vscode.workspace.getConfiguration('tiermux.agent');
  const approval = cfg.get<string>('commandApproval', 'always'); // 'always' | 'allowlist' | 'never'
  const mode: PermissionMode = autoApproveSession || approval === 'never'
    ? 'full-auto'
    : approval === 'allowlist' ? 'auto' : 'ask';
  const grants = grantsFor(sessionId);
  return {
    mode,
    sessionMode,
    alwaysAllow: grants.allow,
    alwaysDeny: grants.deny,
    autoModeAllowlist: new Set(cfg.get<string[]>('commandAllowlist', [])),
    // 'never' disables the shell. The session auto-approve toggle does NOT re-enable it — that
    // toggle is about skipping prompts, and a user who switched the terminal off did not ask
    // for it back.
    shellDisabled: approval === 'never',
    autoApproveWrites: cfg.get<boolean>('requireWriteConfirmation', true) === false,
  };
}
