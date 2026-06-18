// Neutral tool schemas (OpenAI function-calling shape). The Gemini adapter
// translates these to functionDeclarations.
import type { ChatToolDefinition } from '../shared/types';

/** Added to the tool set only when the codebase embeddings index is enabled + built. */
export const CODEBASE_SEARCH_SPEC: ChatToolDefinition = {
  type: 'function',
  function: {
    name: 'codebaseSearch',
    description: 'Semantic search over the indexed codebase. Returns the most relevant code chunks for a natural-language query (use this to find code by meaning, not just keywords).',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Natural-language description of what you are looking for.' } },
      required: ['query'],
    },
  },
};

export const TOOL_SPECS: ChatToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'updateTodos',
      description: 'Maintain a visible task checklist for multi-step work. Call it with the FULL list each time: set a task to "in_progress" before you start it and "completed" when done, keeping exactly one task in_progress. Skip it for trivial one-step tasks. This only updates the UI checklist — it changes no files.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The complete ordered task list.',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Short imperative task description.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current status.' },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'readFile',
      description: 'Read a UTF-8 text file from the workspace. Returns its contents (truncated if very large).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative path.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listDir',
      description: 'List the entries (files and folders) of a workspace directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative directory path. Use "." for the root.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repoMap',
      description: 'Get a cheap high-level overview of the workspace (directory structure, file counts, and key files) to orient yourself before searching.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchWorkspace',
      description: 'Search the workspace for files and text. Returns matching file paths and line snippets.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Text or glob to search for.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getDiagnostics',
      description: 'Get current diagnostics (errors/warnings) for a file, or the whole workspace if path is omitted.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Optional workspace-relative file path.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'runCommand',
      description: 'Run a shell command in the workspace root (tests, build, lint, git, etc.) and get back its exit code, stdout, and stderr. Use this to verify your changes and self-correct — e.g. run the test suite after an edit and fix failures. The user may be prompted to approve the command.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run, e.g. "npm test".' },
          cwd: { type: 'string', description: 'Optional workspace-relative working directory (defaults to the workspace root).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'writeFile',
      description: 'Create or overwrite a file with the given content. Shown to the user as a diff for approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path.' },
          content: { type: 'string', description: 'Full new file content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'createFile',
      description: 'Create a new file with content. Fails if it already exists. Shown as a diff for approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path.' },
          content: { type: 'string', description: 'File content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editFile',
      description: 'Replace the first occurrence of an exact search string with a replacement in a file. Shown as a diff for approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path.' },
          search: { type: 'string', description: 'Exact text to find (must be unique enough).' },
          replace: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'search', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deleteFile',
      description: 'Delete a workspace file. Shown to the user for approval.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative path.' } },
        required: ['path'],
      },
    },
  },
];
