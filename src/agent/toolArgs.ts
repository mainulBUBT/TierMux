// Schema-aware repair of double-encoded tool-call arguments, plus a compact
// rescue for models that emit tool calls as inline dialect text.
// Ported/adapted from freellmapi's server/src/lib/{tool-args,tool-call-rescue}.ts (MIT).

interface JsonSchemaish {
  type?: string;
  properties?: Record<string, JsonSchemaish>;
}

/**
 * Repair a tool call's `arguments` JSON string against the tool's parameter
 * schema. Returns the original string untouched whenever anything doesn't parse
 * or match — must never corrupt a valid call.
 */
/**
 * Best-effort repair of JSON a weak model emitted with common breakage: markdown fences,
 * surrounding prose, trailing commas, single-quoted strings, and unquoted keys. These are the
 * most frequent reasons a free model's tool call fails to parse, and they'd otherwise trigger a
 * costly escalation to a stronger model. Returns a string JSON.parse can handle, or the original
 * if nothing could be salvaged — must never turn a valid argument string into an invalid one.
 */
export function repairBrokenJson(raw: string): string {
  if (raw == null) return raw;
  // Fast path: already valid JSON → return untouched (never corrupt a good call).
  try { JSON.parse(raw); return raw; } catch { /* fall through to repairs */ }
  let s = raw.trim();
  // 1. Strip markdown code fences (```json … ```).
  s = s.replace(/^```(?:json|JSON)?\s*/i, '').replace(/\s*```\s*$/, '');
  // 2. Trim surrounding prose — keep from the first { or [ to the matching last } or ].
  const open = s.search(/[{[]/);
  if (open > 0) s = s.slice(open);
  const lastClose = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (lastClose >= 0 && lastClose < s.length - 1) s = s.slice(0, lastClose + 1);
  // 3. Drop trailing commas before a closing brace/bracket ({"a":1,} → {"a":1}).
  s = s.replace(/,\s*([}\]])/g, '$1');
  // 4. Quote unquoted object keys ({path: "."} → {"path": "."}).
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
  // 5. Convert single-quoted strings to double-quoted (best-effort).
  s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, inner) => `"${String(inner).replace(/"/g, '\\"')}"`);
  try { JSON.parse(s); return s; } catch { return raw; }
}

export function repairToolArguments(args: string, paramSchema?: JsonSchemaish): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }

  let changed = false;

  // Whole-arguments double encoding: `"{\"a\":1}"`.
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
        // not actually JSON — leave it
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
      // Answer present → show it (with reasoning tucked into <think>). Analysis only
      // (model produced no final channel) → return just the <think> so the visible
      // answer is empty and the caller's fallback message is used, never raw CoT.
      if (answer) return reasoning ? `<think>${reasoning}</think>${answer}` : answer;
      if (reasoning) return `<think>${reasoning}</think>`;
    }
  }
  // No channels (or unparseable): strip any lone control tokens.
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

export interface RescuedCall {
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

  // Pattern A: <function=NAME>{json}</function> or <function=NAME>{json} — the closing tag
  // and the `>` after the name are both optional: weak models often emit malformed forms like
  // `<function=listDir{"path":"."}` (no `>`, no closing tag).
  const fnTag = /<function=([a-zA-Z0-9_\-]+)\s*>?\s*(\{[\s\S]*?\})\s*(?:<\/function>)?/g;
  let m: RegExpExecArray | null;
  while ((m = fnTag.exec(text)) !== null) {
    const name = m[1];
    if (toolNames.has(name)) calls.push({ name, arguments: m[2] });
  }

  // Pattern B: {"name":"NAME","arguments":{...}} blobs.
  if (calls.length === 0) {
    const blob = /\{\s*"name"\s*:\s*"([a-zA-Z0-9_\-]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    while ((m = blob.exec(text)) !== null) {
      const name = m[1];
      if (toolNames.has(name)) calls.push({ name, arguments: m[2] });
    }
  }

  return { detected: calls.length > 0, calls };
}
