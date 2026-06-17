// Ctrl+I inline chat: prompt for an instruction, then replace the selection
// (or whole file) with the model's edited version, shown via the diff gate.
import * as vscode from 'vscode';
import type { Router } from '../router/router';
import type { EditGate } from '../edits/applyEdit';
import { contentToString } from '../agent/content';
import { PRODUCT_NAME } from '../shared/branding';

const SYSTEM = `You are a precise code editor. The user gives an instruction and a code
selection. Reply with ONLY the rewritten code that should replace the selection — no prose,
no markdown fences, no explanation.`;

function stripFences(text: string): string {
  const m = /^\s*```[a-zA-Z0-9]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m ? m[1] : text;
}

export function registerInlineChat(router: Router, editGate: EditGate): vscode.Disposable {
  return vscode.commands.registerCommand('tiermux.inlineChat', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { void vscode.window.showInformationMessage('Open a file first.'); return; }
    const instruction = await vscode.window.showInputBox({ prompt: 'Inline edit instruction', placeHolder: 'e.g. add error handling' });
    if (!instruction) return;

    const sel = editor.selection;
    const useWholeFile = sel.isEmpty;
    const range = useWholeFile ? new vscode.Range(0, 0, editor.document.lineCount, 0) : sel;
    const code = editor.document.getText(useWholeFile ? undefined : sel);
    const lang = editor.document.languageId;

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${PRODUCT_NAME}: editing…` }, async () => {
      try {
        const result = await router.route(
          [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `Instruction: ${instruction}\n\nLanguage: ${lang}\n\nCode:\n\`\`\`${lang}\n${code}\n\`\`\`` },
          ],
          {},
        );
        const newCode = stripFences(contentToString(result.response.choices[0]?.message.content)).trimEnd();
        if (useWholeFile) {
          await editGate.write(editor.document.uri, newCode + '\n');
        } else {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(editor.document.uri, range, newCode);
          await vscode.workspace.applyEdit(edit);
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`Inline edit failed: ${e instanceof Error ? e.message : e}`);
      }
    });
  });
}
