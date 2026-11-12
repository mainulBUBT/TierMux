// Graphic preview — one webview beside the editor: an image file scaled to fit, or an HTML/SVG
// source rendered live at a fixed canvas (unsaved edits included). renderImage refreshes it when open.

import * as vscode from 'vscode';
import * as path from 'path';
import { getNonce } from '../util/nonce';
import { CANVAS_PRESETS, DEFAULT_CANVAS, detectCanvas, previewDocument, previewKind } from './graphicDoc';

const DEBOUNCE_MS = 250;

let current: GraphicPreview | undefined;

export function registerGraphicPreview(): vscode.Disposable {
  return vscode.commands.registerCommand('tiermux.previewGraphic', (uri?: vscode.Uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri ?? activeTabUri();
    if (!target || !previewKind(target.fsPath)) {
      void vscode.window.showInformationMessage('TierMux: open an .html, .svg, .png, .jpg or .webp file to preview.');
      return;
    }
    (current ??= new GraphicPreview()).show(target, true);
  });
}

/** renderImage wrote a PNG: show it if the preview is already open, never open it. */
export function notifyGraphicRendered(uri: vscode.Uri): void {
  current?.show(uri, false);
}

function activeTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input && typeof input === 'object' && 'uri' in input && input.uri instanceof vscode.Uri ? input.uri : undefined;
}

class GraphicPreview {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private uri: vscode.Uri | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly sizes = new Map<string, string>();

  constructor() {
    this.panel = vscode.window.createWebviewPanel('tiermux.graphicPreview', 'TierMux Graphic Preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: this.roots() });
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: { type?: string; value?: string }) => {
        if (m.type === 'ready') void this.update();
        if (m.type === 'size' && this.uri && typeof m.value === 'string') { this.sizes.set(this.uri.toString(), m.value); void this.update(); }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => { if (this.is(e.document.uri)) this.schedule(); }),
      vscode.workspace.onDidSaveTextDocument((d) => { if (this.is(d.uri)) void this.update(); }),
    );
  }

  show(uri: vscode.Uri, reveal: boolean): void {
    if (!previewKind(uri.fsPath)) return;
    if (!this.is(uri)) {
      this.uri = uri;
      this.watcher?.dispose();
      this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)));
      this.watcher.onDidChange(() => this.schedule());
      this.watcher.onDidCreate(() => this.schedule());
      const roots = this.roots();
      const dir = roots[roots.length - 1].fsPath;
      const covered = (this.panel.webview.options.localResourceRoots ?? []).some((r) => dir === r.fsPath || dir.startsWith(r.fsPath + path.sep));
      if (!covered) {
        this.panel.webview.options = { enableScripts: true, localResourceRoots: roots };
        this.panel.webview.html = this.html();
      }
    }
    if (reveal) this.panel.reveal(this.panel.viewColumn, true);
    void this.update();
  }

  private is(uri: vscode.Uri): boolean {
    return !!this.uri && uri.toString() === this.uri.toString();
  }

  private roots(): vscode.Uri[] {
    const ws = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);
    return this.uri ? [...ws, vscode.Uri.file(path.dirname(this.uri.fsPath))] : ws;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), DEBOUNCE_MS);
  }

  private async update(): Promise<void> {
    const uri = this.uri;
    if (!uri) return;
    const name = vscode.workspace.asRelativePath(uri, false);
    const webview = this.panel.webview;
    if (previewKind(uri.fsPath) === 'image') {
      await webview.postMessage({ type: 'image', name, src: `${webview.asWebviewUri(uri).toString()}?v=${Date.now()}` });
      return;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    let text: string;
    try {
      text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      await webview.postMessage({ type: 'error', name, message: 'File not found.' });
      return;
    }
    const svg = /\.svg$/i.test(uri.fsPath);
    const detected = detectCanvas(text, svg);
    const chosen = this.sizes.get(uri.toString()) ?? 'auto';
    const m = /^(\d+)x(\d+)$/.exec(chosen);
    const canvas = m ? { width: Number(m[1]), height: Number(m[2]) } : detected ?? DEFAULT_CANVAS;
    const baseHref = `${webview.asWebviewUri(vscode.Uri.file(path.dirname(uri.fsPath))).toString()}/`;
    await webview.postMessage({ type: 'source', name, doc: previewDocument(text, svg, baseHref), canvas, detected, chosen: m ? chosen : 'auto' });
  }

  private html(): string {
    const nonce = getNonce();
    const src = this.panel.webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `img-src ${src} https: data: blob:`,
      `style-src ${src} https: 'unsafe-inline'`,
      `font-src ${src} https: data:`,
      `media-src ${src} https: data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const presets = CANVAS_PRESETS.map((p) => `<option value="${p.width}x${p.height}">${p.label} ${p.width}×${p.height}</option>`).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TierMux Graphic Preview</title>
  <style>
    html, body { margin: 0; height: 100%; }
    body { display: flex; flex-direction: column; font: 12px var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    header { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    #name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #info { opacity: .75; margin-left: auto; white-space: nowrap; }
    select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); }
    #stage { flex: 1; position: relative; overflow: hidden; display: grid; place-items: center; min-height: 0; }
    #box { position: relative; overflow: hidden; box-shadow: 0 0 0 1px var(--vscode-panel-border); background: repeating-conic-gradient(#8882 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
    #box iframe { position: absolute; top: 0; left: 0; border: 0; transform-origin: 0 0; background: transparent; }
    #box img { display: block; width: 100%; height: 100%; }
    #msg { opacity: .75; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <header><span id="name">No file</span><select id="size" hidden><option value="auto">Auto</option>${presets}</select><span id="info"></span></header>
  <div id="stage"><div id="box" hidden></div><div id="msg">Run “TierMux: Preview Graphic” on an .html, .svg or image file.</div></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const stage = $('stage'), box = $('box'), size = $('size'), info = $('info'), msg = $('msg');
    let w = 0, h = 0, mode = '', label = '';
    function fit() {
      if (!w || !h) return;
      const pad = 24, s = Math.min((stage.clientWidth - pad) / w, (stage.clientHeight - pad) / h, mode === 'image' ? 1 : Infinity);
      const k = Math.max(s, 0.01);
      box.style.width = w * k + 'px'; box.style.height = h * k + 'px';
      for (const f of box.querySelectorAll('iframe')) f.style.transform = 'scale(' + k + ')';
      info.textContent = label + ' · ' + Math.round(k * 100) + '%';
    }
    new ResizeObserver(fit).observe(stage);
    size.addEventListener('change', () => vscode.postMessage({ type: 'size', value: size.value }));
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || typeof m.type !== 'string') return;
      $('name').textContent = m.name || '';
      msg.hidden = m.type !== 'error'; box.hidden = m.type === 'error';
      if (m.type === 'error') { msg.textContent = m.message; size.hidden = true; info.textContent = ''; return; }
      if (m.type === 'image') {
        size.hidden = true;
        const img = new Image();
        img.onload = () => { mode = 'image'; w = img.naturalWidth; h = img.naturalHeight; label = w + '×' + h + ' px'; box.replaceChildren(img); fit(); };
        img.onerror = () => { box.hidden = true; msg.hidden = false; msg.textContent = 'Could not load the image.'; };
        img.src = m.src;
        return;
      }
      size.hidden = false;
      size.options[0].textContent = 'Auto' + (m.detected ? ' ' + m.detected.width + '×' + m.detected.height : '');
      size.value = m.chosen;
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-same-origin');
      f.width = m.canvas.width; f.height = m.canvas.height;
      f.style.visibility = 'hidden';
      f.onload = () => {
        if (box.lastElementChild !== f) return;
        for (const old of box.querySelectorAll('iframe')) if (old !== f) old.remove();
        f.style.visibility = '';
      };
      if (mode !== 'source') box.replaceChildren();
      box.appendChild(f);
      f.srcdoc = m.doc;
      mode = 'source'; w = m.canvas.width; h = m.canvas.height;
      label = w + '×' + h + ' canvas';
      fit();
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    if (current === this) current = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
