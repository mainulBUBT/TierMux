

import * as vscode from 'vscode';
import { routeOnceOrUndefined } from '../agent/core/routeOnce';
import type { Catalog } from '../catalog/catalog';
import type { SettingsStore } from '../config/settingsStore';
import { PRODUCT_NAME } from '../shared/branding';

const SYSTEM = `You are an inline code completion engine. Continue the code at the cursor.
Reply with ONLY the raw characters to insert — no markdown, no explanation, no repetition of
existing code. Keep it short (a line or a few lines).`;

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly catalog: Catalog,
    private readonly settings: SettingsStore,
  ) {}

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('tiermux.completions').get<boolean>('enabled', false);
  }
  private debounceMs(): number {
    return vscode.workspace.getConfiguration('tiermux.completions').get<number>('debounceMs', 350);
  }
  private modelChoice(): string {
    const m = vscode.workspace.getConfiguration('tiermux.completions').get<string>('model', 'auto');
    if (m && m !== 'auto') return m;
    const fast = this.catalog.fastestEnabled(this.settings.getFallback());
    return fast ? `${fast.platform}::${fast.modelId}` : 'auto';
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!this.enabled() || token.isCancellationRequested) return undefined;

    await new Promise((r) => { this.timer && clearTimeout(this.timer); this.timer = setTimeout(r, this.debounceMs()); });
    if (token.isCancellationRequested) return undefined;

    const maxPrefix = 2000, maxSuffix = 500;
    const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position)).slice(-maxPrefix);
    const suffix = document.getText(new vscode.Range(position, document.positionAt(document.getText().length))).slice(0, maxSuffix);
    if (!prefix.trim()) return undefined;

    try {
      const result = await routeOnceOrUndefined(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Language: ${document.languageId}\n\n<prefix>\n${prefix}\n</prefix>\n<suffix>\n${suffix}\n</suffix>\n\nInsert at the cursor (between prefix and suffix):` },
        ],
        { taskKind: 'trivial', model: this.modelChoice(), maxTokens: 128, temperature: 0.1, label: 'inlineCompletion' },
      );
      if (token.isCancellationRequested || !result) return undefined;
      let text = result.text;
      text = text.replace(/^```[a-zA-Z0-9]*\n?/, '').replace(/\n?```\s*$/, '');
      if (!text) return undefined;
      return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
    } catch {
      return undefined; // never surface completion errors to the user
    }
  }
}

export function registerInlineCompletions(catalog: Catalog, settings: SettingsStore): vscode.Disposable[] {
  const provider = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    new InlineCompletionProvider(catalog, settings),
  );
  const toggle = vscode.commands.registerCommand('tiermux.toggleCompletions', async () => {
    const cfg = vscode.workspace.getConfiguration('tiermux.completions');
    const next = !cfg.get<boolean>('enabled', false);
    await cfg.update('enabled', next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`${PRODUCT_NAME} inline completions ${next ? 'enabled' : 'disabled'}.`);
  });
  return [provider, toggle];
}
