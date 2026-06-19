# Per-Task Utility Model Override

## Goal
Add two new settings so users can pick a different model for **commit messages** and **chat titles** independently. Both default to the existing `tiermux.utilityModel` (which itself defaults to `auto`).

## New settings

| Setting | Default | Used for |
|---|---|---|
| `tiermux.commitMessageModel` | `tiermux.utilityModel` | Generating AI commit messages |
| `tiermux.chatTitleModel` | `tiermux.utilityModel` | Generating chat session titles |
| `tiermux.utilityModel` (existing) | `auto` | Fallback when the per-task setting is unset/`auto` |

Each accepts the same values:
- `"auto"` → fall back to `tiermux.utilityModel`
- `"platform::modelId"` → use that specific model (e.g. `ovh::gpt-oss-120b`)

## Resolution order

```
Commit message:
  1. tiermux.commitMessageModel if not "auto"
  2. tiermux.utilityModel if not "auto"
  3. pickUtilityModel() (keyless first, then keyed, then smartest)

Chat title:
  1. tiermux.chatTitleModel if not "auto"
  2. tiermux.utilityModel if not "auto"
  3. pickUtilityModel()
```

## Changes

### 1. `src/router/router.ts` — add a generic resolver

```typescript
/**
 * Resolve a per-task model setting: explicit choice → utilityModel fallback → default ladder.
 * Used by short-task callers (commitMessage, chatTitle) so users can override per-task.
 */
async resolveUtilityModel(settingKey: 'commitMessageModel' | 'chatTitleModel'): Promise<string | undefined> {
  const explicit = vscodeConfigString(`tiermux.${settingKey}`, 'auto');
  if (explicit && explicit !== 'auto' && (await this.readyForModel(explicit))) return explicit;
  // Fall through to the existing utility-model ladder
  return this.pickUtilityModel();
}
```

Refactor `pickUtilityModel` to extract the `readyForModel` helper (currently inlined) so both methods can use it.

### 2. `src/scm/commitMessage.ts` — use the new resolver

Change line 113:
```typescript
const model = await router.pickUtilityModel();
```
to:
```typescript
const model = await router.resolveUtilityModel('commitMessageModel');
```

### 3. `src/chatViewProvider.ts` — use the new resolver for titles

In `maybeGenerateTitle` (around line 1516), find where the model is picked and change it to use `resolveUtilityModel('chatTitleModel')`.

### 4. `package.json` — add the two settings

```json
"tiermux.commitMessageModel": {
  "type": "string",
  "default": "auto",
  "description": "Model used for AI commit messages. 'auto' uses tiermux.utilityModel (which itself defaults to a strong keyless model). Or pick a specific 'platform::modelId'."
},
"tiermux.chatTitleModel": {
  "type": "string",
  "default": "auto",
  "description": "Model used for chat session titles. 'auto' uses tiermux.utilityModel. Or pick a specific 'platform::modelId'."
}
```

### 5. `media/main.js` — extend the Others section

The current `renderOthersSection` shows a single picker for the utility model. Extend it to show three:

```
Titles & commit messages
Model used for short utility tasks (defaults below).

┌─────────────────────────────────────────┐
│ Chat titles                              │
│   [ Search models…                ]       │
│   ● Auto (uses utility model)             │
│   ○ OVH — gpt-oss-120b (keyless)         │
│   ...                                     │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Commit messages                          │
│   [ Search models…                ]       │
│   ● Auto (uses utility model)             │
│   ○ OVH — gpt-oss-120b (keyless)         │
│   ...                                     │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Default (utility model) — fallback for Auto│
│   ● Auto (prefers keyless)               │
│   ...                                     │
└─────────────────────────────────────────┘
```

### 6. New webview messages

Add two message types in `src/messages.ts` and handle in `chatViewProvider.ts`:

```typescript
case 'setCommitMessageModel':
  await vscode.workspace.getConfiguration('tiermux').update('commitMessageModel', m.model, vscode.ConfigurationTarget.Global);
  await this.sendConfig();
  break;
case 'setChatTitleModel':
  await vscode.workspace.getConfiguration('tiermux').update('chatTitleModel', m.model, vscode.ConfigurationTarget.Global);
  await this.sendConfig();
  break;
```

### 7. `src/messages.ts` — extend the config payload

Add to the `config` message:
```typescript
commitMessageModel: string;
chatTitleModel: string;
utilityModel: string;  // already exists
```

## Files to modify

| File | Change |
|---|---|
| `src/router/router.ts` | Add `resolveUtilityModel`; extract `readyForModel` helper |
| `src/scm/commitMessage.ts` | Use `resolveUtilityModel('commitMessageModel')` |
| `src/chatViewProvider.ts` | Use `resolveUtilityModel('chatTitleModel')`; handle new messages; send new config fields |
| `package.json` | Add 2 settings |
| `media/main.js` | Extend Others section with 3 pickers |
| `src/messages.ts` | Add new config fields + message types |

## Acceptance criteria

1. New settings appear in the Models panel → Others tab.
2. Setting `commitMessageModel` overrides the utility model for commit messages only.
3. Setting `chatTitleModel` overrides the utility model for chat titles only.
4. Both default to `"auto"` which falls back to `utilityModel`.
5. Picking the same model for both works as before (no regression).
6. Title check + typecheck pass.
