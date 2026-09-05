// Repairs for tool calls that arrive as TEXT instead of native tool_calls. Live caller:
// openai-compat.ts rescues Groq-style `failed_generation` bodies through rescueInlineToolCalls,
// then repairToolArguments coerces the args against the tool's JSON schema.

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

/** Un-stringify `value` against `schema` if it should be an array/object but arrived as a
 *  JSON-encoded string, recursing into items/properties so a nested stringified field is
 *  repaired too. Mutates in place; sets `state.changed` on any repair. */
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

/** Imagined tool names weak models use in text dialects (`<invoke name="read">`), mapped to
 *  registry names. Without this a rescued call with an unknown name was dropped outright. */
const DIALECT_NAME_ALIASES: Record<string, string> = {
  read: 'readFile', open: 'readFile', view: 'readFile',
  write: 'writeFile', create: 'createFile', create_file: 'createFile', new_file: 'createFile',
  edit: 'editFile', replace: 'editFile', modify: 'editFile', str_replace: 'editFile',
  delete: 'deleteFile', remove: 'deleteFile',
  search: 'grep', find: 'grep', grep_search: 'grep',
  list: 'listDir', ls: 'listDir', list_files: 'listDir', glob_search: 'glob',
  bash: 'runCommand', shell: 'runCommand', exec: 'runCommand', execute: 'runCommand', terminal: 'runCommand',
  todo: 'todoWrite', update_plan: 'todoWrite', set_todos: 'todoWrite',
};

/** Resolve a dialect-emitted tool name to a REGISTERED name: exact, then case/underscore-
 *  insensitive (`read_file` → `readFile`), then the alias table above. Never returns a tool
 *  the caller didn't register, so a mode-withheld tool can't be smuggled in by an alias. */
export function resolveDialectToolName(name: string, toolNames: Set<string>, allowAliases = true): string | undefined {
  if (!name) return undefined;
  if (toolNames.has(name)) return name;
  const key = name.toLowerCase().replace(/[_\-\s]/g, '');
  for (const real of toolNames) {
    if (real.toLowerCase().replace(/[_\-\s]/g, '') === key) return real;
  }
  // `allowAliases: false` is for the shapes that infer the tool name from a BARE tag word
  // (`<search>`, `<link>`) rather than from unambiguous call syntax (`name="…"` / `=NAME`).
  // Those are real HTML elements, and aliasing them to grep/readFile would turn a page of
  // markup quoted in a chat answer into tool calls.
  if (!allowAliases) return undefined;
  const alias = DIALECT_NAME_ALIASES[key];
  return alias ? resolveDialectToolName(alias, toolNames, false) : undefined;
}

/** Strip the wrapper a dialect puts AROUND its tag word, leaving the word: an XML namespace
 *  prefix (`antml:invoke`) and DeepSeek's fullwidth ｜DSML｜ sleeve (which the model sometimes
 *  doubles). Lets one matcher accept every sleeved variant of a dialect instead of one shape
 *  per sleeve. */
function stripDialectSleeve(token: string): string {
  return token.replace(/｜+DSML｜+/g, '').replace(/^[A-Za-z0-9_\-]+:/, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Any opening tag, tolerating an unterminated one so a chunk split mid-tag still detects.
 *  Group 1 is the tag word (which may carry a `=NAME` suffix), group 2 its attributes. */
const ANY_OPEN_TAG = /<(?![/!?])([^\s></]{1,120})((?:\s[^>]*)?)>/g;

/**
 * Arguments out of a dialect call's BODY, without knowing which dialect wrote it. Tries, in
 * order: `<arg_key>/<arg_value>` pairs; any child tag whose key is its `name="…"` attribute,
 * its `=KEY` suffix, or its own tag word; then a JSON body. Values are NOT trimmed beyond the
 * single newline+indent a dialect puts inside the tags — an editFile `search` body must match
 * the file byte for byte — and a multi-line value skips JSON coercion, which would either fail
 * on code or (worse) succeed and reshape it.
 */
function argsFromDialectBody(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  let p: RegExpExecArray | null;

  const pair = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/g;
  while ((p = pair.exec(body)) !== null) args[p[1]] = coerceInlineArgValue(p[2]);
  if (Object.keys(args).length) return args;

  const child = new RegExp(ANY_OPEN_TAG.source, 'g');
  while ((p = child.exec(body)) !== null) {
    const [, rawToken, attrs] = p;
    const token = stripDialectSleeve(rawToken);
    const eq = token.indexOf('=');
    const key = /\bname\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1] ?? (eq > 0 ? token.slice(eq + 1) : token);
    if (!key) continue;
    const openEnd = p.index + p[0].length;
    // Close on the tag's own base word, so a sleeved/namespaced closer matches its opener.
    const closeRe = new RegExp(`</\\s*${escapeRegExp(rawToken.split('=')[0])}\\s*>`, 'g');
    closeRe.lastIndex = openEnd;
    const close = closeRe.exec(body);
    const raw = body.slice(openEnd, close ? close.index : body.length)
      .replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
    // DSML's `string="true"` means "this is literally a string" — skip coercion, as for code.
    args[key] = /string\s*=\s*"true"/.test(attrs) || raw.includes('\n') ? raw : coerceInlineArgValue(raw);
    child.lastIndex = close ? close.index + close[0].length : body.length;
  }
  if (Object.keys(args).length) return args;

  const jsonStart = jsonBodyStart(body, 0);
  if (jsonStart >= 0) {
    const obj = balancedJsonFrom(body, jsonStart);
    if (obj) {
      try {
        const parsed: unknown = JSON.parse(obj.text);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch { /* fall through to the empty object — a parameterless call is still a call */ }
    }
  }
  return args;
}

/** Common parameter-name aliases for the tools a dialect tends to imagine: `file`/`filename`
 *  for readFile's `path`, `query`/`keyword` for grep's `pattern`, `cmd`/`command_to_run` for
 *  runCommand's `command`. Applied ONLY when the real parameter is absent — never overrides an
 *  argument the model got right. Cheap structural fixups: no schema, no coercion. */
const DIALECT_PARAM_ALIASES: Record<string, Record<string, string>> = {
  readFile: { file: 'path', filename: 'path', file_path: 'path', filepath: 'path' },
  writeFile: { file: 'path', filename: 'path', file_path: 'path', filepath: 'path', text: 'content', contents: 'content' },
  createFile: { file: 'path', filename: 'path', file_path: 'path', filepath: 'path', text: 'content', contents: 'content' },
  editFile: { file: 'path', filename: 'path', file_path: 'path', filepath: 'path', old_text: 'search', old_string: 'search', find: 'search', new_text: 'replace', new_string: 'replace', replacement: 'replace' },
  deleteFile: { file: 'path', filename: 'path', file_path: 'path', filepath: 'path' },
  grep: { query: 'pattern', keyword: 'pattern', search: 'pattern', regex: 'pattern' },
  runCommand: { cmd: 'command', command_to_run: 'command', shell_command: 'command' },
};

/** Rename a rescued call's imagined parameter names to the real ones (in place, on the parsed
 *  object). Returns the canonical arguments JSON string. Best-effort: an unparseable argument
 *  payload passes through untouched — schema validation downstream (repairToolArguments /
 *  Zod) reports anything still wrong as a fail-soft tool error the model can correct. */
function normalizeDialectParams(name: string, argsJson: string): string {
  const aliases = DIALECT_PARAM_ALIASES[name];
  if (!aliases) return argsJson;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(argsJson); } catch { return argsJson; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return argsJson;
  let changed = false;
  for (const [from, to] of Object.entries(aliases)) {
    if (from in parsed && !(to in parsed)) { parsed[to] = parsed[from]; delete parsed[from]; changed = true; }
  }
  return changed ? JSON.stringify(parsed) : argsJson;
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
    const resolved = resolveDialectToolName(m[1], toolNames);
    const after = m.index + m[0].length;
    if (!resolved) continue;
    const jsonStart = jsonBodyStart(text, after);
    if (jsonStart < 0) continue;
    const obj = balancedJsonFrom(text, jsonStart);
    if (!obj) continue;
    calls.push({ name: resolved, arguments: normalizeDialectParams(resolved, obj.text) });
    fnAnchor.lastIndex = obj.end;
  }

  if (calls.length === 0) {
    // Shape 2: {"name":"...","arguments":{...}}  (OpenAI-style inline blob a weak model emits
    // as content / failed_generation). Capture the OUTER object balanced, then lift the inner
    // `arguments` object so braces inside it survive.
    const blobAnchor = /\{\s*"name"\s*:\s*"([a-zA-Z0-9_\-]+)"\s*,\s*"arguments"\s*:/g;
    while ((m = blobAnchor.exec(text)) !== null) {
      const resolved = resolveDialectToolName(m[1], toolNames);
      if (!resolved) continue;
      const obj = firstBalancedJson(text, m.index);
      if (!obj) continue;
      let parsed: { arguments?: unknown };
      try { parsed = JSON.parse(obj.text); } catch { blobAnchor.lastIndex = m.index + m[0].length; continue; }
      const lifted = liftArgsPayload(parsed?.arguments);
      if (lifted !== null) calls.push({ name: resolved, arguments: normalizeDialectParams(resolved, lifted) });
      blobAnchor.lastIndex = obj.end;
    }
  }

  if (calls.length === 0) {
    // Shape 3: {"type":"function","name":"...","parameters":{...}}  (Claude/Anthropic-style
    // inline that weak models — e.g. Cloudflare's llama-3.3 — emit as content because they
    // don't speak the tools API). Same balanced capture, lifting `parameters`.
    const typedAnchor = /\{\s*"type"\s*:\s*"function"\s*,\s*"name"\s*:\s*"([a-zA-Z0-9_\-]+)"\s*,\s*"parameters"\s*:/g;
    while ((m = typedAnchor.exec(text)) !== null) {
      const resolved = resolveDialectToolName(m[1], toolNames);
      if (!resolved) continue;
      const obj = firstBalancedJson(text, m.index);
      if (!obj) continue;
      let parsed: { parameters?: unknown };
      try { parsed = JSON.parse(obj.text); } catch { typedAnchor.lastIndex = m.index + m[0].length; continue; }
      const lifted = liftArgsPayload(parsed?.parameters);
      if (lifted !== null) calls.push({ name: resolved, arguments: normalizeDialectParams(resolved, lifted) });
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
      const resolved = resolveDialectToolName(m[1], toolNames);
      if (!resolved) continue;
      const args: Record<string, unknown> = {};
      const pair = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/g;
      let p: RegExpExecArray | null;
      while ((p = pair.exec(m[2])) !== null) args[p[1]] = coerceInlineArgValue(p[2]);
      calls.push({ name: resolved, arguments: normalizeDialectParams(resolved, JSON.stringify(args)) });
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
      const resolved = resolveDialectToolName(m[1], toolNames);
      if (!resolved) { invokeTag.lastIndex = m.index + m[0].length; continue; }
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
      calls.push({ name: resolved, arguments: normalizeDialectParams(resolved, JSON.stringify(args)) });
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
      const resolved = resolveDialectToolName(m[1], toolNames);
      const bodyStart = m.index + m[0].length;
      fnParamAnchor.lastIndex = bodyStart;
      if (!resolved) continue;
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
      calls.push({ name: resolved, arguments: normalizeDialectParams(resolved, JSON.stringify(args)) });
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
      const resolved = resolveDialectToolName(m[1], toolNames);
      if (!resolved) continue;
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
      calls.push({ name: resolved, arguments: normalizeDialectParams(resolved, JSON.stringify(args)) });
      pyAnchor.lastIndex = Math.max(pyAnchor.lastIndex, i);
    }
  }

  {
    // Shape 8: the GLM-4.x raw CHANNEL dialect — the provider hands back the model's own
    // tool-call template unparsed as plain content (captured 2026-08-21 in plan mode:
    // `<|start|>assistant<|channel|>commentary to=functions.listDir <|constrain|>json={"path":""}<|call|>`
    // streamed straight into the chat, no tool ran, and plan mode looked broken). Shape:
    //   <|channel|>commentary to=functions.NAME <|constrain|>json={ ...args... }<|call|>
    // `<|call|>` needs no handling of its own — balanced-JSON scanning ends the args. Runs
    // unconditionally like 1/6/7: no shared opener, and the dedupe pass covers overlap.
    // GLM also tends to snake_case names against TierMux's camelCase registry
    // (functions.read_file vs readFile), so an exact miss falls back to case-variant
    // resolution instead of dropping the call.
    const chanAnchor = /<\|channel\|>\s*commentary\s+to\s*=\s*functions\.([a-zA-Z0-9_\-]+)/g;
    while ((m = chanAnchor.exec(text)) !== null) {
      const resolved = resolveDialectToolName(m[1], toolNames);
      if (!resolved) continue;
      const after = m.index + m[0].length;
      // Args follow `json=` after a <|constrain|> marker; fall back to the first `{` after
      // the tag for variants that omit the marker.
      const constrain = /<\|constrain\|>\s*json\s*=\s*/g;
      constrain.lastIndex = after;
      const cm = constrain.exec(text);
      const braceAt = text.indexOf('{', cm ? cm.index + cm[0].length : after);
      if (braceAt < 0) continue;
      const obj = balancedJsonFrom(text, braceAt);
      if (!obj) continue;
      calls.push({ name: resolved, arguments: normalizeDialectParams(resolved, obj.text) });
      chanAnchor.lastIndex = obj.end;
    }
  }

  if (calls.length === 0) {
    // Shape 9: the plain Claude/Anthropic-style `<invoke name="X"><parameter name="Y">value
    // </parameter></invoke>` dialect (optionally namespaced, e.g. `<invoke>`), emitted as
    // plain content when a provider serves an Anthropic-trained model without wiring the tools
    // API. Distinct from shape 5 (DeepSeek's DSML dialect uses the fullwidth ｜ wrapper around
    // "invoke"/"parameter"; this has none) and shape 6 (Hermes/Qwen's `<function=NAME>` /
    // `<parameter=KEY>` attribute-free tags). Captured from a 2026-08-23 run: the model narrated
    // "Let me check CarpoolBooking for rider_notes." then emitted this exact XML as its final
    // answer text instead of a real tool call — no shape above matched it, so nothing ran and the
    // raw markup streamed to the user as the reply. Closing tags are optional to tolerate a
    // response truncated mid-call.
    const invokeTag = /<(?:\w+:)?invoke\s+name="([a-zA-Z0-9_\-]+)"[^>]*>/g;
    while ((m = invokeTag.exec(text)) !== null) {
      const resolved = resolveDialectToolName(m[1], toolNames);
      if (!resolved) { invokeTag.lastIndex = m.index + m[0].length; continue; }
      const closeRe = /<\/(?:\w+:)?invoke>/g;
      closeRe.lastIndex = m.index + m[0].length;
      const close = closeRe.exec(text);
      const bodyEnd = close ? close.index : text.length;
      const body = text.slice(m.index + m[0].length, bodyEnd);
      const args: Record<string, unknown> = {};
      const paramTag = /<(?:\w+:)?parameter\s+name="([a-zA-Z0-9_\-]+)"[^>]*>([\s\S]*?)(?:<\/(?:\w+:)?parameter>|$)/g;
      let p: RegExpExecArray | null;
      while ((p = paramTag.exec(body)) !== null) {
        const raw = p[2].replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
        args[p[1]] = raw.includes('\n') ? raw : coerceInlineArgValue(raw);
      }
      calls.push({ name: resolved, arguments: normalizeDialectParams(resolved, JSON.stringify(args)) });
      invokeTag.lastIndex = close ? close.index + close[0].length : text.length;
    }
  }

  if (calls.length === 0) {
    // Shape 10 — the GENERIC fallback, and the reason this list should stop growing. Shapes
    // 1/4/5/6/9 each pin one vendor's exact markup, so every provider that serves a tool-trained
    // model without wiring the tools API cost a new shape — and, until someone hit it live, a
    // dead turn with raw markup shown as the answer. This shape pins no vendor: it walks every
    // opening tag and asks one question — does this tag NAME a tool the caller registered?
    // Dialects put that name in exactly three places, so all three are read:
    //   attribute   <invoke name="readFile">   <call name="readFile">   <tool name="readFile">
    //   after '='   <function=readFile>
    //   the tag     <readFile><path>src/app.ts</path></readFile>
    // stripDialectSleeve removes an XML namespace and DeepSeek's ｜DSML｜ wrapper first, so a
    // sleeved variant of any of the three parses without its own shape, and argsFromDialectBody
    // reads the body by the same open question instead of a fixed parameter syntax.
    // resolveDialectToolName against the REGISTERED tool set is the entire false-positive guard:
    // `<div>`, `<h1>`, `<script>` in an answer resolve to nothing and are skipped. The bare-tag
    // form passes allowAliases=false on top of that — `<search>` and `<link>` are real HTML
    // elements, and aliasing them to grep/readFile would turn quoted markup into tool calls.
    // Nothing but a model calling a tool writes `<invoke name="read">`, so the other two forms
    // keep the alias table.
    const anyTag = new RegExp(ANY_OPEN_TAG.source, 'g');
    while ((m = anyTag.exec(text)) !== null) {
      const [, rawToken, attrs] = m;
      const token = stripDialectSleeve(rawToken);
      const eq = token.indexOf('=');
      const attrName = /\bname\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1];
      const resolved =
        (attrName ? resolveDialectToolName(attrName, toolNames) : undefined)
        ?? (eq > 0 ? resolveDialectToolName(token.slice(eq + 1), toolNames) : undefined)
        ?? resolveDialectToolName(token, toolNames, false);
      const openEnd = m.index + m[0].length;
      anyTag.lastIndex = openEnd;
      if (!resolved) continue;
      const closeRe = new RegExp(`</\\s*${escapeRegExp(rawToken.split('=')[0])}\\s*>`, 'g');
      closeRe.lastIndex = openEnd;
      const close = closeRe.exec(text);
      // Closing tag optional, to tolerate a response truncated mid-call.
      const body = text.slice(openEnd, close ? close.index : text.length);
      calls.push({ name: resolved, arguments: normalizeDialectParams(resolved, JSON.stringify(argsFromDialectBody(body))) });
      if (close) anyTag.lastIndex = close.index + close[0].length;
    }
  }

  // Cheap insurance now that shapes 1, 6, 7 and 8 all scan the full text: collapse identical
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
 * `["a"]`→array, `{...}`→object; fall back to the raw trimmed string for a plain path/word that
 * isn't valid JSON. (repairToolArguments still runs afterward to reconcile against the tool's
 * schema, so this only needs to be a sensible first guess.) */
function coerceInlineArgValue(raw: string): unknown {
  const t = raw.trim();
  if (t === '') return t;
  try { return JSON.parse(t); } catch { return t; }
}
