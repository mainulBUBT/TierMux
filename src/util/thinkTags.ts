// Text/stream utilities — pure functions and one state machine, no vscode, no providers.
//
//   · clampOutputToContext — cap a requested max_tokens against the model's window
//   · ThinkStripper        — split-tag-safe <think> separation (chat text vs reasoning)
//   · stripThinkTags       — one-shot form of the above
//   · reasoningFromDelta   — read the reasoning channel out of an OpenAI-shaped delta
//
// Every provider dialect is covered by scripts/thinkSplit.e2e.ts; do not inline a regex
// version of any of this anywhere else.

/** Lower an output-token request to something a small local context can actually honour. Returns
 *  `want` unchanged when there is no known window or the window is comfortable — this only ever
 *  shrinks, so it cannot make a cloud model's budget worse. */
export function clampOutputToContext(want: number, contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0) return want;
  const cap = Math.max(512, Math.floor(contextWindow / 4));
  return Math.min(want, cap);
}

/**
 * Streaming `<think>…</think>` stripper. Buffers incoming deltas and emits only
 * the non-reasoning text. Handles tags that span multiple chunks, dangling
 * opening tags (incomplete at stream end), and nested/multiple think blocks.
 *
 * Some models (Qwen3, DeepSeek-R1, etc.) emit reasoning inside `<think>` tags
 * directly in the content stream. Without stripping, the client sees the raw
 * reasoning markup alongside the actual answer.
 */
const THINK_OPEN_RE = /<(think|thinking|thought|reasoning)>/i;
const THINK_CLOSE_RE = /<\/(think|thinking|thought|reasoning)>/i;
const OPEN_TAG_PREFIXES = ['<think>', '<thinking>', '<thought>', '<reasoning>'];
const CLOSE_TAG_PREFIXES = ['</think>', '</thinking>', '</thought>', '</reasoning>'];
export class ThinkStripper {
  private buf = '';
  private insideThink = false;

  feed(delta: string): string {
    return this.feedParts(delta).text;
  }

  /** Same state machine as feed(), but separates BOTH channels: text outside think blocks
   *  (chat answer) and text INSIDE them (reasoning) — so a `<think>`-style model's thinking
   *  can be surfaced as reasoning instead of being discarded. Split-tag safe exactly like
   *  feed(): partial `<thi` / `</thi` tails at the buffer end are held back. */
  feedParts(delta: string): { text: string; reasoning: string } {
    this.buf += delta;
    let text = '';
    let reasoning = '';

    while (this.buf.length > 0) {
      if (this.insideThink) {
        const closeMatch = THINK_CLOSE_RE.exec(this.buf);
        if (!closeMatch) {
          let safeCut = this.buf.length;
          const lower = this.buf.toLowerCase();
          for (let i = Math.max(0, lower.length - 12); i < lower.length; i++) {
            const tail = lower.slice(i);
            if (CLOSE_TAG_PREFIXES.some((p) => p.startsWith(tail))) {
              safeCut = i;
              break;
            }
          }
          reasoning += this.buf.slice(0, safeCut);
          this.buf = this.buf.slice(safeCut);
          break;
        }

        reasoning += this.buf.slice(0, closeMatch.index);
        this.buf = this.buf.slice(closeMatch.index + closeMatch[0].length);
        this.insideThink = false;
        continue;
      }

      const openMatch = THINK_OPEN_RE.exec(this.buf);
      if (!openMatch) {
        let safeUpTo = this.buf.length;
        const lower = this.buf.toLowerCase();
        for (let i = Math.max(0, lower.length - 11); i < lower.length; i++) {
          const tail = lower.slice(i);
          if (OPEN_TAG_PREFIXES.some((p) => p.startsWith(tail))) {
            safeUpTo = Math.min(safeUpTo, i);
          }
        }
        text += this.buf.slice(0, safeUpTo);
        this.buf = this.buf.slice(safeUpTo);
        break;
      }

      text += this.buf.slice(0, openMatch.index);
      this.buf = this.buf.slice(openMatch.index + openMatch[0].length);
      this.insideThink = true;
    }

    return { text, reasoning };
  }

  /** Flush any remaining buffer at stream end. If we're still inside a think block,
   *  discard the buffered reasoning. Otherwise emit any held-back text. */
  flush(): string {
    if (this.insideThink) {
      this.buf = '';
      this.insideThink = false;
      return '';
    }
    const remaining = this.buf;
    this.buf = '';
    return remaining;
  }

  /** Flush separating both channels: an UNCLOSED think block (DeepSeek-R1-style, thinking to
   *  end-of-stream) yields its buffered content as reasoning rather than discarding it. */
  flushParts(): { text: string; reasoning: string } {
    if (this.insideThink) {
      const reasoning = this.buf;
      this.buf = '';
      this.insideThink = false;
      return { text: '', reasoning };
    }
    const text = this.buf;
    this.buf = '';
    return { text, reasoning: '' };
  }
}

/** Strip `<think>…</think>`, `<thinking>…</thinking>`, and other reasoning tags from a response string. */
export function stripThinkTags(text: string): string {
  let result = text;
  result = result.replace(/<(think|thinking|thought|reasoning)>[\s\S]*?<\/\1>/gi, '');
  result = result.replace(/<(think|thinking|thought|reasoning)>[\s\S]*?<\/(think|thinking|thought|reasoning)>/gi, '');
  result = result.replace(/<(think|thinking|thought|reasoning)>[\s\S]*$/i, '');
  result = result.replace(/^[\s\S]*?<\/(think|thinking|thought|reasoning)>/gi, '');
  result = result.replace(/<\/?(think|thinking|thought|reasoning)>/gi, '');
  return result.trim();
}

/** Extract a reasoning delta from a streamed chunk's `delta`. Providers disagree on the field:
 *  `reasoning_content` (DeepSeek/OpenRouter), `reasoning`, or a `reasoning_details` array of
 *  `{ type: 'reasoning.text', text }`. Returns '' when the chunk carries no reasoning. */
export function reasoningFromDelta(delta: Record<string, unknown>): string {
  return reasoningFromDeltaImpl(delta);
}

function reasoningFromDeltaImpl(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) return delta.reasoning_content;
  if (typeof delta.reasoning === 'string' && delta.reasoning) return delta.reasoning;
  const details = delta.reasoning_details;
  if (Array.isArray(details)) {
    let out = '';
    for (const d of details) {
      const t = (d as { text?: unknown }).text;
      if (typeof t === 'string') out += t;
    }
    if (out) return out;
  }
  return '';
}
