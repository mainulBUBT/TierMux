// Tool-approval policy — Cline's `requestToolApproval`. Priority, always in this order:
//   1. alwaysDeny (even full-auto cannot bypass)  2. alwaysAllow  3. READ_ONLY tools
//   4. mode — 'full-auto' approves the rest; 'auto' approves allowlisted shell commands;
//      `autoApproveWrites` approves file mutation  5. ask the user.
// policyFromSettings reads vscode config; resolvePolicy is pure so the e2e drives it directly.

import * as vscode from 'vscode';
import { commandFromInput, isDangerous, isReadOnlyCommand, matchesAllowlist, DEFAULT_COMMAND_ALLOWLIST } from '../edits/commandClassify';

export type PermissionMode = 'ask' | 'auto' | 'full-auto';

export type ToolApprovalStatus = { type: 'approved' } | { type: 'denied'; reason: string };

/** Cline builtin tools that never change the workspace — auto-approved in every mode. */
export const READ_ONLY_TOOLS = new Set(['read_files', 'search_codebase', 'fetch_web_content', 'skills', 'ask_question']);

/** The tools that write to disk — denied outright in plan mode. */
const MUTATING_FILE_TOOLS = new Set(['editor', 'apply_patch']);

const SHELL_TOOL = 'run_commands';

export interface PolicyConfig {
  mode: PermissionMode;
  /** 'plan' applies §12's profile: read/search auto-allow, shell ASKS, edit/delete/write
   *  hard-deny — approval of a plan is never a blanket approval to mutate. */
  sessionMode?: 'plan' | 'agent';
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
  /** `agent.requireWriteConfirmation: false` — the agent's file writes (Cline's editor) run
   *  without a prompt; shell commands still follow commandApproval. */
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
    if (call.toolName === SHELL_TOOL) {
      if (!requestApproval) return Promise.resolve({ type: 'denied', reason: 'no approval channel configured' });
      return requestApproval({ tool: call.toolName, input: call.input }).then((d) => {
        if (d === 'allow-always') config.alwaysAllow.add(call.toolName);
        return d === 'allow' || d === 'allow-always'
          ? { type: 'approved' as const }
          : { type: 'denied' as const, reason: 'user denied' };
      });
    }
    return Promise.resolve({ type: 'denied', reason: 'plan mode is read-only — the user must switch to Agent mode before anything changes' });
  }

  // Ask mode is gone (modes are 'plan' | 'agent'); its read-only shell behavior lives on in the
  // generic read-only auto-approve below, which every session mode gets.

  if (config.alwaysAllow.has(call.toolName)) {
    return Promise.resolve({ type: 'approved' });
  }
  if (READ_ONLY_TOOLS.has(call.toolName)) {
    return Promise.resolve({ type: 'approved' });
  }
  // `commandApproval: 'never'` = "disable terminal command execution entirely". Until
  // 2026-09-05 policyFromSettings folded it into full-auto, so the one setting that switches the
  // shell OFF auto-approved every command. `shellDisabled` keeps the "don't ask" half and
  // restores the "don't run" half.
  if (config.shellDisabled === true && call.toolName === SHELL_TOOL) {
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
  if (call.toolName === SHELL_TOOL) {
    const cmd = commandFromInput(call.input);
    if (cmd && !isDangerous(cmd)) {
      // A confidently read-only command auto-runs in EVERY mode. Allowlist mode already did;
      // the default commandApproval: 'always' was the one place `ls` or `git log` still cost a
      // prompt, so the most permissive session mode was the strictest about reading
      // (2026-09-16). Plan mode returns in its own branch above, so this changes agent mode
      // only.
      if (isReadOnlyCommand(cmd)) return Promise.resolve({ type: 'approved' });
      // The broader allowlist (installs, builds, test suites) stays gated on allowlist mode.
      if (config.mode === 'auto'
        && (matchesAllowlist(cmd, DEFAULT_COMMAND_ALLOWLIST) || matchesAllowlist(cmd, config.autoModeAllowlist))) {
        return Promise.resolve({ type: 'approved' });
      }
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

/** Live config snapshot from settings + the per-session grant store. The ALWAYS-ALLOW/DENY sets
 *  are the STORED REFERENCES, not copies — resolvePolicy's 'allow-always' path mutates them, so
 *  a grant survives across turns. Callers without a sessionId share the 'workspace' key. */
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
  sessionMode: 'plan' | 'agent' = 'agent',
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
