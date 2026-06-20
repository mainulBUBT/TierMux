// Workspace + pasted file extraction. PDFs and DOCX are heavy binary formats —
// the model never sees the raw bytes, only the text we pull out here. Images
// pass through as data: URLs so the vision provider can look at them directly.
import * as vscode from 'vscode';
import mammoth from 'mammoth';
import type { Attachment, AttachmentKind } from '../messages';

/**
 * pdf-parse wraps pdfjs-dist, which expects browser globals (DOMMatrix, …). A top-level
 * `import` makes esbuild evaluate pdfjs at bundle-load time → "DOMMatrix is not defined"
 * crashes EXTENSION ACTIVATION. So pdf-parse is loaded lazily (only when a PDF is actually
 * parsed), with the browser globals polyfilled first. A parse failure returns '' instead of
 * throwing — a PDF must never take down the attachment flow or the host.
 */
function ensureBrowserGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  if (!g.DOMMatrix) {
    // Minimal 2D-affine DOMMatrix — enough for pdfjs's text-extraction path under Node.
    // biome-ignore lint/suspicious/noExplicitAny: polyfill typed loosely on purpose
    g.DOMMatrix = class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      constructor(init?: number[]) {
        if (Array.isArray(init)) {
          this.a = init[0] ?? 1; this.b = init[1] ?? 0; this.c = init[2] ?? 0;
          this.d = init[3] ?? 1; this.e = init[4] ?? 0; this.f = init[5] ?? 0;
        }
      }
      // biome-ignore lint/suspicious/noExplicitAny: polyfill
      multiply(o: any) {
        // biome-ignore lint/suspicious/noExplicitAny: polyfill
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
      // biome-ignore lint/suspicious/noExplicitany: polyfill
      translate(tx = 0, ty = 0) { const M = g.DOMMatrix as new (i?: number[]) => any; return new M([this.a, this.b, this.c, this.d, this.e + tx, this.f + ty]); }
      // biome-ignore lint/suspicious/noExplicitany: polyfill
      scale(s = 1) { const M = g.DOMMatrix as new (i?: number[]) => any; return new M([this.a * s, this.b * s, this.c * s, this.d * s, this.e, this.f]); }
      // biome-ignore lint/suspicious/noExplicitany: polyfill
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

export interface FileFilters {
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
    att.dataUrl = `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`;
    att.text = (await extractPdfText(Buffer.from(bytes))).slice(0, MAX_EXTRACTED_CHARS);
    return att;
  }
  if (kind === 'doc') {
    if (uri.fsPath.toLowerCase().endsWith('.docx')) {
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      att.text = value.slice(0, MAX_EXTRACTED_CHARS);
    } else {
      // Plain text / markdown / json / .doc (best-effort) — decode as text and trust the user.
      att.text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).slice(0, MAX_EXTRACTED_CHARS);
    }
    return att;
  }
  // 'file': anything else we agreed to show in the picker. Decode as text.
  att.text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).slice(0, MAX_EXTRACTED_CHARS);
  return att;
}

/** Extract plain text from a PDF buffer using pdf-parse (which wraps pdfjs-dist). */
/** Extract plain text from a PDF buffer using pdf-parse (which wraps pdfjs-dist).
 *  Lazy-loaded so pdfjs never evaluates at activation; any failure returns '' (never throws). */
export async function extractPdfText(buf: Buffer): Promise<string> {
  ensureBrowserGlobals();
  try {
    const mod = await import('pdf-parse');
    // biome-ignore lint/suspicious/noExplicitAny: pdf-parse has varied export shapes across versions
    const lib = (mod as any).PDFParse ?? (mod as any).default;
    if (lib && typeof lib.getText === 'function') {
      // Class form: new PDFParse({ data }).getText()
      const parser = new lib({ data: new Uint8Array(buf) });
      try {
        const result = await parser.getText();
        return (result?.text ?? '').trim();
      } finally {
        await parser.destroy?.().catch(() => { /* best-effort cleanup */ });
      }
    }
    if (typeof lib === 'function') {
      // Function form: pdfParse(buffer) → { text }
      const result = await lib(new Uint8Array(buf));
      return (result?.text ?? '').trim();
    }
    return '';
  } catch {
    // A malformed/encrypted PDF or a missing optional dep must never break the attachment flow.
    return '';
  }
}

/** Extract plain text from a DOCX buffer using mammoth. */
export async function extractDocxText(buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return (value ?? '').trim();
}

/** Cap we apply when an image is sent through the wire (mirrors the provider cap). */
export const IMAGE_BYTE_LIMIT = MAX_IMAGE_BYTES;
