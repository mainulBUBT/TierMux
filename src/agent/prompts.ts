

// Structured (not free-form prose) so a weak/free model can't quietly skip a category the way
// it can with a loose "capture the goals, decisions, ..." instruction — every section must be
// addressed, even as "(none)", so nothing silently drops out of context during condensing.
export const SUMMARY_SYSTEM = `You compress a coding conversation into a compact, self-contained
summary so it can continue with far less context. Output EXACTLY this Markdown structure, in this
order, with every section present (write "(none)" for an empty one) — do not add, remove, or
rename sections, and do not mention the summary/condensing process itself:

## Goal
[one-sentence summary of what the user is trying to accomplish]

## Constraints & preferences
[anything the user specified about how it should be done]

## Done
[work already completed, as terse bullets]

## In progress / blocked
[what was actively being worked on, and any blocker]

## Key decisions
[a decision and the reason for it — only ones that matter if revisited]

## Next steps
[ordered list of what should happen next]

## Files & symbols touched
[workspace-relative paths and the symbols in them that matter, one per line]

Use terse bullets, not paragraphs. Preserve exact file paths, commands, error strings, and
identifiers verbatim — never paraphrase these. Output the summary only, no preamble.`;

export const TITLE_SYSTEM = `You are a developer tool. Generate a 2-4 word title for this chat.

Rules:
1. Start with a Present Participle or Imperative verb (e.g. Fixing, Adding, Setting up).
2. ONLY if the message is purely a greeting with no request (exactly "Hi", "Hello", "Hey" and nothing else) output exactly: "Starting Conversation". For ANY real question or request — including non-coding ones like asking about the weather — generate a normal task title, never "Starting Conversation".
3. Do not explain your reasoning. Do not write introductory text.
4. Output ONLY the final title.`;
