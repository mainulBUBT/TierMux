

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

/** Scan one balanced JSON object out of `text`, starting from the opening `{` at index `start`.
 *  Walks the string tracking string-literal / escape state so a `}` INSIDE a string value does
 *  NOT end the capture — writeFile/editFile `content`/`replace` routinely contain code with
 *  braces, and the old non-greedy regex `\{[\s\S]*?\}` truncated at that first inner `}`,
 *  yielding invalid JSON, dropping the rescued call, and showing the model's `<function=…>`
 *  text as chat (the "tool call as text, stuck in loop" symptom). Returns the matched
 *  substring and the index past the closing `}`, or null if no balanced close is found. */
function balancedJsonFrom(text: string, start: number): { text: string; end: number } | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return { text: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null; // truncated before the matching close — caller skips
}

/** First balanced JSON object at or after `from`, or null. */
function firstBalancedJson(text: string, from: number): { text: string; end: number } | null {
  const brace = text.indexOf('{', from);
  return brace === -1 ? null : balancedJsonFrom(text, brace);
}

/**
 * Best-effort rescue of tool calls a weak model emitted as inline dialect text
 * (e.g. `<function=NAME>{...}</function>` or a bare `{"name":...,"arguments":...}`
 * blob) and that the provider handed back in `error.failed_generation`.
 */
export function rescueInlineToolCalls(text: string, toolNames: Set<string>): { detected: boolean; calls: RescuedCall[] } {
  const calls: RescuedCall[] = [];
  let m: RegExpExecArray | null;

  // Shape 1 — the explicit dialect FORCE_ACTION_NUDGE tells weak models to emit when they can't
  // produce a native call:  <function=NAME>{ ...args... }</function>   (closing tag optional —
  // tolerate a response truncated mid-call). The `{...}` is captured by BALANCED brace scanning
  // (balancedJsonFrom), NOT a non-greedy regex: writeFile/editFile payloads routinely hold `}`
  // inside the `content`/`replace` string (any code with braces), and `\{[\s\S]*?\}` truncated
  // at that first inner `}` → invalid JSON → the call was dropped and the raw `<function=…>`
  // text streamed through as the reply → no tool ran → loop. Balance-tracking fixes it.
  const fnAnchor = /<function=([a-zA-Z0-9_\-]+)[^>]*>/g;
  while ((m = fnAnchor.exec(text)) !== null) {
    const name = m[1];
    if (!toolNames.has(name)) continue;
    const obj = firstBalancedJson(text, m.index + m[0].length);
    if (!obj) continue;
    calls.push({ name, arguments: obj.text });
    fnAnchor.lastIndex = obj.end;
  }

  if (calls.length === 0) {
    // Shape 2: {"name":"...","arguments":{...}}  (OpenAI-style inline blob a weak model emits
    // as content / failed_generation). Capture the OUTER object balanced, then lift the inner
    // `arguments` object so braces inside it survive.
    const blobAnchor = /\{\s*"name"\s*:\s*"([a-zA-Z0-9_\-]+)"\s*,\s*"arguments"\s*:/g;
    while ((m = blobAnchor.exec(text)) !== null) {
      const name = m[1];
      if (!toolNames.has(name)) continue;
      const obj = firstBalancedJson(text, m.index);
      if (!obj) continue;
      let parsed: { arguments?: unknown };
      try { parsed = JSON.parse(obj.text); } catch { blobAnchor.lastIndex = m.index + m[0].length; continue; }
      const inner = parsed?.arguments;
      if (inner != null && typeof inner === 'object') calls.push({ name, arguments: JSON.stringify(inner) });
      blobAnchor.lastIndex = obj.end;
    }
  }

  if (calls.length === 0) {
    // Shape 3: {"type":"function","name":"...","parameters":{...}}  (Claude/Anthropic-style
    // inline that weak models — e.g. Cloudflare's llama-3.3 — emit as content because they
    // don't speak the tools API). Same balanced capture, lifting `parameters`.
    const typedAnchor = /\{\s*"type"\s*:\s*"function"\s*,\s*"name"\s*:\s*"([a-zA-Z0-9_\-]+)"\s*,\s*"parameters"\s*:/g;
    while ((m = typedAnchor.exec(text)) !== null) {
      const name = m[1];
      if (!toolNames.has(name)) continue;
      const obj = firstBalancedJson(text, m.index);
      if (!obj) continue;
      let parsed: { parameters?: unknown };
      try { parsed = JSON.parse(obj.text); } catch { typedAnchor.lastIndex = m.index + m[0].length; continue; }
      const inner = parsed?.parameters;
      if (inner != null && typeof inner === 'object') calls.push({ name, arguments: JSON.stringify(inner) });
      typedAnchor.lastIndex = obj.end;
    }
  }

  if (calls.length === 0) {
    // Shape 4: the XML "tool_call" dialect some weak free models (Qwen/GLM-style chat templates)
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

  if (calls.length === 0) {
    // Shape 5: DeepSeek V3.2/V4's "DSML" tool-call markup, emitted as plain content when the
    // provider doesn't natively parse the ｜DSML｜ special token:
    //   <｜DSML｜tool_calls><｜DSML｜invoke name="readFile">
    //   <｜DSML｜parameter name="path" string="true">README.md</｜DSML｜parameter>
    //   </｜DSML｜invoke></｜DSML｜tool_calls>
    // The fullwidth vertical bar (｜, U+FF5C) around DSML is sometimes doubled by the model
    // (｜｜DSML｜｜) — match one-or-more so both variants parse. `string="true"` on a <parameter>
    // means "treat as a literal string" (DSML has no other type marker), so it skips JSON coercion.
    const invokeTag = /<｜+DSML｜+invoke\s+name="([a-zA-Z0-9_\-]+)"[^>]*>/g;
    while ((m = invokeTag.exec(text)) !== null) {
      const name = m[1];
      if (!toolNames.has(name)) { invokeTag.lastIndex = m.index + m[0].length; continue; }
      const closeRe = /<\/｜+DSML｜+invoke>/g;
      closeRe.lastIndex = m.index + m[0].length;
      const close = closeRe.exec(text);
      const bodyEnd = close ? close.index : text.length;
      const body = text.slice(m.index + m[0].length, bodyEnd);
      const args: Record<string, unknown> = {};
      const paramTag = /<｜+DSML｜+parameter\s+name="([a-zA-Z0-9_\-]+)"([^>]*)>([\s\S]*?)(?:<\/｜+DSML｜+parameter>|$)/g;
      let p: RegExpExecArray | null;
      while ((p = paramTag.exec(body)) !== null) {
        const [, pname, attrs, raw] = p;
        args[pname] = /string\s*=\s*"true"/.test(attrs) ? raw.trim() : coerceInlineArgValue(raw);
      }
      calls.push({ name, arguments: JSON.stringify(args) });
      invokeTag.lastIndex = close ? close.index + close[0].length : text.length;
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
