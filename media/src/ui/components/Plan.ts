// AI Elements-inspired Plan Component
// 
// Collapsible plan sections with task management
// Following AI Elements Plan component design patterns adapted for vanilla TypeScript

import { el, appendChildren, type ElChild } from '../dom';
import { createCollapse } from '../primitives/Collapse';

// ========== Types ==========

export interface PlanTask {
  id: string;
  title: string;
  completed: boolean;
  pending?: boolean;
  error?: boolean;
  running?: boolean;
}

export interface PlanSection {
  id: string;
  title: string;
  tasks: PlanTask[];
}

export interface PlanData {
  id: string;
  title: string;
  sections: PlanSection[];
  createdAt: number;
  completedTasks: number;
  totalTasks: number;
}

export interface PlanOptions {
  className?: string;
  data: PlanData;
  onTaskToggle?: (taskId: string) => void;
  onSectionToggle?: (sectionId: string) => void;
  onSave?: () => void;
  onExport?: () => void;
}

// ========== Helper Functions ==========

function calculateProgress(tasks: PlanTask[]): number {
  if (tasks.length === 0) return 0;
  const completed = tasks.filter(t => t.completed).length;
  return Math.round((completed / tasks.length) * 100);
}

function getStatusIcon(task: PlanTask): string {
  if (task.error) return '✗';
  if (task.completed) return '✓';
  if (task.running) return '↻';
  return '○';
}

function getStatusClass(task: PlanTask): string {
  if (task.error) return 'error';
  if (task.completed) return 'completed';
  if (task.pending) return 'pending';
  if (task.running) return 'running';
  return '';
}

// ========== Component Builders ==========

function createTaskCheckbox(task: PlanTask, onToggle?: (taskId: string) => void): HTMLElement {
  const checkbox = el('div', { 
    class: `tm-plan-task-checkbox ${task.completed ? 'checked' : ''} ${getStatusClass(task)}`
  });
  
  if (onToggle && !task.running) {
    checkbox.style.cursor = 'pointer';
    checkbox.addEventListener('click', () => onToggle(task.id));
  }
  
  return checkbox;
}

function createTaskContent(task: PlanTask): HTMLElement {
  return el('div', { 
    class: `tm-plan-task-content ${getStatusClass(task)}`
  }, task.title);
}

function createTaskItem(task: PlanTask, onToggle?: (taskId: string) => void): HTMLElement {
  return el('div', { 
    class: `tm-plan-task ${getStatusClass(task)}`
  },
    createTaskCheckbox(task, onToggle),
    createTaskContent(task)
  );
}

function createTaskList(tasks: PlanTask[], onToggle?: (taskId: string) => void): HTMLElement {
  const taskList = el('div', { class: 'tm-plan-tasks' });
  tasks.forEach(task => {
    taskList.appendChild(createTaskItem(task, onToggle));
  });
  return taskList;
}

function createSectionHeader(section: PlanSection, onToggle?: (sectionId: string) => void): HTMLElement {
  const completed = section.tasks.filter(t => t.completed).length;
  const total = section.tasks.length;
  
  return el('div', { 
    class: 'tm-plan-section-header',
    onClick: onToggle ? () => onToggle(section.id) : undefined
  },
    el('span', { class: 'tm-plan-section-title' }, section.title),
    el('span', { class: 'tm-plan-section-count' }, `${completed}/${total}`)
  );
}

function createPlanSection(section: PlanSection, onToggle?: (sectionId: string) => void, onTaskToggle?: (taskId: string) => void): HTMLElement {
  return el('div', { 
    class: 'tm-plan-section',
    dataset: { id: section.id }
  },
    createSectionHeader(section, onToggle),
    createTaskList(section.tasks, onTaskToggle)
  );
}

function createProgressBar(progress: number): HTMLElement {
  return el('div', { class: 'tm-plan-progress' },
    el('div', { 
      class: 'tm-plan-progress-bar',
      style: `width: ${progress}%`
    })
  );
}

function createPlanStats(data: PlanData): HTMLElement {
  return el('div', { class: 'tm-plan-stats' },
    el('div', { class: 'tm-plan-stat' },
      el('span', { class: 'tm-plan-stat-value' }, String(data.completedTasks)),
      ' completed'
    ),
    el('div', { class: 'tm-plan-stat' },
      el('span', { class: 'tm-plan-stat-value' }, String(data.totalTasks)),
      ' total'
    )
  );
}

function createPlanActions(onSave?: () => void, onExport?: () => void): HTMLElement {
  const actions = el('div', { class: 'tm-plan-actions' });
  
  if (onExport) {
    actions.appendChild(el('button', { 
      class: 'tm-plan-btn',
      onClick: onExport
    }, '📋 Export'));
  }
  
  if (onSave) {
    actions.appendChild(el('button', { 
      class: 'tm-plan-btn primary',
      onClick: onSave
    }, '💾 Save'));
  }
  
  return actions;
}

// ========== Main Component ==========

export function createPlan(opts: PlanOptions): HTMLElement {
  const { className, data, onTaskToggle, onSectionToggle, onSave, onExport } = opts;
  
  // Calculate overall progress
  const overallProgress = data.totalTasks > 0 
    ? Math.round((data.completedTasks / data.totalTasks) * 100) 
    : 0;
  
  const plan = el('details', { 
    class: `tm-plan ${className || ''}`,
    open: true
  });
  
  // Plan Header
  const header = el('summary', { class: 'tm-plan-header' },
    el('div', { class: 'tm-plan-title' },
      el('span', { class: 'tm-plan-title-icon' }, '▶'),
      data.title
    ),
    createPlanStats(data)
  );
  plan.appendChild(header);
  
  // Plan Content Container
  const content = el('div', { class: 'tm-plan-sections' });
  
  // Progress Bar
  content.appendChild(createProgressBar(overallProgress));
  
  // Plan Sections
  data.sections.forEach(section => {
    content.appendChild(createPlanSection(section, onSectionToggle, onTaskToggle));
  });
  
  // Plan Actions
  content.appendChild(createPlanActions(onSave, onExport));
  
  plan.appendChild(content);
  
  return plan;
}

// ========== Utility Functions ==========

export function createPlanFromTasks(title: string, tasks: PlanTask[]): PlanData {
  const sections: PlanSection[] = [
    {
      id: 'default',
      title: 'Tasks',
      tasks
    }
  ];
  
  return {
    id: `plan-${Date.now()}`,
    title,
    sections,
    createdAt: Date.now(),
    completedTasks: tasks.filter(t => t.completed).length,
    totalTasks: tasks.length
  };
}

export function updatePlanProgress(data: PlanData): PlanData {
  const totalTasks = data.sections.reduce((sum, section) => sum + section.tasks.length, 0);
  const completedTasks = data.sections.reduce(
    (sum, section) => sum + section.tasks.filter(t => t.completed).length, 
    0
  );
  
  return {
    ...data,
    completedTasks,
    totalTasks
  };
}

export function togglePlanTask(data: PlanData, taskId: string): PlanData {
  const updatedSections = data.sections.map(section => ({
    ...section,
    tasks: section.tasks.map(task => 
      task.id === taskId ? { ...task, completed: !task.completed } : task
    )
  }));
  
  return updatePlanProgress({ ...data, sections: updatedSections });
}