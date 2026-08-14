

import { tool, generateText, isStepCount } from 'ai';
import { z } from 'zod';
import * as vscode from 'vscode';
import type { Router } from '../../../../router/router';
import { createRouterProvider } from '../../routerProvider';
import { createWorkerToolApproval } from '../../policies/permission';
import { effectiveRootUri, runWithWorkspaceRoot } from '../workspaceRoot';
import { getCommandGate } from '../gates';
import { createReadTool } from '../filesystem/read';
import { createWriteFileTool } from '../filesystem/write';
import { createEditTool } from '../filesystem/edit';
import { createDeleteTool } from '../filesystem/delete';
import { createShellTool } from '../shell/bash';
import { createListDirTool } from '../workspace/list';
import { createGlobTool } from '../workspace/glob';
import { createGrepTool } from '../workspace/grep';
import { createDiagnosticsTool } from '../workspace/diagnostics';
import {
  createWorktree, createWorktreeExistingBranch, createBranch, removeWorktree,
  mergeBranchIntoWorktree, diffBranch, type WorktreeInfo, type MergeOutcome,
} from '../../../../edits/worktree';
import { isGitRepo } from '../../../../edits/gitSnapshot';

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_WORKER_MAX_STEPS = 16;
const DEFAULT_WORKER_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_STAGING_PREFIX = 'tiermux/pipeline';

function fleetConfig() {
  const cfg = vscode.workspace.getConfiguration('tiermux.fleet');
  return {
    maxWorkers: cfg.get<number>('maxWorkers', DEFAULT_MAX_WORKERS),
    workerMaxSteps: cfg.get<number>('workerMaxSteps', DEFAULT_WORKER_MAX_STEPS),
    workerTimeoutMs: cfg.get<number>('workerTimeoutMs', DEFAULT_WORKER_TIMEOUT_MS),
    stagingBranchPrefix: cfg.get<string>('stagingBranchPrefix', DEFAULT_STAGING_PREFIX),
  };
}

const WORKER_SYSTEM =
  'You are an implementation WORKER inside a parallel pipeline. Your working directory is a '
  + 'DISPOSABLE git worktree — a private copy of the repo where you can edit files freely without '
  + 'affecting any other worker or the user.\n\n'
  + 'Rules:\n'
  + '- Implement ONLY the one subtask you are given. Do not start other workers\' work.\n'
  + '- Edit ONLY the files assigned to you. Touching shared files (barrels, index files, configs) '
  + 'that other workers also edit will cause a merge conflict.\n'
  + '- Do NOT run git commands (commit, branch, checkout, push, …). The orchestrator manages all '
  + 'git state for you; running git yourself disrupts the pipeline.\n'
  + '- Stop as soon as the acceptance criteria are met. Do not refactor beyond your assigned files.\n\n'
  + 'When done, reply with a SHORT summary: what you changed (file list) and confirmation the '
  + 'acceptance criteria are met. Do not paste large diffs.';

interface PlanItem {
  goal: string;
  files: string[];
  acceptanceCriteria: string;
  hints?: string;
}

interface WorkerResult {
  ok: boolean;
  summary: string;
  filesChanged: string[];
  verifyOk: boolean | null;
  verifyOutput: string | null;
}

/**
 * The fleet pipeline orchestration tool. The main agent authors a `plan` of INDEPENDENT subtasks
 * (partitioned so no two workers own the same file) and calls this; it spins up one disposable git
 * worktree per subtask, runs the workers in parallel (each a nested `generateText` loop scoped to
 * its worktree via `runWithWorkspaceRoot`), then merges each worker branch into a staging branch.
 *
 * The user's working tree is NEVER touched — workers edit only their worktrees, and merges land in
 * the staging branch (checked out in its own worktree). On conflict the merge is aborted and the
 * worker branch is left for inspection; nothing is ever auto-resolved. All worktrees are removed in
 * a `finally` (even on abort), but the staging + worker BRANCHES persist so the user can
 * merge/inspect/discard them.
 *
 * Model: each worker uses the router's full route (no pinned model) with taskKind 'coding', so it
 * gets a capable model and independent failover. Workers omit sessionId so they don't all force-pin
 * one provider. They share the router's rate/cooldown/health maps automatically.
 */
export function createImplementPipelineTool(router: Router, abortSignal?: AbortSignal) {
  const cfg = fleetConfig();

  return tool({
    description:
      'Run a parallel implementation pipeline for a task that splits into INDEPENDENT, '
      + 'NON-OVERLAPPING multi-file subtasks. Use this ONLY for genuinely parallelizable work '
      + '(e.g. "implement features A, B, C in separate modules") — it costs roughly N× a normal '
      + 'turn. Do NOT use it for a single-file fix, a question, or tightly-coupled work that must '
      + 'happen in sequence. Author a plan where each item owns a DISJOINT set of files (workers '
      + 'that edit the same file will conflict on merge); if subtasks share files, do them '
      + 'sequentially yourself instead. Workers edit in private git worktrees and their work is '
      + 'merged into a staging branch — your working tree is not modified. Returns a synthesis of '
      + 'what each worker did and how to inspect/merge the staging branch.',
    inputSchema: z.object({
      plan: z.array(z.object({
        goal: z.string().describe('The concrete implementation goal for this one worker.'),
        files: z.array(z.string()).describe('The DISJOINT set of files this worker will edit. No two plan items may share a file.'),
        acceptanceCriteria: z.string().describe('When is this subtask done? The worker stops when this is met.'),
        hints: z.string().optional().describe('Optional implementation hints, conventions, or links to reference code.'),
      })).min(1).max(8).describe('Independent subtasks. Each becomes one parallel worker.'),
      verifyCommand: z.string().optional().describe('Optional command (e.g. "npm test" or "tsc --noEmit") run in each worker\'s worktree before its work is merged. A non-zero exit blocks that worker\'s merge.'),
    }),
    execute: async (input: { plan: PlanItem[]; verifyCommand?: string }) => {
      const plan = input.plan;

      // 1. Partition check — disjoint files only.
      const overlap = findOverlap(plan);
      if (overlap) {
        return overlap; // tells the main agent to repartition or run sequentially
      }

      const items = plan.slice(0, Math.max(1, cfg.maxWorkers));
      if (plan.length > items.length) {
        return `Plan has ${plan.length} items but the worker cap is ${cfg.maxWorkers}. Repartition into at most ${cfg.maxWorkers} disjoint items, or run the rest sequentially after this pipeline.`;
      }

      const repoRoot = effectiveRootUri().fsPath;
      if (!(await isGitRepo(repoRoot))) {
        return `Not a git repo (${repoRoot}). The pipeline needs git to create isolated worktrees — aborting.`;
      }

      const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const stagingBranch = `${cfg.stagingBranchPrefix}-${runId}`;
      const workerBranches = items.map((_, i) => `tiermux/worker-${runId}-${i}`);

      const createdWorktrees: WorktreeInfo[] = [];
      let stagingWt: WorktreeInfo | undefined;

      try {
        // 2. Staging branch + its own worktree (so merges land there, never in the user's tree).
        await createBranch(repoRoot, stagingBranch, 'HEAD');
        stagingWt = await createWorktreeExistingBranch(repoRoot, stagingBranch);
        createdWorktrees.push(stagingWt);

        // 3. One worktree per worker, each on its own branch off HEAD.
        for (let i = 0; i < items.length; i++) {
          const wt = await createWorktree(repoRoot, workerBranches[i], 'HEAD');
          createdWorktrees.push(wt);
        }

        // 4. Run workers in parallel, each scoped to its worktree via ALS. One failure must not
        //    short-circuit the others or skip cleanup, so each worker catches its own errors.
        const verifyCommand = input.verifyCommand;
        const workerResults = await Promise.all(items.map((item, i) =>
          runWithWorkspaceRoot(createdWorktrees[i + 1].path, () => runWorker({
            item, planContext: items, branch: workerBranches[i], worktreePath: createdWorktrees[i + 1].path,
            router, parentAbort: abortSignal, verifyCommand,
          })),
        ));

        // 5. Merge each successful worker branch into the staging worktree, in order. Conflicts
        //    abort that worker's merge and leave its branch; nothing is auto-resolved.
        const merges: { branch: string; outcome: MergeOutcome; filesChanged: string[] }[] = [];
        for (let i = 0; i < workerResults.length; i++) {
          const r = workerResults[i];
          const branch = workerBranches[i];
          if (!r.ok || r.verifyOk === false) {
            merges.push({ branch, outcome: { ok: false, message: `Skipped (worker ${r.verifyOk === false ? 'failed verify' : 'errored'}). Branch left for inspection.` }, filesChanged: r.filesChanged });
            continue;
          }
          const filesChanged = await diffBranch(repoRoot, branch, 'HEAD').catch(() => r.filesChanged);
          const outcome = await mergeBranchIntoWorktree(stagingWt!.path, branch);
          merges.push({ branch, outcome, filesChanged });
        }

        // 6. Synthesis for the parent agent.
        return synthesize({ items, workerResults, merges, stagingBranch, repoRoot });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Pipeline failed before completion: ${msg}. Any worktrees were cleaned up; worker/staging branches may still exist for inspection.`;
      } finally {
        // 7. ALWAYS remove worktrees (even on abort/failure) so nothing leaks. Best-effort: a
        //    failed remove must not mask the real error or skip the remaining removes.
        for (const wt of createdWorktrees) {
          try { await removeWorktree(repoRoot, wt.path, { force: true }); } catch { /* best-effort */ }
        }
      }
    },
  });

  async function runWorker(args: {
    item: PlanItem;
    planContext: PlanItem[];
    branch: string;
    worktreePath: string;
    router: Router;
    parentAbort?: AbortSignal;
    verifyCommand?: string;
  }): Promise<WorkerResult> {
    const { item, planContext, branch, worktreePath, router, parentAbort, verifyCommand } = args;

    // Full route (no pinned model) → router picks a capable coding model with independent failover.
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

    const timeout = AbortSignal.timeout(cfg.workerTimeoutMs);
    const signal = parentAbort ? AbortSignal.any([parentAbort, timeout]) : timeout;

    const prompt = buildWorkerPrompt(item, planContext, branch, worktreePath);

    try {
      const result = await generateText({
        model: provider as any,
        system: WORKER_SYSTEM,
        prompt,
        tools: tools as any,
        toolApproval: createWorkerToolApproval() as any,
        stopWhen: isStepCount(cfg.workerMaxSteps),
        abortSignal: signal,
      } as any);

      const summary = ((result as any).text ?? '').trim() || '(worker produced no summary)';

      // Verify (optional): run verifyCommand in this worktree. Still inside runWithWorkspaceRoot,
      // so the command gate's cwd resolves to the worktree.
      let verifyOk: boolean | null = null;
      let verifyOutput: string | null = null;
      if (verifyCommand) {
        try {
          const res = await getCommandGate().runApproved(verifyCommand, undefined, undefined, undefined);
          verifyOk = res.exitCode === 0;
          verifyOutput = (res.error ? res.error + '\n' : '') + res.stdout + res.stderr;
        } catch (e) {
          verifyOk = false;
          verifyOutput = e instanceof Error ? e.message : String(e);
        }
      }

      const filesChanged = await diffBranch(worktreePath, branch, 'HEAD').catch(() => []);
      return { ok: true, summary, filesChanged, verifyOk, verifyOutput };
    } catch (err) {
      // Distinguish a clean abort (Stop button / timeout) from a real failure.
      const aborted = parentAbort?.aborted || signal.aborted;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        summary: aborted ? `Worker aborted (${branch}).` : `Worker failed: ${msg}`,
        filesChanged: [],
        verifyOk: null,
        verifyOutput: null,
      };
    }
  }
}

function buildWorkerPrompt(item: PlanItem, planContext: PlanItem[], branch: string, worktreePath: string): string {
  const others = planContext.filter((p) => p !== item).map((p) => `- ${p.goal} (files: ${p.files.join(', ')})`).join('\n');
  return ''
    + `Your branch: ${branch}\n`
    + `Your worktree: ${worktreePath}\n\n`
    + `## Your subtask\n`
    + `${item.goal}\n\n`
    + `## Files you own (edit ONLY these)\n`
    + `${item.files.map((f) => `- ${f}`).join('\n')}\n\n`
    + `## Acceptance criteria\n`
    + `${item.acceptanceCriteria}\n\n`
    + (item.hints ? `## Hints\n${item.hints}\n\n` : '')
    + (others ? `## Other workers running in parallel (for awareness — do not touch their files)\n${others}\n\n` : '')
    + `Begin. Read the files you own first, then implement the subtask.`;
}

/** Returns an error string if any two plan items share a file, else undefined. */
function findOverlap(plan: PlanItem[]): string | undefined {
  for (let i = 0; i < plan.length; i++) {
    for (let j = i + 1; j < plan.length; j++) {
      const shared = plan[i].files.filter((f) => plan[j].files.includes(f));
      if (shared.length) {
        return `Subtasks ${i} and ${j} both claim files (${shared.join(', ')}). Repartition so each `
          + `file is owned by exactly one worker, or run those subtasks sequentially instead of in the pipeline.`;
      }
    }
  }
  return undefined;
}

function synthesize(args: {
  items: PlanItem[];
  workerResults: WorkerResult[];
  merges: { branch: string; outcome: MergeOutcome; filesChanged: string[] }[];
  stagingBranch: string;
  repoRoot: string;
}): string {
  const { items, workerResults, merges, stagingBranch, repoRoot } = args;
  const lines: string[] = [`# Pipeline complete — staging branch: \`${stagingBranch}\``];

  let mergedCount = 0;
  let conflictCount = 0;
  for (let i = 0; i < workerResults.length; i++) {
    const r = workerResults[i];
    const m = merges[i];
    const status = !r.ok ? 'FAILED'
      : r.verifyOk === false ? 'VERIFY FAILED'
      : m.outcome.ok ? 'MERGED'
      : 'CONFLICT';
    if (status === 'MERGED') mergedCount++;
    if (status === 'CONFLICT') conflictCount++;
    lines.push(`\n## Worker ${i}: ${status}`);
    lines.push(`Goal: ${items[i].goal}`);
    lines.push(`Branch: \`${m.branch}\``);
    if (r.filesChanged.length) lines.push(`Files: ${r.filesChanged.join(', ')}`);
    lines.push(`Summary: ${r.summary}`);
    if (r.verifyOutput) lines.push(`Verify output:\n\`\`\`\n${r.verifyOutput.trim().slice(0, 1500)}\n\`\`\``);
    if (!m.outcome.ok) lines.push(`Merge: ${m.outcome.message}`);
  }

  lines.push(`\n## How to land this work`);
  lines.push(`Merged into staging branch \`${stagingBranch}\` (${mergedCount} merged, ${conflictCount} conflicted). To inspect:`);
  lines.push(`\`\`\`\ngit -C "${repoRoot}" diff HEAD...${stagingBranch}\n\`\`\``);
  lines.push(`To merge into your current branch when ready:`);
  lines.push(`\`\`\`\ngit merge ${stagingBranch}\n\`\`\``);
  if (conflictCount || workerResults.some((r) => !r.ok)) {
    lines.push(`\nConflicted/failed worker branches are kept for inspection:`);
    for (const m of merges) {
      if (!m.outcome.ok) lines.push(`- \`${m.branch}\`  →  \`git -C "${repoRoot}" diff HEAD...${m.branch}\``);
    }
  }
  return lines.join('\n');
}
