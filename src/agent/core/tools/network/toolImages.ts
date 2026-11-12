// Images a tool shows the MODEL (not the UI): execute() stores a JPEG under its tool call id and
// returns the usual string; toModelOutput attaches it as a file part. The router sends those
// pixels only to candidates that read images and turns them into a note for the rest
// (routerProvider: toRouterMessages / withoutToolImages), so a tool can always attach.

import type { ToolResultOutput } from '@ai-sdk/provider-utils';

const images = new Map<string, string>();
/** Bound on unconsumed images (a call whose result never reached the model). */
const MAX_PENDING = 8;

export function keepToolImage(toolCallId: string | undefined, base64Jpeg: string): void {
  if (!toolCallId) return;
  images.set(toolCallId, base64Jpeg);
  while (images.size > MAX_PENDING) images.delete(images.keys().next().value as string);
}

/** toModelOutput body: text alone, or text + the stored image with `hint` appended. */
export function toolImageOutput(toolCallId: string, output: unknown, hint: string): ToolResultOutput {
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  const img = images.get(toolCallId);
  images.delete(toolCallId);
  if (!img || typeof output !== 'string') return { type: 'text', value: text };
  return {
    type: 'content',
    value: [
      { type: 'text', text: `${text}\n${hint}` },
      { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: img } },
    ],
  };
}
