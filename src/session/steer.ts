// Should a message that arrived while a turn was RUNNING be steered into that turn, or queued to
// start a turn of its own? Pure — the host (chatViewProvider's sendMessage handler) only supplies
// the facts. Run: npm run test:e2e:steer
import { parseSlash } from '../context/mentions';

export interface SteerInput {
  /** A turn is running AND its model loop can take a message right now (the engine's
   *  onSteerReady handle; it resolves false by itself once no loop is there). */
  canSteer: boolean;
  text: string;
  /** Attachments on the message. */
  attachments: number;
  /** The mode the running turn was started in; undefined when none is recorded. */
  runningMode: string | undefined;
  /** The mode this message asks for. */
  sentMode: string;
}

/** Why a mid-turn message was NOT steered — for the "why did this queue?" case, and for tests. */
export type SteerDecision = 'steer' | 'no-running-loop' | 'slash-command' | 'attachments' | 'mode-change';

/**
 * Steering (ai v7): a steered message joins the model's input at the turn's NEXT step boundary
 * instead of waiting for the whole turn — an agent turn can run for minutes. It is only correct
 * when the message means "do this as part of what you are doing". A slash command, an attachment
 * or a mode change is a new request, so those queue exactly as before (they start their own turn
 * once this one settles).
 */
export function steerDecision(i: SteerInput): SteerDecision {
  if (!i.canSteer) return 'no-running-loop';
  if (parseSlash(i.text)) return 'slash-command';
  if (i.attachments > 0) return 'attachments';
  if (i.runningMode !== undefined && i.runningMode !== i.sentMode) return 'mode-change';
  return 'steer';
}

export function shouldSteer(i: SteerInput): boolean {
  return steerDecision(i) === 'steer';
}
