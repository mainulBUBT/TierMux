// Upstream vision-classification test. The vision path (vision-capable model + per-turn
// re-injection) fires only when classifyTask() returns 'vision', which in turn depends on
// attachmentKindsFromContent() reporting 'image'/'pdf'. That mime detection must be robust:
// an image attached with an EMPTY or MISSING `mime` field (some paste sources, host
// data-URL forwards) previously fell back to 'application/octet-stream' → classified as a
// text 'doc' → NOT vision → the image was never re-injected and was lost across the agent
// tool loop (runaway search, empty answer). The fix recovers the mime from the `data:` URL
// header. This test locks that in.
//
// Run:  esbuild scripts/visionClassify.e2e.ts --bundle --platform=node --format=cjs --external:vscode --outfile=dist/visionClassify.e2e.cjs && node dist/visionClassify.e2e.cjs
import { classifyTask, attachmentKindsFromContent } from '../src/agent/routing';
import { normalizeAttachmentBlocks, collectSessionAttachmentBlocks } from '../src/agent/content';
import type { ChatContentBlock, ChatMessage } from '../src/shared/types';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// image_url block with a configurable mime field (undefined = field absent).
const img = (mime: string | undefined, urlMime = 'image/png'): ChatContentBlock =>
  ({ type: 'image_url', image_url: { url: `data:${urlMime};base64,IMGDATA`, ...(mime === undefined ? {} : { mime }), filename: 'shot.png' } } as ChatContentBlock);
const fileBlock = (mime: string | undefined, urlMime: string): ChatContentBlock =>
  ({ type: 'file', file: { file_data: `data:${urlMime};base64,FILEDATA`, ...(mime === undefined ? {} : { mime }), filename: 'doc' } } as ChatContentBlock);

const PROMPT = 'find out the issue in this screenshot';

// 1. Baseline — explicit image mime classifies as vision.
{
  const content = [{ type: 'text', text: PROMPT }, img('image/png')] as ChatContentBlock[];
  ok('explicit image/png → kind image', attachmentKindsFromContent(content)[0] === 'image');
  ok('explicit image/png → vision', classifyTask(PROMPT, { attachmentKinds: attachmentKindsFromContent(content) }) === 'vision');
}

// 2. THE FIX — mime field entirely ABSENT, but url is data:image/... → still vision.
{
  const content = [{ type: 'text', text: PROMPT }, img(undefined, 'image/jpeg')] as ChatContentBlock[];
  ok('missing mime → recovered image/jpeg from url', normalizeAttachmentBlocks(content)[0]?.mime === 'image/jpeg');
  ok('missing mime → kind image (not doc)', attachmentKindsFromContent(content)[0] === 'image');
  ok('missing mime → vision', classifyTask(PROMPT, { attachmentKinds: attachmentKindsFromContent(content) }) === 'vision');
}

// 3. THE FIX — EMPTY mime string, url is data:image/... → still vision.
{
  const content = [{ type: 'text', text: PROMPT }, img('', 'image/png')] as ChatContentBlock[];
  ok('empty mime → recovered image/png from url', normalizeAttachmentBlocks(content)[0]?.mime === 'image/png');
  ok('empty mime → kind image', attachmentKindsFromContent(content)[0] === 'image');
  ok('empty mime → vision (was mis-routing as doc before fix)', classifyTask(PROMPT, { attachmentKinds: attachmentKindsFromContent(content) }) === 'vision');
}

// 4. Generic octet-stream mime but data:image url → recovered.
{
  const content = [img('application/octet-stream', 'image/webp')] as ChatContentBlock[];
  ok('octet-stream mime → recovered image/webp', normalizeAttachmentBlocks(content)[0]?.mime === 'image/webp');
  ok('octet-stream mime → kind image', attachmentKindsFromContent(content)[0] === 'image');
}

// 5. PDF with missing mime but data:application/pdf url → pdf (also a vision route).
{
  const content = [{ type: 'text', text: PROMPT }, fileBlock(undefined, 'application/pdf')] as ChatContentBlock[];
  ok('missing-mime pdf → kind pdf', attachmentKindsFromContent(content)[0] === 'pdf');
  ok('missing-mime pdf → vision route', classifyTask(PROMPT, { attachmentKinds: attachmentKindsFromContent(content) }) === 'vision');
}

// 6. Regression — a genuine non-image/non-pdf file must NOT be forced to vision.
{
  const content = [{ type: 'text', text: 'summarize this' }, fileBlock('text/csv', 'text/csv')] as ChatContentBlock[];
  ok('csv file → kind doc', attachmentKindsFromContent(content)[0] === 'doc');
  ok('csv file → NOT vision', classifyTask('summarize this', { attachmentKinds: attachmentKindsFromContent(content) }) !== 'vision');
}

// 7. Session capture still collects the empty-mime image (it must reach forcedAttachments).
{
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: PROMPT }, img('', 'image/png')] as ChatContentBlock[] }];
  const blocks = collectSessionAttachmentBlocks(messages);
  ok('empty-mime image is captured for the session (reinjection source)', blocks.length === 1);
}

// 8. Language-agnostic vision routing: an image forces the vision route regardless of the
// text's language (routing keys off the attachment MIME, not English keywords) — so a Banglish
// or Bengali prompt with an image still lands on a vision model. Build-vs-Q&A is left to the
// (multilingual) model via a single neutral directive, so no language-specific test is needed.
{
  const banglish = [{ type: 'text', text: 'ei design ta banao' }, img('image/png')] as ChatContentBlock[];
  ok('Banglish build prompt + image → still vision route', classifyTask('ei design ta banao', { attachmentKinds: attachmentKindsFromContent(banglish) }) === 'vision');
  const bengali = [{ type: 'text', text: 'এই স্ক্রিনশটে সমস্যা কী' }, img('image/jpeg')] as ChatContentBlock[];
  ok('Bengali Q&A prompt + image → still vision route', classifyTask('এই স্ক্রিনশটে সমস্যা কী', { attachmentKinds: attachmentKindsFromContent(bengali) }) === 'vision');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
