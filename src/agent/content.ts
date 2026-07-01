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

/**
 * Drop only `type: 'file'` blocks (PDFs we attached as native file data) but
 * keep `image_url` blocks. OpenAI-compat providers that DO support vision
 * (Groq Llama Vision, Mistral Pixtral, OpenRouter, etc.) accept `image_url`
 * natively — only our `file` envelope is unknown to them, so strip it and
 * rely on the PDF's extracted text already embedded in the user message.
 */
export function stripFileBlocks(content: ChatContent): ChatContent {
  if (!Array.isArray(content)) return content;
  const out: ChatContent = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'file') continue;
    out.push(block as never);
  }
  return out;
}

/** Split a leading `<think>…</think>` reasoning block from message text. */
export function splitReasoning(text: string): { reasoning?: string; content: string } {
  const m = /^\s*<think>([\s\S]*?)<\/think>\s*/i.exec(text);
  if (m) return { reasoning: m[1].trim(), content: text.slice(m[0].length).trim() };
  return { content: text };
}
