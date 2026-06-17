// Generate a commit message from the staged diff via the built-in Git API.
import * as vscode from 'vscode';
import type { Router } from '../router/router';
import { contentToString } from '../agent/content';

const SYSTEM = `You write concise Conventional Commits messages. Given a git diff, reply with ONLY
the commit message: a short imperative subject line (<= 72 chars, e.g. "feat: ..."), then an
optional blank line and brief body. No markdown fences, no quotes.`;

interface GitRepo {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
}
interface GitApi { repositories: GitRepo[] }

function getGitApi(): GitApi | undefined {
  const ext = vscode.extensions.getExtension<{ getAPI(v: number): GitApi }>('vscode.git');
  return ext?.isActive ? ext.exports.getAPI(1) : ext?.exports?.getAPI?.(1);
}

export function registerCommitMessage(router: Router): vscode.Disposable {
  return vscode.commands.registerCommand('tiermux.generateCommitMessage', () => generateCommitMessage(router));
}

export async function generateCommitMessage(router: Router): Promise<void> {
  const git = getGitApi();
  if (!git || git.repositories.length === 0) {
    void vscode.window.showInformationMessage('No Git repository found.');
    return;
  }
  const repo = git.repositories[0];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'Generating commit message…' }, async () => {
    let diff = '';
    try { diff = await repo.diff(true); } catch { /* ignore */ }
    if (!diff || !diff.trim()) {
      try { diff = await repo.diff(false); } catch { /* ignore */ }
    }
    if (!diff || !diff.trim()) {
      void vscode.window.showInformationMessage('No changes to summarize. Stage some changes first.');
      return;
    }
    const clipped = diff.slice(0, 12000);
    try {
      const result = await router.route(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Generate a commit message for this diff:\n\n\`\`\`diff\n${clipped}\n\`\`\`` },
        ],
        { temperature: 0.2, max_tokens: 256 },
      );
      const msg = contentToString(result.response.choices[0]?.message.content).trim().replace(/^```[\s\S]*?\n|\n```$/g, '');
      if (msg) repo.inputBox.value = msg;
    } catch (e) {
      void vscode.window.showErrorMessage(`Commit message generation failed: ${e instanceof Error ? e.message : e}`);
    }
  });
}
