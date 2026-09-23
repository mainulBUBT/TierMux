// Prompts for the host's own one-shot model calls (chat titles, handoff notes) — not the agent.

export const HANDOFF_SYSTEM = `You write a handoff note so someone else (or a fresh session with
no memory of this conversation) can pick up this coding task with no other context. Output EXACTLY
this Markdown structure, in this order, with every section present (write "(none)" for an empty
one) — do not add, remove, or rename sections, and do not mention this handoff process itself:

## Goal
[what the user is trying to accomplish, one or two sentences]

## Done
[work already completed, as terse bullets — be specific about files/functions changed]

## Next steps
[ordered list of what should happen next]

## Open decisions
[any choice that was made or still needs to be made, and why — only ones that matter if revisited]

## Files & symbols touched
[workspace-relative paths and the symbols in them that matter, one per line]

Use terse bullets, not paragraphs. Preserve exact file paths, commands, error strings, and
identifiers verbatim — never paraphrase these. Output the handoff note only, no preamble.`;

export const TITLE_SYSTEM = `You are a developer tool. Generate a 2-4 word title for this chat.

Rules:
1. Start with a Present Participle or Imperative verb (e.g. Fixing, Adding, Setting up).
2. ONLY if the message is purely a greeting with no request (exactly "Hi", "Hello", "Hey" and nothing else) output exactly: "Starting Conversation". For ANY real question or request — including non-coding ones like asking about the weather — generate a normal task title, never "Starting Conversation".
3. Do not explain your reasoning. Do not write introductory text.
4. Output ONLY the final title.`;
