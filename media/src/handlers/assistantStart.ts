/* Handler for 'assistantStart' messages - initializes assistant message bubble.
 *
 * This is Phase D2's second extracted handler (PR5.1).
 *
 * Dependencies (via focused AssistantStartContext):
 * - ensureTarget: Get or create the Target object for this requestId
 * - setStatusLabel: Set the "Thinking…" status label
 * - startStatusTimer: Start the elapsed time timer
 *
 * Context: This handler initializes the Target state (model, status, timer).
 * It performs minimal Target mutation (t.model) which is metadata only.
 */

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

/**
 * Focused context for the assistantStart handler.
 *
 * This is NOT the full HandlerContext - it only exposes the 3 capabilities
 * this handler needs. This continues the context segregation pattern (PR7).
 *
 * Why this matters:
 * - If we exported the full HandlerContext, we'd propagate the God Object
 * - By using a focused interface, we keep the handler decoupled
 * - Future handlers can define their own focused contexts
 * - Eventually we'll split HandlerContext into focused interfaces (PR7)
 */
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

/**
 * Handle the 'assistantStart' message from the extension host.
 *
 * This initializes the assistant message bubble when the agent starts responding.
 * It performs the following actions:
 * - Gets or creates the Target object for this requestId
 * - Sets the model metadata (platform/model)
 * - Displays "Thinking…" status label
 * - Starts the elapsed time timer
 *
 * @param ctx - Focused context with only the 3 capabilities this handler needs
 * @param msg - Message containing the start signal and model info
 */
export function handleAssistantStart(ctx: AssistantStartContext, msg: AssistantStartMessage): void {
  const t = ctx.ensureTarget(msg.requestId, msg.platform, msg.model);
  // Set the model metadata so the footer shows which model produced the answer
  if (msg.model) t.model = `${msg.platform || ''}/${msg.model}`;
  // Show "Thinking…" status while the assistant processes
  ctx.setStatusLabel(msg.requestId, 'Thinking…', { force: true });
  // Start tracking elapsed time for "Worked for Ns" display
  ctx.startStatusTimer(msg.requestId);
}
