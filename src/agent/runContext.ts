

import type * as vscode from 'vscode';
import type { TodoItem } from '../shared/types';

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
  /** Same abort signal the agent loop receives (Stop button / wall-clock ceiling). Forwarded
   *  to CommandGate so an in-flight shell can be killed by tree — see commandGate.ts's
   *  `live` map. Without this, Stop only cancelled the HTTP call and long-running commands
   *  (npm test, composer install, php artisan test) outlived the run, pinning the workspace. */
  abortSignal?: AbortSignal;
  /** Optional output directory for run-scoped artifacts (e.g. bench debug log).
   *  When set, the agent writes pre-research.jsonl to <outDir>/pre-research.jsonl
   *  so each run's instrumentation lands alongside its telemetry. */
  outDir?: string;
  /** Native engine only: forwards a `todowrite` tool call's list to the UI. */
  onTodos?: (todos: TodoItem[]) => void;
  /** Native engine only: forwards a `question` tool call to the UI's askUser card. */
  onAskUser?: (question: string, options?: string[]) => Promise<string>;
}
