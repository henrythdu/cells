import { existsSync, readFileSync, readdirSync, statSync, realpathSync, writeFileSync, type Stats } from 'node:fs';
import { join, relative, extname } from 'node:path';
import type { Dirent } from 'node:fs';
import { parseCell, type Cell } from './declaration.js';
import { parseOwnership, serializeOwnership, type Ownership } from './ownership.js';
import { parseIgnore, isIgnored } from './ignore.js';
import { parseConfig, type CellsConfig } from './config.js';

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

/** `.cells/ignore` patterns (empty when the file is absent). Shared by the census (listCodeFiles)
 *  and ownership loading — one read/parse path for the ignore file. */
function loadIgnorePatterns(): string[] {
  const ignorePath = join(CELLS_DIR, 'ignore');
  if (!existsSync(ignorePath)) return [];
  return parseIgnore(readFileSync(ignorePath, 'utf8'));
}

/** Filter an ownership map down to non-ignored files (the store's invariant: owned ⟺ not
 *  ignored). Shared by read and write so the two ends can't drift. */
function filterIgnored(ownership: Ownership): Ownership {
  const patterns = loadIgnorePatterns();
  if (patterns.length === 0) return ownership;
  const filtered: Ownership = {};
  for (const [cell, files] of Object.entries(ownership)) {
    const kept = files.filter((f) => !isIgnored(f, patterns));
    if (kept.length > 0) filtered[cell] = kept;
  }
  return filtered;
}

export function loadOwnership(): Ownership {
  const path = join(CELLS_DIR, 'ownership.toml');
  if (!existsSync(path)) return {};
  const ownership = readParsed(path, parseOwnership, '.cells/ownership.toml');
  // wave-3 #7: `.cells/ignore` means cell-free — owned-but-ignored files read as unowned
  // (stale ownership.toml entries drop on the next write of the store; size/payload stop
  // counting them without a manual unassign).
  return filterIgnored(ownership);
}

/** Persist the ownership map. Write side of the store's invariant: read filters ignored files,
 *  write drops them — the file on disk and what cells reads never disagree, and a stale entry
 *  (written before the ignore rule was added, or an ignored file handed to assign) drops here
 *  instead of lingering invisibly. All writers go through this one seam. */
export function writeOwnership(ownership: Ownership): void {
  writeFileSync(join(CELLS_DIR, 'ownership.toml'), serializeOwnership(filterIgnored(ownership)));
}

/** Load `.cells/config.toml` (optional — missing file → defaults). `parseConfig('')`
 *  is the empty-document parse — every key missing → every default — so the fallback
 *  shape lives in ONE place (parseConfig), not duplicated inline here. */
export function loadConfig(): CellsConfig {
  const path = join(CELLS_DIR, 'config.toml');
  if (!existsSync(path)) return parseConfig('');
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

/** Recursively list files under a directory whose extension is in `exts` (relative paths).
 *  Follows symlinked dirs but stops on a cycle (a visited realpath) — a symlink loop
 *  can't grow the result, only re-walk forever. SKIP_DIRS (deps/build/tooling) never
 *  enter the census — a code-dirs ["."] config (flat repo) must not sweep node_modules/
 *  dist/ into ownership, plan and size (detectProject already excludes them at init;
 *  this closes the same hole for hand-edited configs). */
function listFiles(dir: string, exts: string[], visited = new Set<string>()): string[] {
  if (!existsSync(dir)) return []; // a repo may lack a configured dir yet
  const real = realpathSync(dir);
  if (visited.has(real)) return []; // symlink cycle — stop
  visited.add(real);
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    let st: Stats;
    try {
      st = statSync(path);
    } catch {
      continue; // dangling symlink / vanished entry — not code; a crash would sink the census
    }
    if (st.isDirectory()) out.push(...listFiles(path, exts, visited));
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
  const patterns = loadIgnorePatterns();
  if (patterns.length === 0) return all;
  return all.filter((f) => !isIgnored(f, patterns));
}

/** Read files into a {path→content} map (missing files skipped — validate flags them).
 *  `baseDir` lets callers read from elsewhere (e.g. an extracted HEAD tree for `--diff`).
 *  The one place file bytes enter cells — importers analyze contents, payload/size pack them. */
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

/** Directories never scanned for code (deps, build output, tooling caches). */
export const SKIP_DIRS = new Set([
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

/** Skip-named dirs that hold census-eligible code or a build manifest (a real `build/` Go
 *  package, a crate dir literally named `build`). Plan reports them so "0 orphans" can't
 *  hide a swallowed package — the skip rule stays; the omission becomes visible.
 *  node_modules/.git/.cells are never source; the ambiguous names (dist/build/target/…)
 *  are exactly the ones worth a user's eye. Pure over the FS. */
export function skippedManifestDirs(codeExts: string[], baseDir = '.'): string[] {
  const MANIFESTS = new Set(['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'build.gradle', 'pom.xml']);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.cells') continue;
      if (SKIP_DIRS.has(e.name)) {
        const p = join(dir, e.name);
        let hasCode = false;
        try {
          hasCode = readdirSync(p).some((f) => MANIFESTS.has(f) || codeExts.some((ext) => f.endsWith(ext)));
        } catch {
          /* unreadable dir — nothing to report */
        }
        if (hasCode) out.push(relative(baseDir, p));
        continue; // never recurse into a skipped dir
      }
      walk(join(dir, e.name));
    }
  };
  walk(baseDir);
  return out.sort();
}


/** Extensions recognised as code (for census + ownership). Cells has importers for
 *  .ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.rs; others (.go/.rb/.java/...) are counted but BLIND
 *  (no crossing analysis) — surfaced by the blind-ext warning in health. */
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyx', '.pxd', '.rs', '.go', '.rb', '.java', '.kt', '.swift', '.c', '.cpp', '.cc', '.h', '.hpp', '.cs']);

/** Detect the project's code languages + directories by scanning the repo (used by `cells init`
 *  so a Python/Rust repo doesn't ship TypeScript-only defaults). Scans top-level dirs (skipping
 *  deps/build/tooling), counts files by extension, collects top-level dirs holding code.
 *  Falls back to TS defaults ([".ts"], ["src","test"]) when no code is found. Pure (no config). */
export function detectProject(root = '.'): { codeExts: string[]; codeDirs: string[] } {
  const extCounts = new Map<string, number>();
  const dirHasCode = new Set<string>();

  const scan = (dir: string, topDir: string, visited: Set<string>): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    // Symlink-cycle guard (listFiles precedent): a loop must not re-walk forever.
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
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
        scan(path, topDir, visited);
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
  const visited = new Set<string>(); // one cycle-guard span across all top-level scans
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
      scan(path, entry, visited);
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
