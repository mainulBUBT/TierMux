// Real-filesystem 'vscode' shim for the quality benchmark, loaded via `node -r` BEFORE the
// bundled runner's own `require("vscode")` calls execute.
//
// Distinct from scripts/vscodeMock.cjs on purpose: that one is a stub for the coreLoop e2e
// tests (fs is `{}`, findFiles returns []) because those tests only exercise the bash tool.
// The quality bench runs the REAL retrieval tools (readFile / listDir / glob / grep) against a
// REAL project on disk, so every workspace API they touch has to actually work — a stubbed
// readFile would score every query 0 on retrieval and blame the model for it.
//
// Originally implemented against the read-only tool set only (mode 'ask'/'plan'). Extended
// 2026-08-10 to cover the mutation surface too (Range/WorkspaceEdit/applyEdit/fs.writeFile) once
// scripts/complexTask.e2e.ts started reusing this SAME shim for real agent-mode (edit-enabled)
// runs — every editFile/writeFile/deleteFile call in every complex-task run up to that point had
// been silently unable to succeed even when the model got everything right, because
// `applyEdit.ts` constructs `new vscode.WorkspaceEdit()` and this shim didn't define the class at
// all: confirmed live as `TypeError: vscode.WorkspaceEdit is not a constructor` on the first
// EVER editFile call to reach this point (all prior runs died — crash, budget exhaustion, XML
// leak — before an edit call got this far, which is why the gap went unnoticed for so long).
const fs = require('fs');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;

// Directories never worth walking for findFiles(); mirrors the tools' own default exclude.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.benchmarks', 'graphify-out']);

class EventEmitter {
  constructor() { this.event = () => ({ dispose() {} }); }
  fire() {}
  dispose() {}
}

/** Convert a VS Code glob pattern to a RegExp over workspace-relative, forward-slash paths. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches any number of leading segments (including none); bare `**` matches all.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Minimal — this codebase only ever constructs `new Range(0, 0, Number.MAX_SAFE_INTEGER, 0)` to
// mean "the whole document", never a partial range, so the fields just need to exist/round-trip.
class Range {
  constructor(startLine, startChar, endLine, endChar) {
    this.start = { line: startLine, character: startChar };
    this.end = { line: endLine, character: endChar };
  }
}

/**
 * Records the same operations the real vscode.WorkspaceEdit would (createFile/deleteFile/
 * replace), applied by `applyEdit()` below rather than by VS Code's own editor/document layer.
 *
 * Every call site in src/edits/applyEdit.ts always `replace`s the WHOLE document (see Range
 * above) and then does its own explicit `vscode.workspace.fs.writeFile(uri, content)` right
 * after a successful `applyEdit()` for the write/create paths — so `replace`/`createFile` here
 * are deliberately no-ops; they only need to make `applyEdit` return true so that real write
 * happens. `deleteFile` is the one case with NO follow-up fs call, so it must actually delete.
 */
class WorkspaceEdit {
  constructor() { this._deletes = []; }
  createFile() { /* no-op — see class comment */ }
  replace() { /* no-op — see class comment */ }
  deleteFile(target, opts) { this._deletes.push({ target, ignoreIfNotExists: !!(opts && opts.ignoreIfNotExists) }); }
}

function uri(fsPath) {
  return { fsPath, path: fsPath, scheme: 'file', toString: () => fsPath };
}

function walk(root, rel, out, limit) {
  if (out.length >= limit) return;
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(root, childRel, out, limit);
    } else if (e.isFile()) {
      out.push(childRel);
    }
  }
}

function workspaceRoot(mock) {
  const folder = mock.workspace.workspaceFolders && mock.workspace.workspaceFolders[0];
  return folder ? folder.uri.fsPath : process.cwd();
}

// Config values the bench overrides. Everything else falls through to the caller's default,
// which is what production would use anyway.
const CONFIG_OVERRIDES = {
  // The bench measures the agent's own retrieval, so leave pruning/caps at their real defaults;
  // only knobs that would make a headless run hang or prompt are forced here.
  'tiermux.agent.maxTurnTokens': 200000,
  // The 30s product default is tuned for a user watching a chat bubble. A bench judge is a large
  // reasoning model answering offline, and 6 of 24 queries in the 2026-08-09 run went UNSCORED
  // purely on `timeout` — an unmeasured query costs far more here than a slow one.
  'tiermux.requestTimeoutMs': 120000,
  // Opt-in per invocation (`TIERMUX_DIAG=1 npm run ...`) so a debugging run can see diagLog's
  // turn.budgetNudge/turn.prune/etc lines on stdout without every bench run being noisy by
  // default. diagLog itself gates on the vscode setting 'tiermux.agent.diagTrace' — not an env
  // var — so without this bridge no diagnostic line reaches the console at all in this harness.
  ...(process.env.TIERMUX_DIAG ? { 'tiermux.agent.diagTrace': true } : {}),
};

const vscodeMock = {
  workspace: {
    workspaceFolders: undefined, // set by the runner before the first turn
    getConfiguration: (section) => ({
      get: (key, def) => {
        const full = section ? `${section}.${key}` : key;
        return Object.prototype.hasOwnProperty.call(CONFIG_OVERRIDES, full) ? CONFIG_OVERRIDES[full] : def;
      },
    }),
    fs: {
      readFile: async (u) => fs.promises.readFile(u.fsPath),
      readDirectory: async (u) => {
        const entries = await fs.promises.readdir(u.fsPath, { withFileTypes: true });
        return entries.map((e) => [e.name, e.isDirectory() ? 2 : e.isSymbolicLink() ? 64 : 1]);
      },
      stat: async (u) => {
        const s = await fs.promises.stat(u.fsPath);
        return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
      },
      // `content` arrives as a Uint8Array (TextEncoder().encode(...) at every applyEdit.ts call
      // site) — mkdir -p first since a brand-new nested file's directory may not exist yet.
      writeFile: async (u, content) => {
        await fs.promises.mkdir(path.dirname(u.fsPath), { recursive: true });
        await fs.promises.writeFile(u.fsPath, Buffer.from(content));
      },
      delete: async (u, opts) => {
        try { await fs.promises.rm(u.fsPath, { recursive: !!(opts && opts.recursive), force: true }); }
        catch (e) { if (!(opts && opts.ignoreIfNotExists)) throw e; }
      },
    },
    // Executes a WorkspaceEdit built by src/edits/applyEdit.ts. Only `deleteFile` needs real
    // work here — see the WorkspaceEdit class comment above for why replace/createFile don't.
    applyEdit: async (edit) => {
      for (const { target, ignoreIfNotExists } of edit._deletes || []) {
        try { await fs.promises.rm(target.fsPath, { force: true }); }
        catch (e) { if (!ignoreIfNotExists) throw e; }
      }
      return true;
    },
    findFiles: async (pattern, _exclude, max = 1000) => {
      const root = workspaceRoot(vscodeMock);
      const files = [];
      walk(root, '', files, 20000);
      const re = globToRegExp(String(pattern));
      return files.filter((f) => re.test(f)).slice(0, max).map((f) => uri(path.join(root, f)));
    },
    asRelativePath: (u) => {
      const p = (u && u.fsPath) || String(u);
      const root = workspaceRoot(vscodeMock);
      return p.startsWith(root) ? p.slice(root.length).replace(/^[/\\]/, '') : p;
    },
    openTextDocument: async (u) => ({ getText: () => fs.readFileSync(u.fsPath, 'utf8') }),
  },
  Uri: {
    file: (p) => uri(p),
    joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
    parse: (s) => uri(s),
  },
  EventEmitter,
  Range,
  WorkspaceEdit,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  // Read-only bench never surfaces UI; every prompt resolves to "no answer" rather than hanging.
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    // Headless: nothing is open. Must exist as an ARRAY — WorkspaceIndex.fallbackSymbolScan
    // maps over it to prioritise open editors, and an undefined here threw
    // "Cannot read properties of undefined (reading 'map')" out of every getSymbolGraph call.
    visibleTextEditors: [],
    activeTextEditor: undefined,
  },
  // No language server runs headless, so a diagnostics-change event never fires — real code
  // (formatDiagnostics.ts's waitForDiagnosticsSettled) already treats that as the common case
  // and falls through to its own timeout, AS LONG AS this method exists at all to subscribe to.
  // Its prior absence meant calling it threw "onDidChangeDiagnostics is not a function" —
  // synchronously, inside editFile's own execute() — which the AI SDK surfaced as a hung tool
  // call (stuck at 'running', no 'tool-result'/'tool-error' ever reaching onTool) rather than a
  // clean rejection, so every editFile/writeFile call in this shim silently never completed.
  languages: { getDiagnostics: () => [], onDidChangeDiagnostics: () => ({ dispose() {} }) },
  commands: { executeCommand: async () => undefined },
  env: { openExternal: async () => true },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
};

Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, ...rest);
};

module.exports = { vscodeMock };
