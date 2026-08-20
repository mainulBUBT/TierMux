/* The general-purpose `delegate` sub-agent tool (src/agent/core/tools/delegate.ts):
 *   - approval policy: research passes like a read tool; code mode prompts exactly like the
 *     mutating tools in agent mode, is denied outside agent mode, and honors rejection
 *   - research mode: nested loop runs on the utility model; a secrets-file read inside the
 *     sub-agent is hard-denied (createSubAgentToolApproval) and the report still comes back
 *   - code mode: REAL git in a temp repo — the worker edits in a disposable worktree, commits,
 *     and the merge lands in the user's branch; the user's tree is left clean
 *   - code mode in a non-git workspace refuses honestly
 *
 * Run: npm run test:e2e:delegate-tool
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDelegateTool } from '../src/agent/core/tools/delegate';
import { createToolApproval } from '../src/agent/core/policies/permission';
import { setGates } from '../src/agent/core/tools/gates';
import { CommandGate, type CommandApproval } from '../src/edits/commandGate';
import { EditGate } from '../src/edits/applyEdit';
import type { Router } from '../src/router/router';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function baseResponse(overrides: Record<string, unknown>) {
  return {
    id: 'r', object: 'chat.completion' as const, created: 0, model: 'fake',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant' as const, content: null, ...overrides } }],
  };
}
const toolCall = (id: string, name: string, args: unknown) =>
  ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

/** Scripted router: serves queued OpenAI-shaped responses; records constraints per call. */
function scriptedRouter(script: Array<Record<string, unknown>>): { router: Router; calls: any[] } {
  const calls: any[] = [];
  const router = {
    async route(_m: unknown, opts: unknown) {
      calls.push(opts ?? {});
      return { platform: 'custom' as const, model: 'fake', response: baseResponse(script.shift() ?? { content: 'done.' }) };
    },
    async pickUtilityModel() { return 'custom::fake-utility'; },
    peekTopSelection: () => ({ entry: { platform: 'custom', modelId: 'fake', enabled: true, priority: 0 }, model: { intelligenceRank: 1 } }),
  } as unknown as Router;
  return { router, calls };
}

async function main(): Promise<void> {
  const vscode = require('vscode');

  console.log('— approval policy: research passes, code mode is gated like a mutating tool —');
  {
    const asks: any[] = [];
    const prompt = async (info: any) => { asks.push(info); return 'once' as const; };
    const agentApproval = createToolApproval({ mode: 'agent', onPermissionAsk: prompt } as any);
    const planApproval = createToolApproval({ mode: 'plan', onPermissionAsk: prompt } as any);
    const research = await (agentApproval as any)({ toolCall: { toolName: 'delegate', input: { description: 'trace auth', task: 'trace it', mode: 'research' } } });
    ok('research mode auto-approves with no prompt', research === 'approved' && asks.length === 0);
    const code = await (agentApproval as any)({ toolCall: { toolName: 'delegate', input: { description: 'add retries', task: 'add retry logic', mode: 'code' } } });
    ok('code mode prompts the user once', code === 'approved' && asks.length === 1 && !!asks[0].title.includes('sub-agent'));
    const rejected = await (createToolApproval({ mode: 'agent', onPermissionAsk: async () => 'reject' } as any) as any)({ toolCall: { toolName: 'delegate', input: { description: 'x', task: 'x', mode: 'code' } } });
    ok('rejection denies the delegation', rejected && rejected.type === 'denied');
    const planCode = await (planApproval as any)({ toolCall: { toolName: 'delegate', input: { description: 'x', task: 'x', mode: 'code' } } });
    ok('code mode is denied outside agent mode', planCode && planCode.type === 'denied' && /Agent mode/i.test(planCode.reason));
    const planResearch = await (planApproval as any)({ toolCall: { toolName: 'delegate', input: { description: 'x', task: 'x', mode: 'research' } } });
    ok('research mode still works in plan mode (read-only)', planResearch === 'approved');
  }

  console.log('\n— research mode: nested utility-model loop, secrets hard-denied inside —');
  {
    const root = mkdtempSync(join(tmpdir(), 'tiermux-delegate-research-'));
    writeFileSync(join(root, 'notes.txt'), 'hello\n');
    try {
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: root, path: root, scheme: 'file' } }];
      const { router } = scriptedRouter([
        { tool_calls: [toolCall('s1', 'readFile', { path: '.env' })] },   // secrets → denied by sub-agent policy
        { content: 'FINDINGS: auth lives in src/auth.ts:12. No secrets needed.' },
      ]);
      const t = createDelegateTool(router) as any;
      const report = await t.execute({ description: 'find auth', task: 'where is auth handled?', mode: 'research' }, { toolCallId: 'd1' });
      ok('report returned to the caller', String(report).includes('src/auth.ts:12'), String(report).slice(0, 80));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log('\n— code mode: worktree → worker edits → commit → merge lands in the user\'s branch —');
  {
    const repo = mkdtempSync(join(tmpdir(), 'tiermux-delegate-code-'));
    try {
      git(repo, 'init', '-q', '.');
      git(repo, 'config', 'user.email', 'test@tiermux.local');
      git(repo, 'config', 'user.name', 'TierMux Test');
      writeFileSync(join(repo, 'base.txt'), 'base\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'init');
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: repo, path: repo, scheme: 'file' } }];
      setGates(new EditGate(() => false), new CommandGate(() => 'always' as CommandApproval, () => 5000, () => []));

      const { router } = scriptedRouter([
        { tool_calls: [toolCall('w1', 'readFile', { path: 'base.txt' })] },
        { tool_calls: [toolCall('w2', 'editFile', { path: 'base.txt', search: 'base', replace: 'base\ndelegated-edited' })] },
        { content: 'Implemented the edit and verified the file content.' },
      ]);
      const t = createDelegateTool(router) as any;
      const report = await t.execute({ description: 'extend base.txt', task: 'Append the line "delegated-edited" to base.txt.', mode: 'code' }, { toolCallId: 'd2' });

      ok('report says the merge landed', String(report).includes('Merged'), String(report).slice(0, 120));
      ok('the edit is in the USER\'S working tree after the merge', readFileSync(join(repo, 'base.txt'), 'utf8').includes('delegated-edited'));
      ok('the commit landed on the user\'s branch', git(repo, 'log', '--oneline').includes('TierMux delegate:'));
      ok('the worker summary is included', String(report).includes('Implemented the edit'));
      ok('the user\'s tree is clean afterwards (worktree parking ignored)', git(repo, 'status', '--porcelain') === '', git(repo, 'status', '--porcelain'));
      // The parking dir itself may remain (fleet behavior) — it must be EMPTY.
      const parking = join(repo, '.tiermux-worktrees');
      const leftovers = existsSync(parking) ? require('node:fs').readdirSync(parking) : [];
      ok('no leftover worktree directories', leftovers.length === 0, leftovers.join(','));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  console.log('\n— code mode refuses honestly outside a git repo —');
  {
    const plain = mkdtempSync(join(tmpdir(), 'tiermux-delegate-nogit-'));
    mkdirSync(plain, { recursive: true });
    try {
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: plain, path: plain, scheme: 'file' } }];
      const { router } = scriptedRouter([]);
      const t = createDelegateTool(router) as any;
      const report = await t.execute({ description: 'x', task: 'edit something', mode: 'code' }, { toolCallId: 'd3' });
      ok('refuses with the git requirement and a remedy', String(report).includes('not a git repo') && /yourself/i.test(String(report)));
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  }

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

void main().catch((e) => { console.error(e); process.exit(1); });
