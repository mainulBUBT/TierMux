// "Fix with AI" lightbulb on diagnostics.
import * as vscode from 'vscode';
import type { ChatViewProvider } from '../chatViewProvider';

class FixWithAiProvider implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (context.diagnostics.length === 0) return [];
    const action = new vscode.CodeAction('Fix with AI', vscode.CodeActionKind.QuickFix);
    action.command = {
      command: 'tiermux.fixWithAI',
      title: 'Fix with AI',
      arguments: [document.uri, range, context.diagnostics.map((d) => d.message)],
    };
    return [action];
  }
}

export function registerCodeActions(chat: ChatViewProvider): vscode.Disposable[] {
  const provider = vscode.languages.registerCodeActionsProvider('*', new FixWithAiProvider(), {
    providedCodeActionKinds: FixWithAiProvider.kinds,
  });
  const cmd = vscode.commands.registerCommand(
    'tiermux.fixWithAI',
    async (uri?: vscode.Uri, range?: vscode.Range, messages?: string[]) => {
      const editor = vscode.window.activeTextEditor;
      const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
      if (!doc) return;
      const r = range ?? editor?.selection;
      const code = r ? doc.getText(r) : doc.getText();
      const path = vscode.workspace.asRelativePath(doc.uri);
      const problems = (messages ?? []).join('\n- ');
      const prompt = `Fix the following problem(s) in \`${path}\` and apply the change:\n- ${problems}\n\nRelevant code:\n\`\`\`${doc.languageId}\n${code}\n\`\`\``;
      await chat.submitExternal(prompt, 'agent');
    },
  );
  return [provider, cmd];
}
