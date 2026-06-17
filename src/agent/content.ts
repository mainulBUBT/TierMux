// Content helpers, adapted from freellmapi's server/src/lib/content.ts (MIT).
import type { ChatContent, ChatMessage } from '../shared/types';

/** Flatten OpenAI multimodal content (string | null | block[]) to plain text. */
export function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        const block = b as { type?: string; text?: unknown };
        if (typeof block?.text === 'string' && (block.type === 'text' || block.type === undefined)) {
          return block.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

export function flattenMessageContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({ ...m, content: contentToString(m.content) as ChatContent }));
}

/** True if the content array carries an image block. */
export function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const type = (block as { type?: string })?.type;
    return type === 'image_url' || type === 'image';
  });
}

export function messagesHaveImage(messages: ChatMessage[]): boolean {
  return messages.some((m) => contentHasImage(m.content));
}
