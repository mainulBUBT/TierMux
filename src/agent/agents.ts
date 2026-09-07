// Sub-agent registry — built-ins plus `.tiermux/agents/*.md`, the same frontmatter shape
// skills use. vscode-free (plain fs) so headless callers can read it.

import * as fs from 'fs';
import * as path from 'path';

export interface AgentDef {
  name: string;
  /** One line telling the caller when to delegate to this agent — it reaches the model in
   *  delegateTask's description, so it is the only thing that makes the agent discoverable. */
  description: string;
  /** Tool names the agent may use; undefined = the read-only research set. */
  tools?: string[];
  /** `platform::modelId` pin. Without one the agent routes by `taskKind`. */
  model?: string;
  taskKind?: string;
  /** Step cap for one delegation. */
  maxSteps?: number;
  /** Run by the host, not offered to the model through delegateTask. */
  internal?: boolean;
  /** The agent's system prompt (METHOD is prepended by the runner). */
  prompt: string;
}

const EXPLORE_PROMPT = `You are the Explore agent: you investigate the workspace and report back. You cannot modify anything — no file writes, and runCommand accepts read-only commands only (git log/show/diff/status, listings, data queries).

## Strategy by question

- **Where is X / how does X work** — start from the manifest or entry point, follow imports, read the tests: they show intended usage. Search for the bare symbol before guessing at names.
- **A bug or a wrong value** — look at the failing thing first (the record, the log line, the test output), then the code that produces it. Check git history for what changed. Look for the same pattern elsewhere; one bug is often three.
- **Architecture / structure** — map directories and module boundaries, trace one representative request or data flow end to end rather than reading everything.

## Report

Your final message is all the caller sees — write it as the answer, not as a status update:

1. **Answer** — the question, answered, in one or two sentences.
2. **Evidence** — each claim with its \`path:line\` and the code or output that proves it.
3. **Ruled out** — what you checked that turned out not to be the cause, so the caller does not repeat it.
4. **Open** — anything you could not determine, and what would settle it.`;

const REVIEW_PROMPT = `You are the Review agent: you look for defects in code you did not write. You cannot modify anything — read-only commands only.

Start from the change itself (\`git diff\`, or the paths the caller named), then read enough of the surrounding code to judge it. Rank findings by severity and lead with them; a summary of what the change does is worth at most one line.

For each finding: the \`path:line\`, what is wrong, and the concrete input or state that makes it go wrong. A finding you cannot make fail is a question, not a finding — say so. If you find nothing, say that plainly and name what you could not check.`;

const AUDIT_PROMPT = `You are the Audit agent. A turn has just declared some of its todos complete. Decide, from the workspace as it is NOW, whether each one is actually done.

The claim is not the evidence. Do not accept a todo as done because someone said so, intended to, or described the change — open the file, run the read-only command, look at the output. If a todo says a value is validated, find the validation. If it says a bug is fixed, find the fix.

You cannot modify anything; runCommand accepts read-only commands only. Be quick: a few targeted checks, not a re-investigation.

Answer with ONE of these as your FIRST line, nothing before it:

VERIFIED
INCOMPLETE: <which todo, and the specific thing that is missing>

Then, in at most three lines, the path:line (or command output) you checked for each todo. Say VERIFIED when the evidence is there — a todo you could not check either way counts as verified, since guessing costs the user a wasted round.`;

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: 'audit',
    description: 'Check, from the workspace as it is now, whether declared todos are actually done.',
    taskKind: 'debug',
    maxSteps: 6,
    internal: true,
    prompt: AUDIT_PROMPT,
  },
  {
    name: 'explore',
    description: 'Investigate the codebase and report findings — where something lives, how it works, why a value is wrong. Read-only.',
    taskKind: 'debug',
    prompt: EXPLORE_PROMPT,
  },
  {
    name: 'review',
    description: 'Review a change or a file for defects, ranked by severity, with the input that triggers each. Read-only.',
    taskKind: 'debug',
    prompt: REVIEW_PROMPT,
  },
];

function parseAgentFile(name: string, raw: string): AgentDef | undefined {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  const body = (m ? m[2] : raw).trim();
  if (!body) return undefined;
  const fm = m ? m[1] : '';
  const scalar = (key: string): string | undefined => {
    const hit = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm);
    return hit ? hit[1].trim().replace(/^["']|["']$/g, '') : undefined;
  };
  // `tools: [a, b]` or a YAML list of `- a` lines.
  const list = (key: string): string[] | undefined => {
    const inline = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, 'm').exec(fm);
    if (inline) return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const block = new RegExp(`^${key}:\\s*\\n((?:\\s*-\\s*.+\\n?)+)`, 'm').exec(fm);
    if (block) return block[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
    return undefined;
  };
  const steps = Number(scalar('maxSteps'));
  const isInternal = scalar('internal') === 'true' || (BUILTIN_AGENTS.find((b) => b.name === name)?.internal ?? false);
  return {
    name,
    description: scalar('description') ?? '',
    tools: list('tools'),
    model: scalar('model'),
    taskKind: scalar('taskKind'),
    maxSteps: Number.isFinite(steps) && steps > 0 ? steps : undefined,
    internal: isInternal ? true : undefined,
    prompt: body,
  };
}

const cache = new Map<string, Map<string, AgentDef>>();
const watched = new Set<string>();

/** Built-ins first, then `.tiermux/agents/*.md` — a workspace file with a built-in's name
 *  replaces it, so `explore.md` is how a project customizes exploration. */
export function loadAgents(workspaceRoot?: string): Map<string, AgentDef> {
  const key = workspaceRoot ?? '';
  const hit = cache.get(key);
  if (hit) return hit;

  const agents = new Map<string, AgentDef>();
  for (const a of BUILTIN_AGENTS) agents.set(a.name, a);

  if (workspaceRoot) {
    const dir = path.join(workspaceRoot, '.tiermux', 'agents');
    if (!watched.has(dir)) {
      try {
        fs.watch(dir, () => cache.delete(key));
        watched.add(dir);
      } catch { /* created later */ }
    }
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { /* absent */ }
    for (const f of files) {
      try {
        const def = parseAgentFile(path.basename(f, '.md').toLowerCase(), fs.readFileSync(path.join(dir, f), 'utf8'));
        if (def) agents.set(def.name, def);
      } catch { /* skip unreadable file */ }
    }
  }
  cache.set(key, agents);
  return agents;
}

export function invalidateAgentsCache(): void {
  cache.clear();
  watched.clear();
}
