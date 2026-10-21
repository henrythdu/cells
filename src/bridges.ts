import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ImportEdge, UnresolvedImport } from './imports.js';
import { SKIP_DIRS } from './io.js';
import { isUnsafePath } from './validate.js';

/**
 * Bridge crossings (ADR 0001). This module resolves imports of FFI (foreign function
 * interface) extension modules to the entry source file of the binding crate. It handles
 * the pyo3 modules that maturin declares. pyo3 is a set of Rust bindings for Python, and
 * maturin builds and packages the Rust crate.
 *
 * A pyo3 module such as `headroom._core` is a compiled artifact. A source-only repository
 * contains no `.py` or `.so` file for it, so the Python importer reports the import as
 * unresolved. The bridge map tells which crate produces the module. Then the import
 * becomes a real edge, from the `.py` file to the `.rs` file. That edge is a crossing, so
 * it marks the language change.
 *
 * The map keys are module names, and each name is declared explicitly. The source is
 * `pyproject.toml [tool.maturin] module-name` (for example `"headroom._core"`). The last
 * segment of the module name links the module to the binding crate, because maturin builds
 * the crate whose `[lib]` name is that segment. The map is declaration-only by design. A
 * fallback convention (lib name equals the import tail) reported a false positive on uv's
 * `deptry_reproducer` test fixture. That fixture is an unrelated cdylib crate whose lib
 * name collided with the tail of an unresolved import. A maturin-built crate always
 * declares `module-name`, so the fallback added nothing. No declaration means no bridge,
 * and the import stays unresolved. That result is honest.
 *
 * The ADR records a known ceiling. A built repository silences `.so` imports, so it never
 * reports them as unresolved, and they never reach this pass. Source-only repositories,
 * which are the analysis case, are fully served.
 */

interface CrateEntry {
  /** The last segment of the module name. The crate `[lib]` name produces this segment
   *  (pyo3 convention). */
  tail: string;
  /** The repository-relative path to the lib entry file of the crate. */
  entry: string;
}

interface ManifestWalk {
  cargo: string[];
  pyproject: string[];
}

/** Walk the code directories one time and collect both kinds of manifest. The bridge needs
 *  the cdylib crates and their `pyproject.toml` module-name overrides, so two full walks
 *  would waste the scan. The walk skips `SKIP_DIRS`, which is the single source of truth in
 *  `io` for dependency, build, and tooling directories. The walk guards against symlink
 *  cycles with a set of visited real paths, the same way as `io.listFiles`, because a loop
 *  must not walk forever. */
function walkManifests(dir: string, out: ManifestWalk, visited = new Set<string>()): void {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return; // The directory vanished, so there is nothing to walk.
  }
  if (visited.has(real)) return; // A symlink cycle, so stop.
  visited.add(real);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    let st: ReturnType<typeof statSync> | null;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkManifests(path, out, visited);
    else if (entry === 'Cargo.toml') out.cargo.push(path);
    else if (entry === 'pyproject.toml') out.pyproject.push(path);
  }
}

function parseTomlFile(path: string): Record<string, unknown> {
  try {
    return parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Read the cdylib crates from the collected `Cargo.toml` files. A cdylib is a Cargo crate
 *  type that produces a shared library. */
function cratesFromCargo(cargoFiles: string[], baseDir: string): CrateEntry[] {
  const crates: CrateEntry[] = [];
  for (const file of cargoFiles) {
    const toml = parseTomlFile(file);
    const lib = toml.lib as { name?: string; 'crate-type'?: string[]; path?: string } | undefined;
    if (!lib || !lib['crate-type']?.includes('cdylib')) continue;
    const name = lib.name ?? (toml.package as { name?: string } | undefined)?.name;
    if (!name) continue;
    const dir = dirname(file);
    const entry = relative(baseDir, join(dir, lib.path ?? 'src/lib.rs'))
      .split(sep)
      .join('/');
    crates.push({ tail: name, entry });
  }
  return crates;
}

/** Build the bridge map. The `pyproject.toml [tool.maturin] module-name` key (for example
 *  `"headroom._core"`) names the produced module explicitly. The tail of the module name
 *  links the module to a crate, because maturin builds the crate whose lib name is that
 *  last segment. The map is declaration-only, because a fallback convention (lib name
 *  equals the import tail) reported a false positive on uv's `deptry_reproducer` fixture. */
function readModuleNameOverrides(pyprojectFiles: string[], crates: CrateEntry[]): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const file of pyprojectFiles) {
    const toml = parseTomlFile(file);
    const tool = toml.tool as Record<string, unknown> | undefined;
    const maturin = tool?.maturin as { 'module-name'?: string } | undefined;
    const moduleName = maturin?.['module-name'];
    if (!moduleName) continue;
    const tail = moduleName.split('.').pop();
    if (!tail) continue;
    const crate = crates.find((c) => c.tail === tail);
    if (crate) overrides.set(moduleName, crate.entry);
  }
  return overrides;
}

/** Build the full bridge map, with one key per `[tool.maturin]` module-name override. The
 *  text above explains why the bare-tail convention fallback is gone. The map is empty
 *  when no cdylib crate exists or no declaration exists, so the behavior does not change.
 *  One manifest walk serves both halves. */
export function buildBridgeMap(codeDirs: readonly string[], baseDir: string): Map<string, string> {
  const found: ManifestWalk = { cargo: [], pyproject: [] };
  for (const dir of codeDirs) walkManifests(join(baseDir, dir), found);
  const crates = cratesFromCargo(found.cargo, baseDir);
  if (crates.length === 0) return new Map();
  return readModuleNameOverrides(found.pyproject, crates);
}

/** Resolve the unresolved imports through the bridge map. The function returns the new
 *  edges and the unresolved entries that remain. The function is pure over its inputs. It
 *  reads the file system one time, through the map.
 *
 *  A bridge target must pass three checks: it must stay inside the repository, it must be a
 *  file that the census walks, and it must exist. The entry in the map comes from a manifest
 *  in the repository, so a `[lib] path` that escapes the root, or a path that the census
 *  excludes, would otherwise become an edge to a file that no cell can own. The import then
 *  stays unresolved, which is the honest result. */
export function applyBridges(map: Map<string, string>, unresolved: readonly UnresolvedImport[], census: ReadonlySet<string>, baseDir = '.'): { edges: ImportEdge[]; unresolved: UnresolvedImport[] } {
  if (map.size === 0) return { edges: [], unresolved: [...unresolved] };
  const edges: ImportEdge[] = [];
  const rest: UnresolvedImport[] = [];
  for (const u of unresolved) {
    const entry = map.get(u.import); // Exact full-name match only. The match comes from a declaration, so it stays conservative.
    if (entry !== undefined && !isUnsafePath(entry) && census.has(entry) && existsSync(join(baseDir, entry))) {
      edges.push({ fromFile: u.fromFile, toFile: entry, import: u.import });
    } else {
      rest.push(u);
    }
  }
  return { edges, unresolved: rest };
}
