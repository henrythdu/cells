import type { Dirent } from 'node:fs';
import { existsSync, readdirSync, readFileSync, realpathSync, type Stats, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { type CellsConfig, parseConfig } from './config.js';
import { type Cell, parseCell } from './declaration.js';
import { isIgnored, parseIgnore } from './ignore.js';
import { type Ownership, parseOwnership, serializeOwnership } from './ownership.js';
import { isUnsafePath } from './validate.js';

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

/** Load every `.cell.toml` declaration in `.cells/`, keyed by cell name. The store's
 *  invariant: file `<name>.cell.toml` declares `name = "<name>"`, and no two declaration
 *  files name the same cell. A silent overwrite would hide a corrupt store (health would
 *  report green on half the partition) — detect both and die with the cause. */
export function loadDeclarations(): Record<string, Cell> {
  const parsed: { file: string; cell: Cell }[] = [];
  for (const file of readdirSync(CELLS_DIR)) {
    if (!file.endsWith('.cell.toml')) continue;
    parsed.push({ file, cell: readParsed(join(CELLS_DIR, file), parseCell, file) });
  }
  // Duplicate names first: two files declaring the same cell is the worse corruption
  // (a silent overwrite would hide half the partition). Then file/name mismatch.
  const sourceBy = new Map<string, string>();
  for (const { file, cell } of parsed) {
    const other = sourceBy.get(cell.name);
    if (other !== undefined) {
      throw new Error(`duplicate cell name "${cell.name}" declared in ${other} and ${file}`);
    }
    sourceBy.set(cell.name, file);
  }
  const decls: Record<string, Cell> = {};
  for (const { file, cell } of parsed) {
    const expected = file.slice(0, -'.cell.toml'.length);
    if (cell.name !== expected) {
      throw new Error(`${file} declares name "${cell.name}" — expected "${expected}" (file name and declared name must match)`);
    }
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
 *  can't grow the result, only re-walk forever. `skip` (default: the built-in SKIP_DIRS)
 *  never enter the census — a code-dirs ["."] config (flat repo) must not sweep
 *  node_modules/ dist/ into ownership, plan and size (detectProject already excludes
 *  them at init; this closes the same hole for hand-edited configs). Config skip-dirs
 *  REPLACES the default set — that's the unhide path for a real internal/build package. */
function listFiles(dir: string, exts: string[], skip: ReadonlySet<string>, visited = new Set<string>()): string[] {
  if (!existsSync(dir)) return []; // a repo may lack a configured dir yet
  const real = realpathSync(dir);
  if (visited.has(real)) return []; // symlink cycle — stop
  visited.add(real);
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const path = join(dir, entry);
    let st: Stats;
    try {
      st = statSync(path);
    } catch {
      continue; // dangling symlink / vanished entry — not code; a crash would sink the census
    }
    if (st.isDirectory()) out.push(...listFiles(path, exts, skip, visited));
    else if (exts.some((e) => entry.endsWith(e))) out.push(path);
  }
  return out;
}

/** All code files on disk (per config `code-dirs`/`code-exts`), excluding `.cells/ignore` matches.
 *  `baseDir` reads code from elsewhere (e.g. an extracted HEAD tree); paths stay repo-relative
 *  so ownership still resolves. `.cells/` (config/ownership/ignore) is always the working repo's. */
export function listCodeFiles(baseDir = '.'): string[] {
  const { codeDirs, codeExts, skipDirs } = loadConfig();
  // Config skip-dirs REPLACES the defaults (repo convention: code-dirs/code-exts too) —
  // the unhide path for a skip-named dir that holds real code (internal/build in Go).
  const skip = new Set(skipDirs ?? SKIP_DIRS);
  // Posix-normalize census paths: importer module keys and resolver string logic assume '/'
  // separators (ts-resolution, python fileToModule, rust dirname probes). Node's fs accepts
  // '/' on Windows, so one normalization here makes the whole pipeline platform-agnostic.
  const all = [...new Set(codeDirs.flatMap((dir) => listFiles(join(baseDir, dir), codeExts, skip).map((f) => relative(baseDir, f).replace(/\\/g, '/'))))];
  // Set: overlapping code-dirs (e.g. "." + "crates") must not double-list files — ownership,
  // plan and size all count per file. Detection filters at init; this covers hand-edited configs.
  const patterns = loadIgnorePatterns();
  if (patterns.length === 0) return all;
  return all.filter((f) => !isIgnored(f, patterns));
}

/** Read files into a {path→content} map. Two guards make this the safe byte seam:
 *  - trust boundary: paths come from repo-controlled ownership/tests entries — an absolute
 *    or `..`-escaping path must not read outside the repo (validatePartition flags the
 *    same condition as an integrity violation). Lexical checks can't see symlinks, so the
 *    resolved target must also stay under the resolved baseDir — a repo-owned symlink
 *    must not smuggle an outside file into the payload.
 *  - never-silent-zero: a MISSING file is skipped (validate flags it as dangling), but a
 *    file that exists yet can't be read (EACCES/EISDIR/…) must not silently become empty
 *    content — importers would derive a zero-edge graph from it.
 *  `baseDir` lets callers read from elsewhere (e.g. an extracted HEAD tree for `--diff`). */
export function readFiles(paths: string[], baseDir = '.'): Record<string, string> {
  const out: Record<string, string> = {};
  // Resolve the root once: every target's realpath must stay under it (symlink escape).
  // realpathSync fails on a missing root only if baseDir itself is gone — callers pass
  // an existing repo, so fall back to the lexical path rather than crash on a race.
  let root: string;
  try {
    root = realpathSync(baseDir);
  } catch {
    root = resolve(baseDir);
  }
  const rootPrefix = root + sep;
  for (const p of paths) {
    if (isUnsafePath(p)) {
      throw new Error(`path "${p}" escapes the repo root — fix the entry in .cells/ownership.toml (or the cell's tests field)`);
    }
    const full = join(baseDir, p);
    let real: string;
    try {
      real = realpathSync(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // missing — validate flags as dangling
      throw new Error(`cannot read ${p}: ${(e as Error).message}`);
    }
    if (real !== root && !real.startsWith(rootPrefix)) {
      throw new Error(`path "${p}" resolves outside the repo root (symlink) — fix the entry in .cells/ownership.toml (or the cell's tests field)`);
    }
    try {
      out[p] = readFileSync(full, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // vanished between realpath and read
      throw new Error(`cannot read ${p}: ${(e as Error).message}`);
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
export function skippedManifestDirs(codeExts: string[], baseDir = '.', skip: ReadonlySet<string> = SKIP_DIRS): string[] {
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
      if (skip.has(e.name)) {
        const p = join(dir, e.name);
        let hasCode = false;
        try {
          hasCode = readdirSync(p).some((f) => MANIFESTS.has(f) || codeExts.some((ext) => f.endsWith(ext)));
        } catch {
          /* unreadable dir — nothing to report */
        }
        if (hasCode) out.push(relative(baseDir, p).replace(/\\/g, '/')); // posix like the census — 'internal\build' would leak to users on Windows
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
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyx', '.pxd', '.rs', '.go', '.rb', '.java', '.kt', '.swift', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.hxx', '.cs']);

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
