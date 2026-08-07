

import { tool } from 'ai';
import { z } from 'zod';
import { getWorkspaceIndex } from '../indexAccess';
import { incSymbolHit } from '../../../../context/telemetry';
import { capToolOutput } from '../capOutput';

const MAX_RESULTS = 30;
const MAX_CHARS = 4 * 1024;

/** getSymbolGraph — the workspace symbol index. One call returns every definition of a symbol
 *  (function/class/type/…) with file + line across the whole project, so the model doesn't have
 *  to `grep` and then `readFile` each hit to find a definition. Prefers the running language
 *  server (accurate) and falls back to the in-memory regex index when no LS is active.
 *
 *  Backs the `getSymbolGraph` tool-card label that already existed in ToolCard.ts with no
 *  implementation, and drives the symbol-hit telemetry the status-bar gauge reads. */
export function createSymbolGraphTool() {
  return tool({
    description:
      'Find where a symbol (function, class, interface, type, method, variable) is DEFINED across the workspace. '
      + 'Returns name, kind, file, and line number. Use this INSTEAD of grep when you need a symbol\'s definition location(s). '
      + 'Works for any language with a running language server, with a regex fallback otherwise. '
      + 'Does not find usages/references — for those use grep.',
    inputSchema: z.object({
      symbol: z.string().describe('The symbol name to look up (e.g. "createToolSet", "Router", "UserController").'),
      limit: z.number().optional().describe('Max results (default 20).'),
    }),
    execute: async ({ symbol, limit }: { symbol: string; limit?: number }) => {
      if (!symbol) throw new Error('Missing required "symbol" argument.');
      const idx = getWorkspaceIndex();
      const refs = await idx.findSymbol(symbol, Math.min(limit ?? 20, MAX_RESULTS));
      if (refs.length === 0) {
        return capToolOutput(`No definitions found for "${symbol}". Try grep to search usages, or check the name/spelling.`, MAX_CHARS);
      }
      incSymbolHit(); // a real index hit — drives the retrieval-quality gauge off grep
      const lines = refs.map((r) => {
        const cont = r.container ? ` (in ${r.container})` : '';
        const src = r.source === 'index' ? ' [indexed]' : '';
        return `${r.name} · ${r.kind} · ${r.filePath}:${r.line}${cont}${src}`;
      });
      const header = `${refs.length} definition${refs.length === 1 ? '' : 's'} for "${symbol}":\n`;
      return capToolOutput(header + lines.join('\n'), MAX_CHARS, 'Refine the symbol name for fewer matches.');
    },
  });
}
