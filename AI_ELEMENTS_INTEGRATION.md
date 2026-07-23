# AI Elements Design Integration

This directory contains AI Elements-inspired components and design tokens adapted for the TierMux VSCode extension. Following AI Elements design patterns while maintaining compatibility with VSCode's theming system.

## Architecture

```
media/
├── styles/
│   ├── tokens.css                          # Base VSCode theme tokens
│   ├── ai-elements-tokens.css              # AI Elements-specific tokens
│   └── components/
│       ├── plan.css                        # Plan component styles
│       ├── queue.css                       # Queue component styles
│       ├── checkpoint.css                  # Checkpoint component styles
│       └── tool-card.css                   # Enhanced tool card styles
└── src/
    └── ui/
        ├── dom.ts                          # DOM building primitives
        ├── components/
        │   ├── Plan.ts                     # Plan component
        │   ├── Queue.ts                    # Queue component
        │   ├── Checkpoint.ts               # Checkpoint component
        │   └── index.ts                    # Component exports
        └── primitives/
            ├── Collapse.ts                 # Collapsible sections
            └── ...                          # Other UI primitives

```

## Design System

### Token Hierarchy

1. **VSCode Base Tokens** (`styles/tokens.css`)
   - Core theme integration with VSCode variables
   - Surface, text, border, accent colors

2. **AI Elements Tokens** (`styles/ai-elements-tokens.css`)
   - Status colors (running, done, error, pending)
   - Component surfaces and shadows
   - Spacing, typography, radius systems
   - Transitions and animations

### Component Status Colors

```css
--tm-status-running: #3b82f6    /* Blue for active operations */
--tm-status-done: #10b981       /* Green for success */
--tm-status-error: #ef4444      /* Red for failures */
--tm-status-pending: #f59e0b    /* Orange for waiting */
--tm-status-cancelled: #6b7280  /* Gray for cancelled */
```

## Components

### Plan Component

**Purpose**: Display implementation strategies with task management

**Features**:
- Collapsible plan sections
- Task completion tracking
- Progress visualization
- Export/Save functionality

**Usage**:
```typescript
import { createPlan, createPlanFromTasks } from './ui/components';

const planData = createPlanFromTasks('Implementation Plan', [
  { id: '1', title: 'Set up project structure', completed: true },
  { id: '2', title: 'Configure dependencies', completed: false },
  { id: '3', title: 'Implement core features', completed: false }
]);

const planElement = createPlan({
  data: planData,
  onTaskToggle: (taskId) => console.log('Toggled:', taskId),
  onSave: () => console.log('Plan saved')
});
```

### Queue Component

**Purpose**: Manage task queues with pending/completed sections

**Features**:
- Real-time task status updates
- Pending and completed sections
- Task retry and cancellation
- Progress indicators

**Usage**:
```typescript
import { createQueue, createQueueFromTasks } from './ui/components';

const queueData = createQueueFromTasks([
  { id: '1', title: 'Search workspace', status: 'running' },
  { id: '2', title: 'Read files', status: 'pending' },
  { id: '3', title: 'Analyze results', status: 'completed' }
]);

const queueElement = createQueue({
  data: queueData,
  onTaskClick: (taskId) => console.log('Task clicked:', taskId),
  onRetry: (taskId) => console.log('Retry task:', taskId)
});
```

### Checkpoint Component

**Purpose**: Conversation state management with save/restore

**Features**:
- Create named checkpoints
- Restore conversation state
- Export/import functionality
- Checkpoint history

**Usage**:
```typescript
import { createCheckpoint, createCheckpointModal } from './ui/components';

const checkpointElement = createCheckpoint({
  checkpoints: [
    { id: '1', name: 'Working state', timestamp: Date.now(), state: {...} }
  ],
  onSave: () => {
    // Show modal to create new checkpoint
  },
  onRestore: (checkpointId) => {
    // Restore conversation state
  }
});
```

### Enhanced Tool Cards

**Purpose**: Improved tool call visualization with AI Elements patterns

**Features**:
- Status indicators with animations
- Progress bars for running tasks
- Enhanced diff view
- Action buttons (retry, cancel)
- Validation status badges

**Styles**: Located in `styles/components/tool-card.css`

## Design Patterns

### Consistent Spacing System

```css
--tm-gap-xs: 2px
--tm-gap-sm: 4px
--tm-gap-md: 8px
--tm-gap-lg: 12px
--tm-gap-xl: 16px
--tm-gap-2xl: 20px
--tm-gap-3xl: 24px
```

### Typography Scale

```css
--tm-text-xs: 11px
--tm-text-sm: 12px
--tm-text-base: 13px
--tm-text-lg: 14px
--tm-text-xl: 16px
--tm-text-2xl: 18px
```

### Border Radius System

```css
--tm-radius-sm: 4px
--tm-radius-md: 6px
--tm-radius-lg: 8px
--tm-radius-xl: 10px
--tm-radius-full: 999px
```

### Transitions

```css
--tm-transition-fast: 150ms ease
--tm-transition-base: 200ms ease
--tm-transition-slow: 300ms ease
```

## Integration with Existing Code

### CSS Loading

All AI Elements styles are automatically loaded in `src/chatViewProvider.ts`:

```typescript
<link href="${uri('styles/ai-elements-tokens.css')}" rel="stylesheet" nonce="${nonce}" />
<link href="${uri('styles/components/plan.css')}" rel="stylesheet" nonce="${nonce}" />
<link href="${uri('styles/components/queue.css')}" rel="stylesheet" nonce="${nonce}" />
<link href="${uri('styles/components/checkpoint.css')}" rel="stylesheet" nonce="${nonce}" />
<link href="${uri('styles/components/tool-card.css')}" rel="stylesheet" nonce="${nonce}" />
```

### Component Usage in Webview

Components can be imported and used in `media/src/main.ts`:

```typescript
import { createPlan, createQueue, createCheckpoint } from './ui/components';

// Use components in message rendering
function renderPlan(planData: PlanData) {
  const plan = createPlan({
    data: planData,
    onTaskToggle: handleTaskToggle
  });
  return plan;
}
```

## Customization Guidelines

### Theming

All components use VSCode theme variables via CSS custom properties. To customize:

1. Modify `styles/tokens.css` for base theme changes
2. Override specific component tokens in `styles/ai-elements-tokens.css`
3. Add component-specific overrides in respective component CSS files

### Component Styling

Each component follows consistent patterns:
- BEM-like naming: `.tm-component-name`, `.tm-component-name-element`, `.tm-component-name--modifier`
- State classes: `.running`, `.done`, `.error`, `.pending`
- Responsive design with mobile breakpoints

## Best Practices

1. **Token Usage**: Always use design tokens instead of hardcoded values
2. **Component Composition**: Build complex UIs by combining simple components
3. **State Management**: Use component callbacks for state changes
4. **Accessibility**: Maintain keyboard navigation and screen reader support
5. **Performance**: Use CSS transitions and animations efficiently

## Future Enhancements

Planned components following AI Elements patterns:
- [ ] Code Block component with AI Elements features
- [ ] Enhanced streaming message components
- [ ] Context/Source citation components
- [ ] Attachment/file handling components
- [ ] Model selector component

## Credits

Design patterns inspired by [AI Elements](https://elements.ai-sdk.dev/) - a component library for AI-native applications, adapted for VSCode extension architecture.

## Contributing

When adding new components:
1. Create component TypeScript file in `media/src/ui/components/`
2. Create corresponding CSS file in `media/styles/components/`
3. Add exports to `media/src/ui/components/index.ts`
4. Update CSS imports in `src/chatViewProvider.ts`
5. Follow existing patterns and naming conventions
6. Use design tokens consistently