// POC ONLY — stub tools for the v3 foundation scenarios (plan step 1, converted for real in step 3).
//
// v3 tool contract (plan §4): every execute() is exception-safe — expected failures return
// `{ error: string }` so the model sees them and self-corrects next turn. Unexpected throws
// still bubble to the SDK, which wraps them as a `tool-error` part (verified at
// ai/dist/index.js:3042-3065) — that's Path B, exercised by `throwingTool` in scenario 5.
//
// The POC stubs use plain fs against a temp root (no vscode import) so the e2e runs without
// the webview/extension host.

import * as fs from 'fs';
import * as path from 'path';
import { tool } from 'ai';
import { z } from 'zod';

/** Tools that never mutate anything — the policy auto-approves these (plan §3). */
export const READ_ONLY_TOOLS = new Set([
  'readFile', 'listDir', 'glob', 'grep', 'getDiagnostics', 'getSymbolGraph',
  'getDependencyTree', 'webSearch', 'fetchUrl', 'showTodo', 'askUser', 'recallNotes', 'checkPlan',
]);

export function buildStubTools(root: string) {
  const resolve = (p: string) => path.resolve(root, p.replace(/^\/+/, ''));

  const readFile = tool({
    description: 'Read the contents of a file in the workspace.',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative path'),
    }),
    execute: async ({ path: rel }) => {
      try {
        return await fs.promises.readFile(resolve(rel), 'utf8');
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  const editFile = tool({
    description: 'Replace the first occurrence of a search string in a file.',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative path'),
      search: z.string().describe('Exact text to find'),
      replace: z.string().describe('Replacement text'),
    }),
    execute: async ({ path: rel, search, replace }) => {
      try {
        const abs = resolve(rel);
        const before = await fs.promises.readFile(abs, 'utf8');
        if (!before.includes(search)) return { error: `search text not found in ${rel}` };
        await fs.promises.writeFile(abs, before.replace(search, replace), 'utf8');
        return `edited ${rel}`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  const writeFile = tool({
    description: 'Write a file, creating or overwriting it.',
    inputSchema: z.object({
      path: z.string(),
      content: z.string(),
    }),
    execute: async ({ path: rel, content }) => {
      try {
        await fs.promises.mkdir(path.dirname(resolve(rel)), { recursive: true });
        await fs.promises.writeFile(resolve(rel), content, 'utf8');
        return `wrote ${rel}`;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  /** Scenario 5 only: deliberately throws so the SDK's tool-error wrapping (Path B) fires. */
  const throwingTool = tool({
    description: 'Test tool that always throws.',
    inputSchema: z.object({ message: z.string().optional() }),
    execute: async ({ message }): Promise<string> => {
      throw new Error(message ?? 'boom: tool crashed unexpectedly');
    },
  });

  return { readFile, editFile, writeFile, throwingTool };
}

export type StubTools = ReturnType<typeof buildStubTools>;
