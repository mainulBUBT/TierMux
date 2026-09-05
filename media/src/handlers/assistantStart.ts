/* Handler for 'assistantStart': creates the assistant bubble, sets the model metadata and the
 * "Thinking…" label, starts the elapsed timer. */

// ----- Types ---------------------------------------------------------------

/**
 * Message from the extension host when the assistant starts responding.
 */
export interface AssistantStartMessage {
  type: 'assistantStart';
  requestId: string;
  platform?: string;
  model?: string;
}

/**
 * Target object represents the assistant message bubble and its DOM structure.
 * This is a subset of the full Target type - only what this handler needs.
 *
 * In the full implementation, Target has many more properties (statusEl, flow, etc.),
 * but this handler only needs el, body, and model (metadata).
 */
export interface Target {
  el: HTMLElement;         // .msg container
  body: HTMLElement;       // .bubble (main content area)
  model: string;          // "platform/model" display string
}

// ----- Context ---------------------------------------------------------------

/** Only the capabilities this handler needs — not the full HandlerContext. */
export interface AssistantStartContext {
  /**
   * Get or create the Target object for this requestId.
   * This is a factory that creates the DOM structure if needed.
   */
  ensureTarget(requestId: string, platform?: string, model?: string): Target;

  /**
   * Set the status label for the working indicator.
   * Used to show "Thinking…" while the assistant processes the request.
   */
  setStatusLabel(requestId: string, text: string, opts?: { force?: boolean; tool?: boolean; done?: boolean }): boolean;

  /**
   * Start the elapsed time timer for the status indicator.
   * Shows "Working. Ns" while the assistant processes.
   */
  startStatusTimer(requestId: string): void;
}

// ----- Handler ---------------------------------------------------------------

/** Handle 'assistantStart' from the extension host. */
export function handleAssistantStart(ctx: AssistantStartContext, msg: AssistantStartMessage): void {
  const t = ctx.ensureTarget(msg.requestId, msg.platform, msg.model);
  // Set the model metadata so the footer shows which model produced the answer
  if (msg.model) t.model = `${msg.platform || ''}/${msg.model}`;
  // Show "Thinking…" status while the assistant processes
  ctx.setStatusLabel(msg.requestId, 'Thinking…', { force: true });
  // Start tracking elapsed time for "Worked for Ns" display
  ctx.startStatusTimer(msg.requestId);
}
