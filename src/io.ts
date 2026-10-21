import type { Dirent } from 'node:fs';
import { existsSync, readdirSync, readFileSync, realpathSync, type Stats, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { type CellsConfig, parseConfig } from './config.js';
import { type Cell, parseCell } from './declaration.js';
import { isIgnored, parseIgnore } from './ignore.js';
import { type Ownership, parseOwnership, serializeOwnership } from './ownership.js';
import { isUnsafePath } from './validate.js';

export const CELLS_DIR = '.cells';

/** Guard: make sure that this is a Cells project (the `.cells/` directory exists). Exit with a friendly message when it is not. */
export function requireCells(): void {
  if (!existsSync(CELLS_DIR)) {
    console.error(`not a Cells project — no \`${CELLS_DIR}/\` here. Run \`cells init\` first.`);
    process.exit(1);
  }
}

/**
 * Read a tracked file and parse it. On a parse failure, add the file name to the error,
 * because a bare smol-toml error does not say which `.cell.toml` is malformed. Without that
 * name, a model or a person who broke one of N declarations has no starting point.
 */
function readParsed<T>(path: string, parse: (text: string) => T, label: string): T {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${label}: ${(e as Error).message}`);
  }
}

/**
 * Load every `.cell.toml` declaration in `.cells/`, keyed by cell name.
 *
 * The invariant of the store: the file `<name>.cell.toml` declares `name = "<name>"`, and no
 * two declaration files name the same cell.
 *
 * A silent overwrite would hide a corrupt store, and health would report success on half of
 * the partition. The function detects both conditions and stops with the cause.
 */
export function loadDeclarations(): Record<string, Cell> {
  const parsed: { file: string; cell: Cell }[] = [];
  for (const file of readdirSync(CELLS_DIR)) {
    if (!file.endsWith('.cell.toml')) continue;
    parsed.push({ file, cell: readParsed(join(CELLS_DIR, file), parseCell, file) });
  }
  // Duplicate names come first. Two files that declare the same cell are the worse
  // corruption, because a silent overwrite would hide half of the partition. The file and
  // name mismatch comes after that.
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

/**
 * The `.cells/ignore` patterns. The result is empty when the file is absent. The census
 * (`listCodeFiles`) and the ownership loader both use this function, so the system reads and
 * parses the ignore file in one place.
 */
function loadIgnorePatterns(): string[] {
  const ignorePath = join(CELLS_DIR, 'ignore');
  if (!existsSync(ignorePath)) return [];
  return parseIgnore(readFileSync(ignorePath, 'utf8'));
}

/**
 * Filter an ownership map down to the files that are not ignored. This is the invariant of
 * the store: a file is owned if and only if it is not ignored. The read path and the write
 * path share this function, so the two ends cannot disagree.
 */
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
  // A `.cells/ignore` match means that the file is free of cells. An owned but ignored file
  // reads as unowned. A stale ownership.toml entry drops on the next write of the store, and
  // size and payload stop counting the file without a manual unassign.
  return filterIgnored(ownership);
}

/**
 * Save the ownership map. This function is the write side of the store invariant: the read
 * path filters the ignored files out, and the write path drops them.
 *
 * Therefore the file on disk and the data that cells reads never disagree. A stale entry
 * (written before the ignore rule was added, or an ignored file passed to `assign`) drops
 * here instead of staying invisible. All writers use this one seam.
 */
export function writeOwnership(ownership: Ownership): void {
  writeFileSync(join(CELLS_DIR, 'ownership.toml'), serializeOwnership(filterIgnored(ownership)));
}

/**
 * Load `.cells/config.toml`. The file is optional, and a missing file gives the defaults.
 *
 * `parseConfig('')` parses an empty document, where every key is missing and every default
 * applies. Therefore the fallback definition lives in ONE place (`parseConfig`) and is not
 * duplicated here.
 */
export function loadConfig(): CellsConfig {
  const path = join(CELLS_DIR, 'config.toml');
  if (!existsSync(path)) return parseConfig('');
  return readParsed(path, parseConfig, '.cells/config.toml');
}

/**
 * The three Cells stores, loaded once for each command. The bundle removes the repeated
 * `loadDeclarations`/`loadOwnership`/`loadConfig` triple from the `cmd*` functions, which was
 * a place where behavior could drift through copy-paste. The bundle is eager: all three reads
 * are small TOML files, so the simplest shape is the best.
 */
export interface CellsContext {
  declarations: Record<string, Cell>;
  ownership: Ownership;
  config: CellsConfig;
}

export function loadContext(): CellsContext {
  return { declarations: loadDeclarations(), ownership: loadOwnership(), config: loadConfig() };
}

/**
 * The shared core of the directory walk: guarded readdir, a realpath cycle guard, and stat
 * for each entry.
 *
 * `skip` removes names before the stat call (the SKIP_DIRS style). `visit` handles each
 * remaining entry, and a directory recurses through the caller, which shares `visited`.
 * Therefore a symlink loop back to an ancestor stops and does not walk again.
 *
 * The census (`listFiles`) and the detection (`scan` and `root`) use this function, so there
 * is one guard surface and not three hand-written loops.
 */
function walkDir(dir: string, visited: Set<string>, visit: (path: string, entry: string, isDir: boolean) => void, skip?: ReadonlySet<string>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // The directory is missing or unreadable, so it is not code. A crash would stop the census.
  }
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  if (visited.has(real)) return; // This is a symlink cycle. Stop.
  visited.add(real);
  for (const entry of entries) {
    if (skip?.has(entry)) continue;
    const path = join(dir, entry);
    let st: Stats;
    try {
      st = statSync(path);
    } catch {
      continue; // The entry is a dangling symlink or a vanished file, so it is not code.
    }
    visit(path, entry, st.isDirectory());
  }
}

/**
 * Recursively list the files below a directory whose extension is in `exts`. The paths are
 * relative.
 *
 * The function follows symlinked directories but stops on a cycle (a realpath that it already
 * visited), so a symlink loop cannot grow the result and cannot walk again forever.
 *
 * `skip` (the default is the built-in SKIP_DIRS) never enters the census. Without this, a
 * `code-dirs = ["."]` configuration for a flat repository would collect node_modules/ and
 * dist/ into ownership, plan, and size. `detectProject` already excludes them at init, and
 * this check closes the same hole for hand-edited configurations.
 *
 * The `skip-dirs` configuration value REPLACES the default set. That is the way to unhide a
 * real internal or build package.
 */
function listFiles(dir: string, exts: string[], skip: ReadonlySet<string>, visited = new Set<string>()): string[] {
  const out: string[] = [];
  walkDir(
    dir,
    visited,
    (path, entry, isDir) => {
      if (isDir) out.push(...listFiles(path, exts, skip, visited));
      else if (exts.some((e) => entry.toLowerCase().endsWith(e.toLowerCase()))) out.push(path); // The comparison is case-insensitive, because some toolchains write .TS or .Cpp. A case gap would miss real code.
    },
    skip,
  );
  return out;
}

/**
 * All code files on disk (per the `code-dirs` and `code-exts` configuration), without the
 * `.cells/ignore` matches.
 *
 * `baseDir` reads the code from another location, for example an extracted HEAD tree. The
 * paths stay relative to the repository, so ownership still resolves. `.cells/` (config,
 * ownership, ignore) is always the directory of the working repository.
 */
export function listCodeFiles(baseDir = '.'): string[] {
  const { codeDirs, codeExts, skipDirs } = loadConfig();
  // The `skip-dirs` configuration value REPLACES the defaults (as `code-dirs` and `code-exts`
  // do). This is the way to unhide a skip-named directory that holds real code, such as an
  // `internal/build` package in Go.
  const skip = new Set(skipDirs ?? SKIP_DIRS);
  // Normalize the census paths to posix form. The importer module keys and the resolver
  // string logic assume '/' separators (`ts-resolution`, `fileToModule` in python, the
  // dirname probes in rust). Node's fs accepts '/' on Windows, so one normalization here
  // makes the whole pipeline platform-independent.
  const all = [...new Set(codeDirs.flatMap((dir) => listFiles(join(baseDir, dir), codeExts, skip).map((f) => relative(baseDir, f).replace(/\\/g, '/'))))];
  // Use a Set. Overlapping code-dirs (for example "." and "crates") must not list a file
  // twice, because ownership, plan, and size count each file. Detection filters at init, and
  // this check covers hand-edited configurations.
  const patterns = loadIgnorePatterns();
  if (patterns.length === 0) return all;
  return all.filter((f) => !isIgnored(f, patterns));
}

/**
 * Read files into a map from path to content. Two guards make this the safe byte seam.
 *
 * - Trust boundary: the paths come from ownership and tests entries, which the repository
 *   controls. An absolute path or a path with `..` must not read outside the repository.
 *   `validatePartition` reports the same condition as an integrity violation. A lexical
 *   check cannot see symlinks, so the resolved target must also stay below the resolved
 *   `baseDir`. A symlink in the repository must not bring an outside file into the payload.
 *
 * - Never zero silently: the function skips a MISSING file, and `validate` reports it as
 *   dangling. But a file that exists and cannot be read (EACCES, EISDIR, and others) must not
 *   become empty content without a warning, because importers would derive a graph with zero
 *   edges from it.
 *
 * `baseDir` lets a caller read from another location, for example an extracted HEAD tree for
 * `--diff`.
 */
export function readFiles(paths: string[], baseDir = '.'): Record<string, string> {
  const out: Record<string, string> = {};
  // Resolve the root once. The real path of every target must stay below it, which prevents
  // a symlink escape. `realpathSync` fails on a missing root only when baseDir itself is gone.
  // Callers pass an existing repository, so use the lexical path and do not crash on a race.
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
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // The file is missing. validate reports it as dangling.
      throw new Error(`cannot read ${p}: ${(e as Error).message}`);
    }
    if (real !== root && !real.startsWith(rootPrefix)) {
      throw new Error(`path "${p}" resolves outside the repo root (symlink) — fix the entry in .cells/ownership.toml (or the cell's tests field)`);
    }
    try {
      out[p] = readFileSync(full, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // The file disappeared between realpath and read.
      throw new Error(`cannot read ${p}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** The directories that the system never scans for code: dependencies, build output, and tool caches. */
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

/**
 * Skip-named directories that hold code which the census would count, or a build manifest.
 * Examples are a real `build/` Go package and a crate directory named `build`.
 *
 * `plan` reports these directories, so "0 orphans" cannot hide a package that the census
 * skipped. The skip rule stays, and the omission becomes visible.
 *
 * `node_modules`, `.git`, and `.cells` are never source. The ambiguous names (dist, build,
 * target, and others) are exactly the ones that a person should inspect. Almost pure: the
 * function reads the file system.
 */
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
          /* The directory is unreadable, so there is nothing to report. */
        }
        if (hasCode) out.push(relative(baseDir, p).replace(/\\/g, '/')); // Use posix form, as the census does. On Windows, 'internal\\build' would reach the user.
        continue; // never recurse into a skipped dir
      }
      walk(join(dir, e.name));
    }
  };
  walk(baseDir);
  return out.sort();
}

/**
 * The extensions that the system recognizes as code (for the census and ownership). Cells has
 * importers for TS/JS, Python (including .pyx and .pxd), Rust, Go, C/C++, and Java. The system
 * counts the other extensions (.rb, .kt, .swift, .cs, and others) but is BLIND to them: there
 * is no crossing analysis. The blind-extension warning in `health` reports them.
 */
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyx', '.pxd', '.rs', '.go', '.rb', '.java', '.kt', '.swift', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.hxx', '.cs']);

/**
 * Detect the languages and directories of the project by scanning the repository. `cells init`
 * uses the result, so a Python or a Rust repository does not get TypeScript-only defaults.
 *
 * The function scans the top-level directories, skips dependencies, build output, and tooling,
 * counts the files for each extension, and collects the top-level directories that hold code.
 * When it finds no code, it uses the TypeScript defaults: [".ts"] and ["src", "test"]. Pure,
 * with no configuration.
 */
export function detectProject(root = '.'): { codeExts: string[]; codeDirs: string[] } {
  const extCounts = new Map<string, number>();
  const dirHasCode = new Set<string>();

  const scan = (dir: string, topDir: string, visited: Set<string>): void => {
    walkDir(dir, visited, (path, entry, isDir) => {
      if (isDir) {
        if (SKIP_DIRS.has(entry)) return;
        scan(path, topDir, visited);
      } else {
        const ext = extname(entry).toLowerCase();
        if (CODE_EXTS.has(ext)) {
          extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
          dirHasCode.add(topDir);
        }
      }
    });
  };

  const visited = new Set<string>(); // One cycle guard span across all top-level scans.
  walkDir(
    root,
    visited,
    (path, entry, isDir) => {
      if (isDir) {
        scan(path, entry, visited);
      } else {
        const ext = extname(entry).toLowerCase();
        if (CODE_EXTS.has(ext)) {
          extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
          dirHasCode.add('.');
        }
      }
    },
    SKIP_DIRS,
  );

  if (extCounts.size === 0) return { codeExts: ['.ts'], codeDirs: ['src', 'test'] };
  const codeExts = [...extCounts.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
  let codeDirs = [...dirHasCode].sort();
  // Code files at the root make the list collapse to ["."]. Without this, every file would
  // count twice in ownership and plan.
  if (dirHasCode.has('.')) codeDirs = ['.'];
  return { codeExts, codeDirs };
}
