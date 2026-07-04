/* Handler for 'todos' messages - renders task list in assistant message bubble.
 *
 * This is Phase D2's first extracted handler (PR5.0).
 *
 * Dependencies (via focused TodosContext):
 * - ensureTarget: Get or create the Target object for this requestId
 * - renderTodos: Render the todo list into the Target's DOM
 *
 * Context: This handler only touches the Target object's body (via renderTodos).
 * It does not mutate any other state.
 */

// ----- Types ---------------------------------------------------------------

/**
 * Todo item from the agent's task list.
 */
export interface Todo {
  status: 'completed' | 'in_progress' | 'pending';
  content: string;
}

/**
 * Message from the extension host containing the todo list.
 */
export interface TodosMessage {
  type: 'todos';
  requestId: string;
  todos: Todo[];
  followingPlan?: boolean;
}

/**
 * Target object represents the assistant message bubble and its DOM structure.
 * This is a subset of the full Target type - only what this handler needs.
 *
 * In the full implementation, Target has many more properties (statusEl, flow, etc.),
 * but this handler only uses the body via renderTodos.
 */
export interface Target {
  el: HTMLElement;         // .msg container
  body: HTMLElement;       // .bubble (main content area)
  todoEl?: HTMLElement;   // .todo-list (created lazily by renderTodos)
}

// ----- Context ---------------------------------------------------------------

/**
 * Focused context for the todos handler.
 *
 * This is NOT the full HandlerContext - it only exposes the 2 capabilities
 * this handler needs. This is the beginning of context segregation (PR7).
 *
 * Why this matters:
 * - If we exported the full HandlerContext, we'd propagate the God Object
 * - By using a focused interface, we keep the handler decoupled
 * - Future handlers can define their own focused contexts
 * - Eventually we'll split HandlerContext into focused interfaces (PR7)
 */
export interface TodosContext {
  /**
   * Get or create the Target object for this requestId.
   * This is a factory that creates the DOM structure if needed.
   */
  ensureTarget(requestId: string): Target;

  /**
   * Render the todo list into the Target's body.
   * This handles all DOM manipulation for the todo list.
   */
  renderTodos(target: Target, todos: Todo[], followingPlan: boolean): void;
}

// ----- Handler ---------------------------------------------------------------

/**
 * Handle the 'todos' message from the extension host.
 *
 * This renders the agent's current task list into the assistant message bubble.
 * The todo list shows:
 * - Number of completed tasks (e.g., "Tasks · 2/5")
 * - Each task with its status (✓ for completed, ○ for pending, spinner for in_progress)
 * - Optional "Following the approved plan" header
 *
 * @param ctx - Focused context with only the capabilities this handler needs
 * @param msg - Message containing the todo list from the host
 */
export function handleTodos(ctx: TodosContext, msg: TodosMessage): void {
  const t = ctx.ensureTarget(msg.requestId);
  ctx.renderTodos(t, msg.todos || [], !!msg.followingPlan);
}
