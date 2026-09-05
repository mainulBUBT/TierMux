

import * as vscode from 'vscode';
import mammoth from 'mammoth';
import type { Attachment, AttachmentKind } from '../messages';
import { diagLog } from './diag';

/** pdf-parse wraps pdfjs-dist, which expects browser globals; a top-level import crashed
 *  EXTENSION ACTIVATION ("DOMMatrix is not defined"). Loaded lazily with the globals polyfilled
 *  first; a parse failure returns '' rather than throwing. */
function ensureBrowserGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  // pdfjs destructures `navigator` at module scope, which the extension host does not define —
  // every PDF read as a scan. defineProperty because on some runtimes it is a getter-only global.
  if (!g.navigator) {
    const platform = process.platform === 'darwin' ? 'MacIntel'
      : process.platform === 'win32' ? 'Win32'
      : 'Linux x86_64';
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: { platform, userAgent: `Node/${process.versions.node}`, language: 'en-US', languages: ['en-US'] },
        configurable: true,
        writable: true,
      });
    } catch { /* already defined by the host — its own value is fine */ }
  }
  if (!g.DOMMatrix) {

    g.DOMMatrix = class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      constructor(init?: number[]) {
        if (Array.isArray(init)) {
          this.a = init[0] ?? 1; this.b = init[1] ?? 0; this.c = init[2] ?? 0;
          this.d = init[3] ?? 1; this.e = init[4] ?? 0; this.f = init[5] ?? 0;
        }
      }

      multiply(o: any) {

        const M = g.DOMMatrix as new (i?: number[]) => any;
        return new M([
          this.a * (o?.a ?? 1) + this.c * (o?.b ?? 0),
          this.b * (o?.a ?? 1) + this.d * (o?.b ?? 0),
          this.a * (o?.c ?? 0) + this.c * (o?.d ?? 1),
          this.b * (o?.c ?? 0) + this.d * (o?.d ?? 1),
          this.a * (o?.e ?? 0) + this.c * (o?.f ?? 0) + this.e,
          this.b * (o?.e ?? 0) + this.d * (o?.f ?? 0) + this.f,
        ]);
      }

      translate(tx = 0, ty = 0) { const M = g.DOMMatrix as new (i?: number[]) => any; return new M([this.a, this.b, this.c, this.d, this.e + tx, this.f + ty]); }

      scale(s = 1) { const M = g.DOMMatrix as new (i?: number[]) => any; return new M([this.a * s, this.b * s, this.c * s, this.d * s, this.e, this.f]); }

      transformPoint(p: { x?: number; y?: number } = {}) { return { x: this.a * (p.x ?? 0) + this.c * (p.y ?? 0) + this.e, y: this.b * (p.x ?? 0) + this.d * (p.y ?? 0) + this.f, z: 0, w: 1 }; }
      toString() { return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`; }
    };
  }
}

/** Max characters we keep from a document's extracted text (rough cap so a
 *  500-page PDF doesn't blow the context window before the model even reads it). */
const MAX_EXTRACTED_CHARS = 120_000;
/** Hard cap on a single image's data URL (bytes). 8 MB matches the Gemini cap. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Hard cap on a single PDF's data URL (bytes), sent to OC as a real FilePart —
 *  20 MB matches Gemini's practical inline-file cap (MAX_INLINE_BYTES in providers/google.ts).
 *  Enforced here, at attach-time, rather than downstream where it's already too late to
 *  give the user a clear error instead of a silently oversized HTTP request. */
const MAX_PDF_BYTES = 20 * 1024 * 1024;

const EXT_BY_KIND: Record<Exclude<AttachmentKind, 'file'>, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'],
  pdf: ['pdf'],
  doc: ['docx', 'doc', 'md', 'markdown', 'rst'],
};

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  md: 'text/markdown', markdown: 'text/markdown', rst: 'text/x-rst',
  txt: 'text/plain', json: 'application/json',
};

/** Resolve a workspace URI to the kind we should treat it as, by extension. */
export function kindForPath(fsPath: string): AttachmentKind {
  const ext = fsPath.split('.').pop()?.toLowerCase() ?? '';
  if (EXT_BY_KIND.image.includes(ext)) return 'image';
  if (EXT_BY_KIND.pdf.includes(ext)) return 'pdf';
  if (EXT_BY_KIND.doc.includes(ext)) return 'doc';
  return 'file';
}

export function mimeForPath(fsPath: string): string {
  const ext = fsPath.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function isSupportedAttachmentPath(fsPath: string): boolean {
  const ext = fsPath.split('.').pop()?.toLowerCase() ?? '';
  return [...EXT_BY_KIND.image, ...EXT_BY_KIND.pdf, ...EXT_BY_KIND.doc, 'txt', 'json'].includes(ext);
}

interface FileFilters {
  [label: string]: string[];
}

/** Filter set for the workspace open-dialog so the user sees the right files. */
export const ATTACHMENT_FILE_FILTERS: FileFilters = {
  'All supported': [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
    'pdf', 'docx', 'doc', 'md', 'markdown', 'txt', 'json', 'rst',
  ],
  'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
  'Documents': ['pdf', 'docx', 'doc', 'md', 'markdown', 'txt', 'json', 'rst'],
};

/** Build a workspace Attachment from a URI the user picked (or the agent opened).
 *  Reads the file, extracts text where applicable, base64-encodes images. */
export async function buildAttachmentFromUri(uri: vscode.Uri, source: Attachment['source'] = 'pick'): Promise<Attachment> {
  const kind = kindForPath(uri.fsPath);
  const name = vscode.workspace.asRelativePath(uri);
  const mime = mimeForPath(uri.fsPath);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const att: Attachment = { kind, name, mime, fsPath: uri.fsPath, source };
  if (kind === 'image') {
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image is too large to attach (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; max ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`);
    }
    att.dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    return att;
  }
  if (kind === 'pdf') {
    if (bytes.byteLength > MAX_PDF_BYTES) {
      throw new Error(`PDF is too large to attach (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; max ${MAX_PDF_BYTES / 1024 / 1024} MB).`);
    }
    const buf = Buffer.from(bytes);
    att.dataUrl = `data:application/pdf;base64,${buf.toString('base64')}`;
    att.text = (await extractPdfText(buf)).slice(0, MAX_EXTRACTED_CHARS);
    // When there's no text layer (a scan), the WEBVIEW rasterizes the pages to images and
    // fills in `pageImages` — see media/src/pdfPages.ts. It can't be done here: host-side
    // rendering needs @napi-rs/canvas, whose native binding Electron refuses to load.
    return att;
  }
  if (kind === 'doc') {
    if (uri.fsPath.toLowerCase().endsWith('.docx')) {
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      att.text = value.slice(0, MAX_EXTRACTED_CHARS);
    } else {

      att.text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).slice(0, MAX_EXTRACTED_CHARS);
    }
    return att;
  }

  att.text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).slice(0, MAX_EXTRACTED_CHARS);
  return att;
}

/** Run `fn` with pdf.js recognising Node: the extension host is Electron with `process.type`
 *  set, which pdf.js reads as "browser" and then fails on browser-only globals. Hidden for the
 *  duration of the parse (pdf.js re-checks during worker setup). */
async function withNodeDetection<T>(fn: () => Promise<T>): Promise<T> {
  const proc = process as unknown as { type?: string };
  const masked = !!process.versions.electron && typeof proc.type === 'string' && proc.type !== 'browser';
  const original = masked ? Object.getOwnPropertyDescriptor(process, 'type') : undefined;
  if (masked) {
    try {
      Object.defineProperty(process, 'type', { value: undefined, configurable: true, writable: true });
    } catch { /* not redefinable — fall through and let the browser path report its own error */ }
  }
  try {
    return await fn();
  } finally {
    if (masked) {
      try {
        if (original) Object.defineProperty(process, 'type', original);
        else delete proc.type;
      } catch { /* best-effort restore */ }
    }
  }
}

/** Last PDF failure reason. A swallowed error is indistinguishable from a genuine scan, so the
 *  notice would say "no text layer" about a text-rich document. */
let lastPdfError: string | undefined;
export function lastPdfFailureReason(): string | undefined {
  return lastPdfError;
}

/** Load pdf-parse lazily (see ensureBrowserGlobals): CJS `require` first, then dynamic `import`
 *  — the extension host is fussier about ESM than plain Node. Failure reasons are kept. */
async function loadPdfParse(): Promise<any | null> {
  ensureBrowserGlobals();
  const errors: string[] = [];
  const pick = (mod: unknown): any =>
    (mod as any)?.PDFParse ?? (mod as any)?.default?.PDFParse ?? (mod as any)?.default ?? mod;

  try {
    const lib = pick(require('pdf-parse'));
    if (typeof lib === 'function') { lastPdfError = undefined; return lib; }
    errors.push(`require: resolved but PDFParse is ${typeof lib}`);
  } catch (e) {
    errors.push(`require: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const lib = pick(await import('pdf-parse'));
    if (typeof lib === 'function') { lastPdfError = undefined; return lib; }
    errors.push(`import: resolved but PDFParse is ${typeof lib}`);
  } catch (e) {
    errors.push(`import: ${e instanceof Error ? e.message : String(e)}`);
  }

  lastPdfError = errors.join(' | ');
  console.error('[tiermux] pdf-parse failed to load — PDF text/rendering unavailable:', lastPdfError);
  diagLog('pdf.load', lastPdfError);
  return null;
}

/** Extract plain text from a PDF buffer using pdf-parse (which wraps pdfjs-dist).
 *  Any failure returns '' (never throws) — the caller treats that as "no text layer",
 *  so the real reason is recorded in lastPdfError for the UI to report. */
export async function extractPdfText(buf: Buffer): Promise<string> {
  // The mask must span BOTH the module load and the parse — pdf.js re-checks which platform
  // it is on when it sets up its worker, not just at import time.
  return withNodeDetection(async () => {
  const PDFParse = await loadPdfParse();
  if (!PDFParse) return '';
  let parser: any;
  try {
    parser = new PDFParse({ data: new Uint8Array(buf) });
    const result = await parser.getText();
    const text = (result?.text ?? '').trim();
    if (!text) lastPdfError = 'getText returned no text (genuinely scanned / image-only PDF)';
    return text;
  } catch (e) {
    lastPdfError = `getText: ${e instanceof Error ? e.message : String(e)}`;
    console.error('[tiermux] PDF text extraction failed:', lastPdfError);
    diagLog('pdf.text', lastPdfError);
    return '';
  } finally {
    await parser?.destroy?.().catch(() => { /* best-effort cleanup */ });
  }
  });
}

/** Cap we apply when an image is sent through the wire (mirrors the provider cap). */
export const IMAGE_BYTE_LIMIT = MAX_IMAGE_BYTES;
