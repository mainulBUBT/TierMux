/* Handler for 'agentStep': updates the live status label during a run and scrolls the
 * activity into view. `ensureTarget` is called for its side effect (creating the bubble). */

// ----- Types ---------------------------------------------------------------

/**
 * Message from the extension host carrying an explicit agent status update.
 * An explicit status message wins over the rolling activity verb when present.
 */
export interface AgentStepMessage {
  type: 'agentStep';
  requestId: string;
  label?: string;
}

// ----- Context ---------------------------------------------------------------

/**
 * Focused context for the agentStep handler.
 *
 * This is NOT the full HandlerContext - it only exposes the 4 capabilities
 * this handler needs. This continues the context segregation pattern (PR7).
 */
export interface AgentStepContext {
  /**
   * Get or create the Target object for this requestId.
   * Called for its side-effect (DOM creation); return value unused here.
   */
  ensureTarget(requestId: string): unknown;

  /**
   * Set the status label for the working indicator.
   * An explicit label wins over the rolling activity verb.
   */
  setStatusLabel(requestId: string, text: string, opts?: { force?: boolean; tool?: boolean; done?: boolean }): boolean;

  /**
   * Start (or ensure running) the elapsed time timer for the status indicator.
   */
  startStatusTimer(requestId: string): void;

  /**
   * Scroll the thread so the latest activity is visible.
   */
  scrollDown(): void;
}

// ----- Handler ---------------------------------------------------------------

/** Handle 'agentStep': an explicit msg.label wins over the current activity label. */
export function handleAgentStep(ctx: AgentStepContext, msg: AgentStepMessage): void {
  // ensureTarget is called for its side-effect (creates the bubble if needed);
  // we don't use the returned Target, so no need to capture it.
  ctx.ensureTarget(msg.requestId);
  // An explicit status message wins; otherwise leave the current activity label.
  if (msg.label) ctx.setStatusLabel(msg.requestId, msg.label, { force: true });
  ctx.startStatusTimer(msg.requestId);
  ctx.scrollDown();
}
