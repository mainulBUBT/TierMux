

// The permission POLICY — not the gate. The AI SDK's own `toolApproval` mechanism (a call-level
// option to streamText/generateText) is the gate: a denied verdict here means the tool's
// execute() never runs at all (verified empirically against ai@7.0.34 — see the plan's spike
// note). This file only decides allow/ask/deny; it never touches execution.
import type { AgentOpts } from '../../agent';
import { isReadOnlyCommand } from '../../../edits/commandClassify';
import { isDangerous } from '../../../edits/commandGate';

/** Tools that mutate the workspace or run arbitrary commands — excluded from plan/ask mode's
 *  tool set entirely (see tools/index.ts) and denied here too as defense in depth. */
export const MUTATING_TOOLS = new Set(['writeFile', 'createFile', 'editFile', 'deleteFile', 'runCommand']);

interface ToolApprovalStatusObject { type: 'approved' | 'denied' | 'not-applicable' | 'user-approval'; reason?: string }
type ToolApprovalStatus = ToolApprovalStatusObject | 'approved' | 'denied' | 'not-applicable' | undefined;

interface ApprovalToolCall {
  toolName: string;
  input: unknown;
}

/**
 * Creates the AI SDK `toolApproval` function for one turn. Same decisions the previous
 * hand-rolled permission checks made — mode gate, live read-only command classification,
 * dangerous-pattern override, and the existing `onPermissionAsk` UI callback — now enforced by
 * the SDK itself.
 */
export function createToolApproval(opts: AgentOpts) {
  return async ({ toolCall }: { toolCall: ApprovalToolCall }): Promise<ToolApprovalStatus> => {
    const name = toolCall.toolName;

    if (opts.mode !== 'agent' && MUTATING_TOOLS.has(name)) {
      return { type: 'denied', reason: `"${name}" is not available in ${opts.mode} mode.` };
    }
    if (!MUTATING_TOOLS.has(name)) return 'approved';

    if (name === 'runCommand') {
      const command = typeof (toolCall.input as { command?: unknown })?.command === 'string'
        ? (toolCall.input as { command: string }).command
        : '';
      if (command && isReadOnlyCommand(command) && !isDangerous(command)) return 'approved';
    }

    if (!opts.onPermissionAsk) return 'approved'; // no gate wired (e.g. a test harness) — allow
    const title = name === 'runCommand'
      ? `Run command: ${(toolCall.input as { command?: string })?.command ?? ''}`
      : `${name} — apply this change?`;
    const command = name === 'runCommand' ? (toolCall.input as { command?: string })?.command : undefined;
    const resp = await opts.onPermissionAsk({ title, command });
    return resp === 'reject' ? { type: 'denied' } : 'approved';
  };
}
