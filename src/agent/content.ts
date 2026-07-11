
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

/** A visual/file attachment reduced to the fields every consumer actually needs —
 *  mime and filename are always already known (threaded from `Attachment` at
 *  attach time), never re-derived by parsing the `url`. */
export interface AttachmentBlock {
  mime: string;
  filename?: string;
  url: string;
}

/**
 * Pull `image_url`/`file` blocks out of a message's content, in order, as a common
 * shape. This is the ONLY place in the extension that knows `image_url` and `file`
 * are two different `ChatContentBlock` shapes for the same idea (an attachment) —
 * every other consumer (routing signals, the OC transport mapper) reads the
 * normalized `{mime, filename, url}` instead of branching on block type itself.
 */
export function normalizeAttachmentBlocks(content: ChatContent): AttachmentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: AttachmentBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; image_url?: { url?: unknown; mime?: unknown; filename?: unknown }; file?: { file_data?: unknown; mime?: unknown; filename?: unknown } };
    if (b.type === 'image_url' && typeof b.image_url?.url === 'string') {
      out.push({
        mime: typeof b.image_url.mime === 'string' ? b.image_url.mime : 'application/octet-stream',
        filename: typeof b.image_url.filename === 'string' ? b.image_url.filename : undefined,
        url: b.image_url.url,
      });
    } else if (b.type === 'file' && typeof b.file?.file_data === 'string') {
      out.push({
        mime: typeof b.file.mime === 'string' ? b.file.mime : 'application/octet-stream',
        filename: typeof b.file.filename === 'string' ? b.file.filename : undefined,
        url: b.file.file_data,
      });
    }
  }
  return out;
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
