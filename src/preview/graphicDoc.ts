// Pure half of the graphic preview: what is previewable, the canvas a source declares, the srcdoc it renders as.

export type PreviewKind = 'image' | 'source';

export interface Canvas { width: number; height: number }

export const DEFAULT_CANVAS: Canvas = { width: 1200, height: 630 };

export const CANVAS_PRESETS: { label: string; width: number; height: number }[] = [
  { label: 'OG', width: 1200, height: 630 },
  { label: 'X post', width: 1600, height: 900 },
  { label: 'Square', width: 1080, height: 1080 },
  { label: 'Story', width: 1080, height: 1920 },
  { label: 'YouTube', width: 1280, height: 720 },
];

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const SOURCE_EXT = new Set(['.html', '.htm', '.svg']);

export function previewKind(file: string): PreviewKind | undefined {
  const ext = (/\.[^./\\]+$/.exec(file)?.[0] ?? '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (SOURCE_EXT.has(ext)) return 'source';
  return undefined;
}

const MIN_SIDE = 100;
const MAX_SIDE = 4096;
const inRange = (n: number) => n >= MIN_SIDE && n <= MAX_SIDE;
const px = (decl: string, prop: 'width' | 'height') => {
  const m = new RegExp(`(?:^|[;{\\s"'])${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, 'i').exec(decl);
  return m ? Math.round(Number(m[1])) : undefined;
};

/** The canvas the source pins itself to: an SVG's width/height (or viewBox), else the first
 *  inline style or CSS rule that sets both width and height in px. */
export function detectCanvas(text: string, svg = false): Canvas | undefined {
  if (svg) {
    const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
    if (!tag) return undefined;
    const attr = (n: string) => { const m = new RegExp(`\\s${n}\\s*=\\s*["']\\s*(\\d+(?:\\.\\d+)?)(?:px)?\\s*["']`, 'i').exec(tag); return m ? Math.round(Number(m[1])) : undefined; };
    let width = attr('width'), height = attr('height');
    if (width === undefined || height === undefined) {
      const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag);
      if (vb) { width = Math.round(Number(vb[1])); height = Math.round(Number(vb[2])); }
    }
    return width !== undefined && height !== undefined && inRange(width) && inRange(height) ? { width, height } : undefined;
  }
  const decls = [
    ...[...text.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi)].map((m) => ({ at: m.index ?? 0, body: m[2] })),
    ...[...text.matchAll(/\{([^{}]*)\}/g)].map((m) => ({ at: m.index ?? 0, body: m[1] })),
  ].sort((a, b) => a.at - b.at);
  for (const { body } of decls) {
    const width = px(body, 'width'), height = px(body, 'height');
    if (width !== undefined && height !== undefined && inRange(width) && inRange(height)) return { width, height };
  }
  return undefined;
}

/** The document the preview iframe renders: SVG scaled to the canvas, HTML with a <base> so
 *  relative paths resolve the way renderImage resolves them (an existing <base> wins). */
export function previewDocument(text: string, svg: boolean, baseHref: string): string {
  const base = `<base href="${baseHref.replace(/"/g, '&quot;')}">`;
  if (svg) {
    return `<!doctype html><html><head><meta charset="utf-8">${base}<style>html,body{margin:0;height:100%;overflow:hidden}`
      + `body>svg{display:block;width:100vw;height:100vh}</style></head><body>${text.replace(/^\s*<\?xml[^>]*\?>/i, '')}</body></html>`;
  }
  if (/<base\s/i.test(text)) return text;
  if (/<head[^>]*>/i.test(text)) return text.replace(/<head[^>]*>/i, (m) => `${m}${base}`);
  if (/<html[^>]*>/i.test(text)) return text.replace(/<html[^>]*>/i, (m) => `${m}<head>${base}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${base}<style>html,body{margin:0}</style></head><body>${text}</body></html>`;
}
