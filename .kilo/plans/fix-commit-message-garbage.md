# Fix: Commit Message Generator Shows Garbage

## User constraint
**No UI changes.** Only behavior. The picker UI in Models → Others stays as-is.

## Bug
Clicking the AI commit-message button places garbage text in the SCM input box — random characters, prompt echoes, repeated lines, model refusals, or JSON wrappers instead of a real commit message.

## Root cause (from `src/scm/commitMessage.ts`)

### 1. Weak keyless model selected first
`router.pickUtilityModel()` (`src/router/router.ts:116-145`) tries free keyless models first:
- `ovh::gpt-oss-120b`
- `ovh::Meta-Llama-3_3-70B-Instruct`
- `pollinations::openai-fast`

These are the only models the user has access to without a key. They are also the models most likely to produce noisy, non-compliant output for short structured tasks (≤256 tokens).

### 2. Insufficient output cleaning
`cleanCommitMessage()` (`commitMessage.ts:47-59`) only handles:
- Complete `<think>…</think>` blocks
- ONE code fence
- A "Here is/Here's …:" preamble (single regex)

It misses:
- JSON wrappers (`{"message": "..."}`, `{"subject": "..."}`)
- Multiple nested code fences
- Model refusals (`I cannot…`, `As an AI…`, `I'm sorry…`)
- Prompt echoes (model copies the system prompt's first sentence)
- Repeated-line noise (`feat: add\nfeat: add\nfeat: add`)
- Markdown headers (`# Commit message`, `**Subject:**`)
- Quoted blocks (model echoes the diff)
- Binary / non-printable noise
- Output >500 chars (model rambling)

### 3. No validation, no retry
Line 122-123 of `commitMessage.ts`:
```typescript
const msg = cleanCommitMessage(contentToString(result.response.choices[0]?.message.content));
if (msg) repo.inputBox.value = msg;
```
If cleaning produces anything non-empty, it goes straight into the input box. No format check, no retry, no fallback.

### 4. Prompt-mirroring risk
User message wraps the diff in a ` ```diff ` fence (line 110). The system prompt says "no markdown fences." Some free models mirror the input format, producing their own fence around the output.

---

## Fix plan (behavior only, no UI)

### 1. Rewrite `cleanCommitMessage` to handle all known garbage patterns

`src/scm/commitMessage.ts` — expand the cleaning function:

```typescript
function cleanCommitMessage(raw: string): string {
  let s = raw.trim();

  // 1. Strip <think>…</think> reasoning blocks (existing)
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/^[\s\S]*?<\/think>/i, '').trim();
  s = s.replace(/<think>[\s\S]*$/i, '').trim();

  // 2. Strip ALL code fences (anywhere in the text, not just edges)
  s = s.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();

  // 3. Strip JSON wrappers
  const jsonMatch = s.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (typeof obj === 'string') s = obj;
      else if (obj && typeof obj === 'object') {
        const candidate = obj.message ?? obj.subject ?? obj.body ?? obj.commit ?? obj.text;
        if (typeof candidate === 'string') s = candidate;
      }
    } catch { /* not JSON, leave as-is */ }
  }

  // 4. Strip leading header/markdown (e.g. "# Commit message", "**Subject:** …")
  s = s.replace(/^#{1,6}\s*[^\n]*\n+/g, '').trim();
  s = s.replace(/^\*\*[^*]+:\*\*\s*/g, '').trim();

  // 5. Strip common preambles
  s = s.replace(/^(?:sure[,!]?\s*)?here(?:'s| is)[^\n:]*:\s*/i, '').trim();
  s = s.replace(/^(?:commit message|subject):\s*/i, '').trim();

  // 6. Collapse 3+ identical consecutive lines into one
  s = s.replace(/^(.*\n)\1{2,}/gm, '$1').trim();

  // 7. Take only the first paragraph if the model rambles past 3 blank-line-separated chunks
  const paragraphs = s.split(/\n{2,}/);
  if (paragraphs.length > 2) s = paragraphs.slice(0, 2).join('\n\n');

  // 8. Trim any quoted block (model echoing the diff)
  s = s.replace(/^>+\s*/gm, '').trim();

  return s;
}
```

### 2. Add `looksLikeGarbage` validator

```typescript
const REFUSAL_PREFIXES = /^(i cannot|i'm sorry|im sorry|as an ai|sure[!,.]?\s*|okay[!,.]?\s*|certainly[!,.]?\s*|of course[!,.]?\s*)/i;

function looksLikeGarbage(text: string): boolean {
  if (!text || !text.trim()) return true;
  const t = text.trim();
  if (t.length < 5) return true;                       // too short
  if (t.length > 2000) return true;                    // rambling
  if (/[\x00-\x08\x0E-\x1F]/.test(t)) return true;    // control chars
  if (REFUSAL_PREFIXES.test(t)) return true;           // refusal / preamble
  // 3+ identical consecutive lines
  if (/^(.*\n)\1{2,}/m.test(t)) return true;
  // Mostly echoes the diff (long quoted block)
  if ((t.match(/^>+\s/gm) || []).length > 3) return true;
  // No subject-line shape and no newlines (single nonsense word)
  if (!t.includes('\n') && !/^[a-z]+(\([^)]+\))?[!:]?\s+\w+/i.test(t) && t.split(/\s+/).length < 3) return true;
  return false;
}
```

### 3. Multi-stage fallback chain

Replace the single `router.route()` call with a chain:

```typescript
const modelAttempts = [
  model,                                          // user's choice (or auto-ladder)
  'google::gemini-2.5-flash',                     // stronger, often keyless-tier
  'groq::llama-3.3-70b-versatile',                // strong fallback
  'openrouter::deepseek/deepseek-chat-v3.1:free', // free + capable
];

let msg = '';
for (const m of modelAttempts) {
  if (!m) continue;
  if (!(await router.isReady(m))) continue;        // skip if not enabled/keyed
  try {
    const result = await router.route(messages, { temperature: 0.2, max_tokens: 256, model: m });
    msg = cleanCommitMessage(contentToString(result.response.choices[0]?.message.content));
    if (!looksLikeGarbage(msg)) break;              // success — stop
  } catch { /* try next */ }
}

// If all models produced garbage, use the template fallback
if (looksLikeGarbage(msg)) msg = buildTemplateFallback(filteredDiff);
```

Add `router.isReady(modelKey)` helper that checks if a model is enabled, keyed, and not in cooldown. (`pickUtilityModel` already has this logic inline — extract it.)

### 4. Better system prompt (more examples, explicit anti-patterns)

```typescript
const SYSTEM = `You write concise commit messages. Output ONLY the commit message text.

GOOD output:
feat: add OAuth login flow

Adds OAuth2 authentication with refresh token rotation.

GOOD output (single-line):
fix: handle null user in profile fetch

BAD output (never produce):
- "Here is the commit message: feat: add..."
- "\`\`\`\nfeat: add...\n\`\`\`"
- "I cannot generate a commit message without more context"
- "{\"subject\": \"feat: add...\"}"
- "Sure, here's a commit message for your changes..."

Rules:
- First line: <72 char imperative subject (e.g. "feat: add X", "fix: handle Y")
- Optional blank line + 1-3 sentence body for non-trivial changes
- If recent commits are listed, match their style/prefix/casing exactly
- No markdown, no fences, no JSON, no preamble, no explanation
- Output the commit message text and nothing else`;
```

### 5. Remove the code-fence wrap in the user message

Change line 110 from:
```typescript
{ role: 'user', content: `...Generate a commit message for this diff:\n\n\`\`\`diff\n${clipped}\n\`\`\`` }
```
to:
```typescript
{ role: 'user', content: `...Generate a commit message for this diff:\n\n<diff>\n${clipped}\n</diff>` }
```

`</diff>` is unique enough that the model won't mirror it. Avoids the prompt-mirroring risk that the code-fence wrap creates.

### 6. Deterministic template fallback

```typescript
function buildTemplateFallback(diff: string): string {
  const paths = [...diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
  const topDir = paths.length > 0
    ? paths[0].split('/').slice(0, 2).join('/')
    : 'project';
  const added = (diff.match(/^\+[^+]/gm) || []).length;
  const removed = (diff.match(/^-[^-]/gm) || []).length;
  return `chore: update ${paths.length} file(s) in ${topDir}\n\n` +
    `Files changed: ${paths.slice(0, 5).map((p) => `- ${p}`).join('\n')}` +
    (paths.length > 5 ? `\n- ... +${paths.length - 5} more` : '');
}
```

Produces a clean, conventional-commits message from file paths. Never garbage because there's no LLM.

---

## Files to modify

| File | Change |
|---|---|
| `src/scm/commitMessage.ts` | Rewrite `cleanCommitMessage`; add `looksLikeGarbage`; add `buildTemplateFallback`; better prompt; remove code-fence wrap; add multi-stage fallback loop |
| `src/router/router.ts` | Add `isReady(modelKey)` helper (extract existing inlined logic); add `routeWithFallback` that returns `{ text, ok: boolean }` |

**No UI changes. No new commands. No new settings.**

## Validation

Add tests in `scripts/selftest.ts`:

```typescript
import { cleanCommitMessage, looksLikeGarbage } from '../src/scm/commitMessage';

ok('clean: strips JSON wrapper',
  cleanCommitMessage('{"message":"feat: add OAuth"}') === 'feat: add OAuth');
ok('clean: strips code fence',
  cleanCommitMessage('```\nfeat: add OAuth\n```') === 'feat: add OAuth');
ok('clean: strips preamble',
  cleanCommitMessage("Here's a commit message:\nfeat: add OAuth") === 'feat: add OAuth');
ok('clean: strips markdown header',
  cleanCommitMessage('# Commit message\n\nfeat: add OAuth') === 'feat: add OAuth');
ok('clean: collapses repeated lines',
  cleanCommitMessage('feat: add\nfeat: add\nfeat: add') === 'feat: add');
ok('clean: keeps good message',
  cleanCommitMessage('feat: add OAuth\n\nAdds OAuth2 auth.') === 'feat: add OAuth\n\nAdds OAuth2 auth.');

ok('garbage: empty', looksLikeGarbage(''));
ok('garbage: too short', looksLikeGarbage('hi'));
ok('garbage: too long', looksLikeGarbage('a'.repeat(3000)));
ok('garbage: refusal', looksLikeGarbage("I cannot generate a commit message"));
ok('garbage: repeated lines', looksLikeGarbage('feat: add\nfeat: add\nfeat: add'));
ok('garbage: control chars', looksLikeGarbage('feat:\u0000\u0000add'));
ok('good: simple', !looksLikeGarbage('feat: add OAuth login flow'));
ok('good: with body', !looksLikeGarbage('feat: add OAuth\n\nAdds OAuth2 auth.'));
ok('good: fix prefix', !looksLikeGarbage('fix: handle null user'));
```

## Acceptance criteria

1. **No garbage text** in the input box under any model output.
2. If LLM produces garbage, fallback chain tries 2-3 stronger models, then deterministic template.
3. The fallback template is always clean (no LLM involved).
4. Better prompt + cleaning handle: JSON, fences, preambles, refusals, repeated lines, markdown, quotes.
5. Existing tests still pass.
6. **No UI changes.**

## Risk

- **More LLM calls** when the first model produces garbage → bounded by 3 attempts.
- **Slightly higher latency** on the bad path (~2-4s extra) → only fires when model actually fails; success-path is unchanged.
- **Template fallback** is generic → acceptable, strictly better than garbage.
