// Editor context-menu commands: Explain / Fix / Refactor / Generate tests / docs.
// Each gathers the selection (or whole file) and routes a prompt to the chat.
import * as vscode from 'vscode';
import type { ChatViewProvider } from '../chatViewProvider';
import type { Mode } from '../agent/agent';

interface Action {
  command: string;
  mode: Mode;
  build: (ctx: { path: string; lang: string; code: string; hasSelection: boolean }) => string;
}

const ACTIONS: Action[] = [
  {
    command: 'tiermux.explainSelection',
    mode: 'chat',
    build: (c) => `Explain this ${c.lang} code from \`${c.path}\`:\n\n\`\`\`${c.lang}\n${c.code}\n\`\`\``,
  },
  {
    command: 'tiermux.fixSelection',
    mode: 'agent',
    build: (c) => `Fix any bugs or problems in this ${c.lang} code in \`${c.path}\` and apply the fix:\n\n\`\`\`${c.lang}\n${c.code}\n\`\`\``,
  },
  {
    command: 'tiermux.refactorSelection',
    mode: 'agent',
    build: (c) => `Refactor this ${c.lang} code in \`${c.path}\` for clarity and apply the changes:\n\n\`\`\`${c.lang}\n${c.code}\n\`\`\``,
  },
  {
    command: 'tiermux.generateTests',
    mode: 'agent',
    build: (c) => `Write unit tests for this ${c.lang} code from \`${c.path}\` and create the test file:\n\n\`\`\`${c.lang}\n${c.code}\n\`\`\``,
  },
  {
    command: 'tiermux.generateDocs',
    mode: 'agent',
    build: (c) => `Add clear documentation/comments to this ${c.lang} code in \`${c.path}\` and apply it:\n\n\`\`\`${c.lang}\n${c.code}\n\`\`\``,
  },
];

export function registerEditorCommands(chat: ChatViewProvider): vscode.Disposable[] {
  return ACTIONS.map((a) =>
    vscode.commands.registerCommand(a.command, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { void vscode.window.showInformationMessage('Open a file and select code first.'); return; }
      const sel = editor.selection;
      const hasSelection = !sel.isEmpty;
      const code = hasSelection ? editor.document.getText(sel) : editor.document.getText();
      const path = vscode.workspace.asRelativePath(editor.document.uri);
      const prompt = a.build({ path, lang: editor.document.languageId, code, hasSelection });
      await chat.submitExternal(prompt, a.mode);
    }),
  );
}
