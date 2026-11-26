import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
});

let passed = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed++;
  console.log(`  ✓ ${message}`);
}

async function main(): Promise<void> {
  const { createTodoSheet } = await import('../media/src/ui/components/TodoSheet');
  const todoSheet = createTodoSheet();
  document.body.appendChild(todoSheet.root);
  const progress = todoSheet.root.querySelector<HTMLElement>('[role="progressbar"]')!;
  const progressFill = todoSheet.root.querySelector<HTMLElement>('.tm-todosheet-progress-fill')!;
  const status = todoSheet.root.querySelector<HTMLElement>('[role="status"]')!;
  const bar = todoSheet.root.querySelector<HTMLButtonElement>('.tm-todobar')!;

  const firstState = {
    title: 'Tasks',
    running: true,
    steps: [
      { text: 'Inspect the existing checklist', status: 'done' as const },
      { text: 'Add a progress indicator', status: 'done' as const },
      { text: 'Announce changed steps', status: 'active' as const },
      { text: 'Test failure and completion states', status: 'pending' as const },
      { text: 'Review narrow-sidebar layout', status: 'pending' as const },
    ],
  };
  todoSheet.update(firstState);
  assert(progress.getAttribute('aria-valuemax') === '5', 'progress max reflects checklist size');
  assert(progress.getAttribute('aria-valuenow') === '2', 'progress value reflects completed steps');
  assert(progress.getAttribute('aria-valuetext') === '2 of 5 steps complete',
    'progress bar exposes a readable completion summary');
  assert(progressFill.style.width === '40%', 'visual progress fill matches completed steps');
  assert(status.textContent?.includes('Current step: Announce changed steps.'),
    'initial TODO state announces its active step');

  const secondState = {
    ...firstState,
    steps: firstState.steps.map((step, index) => ({
      ...step,
      status: (index === 0 || index === 1 || index === 2 ? 'done' : index === 3 ? 'active' : 'pending') as typeof step.status,
    })),
  };
  todoSheet.update(secondState);
  assert(progress.getAttribute('aria-valuenow') === '3' && progressFill.style.width === '60%',
    'progress updates when a step completes');
  assert(status.textContent?.includes('Current step: Test failure and completion states.'),
    'status announces the newly active step');

  const announcement = status.textContent;
  todoSheet.update(secondState);
  assert(status.textContent === announcement, 'unchanged updates do not repeat announcements');

  todoSheet.update({
    ...secondState,
    running: false,
    finished: true,
    steps: secondState.steps.map((step, index) => ({
      ...step,
      status: index === 3 ? 'failed' as const : step.status,
    })),
  });
  assert(status.textContent?.includes('finished with 1 failed step'),
    'terminal failure is announced with the failed-step count');

  const completedSheet = createTodoSheet();
  completedSheet.update({
    title: 'Plan',
    running: true,
    steps: [{ text: 'Complete the requested change', status: 'active' }],
  });
  completedSheet.update({
    title: 'Plan',
    running: false,
    finished: true,
    steps: [{ text: 'Complete the requested change', status: 'done' }],
  });
  assert(completedSheet.root.querySelector('[role="status"]')?.textContent ===
    'Plan completed. 1 of 1 step complete.',
  'successful completion is announced with the final progress');

  const zeroSteps = createTodoSheet();
  zeroSteps.update({ title: 'Tasks', steps: [] });
  assert(zeroSteps.root.querySelector('.tm-todosheet-progress')?.classList.contains('hidden') === true,
    'progress bar stays hidden for an empty checklist');
  assert(zeroSteps.root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuemax') === '1',
    'empty progress state keeps ARIA range valid');

  todoSheet.update(null);
  assert(bar.classList.contains('hidden') && status.textContent === '',
    'clearing TODO state hides the bar and clears the live announcement');
  console.log(`Passed ${passed} TODO sheet checks.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
