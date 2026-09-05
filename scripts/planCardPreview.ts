/** Visual preview harness for the Plan card: renders the real component from the real card text
 *  in a plain browser, decoupling "does the design look right?" from "did a free-tier model call
 *  the tool?" (2026-09-01: no card ever rendered). Input is the OUTPUT of formatPlanForCard.
 *  `npm run preview:plan`, then open dist/planCardPreview.html. */
import { createPlan, planDataFromStepText } from '../media/src/ui/components';

// The card text is produced by the REAL formatPlanForCard, but on the Node side of the build
// (scripts/buildPlanPreview.mjs) and injected here: importing planStructurer directly would drag
// the router — and its fs/path imports — into a browser bundle.
declare const __PLAN_FIXTURES__: { vendor: string; clean: string };

const { vendor, clean } = __PLAN_FIXTURES__;

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
  section('edit mode — evidence-heavy multi-file plan', build('Hide inactive products in order edit mode', vendor, 'edit')),
  section('edit mode — settled plan, actions live', build('Add a dark mode toggle', clean, 'edit')),
  section('live mode — read-only tracker', build('Add a dark mode toggle', clean, 'live')),
);
