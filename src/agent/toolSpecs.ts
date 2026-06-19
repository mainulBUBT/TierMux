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

// ---- Responsible-tool additions (verify/look up instead of guess; ask instead of assume) ----
// These are conditionally included by the agent (see agent.ts runAgent): glob/grep/skill/askUser
// whenever tools are offered; web tools only when `tiermux.tools.web` is on. None are sent in
// chat/trivial (no tools there), keeping the base request lean.

/** Find files by glob pattern (names/paths), distinct from content search. */
export const GLOB_SPEC: ChatToolDefinition = {
  type: 'function',
  function: {
    name: 'glob',
    description: 'Find workspace files by glob pattern (e.g. "src/**/*.ts", "**/*.css"). Returns matching paths. Use this to locate files by name; use grep for content.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/agent.ts" or "**/*.{js,ts}".' },
        path: { type: 'string', description: 'Optional workspace-relative folder to search within (defaults to the whole workspace).' },
      },
      required: ['pattern'],
    },
  },
};

/** Search file contents by pattern/regex — find where symbols/strings live before editing. */
export const GREP_SPEC: ChatToolDefinition = {
  type: 'function',
  function: {
    name: 'grep',
    description: 'Search workspace file contents for a pattern (substring or regex). Returns matching files with line numbers and snippets. Use this to find where code lives before editing it.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or JavaScript regex to search for.' },
        path: { type: 'string', description: 'Optional workspace-relative folder/glob to limit the search.' },
        regex: { type: 'boolean', description: 'Treat `pattern` as a regex (default: plain text).' },
      },
      required: ['pattern'],
    },
  },
};

/** Ask the user a clarifying question instead of guessing. Use sparingly — only when the goal is genuinely ambiguous. */
export const ASK_USER_SPEC: ChatToolDefinition = {
  type: 'function',
  function: {
    name: 'askUser',
    description: 'Ask the user one short clarifying question and wait for their answer. Use ONLY when you cannot reasonably infer how to proceed — not for things you can verify yourself with a search.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One concise question.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional 2-4 short answer choices. Omit for a free-text answer.',
        },
      },
      required: ['question'],
    },
  },
};

/** Load a named skill (a reusable workflow/instruction set) by name. */
export const SKILL_SPEC: ChatToolDefinition = {
  type: 'function',
  function: {
    name: 'skill',
    description: 'Load a named skill — a reusable set of instructions/workflow stored in .tiermux/skills/<name>.md. Returns the skill\'s instructions to follow. Use a skill when one applies to the current task.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name (matches a .tiermux/skills/<name>.md file).' } },
      required: ['name'],
    },
  },
};

export const GRAPH_TOOLS_SPEC: ChatToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'buildGraph',
      description: 'Build or refresh the structural code graph (imports, exports, call edges, entrypoints). Use before getSymbolGraph or impactAnalysis if the graph is stale or absent.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getSymbolGraph',
      description: 'Show who imports/exports and who calls/is called by a file. Returns the dependency neighborhood of one file.',
      parameters: {
        type: 'object',
        properties: { file: { type: 'string', description: 'Workspace-relative file path, e.g. "src/agent/agent.ts".' } },
        required: ['file'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'impactAnalysis',
      description: 'Show which files are transitively affected by changes to the given files (import/call graph traversal).',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Workspace-relative paths of changed files.',
          },
        },
        required: ['files'],
      },
    },
  },
];

/** Web tools (only included when the user enables `tiermux.tools.web`) — look things up instead of fabricating. */
export const WEB_TOOL_SPECS: ChatToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'webFetch',
      description: 'Fetch a URL and return its text (HTML stripped, truncated). Use this to read a doc page, changelog, or API reference instead of guessing its contents.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The absolute URL to fetch.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'webSearch',
      description: 'Search the web and return a few results (title, URL, snippet). Use this when you need information outside the workspace rather than guessing.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query'],
      },
    },
  },
];
