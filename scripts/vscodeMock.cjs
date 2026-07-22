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
    getConfiguration: () => ({ get: (_key, def) => def }),
    fs: {},
    findFiles: async () => [],
    asRelativePath: (u) => (u && u.fsPath) || String(u),
  },
  Uri: {
    joinPath: (base, ...parts) => {
      const path = require('path');
      const fsPath = path.join(base.fsPath, ...parts);
      return { fsPath, path: fsPath };
    },
    parse: (s) => ({ fsPath: s, path: s }),
  },
  EventEmitter,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
  commands: { executeCommand: async () => undefined },
};

Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, ...rest);
};

module.exports = { vscodeMock };
