// Execution Memory — lightweight session-level task-state tracker.
//
// Problem: when a multi-step task spans multiple auto-continue loops or
// user follow-up messages, the model loses track of what it already did.
// It re-reads the same files, re-plans the same steps, and sometimes
// partially re-applies changes. This looks like forgetfulness to the user.
//
// Solution: after each agent run, scan the tool call transcript for file
// writes/edits/creates, build a compact "Previous work in this session"
// block, and inject it at the top of the NEXT run's system prompt.
// The model sees exactly what changed before it starts thinking.

export interface ExecutionStep {
  verb: 'modified' | 'created' | 'deleted' | 'ran';
  target: string;   // file path or command
  ts: number;
}

export interface ExecutionState {
  steps: ExecutionStep[];
  filesModified: Set<string>;
}

/**
 * Scan tool call messages from an agent run and extract ExecutionSteps.
 * `messages` is the raw Message[] array from the agent run.
 */
export function extractStepsFromMessages(
  messages: Array<{ role?: string; content?: unknown }>,
): ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  const ts = Date.now();

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_use') continue;
      const name = b['name'] as string | undefined;
      const input = b['input'] as Record<string, unknown> | undefined;
      if (!name || !input) continue;

      if (name === 'writeFile' || name === 'createFile') {
        const path = (input['path'] ?? input['filePath'] ?? '') as string;
        if (path) steps.push({ verb: name === 'createFile' ? 'created' : 'modified', target: path, ts });
      } else if (name === 'editFile' || name === 'replaceInFile') {
        const path = (input['path'] ?? input['filePath'] ?? '') as string;
        if (path) steps.push({ verb: 'modified', target: path, ts });
      } else if (name === 'deleteFile') {
        const path = (input['path'] ?? '') as string;
        if (path) steps.push({ verb: 'deleted', target: path, ts });
      } else if (name === 'runTerminalCommand' || name === 'executeCommand' || name === 'run') {
        const cmd = (input['command'] ?? input['cmd'] ?? '') as string;
        if (cmd) steps.push({ verb: 'ran', target: (cmd as string).slice(0, 60), ts });
      }
    }
  }
  return steps;
}

/**
 * Accumulates execution steps across multiple run() calls in a session.
 * Instantiated once per Agent instance, cleared when the user starts a
 * new chat (which creates a new Agent instance).
 */
export class ExecutionTracker {
  private state: ExecutionState = { steps: [], filesModified: new Set() };

  /** Read-only view of all files modified in this session — used by conversationMemory. */
  get modifiedFiles(): ReadonlySet<string> { return this.state.filesModified; }

  /** Record steps from a completed run. Deduplicates file paths. */
  record(messages: Array<{ role?: string; content?: unknown }>): void {
    const newSteps = extractStepsFromMessages(messages);
    for (const step of newSteps) {
      if (step.verb === 'modified' || step.verb === 'created' || step.verb === 'deleted') {
        // Merge into filesModified set — keeps only the FINAL verb per file.
        this.state.filesModified.add(step.target);
      }
      // Only add if not already recorded in the last 5 steps for same target.
      const recent = this.state.steps.slice(-5);
      if (!recent.some((s) => s.verb === step.verb && s.target === step.target)) {
        this.state.steps.push(step);
      }
    }
  }

  get isEmpty(): boolean {
    return this.state.steps.length === 0;
  }

  /**
   * Build a compact markdown block for injection into the next run's system prompt.
   * Returns '' when there's nothing to report (first run in a session).
   */
  buildContextBlock(): string {
    if (this.state.steps.length === 0) return '';

    const lines: string[] = ['## Previous work this session\n'];

    const modified = [...this.state.filesModified];
    if (modified.length > 0) {
      lines.push(`**Files changed:** ${modified.slice(0, 8).map((f) => `\`${f}\``).join(', ')}`);
    }

    const cmds = this.state.steps.filter((s) => s.verb === 'ran').slice(-3);
    if (cmds.length > 0) {
      lines.push(`**Commands run:** ${cmds.map((s) => `\`${s.target}\``).join(', ')}`);
    }

    lines.push('\n_Do not redo these steps unless explicitly asked._');
    return lines.join('\n');
  }

  /** Reset for a brand-new task (called when history.length === 0 at run start). */
  reset(): void {
    this.state = { steps: [], filesModified: new Set() };
  }
}
