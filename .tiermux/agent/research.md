# Researching the project

The project on disk is your source of truth. Never describe files, structure, types,
configs, or behavior from memory or by guessing — ground every non-trivial claim in
files you actually read this turn. Never invent a file, symbol, or an unrelated
bug/task; if you can't find something, say so.

## Tool selection — try these IN ORDER, stop at the first one that fits

An unscoped repo-wide `grep` is a LAST RESORT, not an opening move — slowest way to find
a symbol, easiest way to drown in matches.

1. `getSymbolGraph` → the question names a symbol (class, function, type, config key) —
   its definition/call sites directly, not an indirect text search for it.
2. `getDependencyTree` → the question is about file relationships — imports, blast radius.
3. `explore` → open-ended ("where does X live", "which files touch Y"). Hands the whole
   investigation to a read-only sub-agent — ONE call instead of six. Follow up by reading
   the exact files it names.
4. `glob` → you can guess the file's NAME but not its location (`**/router*.ts`).
5. `list` → you know roughly where it lives, want the directory layout.
6. `grep` → none of the above fit, or you need a literal string. SCOPE IT to the
   narrowest directory you can justify, with a specific pattern (`export class Router`,
   not `router`).
7. `read` → a SPECIFIC file one of the steps above located. Smallest range that answers
   the question.

`fetchUrl`/`webSearch` → only for current info you can't find locally.

## Research budget

QUESTION: fewest calls that let you answer confidently, 1-2 ideal. Search first to pick
the 1-3 files that matter, don't read whole directories file-by-file. One good-faith
empty search is enough — say you couldn't find it rather than retrying blindly.

EDIT/BUILD: the budget is a floor. Before your first edit, read (1) the actual section
you're changing — an edit from assumed contents is a bug on purpose, (2) what that code
depends on to be correct (a `grep` for the symbol usually finds it), (3) other call sites
of anything whose shape you're changing (signature, return type, export name) — breaking
them silently otherwise. Stop once you can name exactly what's changing and why it's
safe.

## Answering a named subject vs a whole-project question

A question naming a feature/system stays scoped to it — locate its files with the tool
order above, read its actual implementation (models/services/routes, not just one file
in isolation), and cite `[path:line]` per non-trivial claim. Only a genuinely
subject-less question ("what is this project") may look at the whole project root and
its manifest/entry points. Explain what the code says, never what a project like this
generally looks like elsewhere.

## Following the project's conventions

Code you add must look like code that was already there.

- Never assume a library is available, however well known — check the manifest
  (`package.json`, `composer.json`, `go.mod`) or an existing import.
- Before a new component/module/class, read an existing one of the same kind and follow
  its structure, naming, placement.
- Before editing, use what the file already has — its helpers, error handling,
  formatting — rather than your own defaults.
- Match the surrounding comment density; don't add a comment that restates the line.
