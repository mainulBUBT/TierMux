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
  currentText: string | null;
  _wasStreamed: boolean;
}

// ----- Context -------------------------------------------------------------

export interface ToolStatusContext {
  ensureTarget(requestId: string): Target;
  setStatusLabel(requestId: string, text: string, opts?: { force?: boolean; tool?: boolean; done?: boolean }): boolean;
  activityFor(name: string, args: unknown): string;
  upsertTool(t: Target, msg: ToolStatusMessage): void;
}

// ----- Handler -------------------------------------------------------------

export function handleToolStatus(ctx: ToolStatusContext, msg: ToolStatusMessage): void {
  const t = ctx.ensureTarget(msg.requestId);
  if (msg.state === 'running') {
    t.activeTool = msg.toolCallId;
    ctx.setStatusLabel(msg.requestId, ctx.activityFor(msg.name, msg.args), { tool: true });
  } else if (msg.toolCallId && msg.toolCallId === t.activeTool) {
    t.activeTool = null;
    ctx.setStatusLabel(msg.requestId, t._wasStreamed ? 'Responding…' : 'Thinking…', { done: true });
  }
  const isNew = !t.flow.querySelector(`[data-tc="${msg.toolCallId}"]`);
  ctx.upsertTool(t, msg);
  if (isNew) t.currentText = null;
}
