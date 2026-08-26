// Minimal 'vscode' shim for scripts/nativeLoop.e2e.ts, loaded via `node -r` BEFORE the
// bundled test file's own `require("vscode")` calls execute (esbuild's --external:vscode
// leaves those as real requires — they'd otherwise throw "Cannot find module 'vscode'"
// outside the extension host). Only implements the handful of APIs the native engine's
// CommandGate/EditGate-construction and loop.ts code paths actually touch when the test
// exercises just the bash/runCommand tool — NOT a general-purpose vscode mock.
const Module = require('module');
const originalLoad = Module._load;

class EventEmitter {
  constructor() { this.event = () => ({ dispose() {} }); }
  fire() {}
  dispose() {}
}

const vscodeMock = {
  workspace: {
    workspaceFolders: undefined, // set by the test via setWorkspaceRoot() below
    // Config reads return the default unless the test set an override in
    // globalThis.__tiermuxTestConfig (e.g. `{ mixturePipeline: 'off' }` to keep the
    // planner step out of router-call-count assertions) — see the e2e scripts.
    getConfiguration: () => ({ get: (key, def) => (globalThis.__tiermuxTestConfig && Object.prototype.hasOwnProperty.call(globalThis.__tiermuxTestConfig, key) ? globalThis.__tiermuxTestConfig[key] : def) }),
    // Real-disk-backed workspace.fs. Seam tests (reanchor, prune-threshold, prompt-diet…)
    // exercise the REAL tools, which read/write through vscode.workspace.fs — an empty {}
    // made every readFile fail with "File not found", leaving those tests asserting against
    // phantom data. Backed by node:fs so tmp-dir fixtures read back exactly as written.
    fs: (() => {
      const fsp = require('fs').promises;
      const p = (uri) => uri.fsPath ?? uri.path;
      return {
        readFile: async (uri) => fsp.readFile(p(uri)),
        writeFile: async (uri, content) => fsp.writeFile(p(uri), content),
        stat: async (uri) => {
          const s = await fsp.stat(p(uri));
          return { ...s, type: s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtime, isDirectory: () => s.isDirectory(), isFile: () => s.isFile() };
        },
        createDirectory: async (uri) => fsp.mkdir(p(uri), { recursive: true }),
        delete: async (uri) => fsp.rm(p(uri), { recursive: true, force: true }),
        readDirectory: async (uri) => {
          const ents = await fsp.readdir(p(uri), { withFileTypes: true });
          return ents.map((e) => [e.name, e.isDirectory() ? 2 : 1]);
        },
      };
    })(),
    findFiles: async () => [],
    asRelativePath: (u) => (u && u.fsPath) || String(u),
    // Minimal WorkspaceEdit applier: replace = whole-file overwrite (that's the only shape
    // applyEdit's applyDirect uses — a MAX_SAFE_INTEGER range replace).
    applyEdit: async (edit) => {
      const fs = require('fs');
      const path = require('path');
      for (const op of edit.ops ?? []) {
        const file = op.uri.fsPath ?? op.uri.path;
        if (op.kind === 'replace') {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, op.text);
        }
        if (op.kind === 'createFile') {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          if (!fs.existsSync(file)) fs.writeFileSync(file, '');
        }
        if (op.kind === 'deleteFile' || op.kind === 'delete') fs.rmSync(file, { force: true, recursive: true });
      }
      return true;
    },
  },
  Uri: {
    joinPath: (base, ...parts) => {
      const path = require('path');
      const fsPath = path.join(base.fsPath, ...parts);
      return { fsPath, path: fsPath, toString: () => `file://${fsPath}` };
    },
    file: (fsPath) => ({ fsPath, path: fsPath, toString: () => `file://${fsPath}` }),
    parse: (s) => {
      const fsPath = String(s).replace(/^file:\/\//, '');
      return { fsPath, path: fsPath, toString: () => `file://${fsPath}` };
    },
  },
  EventEmitter,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  CodeActionKind: { QuickFix: { value: 'quickfix' }, Refactor: { value: 'refactor' }, Source: { value: 'source' } },
  Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  WorkspaceEdit: class { constructor() { this.ops = []; } replace(uri, range, text) { this.ops.push({ kind: 'replace', uri, range, text }); } insert(uri, position, text) { this.ops.push({ kind: 'insert', uri, position, text }); } delete(uri, range) { this.ops.push({ kind: 'delete', uri, range }); } createFile(uri) { this.ops.push({ kind: 'createFile', uri }); } deleteFile(uri) { this.ops.push({ kind: 'deleteFile', uri }); } },
  window: {
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
  commands: { executeCommand: async () => undefined },
};

Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, ...rest);
};

module.exports = { vscodeMock };
