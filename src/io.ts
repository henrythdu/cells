import { existsSync, readFileSync, readdirSync, statSync, realpathSync, type Stats } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { parseCell, type Cell } from './declaration.js';
import { parseOwnership, type Ownership } from './ownership.js';
import { assemblePayload, type CellSize } from './payload.js';
import { parseIgnore, isIgnored } from './ignore.js';
import { parseConfig, DEFAULT_MAX_PAYLOAD_TOKENS, type CellsConfig } from './config.js';

export const CELLS_DIR = '.cells';

/** Guard: ensure this is a Cells project (`.cells/` exists). Friendly exit if not. */
export function requireCells(): void {
  if (!existsSync(CELLS_DIR)) {
    console.error(`not a Cells project — no \`${CELLS_DIR}/\` here. Run \`cells init\` first.`);
    process.exit(1);
  }
}

/** Read a tracked file and parse it; on parse failure, attribute the error to the file —
 *  a bare smol-toml error doesn't say which `.cell.toml` is malformed, which strands an LLM
 *  (or human) that broke one of N declarations. */
function readParsed<T>(path: string, parse: (text: string) => T, label: string): T {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${label}: ${(e as Error).message}`);
  }
}

/** Load every `.cell.toml` declaration in `.cells/`, keyed by cell name. */
export function loadDeclarations(): Record<string, Cell> {
  const decls: Record<string, Cell> = {};
  for (const file of readdirSync(CELLS_DIR)) {
    if (!file.endsWith('.cell.toml')) continue;
    const cell = readParsed(join(CELLS_DIR, file), parseCell, file);
    decls[cell.name] = cell;
  }
  return decls;
}

/** Load the ownership map from `.cells/ownership.toml`. Missing file → empty map
 *  (a repo can have declarations but no assignments yet; every command should still run). */
export function loadOwnership(): Ownership {
  const path = join(CELLS_DIR, 'ownership.toml');
  if (!existsSync(path)) return {};
  return readParsed(path, parseOwnership, '.cells/ownership.toml');
}

/** Load `.cells/config.toml` (optional — missing file → defaults). */
export function loadConfig(): CellsConfig {
  const path = join(CELLS_DIR, 'config.toml');
  if (!existsSync(path)) return { maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS, layers: {}, codeDirs: ['src', 'test'], codeExts: ['.ts'] };
  return readParsed(path, parseConfig, '.cells/config.toml');
}

/** The three Cells stores, loaded once per command. Bundle them so cmd* functions stop
 *  hand-repeating the loadDeclarations/loadOwnership/loadConfig triple (the copy-paste
 *  drift surface). Eager: all three are tiny TOML reads, so the simplest shape wins. */
export interface CellsContext {
  declarations: Record<string, Cell>;
  ownership: Ownership;
  config: CellsConfig;
}

export function loadContext(): CellsContext {
  return { declarations: loadDeclarations(), ownership: loadOwnership(), config: loadConfig() };
}

/** Read files into a {path→content} map (missing files skipped — validate flags them).
 *  `baseDir` lets callers read from elsewhere (e.g. an extracted HEAD tree for `--diff`). */
export function readFiles(paths: string[], baseDir = '.'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    try {
      out[p] = readFileSync(join(baseDir, p), 'utf8');
    } catch {
      // missing — validate flags as dangling
    }
  }
  return out;
}

/** Recursively list files under a directory whose extension is in `exts` (relative paths).
 *  Follows symlinked dirs but stops on a cycle (a visited realpath) — a symlink loop
 *  can't grow the result, only re-walk forever. */
export function listFiles(dir: string, exts: string[], visited = new Set<string>()): string[] {
  if (!existsSync(dir)) return []; // a repo may lack a configured dir yet
  const real = realpathSync(dir);
  if (visited.has(real)) return []; // symlink cycle — stop
  visited.add(real);
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listFiles(path, exts, visited));
    else if (exts.some((e) => entry.endsWith(e))) out.push(path);
  }
  return out;
}

/** All code files on disk (per config `code-dirs`/`code-exts`), excluding `.cells/ignore` matches.
 *  `baseDir` reads code from elsewhere (e.g. an extracted HEAD tree); paths stay repo-relative
 *  so ownership still resolves. `.cells/` (config/ownership/ignore) is always the working repo's. */
export function listCodeFiles(baseDir = '.'): string[] {
  const { codeDirs, codeExts } = loadConfig();
  const all = [...new Set(codeDirs.flatMap((dir) => listFiles(join(baseDir, dir), codeExts).map((f) => relative(baseDir, f))))];
  // Set: overlapping code-dirs (e.g. "." + "crates") must not double-list files — ownership,
  // plan and size all count per file. Detection filters at init; this covers hand-edited configs.
  const ignorePath = join(CELLS_DIR, 'ignore');
  if (!existsSync(ignorePath)) return all;
  const patterns = parseIgnore(readFileSync(ignorePath, 'utf8'));
  return all.filter((f) => !isIgnored(f, patterns));
}

/** Directories never scanned for code (deps, build output, tooling caches). */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.cells',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  'out',
  'coverage',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.env',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.eggs',
  'eggs',
]);

/** Extensions recognised as code (for census + ownership). Cells has importers for
 *  .ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.rs; others (.go/.rb/.java/...) are counted but BLIND
 *  (no crossing analysis) — surfaced by the blind-ext warning in health. */
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.rb', '.java', '.kt', '.swift', '.c', '.cpp', '.cc', '.h', '.hpp', '.cs']);

/** Detect the project's code languages + directories by scanning the repo (used by `cells init`
 *  so a Python/Rust repo doesn't ship TypeScript-only defaults). Scans top-level dirs (skipping
 *  deps/build/tooling), counts files by extension, collects top-level dirs holding code.
 *  Falls back to TS defaults ([".ts"], ["src","test"]) when no code is found. Pure (no config). */
export function detectProject(root = '.'): { codeExts: string[]; codeDirs: string[] } {
  const extCounts = new Map<string, number>();
  const dirHasCode = new Set<string>();

  const scan = (dir: string, topDir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let st: Stats;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        scan(path, topDir);
      } else {
        const ext = extname(entry).toLowerCase();
        if (CODE_EXTS.has(ext)) {
          extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
          dirHasCode.add(topDir);
        }
      }
    }
  };

  let rootEntries: string[];
  try {
    rootEntries = readdirSync(root);
  } catch {
    return { codeExts: ['.ts'], codeDirs: ['src', 'test'] };
  }
  for (const entry of rootEntries) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(root, entry);
    let st: Stats;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      scan(path, entry);
    } else if (CODE_EXTS.has(extname(entry).toLowerCase())) {
      extCounts.set(extname(entry).toLowerCase(), (extCounts.get(extname(entry).toLowerCase()) ?? 0) + 1);
      dirHasCode.add('.');
    }
  }

  if (extCounts.size === 0) return { codeExts: ['.ts'], codeDirs: ['src', 'test'] };
  const codeExts = [...extCounts.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
  let codeDirs = [...dirHasCode].sort();
  // Drop dirs covered by another included dir: "." covers everything (root code files make
  // the list collapse to ["."] — otherwise every file double-counts in ownership/plan).
  codeDirs = codeDirs.includes('.') ? ['.'] : codeDirs.filter((d) => !codeDirs.some((o) => o !== d && (d + '/').startsWith(o + '/')));
  if (codeDirs.length === 0) codeDirs = ['src', 'test'];
  return { codeExts, codeDirs };
}

/** Resolve a cell's neighbor declarations (for payload assembly). */
export function neighborsOf(cell: Cell, declarations: Record<string, Cell>): Cell[] {
  return cell.requires.map((r) => declarations[r]).filter((c): c is Cell => Boolean(c));
}

/** Assemble a cell's payload and measure it — the context-fit metric (what the model consumes).
 * Includes test files so the size gate (health/size) matches what `payload` actually emits. */
export function computePayloadSize(cell: Cell, ownedFiles: string[], neighbors: Cell[]): CellSize {
  const fileContents = readFiles(ownedFiles);
  const testFiles = cell.tests ?? [];
  const testContents = testFiles.length > 0 ? readFiles(testFiles) : undefined;
  const chars = assemblePayload(cell, ownedFiles, fileContents, neighbors, undefined, testFiles, testContents).length;
  return { files: ownedFiles.length + testFiles.length, chars, tokens: estimateTokens(chars) };
}

/** chars → token estimate (the payload heuristic: ~3 chars/token). Single home — all
 *  size displays must route through here so they never disagree. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3);
}
