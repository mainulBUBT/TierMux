import * as vscode from 'vscode';

/**
 * Deterministic, no-LLM compaction of tool results BEFORE they enter the message history
 * (the RTK idea from 9router): a 30k-char command output the model needs only the head and
 * tail of is re-billed as input tokens on EVERY later step of the turn. Compacting at the
 * workMessages choke point means neither the model nor the persisted session ever carries
 * the bulk.
 *
 * Verbatim-lossless tools are NEVER compacted: readFile/editFile results are the material
 * the model edits against, and diagnostics are already small. `runCommand` is compacted at
 * every level (keep the command echo's outcome — exit code lives in the wrapper text —
 * plus head and tail). Search-shaped tools join only at 'aggressive'.
 */

export type CompactionLevel = 'off' | 'light' | 'aggressive';

/** Outputs at or below this stay untouched — compaction markers would cost more than they save. */
const MIN_CHARS = 2_000;
const HEAD_CHARS = 800;
const TAIL_CHARS = 1_500;
/** Line cap for search-shaped outputs at 'aggressive'. */
const MAX_LINES = 80;

export function toolCompactionLevel(): CompactionLevel {
  try {
    return vscode.workspace.getConfiguration('tiermux.agent').get<CompactionLevel>('toolCompaction', 'light');
  } catch {
    return 'light';
  }
}

const compactHeadTail = (toolName: string, output: string): string =>
  `${output.slice(0, HEAD_CHARS)}\n[TierMux: compacted ${toolName} output — ${output.length} chars, middle omitted]\n${output.slice(-TAIL_CHARS)}`;

const compactLines = (toolName: string, output: string): string => {
  const lines = output.split('\n');
  if (lines.length <= MAX_LINES) return compactHeadTail(toolName, output);
  const kept = lines.slice(0, MAX_LINES).join('\n');
  return `${kept}\n[TierMux: compacted ${toolName} output — ${lines.length} lines, showing first ${MAX_LINES}]`;
};

/**
 * Compact one tool result for the message history.
 */
export function compactToolResult(toolName: string | undefined, output: string, level: CompactionLevel): string {
  if (level === 'off') return output;
  if (typeof output !== 'string' || output.length <= MIN_CHARS) return output;
  if (!toolName) return output;

  switch (toolName) {
    case 'runCommand':
    case 'bash':
    case 'shell':
      // Every level: commands are the big repeated payloads, and the model needs the
      // beginning (what happened) and end (final status), not the 25k chars between.
      return compactHeadTail(toolName, output);
    case 'grep':
    case 'glob':
    case 'listDir':
    case 'webSearch':
    case 'deepSearch':
      if (level === 'aggressive') return compactLines(toolName, output);
      return output;
    default:
      // readFile / editFile / writeFile / diagnostics / reports — verbatim by policy.
      return output;
  }
}
