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

/** True if a block is a visual attachment (image_url, image, or our PDF file block). */
function isVisualBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const t = (block as { type?: string })?.type;
  return t === 'image_url' || t === 'image' || t === 'file';
}

/**
 * For OpenAI-compat providers that don't accept our `file` (PDF) block, drop
 * non-text blocks and keep only the text parts. We don't want to lose the text
 * of the conversation (which contains the attachment's extracted text already),
 * but we do want to drop the raw PDF data URL — it's wasted bandwidth and
 * the provider would just 400.
 */
export function stripVisualBlocks(content: ChatContent): ChatContent {
  if (!Array.isArray(content)) return content;
  const textOnly: Array<{ type: 'text'; text: string }> = [];
  for (const block of content) {
    if (typeof block === 'string') {
      textOnly.push({ type: 'text', text: block });
      continue;
    }
    if (isVisualBlock(block)) continue;
    if ((block as { type?: string })?.type === 'text' && typeof (block as { text?: unknown })?.text === 'string') {
      textOnly.push({ type: 'text', text: (block as { text: string }).text });
    }
  }
  return textOnly;
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

/** True if the content array carries an image or PDF file block. Used to
 *  decide whether the user needs a vision-capable model for this turn. */
export function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const type = (block as { type?: string })?.type;
    return type === 'image_url' || type === 'image' || type === 'file';
  });
}

export function messagesHaveImage(messages: ChatMessage[]): boolean {
  return messages.some((m) => contentHasImage(m.content));
}

/** Split a leading `<think>…</think>` reasoning block from message text. */
export function splitReasoning(text: string): { reasoning?: string; content: string } {
  const m = /^\s*<think>([\s\S]*?)<\/think>\s*/i.exec(text);
  if (m) return { reasoning: m[1].trim(), content: text.slice(m[0].length).trim() };
  return { content: text };
}
