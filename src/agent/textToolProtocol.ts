// Text (XML-style) tool-calling protocol — the fallback that lets weak free models ACT.
//
// Many free-tier models either don't support OpenAI-style native function-calling or
// silently ignore the `tools` param, so they reply with prose ("I'll add the function to
// foo.ts…") and never emit a real tool call. Cline solves this by teaching the model an
// XML protocol and parsing tool calls out of the plain-text reply — which is why it works
// across basically any model. This module is that mechanism for TierMux: a prompt that
// teaches the format, and a parser that turns the reply back into ChatToolCall objects so
// the existing agent loop can execute them unchanged.
//
// XML (not JSON) on purpose: weak models can't reliably JSON-escape a whole file's content
// (quotes/newlines), which is exactly what `allUnparseable` in escalation.ts flags as
// garbage. Between XML tags the content is written literally — no escaping — so they get it
// right far more often.
import type { ChatToolCall, ChatToolDefinition } from '../shared/types';

let seq = 0;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Instructions appended to the system prompt (weak models) teaching the XML tool format and
 * listing the tools actually available this run, so the model knows them even if it ignores
 * the native schemas. Generated from the live tool set — never hard-coded.
 */
export function textToolProtocolPrompt(tools: ChatToolDefinition[]): string {
  const lines = tools.map((t) => {
    const props = (t.function.parameters?.properties ?? {}) as Record<string, unknown>;
    const required = new Set((t.function.parameters?.required ?? []) as string[]);
    const params = Object.keys(props).map((p) => (required.has(p) ? p : `${p}?`)).join(', ');
    return `- ${t.function.name}(${params})`;
  });
  return `# Calling tools (read this carefully)
To actually DO something (read, search, edit, run), you must call a tool. If your native tool
calls aren't getting through, call a tool by writing an XML block in your reply — one block per
tool, exactly like this:

<toolName>
<paramName>value</paramName>
</toolName>

Rules:
- Put the XML block on its own lines. A short sentence of reasoning before it is fine.
- One tool per turn is safest — after it runs you'll get the result and can call the next.
- Do NOT wrap the block in code fences and do NOT escape the content: write file contents,
  search text, and replacement text literally between the tags.
- Never just describe an edit in prose — emit the editFile/createFile block so it actually happens.
- When the task is fully complete, reply with a normal final answer and NO tool tags.

Examples:
<readFile>
<path>src/index.ts</path>
</readFile>

<editFile>
<path>src/index.ts</path>
<search>const timeout = 1000</search>
<replace>const timeout = 5000</replace>
</editFile>

Tools available to you now:
${lines.join('\n')}`;
}

/**
 * Parse XML tool blocks out of a model reply into ChatToolCall objects (same shape native
 * tool-calling produces), so the agent loop executes them identically. Only tags matching a
 * known tool/param name are recognized, so ordinary prose and code containing unrelated tags
 * (e.g. `</div>`) are ignored.
 *
 * Known limitation: a param value that itself contains the literal closing tag (e.g. file
 * content with `</content>` in it) truncates at the first occurrence. Rare in practice, and the
 * existing escalation/garbage-detection safety net covers the fallout; harden later if needed.
 */
export function parseTextToolCalls(content: string, tools: ChatToolDefinition[]): ChatToolCall[] {
  if (!content) return [];
  const byName = new Map(tools.map((t) => [t.function.name, t] as const));
  const names = tools.map((t) => t.function.name);
  if (!names.length) return [];

  const blockRe = new RegExp(`<(${names.map(escapeRegExp).join('|')})>([\\s\\S]*?)</\\1>`, 'g');
  const calls: ChatToolCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    const spec = byName.get(name);
    const props = (spec?.function.parameters?.properties ?? {}) as Record<string, { type?: string }>;
    const paramNames = Object.keys(props);
    const args: Record<string, unknown> = {};
    for (const p of paramNames) {
      const pm = new RegExp(`<${escapeRegExp(p)}>([\\s\\S]*?)</${escapeRegExp(p)}>`).exec(body);
      if (!pm) continue;
      let val: unknown = pm[1].replace(/^\n/, '').replace(/\n$/, ''); // models pad content with newlines
      const type = props[p]?.type;
      if (type === 'number') { const n = Number(String(val).trim()); if (!Number.isNaN(n)) val = n; }
      else if (type === 'boolean') { val = /^true$/i.test(String(val).trim()); }
      else if (type === 'array' || type === 'object') { try { val = JSON.parse(String(val)); } catch { /* leave raw — repair may handle */ } }
      args[p] = val;
    }
    // A tool with params only counts once it supplied at least one; a no-param tool always counts.
    if (paramNames.length === 0 || Object.keys(args).length > 0) {
      calls.push({ id: `tt_${++seq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    }
  }
  return calls;
}
