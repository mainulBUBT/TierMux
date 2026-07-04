/* Handler for 'agentStep' messages - updates the live status label during a run.
 *
 * This is Phase D2's third extracted handler (PR5.2).
 *
 * Dependencies (via focused AgentStepContext):
 * - ensureTarget: Get or create the Target object for this requestId
 * - setStatusLabel: Set the activity label (e.g. an explicit OC status message)
 * - startStatusTimer: Ensure the elapsed time timer is running
 * - scrollDown: Keep the latest activity in view
 *
 * Context: This handler updates only the status display; it performs NO Target
 * state mutation. Note: `ensureTarget` is called for its side-effect (creating
 * the message bubble if needed); its return value is unused here.
 *
 * Capability count note: 4 capabilities (soft limit). `scrollDown` is required
 * because an explicit agent-step status update should bring the activity feed
 * into view, unlike assistantStart which does not scroll.
 */

// ----- Types ---------------------------------------------------------------

/**
 * Message from the extension host carrying an explicit agent status update.
 * An OpenCode status message wins over the rolling activity verb when present.
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

/**
 * Handle the 'agentStep' message from the extension host.
 *
 * An explicit OC status message (msg.label) wins over the current activity
 * label; otherwise the existing label is left untouched. The timer is ensured
 * running and the view scrolls to the latest activity.
 *
 * @param ctx - Focused context with only the 4 capabilities this handler needs
 * @param msg - Message carrying the optional explicit status label
 */
export function handleAgentStep(ctx: AgentStepContext, msg: AgentStepMessage): void {
  // ensureTarget is called for its side-effect (creates the bubble if needed);
  // we don't use the returned Target, so no need to capture it.
  ctx.ensureTarget(msg.requestId);
  // An explicit OC status message wins; otherwise leave the current activity label.
  if (msg.label) ctx.setStatusLabel(msg.requestId, msg.label, { force: true });
  ctx.startStatusTimer(msg.requestId);
  ctx.scrollDown();
}
