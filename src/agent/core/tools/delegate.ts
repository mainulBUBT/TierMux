
// General-purpose sub-agent delegation — the Claude Code "Task tool" pattern, adapted to
// TierMux's two existing sub-agent shapes: `research` mode is a bigger sibling of `explore`
// (read-only, cheap utility model, own loop, findings report), and `code` mode is a
// single-worker version of the fleet pipeline (disposable git worktree, full tool set under
// the worker approval policy, commit, merge back into the user's branch). Both keep the MAIN
// agent's context small: only the final report returns.
//
// Approval (policies/permission.ts): research is read-only and passes like other read tools;
// code mode is gated exactly like the other mutating tools (agent mode + user approval),
// because its effect — merged commits — mutates the user's branch.

import { tool, generateText, isStepCount } from 'ai';
import { z } from 'zod';
import * as vscode from 'vscode';
import type { Router } from '../../../router/router';
import { createRouterProvider } from '../routerProvider';
import { createSubAgentToolApproval, createWorkerToolApproval } from '../policies/permission';
import { effectiveRootUri, runWithWorkspaceRoot } from './workspaceRoot';
import { createReadTool } from './filesystem/read';
import { createWriteFileTool } from './filesystem/write';
import { createEditTool } from './filesystem/edit';
import { createDeleteTool } from './filesystem/delete';
import { createShellTool } from './shell/bash';
import { createListDirTool } from './workspace/list';
import { createGlobTool } from './workspace/glob';
import { createGrepTool } from './workspace/grep';
import { createDiagnosticsTool } from './workspace/diagnostics';
import {
  createWorktree, removeWorktree, commitAll, diffBranch, ensureWorktreeDirIgnored, gitExec,
  type WorktreeInfo,
} from '../../../edits/worktree';
import { isGitRepo } from '../../../edits/gitSnapshot';

// Research mode bounds: bigger than explore's quick lookup (6 steps / 20s) but still cheap —
// defaults of 20 steps / 3min on the utility model, read-only tools only. Overridable via
// tiermux.fleet.researchMaxSteps / researchTimeoutMs; the timeout doubles as network-hang
// protection for stuck free-tier providers, so raising it is safer than removing it.
const DEFAULT_RESEARCH_MAX_STEPS = 20;
const DEFAULT_RESEARCH_TIMEOUT_MS = 180_000;

// Code mode reuses the fleet's worker bounds (same settings drive both — a delegated
// implementation task IS a one-worker pipeline).
const DEFAULT_WORKER_MAX_STEPS = 16;
const DEFAULT_WORKER_TIMEOUT_MS = 5 * 60_000;

const RESEARCH_SYSTEM =
  'You are a research sub-agent. Investigate the workspace and report back to the main agent. '
  + 'You have READ-ONLY tools (readFile, grep, glob, listDir, getDiagnostics).\n\n'
  + 'Work systematically: locate the relevant code, read enough to answer precisely, and stop as '
  + 'soon as you can. Your report must include:\n'
  + '- A direct answer to the task (or the requested artifact: comparison, inventory, trace).\n'
  + '- The specific evidence: workspace-relative `path:line` locations and short quotes.\n'
  + '- Anything you could NOT establish, said plainly.\n'
  + 'Keep the report under ~600 words. Do not paste large code blocks — cite locations.';

const WORKER_SYSTEM =
  'You are an implementation sub-agent. Your working directory is a DISPOSABLE git worktree — '
  + 'a private copy of the repo where you can edit files freely; your committed work is merged '
  + 'back by the orchestrator when you finish.\n\n'
  + 'Rules:\n'
  + '- Implement ONLY the task you are given. No drive-by refactors.\n'
  + '- Do NOT run mutating git commands (commit, branch, checkout, push, …) — the orchestrator '
  + 'owns git; your edits are committed for you.\n'
  + '- Verify your own work (run the project check/test command if one exists) before finishing.\n'
  + '- Finish with a SHORT summary: what you changed and why, plus verification status. No large diffs.';

function researchConfig() {
  const cfg = vscode.workspace.getConfiguration('tiermux.fleet');
  return {
    maxSteps: cfg.get<number>('researchMaxSteps', DEFAULT_RESEARCH_MAX_STEPS),
    timeoutMs: cfg.get<number>('researchTimeoutMs', DEFAULT_RESEARCH_TIMEOUT_MS),
  };
}

function workerConfig() {
  const cfg = vscode.workspace.getConfiguration('tiermux.fleet');
  return {
    maxSteps: cfg.get<number>('workerMaxSteps', DEFAULT_WORKER_MAX_STEPS),
    timeoutMs: cfg.get<number>('workerTimeoutMs', DEFAULT_WORKER_TIMEOUT_MS),
  };
}

export function createDelegateTool(router: Router, abortSignal?: AbortSignal) {
  return tool({
    description:
      'Delegate one self-contained sub-task to an isolated sub-agent and get back only its report '
      + '(keeps your own context small). mode "research": read-only investigation on a cheap model — '
      + 'deeper than `explore`; use for multi-file analysis, tracing a flow, comparing options with '
      + 'evidence. mode "code": an implementation worker that edits files in a disposable git '
      + 'worktree, verifies, commits, and merges back into your branch — use for ONE focused, '
      + 'self-contained change you do not need to iterate on interactively. Give a crisp task '
      + 'statement with acceptance criteria; vague tasks come back vague.',
    inputSchema: z.object({
      description: z.string().describe('Short label for the sub-task (shown in approvals and reports).'),
      task: z.string().describe('The complete, self-contained task for the sub-agent — include goal, scope, and acceptance criteria.'),
      mode: z.enum(['research', 'code']).describe('research = read-only investigation; code = implement in an isolated worktree and merge back.'),
    }),
    execute: async (input: { description: string; task: string; mode: 'research' | 'code' }): Promise<string> => {
      if (!input.task?.trim()) throw new Error('Missing required "task" argument.');
      return input.mode === 'code'
        ? await runCodeDelegate(input.description, input.task, router, abortSignal)
        : await runResearchDelegate(input.task, router, abortSignal);
    },
  });
}

async function runResearchDelegate(task: string, router: Router, abortSignal?: AbortSignal): Promise<string> {
  const cfg = researchConfig();
  const utility = await router.pickUtilityModel();
  const provider = createRouterProvider(router, { taskKind: 'reasoning', pinnedModel: utility });

  const tools = {
    readFile: createReadTool(),
    grep: createGrepTool(),
    glob: createGlobTool(),
    listDir: createListDirTool(),
    getDiagnostics: createDiagnosticsTool(),
  };

  const timeout = AbortSignal.timeout(cfg.timeoutMs);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;

  try {
    const result = await generateText({
      model: provider,
      system: RESEARCH_SYSTEM,
      prompt: task,
      tools,
      toolApproval: createSubAgentToolApproval(),
      stopWhen: isStepCount(cfg.maxSteps),
      abortSignal: signal,
    });
    const text = (result.text ?? '').trim();
    return text || '(research sub-agent finished but produced no report)';
  } catch (err) {
    // Never throw out of a sub-agent — degrade to a message the main agent can act on.
    return `Research delegation failed: ${err instanceof Error ? err.message : String(err)}. Investigate directly instead.`;
  }
}

async function runCodeDelegate(description: string, task: string, router: Router, abortSignal?: AbortSignal): Promise<string> {
  const cfg = workerConfig();
  const repoRoot = effectiveRootUri().fsPath;
  if (!(await isGitRepo(repoRoot))) {
    return 'Code delegation aborted: not a git repo (an isolated worktree is required so your working tree is never touched directly). Implement it yourself instead.';
  }

  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const branch = `tiermux/delegate-${runId}`;
  const baseSha = (await gitExec(repoRoot, ['rev-parse', 'HEAD'])).trim();
  await ensureWorktreeDirIgnored(repoRoot);

  let worktree: WorktreeInfo | undefined;
  try {
    // worktree add -b creates the branch off HEAD and checks it out in one step (no separate
    // createBranch — that would make the add fail with "branch already exists").
    worktree = await createWorktree(repoRoot, branch, 'HEAD');

    const provider = createRouterProvider(router, { taskKind: 'coding', pinnedModel: undefined });
    const tools = {
      readFile: createReadTool(),
      writeFile: createWriteFileTool(false),
      createFile: createWriteFileTool(true),
      editFile: createEditTool(),
      deleteFile: createDeleteTool(),
      runCommand: createShellTool(),
      listDir: createListDirTool(),
      glob: createGlobTool(),
      grep: createGrepTool(),
      getDiagnostics: createDiagnosticsTool(),
    };

    const timeout = AbortSignal.timeout(cfg.timeoutMs);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;

    const prompt = `## Task\n${task}\n\nYour worktree: ${worktree.path}\nYour branch: ${branch}\n\n`
      + 'Read the relevant files first, implement the task, verify, then reply with the summary.';

    const result = await runWithWorkspaceRoot(worktree.path, () => generateText({
      model: provider,
      system: WORKER_SYSTEM,
      prompt,
      tools,
      toolApproval: createWorkerToolApproval(),
      stopWhen: isStepCount(cfg.maxSteps),
      abortSignal: signal,
    }));

    const summary = (result.text ?? '').trim() || '(worker produced no summary)';

    // Commit inside the worktree (the branch is checked out there), then merge into the user's
    // current branch. No other writer exists, so a conflict can only mean the user's tree moved
    // under us — in that case abort the merge cleanly and leave the branch for manual landing.
    const committed = await commitAll(worktree.path, `TierMux delegate: ${description || task.slice(0, 60)}`).catch(() => false);
    if (!committed) {
      return `Delegated worker finished but had nothing to commit (or the commit failed).\n\nSummary:\n${summary}`;
    }
    const filesChanged = await diffBranch(worktree.path, branch, baseSha).catch(() => [] as string[]);

    let mergeMsg: string;
    try {
      await gitExec(repoRoot, ['merge', '--no-edit', branch]);
      mergeMsg = `Merged \`${branch}\` into your current branch (${filesChanged.length} file(s): ${filesChanged.join(', ') || 'none'}).`;
    } catch {
      await gitExec(repoRoot, ['merge', '--abort']).catch(() => undefined);
      mergeMsg = `Could NOT merge cleanly (your working tree moved conflicting files). Nothing was changed. Inspect or merge manually:\n`
        + `\`git diff HEAD...${branch}\`\n\`git merge ${branch}\``;
    }

    return `# Delegation complete — ${description || 'task'}\n\n${mergeMsg}\n\n## Worker summary\n${summary}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Code delegation failed: ${msg}. The worktree was cleaned up; branch \`${branch}\` may still exist for inspection.`;
  } finally {
    if (worktree) {
      try { await removeWorktree(repoRoot, worktree.path, { force: true }); } catch { /* best-effort */ }
    }
  }
}
