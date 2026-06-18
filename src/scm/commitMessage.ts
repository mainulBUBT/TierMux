// Generate a commit message from the staged diff via the built-in Git API.
import * as vscode from 'vscode';
import type { Router } from '../router/router';
import { contentToString } from '../agent/content';

const SYSTEM = `You write concise commit messages. Reply with ONLY the commit message: a short
imperative subject line (<= 72 chars), then an optional blank line and a brief body for non-trivial
changes. If recent commit messages from the repo are provided, MATCH their style and format exactly
(type/scope prefix, casing, tense, emoji or none). Otherwise use Conventional Commits ("feat: …",
"fix: …"). No markdown fences, no quotes. Do NOT restate the task, echo the diff, or include any
reasoning, preamble, or explanation — output the commit message text and nothing else.`;

interface GitRepo {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
  log?(options?: { maxEntries?: number }): Promise<Array<{ message?: string }>>;
}
interface GitApi { repositories: GitRepo[] }

/** Lockfiles / generated / minified paths whose diffs are noise for a commit message. */
const NOISE_FILE = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|.+\.min\.(?:js|css)|.+\.map|.+\.lock)$/i;

/**
 * Drop noise from a unified diff: lockfiles, minified/generated files, and binary
 * blobs — so the model sees real code changes and spends fewer tokens. Falls back to
 * the original diff if filtering would remove everything.
 */
function filterDiff(diff: string): string {
  const parts = diff.split(/(?=^diff --git )/m);
  const kept = parts.filter((p) => {
    if (!p.startsWith('diff --git')) return true; // preamble, keep
    const path = p.match(/^diff --git a\/(.+?) b\//m)?.[1] ?? '';
    if (path && NOISE_FILE.test(path)) return false;
    if (/^Binary files .* differ$/m.test(p)) return false;
    return true;
  });
  const out = kept.join('');
  return out.trim() ? out : diff;
}

/**
 * Reduce a raw model reply to ONLY the commit message. Reasoning models emit
 * <think>…</think> traces and some models add a "Here is the commit message:"
 * preamble or wrap the text in a code fence — none of which belong in the SCM box.
 */
function cleanCommitMessage(raw: string): string {
  let s = raw.trim();
  // Drop complete <think>…</think> reasoning blocks, then any dangling open/close tag
  // (truncated traces) and everything up to a stray </think>.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/^[\s\S]*?<\/think>/i, '').trim();
  s = s.replace(/<think>[\s\S]*$/i, '').trim();
  // Unwrap a surrounding code fence.
  s = s.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
  // Strip a leading "Here is/Here's …:" style preamble (only the first line).
  s = s.replace(/^(?:sure[,!]?\s*)?here(?:'s| is)[^\n:]*:\s*/i, '').trim();
  return s;
}

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
  // Whatever the user already typed in the box is guidance, not something to clobber.
  const typed = (repo.inputBox.value || '').trim();
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
    const clipped = filterDiff(diff).slice(0, 12000);

    // Recent subjects so the message matches the repo's existing convention.
    let recent: string[] = [];
    try {
      const commits = await repo.log?.({ maxEntries: 10 });
      recent = (commits ?? [])
        .map((c) => (c.message ?? '').split('\n')[0].trim())
        .filter((s) => s.length > 0)
        .slice(0, 10);
    } catch { /* style matching is best-effort */ }

    const styleBlock = recent.length
      ? `Recent commit messages in this repo — match this style and format:\n${recent.map((s) => `- ${s}`).join('\n')}\n\n`
      : '';
    const hintBlock = typed
      ? `The user already started the commit message — treat it as guidance and refine/complete it:\n"${typed}"\n\n`
      : '';

    const messages = [
      { role: 'system' as const, content: SYSTEM },
      { role: 'user' as const, content: `${styleBlock}${hintBlock}Generate a commit message for this diff:\n\n\`\`\`diff\n${clipped}\n\`\`\`` },
    ];
    // Prefer a strong free model for a good message; fall back to Auto if it's unavailable.
    const model = await router.pickUtilityModel();
    try {
      let result;
      try {
        result = await router.route(messages, { temperature: 0.2, max_tokens: 256, model });
      } catch (err) {
        if (!model) throw err; // already Auto — nothing to fall back to
        result = await router.route(messages, { temperature: 0.2, max_tokens: 256 });
      }
      const msg = cleanCommitMessage(contentToString(result.response.choices[0]?.message.content));
      if (msg) repo.inputBox.value = msg;
    } catch (e) {
      void vscode.window.showErrorMessage(`Commit message generation failed: ${e instanceof Error ? e.message : e}`);
    }
  });
}
