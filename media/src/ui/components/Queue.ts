// AI Elements-inspired Queue/Task Component
// 
// Task queue management with pending/completed sections
// Following AI Elements Queue component design patterns adapted for vanilla TypeScript

import { el, appendChildren, type ElChild } from '../dom';

// ========== Types ==========

export interface QueueTask {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  startTime?: number;
  endTime?: number;
  progress?: number;
  meta?: string;
}

export interface QueueSection {
  id: string;
  title: string;
  status: 'pending' | 'completed';
  tasks: QueueTask[];
}

export interface QueueData {
  id: string;
  sections: QueueSection[];
  totalTasks: number;
  completedTasks: number;
  runningTasks: number;
}

export interface QueueOptions {
  className?: string;
  data: QueueData;
  onTaskClick?: (taskId: string) => void;
  onRetry?: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
  onClearCompleted?: () => void;
}

// ========== Helper Functions ==========

function formatDuration(startTime: number, endTime?: number): string {
  const end = endTime || Date.now();
  const duration = Math.round((end - startTime) / 1000);
  
  if (duration < 60) return `${duration}s`;
  const minutes = Math.floor(duration / 60);
  const seconds = duration % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function getStatusIcon(status: QueueTask['status']): string {
  switch (status) {
    case 'pending': return '○';
    case 'running': return '↻';
    case 'completed': return '✓';
    case 'error': return '✗';
    default: return '?';
  }
}

function getStatusClass(status: QueueTask['status']): string {
  return `status-${status}`;
}

// ========== Component Builders ==========

function createTaskStatusIndicator(task: QueueTask): HTMLElement {
  return el('div', { 
    class: `tm-queue-task-status ${getStatusClass(task)}`
  }, getStatusIcon(task.status));
}

function createTaskProgress(task: QueueTask): HTMLElement | null {
  if (task.status !== 'running' || task.progress === undefined) return null;
  
  return el('div', { class: 'tm-queue-task-progress' },
    el('div', { class: 'tm-queue-task-progress-bar' },
      el('div', { 
        class: 'tm-queue-task-progress-fill',
        style: `transform: rotate(${task.progress * 3.6}deg)`
      })
    )
  );
}

function createTaskActions(task: QueueTask, onRetry?: (taskId: string) => void, onCancel?: (taskId: string) => void): HTMLElement {
  const actions = el('div', { class: 'tm-queue-task-actions' });
  
  if (task.status === 'error' && onRetry) {
    actions.appendChild(el('button', { 
      class: 'tm-queue-task-btn',
      title: 'Retry',
      onClick: () => onRetry(task.id)
    }, '↻'));
  }
  
  if (task.status === 'running' && onCancel) {
    actions.appendChild(el('button', { 
      class: 'tm-queue-task-btn',
      title: 'Cancel',
      onClick: () => onCancel(task.id)
    }, '✕'));
  }
  
  return actions;
}

function createTaskMeta(task: QueueTask): HTMLElement | null {
  const meta: string[] = [];
  
  if (task.startTime) {
    meta.push(formatDuration(task.startTime, task.endTime));
  }
  
  if (task.meta) {
    meta.push(task.meta);
  }
  
  if (meta.length === 0) return null;
  
  return el('div', { class: 'tm-queue-task-meta' },
    ...meta.map(m => el('span', { class: 'tm-queue-task-time' }, m))
  );
}

function createTaskItem(task: QueueTask, onClick?: (taskId: string) => void, onRetry?: (taskId: string) => void, onCancel?: (taskId: string) => void): HTMLElement {
  const taskItem = el('div', { 
    class: `tm-queue-task ${getStatusClass(task.status)}`,
    dataset: { id: task.id }
  });
  
  if (onClick) {
    taskItem.style.cursor = 'pointer';
    taskItem.addEventListener('click', () => onClick(task.id));
  }
  
  appendChildren(taskItem, [
    createTaskStatusIndicator(task),
    createTaskProgress(task),
    el('div', { class: 'tm-queue-task-content' },
      el('div', { class: 'tm-queue-task-title' }, task.title),
      createTaskMeta(task)
    ),
    createTaskActions(task, onRetry, onCancel)
  ]);
  
  return taskItem;
}

function createTaskList(tasks: QueueTask[], onClick?: (taskId: string) => void, onRetry?: (taskId: string) => void, onCancel?: (taskId: string) => void): HTMLElement {
  const taskList = el('div', { class: 'tm-queue-tasks' });
  
  if (tasks.length === 0) {
    taskList.appendChild(el('div', { class: 'tm-queue-empty' },
      el('div', { class: 'tm-queue-empty-icon' }, '📋'),
      'No tasks in this section'
    ));
    return taskList;
  }
  
  tasks.forEach(task => {
    taskList.appendChild(createTaskItem(task, onClick, onRetry, onCancel));
  });
  
  return taskList;
}

function createSectionHeader(section: QueueSection): HTMLElement {
  const icon = section.status === 'completed' ? '✓' : '○';
  
  return el('div', { 
    class: `tm-queue-section-header ${section.status}`
  },
    el('span', { class: 'tm-queue-section-header-icon' }, icon),
    section.title,
    el('span', { class: 'tm-queue-count' }, String(section.tasks.length))
  );
}

function createQueueSection(section: QueueSection, onClick?: (taskId: string) => void, onRetry?: (taskId: string) => void, onCancel?: (taskId: string) => void): HTMLElement {
  return el('div', { 
    class: 'tm-queue-section',
    dataset: { id: section.id }
  },
    createSectionHeader(section),
    createTaskList(section.tasks, onClick, onRetry, onCancel)
  );
}

function createQueueActions(onClearCompleted?: () => void): HTMLElement {
  const actions = el('div', { class: 'tm-queue-actions' });
  
  if (onClearCompleted) {
    actions.appendChild(el('button', { 
      class: 'tm-plan-btn',
      onClick: onClearCompleted
    }, '🗹 Clear Completed'));
  }
  
  return actions;
}

// ========== Main Component ==========

export function createQueue(opts: QueueOptions): HTMLElement {
  const { className, data, onTaskClick, onRetry, onCancel, onClearCompleted } = opts;
  
  const queue = el('div', { 
    class: `tm-queue ${className || ''}`,
    dataset: { id: data.id }
  });
  
  // Queue Header
  const header = el('div', { class: 'tm-queue-header' },
    el('div', { class: 'tm-queue-title' },
      el('span', { class: 'tm-queue-header-icon' }, '📋'),
      'Task Queue',
      el('span', { class: 'tm-queue-count' }, String(data.totalTasks))
    ),
    createQueueActions(onClearCompleted)
  );
  queue.appendChild(header);
  
  // Queue Sections
  data.sections.forEach(section => {
    queue.appendChild(createQueueSection(section, onTaskClick, onRetry, onCancel));
  });
  
  return queue;
}

// ========== Utility Functions ==========

export function createQueueFromTasks(tasks: QueueTask[]): QueueData {
  const pendingTasks = tasks.filter(t => t.status === 'pending' || t.status === 'running');
  const completedTasks = tasks.filter(t => t.status === 'completed' || t.status === 'error');
  
  const sections: QueueSection[] = [];
  
  if (pendingTasks.length > 0) {
    sections.push({
      id: 'pending',
      title: 'In Progress',
      status: 'pending',
      tasks: pendingTasks
    });
  }
  
  if (completedTasks.length > 0) {
    sections.push({
      id: 'completed',
      title: 'Completed',
      status: 'completed',
      tasks: completedTasks
    });
  }
  
  return {
    id: `queue-${Date.now()}`,
    sections,
    totalTasks: tasks.length,
    completedTasks: completedTasks.length,
    runningTasks: tasks.filter(t => t.status === 'running').length
  };
}

export function updateQueueTask(data: QueueData, taskId: string, updates: Partial<QueueTask>): QueueData {
  const updatedSections = data.sections.map(section => ({
    ...section,
    tasks: section.tasks.map(task => 
      task.id === taskId ? { ...task, ...updates } : task
    )
  }));
  
  return createQueueDataFromSections(updatedSections);
}

export function createQueueDataFromSections(sections: QueueSection[]): QueueData {
  const allTasks = sections.flatMap(s => s.tasks);
  
  return {
    id: `queue-${Date.now()}`,
    sections,
    totalTasks: allTasks.length,
    completedTasks: allTasks.filter(t => t.status === 'completed' || t.status === 'error').length,
    runningTasks: allTasks.filter(t => t.status === 'running').length
  };
}

export function addQueueTask(data: QueueData, task: QueueTask): QueueData {
  const updatedSections = data.sections.map(section => {
    if (section.id === 'pending') {
      return {
        ...section,
        tasks: [...section.tasks, task]
      };
    }
    return section;
  });
  
  return createQueueDataFromSections(updatedSections);
}