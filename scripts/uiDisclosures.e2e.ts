import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  acquireVsCodeApi: () => ({ postMessage() {} }),
});

let passed = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed++;
  console.log(`  ✓ ${message}`);
}

async function main(): Promise<void> {
  const { buildReasoningBlock, buildToolCard, settleReasoningBlock, updateReasoningBlock } =
    await import('../media/src/ui/tool/ToolCard');

  console.log('uiDisclosures.e2e');

  {
    const card = buildToolCard({
      name: 'readFile',
      args: { path: 'src/index.ts' },
      detail: 'file contents',
      state: 'done',
      toolCallId: 'read-1',
    });
    document.body.appendChild(card);

    const toggle = card.querySelector<HTMLButtonElement>('.tm-tool-card-toggle')!;
    const body = card.querySelector<HTMLElement>('.tm-tool-card-body')!;
    assert(toggle.tagName === 'BUTTON' && toggle.type === 'button', 'tool disclosure uses a native button');
    assert(toggle.getAttribute('aria-controls') === body.id, 'tool disclosure references its output region');
    assert(toggle.getAttribute('aria-expanded') === 'false', 'tool output starts collapsed');
    toggle.focus();
    assert(document.activeElement === toggle, 'tool disclosure can receive keyboard focus');
    toggle.click();
    assert(card.classList.contains('open') && toggle.getAttribute('aria-expanded') === 'true',
      'tool disclosure click opens and announces its output');
    toggle.click();
    assert(!card.classList.contains('open') && toggle.getAttribute('aria-expanded') === 'false',
      'tool disclosure click closes and announces its output');
  }

  {
    const emptyCard = buildToolCard({ name: 'unknownTool', args: {}, state: 'done' });
    const toggle = emptyCard.querySelector<HTMLButtonElement>('.tm-tool-card-toggle')!;
    assert(toggle.disabled, 'tool disclosure is disabled when there is no output');
  }

  {
    let retries = 0;
    const card = buildToolCard({
      name: 'runCommand',
      args: { command: 'check' },
      detail: 'command failed',
      state: 'error',
      toolCallId: 'failed-command',
    }, () => { retries++; });
    const toggle = card.querySelector<HTMLButtonElement>('.tm-tool-card-toggle')!;
    const retry = card.querySelector<HTMLButtonElement>('.tm-tool-card-btn')!;
    assert(toggle.getAttribute('aria-expanded') === 'true', 'failed tool output starts expanded');
    assert(card.querySelector('.tm-tool-card-body')?.textContent?.includes('command failed') === true,
      'failed tool output is inside its controlled region');
    toggle.click();
    retry.click();
    assert(retries === 1, 'retry action remains independently operable');
    assert(toggle.getAttribute('aria-expanded') === 'false',
      'retry action does not toggle the enclosing disclosure');
  }

  {
    let cancellations = 0;
    const card = buildToolCard({
      name: 'runCommand',
      args: { command: 'long-running-check' },
      detail: 'still running',
      state: 'running',
    }, undefined, () => { cancellations++; });
    document.body.appendChild(card);
    const toggle = card.querySelector<HTMLButtonElement>('.tm-tool-card-toggle')!;
    const cancel = card.querySelector<HTMLButtonElement>('.tm-tool-card-btn')!;
    cancel.focus();
    assert(document.activeElement === cancel, 'cancel action is independently keyboard-focusable');
    assert(cancel.getAttribute('aria-label') === 'Cancel tool call', 'cancel action has an accessible name');
    cancel.click();
    assert(cancellations === 1 && toggle.getAttribute('aria-expanded') === 'false',
      'cancel action does not toggle the enclosing disclosure');
  }

  {
    const card = buildToolCard({
      name: 'editFile',
      args: { path: 'src/index.ts', search: 'before', replace: 'after' },
      state: 'done',
    });
    const toggle = card.querySelector<HTMLButtonElement>('.tm-tool-card-toggle')!;
    const body = card.querySelector<HTMLElement>('.tm-tool-card-body')!;
    assert(body.querySelector('.tm-edit-diff') !== null, 'edit diff is inside the controlled region');
    assert(toggle.getAttribute('aria-expanded') === 'true', 'completed edit starts expanded');
    toggle.click();
    assert(!card.classList.contains('open') && toggle.getAttribute('aria-expanded') === 'false',
      'edit diff can be collapsed with the disclosure button');
  }

  {
    const block = buildReasoningBlock('thought', 'reasoning-live', true);
    const toggle = block.querySelector<HTMLButtonElement>('.tm-reasoning-header')!;
    const content = block.querySelector<HTMLElement>('.tm-reasoning-content')!;
    assert(toggle.tagName === 'BUTTON' && toggle.type === 'button', 'reasoning disclosure uses a native button');
    assert(toggle.getAttribute('aria-controls') === content.id, 'reasoning disclosure references its content');
    assert(toggle.getAttribute('aria-expanded') === 'true', 'streaming reasoning starts expanded');
    toggle.click();
    updateReasoningBlock(block, 'updated thought');
    assert(block.classList.contains('open') && toggle.getAttribute('aria-expanded') === 'true',
      'stream updates synchronize the reasoning disclosure state');
    settleReasoningBlock(block, 1200);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert(!block.classList.contains('open') && toggle.getAttribute('aria-expanded') === 'false',
      'settled reasoning auto-collapse updates its announced state');
  }

  {
    const block = buildReasoningBlock('thought', 'reasoning-kept-open', true);
    const toggle = block.querySelector<HTMLButtonElement>('.tm-reasoning-header')!;
    settleReasoningBlock(block, 1200);
    toggle.click();
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert(block.classList.contains('open') && toggle.getAttribute('aria-expanded') === 'true',
      'reasoning stays open when the user reopens it during auto-collapse');
  }

  console.log(`Passed ${passed} UI disclosure checks.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
