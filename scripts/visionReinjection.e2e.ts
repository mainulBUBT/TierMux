// End-to-end test of the router-proxy vision path: boots the REAL startRouterProxy()
// with a fake Router, sets the forced-* run channels the way sdk.ts does, then POSTs
// completion requests shaped like OC's re-serializations. Asserts what the Router
// actually receives: forced vision taskKind, and the session's image blocks spliced
// into the last user message (missing / rewritten-URL / partial cases).
//
// Run:  esbuild scripts/visionReinjection.e2e.ts --bundle --platform=node --format=cjs --external:vscode --outfile=dist/visionReinjection.e2e.cjs && node dist/visionReinjection.e2e.cjs
import {
  startRouterProxy,
  setForcedTaskKind,
  setForcedAttachments,
} from '../src/backend/routerProxy';
import type { ChatContentBlock, ChatMessage } from '../src/shared/types';

let failures = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const IMG_URL = 'data:image/png;base64,SESSION_IMG_1';
const imageBlock: ChatContentBlock = { type: 'image_url', image_url: { url: IMG_URL, mime: 'image/png', filename: 'shot.png' } } as ChatContentBlock;

interface Captured { messages: ChatMessage[]; opts: any }
const captured: Captured[] = [];

// Minimal fake Router: records what handleChatCompletion hands it, returns a canned answer.
const fakeRouter: any = {
  settings: { enabledByPriority: () => [] },
  route: async (messages: ChatMessage[], opts: any) => {
    captured.push({ messages, opts });
    return {
      platform: 'google',
      model: 'gemini-2.5-flash',
      response: { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    };
  },
};

async function post(baseURL: string, body: unknown): Promise<number> {
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

function lastUserBlocks(messages: ChatMessage[]): ChatContentBlock[] {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  return Array.isArray(lastUser?.content) ? (lastUser!.content as ChatContentBlock[]) : [];
}
const imageUrls = (blocks: ChatContentBlock[]): string[] =>
  blocks
    .filter((b): b is Extract<ChatContentBlock, { type: 'image_url' }> => !!b && typeof b === 'object' && (b as any).type === 'image_url')
    .map((b: any) => b.image_url?.url);

(async () => {
  const proxy = await startRouterProxy(fakeRouter);
  try {
    // --- Case 1: OC forwarded NO attachment blocks (text-only re-serialization) -----
    setForcedTaskKind('vision');
    setForcedAttachments([imageBlock]);
    captured.length = 0;
    let status = await post(proxy.baseURL, {
      model: 'tiermux/fast',
      stream: false,
      messages: [{ role: 'user', content: 'why is the column empty?' }],
    });
    ok('no-blocks: request accepted', status === 200);
    ok('no-blocks: router received exactly one call', captured.length === 1);
    {
      const urls = imageUrls(lastUserBlocks(captured[0]?.messages ?? []));
      ok('no-blocks: session image reinjected into last user message', urls.includes(IMG_URL));
      ok('no-blocks: forced vision taskKind reached the router', captured[0]?.opts?.taskKind === 'vision');
    }

    // --- Case 2: OC forwarded the image with a REWRITTEN unusable URL ---------------
    captured.length = 0;
    status = await post(proxy.baseURL, {
      model: 'tiermux/fast',
      stream: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'why is the column empty?' },
          { type: 'image_url', image_url: { url: 'file:///tmp/oc-rewrote-this.png', mime: 'image/png' } },
        ],
      }],
    });
    ok('rewritten-url: request accepted', status === 200);
    {
      const urls = imageUrls(lastUserBlocks(captured[0]?.messages ?? []));
      ok('rewritten-url: unusable block stripped', !urls.includes('file:///tmp/oc-rewrote-this.png'));
      ok('rewritten-url: real data: image reinjected', urls.includes(IMG_URL));
    }

    // --- Case 3: OC forwarded the image intact (same data: URL) — no duplication ----
    captured.length = 0;
    status = await post(proxy.baseURL, {
      model: 'tiermux/fast',
      stream: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'and the header row?' },
          { type: 'image_url', image_url: { url: IMG_URL, mime: 'image/png', filename: 'shot.png' } },
        ],
      }],
    });
    ok('intact: request accepted', status === 200);
    {
      const urls = imageUrls(lastUserBlocks(captured[0]?.messages ?? []));
      ok('intact: image present exactly once (no duplicate reinjection)', urls.filter((u) => u === IMG_URL).length === 1);
    }

    // --- Case 4: new image this turn + older session image — older one appended -----
    const NEW_URL = 'data:image/png;base64,SESSION_IMG_2';
    setForcedAttachments([
      imageBlock,
      { type: 'image_url', image_url: { url: NEW_URL, mime: 'image/png', filename: 'new.png' } } as ChatContentBlock,
    ]);
    captured.length = 0;
    status = await post(proxy.baseURL, {
      model: 'tiermux/fast',
      stream: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'compare with the previous screenshot' },
          { type: 'image_url', image_url: { url: NEW_URL, mime: 'image/png', filename: 'new.png' } },
        ],
      }],
    });
    ok('partial: request accepted', status === 200);
    {
      const urls = imageUrls(lastUserBlocks(captured[0]?.messages ?? []));
      ok('partial: new image kept', urls.includes(NEW_URL));
      ok('partial: earlier session image appended too', urls.includes(IMG_URL));
    }

    // --- Case 5: no forced vision run (plain text turn) — nothing injected -----------
    setForcedTaskKind(undefined);
    setForcedAttachments(undefined);
    captured.length = 0;
    status = await post(proxy.baseURL, {
      model: 'tiermux/fast',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    });
    ok('no-vision-run: request accepted', status === 200);
    ok('no-vision-run: nothing injected', imageUrls(lastUserBlocks(captured[0]?.messages ?? [])).length === 0);
  } finally {
    proxy.close();
    setForcedTaskKind(undefined);
    setForcedAttachments(undefined);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
