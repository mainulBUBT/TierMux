

interface JsonSchemaish {
  type?: string;
  properties?: Record<string, JsonSchemaish>;
}

export function repairToolArguments(args: string, paramSchema?: JsonSchemaish): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }

  let changed = false;

  if (typeof parsed === 'string') {
    try {
      const inner = JSON.parse(parsed);
      if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
        parsed = inner;
        changed = true;
      } else {
        return args;
      }
    } catch {
      return args;
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return changed ? JSON.stringify(parsed) : args;
  }

  const props = paramSchema?.properties;
  if (props) {
    const obj = parsed as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== 'string') continue;
      const want = props[key]?.type;
      if (want !== 'array' && want !== 'object') continue;
      const trimmed = value.trim();
      if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) continue;
      try {
        const inner = JSON.parse(trimmed);
        const isMatch = want === 'array'
          ? Array.isArray(inner)
          : inner !== null && typeof inner === 'object' && !Array.isArray(inner);
        if (isMatch) {
          obj[key] = inner;
          changed = true;
        }
      } catch {

      }
    }
  }

  return changed ? JSON.stringify(parsed) : args;
}

/**
 * Strip leaked control tokens from a tool-call function name. Some models
 * (notably gpt-oss / OpenAI "Harmony" format on Groq/Cerebras/OVH) emit raw
 * channel tokens inside the function name — e.g. `searchWorkspace<|channel|>commentary`
 * — or namespace it as `functions.searchWorkspace`. Returns the bare tool name so
 * it matches our registered tools instead of failing as "unknown tool".
 */
export function sanitizeToolName(name: string): string {
  if (!name) return name;
  let n = name;
  const tok = n.indexOf('<|'); // drop the first Harmony token and everything after it
  if (tok !== -1) n = n.slice(0, tok);
  const ns = n.lastIndexOf('functions.'); // `functions.NAME` / `to=functions.NAME`
  if (ns !== -1) n = n.slice(ns + 'functions.'.length);
  return n.trim();
}

/**
 * Clean gpt-oss / Harmony output for display. These models emit channels —
 * `<|channel|>analysis<|message|>…<|end|>` (chain-of-thought) and
 * `<|channel|>final<|message|>…` (the answer). Naively deleting the tokens would
 * merge the reasoning INTO the answer, so we instead keep only the final channel
 * as the visible text and fold any analysis/commentary into a <think> block, which
 * the reasoning splitter then shows separately (never as the message itself).
 */
export function stripHarmonyTokens(text: string): string {
  if (!text || text.indexOf('<|') === -1) return text;
  if (/<\|channel\|>/.test(text)) {
    const finals: string[] = [];
    const thoughts: string[] = [];
    const re = /<\|channel\|>\s*(analysis|commentary|final)\s*<\|message\|>([\s\S]*?)(?=<\|(?:end|return|start|channel)\|>|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const body = m[2].trim();
      if (!body) continue;
      (m[1] === 'final' ? finals : thoughts).push(body);
    }
    if (finals.length || thoughts.length) {
      const answer = finals.join('\n').trim();
      const reasoning = thoughts.join('\n').trim();

      if (answer) return reasoning ? `<think>${reasoning}</think>${answer}` : answer;
      if (reasoning) return `<think>${reasoning}</think>`;
    }
  }

  return text
    .replace(/<\|channel\|>\s*(?:analysis|commentary|final)?\s*<\|message\|>/g, '')
    .replace(/<\|(?:start|end|message|channel|constrain|call|return)\|>/g, '')
    .trim();
}

export function toolSchemaMap(
  tools?: Array<{ type?: string; function?: { name?: string; parameters?: unknown } }>,
): Map<string, JsonSchemaish> {
  const map = new Map<string, JsonSchemaish>();
  for (const t of tools ?? []) {
    const name = t.function?.name;
    if (t.type === 'function' && name && t.function?.parameters && typeof t.function.parameters === 'object') {
      map.set(name, t.function.parameters as JsonSchemaish);
    }
  }
  return map;
}

interface RescuedCall {
  name: string;
  arguments: string;
}

/**
 * Best-effort rescue of tool calls a weak model emitted as inline dialect text
 * (e.g. `<function=NAME>{...}</function>` or a bare `{"name":...,"arguments":...}`
 * blob) and that the provider handed back in `error.failed_generation`.
 */
export function rescueInlineToolCalls(text: string, toolNames: Set<string>): { detected: boolean; calls: RescuedCall[] } {
  const calls: RescuedCall[] = [];

  const fnTag = /<function=([a-zA-Z0-9_\-]+)\s*>?\s*(\{[\s\S]*?\})\s*(?:<\/function>)?/g;
  let m: RegExpExecArray | null;
  while ((m = fnTag.exec(text)) !== null) {
    const name = m[1];
    if (toolNames.has(name)) calls.push({ name, arguments: m[2] });
  }

  if (calls.length === 0) {
    // Shape A: {"name":"...","arguments":{...}}  (OpenAI-style inline)
    const blob = /\{\s*"name"\s*:\s*"([a-zA-Z0-9_\-]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    while ((m = blob.exec(text)) !== null) {
      const name = m[1];
      if (toolNames.has(name)) calls.push({ name, arguments: m[2] });
    }
  }

  if (calls.length === 0) {
    // Shape B: {"type":"function","name":"...","parameters":{...}}  (Claude/Anthropic-style
    // inline tool-call that weak models — e.g. Cloudflare's llama-3.3 — emit as content text
    // because they don't speak the tools API properly). Parameters map to arguments.
    const typed = /\{\s*"type"\s*:\s*"function"\s*,\s*"name"\s*:\s*"([a-zA-Z0-9_\-]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    while ((m = typed.exec(text)) !== null) {
      const name = m[1];
      if (toolNames.has(name)) calls.push({ name, arguments: m[2] });
    }
  }

  if (calls.length === 0) {
    // Shape C: the XML "tool_call" dialect some weak free models (Qwen/GLM-style chat templates)
    // emit as plain content when the server doesn't wire the tools API:
    //   <tool_call>NAME
    //   <arg_key>limit</arg_key><arg_value>30</arg_value>
    //   <arg_key>path</arg_key><arg_value>routes/web.php</arg_value>
    //   </tool_call>
    // The tool name follows the opening tag; each argument is an <arg_key>/<arg_value> pair.
    // (A <tool_call>{"name":...,"arguments":...}</tool_call> variant is already covered by the
    // JSON shapes above, which scan the whole text.) The closing tag is optional to tolerate a
    // response truncated mid-call. Without this branch the XML streamed straight through as the
    // final answer and the turn died with no tool ever running.
    const tcTag = /<tool_call>\s*([a-zA-Z0-9_.\-]+)\s*([\s\S]*?)(?:<\/tool_call>|$)/g;
    while ((m = tcTag.exec(text)) !== null) {
      const name = m[1];
      if (!toolNames.has(name)) continue;
      const args: Record<string, unknown> = {};
      const pair = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/g;
      let p: RegExpExecArray | null;
      while ((p = pair.exec(m[2])) !== null) args[p[1]] = coerceInlineArgValue(p[2]);
      calls.push({ name, arguments: JSON.stringify(args) });
    }
  }

  return { detected: calls.length > 0, calls };
}

/** Coerce one <arg_value> payload to a JS value: JSON-parse it so `30`→number, `true`→boolean,
 *  `["a"]`→array, `{...}`→object; fall back to the raw trimmed string for a plain path/word that
 *  isn't valid JSON. (repairToolArguments still runs afterward to reconcile against the tool's
 *  schema, so this only needs to be a sensible first guess.) */
function coerceInlineArgValue(raw: string): unknown {
  const t = raw.trim();
  if (t === '') return t;
  try { return JSON.parse(t); } catch { return t; }
}
