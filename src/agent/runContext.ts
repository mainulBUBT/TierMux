// Per-run context that threads a session's checkpoints + approval handlers through the
// shared, stateless EditGate/CommandGate/WorkspaceTools. This is what lets concurrent
// agent runs (one per chat session) use the SAME gate instances without crossing wires:
// each run supplies its own checkpoints recorder, approval callbacks, and auto-approve read.
//
// Callers without a session (e.g. inline editor chat) omit it, and the gates fall back to
// their construct-time closures — preserving today's single-session behavior exactly.
import type * as vscode from 'vscode';

export interface RunContext {
  sessionId: string;
  requestId: string;
  /** Records a file's pre-edit baseline into THIS session's checkpoints. */
  checkpoints: { record(uri: vscode.Uri, before: string | null): void };
  /** Ask the user to approve a `runCommand` call inline, in THIS session's thread. */
  approveCommand: (command: string, cwd?: string) => Promise<boolean>;
  /** Ask the user to approve a file edit/deletion inline, in THIS session's thread. `undefined` = defer to the native modal. */
  approveEdit: (req: { path: string; title: string; kind: 'write' | 'delete' }) => Promise<boolean | undefined>;
  /** Live read of the (workspace-wide) Auto-approve toggle. */
  autoApprove: () => boolean;
}
