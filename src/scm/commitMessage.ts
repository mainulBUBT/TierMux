// Generate a commit message from the staged diff via the built-in Git API.
// Hardening: better post-processing of model output, garbage detection, a
// multi-stage model fallback chain, and a deterministic template fallback so
// the SCM input box never shows garbage text from a noisy free-tier model.
import * as vscode from 'vscode';
import type { Router } from '../router/router';
import { contentToString } from '../agent/content';
import { cleanCommitMessage, looksLikeGarbage, buildTemplateFallback } from './commitMessageClean';

const SYSTEM = `You write concise commit messages. Output ONLY the commit message text.

GOOD output:
feat: add OAuth login flow

Adds OAuth2 authentication with refresh token rotation.

GOOD output (single-line):
fix: handle null user in profile fetch

BAD output (never produce):
- "Here is the commit message: feat: add..."
- "\`\`\`\nfeat: add...\n\`\`\`"
- "I cannot generate a commit message without more context"
- "{\"subject\": \"feat: add...\"}"
- "Sure, here's a commit message for your changes..."

Rules:
- First line: <72 char imperative subject (e.g. "feat: add X", "fix: handle Y")
- Optional blank line + 1-3 sentence body for non-trivial changes
- If recent commits are listed, match their style/prefix/casing exactly
- No markdown, no fences, no JSON, no preamble, no explanation
- Output the commit message text and nothing else`;

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
      { role: 'user' as const, content: `${styleBlock}${hintBlock}Generate a commit message for this diff:\n\n<diff>\n${clipped}\n</diff>` },
    ];

    try {
      // Multi-stage fallback: try the user's utility-model pick first, then a
      // ladder of stronger models. Each attempt is validated; the first clean
      // output wins. If every model produces garbage, use the deterministic
      // template so the user never sees garbage in the input box.
      const primary = await router.pickUtilityModel();
      const fallbacks = [
        'google::gemini-2.5-flash',
        'groq::llama-3.3-70b-versatile',
        'openrouter::deepseek/deepseek-chat-v3.1:free',
      ];
      const candidates = [primary, ...fallbacks].filter((m): m is string => !!m);
      const seen = new Set<string>();
      const attempts: string[] = [];
      for (const m of candidates) {
        if (seen.has(m)) continue;
        seen.add(m);
        if (!(await router.isReady(m))) continue;
        attempts.push(m);
        if (attempts.length >= 3) break;
      }

      let msg = '';
      for (const model of attempts) {
        try {
          const result = await router.route(messages, { temperature: 0.2, max_tokens: 256, model });
          const cleaned = cleanCommitMessage(contentToString(result.response.choices[0]?.message.content));
          if (!looksLikeGarbage(cleaned)) {
            msg = cleaned;
            break;
          }
        } catch { /* try the next model */ }
      }

      if (!msg || looksLikeGarbage(msg)) {
        msg = buildTemplateFallback(diff);
      }
      if (msg) repo.inputBox.value = msg;
    } catch (e) {
      // Catastrophic failure (no router, etc.) — at minimum, show a clean template.
      const fallback = buildTemplateFallback(diff);
      if (fallback) repo.inputBox.value = fallback;
      void vscode.window.showErrorMessage(`Commit message generation failed: ${e instanceof Error ? e.message : e}`);
    }
  });
}
