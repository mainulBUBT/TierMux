

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

/** Content-reading tools that take a workspace path — the ones a secrets read can leak through. */
const CONTENT_READ_TOOLS = new Set(['readFile', 'grep']);

/** Path patterns that commonly hold secrets. Matched against workspace-relative paths, so this
 *  catches `.env` at any depth without also matching e.g. `src/env.ts`. */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa(\.[^/]+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
  /credentials/i,
];

function findSensitivePath(paths: string[]): string | undefined {
  return paths.find((p) => SENSITIVE_PATH_PATTERNS.some((re) => re.test(p)));
}

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

    if (CONTENT_READ_TOOLS.has(name)) {
      const input = toolCall.input as { path?: string | string[] };
      const paths = Array.isArray(input?.path) ? input.path : input?.path ? [input.path] : [];
      const hit = findSensitivePath(paths);
      if (hit) {
        if (!opts.onPermissionAsk) return { type: 'denied', reason: `"${hit}" looks like a secrets file.` };
        const resp = await opts.onPermissionAsk({
          title: `This tool wants to read the secrets-looking file`,
          pattern: hit,
          toolName: name,
        });
        return resp === 'reject' ? { type: 'denied', reason: `"${hit}" looks like a secrets file.` } : 'approved';
      }
    }

    if (!MUTATING_TOOLS.has(name)) return 'approved';

    if (name === 'runCommand') {
      const command = typeof (toolCall.input as { command?: unknown })?.command === 'string'
        ? (toolCall.input as { command: string }).command
        : '';
      if (command && isReadOnlyCommand(command) && !isDangerous(command)) return 'approved';
    }

    if (!opts.onPermissionAsk) return 'approved'; // no gate wired (e.g. a test harness) — allow
    // Lead-in sentence + the command/path shown separately (as `pattern`, rendered as an inline
    // code chip by the webview) — mirrors the AI Elements Confirmation reference ("This tool
    // wants to delete the file `path`. Do you approve this action?") instead of a bare
    // "editFile — apply this change?" that never named WHICH file.
    const input = toolCall.input as { command?: string; path?: string };
    const title = name === 'runCommand' ? 'This tool wants to run the command'
      : name === 'deleteFile' ? 'This tool wants to delete the file'
      : name === 'editFile' ? 'This tool wants to apply changes to the file'
      : 'This tool wants to write to the file';
    const pattern = name === 'runCommand' ? input.command : input.path;
    const command = name === 'runCommand' ? input.command : undefined;
    const resp = await opts.onPermissionAsk({ title, pattern, command, toolName: name });
    return resp === 'reject' ? { type: 'denied' } : 'approved';
  };
}
