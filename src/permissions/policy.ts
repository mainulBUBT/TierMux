// v3 permission policy (plan step 6) — production. Replaces src/edits/commandGate.ts +
// src/edits/applyEdit.ts's confirmation flow + agent/core/policies/permission.ts.
//
// Priority chain, ALWAYS in this order (user's correction #2):
//   1. alwaysDeny  — hard block; even full-auto cannot bypass it.
//   2. alwaysAllow — user-pinned allow; beats everything except deny.
//   3. READ_ONLY   — non-mutating tools are always safe.
//   4. mode        — 'full-auto' approves the rest; 'auto' approves its allowlist.
//   5. ask         — prompt the user via the approval channel.
//
// Mode/allowlists read from vscode config (tiermux.agent.commandApproval-style); the
// resolvePolicy core is pure and vscode-free so e2e drives it directly.

import * as vscode from 'vscode';
import type { ToolApprovalStatus } from 'ai';
import { READ_ONLY_TOOLS } from '../agent/core/tools/v3';

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
  autoModeAllowlist: Set<string>;
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

  // Ask mode: "everything except edits". The toolset already withholds the three file
  // mutators; this is the second lock, so a full-auto session (or a pinned alwaysAllow from an
  // earlier agent-mode turn) can never turn a Q&A turn into a writing turn. runCommand
  // deliberately falls through to the normal chain below — asking about the repo means
  // running `git log`/`npm test`, and those go through the same approval the user configured.
  if (config.sessionMode === 'ask' && MUTATING_FILE_TOOLS.has(call.toolName)) {
    return Promise.resolve({ type: 'denied', reason: 'ask mode answers questions — file edits are disabled; switch to agent mode to change files' });
  }

  if (config.alwaysAllow.has(call.toolName)) {
    return Promise.resolve({ type: 'approved' });
  }
  if (READ_ONLY_TOOLS.has(call.toolName)) {
    return Promise.resolve({ type: 'approved' });
  }
  if (config.mode === 'full-auto') {
    return Promise.resolve({ type: 'approved' });
  }
  if (config.mode === 'auto' && config.autoModeAllowlist.has(call.toolName)) {
    return Promise.resolve({ type: 'approved' });
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
    autoModeAllowlist: new Set(cfg.get<string[]>('commandAllowlist', []).flatMap((s) => s.split(/\s+/))),
  };
}
