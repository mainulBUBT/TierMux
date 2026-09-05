// Per-language regex symbol extractors (zero dependencies), used by symbolPruner.ts to trim a
// large @-mentioned file to its top-level declarations. imports/exports are extracted too but
// nothing reads them since the workspace index was removed (2026-09-05).

export type Language =
  | 'typescript'
  | 'javascript'
  | 'php'
  | 'python'
  | 'go'
  | 'dart'
  | 'rust'
  | 'cpp'
  | 'java'
  | 'kotlin'
  | 'ruby'
  | 'swift'
  | 'unknown';

export interface SymbolExtract {
  name: string;
  kind: string;
  line: number;
}

export interface ExtractResult {
  language: Language;
  imports: string[];
  exports: string[];
  symbols: SymbolExtract[];
}

const EXT_LANG: Record<string, Language> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.php': 'php',
  '.py': 'python',
  '.go': 'go',
  '.dart': 'dart',
  '.rs': 'rust',
  '.c': 'cpp', '.h': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.java': 'java',
  '.kt': 'kotlin',
  '.rb': 'ruby',
  '.swift': 'swift',
};

export function languageForPath(relPath: string): Language {
  const dot = relPath.lastIndexOf('.');
  if (dot < 0) return 'unknown';
  return EXT_LANG[relPath.slice(dot).toLowerCase()] ?? 'unknown';
}

/** 0-indexed line number of a character offset (1-indexed everywhere downstream). */
function lineOf(text: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** De-duplicate while preserving first-seen order. */
function uniq(arr: string[]): string[] {
  return [...new Set(arr)];
}

// ── JS / TS ──────────────────────────────────────────────────────────────────────
const JS_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"`]([^'"`$]+)['"`]/g;

function extractJsTs(text: string): { imports: string[]; exports: string[]; symbols: SymbolExtract[] } {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  JS_IMPORT_RE.lastIndex = 0;
  while ((m = JS_IMPORT_RE.exec(text)) !== null) {
    const spec = m[1].trim();
    if (spec) imports.push(spec);
  }

  const symbols: SymbolExtract[] = [];
  const exportNames: string[] = [];
  const DEF_RE = /^\s*(export(?:\s+default)?\s+)?(?:export\s+)?(?:declare\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  DEF_RE.lastIndex = 0;
  while ((m = DEF_RE.exec(text)) !== null) {
    const exported = !!m[1] || /^export\b/.test(m[0]);
    const kind = m[2];
    const name = m[3];
    symbols.push({ name, kind, line: lineOf(text, m.index) });
    if (exported) exportNames.push(name);
  }
  const NAMED_RE = /^export\s*\{([^}]*)\}/gm;
  NAMED_RE.lastIndex = 0;
  while ((m = NAMED_RE.exec(text)) !== null) {
    for (const raw of m[1].split(',')) {
      const rename = raw.split(/\bas\b/);
      const name = (rename[rename.length - 1] ?? raw).trim();
      if (name) exportNames.push(name);
    }
  }
  return { imports: uniq(imports), exports: uniq(exportNames), symbols };
}

// ── PHP ──────────────────────────────────────────────────────────────────────────
const PHP_USE_RE = /\buse\s+([\\A-Za-z_][\w\\]*)/g;
const PHP_REQUIRE_RE = /\b(?:require|require_once|include|include_once)\s*['"]([^'"]+)['"]/g;

function extractPhp(text: string): { imports: string[]; exports: string[]; symbols: SymbolExtract[] } {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  PHP_USE_RE.lastIndex = 0;
  while ((m = PHP_USE_RE.exec(text)) !== null) imports.push(m[1]);
  PHP_REQUIRE_RE.lastIndex = 0;
  while ((m = PHP_REQUIRE_RE.exec(text)) !== null) imports.push(m[1]);

  const symbols: SymbolExtract[] = [];
  const DEF_RE = /^\s*(?:(?:abstract|final|public|protected|private|static)\s+)*(function|class|interface|trait)\s+([A-Za-z_]\w*)/gm;
  DEF_RE.lastIndex = 0;
  while ((m = DEF_RE.exec(text)) !== null) {
    symbols.push({ name: m[2], kind: m[1], line: lineOf(text, m.index) });
  }
  return { imports: uniq(imports), exports: uniq(symbols.map((s) => s.name)), symbols };
}

// ── Python ───────────────────────────────────────────────────────────────────────
const PY_IMPORT_RE = /\bimport\s+([\w.]+)/g;
const PY_FROM_RE = /\bfrom\s+([\w.]+)\s+import\b/g;

function extractPython(text: string): { imports: string[]; exports: string[]; symbols: SymbolExtract[] } {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  PY_IMPORT_RE.lastIndex = 0;
  while ((m = PY_IMPORT_RE.exec(text)) !== null) imports.push(m[1]);
  PY_FROM_RE.lastIndex = 0;
  while ((m = PY_FROM_RE.exec(text)) !== null) imports.push(m[1]);

  const symbols: SymbolExtract[] = [];
  const DEF_RE = /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/gm;
  DEF_RE.lastIndex = 0;
  while ((m = DEF_RE.exec(text)) !== null) {
    symbols.push({ name: m[2], kind: m[1], line: lineOf(text, m.index) });
  }
  return { imports: uniq(imports), exports: uniq(symbols.map((s) => s.name)), symbols };
}

// ── Go ───────────────────────────────────────────────────────────────────────────
const GO_BLOCK_RE = /import\s*\(([\s\S]*?)\)/g;
const GO_SINGLE_RE = /\bimport\s+"([^"]+)"/g;
const GO_LINE_RE = /"([^"]+)"/g;

function extractGo(text: string): { imports: string[]; exports: string[]; symbols: SymbolExtract[] } {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  GO_SINGLE_RE.lastIndex = 0;
  while ((m = GO_SINGLE_RE.exec(text)) !== null) imports.push(m[1]);
  GO_BLOCK_RE.lastIndex = 0;
  while ((m = GO_BLOCK_RE.exec(text)) !== null) {
    GO_LINE_RE.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = GO_LINE_RE.exec(m[1])) !== null) imports.push(lm[1]);
  }

  const symbols: SymbolExtract[] = [];
  const DEF_RE = /\bfunc\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*\(|\btype\s+([A-Za-z_]\w*)/g;
  DEF_RE.lastIndex = 0;
  while ((m = DEF_RE.exec(text)) !== null) {
    const name = m[1] ?? m[2];
    if (name) symbols.push({ name, kind: m[1] ? 'func' : 'type', line: lineOf(text, m.index) });
  }
  const exports = uniq(symbols.map((s) => s.name).filter((n) => /^[A-Z]/.test(n)));
  return { imports: uniq(imports), exports, symbols };
}

// ── Dart ─────────────────────────────────────────────────────────────────────────
const DART_IMPORT_RE = /\b(?:import|export|part)\s+['"]([^'"]+)['"]/g;
const DART_DEF_RE = /^\s*(?:abstract\s+|sealed\s+|base\s+|interface\s+|final\s+|mixin\s+)*(class|mixin|enum|extension|typedef)\s+([A-Za-z_]\w*)/gm;
const DART_FUNC_RE = /^\s*(?:(?:[A-Za-z_]\w*<[^>]+>|[A-Za-z_]\w*)\s+)+([a-z_]\w*)\s*\(/gm;

function extractDart(text: string): { imports: string[]; exports: string[]; symbols: SymbolExtract[] } {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  DART_IMPORT_RE.lastIndex = 0;
  while ((m = DART_IMPORT_RE.exec(text)) !== null) imports.push(m[1]);

  const symbols: SymbolExtract[] = [];
  DART_DEF_RE.lastIndex = 0;
  while ((m = DART_DEF_RE.exec(text)) !== null) {
    symbols.push({ name: m[2], kind: m[1], line: lineOf(text, m.index) });
  }
  DART_FUNC_RE.lastIndex = 0;
  while ((m = DART_FUNC_RE.exec(text)) !== null) {
    if (!['if', 'for', 'while', 'switch', 'catch'].includes(m[1])) {
      symbols.push({ name: m[1], kind: 'func', line: lineOf(text, m.index) });
    }
  }
  const exports = uniq(symbols.map((s) => s.name).filter((n) => !n.startsWith('_')));
  return { imports: uniq(imports), exports, symbols };
}

// ── Rust ─────────────────────────────────────────────────────────────────────────
const RUST_USE_RE = /\buse\s+([^;]+);/g;
const RUST_MOD_RE = /\bmod\s+([A-Za-z_]\w*);/g;
const RUST_DEF_RE = /^\s*(pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|type|mod|const|static)\s+([A-Za-z_]\w*)/gm;

function extractRust(text: string): { imports: string[]; exports: string[]; symbols: SymbolExtract[] } {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  RUST_USE_RE.lastIndex = 0;
  while ((m = RUST_USE_RE.exec(text)) !== null) {
    imports.push(m[1].trim());
  }
  RUST_MOD_RE.lastIndex = 0;
  while ((m = RUST_MOD_RE.exec(text)) !== null) imports.push(m[1]);

  const symbols: SymbolExtract[] = [];
  const exportNames: string[] = [];
  RUST_DEF_RE.lastIndex = 0;
  while ((m = RUST_DEF_RE.exec(text)) !== null) {
    const isPub = !!m[1];
    const kind = m[2];
    const name = m[3];
    symbols.push({ name, kind, line: lineOf(text, m.index) });
    if (isPub) exportNames.push(name);
  }
  return { imports: uniq(imports), exports: uniq(exportNames), symbols };
}

// ── C / C++ ──────────────────────────────────────────────────────────────────────
const CPP_INCLUDE_RE = /#include\s*["<]([^">]+)[">]/g;
const CPP_DEF_RE = /^\s*(class|struct|enum|union|namespace)\s+([A-Za-z_]\w*)/gm;
const CPP_FUNC_RE = /^\s*(?:[A-Za-z_]\w*[\s*&]+)+([A-Za-z_]\w*)\s*\([^)]*\)\s*[\{;]/gm;

function extractCpp(text: string): { imports: string[]; exports: string[]; symbols: SymbolExtract[] } {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  CPP_INCLUDE_RE.lastIndex = 0;
  while ((m = CPP_INCLUDE_RE.exec(text)) !== null) imports.push(m[1]);

  const symbols: SymbolExtract[] = [];
  CPP_DEF_RE.lastIndex = 0;
  while ((m = CPP_DEF_RE.exec(text)) !== null) {
    symbols.push({ name: m[2], kind: m[1], line: lineOf(text, m.index) });
  }
  CPP_FUNC_RE.lastIndex = 0;
  while ((m = CPP_FUNC_RE.exec(text)) !== null) {
    if (!['if', 'for', 'while', 'switch', 'catch', 'return'].includes(m[1])) {
      symbols.push({ name: m[1], kind: 'func', line: lineOf(text, m.index) });
    }
  }
  return { imports: uniq(imports), exports: uniq(symbols.map((s) => s.name)), symbols };
}

// ── Java ─────────────────────────────────────────────────────────────────────────
const JAVA_IMPORT_RE = /\bimport\s+(?:static\s+)?([\w.*]+);/g;
const JAVA_DEF_RE = /^\s*(?:(?:public|protected|private|static|final|abstract|native|synchronized)\s+)*(class|interface|enum|record|@interface)\s+([A-Za-z_]\w*)/gm;
const JAVA_METHOD_RE = /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)+(?:[\w<>\[\]]+\s+)+([A-Za-z_]\w*)\s*\(/gm;

function extractJava(text: string): { imports: string[]; exports: string[]; symbols: SymbolExtract[] } {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  JAVA_IMPORT_RE.lastIndex = 0;
  while ((m = JAVA_IMPORT_RE.exec(text)) !== null) imports.push(m[1]);

  const symbols: SymbolExtract[] = [];
  const exportNames: string[] = [];
  JAVA_DEF_RE.lastIndex = 0;
  while ((m = JAVA_DEF_RE.exec(text)) !== null) {
    const isPublic = /\bpublic\b/.test(m[0]);
    symbols.push({ name: m[2], kind: m[1], line: lineOf(text, m.index) });
    if (isPublic) exportNames.push(m[2]);
  }
  JAVA_METHOD_RE.lastIndex = 0;
  while ((m = JAVA_METHOD_RE.exec(text)) !== null) {
    const name = m[1];
    if (!['if', 'for', 'while', 'switch', 'catch'].includes(name)) {
      symbols.push({ name, kind: 'method', line: lineOf(text, m.index) });
      if (/\bpublic\b/.test(m[0])) exportNames.push(name);
    }
  }
  return { imports: uniq(imports), exports: uniq(exportNames), symbols };
}

// ── Kotlin ───────────────────────────────────────────────────────────────────────
const KT_IMPORT_RE = /\bimport\s+([\w.]+)/g;
const KT_DEF_RE = /^\s*(?:(?:public|protected|private|internal|abstract|final|open|inner|sealed|data|value)\s+)*(class|interface|object|enum\s+class|fun|val|var)\s+([A-Za-z_]\w*)/gm;

function extractKotlin(text: string): { imports: string[]; exports: string[]; symbols: SymbolExtract[] } {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  KT_IMPORT_RE.lastIndex = 0;
  while ((m = KT_IMPORT_RE.exec(text)) !== null) imports.push(m[1]);

  const symbols: SymbolExtract[] = [];
  const exportNames: string[] = [];
  KT_DEF_RE.lastIndex = 0;
  while ((m = KT_DEF_RE.exec(text)) !== null) {
    const isPrivate = /\bprivate\b/.test(m[0]);
    const kind = m[1].replace(/\s+/g, '_');
    const name = m[2];
    symbols.push({ name, kind, line: lineOf(text, m.index) });
    if (!isPrivate) exportNames.push(name);
  }
  return { imports: uniq(imports), exports: uniq(exportNames), symbols };
}

// ── Ruby ─────────────────────────────────────────────────────────────────────────
const RB_IMPORT_RE = /\b(?:require|require_relative|load)\s*['"]([^'"]+)['"]/g;
const RB_DEF_RE = /^\s*(def|class|module)\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/gm;

function extractRuby(text: string): { imports: string[]; exports: string[]; symbols: SymbolExtract[] } {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  RB_IMPORT_RE.lastIndex = 0;
  while ((m = RB_IMPORT_RE.exec(text)) !== null) imports.push(m[1]);

  const symbols: SymbolExtract[] = [];
  RB_DEF_RE.lastIndex = 0;
  while ((m = RB_DEF_RE.exec(text)) !== null) {
    symbols.push({ name: m[2], kind: m[1], line: lineOf(text, m.index) });
  }
  return { imports: uniq(imports), exports: uniq(symbols.map((s) => s.name)), symbols };
}

// ── Swift ────────────────────────────────────────────────────────────────────────
const SWIFT_IMPORT_RE = /\bimport\s+(?:class|struct|enum|protocol|typealias|func|let|var\s+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g;
const SWIFT_DEF_RE = /^\s*(?:(?:public|open|internal|fileprivate|private|final|abstract)\s+)*(class|struct|enum|protocol|extension|typealias|func|let|var)\s+([A-Za-z_]\w*)/gm;

function extractSwift(text: string): { imports: string[]; exports: string[]; symbols: SymbolExtract[] } {
  const imports: string[] = [];
  let m: RegExpExecArray | null;
  SWIFT_IMPORT_RE.lastIndex = 0;
  while ((m = SWIFT_IMPORT_RE.exec(text)) !== null) imports.push(m[1]);

  const symbols: SymbolExtract[] = [];
  const exportNames: string[] = [];
  SWIFT_DEF_RE.lastIndex = 0;
  while ((m = SWIFT_DEF_RE.exec(text)) !== null) {
    const isPrivate = /\b(?:private|fileprivate)\b/.test(m[0]);
    const kind = m[1];
    const name = m[2];
    symbols.push({ name, kind, line: lineOf(text, m.index) });
    if (!isPrivate) exportNames.push(name);
  }
  return { imports: uniq(imports), exports: uniq(exportNames), symbols };
}

/** Extract imports/exports/symbols for one file. `unknown` language yields empty. */
export function extract(relPath: string, text: string): ExtractResult {
  const language = languageForPath(relPath);
  switch (language) {
    case 'typescript':
    case 'javascript': { const r = extractJsTs(text); return { language, ...r }; }
    case 'php': { const r = extractPhp(text); return { language, ...r }; }
    case 'python': { const r = extractPython(text); return { language, ...r }; }
    case 'go': { const r = extractGo(text); return { language, ...r }; }
    case 'dart': { const r = extractDart(text); return { language, ...r }; }
    case 'rust': { const r = extractRust(text); return { language, ...r }; }
    case 'cpp': { const r = extractCpp(text); return { language, ...r }; }
    case 'java': { const r = extractJava(text); return { language, ...r }; }
    case 'kotlin': { const r = extractKotlin(text); return { language, ...r }; }
    case 'ruby': { const r = extractRuby(text); return { language, ...r }; }
    case 'swift': { const r = extractSwift(text); return { language, ...r }; }
    default: return { language: 'unknown', imports: [], exports: [], symbols: [] };
  }
}
