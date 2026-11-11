/* Raw PDF blocks end to end: a scanned PDF (no text, no page renders) reaches the engine as a
 * `file` block — restored to a model file part (engine) which a carriesRawPdf provider would
 * deliver, while stripFileBlocks — the OpenAI-compat wire shape — now SWAPS it for an explicit
 * not-delivered note instead of silently dropping it (the model used to answer questions about a
 * file it never saw). Also: image blocks keep flowing untouched, and the router message
 * round-trip preserves a pdf file part. The "v3.1 restores that flow" comment is gone for good.
 * Run: npm run test:e2e:pdf-block */
import { toModelMessages } from '../src/agent/core/engine';
import { stripFileBlocks, normalizeAttachmentBlocks } from '../src/agent/content';
import { toRouterMessages } from '../src/agent/core/routerProvider';
import type { ChatMessage } from '../src/shared/types';

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `   (${detail})` : ''}`);
};

const PDF_DATA = 'data:application/pdf;base64,JVBERi0xLjQK';

async function main(): Promise<void> {
  console.log('— Engine: a pdf file block becomes a model file part (was: dropped) —');
  {
    const msgs: ChatMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is on page 2?' },
        { type: 'file', file: { filename: 'scan.pdf', file_data: PDF_DATA, mime: 'application/pdf' } },
      ],
    } as unknown as ChatMessage['content']] as ChatMessage[];
    const model = toModelMessages(msgs);
    const user = model.find((m) => m.role === 'user');
    const parts = (user?.content ?? []) as Array<{ type?: string; mediaType?: string; data?: string; text?: string }>;
    const filePart = parts.find((p) => p.type === 'file');
    check('file part present', !!filePart, JSON.stringify(parts));
    check('mediaType is the pdf mime', filePart?.mediaType === 'application/pdf', String(filePart?.mediaType));
    check('data carries the bytes', filePart?.data === PDF_DATA);
    check('text part kept', parts.some((p) => p.type === 'text' && p.text === 'What is on page 2?'));
    // A non-data-URL file_data (corrupt host path) must not fabricate a part.
    const bad: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'file', file: { filename: 'x.pdf', file_data: 'http://elsewhere/x.pdf', mime: 'application/pdf' } }],
    } as unknown as ChatMessage['content']] as ChatMessage[];
    check('non-data-URL file_data dropped (never fetched blindly)', !((toModelMessages(bad)[0]?.content ?? []) as Array<{ type?: string }>).some((p) => p.type === 'file'));
  }

  console.log('\n— Wire: OpenAI-compat gets an explicit not-delivered note, images untouched —');
  {
    const content = [
      { type: 'text', text: 'hi' },
      { type: 'file', file: { filename: 'scan.pdf', file_data: PDF_DATA, mime: 'application/pdf' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=', mime: 'image/png', filename: 'p1.png' } },
    ] as never;
    const stripped = stripFileBlocks(content) as Array<{ type?: string; text?: string; image_url?: { url: string } }>;
    check('pdf block replaced by a text note', stripped.some((b) => b.type === 'text' && /scan\.pdf" not delivered/.test(b.text ?? '') && /cannot read PDF/.test(b.text ?? '')), JSON.stringify(stripped));
    check('note tells the model not to guess', stripped.some((b) => b.text?.includes('instead of guessing')));
    check('image_url survives, narrowed to { url }', stripped.some((b) => b.type === 'image_url' && Object.keys(b.image_url ?? {}).length === 1));
    check('original text kept', stripped.some((b) => b.type === 'text' && b.text === 'hi'));
    // The attachment normalizer still sees the ORIGINAL blocks (routing kinds, webview) — the
    // note lives only in the wire copy.
    check('normalize still reports the pdf kind', normalizeAttachmentBlocks(content).some((b) => b.mime === 'application/pdf'));
  }

  console.log('\n— Router round-trip: a model file part becomes a wire file block again —');
  {
    // LanguageModelV4 file-part shape (what the SDK hands the provider): data WRAPPED as
    // { type:'data', data } — the ModelMessage bare-string form is unwrapped upstream.
    const prompt = [{
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'read it' },
        { type: 'file' as const, data: { type: 'data' as const, data: PDF_DATA }, mediaType: 'application/pdf', filename: 'scan.pdf' },
      ],
    }];
    const routed = toRouterMessages(prompt as never);
    const user = routed.find((m) => m.role === 'user');
    const blocks = (user?.content ?? []) as Array<{ type?: string; file?: { mime?: string; file_data?: string } }>;
    const fb = blocks.find((b) => b.type === 'file');
    check('pdf round-trips to a wire file block', fb?.file?.mime === 'application/pdf' && fb.file.file_data === PDF_DATA, JSON.stringify(blocks));
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
