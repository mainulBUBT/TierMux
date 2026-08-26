// POC ONLY — v3 permission policy (plan §3). Replaces src/edits/** + policies/permission.ts.
//
// The priority chain is explicit and ALWAYS evaluated in this order:
//   1. alwaysDeny   — hard block; even full-auto cannot bypass it.
//   2. alwaysAllow  — user-pinned allow; short-circuits everything except deny.
//   3. READ_ONLY    — non-mutating tools are always safe to run.
//   4. mode         — 'full-auto' approves the rest; 'auto' approves its allowlist.
//   5. ask          — prompt the user via opts.requestApproval.

import type { ToolApprovalStatus } from 'ai';
import { READ_ONLY_TOOLS } from './tools';

export type PermissionMode = 'ask' | 'auto' | 'full-auto';

export interface PolicyConfig {
  mode: PermissionMode;
  alwaysAllow: Set<string>;
  alwaysDeny: Set<string>;
  /** Extra tools auto-approved in 'auto' mode (read-only ones already are). */
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

export function resolvePolicy(
  call: PolicyCall,
  config: PolicyConfig,
  requestApproval?: (req: { tool: string; input?: unknown }) => Promise<ApprovalDecision | undefined>,
): Promise<ToolApprovalStatus> {
  // 1. alwaysDeny ALWAYS wins — even in full-auto (user's correction #2).
  if (config.alwaysDeny.has(call.toolName)) {
    return Promise.resolve({ type: 'denied', reason: `tool "${call.toolName}" is in the alwaysDeny list` });
  }

  // 2. Explicit allow beats everything except deny.
  if (config.alwaysAllow.has(call.toolName)) {
    return Promise.resolve({ type: 'approved' });
  }

  // 3. Read-only tools are always safe.
  if (READ_ONLY_TOOLS.has(call.toolName)) {
    return Promise.resolve({ type: 'approved' });
  }

  // 4. Mode policy.
  if (config.mode === 'full-auto') {
    return Promise.resolve({ type: 'approved' });
  }
  if (config.mode === 'auto' && config.autoModeAllowlist.has(call.toolName)) {
    return Promise.resolve({ type: 'approved' });
  }

  // 5. Ask the user.
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
