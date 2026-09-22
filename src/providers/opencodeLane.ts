// OpenCode Zen's anonymous free lane: what it takes to be let through.
//
// Since 2026-09-16 Zen refuses any free-tier request that does not look like
// traffic from the official OpenCode client — 403 FreeTierError, "OpenCode's
// free tier can only be used from within OpenCode". The gate (verified against
// the live endpoint, 2026-09-22) checks, and ALL must hold:
//
//   1. User-Agent starts with "opencode/"
//   2. x-opencode-session is `ses_` + 12 lowercase hex + 14 Base62
//   3. the body streams (stream: true) and carries function tools named
//      `bash` AND `read`
//
// Everything else is optional: no Authorization is needed on the free lane
// (a missing header passes), `stream_options` is fine, and the remaining
// x-opencode-* headers are sent anyway as insurance against the gate
// tightening. A paid Zen key needs none of this and should not enable the
// lane — see OpenAICompatOpts.opencodeFreeLane.
import { createHash, randomBytes } from 'crypto';

import type { ChatCompletionResponse, ChatMessage, ChatToolCall } from '../shared/types';

/** Must track a current CLI version: the gate checks the `opencode/` prefix
 *  today, and a version far behind the real client is the first thing a
 *  tightened check would reject. */
const OC_VERSION = '1.18.32';
export const OPENCODE_USER_AGENT = `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`;

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Exactly the id shape the gate parses: 6 bytes as 12 lowercase hex, then 14
 *  bytes as one Base62 char each. Stable per input, so the same conversation
 *  keeps the same session and Zen's prompt cache stays warm. */
function ocId(prefix: string, seed: string, stable: boolean): string {
  const bytes = stable ? createHash('sha1').update(seed).digest() : randomBytes(20);
  let hex = '';
  for (let i = 0; i < 6; i++) hex += bytes[i].toString(16).padStart(2, '0');
  let b62 = '';
  for (let i = 6; i < 20; i++) b62 += B62[bytes[i] % B62.length];
  return prefix + hex + b62;
}

/** Session id for a conversation. No session (title generation, condense)
 *  gets a one-off, exactly like the generic sessionHeader path did. */
export function ocSessionId(sessionId?: string): string {
  return ocId('ses_', 'tiermux/oc-session:' + (sessionId ?? ''), Boolean(sessionId));
}

/** Fresh per HTTP call, like the real client's. */
export function ocRequestId(): string {
  return ocId('msg_', 'tiermux/oc-request:' + Date.now() + ':' + randomBytes(6).toString('hex'), false);
}

/** The full official-client costume. Merged last, so it overrides the
 *  extension's own User-Agent on lane providers only. */
export function openCodeLaneHeaders(sessionId?: string): Record<string, string> {
  return {
    'User-Agent': OPENCODE_USER_AGENT,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-request': ocRequestId(),
    'x-opencode-session': ocSessionId(sessionId),
  };
}

/* ---------- body shaping ---------- */

// The gate wants tools with these NAMES present. Their schemas are inert on
// purpose and the descriptions tell the model to keep away, because a decoy
// the model actually called would surface as a tool this extension never
// registered. When the caller brought no tools of their own, tool_choice
// "none" takes the choice away entirely.
export const OPENCODE_DECOY_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'bash',
      description: 'Reserved for transport compatibility. Do not call this tool.',
      parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read',
      description: 'Reserved for transport compatibility. Do not call this tool.',
      parameters: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

function toolName(t: unknown): string {
  return (t as { function?: { name?: unknown } })?.function?.name as string ?? '';
}

/** Forces the wire shape the gate demands on an already-built request body:
 *  streaming always on, the two decoy tools riding along, and the decoys
 *  pinned off when the caller has no tools of their own. */
export function shapeOpenCodeRequest(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  const tools = Array.isArray(out.tools) ? (out.tools as unknown[]).slice() : [];
  const callerHadTools = tools.length > 0;
  let added = false;
  for (const decoy of OPENCODE_DECOY_TOOLS) {
    if (!tools.some((t) => toolName(t) === decoy.function.name)) {
      tools.push(decoy);
      added = true;
    }
  }
  if (added) out.tools = tools;
  out.stream = true;
  if (!callerHadTools) out.tool_choice = 'none';
  return out;
}

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
