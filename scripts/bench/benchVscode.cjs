// Real-filesystem 'vscode' shim for the quality benchmark, loaded via `node -r` BEFORE the
// bundled runner's own `require("vscode")` calls execute.
//
// Distinct from scripts/vscodeMock.cjs on purpose: that one is a stub for the coreLoop e2e
// tests (fs is `{}`, findFiles returns []) because those tests only exercise the bash tool.
// The quality bench runs the REAL retrieval tools (readFile / listDir / glob / grep) against a
// REAL project on disk, so every workspace API they touch has to actually work — a stubbed
// readFile would score every query 0 on retrieval and blame the model for it.
//
// Implemented against the read-only tool set only (mode 'ask'/'plan'). Write/edit/runCommand
// tools are never built in those modes, so their vscode surface is intentionally absent.
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
  languages: { getDiagnostics: () => [] },
  commands: { executeCommand: async () => undefined },
  env: { openExternal: async () => true },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
};

Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, ...rest);
};

module.exports = { vscodeMock };
