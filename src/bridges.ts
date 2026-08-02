import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ImportEdge, UnresolvedImport } from './imports.js';

/**
 * Bridge crossings (ADR 0001): resolve FFI extension-module imports (pyo3/napi) to the
 * binding crate's entry source file. A pyo3 module like headroom._core is a compiled
 * artifact — no .py/.so in a source-only repo, so the python importer reports it
 * unresolved. The bridge map (declaration-derived, ownership-derived — reads the repo's
 * own Cargo.toml/pyproject.toml, no per-repo config) says which crate produces it, and the
 * import becomes a real edge: from .py → to .rs, a crossing that marks the language change.
 *
 * The map keys are module names; a bare-tail key (lib name, pyo3 convention: the module's
 * last segment == [lib] name) matches any import whose last '.'-segment equals it, and a
 * full-name key from [tool.maturin] module-name overrides when present. The pass only
 * rewrites UNRESOLVED local imports — external imports stay silent, resolved imports never
 * reach it — so the false-positive window is an unresolved import whose tail collides with
 * an unrelated cdylib lib name (rare, and the edge beats leaving it unresolved).
 *
 * Known ceiling (in the ADR): a BUILT repo that silences .so imports never reports them as
 * unresolved, so they don't reach this pass. Source-only repos — the analysis case — are
 * fully served.
 */

interface CrateEntry {
  /** The module tail the crate's [lib] name produces (pyo3 convention). */
  tail: string;
  /** Repo-relative path to the crate's lib entry file. */
  entry: string;
}

function walkToml(dir: string, name: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === '.cells' || entry === '.git' || entry === 'node_modules' || entry === 'target' || entry === 'vendor') continue;
    const path = join(dir, entry);
    let st: ReturnType<typeof statSync> | null;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkToml(path, name, out);
    else if (entry === name) out.push(path);
  }
}

function parseTomlFile(path: string): Record<string, unknown> {
  try {
    return parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Scan a repo's Cargo.toml files for cdylib crates ([lib] crate-type) — the crates that
 *  produce importable extension modules. Reads `[lib] name/path`; entry defaults to
 *  src/lib.rs (Cargo's [lib] default) when no path is declared. */
export function scanCdylibCrates(codeDirs: readonly string[], baseDir: string): CrateEntry[] {
  const files: string[] = [];
  for (const dir of codeDirs) walkToml(join(baseDir, dir), 'Cargo.toml', files);
  const crates: CrateEntry[] = [];
  for (const file of files) {
    const toml = parseTomlFile(file);
    const lib = toml['lib'] as { name?: string; 'crate-type'?: string[]; path?: string } | undefined;
    const crateType = lib?.['crate-type'];
    if (!crateType || !crateType.includes('cdylib')) continue;
    const name = lib?.name ?? (toml['package'] as { name?: string } | undefined)?.name;
    if (!name) continue;
    const dir = dirname(file);
    const entry = relative(baseDir, join(dir, lib?.path ?? 'src/lib.rs')).split(sep).join('/');
    crates.push({ tail: name, entry });
  }
  return crates;
}

/** The module-name overrides: pyproject.toml [tool.maturin] module-name ("headroom._core")
 *  explicitly names the produced module. Linked to a crate by its tail (maturin builds the
 *  crate whose lib name is the module's last segment). */
function readModuleNameOverrides(codeDirs: readonly string[], baseDir: string, crates: CrateEntry[]): Map<string, string> {
  const files: string[] = [];
  for (const dir of codeDirs) walkToml(join(baseDir, dir), 'pyproject.toml', files);
  const overrides = new Map<string, string>();
  for (const file of files) {
    const toml = parseTomlFile(file);
    const tool = toml['tool'] as Record<string, unknown> | undefined;
    const maturin = tool?.['maturin'] as { 'module-name'?: string } | undefined;
    const moduleName = maturin?.['module-name'];
    if (!moduleName) continue;
    const tail = moduleName.split('.').pop()!;
    const crate = crates.find((c) => c.tail === tail);
    if (crate) overrides.set(moduleName, crate.entry);
  }
  return overrides;
}

/** The full bridge map: full-name overrides first, then bare-tail keys (deduped — an
 *  override's tail key would duplicate its crate's tail entry; the exact key wins by
 *  lookup order, so dropping the duplicate is safe). */
export function buildBridgeMap(codeDirs: readonly string[], baseDir: string): Map<string, string> {
  const crates = scanCdylibCrates(codeDirs, baseDir);
  if (crates.length === 0) return new Map();
  const map = readModuleNameOverrides(codeDirs, baseDir, crates);
  // Full-name overrides are authoritative for their crate — skip the crate's bare-tail
  // duplicate (the exact key wins by lookup order in applyBridges anyway).
  const overriddenTails = new Set([...map.keys()].map((k) => k.split('.').pop() as string));
  for (const c of crates) {
    if (overriddenTails.has(c.tail)) continue;
    map.set(c.tail, c.entry);
  }
  return map;
}

/** Resolve unresolved imports through the bridge map. Returns the new edges + the
 *  unresolved entries that remain. Pure over its inputs (reads the FS once, via the map). */
export function applyBridges(
  map: Map<string, string>,
  unresolved: readonly UnresolvedImport[],
  baseDir = '.',
): { edges: ImportEdge[]; unresolved: UnresolvedImport[] } {
  if (map.size === 0) return { edges: [], unresolved: [...unresolved] };
  const edges: ImportEdge[] = [];
  const rest: UnresolvedImport[] = [];
  for (const u of unresolved) {
    const full = map.get(u.import);
    const tail = u.import.split('.').pop()!;
    const entry = full ?? (tail !== u.import ? map.get(tail) : undefined);
    if (entry && existsSync(join(baseDir, entry))) {
      edges.push({ fromFile: u.fromFile, toFile: entry, import: u.import });
    } else {
      rest.push(u);
    }
  }
  return { edges, unresolved: rest };
}
