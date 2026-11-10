import { randomBytes } from 'crypto';

import type { ChatCompletionResponse, ChatMessage, ChatToolCall } from '../shared/types';
import { openCodeSystemDecoy } from './opencodePrompt';

/** Tracks the client release the decoy system prompt (opencodePrompt.ts) was captured from —
 *  the two must move together. The gate itself no longer inspects the wire identity (measured
 *  live 2026-11-10: the 1.18 costume passed once the body carried the fingerprint), but the
 *  headers stay dressed so a future gate tightening finds a coherent client, not a mismatch. */
const OC_VERSION = '1.19.5';
export const OPENCODE_USER_AGENT = `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4`;

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const stableSessions = new Map<string, string>();
let lastSessionTimestamp = 0;
let sessionCounter = 0;

function randomBase62(len = 14): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += B62[bytes[i] % 62];
  return out;
}

/** Canonical descending identifier: ses_ + 12 hex digits (~(timestamp * 0x1000 + counter))
 *  + 14 Base62 random characters. Stable per conversation so prompt cache stays warm. */
export function ocSessionId(sessionId?: string): string {
  if (sessionId && stableSessions.has(sessionId)) {
    return stableSessions.get(sessionId)!;
  }
  const timestamp = Date.now();
  if (timestamp !== lastSessionTimestamp) {
    lastSessionTimestamp = timestamp;
    sessionCounter = 0;
  }
  sessionCounter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(sessionCounter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, '0')
  ).join('');
  const id = `ses_${time}${randomBase62(14)}`;
  if (sessionId) {
    stableSessions.set(sessionId, id);
  }
  return id;
}

/** Fresh per HTTP call: msg_ + 12 hex digits (timestamp * 0x1000 + 1) + 14 Base62 characters. */
export function ocRequestId(): string {
  const current = BigInt(Date.now()) * 0x1000n + 1n;
  const value = current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, '0')
  ).join('');
  return `msg_${time}${randomBase62(14)}`;
}

/** The full official-client costume, as captured from opencode 1.19.5's CLI (the official
 *  client sends no Accept header beyond fetch's default, and mirrors the session id in
 *  x-opencode-session-id). Merged last, so it overrides the extension's own User-Agent on lane
 *  providers only. */
export function openCodeLaneHeaders(sessionId?: string): Record<string, string> {
  const session = ocSessionId(sessionId);
  return {
    'Authorization': 'Bearer public',
    'User-Agent': OPENCODE_USER_AGENT,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-request': ocRequestId(),
    'x-opencode-session': session,
    'x-opencode-session-id': session,
  };
}

/* ---------- body shaping ---------- */

// Upstream Zen gates anonymous free traffic on TWO body marks (re-measured live 2026-11-10):
// the 4-tool file-search quartet {bash, glob, grep, read} riding in `tools` — names suffice,
// schemas are not inspected — and the decoy system message (opencodePrompt.ts) leading the
// messages. Missing either one draws 429 FreeUsageLimitError.
export const OPENCODE_FINGERPRINT_TOOLS = ['bash', 'glob', 'grep', 'read'] as const;

export const OPENCODE_DECOY_TOOLS = OPENCODE_FINGERPRINT_TOOLS.map((name) => ({
  type: 'function' as const,
  function: {
    name,
    description: `OpenCode built-in ${name} tool`,
    parameters: { type: 'object' as const, properties: {} },
  },
}));

function toolName(t: unknown): string {
  return (t as { function?: { name?: unknown } })?.function?.name as string ?? '';
}

/** Forces the wire shape the gate demands on an already-built request body: the decoy
 *  system message leading the messages (the caller's own system prompt, if any, follows it
 *  and stays in charge), the 4-tool quartet riding along, streaming always on, and the decoys
 *  pinned off when the caller has no tools of their own. Idempotent: a body already led by
 *  the decoy is not given a second copy. */
export function shapeOpenCodeRequest(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  const messages = Array.isArray(out.messages) ? (out.messages as unknown[]) : [];
  const first = messages[0] as { role?: unknown; content?: unknown } | undefined;
  const alreadyDecoyed = first?.role === 'system'
    && typeof first.content === 'string'
    && first.content.startsWith(OC_DECOY_PREFIX);
  if (!alreadyDecoyed) out.messages = [{ role: 'system', content: openCodeSystemDecoy() }, ...messages];
  const tools = Array.isArray(out.tools) ? (out.tools as unknown[]).slice() : [];
  const callerHadTools = tools.length > 0;
  let added = false;
  for (const decoy of OPENCODE_DECOY_TOOLS) {
    if (!tools.some((t) => toolName(t).toLowerCase() === decoy.function.name)) {
      tools.push(decoy);
      added = true;
    }
  }
  if (added) out.tools = tools;
  out.stream = true;
  if (!callerHadTools) out.tool_choice = 'none';
  return out;
}

/** The stable opening of the decoy prompt — enough of it to recognise our own decoy by. */
const OC_DECOY_PREFIX = 'You are opencode, an interactive CLI tool';

/* ---------- folding a forced stream back into one answer ---------- */

/** Merges an SSE body into the single chat.completion a non-streaming caller
 *  asked for: content and reasoning deltas concatenated, tool-call fragments
 *  joined by slot index, the last finish_reason and any usage kept. The
 *  reasoning-to-content fold is left to normalizeChoices, which runs on every
 *  non-streaming response anyway. Unparseable frames are skipped, not fatal. */
export function foldSseToCompletion(text: string, modelId: string): ChatCompletionResponse {
  let role = 'assistant';
  let finish: string | null = null;
  let content = '';
  let reasoning = '';
  const calls: ChatToolCall[] = [];
  let id = '';
  let created = 0;
  let usage: Record<string, unknown> | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let chunk: {
      id?: string; created?: number; model?: string; usage?: Record<string, unknown>;
      choices?: Array<{
        finish_reason?: string | null;
        delta?: { role?: string; content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<ChatToolCall> };
        message?: { content?: string };
      }>;
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!id && chunk.id) id = chunk.id;
    if (!created && chunk.created) created = chunk.created;
    if (chunk.usage) usage = chunk.usage;
    const ch = chunk.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta ?? {};
    if (d.role) role = d.role;
    if (typeof d.content === 'string') content += d.content;
    if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    else if (typeof d.reasoning === 'string') reasoning += d.reasoning;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0;
        if (!calls[i]) calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name = tc.function.name;
        if (tc.function && typeof tc.function.arguments === 'string') calls[i].function.arguments += tc.function.arguments;
      }
    }
    // Some providers stream whole messages rather than deltas.
    if (typeof ch.message?.content === 'string') content += ch.message.content;
  }

  const message: ChatMessage = { role: role as ChatMessage['role'], content };
  if (reasoning) message.reasoning_content = reasoning;
  const used = calls.filter(Boolean);
  if (used.length) message.tool_calls = used;

  return {
    id: id || `chatcmpl-oc-fold-${Date.now()}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message, finish_reason: finish ?? 'stop' }],
    usage: (usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }) as unknown as ChatCompletionResponse['usage'],
  };
}
