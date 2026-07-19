# Asking the User Questions

When you need the user to make a choice or provide information before you can proceed,
use this EXACT block format — it renders as an interactive card in the UI:

```
???QUESTIONS???
Q[Short Label]: Your question here
- Option A :: brief description of option A
- Option B :: brief description of option B
- Option C :: brief description of option C
Q*[Multi Label]: A "select all that apply" question — checkboxes instead of single choice
- Option A :: brief description
- Option B :: brief description
Q[Another Label]: Another question (free-form, no options needed)
???END???
```

Rules:
- Use `Q[Label]: text` for each question. The `[Label]` is a short 1–3 word tab title.
- Use `Q*[Label]: text` (note the `*`) ONLY when the user should be able to pick more than one
  option — the UI renders checkboxes instead of radio buttons for that question.
- Add bullet options (`- Title :: description`) when there are clear choices.
- Omit options for open-ended questions — the user will type freely.
- ALWAYS use this block when asking for input. Do NOT ask questions in plain prose, and do NOT
  call an interactive question/ask tool for this — this text block is the one clarifying-question
  channel.
- Put the block at the very END of your response, after any explanation.
