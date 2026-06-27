/**
 * `tiermux.bench` command orchestration: gather config via QuickPicks, build the
 * index/graph once, run the dataset, and write reports. Registered from extension.ts.
 *
 * Dev-only. Runs the real agent against the open workspace (bazardor). Always-on
 * benchmark determinism: temperature 0, pinned model, pinned effort.
 */
import * as path from 'path';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import type { Agent } from '../agent/agent';
import type { Router } from '../router/router';
import type { Catalog } from '../catalog/catalog';
import type { CodebaseIndex } from '../index/codebaseIndex';
// Pre-research graph + inverted index removed in v7.0. Bench still measures
// the legacy agent loop (when OpenCode engine is disabled or fails), but the
// O(1) symbol lookup + bundle cache no longer exist. The `agent.run()` path
// will simply skip pre-research for the OpenCode engine case.
import { resetTelemetry } from '../context/telemetry';
import { queriesForScope, planExecution, type Scope } from './queries';
import { Benchmark, runUnits } from './runner';
import { writeReports } from './report';

export interface BenchDeps {
  agent: Agent;
  router: Router;
  catalog: Catalog;
  index: CodebaseIndex;
  globalStorageUri: vscode.Uri;
}

export async function runBenchmarkCommand(deps: BenchDeps): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('TierMux Benchmark: open the bazardor workspace folder first.');
    return;
  }
  const workspace = folder.uri.fsPath;

  // Guard: require a clean git tree so restore is safe.
  if (!(await isClean(workspace))) {
    const proceed = await vscode.window.showWarningMessage(
      'TierMux Benchmark: workspace has uncommitted changes. The runner restores files via `git restore` + `git clean -fd` after each query, which would discard them. Commit or stash first.',
      'Cancel',
    );
    if (proceed === 'Cancel' || !proceed) return;
  }

  // --- Gather config ---
  const modelItems = deps.catalog.all().map((m) => ({ label: m.displayName || m.modelId, description: m.platform, value: `${m.platform}::${m.modelId}` }));
  const modelPick = await vscode.window.showQuickPick(modelItems, { title: 'Agent-under-test model (pinned)', placeHolder: 'Pick the model TierMux will use for all 50 queries' });
  if (!modelPick) return;

  const effortPick = await vscode.window.showQuickPick(
    [{ label: 'medium' }, { label: 'low' }, { label: 'high' }],
    { title: 'Reasoning effort (pinned)', placeHolder: 'medium' },
  );
  if (!effortPick) return;

  const judgePick = await vscode.window.showQuickPick(modelItems, { title: 'Judge model (grades Reasoning + Answer)', placeHolder: 'Pick a strong model to grade answers' });
  if (!judgePick) return;

  // Bias guard: same model generating and judging inflates scores. Warn (allow override).
  if (judgePick.value === modelPick.value) {
    const cont = await vscode.window.showWarningMessage(
      'Judge and generator are the SAME model — self-grading inflates Reasoning/Answer scores. Use a different (ideally stronger) judge model for trustworthy numbers.',
      'Continue anyway',
      'Cancel',
    );
    if (cont !== 'Continue anyway') return;
  }

  const labelPick = await vscode.window.showInputBox({ prompt: 'Run label (before / after)', value: 'before' });
  if (!labelPick) return;

  const scopeItems: vscode.QuickPickItem[] = [
    { label: 'smoke', description: 'E1–E3 (quick sanity)' },
    { label: 'consistency', description: 'E1 × 3 (judge determinism check)' },
    { label: 'explain', description: 'E1–E10' },
    { label: 'bug', description: 'B1–B10' },
    { label: 'feature', description: 'F1–F10' },
    { label: 'refactor', description: 'R1–R10' },
    { label: 'chains', description: 'C1–C10 (memory test)' },
    { label: 'all', description: 'all 50' },
  ];
  const scopePick = await vscode.window.showQuickPick(scopeItems, { title: 'Scope', placeHolder: 'all' });
  if (!scopePick) return;
  const scope: Scope = scopePick.label as Scope;

  const outDir = path.join(deps.globalStorageUri.fsPath, 'bench', `${labelPick}-${stamp()}`);

  const channel = vscode.window.createOutputChannel('TierMux Benchmark');
  channel.show(true);
  const log = (m: string): void => { channel.appendLine(m); };

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'TierMux Benchmark', cancellable: false },
    async () => {
      log('Pre-research removed in v7.0; running bench directly.');
      resetTelemetry();
      try { await deps.index.build(); } catch (e) { log(`  codebase index warning: ${msg(e)}`); }

      const bench = new Benchmark({
        agent: deps.agent, router: deps.router,
        model: modelPick.value, effort: effortPick.label as 'low' | 'medium' | 'high',
        judgeModel: judgePick.value, workspace, outDir, log,
      });

      const queries = queriesForScope(scope);
      const units = planExecution(queries);
      log(`Running ${queries.length} queries (${units.length} session(s)) — model ${modelPick.value}, effort ${effortPick.label}, judge ${judgePick.value}`);

      const results = await runUnits(bench, units, log);

      const { scoresPath, summaryPath, summary } = writeReports(outDir, results, {
        label: labelPick,
        generatorModel: modelPick.value,
        judgeModel: judgePick.value,
        effort: effortPick.label,
        temperature: 0,
        gitCommit: await gitHead(),
        timestamp: new Date().toISOString(),
      });

      log('');
      log(`Retrieval ${summary.retrieval}% ${summary.passRetrieval ? '✓' : '✗'}  ·  Reasoning ${summary.reasoning}% ${summary.passReasoning ? '✓' : '✗'}  ·  Answer ${summary.answer}% ${summary.passAnswer ? '✓' : '✗'}  ·  Overall ${summary.overall}%`);
      if (summary.consistencySpread !== null) log(`Consistency spread (lower=deterministic): ${summary.consistencySpread}`);
      if (summary.continuation !== null) log(`Continuation (chain follow-ups) ${summary.continuation}%`);
      const cats = Object.entries(summary.byCategory).map(([c, v]) => `${c} ${v.overall}%`).join('  ·  ');
      log(`By category: ${cats}`);
      log(`Result: ${summary.pass ? 'PASS ✅' : 'FAIL ❌'}`);
      log(`Diagnosis: ${summary.diagnosis}`);
      log(`Reports: ${outDir}`);

      void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(scoresPath));
      channel.appendLine('\n--- summary.json ---\n' + JSON.stringify(summary, null, 2));
      void summaryPath;
    },
  );
}

function isClean(ws: string): Promise<boolean> {
  return new Promise((resolve) => {
    cp.exec(`git -C ${JSON.stringify(ws)} status --porcelain`, (err, stdout) => {
      if (err) return resolve(true); // not a git repo → treat as clean (no restore will happen meaningfully)
      resolve(stdout.trim().length === 0);
    });
  });
}

/** Short HEAD of the TierMux repo (the architecture under test). Falls back to 'unknown'. */
function gitHead(): Promise<string> {
  // dist/extension.js → repo root is one level up.
  const repoRoot = path.resolve(__dirname, '..');
  return new Promise((resolve) => {
    cp.exec(`git -C ${JSON.stringify(repoRoot)} rev-parse --short HEAD`, (err, stdout) => {
      if (err) return resolve('unknown');
      resolve(stdout.trim() || 'unknown');
    });
  });
}

function stamp(): string {
  // YYYYMMDD-HHMMSS — second resolution so back-to-back re-runs (same minute,
  // same label) get distinct outDirs and don't clobber each other. Sequential
  // benchmark execution guarantees no two runs share a second; for parallel or
  // distributed execution, switch to a UUID-based runId.
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
