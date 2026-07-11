

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
  /** Optional output directory for run-scoped artifacts (e.g. bench debug log).
   *  When set, the agent writes pre-research.jsonl to <outDir>/pre-research.jsonl
   *  so each run's instrumentation lands alongside its telemetry. */
  outDir?: string;
}
