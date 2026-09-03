// Agent type picker — the composer's primary control ("how the assistant handles my
// message"). A per-mode tinted trigger pill opening a popover of rich agent cards:
// icon tile, name, full description, capability chips (read-only / edits after
// approval / full access), and a check on the selected mode.
//
// The mode DATA (values, labels, descriptions) stays owned by main.ts (it also drives
// placeholders and the sendMessage payload); this component only renders + reports
// selection changes.

import { el, icon } from '../dom';
import { ICON } from '../../icons';
import { createPopover } from '../primitives/Popover';

export interface AgentModeDef {
  value: string;
  label: string;
  /** Raw SVG markup (icons.ts) shown in the trigger and on the option card. */
  icon: string;
  desc: string;
  /** Short capability chips under the mode name, e.g. ["read-only"]. */
  caps: string[];
}

export interface AgentPickerOptions {
  modes: AgentModeDef[];
  value: string;
  onChange(value: string): void;
}

export interface AgentPickerHandle {
  el: HTMLElement;
  /** Select a mode — updates the trigger (label, icon, tint, tooltip). */
  setValue(value: string): void;
  /** Visual-only "executing an approved plan" state: the trigger reads "Agent ⚡" and
   *  pulses without touching the user's actual selection (restored on false). */
  setExecuting(on: boolean): void;
}

export function createAgentPicker(opts: AgentPickerOptions): AgentPickerHandle {
  const { modes, onChange } = opts;
  let current = opts.value || (modes[0] && modes[0].value) || '';
  let executing = false;

  const triggerIconEl = icon('', 'tm-agent-trigger-icon');
  const labelEl = el('span', { class: 'tm-agent-label' });
  const trigger = el(
    'button',
    {
      class: 'tm-agent-trigger', type: 'button',
      'aria-label': 'Agent type — how the assistant handles your message',
    },
    triggerIconEl, labelEl, icon(ICON.chevron, 'tm-agent-trigger-chev'),
  );

  const listEl = el('div', { class: 'tm-agent-list' });

  function find(value: string): AgentModeDef {
    return modes.find((m) => m.value === value) || modes[0];
  }

  function renderTrigger() {
    const m = find(current);
    trigger.classList.remove('tm-agent-ask', 'tm-agent-plan', 'tm-agent-agent');
    if (m) trigger.classList.add(`tm-agent-${m.value}`);
    triggerIconEl.innerHTML = m ? m.icon : '';
    labelEl.textContent = '';
    if (executing) {
      labelEl.append('Agent', icon(ICON.zap, 'tm-agent-exec-zap'));
      trigger.title = 'Executing approved plan…';
    } else {
      labelEl.textContent = m ? m.label : '';
      trigger.title = m ? m.desc : '';
    }
    trigger.classList.toggle('executing', executing);
  }

  function renderList() {
    listEl.innerHTML = '';
    modes.forEach((m) => {
      const card = el(
        'div',
        {
          class: 'tm-agent-item' + (m.value === current ? ' selected' : ''),
          role: 'button', tabindex: '0',
          onClick: () => { popover.close(); if (m.value !== current) onChange(m.value); },
          onKeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); popover.close(); if (m.value !== current) onChange(m.value); }
          },
        },
        icon(m.icon, 'tm-agent-item-icon'),
        el(
          'div',
          { class: 'tm-agent-item-body' },
          el(
            'div',
            { class: 'tm-agent-item-head' },
            el('div', { class: 'tm-agent-item-name' }, m.label),
            m.caps && m.caps.length
              ? el('div', { class: 'tm-agent-item-caps' }, ...m.caps.map((c) => el('span', { class: 'tm-cap' }, c)))
              : null,
          ),
          el('div', { class: 'tm-agent-item-desc', title: m.desc }, m.desc),
        ),
        m.value === current ? icon(ICON.check, 'tm-agent-item-check') : null,
      );
      listEl.append(card);
    });
  }

  const popover = createPopover({
    trigger,
    content: el('div', { class: 'tm-agent-pop' }, el('div', { class: 'tm-pop-title' }, 'Agent'), listEl),
    onOpen: renderList,
  });

  renderTrigger();

  return {
    el: popover.el,
    setValue(value: string) {
      current = value;
      renderTrigger();
      // Always re-render so the selected marks never go stale for the next open.
      renderList();
    },
    setExecuting(on: boolean) {
      executing = on;
      renderTrigger();
    },
  };
}
