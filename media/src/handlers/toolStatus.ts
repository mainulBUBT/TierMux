/* Handler for 'toolStatus' messages - updates the live tool card + status verb.
 *
 * Phase D2 PR6: fourth extracted handler. Same pattern as todos/assistantStart/agentStep.
 */

// ----- Types ---------------------------------------------------------------

export interface ToolStatusMessage {
  type: 'toolStatus';
  requestId: string;
  state: 'running' | 'done' | 'error';
  name: string;
  args: unknown;
  detail?: string;
  toolCallId?: string;
}

/**
 * Target subset this handler reads/writes. The full Target in main.ts has many
 * more fields; only the tool-lifecycle ones are listed here.
 */
export interface Target {
  el: HTMLElement;
  flow: HTMLElement;
  activeTool: string | null;
  /** The in-progress `.flow-text.streaming` div text is currently accumulating into, or null
   *  between segments (main.ts creates a fresh one lazily on the next chunk). NOT a string,
   *  despite the field name — it's the live DOM node so a closed segment's `streaming` class
   *  (and its CSS-driven blinking cursor) can be stripped when the segment ends. */
  currentText: HTMLElement | null;
  _wasStreamed: boolean;
}

// ----- Context -------------------------------------------------------------

export interface ToolStatusContext {
  ensureTarget(requestId: string): Target;
  setStatusLabel(requestId: string, text: string, opts?: { force?: boolean; tool?: boolean; done?: boolean }): boolean;
  activityFor(name: string, args: unknown): string;
  upsertTool(t: Target, msg: ToolStatusMessage): void;
}

/** Closes the current text segment: strips the `streaming` class (so its CSS-driven blinking
 *  cursor stops) before dropping the reference. Without the classList removal, a segment closed
 *  mid-turn (a tool card or reasoning block interrupting the model's narration) stayed in the DOM
 *  still marked `streaming` forever — each one then blinked its OWN cursor on its own last line,
 *  which is why a multi-tool-call turn showed a `▍`/`|` on several lines at once, not just the
 *  true last one. */
function closeTextSegment(t: Target): void {
  t.currentText?.classList.remove('streaming');
  t.currentText = null;
}

// ----- Handler -------------------------------------------------------------

export function handleToolStatus(ctx: ToolStatusContext, msg: ToolStatusMessage): void {
  const t = ctx.ensureTarget(msg.requestId);
  // Reasoning is self-displaying: the tm-reasoning block shows its own "Thinking…" / "Thought for
  // Ns" header. Don't ALSO drive the whimsical rolling-verb status line for it — that duplicated
  // "Thinking" across two UI regions (the CoT block AND the agent status line) and looked like the
  // verbs leaked into the chain-of-thought. Only real tools own the status label.
  if (msg.name === 'reasoning') {
    const isNew = !t.flow.querySelector(`[data-tc="${msg.toolCallId}"]`);
    ctx.upsertTool(t, msg);
    if (isNew) closeTextSegment(t);
    return;
  }
  if (msg.state === 'running') {
    t.activeTool = msg.toolCallId;
    ctx.setStatusLabel(msg.requestId, ctx.activityFor(msg.name, msg.args), { tool: true });
  } else if (msg.toolCallId && msg.toolCallId === t.activeTool) {
    t.activeTool = null;
    ctx.setStatusLabel(msg.requestId, t._wasStreamed ? 'Responding…' : 'Thinking…', { done: true });
  }
  const isNew = !t.flow.querySelector(`[data-tc="${msg.toolCallId}"]`);
  ctx.upsertTool(t, msg);
  if (isNew) closeTextSegment(t);
}
