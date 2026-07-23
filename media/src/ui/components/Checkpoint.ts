// AI Elements-inspired Checkpoint Component
// 
// Conversation state management with save/restore functionality
// Following AI Elements Checkpoint component design patterns adapted for vanilla TypeScript

import { el, appendChildren, type ElChild } from '../dom';

// ========== Types ==========

export interface Checkpoint {
  id: string;
  name: string;
  description?: string;
  timestamp: number;
  state: unknown; // Serialized conversation state
}

export interface CheckpointOptions {
  className?: string;
  checkpoints: Checkpoint[];
  activeCheckpointId?: string;
  onSave?: (name: string, description?: string) => void;
  onRestore?: (checkpointId: string) => void;
  onDelete?: (checkpointId: string) => void;
  onRename?: (checkpointId: string, newName: string) => void;
}

// ========== Helper Functions ==========

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  
  return date.toLocaleDateString();
}

function truncateText(text: string, maxLength: number = 50): string {
  return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
}

// ========== Component Builders ==========

function createCheckpointItem(checkpoint: Checkpoint, isActive: boolean, onRestore?: (checkpointId: string) => void, onDelete?: (checkpointId: string) => void): HTMLElement {
  const item = el('div', { 
    class: `tm-checkpoint-item ${isActive ? 'active' : ''}`,
    dataset: { id: checkpoint.id }
  });
  
  if (onRestore) {
    item.addEventListener('click', () => onRestore(checkpoint.id));
  }
  
  const content = el('div', { class: 'tm-checkpoint-item-content' },
    el('div', { class: 'tm-checkpoint-item-name' }, checkpoint.name),
    el('div', { class: 'tm-checkpoint-item-time' }, formatTimestamp(checkpoint.timestamp))
  );
  
  appendChildren(item, [content]);
  
  if (onDelete) {
    const actions = el('div', { class: 'tm-checkpoint-item-actions' },
      el('button', { 
        class: 'tm-checkpoint-history-btn delete',
        title: 'Delete',
        onClick: (e: Event) => {
          e.stopPropagation();
          onDelete(checkpoint.id);
        }
      }, '✕')
    );
    item.appendChild(actions);
  }
  
  return item;
}

function createCheckpointList(checkpoints: Checkpoint[], activeId: string | undefined, onRestore?: (checkpointId: string) => void, onDelete?: (checkpointId: string) => void): HTMLElement {
  const list = el('div', { class: 'tm-checkpoint-list' });
  
  if (checkpoints.length === 0) {
    list.appendChild(el('div', { class: 'tm-checkpoint-empty' },
      el('div', { class: 'tm-checkpoint-empty-icon' }, '💾'),
      'No checkpoints yet'
    ));
    return list;
  }
  
  // Sort by timestamp (newest first)
  const sorted = [...checkpoints].sort((a, b) => b.timestamp - a.timestamp);
  
  sorted.forEach(checkpoint => {
    list.appendChild(createCheckpointItem(checkpoint, checkpoint.id === activeId, onRestore, onDelete));
  });
  
  return list;
}

function createCheckpointHeader(): HTMLElement {
  return el('div', { class: 'tm-checkpoint-header' },
    el('span', { class: 'tm-checkpoint-header-icon' }, '💾'),
    'Checkpoints'
  );
}

function createCheckpointActions(onSave?: () => void): HTMLElement {
  const actions = el('div', { class: 'tm-checkpoint-actions' });
  
  if (onSave) {
    actions.appendChild(el('button', { 
      class: 'tm-checkpoint-btn primary',
      onClick: onSave
    }, '+ New Checkpoint'));
  }
  
  return actions;
}

// ========== Modal Components ==========

export interface CheckpointModalOptions {
  title: string;
  onSubmit: (name: string, description?: string) => void;
  onCancel: () => void;
  initialName?: string;
  initialDescription?: string;
}

export function createCheckpointModal(opts: CheckpointModalOptions): HTMLElement {
  const { title, onSubmit, onCancel, initialName = '', initialDescription = '' } = opts;
  
  const modal = el('div', { class: 'tm-checkpoint-modal' });
  
  // Modal Content
  const content = el('div', { class: 'tm-checkpoint-modal-content' });
  
  // Header
  const header = el('div', { class: 'tm-checkpoint-modal-header' },
    el('div', { class: 'tm-checkpoint-modal-title' }, title),
    el('button', { 
      class: 'tm-checkpoint-modal-close',
      onClick: onCancel
    }, '✕')
  );
  content.appendChild(header);
  
  // Body
  const body = el('div', { class: 'tm-checkpoint-modal-body' });
  
  // Form
  const form = el('div', { class: 'tm-checkpoint-form' });
  
  // Name Input
  const nameGroup = el('div', { class: 'tm-checkpoint-form-group' },
    el('label', { class: 'tm-checkpoint-form-label' }, 'Name'),
    el('input', { 
      class: 'tm-checkpoint-form-input',
      type: 'text',
      placeholder: 'Checkpoint name...',
      value: initialName
    })
  );
  form.appendChild(nameGroup);
  
  // Description Input
  const descGroup = el('div', { class: 'tm-checkpoint-form-group' },
    el('label', { class: 'tm-checkpoint-form-label' }, 'Description (optional)'),
    el('textarea', { 
      class: 'tm-checkpoint-form-input tm-checkpoint-form-textarea',
      placeholder: 'Brief description...',
      value: initialDescription
    })
  );
  form.appendChild(descGroup);
  
  body.appendChild(form);
  content.appendChild(body);
  
  // Footer
  const footer = el('div', { class: 'tm-checkpoint-modal-footer' },
    el('button', { 
      class: 'tm-checkpoint-btn',
      onClick: onCancel
    }, 'Cancel'),
    el('button', { 
      class: 'tm-checkpoint-btn primary',
      onClick: () => {
        const nameInput = nameGroup.querySelector('input') as HTMLInputElement;
        const descInput = descGroup.querySelector('textarea') as HTMLTextAreaElement;
        onSubmit(nameInput.value, descInput.value);
      }
    }, 'Save')
  );
  content.appendChild(footer);
  
  modal.appendChild(content);
  
  return modal;
}

// ========== History Component ==========

export function createCheckpointHistory(
  checkpoints: Checkpoint[],
  activeId: string | undefined,
  onRestore?: (checkpointId: string) => void,
  onDelete?: (checkpointId: string) => void
): HTMLElement {
  const history = el('div', { class: 'tm-checkpoint-history' });
  
  if (checkpoints.length === 0) {
    history.appendChild(el('div', { class: 'tm-checkpoint-empty' },
      el('div', { class: 'tm-checkpoint-empty-icon' }, '📜'),
      'No checkpoint history'
    ));
    return history;
  }
  
  // Sort by timestamp (newest first)
  const sorted = [...checkpoints].sort((a, b) => b.timestamp - a.timestamp);
  
  sorted.forEach(checkpoint => {
    const item = el('div', { 
      class: `tm-checkpoint-history-item ${checkpoint.id === activeId ? 'active' : ''}`,
      dataset: { id: checkpoint.id }
    });
    
    if (onRestore) {
      item.addEventListener('click', () => onRestore(checkpoint.id));
    }
    
    const info = el('div', { class: 'tm-checkpoint-history-info' },
      el('div', { class: 'tm-checkpoint-history-name' }, checkpoint.name),
      el('div', { class: 'tm-checkpoint-history-time' }, 
        formatTimestamp(checkpoint.timestamp)
      )
    );
    
    const actions = el('div', { class: 'tm-checkpoint-history-actions' });
    
    if (onDelete) {
      actions.appendChild(el('button', { 
        class: 'tm-checkpoint-history-btn delete',
        title: 'Delete',
        onClick: (e: Event) => {
          e.stopPropagation();
          onDelete(checkpoint.id);
        }
      }, '🗑'));
    }
    
    appendChildren(item, [info, actions]);
    history.appendChild(item);
  });
  
  return history;
}

// ========== Main Component ==========

export function createCheckpoint(opts: CheckpointOptions): HTMLElement {
  const { className, checkpoints, activeCheckpointId, onSave, onRestore, onDelete } = opts;
  
  const checkpoint = el('div', { 
    class: `tm-checkpoint-bar ${className || ''}`
  });
  
  // Header
  checkpoint.appendChild(createCheckpointHeader());
  
  // Checkpoint List
  checkpoint.appendChild(createCheckpointList(checkpoints, activeCheckpointId, onRestore, onDelete));
  
  // Actions
  checkpoint.appendChild(createCheckpointActions(onSave));
  
  return checkpoint;
}

// ========== Utility Functions ==========

export function createDefaultCheckpoint(state: unknown): Checkpoint {
  return {
    id: `checkpoint-${Date.now()}`,
    name: `Checkpoint ${formatTimestamp(Date.now())}`,
    timestamp: Date.now(),
    state
  };
}

export function serializeCheckpoint(state: unknown): string {
  return JSON.stringify(state, null, 2);
}

export function deserializeCheckpoint(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch (error) {
    console.error('Failed to deserialize checkpoint:', error);
    return null;
  }
}

export function exportCheckpoint(checkpoint: Checkpoint): string {
  const exportData = {
    version: '1.0',
    exportDate: new Date().toISOString(),
    checkpoint: {
      id: checkpoint.id,
      name: checkpoint.name,
      description: checkpoint.description,
      timestamp: checkpoint.timestamp,
      state: checkpoint.state
    }
  };
  
  return JSON.stringify(exportData, null, 2);
}

export function importCheckpoint(data: string): Checkpoint | null {
  try {
    const parsed = JSON.parse(data);
    if (parsed.checkpoint) {
      return {
        id: parsed.checkpoint.id,
        name: parsed.checkpoint.name,
        description: parsed.checkpoint.description,
        timestamp: parsed.checkpoint.timestamp,
        state: parsed.checkpoint.state
      };
    }
    return null;
  } catch (error) {
    console.error('Failed to import checkpoint:', error);
    return null;
  }
}