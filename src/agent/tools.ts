// Workspace tool implementations. All paths are confined to the workspace root.
import * as vscode from 'vscode';
import { EditGate } from '../edits/applyEdit';
import { CommandGate } from '../edits/commandGate';
import { buildRepoMapSummary } from './repoMap';

const MAX_READ_BYTES = 100 * 1024;
const MAX_SEARCH_RESULTS = 40;
const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/.venv/**}';

export interface ToolEvent {
  toolCallId: string;
  name: string;
  args: unknown;
  state: 'running' | 'done' | 'error';
  detail?: string;
}

export class WorkspaceTools {
  constructor(
    private readonly editGate: EditGate,
    private readonly commandGate: CommandGate,
  ) {}

  private root(): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) throw new Error('No workspace folder is open.');
    return folders[0].uri;
  }

  /** Resolve a workspace-relative path, rejecting traversal outside the root. */
  private resolve(p: string): vscode.Uri {
    const root = this.root();
    const cleaned = p.replace(/^\/+/, '');
    const uri = vscode.Uri.joinPath(root, cleaned);
    if (!uri.path.startsWith(root.path)) throw new Error(`Path escapes the workspace: ${p}`);
    return uri;
  }

  /** Execute a tool by name. Returns a string observation; never throws. */
  async execute(name: string, rawArgs: string): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return JSON.stringify({ error: 'Invalid JSON arguments.' });
    }
    try {
      switch (name) {
        case 'readFile': return await this.readFile(String(args.path ?? ''));
        case 'listDir': return await this.listDir(String(args.path ?? '.'));
        case 'repoMap': return await this.repoMap();
        case 'searchWorkspace': return await this.searchWorkspace(String(args.query ?? ''));
        case 'getDiagnostics': return await this.getDiagnostics(args.path ? String(args.path) : undefined);
        case 'runCommand': return await this.runCommand(String(args.command ?? ''), args.cwd ? String(args.cwd) : undefined);
        case 'writeFile': return await this.writeFile(String(args.path ?? ''), String(args.content ?? ''));
        case 'createFile': return await this.createFile(String(args.path ?? ''), String(args.content ?? ''));
        case 'editFile': return await this.editFile(String(args.path ?? ''), String(args.search ?? ''), String(args.replace ?? ''));
        case 'deleteFile': return await this.deleteFile(String(args.path ?? ''));
        default: return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async readFile(p: string): Promise<string> {
    const uri = this.resolve(p);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const truncated = bytes.byteLength > MAX_READ_BYTES;
    const text = new TextDecoder().decode(truncated ? bytes.slice(0, MAX_READ_BYTES) : bytes);
    return JSON.stringify({ path: p, truncated, content: text });
  }

  private async listDir(p: string): Promise<string> {
    const uri = this.resolve(p);
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return JSON.stringify({
      path: p,
      entries: entries.map(([name, type]) => ({ name, type: type === vscode.FileType.Directory ? 'dir' : 'file' })),
    });
  }

  /** Cheap workspace overview so the agent can orient itself. */
  private async repoMap(): Promise<string> {
    return JSON.stringify(await buildRepoMapSummary());
  }

  private async searchWorkspace(query: string): Promise<string> {
    const q = query.trim();
    if (!q) return JSON.stringify({ error: 'Empty query.' });
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);

    // File-name / glob matches.
    const nameGlob = q.includes('*') || q.includes('/') ? q : `**/*${terms[0]}*`;
    const files = (await vscode.workspace.findFiles(nameGlob, EXCLUDE, 20)).map((f) => vscode.workspace.asRelativePath(f));

    // Content matches, ranked by how many query terms each file hits.
    const candidates = await vscode.workspace.findFiles(
      '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,c,cc,cpp,h,hpp,cs,rb,php,swift,scala,json,md,txt,html,css,scss,yaml,yml,sh,sql}',
      EXCLUDE, 500,
    );
    const perFile: Array<{ path: string; score: number; hits: Array<{ line: number; text: string }> }> = [];
    for (const f of candidates) {
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(f));
        const lines = text.split('\n');
        const hits: Array<{ line: number; text: string }> = [];
        let score = 0;
        for (let i = 0; i < lines.length; i++) {
          const low = lines[i].toLowerCase();
          const matched = terms.filter((t) => low.includes(t)).length;
          if (matched > 0) { score += matched; if (hits.length < 3) hits.push({ line: i + 1, text: lines[i].trim().slice(0, 200) }); }
        }
        if (score > 0) perFile.push({ path: vscode.workspace.asRelativePath(f), score, hits });
      } catch { /* skip unreadable */ }
    }
    perFile.sort((a, b) => b.score - a.score);
    return JSON.stringify({ files, matches: perFile.slice(0, MAX_SEARCH_RESULTS) });
  }

  private async getDiagnostics(p?: string): Promise<string> {
    const collect = (uri: vscode.Uri) =>
      vscode.languages.getDiagnostics(uri).map((d) => ({
        severity: vscode.DiagnosticSeverity[d.severity],
        line: d.range.start.line + 1,
        message: d.message,
      }));
    if (p) {
      const uri = this.resolve(p);
      return JSON.stringify({ path: p, diagnostics: collect(uri) });
    }
    const all = vscode.languages.getDiagnostics().slice(0, 50).map(([uri, diags]) => ({
      path: vscode.workspace.asRelativePath(uri),
      diagnostics: diags.map((d) => ({ severity: vscode.DiagnosticSeverity[d.severity], line: d.range.start.line + 1, message: d.message })),
    }));
    return JSON.stringify({ files: all });
  }

  private async runCommand(command: string, cwd?: string): Promise<string> {
    return JSON.stringify(await this.commandGate.run(command, cwd));
  }

  private async writeFile(p: string, content: string): Promise<string> {
    const r = await this.editGate.write(this.resolve(p), content);
    return JSON.stringify(r.applied ? { ok: true, path: p } : { error: r.error ?? 'not applied' });
  }
  private async createFile(p: string, content: string): Promise<string> {
    const r = await this.editGate.create(this.resolve(p), content);
    return JSON.stringify(r.applied ? { ok: true, path: p } : { error: r.error ?? 'not applied' });
  }
  private async editFile(p: string, search: string, replace: string): Promise<string> {
    const r = await this.editGate.edit(this.resolve(p), search, replace);
    return JSON.stringify(r.applied ? { ok: true, path: p } : { error: r.error ?? 'not applied' });
  }
  private async deleteFile(p: string): Promise<string> {
    const r = await this.editGate.remove(this.resolve(p));
    return JSON.stringify(r.applied ? { ok: true, path: p } : { error: r.error ?? 'not applied' });
  }
}
