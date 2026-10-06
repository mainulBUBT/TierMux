import type { ChatMessage, ChatToolCall } from '../shared/types';
import { contentToString } from '../agent/content';

/* Some models are served only on the OpenAI Responses surface (OpenCode Zen's muse-spark-*
 * answer 500 on /chat/completions, 200 on /responses — live 2026-10-06). The provider keeps
 * building a chat body and reading a chat stream; this module translates both directions. */

function inputContent(content: ChatMessage['content']): unknown {
  if (!Array.isArray(content)) return contentToString(content);
  const parts: unknown[] = [];
  for (const block of content as Array<{ type?: string; text?: unknown; image_url?: { url?: unknown } }>) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push({ type: 'input_text', text: block.text });
    else if (block?.type === 'image_url' && typeof block.image_url?.url === 'string') parts.push({ type: 'input_image', image_url: block.image_url.url });
  }
  return parts;
}

function toInput(messages: ChatMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: contentToString(m.content) });
    } else if (m.role === 'assistant') {
      const text = contentToString(m.content);
      if (text) items.push({ role: 'assistant', content: text });
      for (const tc of m.tool_calls ?? []) {
        items.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
      }
    } else {
      items.push({ role: m.role, content: inputContent(m.content) });
    }
  }
  return items;
}

/** A finished chat-completions body, re-expressed for /responses. Always streamed. Zen accepts
 *  only "auto" for tool_choice there (400 for "none"), so any other value is dropped. */
export function chatBodyToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const tools = Array.isArray(body.tools)
    ? (body.tools as Array<{ function: { name: string; description?: string; parameters?: unknown } }>).map((t) => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }))
    : undefined;
  const effort = body.reasoning_effort ?? (body.reasoning as { effort?: unknown } | undefined)?.effort;
  return {
    model: body.model,
    input: toInput((body.messages as ChatMessage[]) ?? []),
    ...(tools ? { tools } : {}),
    ...(body.tool_choice === 'auto' ? { tool_choice: 'auto' } : {}),
    ...(body.parallel_tool_calls !== undefined ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.max_tokens !== undefined ? { max_output_tokens: body.max_tokens } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    stream: true,
  };
}

interface ResponsesEvent {
  type?: string;
  output_index?: number;
  delta?: string;
  arguments?: string;
  item?: { type?: string; call_id?: string; name?: string; arguments?: string };
  response?: {
    id?: string;
    status?: string;
    incomplete_details?: { reason?: string } | null;
    error?: { message?: string } | null;
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
  };
  message?: string;
}

/** Re-frames a /responses event stream as chat.completion.chunk SSE, so the shared reader and
 *  the non-stream fold consume it unchanged. A failure event becomes the error frame
 *  readSseStream already turns into a ProviderHttpError. */
export function responsesSseAsChatSse(res: Response, modelId: string): Response {
  if (!res.body) return res;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const created = Math.floor(Date.now() / 1000);
  let id = `chatcmpl-resp-${Date.now()}`;
  let buffer = '';
  const slots = new Map<number, { slot: number; args: string }>();

  const frame = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown): string =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  const call = (c: Partial<ChatToolCall> & { index: number }): Record<string, unknown> => ({ tool_calls: [c] });

  const translate = (ev: ResponsesEvent): string => {
    switch (ev.type) {
      case 'response.created':
        if (ev.response?.id) id = ev.response.id;
        return '';
      case 'response.output_text.delta':
        return ev.delta ? frame({ content: ev.delta }) : '';
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta':
        return ev.delta ? frame({ reasoning_content: ev.delta }) : '';
      case 'response.output_item.added': {
        if (ev.item?.type !== 'function_call' || ev.output_index === undefined) return '';
        const s = { slot: slots.size, args: ev.item.arguments ?? '' };
        slots.set(ev.output_index, s);
        return frame(call({ index: s.slot, id: ev.item.call_id ?? '', type: 'function', function: { name: ev.item.name ?? '', arguments: s.args } }));
      }
      case 'response.function_call_arguments.delta': {
        const s = slots.get(ev.output_index ?? -1);
        if (!s || !ev.delta) return '';
        s.args += ev.delta;
        return frame(call({ index: s.slot, function: { name: '', arguments: ev.delta } }));
      }
      case 'response.function_call_arguments.done': {
        // Some servers send the arguments only here.
        const s = slots.get(ev.output_index ?? -1);
        if (!s || s.args || !ev.arguments) return '';
        s.args = ev.arguments;
        return frame(call({ index: s.slot, function: { name: '', arguments: ev.arguments } }));
      }
      case 'response.completed':
      case 'response.incomplete': {
        const u = ev.response?.usage;
        const finish = ev.type === 'response.incomplete'
          ? (ev.response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop')
          : (slots.size > 0 ? 'tool_calls' : 'stop');
        const usage = u
          ? { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: u.total_tokens ?? 0, completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.reasoning_tokens } }
          : undefined;
        return frame({}, finish, usage) + 'data: [DONE]\n\n';
      }
      case 'response.failed':
      case 'error':
        return `data: ${JSON.stringify({ error: { message: ev.response?.error?.message ?? ev.message ?? 'responses stream failed' } })}\n\n`;
      default:
        return '';
    }
  };

  const lines = (text: string): string => {
    let out = '';
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      try {
        out += translate(JSON.parse(t.slice(5).trim()) as ResponsesEvent);
      } catch {
        // unparseable frame: skipped, as the chat reader does
      }
    }
    return out;
  };

  const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += dec.decode(chunk, { stream: true });
      const cut = buffer.lastIndexOf('\n');
      if (cut < 0) return;
      const out = lines(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 1);
      if (out) controller.enqueue(enc.encode(out));
    },
    flush(controller) {
      const out = lines(buffer + dec.decode());
      if (out) controller.enqueue(enc.encode(out));
    },
  }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: { 'content-type': 'text/event-stream' } });
}
