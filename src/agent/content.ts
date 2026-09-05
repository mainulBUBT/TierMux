
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

/** A visual/file attachment reduced to what consumers need. `mime` is recovered from the `data:`
 *  URL header when missing/generic — otherwise an image mis-routes as a text `doc` and the
 *  vision path never fires. */
export interface AttachmentBlock {
  mime: string;
  filename?: string;
  url: string;
}

/** Recover a MIME type from a `data:<mime>;base64,...` URL header; '' if not a data URL. */
function mimeFromDataUrl(url: unknown): string {
  return typeof url === 'string' ? (url.match(/^data:([^;,]+)/)?.[1] ?? '') : '';
}

/** Most-specific MIME available: an explicit, non-empty, non-generic value wins;
 *  otherwise recover it from the data-URL header; else generic octet-stream. */
function resolveMime(explicit: unknown, url: unknown): string {
  if (typeof explicit === 'string' && explicit && explicit !== 'application/octet-stream') return explicit;
  return mimeFromDataUrl(url) || 'application/octet-stream';
}

/** Pull `image_url`/`file` blocks out of a message's content as one normalized
 *  `{mime, filename, url}` shape — the only place that knows they are two block types. */
export function normalizeAttachmentBlocks(content: ChatContent): AttachmentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: AttachmentBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; image_url?: { url?: unknown; mime?: unknown; filename?: unknown }; file?: { file_data?: unknown; mime?: unknown; filename?: unknown } };
    if (b.type === 'image_url' && typeof b.image_url?.url === 'string') {
      out.push({
        mime: resolveMime(b.image_url.mime, b.image_url.url),
        filename: typeof b.image_url.filename === 'string' ? b.image_url.filename : undefined,
        url: b.image_url.url,
      });
    } else if (b.type === 'file' && typeof b.file?.file_data === 'string') {
      out.push({
        mime: resolveMime(b.file.mime, b.file.file_data),
        filename: typeof b.file.filename === 'string' ? b.file.filename : undefined,
        url: b.file.file_data,
      });
    }
  }
  return out;
}

/** Wire shape for OpenAI-compat endpoints: drop `type: 'file'` blocks (the extracted text is
 *  already in the message) and narrow `image_url` to `{ url }` — extra fields make
 *  schema-validating gateways 400. */
export function stripFileBlocks(content: ChatContent): ChatContent {
  if (!Array.isArray(content)) return content;
  const out: ChatContent = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') { out.push(block as never); continue; }
    const b = block as { type?: string; image_url?: { url?: unknown } };
    if (b.type === 'file') continue;
    if (b.type === 'image_url' && typeof b.image_url?.url === 'string') {
      out.push({ type: 'image_url', image_url: { url: b.image_url.url } } as never);
      continue;
    }
    out.push(block as never);
  }
  return out;
}

/** Split a leading `<think>…</think>` or `<thinking>…</thinking>` reasoning block from message text. */
export function splitReasoning(text: string): { reasoning?: string; content: string } {
  const m = /^\s*<(think|thinking|thought|reasoning)>([\s\S]*?)<\/(?:think|thinking|thought|reasoning)>\s*/i.exec(text);
  if (m) return { reasoning: m[2].trim(), content: text.slice(m[0].length).trim() };
  return { content: text };
}
