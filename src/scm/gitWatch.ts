// Detects git commits via the built-in Git extension's repo state, since it exposes no
// dedicated commit event. Used to invalidate the pinned "changed files / undo" checkpoint
// bar once edits are committed (see clearAllCheckpoints in chatViewProvider.ts).
import * as vscode from 'vscode';

interface GitRepoState {
  HEAD?: { commit?: string };
  onDidChange: vscode.Event<void>;
}
interface GitRepo { rootUri: vscode.Uri; state: GitRepoState }
interface GitApi { repositories: GitRepo[]; onDidOpenRepository: vscode.Event<GitRepo> }

async function getGitApi(): Promise<GitApi | undefined> {
  const ext = vscode.extensions.getExtension<{ getAPI(v: number): GitApi }>('vscode.git');
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports.getAPI(1);
}

/** Fire `onCommit` whenever any open repo's HEAD commit changes. */
export function watchGitCommits(onCommit: () => void): vscode.Disposable {
  let disposed = false;
  const disposables: vscode.Disposable[] = [];
  const lastHead = new Map<string, string>();

  const track = (repo: GitRepo) => {
    lastHead.set(repo.rootUri.toString(), repo.state.HEAD?.commit ?? '');
    disposables.push(repo.state.onDidChange(() => {
      const key = repo.rootUri.toString();
      const head = repo.state.HEAD?.commit ?? '';
      const prev = lastHead.get(key);
      lastHead.set(key, head);
      if (prev !== undefined && head && head !== prev) onCommit();
    }));
  };

  void getGitApi().then((git) => {
    if (!git || disposed) return;
    git.repositories.forEach(track);
    disposables.push(git.onDidOpenRepository(track));
  });

  return { dispose: () => { disposed = true; disposables.forEach((d) => d.dispose()); } };
}
