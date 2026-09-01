/** Visual preview harness for the Plan card — renders the real component from the real card
 *  text, so the design can be inspected in a plain browser without a model, a provider, or the
 *  extension host.
 *
 *  Why it exists: judging the card through a live turn couples "does the design look right?" to
 *  "did a free-tier model call the tool?" — and on 2026-09-01 two different models answered a
 *  question ABOUT plan mode by pasting the schema, so no card ever rendered and the design was
 *  never actually on screen. This decouples them. `npm run preview:plan`, then open
 *  dist/planCardPreview.html.
 *
 *  The input is deliberately the OUTPUT of formatPlanForCard, not a hand-written PlanData: what
 *  you see here is exactly what the webview builds from what the tool emits. */
import { createPlan, planDataFromStepText } from '../media/src/ui/components';

// The card text is produced by the REAL formatPlanForCard, but on the Node side of the build
// (scripts/buildPlanPreview.mjs) and injected here: importing planStructurer directly would drag
// the router — and its fs/path imports — into a browser bundle.
declare const __PLAN_FIXTURES__: { withQuestions: string; clean: string };

const { withQuestions, clean } = __PLAN_FIXTURES__;

const section = (label: string, node: HTMLElement): HTMLElement => {
  const box = document.createElement('div');
  box.className = 'pv-case';
  const h = document.createElement('div');
  h.className = 'pv-label';
  h.textContent = label;
  box.append(h, node);
  return box;
};

const build = (title: string, text: string, mode: 'edit' | 'live') => {
  const { data, summary } = planDataFromStepText(title, text);
  return createPlan({
    data, mode, summary,
    onApprove: () => {}, onExecute: () => {}, onDefer: () => {}, onDiscard: () => {},
  });
};

document.body.append(
  section('edit mode — open questions block execution', build('Hide inactive products in order edit mode', withQuestions, 'edit')),
  section('edit mode — nothing open, actions enabled', build('Add a dark mode toggle', clean, 'edit')),
  section('live mode — read-only tracker', build('Add a dark mode toggle', clean, 'live')),
);
