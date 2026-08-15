

interface JsonSchemaish {
  type?: string;
  properties?: Record<string, JsonSchemaish>;
  items?: JsonSchemaish;
}

/** Parse the leading balanced JSON value (object or array) out of `text`, discarding anything
 *  after it. Needed because a weak model can glue hallucinated trailing content onto an
 *  otherwise-valid value — e.g. `[{"search":"a","replace":"b"}], "oldEdits": [...]` — which makes
 *  `JSON.parse` on the whole string throw even though the real value up front is fine. Tracks a
 *  bracket stack (not a single depth counter) so `{`/`[` can nest in either order, and honors
 *  string-literal/escape state so a bracket character inside a quoted value doesn't miscount. */
function leadingBalancedJsonValue(text: string): unknown | undefined {
  const first = text[0];
  if (first !== '{' && first !== '[') return undefined;
  const stack: string[] = [];
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) {
        try { return JSON.parse(text.slice(0, i + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

/** Un-stringify `value` against `schema` if it should be an array/object per the schema but
 *  arrived as a JSON-encoded string, then recurse into array items / object properties so a
 *  NESTED field stringified inside an already-correctly-typed parent (e.g. `askQuestions`'
 *  `questions[i].options`, one level inside the outer `questions` array) gets the same treatment
 *  — not just the top-level args object's own immediate fields. Mutates array/object values in
 *  place and returns the (possibly replaced) value; sets `state.changed` on any repair. */
function repairValueAgainstSchema(value: unknown, schema: JsonSchemaish | undefined, state: { changed: boolean }): unknown {
  if (!schema) return value;

  if ((schema.type === 'array' || schema.type === 'object') && typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      let inner: unknown;
      try {
        inner = JSON.parse(trimmed);
      } catch {
        // Whole string didn't parse — try the leading balanced value in case trailing
        // hallucinated content (e.g. a stray extra key) was glued on after it.
        inner = leadingBalancedJsonValue(trimmed);
      }
      const isMatch = schema.type === 'array'
        ? Array.isArray(inner)
        : inner !== null && typeof inner === 'object' && !Array.isArray(inner);
      if (isMatch) {
        value = inner;
        state.changed = true;
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    return value.map((el) => repairValueAgainstSchema(el, schema.items, state));
  }
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const propSchema = schema.properties[key];
      if (propSchema) obj[key] = repairValueAgainstSchema(obj[key], propSchema, state);
    }
  }

  return value;
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

  if (paramSchema?.properties) {
    const state = { changed };
    parsed = repairValueAgainstSchema(parsed, { type: 'object', properties: paramSchema.properties }, state);
    changed = state.changed;
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

/** Index of the `{` opening a `<function=NAME>`'s JSON body, or -1 if this occurrence doesn't have
 *  one (meaning it belongs to the `<parameter=…>` dialect, shape 6). Skips leading whitespace AND
 *  an opening code fence: weak models wrap JSON in ```json … ``` constantly — the rest of this
 *  codebase already fights that in stripJsonFence — and a fenced body used to fail the bare
 *  `text[after + lead] !== '{'` test, so the call was dropped by shape 1 and then found no
 *  `<parameter=` for shape 6 either, vanishing entirely.
 *
 *  Doubles as the ownership boundary between shapes 1 and 6: `>= 0` means shape 1 owns this
 *  occurrence, `-1` means shape 6 does. That makes them provably exclusive per-occurrence, which
 *  is what lets shape 6 run over the same text instead of being suppressed whenever shape 1
 *  matched anything (a reply mixing both dialects used to silently lose the second call). */
function jsonBodyStart(text: string, after: number): number {
  const lead = /^\s*/.exec(text.slice(after))![0].length;
  let i = after + lead;
  const fence = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/.exec(text.slice(i));
  if (fence) i += fence[0].length;
  return text[i] === '{' ? i : -1;
}

/** Normalize a rescued call's argument payload to a JSON-object string, or null if it isn't one.
 *  Weak models emit it two ways: as a real object (`"arguments": {...}`) or — mimicking the
 *  OpenAI wire format, where `arguments` is literally a string — as an ESCAPED JSON STRING
 *  (`"arguments": "{\"path\":\"src/app.ts\"}"`). The string form failed the old
 *  `typeof inner === 'object'` test, so the call was dropped with no log and no fallthrough: no
 *  tool ran and the raw JSON streamed to chat as the final answer — the exact "tool call as text"
 *  symptom this module exists to prevent, triggered by the single most standard encoding there is. */
function liftArgsPayload(inner: unknown): string | null {
  if (inner !== null && typeof inner === 'object') return JSON.stringify(inner);
  if (typeof inner === 'string') {
    const t = inner.trim();
    // Hand a valid object literal through as-is — repairToolArguments runs next and expects
    // exactly this shape (a JSON string), so re-encoding would only add a layer to strip.
    if (t.startsWith('{')) { try { JSON.parse(t); return t; } catch { return null; } }
  }
  return null;
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
  // The `{` must be the FIRST non-whitespace thing after the tag. firstBalancedJson scans
  // FORWARD from the tag, so without this guard `<function=editFile><parameter=search>…{…}…`
  // (shape 6) matched here, lifted a brace out of the search payload as the whole argument
  // object, and — because every later shape only runs when nothing matched — suppressed the
  // branch that would have parsed it correctly. Measured cost: an edit that wrote nothing.
  const fnAnchor = /<function=([a-zA-Z0-9_\-]+)[^>]*>/g;
  while ((m = fnAnchor.exec(text)) !== null) {
    const name = m[1];
    const after = m.index + m[0].length;
    if (!toolNames.has(name)) continue;
    const jsonStart = jsonBodyStart(text, after);
    if (jsonStart < 0) continue;
    const obj = balancedJsonFrom(text, jsonStart);
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
      const lifted = liftArgsPayload(parsed?.arguments);
      if (lifted !== null) calls.push({ name, arguments: lifted });
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
      const lifted = liftArgsPayload(parsed?.parameters);
      if (lifted !== null) calls.push({ name, arguments: lifted });
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

  {
    // NOTE: deliberately NOT gated on `calls.length === 0`, unlike shapes 2-5. Shape 6 shares the
    // `<function=NAME>` opener with shape 1, and `jsonBodyStart` splits ownership cleanly between
    // them (JSON body → shape 1, tagged parameters → shape 6), so both can scan the full text
    // without double-counting an occurrence. Under the old guard a reply that mixed the two — very
    // common, since weak models switch dialects between calls in one turn — kept only whichever
    // came first: a verified repro dropped the `editFile` entirely while the `readFile` went
    // through, so zero bytes were written and nothing reported an error.
    // Shape 6: the Hermes/Qwen `<parameter=KEY>` dialect — same `<function=NAME>` opener as
    // shape 1 but with tagged parameters instead of a JSON body, usually wrapped in <tool_call>:
    //   <tool_call>
    //   <function=editFile>
    //   <parameter=path>
    //   package.json
    //   </parameter>
    //   <parameter=search>
    //   …possibly-braced code…
    //   </parameter>
    //   </function>
    //   </tool_call>
    // Captured from a real run where this was the turn's ONLY edit attempt: nothing parsed it,
    // so zero bytes changed on disk and the raw XML was shown to the user as the answer.
    // Values are NOT trimmed — an editFile `search` body must match the file byte for byte, so
    // only the single newline the dialect puts after the opening tag (and the newline plus any
    // indent before the closing one) is removed. Closing tags are optional to tolerate a
    // response truncated mid-call.
    const fnParamAnchor = /<function=([a-zA-Z0-9_\-]+)[^>]*>/g;
    while ((m = fnParamAnchor.exec(text)) !== null) {
      const name = m[1];
      const bodyStart = m.index + m[0].length;
      fnParamAnchor.lastIndex = bodyStart;
      if (!toolNames.has(name)) continue;
      // This occurrence has a JSON body — shape 1 already claimed it. Skipping here is what keeps
      // the two shapes exclusive now that both run unconditionally.
      if (jsonBodyStart(text, bodyStart) >= 0) continue;
      const closeRe = /<\/function>/g;
      closeRe.lastIndex = bodyStart;
      const close = closeRe.exec(text);
      const bodyEnd = close ? close.index : text.length;
      const args: Record<string, unknown> = {};
      const paramTag = /<parameter=([a-zA-Z0-9_\-]+)\s*>([\s\S]*?)(?:<\/parameter>|$)/g;
      let p: RegExpExecArray | null;
      while ((p = paramTag.exec(text.slice(bodyStart, bodyEnd))) !== null) {
        const raw = p[2].replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
        // Only single-line scalars get JSON coercion; a multi-line body is code, and parsing it
        // would either fail or (worse) succeed and reshape it.
        args[p[1]] = raw.includes('\n') ? raw : coerceInlineArgValue(raw);
      }
      // Pushed even with NO parameters. A parameterless tool (`listTodos`, `getDiagnostics` with
      // no args) legitimately emits `<function=listTodos></function>`, and the old
      // `Object.keys(args).length > 0` guard meant such a call could never be rescued at all —
      // the turn died with the raw XML shown as the answer. Safe now only because the
      // `jsonBodyStart` check above already excluded shape 1's occurrences: without it this would
      // push a duplicate `{}` call for every JSON-bodied one.
      calls.push({ name, arguments: JSON.stringify(args) });
      if (close) fnParamAnchor.lastIndex = close.index + close[0].length;
    }
  }

  {
    // Shape 7: the Liquid LFM / Llama-3.1 single-line python-call dialect, emitted as plain
    // content when the provider doesn't wire the special tokens:
    //   <tool_call_start>|[readFile(path='public/landing.blade.php')]<tool_call_end>|
    // Captured from a real 2026-08-15 OpenRouter liquid/lfm-2.5-2.6b run: the model drove 14
    // read calls fine, then emitted its edit exactly once in THIS dialect — no shape above
    // matched (`<tool_call_start>` fails shape 4's literal `<tool_call>`; no `<function=`,
    // no JSON blob), so the call never ran, the raw text streamed to chat as the reply, and
    // the turn ended on "What would you like to know?". The bare `[name(kw='v')]` form (same
    // dialect, special tokens already stripped by the provider) parses identically — the
    // toolNames membership test is the false-positive guard, since prose brackets don't start
    // with a real tool name followed by `(`.
    // Runs unconditionally (like 1/6): it shares no opener with any other shape, and the
    // dedupe pass below collapses any overlap.
    const pyAnchor = /(?:<tool_call_start>\|?\s*)?\[([a-zA-Z0-9_\-]+)\s*\(/g;
    while ((m = pyAnchor.exec(text)) !== null) {
      const name = m[1];
      if (!toolNames.has(name)) continue;
      // Scan the kwarg list by hand: `key='value'` / key="value" / bare token, comma-separated.
      // Values are python-style single-OR-double-quoted strings whose contents may hold commas,
      // brackets, and escaped quotes — a naive split(',') breaks on the first comma inside a path.
      let i = m.index + m[0].length;
      const args: Record<string, unknown> = {};
      let matchedClose = false;
      while (i < text.length) {
        // Skip whitespace and separators before the next kwarg.
        while (i < text.length && /[\s,]/.test(text[i])) i++;
        if (i >= text.length) break;
        // `)` or `]` ends the call (a model may close the paren, the bracket, or both).
        if (text[i] === ')' || text[i] === ']') { matchedClose = text[i] === ')'; i++; break; }
        const keyMatch = /([a-zA-Z0-9_\-]+)\s*=\s*/.exec(text.slice(i));
        if (!keyMatch) break; // not a kwarg — give up rather than mis-parse
        const key = keyMatch[1];
        i += keyMatch[0].length;
        let value: unknown;
        const q = text[i];
        if (q === '\'' || q === '"') {
          // Quoted string: scan to the matching unescaped close quote, honoring backslash escapes.
          let j = i + 1;
          let raw = '';
          while (j < text.length) {
            if (text[j] === '\\' && j + 1 < text.length) { raw += text[j + 1]; j += 2; continue; }
            if (text[j] === q) break;
            raw += text[j];
            j++;
          }
          value = raw; // a quoted value is always a literal string — no JSON coercion
          i = j < text.length ? j + 1 : j;
        } else {
          // Bare token: up to the next `,`, `)`, or `]`.
          let j = i;
          while (j < text.length && !/[,\)\]]/.test(text[j])) j++;
          value = coerceInlineArgValue(text.slice(i, j));
          i = j;
        }
        args[key] = value;
      }
      // Only rescue a call whose kwarg scan actually closed (a `)` or `]`), so truncated
      // mid-emit text or an accidental `[readFile(` in prose doesn't run a half-parsed call
      // with silently-missing arguments.
      if (!matchedClose) continue;
      calls.push({ name, arguments: JSON.stringify(args) });
      pyAnchor.lastIndex = Math.max(pyAnchor.lastIndex, i);
    }
  }

  // Cheap insurance now that shapes 1, 6 and 7 all scan the full text: collapse identical
  // (name, arguments) pairs so no dialect overlap can ever run the same tool call twice.
  const seen = new Set<string>();
  const unique = calls.filter((c) => {
    const key = `${c.name} ${c.arguments}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { detected: unique.length > 0, calls: unique };
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
