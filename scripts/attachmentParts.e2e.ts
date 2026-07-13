// Serialization round-trip test for toOcParts() (ocClient.ts): a ChatContent array of
// text/image_url/file blocks must map to OC's Array<TextPart|FilePart> preserving
// mime/filename/url exactly AND preserving the original interleaving — no regrouping
// by type. This is the highest-risk part of the PDF/image-to-OC attachment feature
// (see docs/plans — "Send PDF/image attachments to OC as real content").
//
// Run:  esbuild scripts/attachmentParts.e2e.ts --bundle --platform=node --format=cjs --external:vscode --outfile=dist/attachmentParts.e2e.cjs && node dist/attachmentParts.e2e.cjs
import { toOcParts } from '../src/backend/ocClient';
import { collectSessionAttachmentBlocks } from '../src/agent/content';
import type { ChatContentBlock } from '../src/shared/types';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const text = (t: string): ChatContentBlock => ({ type: 'text', text: t });
const image = (n: string, mime = 'image/png'): ChatContentBlock =>
  ({ type: 'image_url', image_url: { url: `data:${mime};base64,IMG_${n}`, mime, filename: `${n}.png` } });
const pdf = (n: string, mime = 'application/pdf'): ChatContentBlock =>
  ({ type: 'file', file: { file_data: `data:${mime};base64,PDF_${n}`, mime, filename: `${n}.pdf` } });

function isFilePart(p: unknown): p is { type: 'file'; mime: string; filename?: string; url: string } {
  return !!p && typeof p === 'object' && (p as { type?: string }).type === 'file';
}
function isTextPart(p: unknown): p is { type: 'text'; text: string } {
  return !!p && typeof p === 'object' && (p as { type?: string }).type === 'text';
}

// --- image only, no text --------------------------------------------------------
{
  const parts = toOcParts([image('a')]);
  ok('image-only: exactly 1 part', parts.length === 1);
  ok('image-only: part is a FilePart', isFilePart(parts[0]));
  if (isFilePart(parts[0])) {
    ok('image-only: mime preserved', parts[0].mime === 'image/png');
    ok('image-only: filename preserved', parts[0].filename === 'a.png');
    ok('image-only: url preserved', parts[0].url === 'data:image/png;base64,IMG_a');
  }
}

// --- PDF only, no text -----------------------------------------------------------
{
  const parts = toOcParts([pdf('doc1')]);
  ok('pdf-only: exactly 1 part', parts.length === 1);
  ok('pdf-only: part is a FilePart', isFilePart(parts[0]));
  if (isFilePart(parts[0])) {
    ok('pdf-only: mime preserved', parts[0].mime === 'application/pdf');
    ok('pdf-only: filename preserved', parts[0].filename === 'doc1.pdf');
    ok('pdf-only: url preserved', parts[0].url === 'data:application/pdf;base64,PDF_doc1');
  }
}

// --- image + text question --------------------------------------------------------
{
  const parts = toOcParts([text('What is this?'), image('shot')]);
  ok('image+text: exactly 2 parts', parts.length === 2);
  ok('image+text: order is [TextPart, FilePart]', isTextPart(parts[0]) && isFilePart(parts[1]));
}

// --- pdf + text question ----------------------------------------------------------
{
  const parts = toOcParts([text('Summarize this'), pdf('report')]);
  ok('pdf+text: exactly 2 parts', parts.length === 2);
  ok('pdf+text: order is [TextPart, FilePart]', isTextPart(parts[0]) && isFilePart(parts[1]));
}

// --- multiple images ---------------------------------------------------------------
{
  const parts = toOcParts([text('compare these'), image('img1'), image('img2')]);
  ok('multi-image: exactly 3 parts', parts.length === 3);
  ok('multi-image: order preserved img1 then img2',
    isFilePart(parts[1]) && parts[1].filename === 'img1.png' && isFilePart(parts[2]) && parts[2].filename === 'img2.png');
}

// --- multiple PDFs -----------------------------------------------------------------
{
  const parts = toOcParts([pdf('p1'), pdf('p2'), text('which is longer?')]);
  ok('multi-pdf: exactly 3 parts', parts.length === 3);
  ok('multi-pdf: order preserved p1, p2, then text',
    isFilePart(parts[0]) && parts[0].filename === 'p1.pdf' &&
    isFilePart(parts[1]) && parts[1].filename === 'p2.pdf' &&
    isTextPart(parts[2]));
}

// --- image + pdf mixed --------------------------------------------------------------
{
  const parts = toOcParts([text('cross-reference these'), image('chart'), pdf('appendix')]);
  ok('image+pdf mixed: exactly 3 parts', parts.length === 3);
  ok('image+pdf mixed: order is [Text, FilePart(image), FilePart(pdf)]',
    isTextPart(parts[0]) &&
    isFilePart(parts[1]) && parts[1].mime === 'image/png' &&
    isFilePart(parts[2]) && parts[2].mime === 'application/pdf');
}

// --- interleaved text/image/text/pdf: no regrouping by type -------------------------
{
  const parts = toOcParts([text('intro'), image('img1'), image('img2'), pdf('doc'), text('outro')]);
  ok('interleaved: exactly 5 parts, no dropping', parts.length === 5);
  const kinds = parts.map((p) => (isTextPart(p) ? 'text' : isFilePart(p) ? 'file' : '?'));
  ok('interleaved: kind sequence is [text, file, file, file, text] (position preserved)',
    JSON.stringify(kinds) === JSON.stringify(['text', 'file', 'file', 'file', 'text']));
  ok('interleaved: first FilePart is img1 (not regrouped/reordered)', isFilePart(parts[1]) && parts[1].filename === 'img1.png');
  ok('interleaved: last part is the trailing text, not moved before attachments', isTextPart(parts[4]) && parts[4].text === 'outro');
}

// --- attachment-only, no accompanying text (observation, not a feature) -------------
{
  const parts = toOcParts([image('solo')]);
  ok('attachment-only: no empty TextPart injected (or if present, harmless — just documenting behavior)',
    parts.every((p) => !isTextPart(p) || p.text.length > 0));
  ok('attachment-only: the FilePart itself is intact', parts.some((p) => isFilePart(p) && p.filename === 'solo.png'));
}

// --- plain string content (no attachments at all) — must still work -----------------
{
  ok('plain string: single TextPart', JSON.stringify(toOcParts('hello')) === JSON.stringify([{ type: 'text', text: 'hello' }]));
  ok('empty string: zero parts', toOcParts('').length === 0);
  ok('null content: zero parts', toOcParts(null).length === 0);
}

// --- collectSessionAttachmentBlocks: session attachment memory ----------------------
{
  const msgs = (contents: Array<{ role: 'user' | 'assistant'; content: ChatContentBlock[] | string }>) =>
    contents as Parameters<typeof collectSessionAttachmentBlocks>[0];

  // follow-up turn with no new attachment still sees the earlier image
  const history = msgs([
    { role: 'user', content: [text('here is a screenshot'), image('shot1')] },
    { role: 'assistant', content: 'I see a login form.' },
    { role: 'user', content: [text('why is the second column empty?')] },
  ]);
  const blocks = collectSessionAttachmentBlocks(history);
  ok('session-memory: earlier image survives a text-only follow-up', blocks.length === 1);

  // dedupe by url: the same image in two turns is collected once
  const dup = collectSessionAttachmentBlocks(msgs([
    { role: 'user', content: [image('same')] },
    { role: 'user', content: [image('same')] },
  ]));
  ok('session-memory: identical payload deduped by url', dup.length === 1);

  // cap: only the most recent N attachments are kept
  const many = collectSessionAttachmentBlocks(msgs([
    { role: 'user', content: [image('a'), image('b'), image('c'), image('d'), image('e')] },
  ]));
  ok('session-memory: capped to most recent 4', many.length === 4);
  const [firstKept] = many.map((b) => (b as { image_url?: { filename?: string } }).image_url?.filename);
  ok('session-memory: cap drops the OLDEST first', firstKept === 'b.png');

  // assistant-turn and string-content messages contribute nothing
  const none = collectSessionAttachmentBlocks(msgs([
    { role: 'assistant', content: [image('fromAssistant')] },
    { role: 'user', content: 'plain text' },
  ]));
  ok('session-memory: assistant/string turns contribute no attachments', none.length === 0);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
