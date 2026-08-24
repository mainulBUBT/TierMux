// Model picker — a quiet toolbar pill opening a rich popover: search, the
// reasoning-effort segmented control (a per-model property, so it lives here rather
// than in the toolbar), the "Auto — smart routing" entry, and the enabled models
// grouped by provider with capability chips (T/V/R) and status tags
// (unavailable / slow / off).
//
// Model DATA stays owned by main.ts (`getEnabledModelOptions()` reads the host
// config); the component renders whatever it is given and reports changes through
// callbacks. The serving-model indicator (which model actually served the current
// turn, incl. failovers) is driven by setServing()/setServing(null).

import { el, icon } from '../dom';
import { ICON } from '../../icons';
import { createPopover } from '../primitives/Popover';

/** One pickable model. Mirrors what main.ts's getEnabledModelOptions() produces. */
export interface ModelOption {
  /** 'platform::modelId' (or 'custom::endpointId::modelId'); 'auto' is separate. */
  value: string;
  label: string;
  /** Provider display name — models are grouped under it. */
  group: string;
  /** Capability flags for the T/V/R chips (absent for custom-endpoint models). */
  model?: { supportsTools?: boolean; supportsVision?: boolean; supportsReasoning?: boolean } | null;
}

export interface ModelPickerInit {
  /** 'auto' or 'platform::modelId'. */
  value: string;
  /** Initial reasoning effort (off | low | medium | high | xhigh). */
  reasoning: string;
  onChange(value: string, label: string): void;
  onReasoningChange(effort: string): void;
}

export interface ModelPickerSetOptions {
  options: ModelOption[];
  /** `platform::modelId` values the provider reported as gone — tagged "unavailable". */
  deprecated?: string[];
  /** `platform::modelId` values with recent slow responses — tagged "slow". */
  slow?: string[];
}

export interface ModelPickerHandle {
  el: HTMLElement;
  /** Select a model; also ends any live serving indicator (an explicit pick wins). */
  setValue(value: string, label?: string): void;
  /** Replace the pickable set (host config arrived / changed). */
  setOptions(opts: ModelPickerSetOptions): void;
  /** Show the model actually serving the turn on the trigger (null = user's pick). */
  setServing(label: string | null): void;
  /** Update the segmented control: new effort and/or disabled (non-reasoning model). */
  setReasoning(effort: string, disabled?: boolean): void;
  close(): void;
}

const EFFORTS: { value: string; label: string; title: string }[] = [
  { value: 'off', label: 'Off', title: 'Off' },
  { value: 'low', label: 'Low', title: 'Low' },
  { value: 'medium', label: 'Med', title: 'Medium' },
  { value: 'high', label: 'High', title: 'High' },
  { value: 'xhigh', label: 'Max', title: 'Very High' },
];

/** Trigger label for a value: "Auto", the option's label, or the bare model id. */
function displayLabel(value: string, options: ModelOption[]): string {
  if (value === 'auto') return 'Auto';
  const hit = options.find((o) => o.value === value);
  return hit ? hit.label : (value.split('::').slice(1).join('::') || value);
}

export function createModelPicker(init: ModelPickerInit): ModelPickerHandle {
  let options: ModelOption[] = [];
  let deprecated = new Set<string>();
  let slow = new Set<string>();
  let value = init.value;
  let label = displayLabel(value, []);
  let serving: string | null = null;
  let preServingLabel = '';
  let reasoning = init.reasoning;
  let reasoningDisabled = false;

  const triggerIconEl = icon('', 'tm-model-trigger-icon');
  const labelEl = el('span', { class: 'tm-model-label' });
  const trigger = el(
    'button',
    { class: 'tm-model-trigger', type: 'button', 'aria-label': 'Model' },
    triggerIconEl, labelEl,
  );

  const searchEl = el('input', { class: 'tm-model-search', type: 'text', placeholder: 'Search models…', autocomplete: 'off' }) as HTMLInputElement;
  const noteEl = el('div', { class: 'tm-reasoning-note hidden' }, 'This model has no reasoning mode');
  const segEl = el('div', { class: 'tm-reasoning-seg', role: 'radiogroup', 'aria-label': 'Reasoning effort' });
  const segBtns = new Map<string, HTMLButtonElement>();
  EFFORTS.forEach((e) => {
    const b = el('button', { class: 'tm-seg-btn', type: 'button', title: e.title, dataset: { effort: e.value } }, e.label) as HTMLButtonElement;
    b.addEventListener('click', () => {
      reasoning = e.value;
      renderReasoning();
      init.onReasoningChange(e.value);
    });
    segBtns.set(e.value, b);
    segEl.append(b);
  });
  const listEl = el('div', { class: 'tm-model-list' });

  // ── trigger ──
  // Auto stays "Auto" on the pill even while a turn is being served — the whole point of
  // Auto is the user doesn't pick a model, so swapping the label to whatever it picked
  // under the hood would just be noise. The actual model still shows in the tooltip.
  // A pinned model still swaps its label to the serving one (e.g. on failover), since
  // that's a real deviation from the user's explicit pick.
  function renderTrigger() {
    const isAuto = value === 'auto';
    trigger.classList.toggle('tm-is-auto', isAuto);
    trigger.classList.toggle('tm-serving', !!serving);
    triggerIconEl.innerHTML = isAuto ? ICON.sparkle : ICON.chip;
    labelEl.textContent = isAuto ? 'Auto' : (serving || label);
    trigger.title = serving ? `Serving this turn: ${serving}` : (isAuto ? 'Auto (smart routing)' : label);
  }

  // ── reasoning segmented control ──
  function renderReasoning() {
    segBtns.forEach((b, effort) => {
      b.classList.toggle('active', effort === reasoning);
      b.setAttribute('aria-checked', String(effort === reasoning));
      b.disabled = reasoningDisabled;
    });
    segEl.classList.toggle('tm-disabled', reasoningDisabled);
    segEl.parentElement?.classList.toggle('tm-reasoning-off', reasoningDisabled);
    noteEl.classList.toggle('hidden', !reasoningDisabled);
  }

  // ── list ──
  function capChips(m?: ModelOption['model']) {
    if (!m) return null;
    const caps: { t: string; title: string }[] = [];
    if (m.supportsTools) caps.push({ t: 'T', title: 'tools' });
    if (m.supportsVision) caps.push({ t: 'V', title: 'vision' });
    if (m.supportsReasoning) caps.push({ t: 'R', title: 'reasoning' });
    if (!caps.length) return null;
    return el('span', { class: 'tm-caps' }, ...caps.map((c) => el('i', { title: c.title }, c.t)));
  }

  function statusTag(v: string, off: boolean) {
    if (deprecated.has(v)) {
      return el('span', { class: 'tm-tag tm-tag-deprecated', title: 'The provider returned “not found” for this model — it looks deprecated or removed. Auto skips it.' }, 'unavailable');
    }
    if (slow.has(v)) {
      return el('span', { class: 'tm-tag tm-tag-slow', title: 'A recent response took 8s or longer. Auto deprioritizes this model for 30 minutes — you can still select it directly.' }, 'slow');
    }
    if (off) {
      return el('span', { class: 'tm-tag tm-tag-off', title: 'Not in your enabled chain — Auto will not pick it, but pinning routes to it directly. Enable it in Settings to include it in Auto.' }, 'off');
    }
    return null;
  }

  function modelRow(opt: ModelOption, off: boolean) {
    const row = el(
      'div',
      {
        class: 'tm-model-item' + (opt.value === value ? ' selected' : '')
          + (deprecated.has(opt.value) ? ' deprecated' : '') + (slow.has(opt.value) ? ' slow' : '') + (off ? ' off' : ''),
        role: 'button', tabindex: '0', dataset: { value: opt.value },
        onClick: () => { popover.close(); if (opt.value !== value) { setValue(opt.value, opt.label); init.onChange(opt.value, opt.label); } },
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); popover.close(); if (opt.value !== value) { setValue(opt.value, opt.label); init.onChange(opt.value, opt.label); } }
        },
      },
      el('span', { class: 'tm-model-item-label' }, opt.label),
      statusTag(opt.value, off),
      capChips(opt.model),
      opt.value === value ? icon(ICON.check, 'tm-model-item-check') : null,
    );
    return row;
  }

  function renderList() {
    listEl.innerHTML = '';
    // Auto entry first, then enabled models grouped by provider.
    listEl.append(el(
      'div',
      {
        class: 'tm-model-item tm-model-auto' + (value === 'auto' ? ' selected' : ''),
        role: 'button', tabindex: '0',
        onClick: () => { popover.close(); if (value !== 'auto') { setValue('auto'); init.onChange('auto', 'Auto'); } },
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); popover.close(); if (value !== 'auto') { setValue('auto'); init.onChange('auto', 'Auto'); } }
        },
      },
      icon(ICON.sparkle, 'tm-model-auto-icon'),
      el(
        'span',
        { class: 'tm-model-item-body' },
        el('span', { class: 'tm-model-item-name' }, 'Auto'),
        el('span', { class: 'tm-model-item-desc' }, 'Smart routing — picks the best enabled model per request'),
      ),
      value === 'auto' ? icon(ICON.check, 'tm-model-item-check') : null,
    ));
    let lastGroup: string | null = null;
    options.forEach((opt) => {
      if (opt.group !== lastGroup) {
        lastGroup = opt.group;
        listEl.append(el('div', { class: 'tm-model-group' }, opt.group));
      }
      listEl.append(modelRow(opt, false));
    });
  }

  // Search filter: hide non-matching rows; while searching, group headers are hidden
  // entirely (matching rows from different providers interleave).
  function filter() {
    const q = searchEl.value.trim().toLowerCase();
    listEl.querySelectorAll<HTMLElement>('.tm-model-item').forEach((it) => {
      it.style.display = !q || (it.textContent || '').toLowerCase().includes(q) ? '' : 'none';
    });
    listEl.querySelectorAll<HTMLElement>('.tm-model-group').forEach((h) => {
      h.style.display = q ? 'none' : '';
    });
  }

  const popover = createPopover({
    trigger,
    content: el(
      'div',
      { class: 'tm-model-pop' },
      searchEl,
      el('div', { class: 'tm-reasoning' },
        el('span', { class: 'tm-reasoning-label' }, 'Reasoning'),
        segEl,
        noteEl,
      ),
      listEl,
    ),
    onOpen: () => {
      searchEl.value = '';
      renderList();
      filter();
      searchEl.focus();
    },
  });
  searchEl.addEventListener('input', filter);
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') popover.close();
  });

  function setValue(next: string, nextLabel?: string) {
    value = next;
    // An explicit pick ends any serving indicator (old behavior — the trigger returns
    // to the user's selection immediately).
    serving = null;
    preServingLabel = '';
    label = nextLabel || displayLabel(next, options);
    renderTrigger();
    // Always re-render the list (not just while open) so the selected marks + check
    // glyphs never go stale for the next time the popover opens.
    renderList();
  }

  renderTrigger();
  renderReasoning();

  return {
    el: popover.el,
    setValue,
    setOptions(opts: ModelPickerSetOptions) {
      options = opts.options || [];
      deprecated = new Set(opts.deprecated || []);
      slow = new Set(opts.slow || []);
      renderList();
    },
    setServing(l: string | null) {
      if (l) {
        if (!serving) preServingLabel = label;
        serving = l;
      } else {
        if (!serving) return;
        serving = null;
        if (preServingLabel) label = preServingLabel;
        preServingLabel = '';
      }
      renderTrigger();
    },
    setReasoning(effort: string, disabled?: boolean) {
      reasoning = effort;
      reasoningDisabled = !!disabled;
      renderReasoning();
    },
    close: () => popover.close(),
  };
}
