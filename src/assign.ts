import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Cell, STUB_PURPOSE } from './declaration.js';
import type { Ownership } from './ownership.js';

/**
 * Move `files` into `cell` and remove them from any other cell first, which keeps the
 * non-overlap invariant. These are move semantics. Pure: the function returns a new map. It
 * creates `cell` when the cell does not exist.
 */
export function assignFiles(ownership: Ownership, cell: string, files: string[]): Ownership {
  const next: Ownership = {};
  const move = new Set(files);
  for (const [c, owned] of Object.entries(ownership)) {
    // Keep the existing files of the target cell. Remove the moved files from every other cell.
    next[c] = c === cell ? [...owned] : owned.filter((f) => !move.has(f));
  }
  const existing = next[cell] ?? [];
  next[cell] = [...new Set([...existing, ...files])];
  return next;
}

/**
 * Remove `files` from every cell that owns them, so the files become orphans (unowned).
 * Pure: the function returns a new map. A cell that is left with no files leaves the map,
 * and its `.cell.toml` declaration is unchanged. Ownership and declaration are different
 * things.
 */
export function unassignFiles(ownership: Ownership, files: string[]): Ownership {
  const remove = new Set(files);
  const next: Ownership = {};
  for (const [cell, owned] of Object.entries(ownership)) {
    const kept = owned.filter((f) => !remove.has(f));
    if (kept.length > 0) next[cell] = kept; // Drop a cell that is left with no files.
  }
  return next;
}

/**
 * A cell name must be an identifier that is safe as a bare TOML key and as a file name:
 * letters, numbers, dashes, and underscores. The function rejects slashes and dots. This
 * guard protects `assign` from a corrupt TOML key (`[src/foo.ts]` does not parse) and from
 * path traversal. Pure.
 */
export function validCellName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/**
 * Map a plan key (a relative directory) to a cell name. The function escapes the path without
 * collisions: `-` becomes `--`, so `src/api` and `src-api` cannot collide, and a separator
 * becomes `-`.
 *
 * The result is valid only when the characters of the key are in `[A-Za-z0-9_/-]`.
 * `planGroups` folds any key that has another character.
 */
export function cellNameOf(key: string): string {
  return key.replaceAll('-', '--').replaceAll('/', '-');
}

/**
 * The proposed cell keys for `cells plan`, from the code census. The function groups the files
 * by "unit root": the deepest ancestor directory that holds a package manifest or a Python
 * `__init__.py`.
 *
 * Thus `crates/uv/src/...`, `packages/foo/src/...`, and `zerver/actions/*.py` collapse to
 * their crate or package. The 72 crates of uv no longer become about 180 directory cells, and
 * the 2016 files of zulip no longer collapse into one `root` cell.
 *
 * The rules:
 *
 * - `Cargo.toml` is a HARD boundary. Every crate is its own unit, however small, because the
 *   importer uses the crate as the namespace for crossings. A crate owns its subtree, so a
 *   Python package inside a crate (the embedded interpreter of uv) folds into the crate.
 *
 * - `__init__.py` is a HARD boundary too. A Python package is an importable namespace, so a
 *   nested package (`zerver/actions`) is its own unit and never folds into its parent. The
 *   result is one unit for each model of a transformer.
 *
 * - `package.json` is SOFT. A package inside another package directory is scaffolding or a
 *   template (`create-vite/template-*` in vite) and folds into the parent package. The
 *   `package.json` at the repository root is the workspace manifest and not a package, so it
 *   never takes the child directories.
 *
 * Manifest grouping applies only when the scan finds 2 or more distinct unit roots. A single
 * root `package.json` is the repository itself, and to collapse it into one cell would
 * destroy the current directory granularity. A file with no manifest ancestor groups by
 * directory, as before.
 *
 * Name safety: a directory whose escaped cell name would be invalid (the Next.js `[[...]]`
 * route directories) folds into its nearest valid ancestor. Therefore plan never proposes a
 * cell that it cannot create.
 *
 * The function is almost pure: the manifest probes read the file system, as the crate-root
 * walk of the Rust importer does.
 */
export function planGroups(codeFiles: string[], baseDir = '.'): Map<string, string[]> {
  // The Cargo.toml at the repository root is usually a [workspace] manifest (headroom, uv)
  // and not a crate. A crate owns its subtree, so a root workspace manifest would put every
  // file outside crates/ into '.', and plan drops the '.' key. On one real repository that
  // removed 1333 Python files from the plan.
  //
  // Only a root Cargo.toml with a [package] section is a real unit root (ripgrep has a root
  // crate and a workspace, and cxx has a single crate). It gets its OWN cell named after the
  // package. To recognize the root crate and then drop it left 126 orphans and made the main
  // crate invisible to crossings. This matches the root package.json rule below.
  //
  // When the manifest has `name.workspace = true`, the name is unparseable and the result is
  // null, so the root falls back to the '.' drop. `crateNameOf` in rust.ts has the same
  // documented limitation.
  let rootCargoIsPackage = false;
  let rootCrateName: string | null = null;
  try {
    const cargoToml = readFileSync(join(baseDir, 'Cargo.toml'), 'utf8');
    rootCargoIsPackage = /^\s*\[package\]/m.test(cargoToml);
    if (rootCargoIsPackage) {
      const section = cargoToml.match(/^\[package\][^[]*/m);
      const name = section?.[0].match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      rootCrateName = name ? name[1] : null;
    }
  } catch {
    rootCargoIsPackage = false;
  }
  // All manifest directories above a directory, the deepest first, each with its manifest kind.
  const manifestAncestors = (dir: string): { dir: string; kind: 'cargo' | 'pkg' | 'pyinit' }[] => {
    const out: { dir: string; kind: 'cargo' | 'pkg' | 'pyinit' }[] = [];
    let d = dir;
    for (;;) {
      const cargo = existsSync(join(baseDir, d, 'Cargo.toml')) && (d !== '.' || rootCargoIsPackage);
      const pkg = existsSync(join(baseDir, d, 'package.json'));
      const pyinit = existsSync(join(baseDir, d, '__init__.py'));
      if (cargo) out.push({ dir: d, kind: 'cargo' });
      else if (pyinit)
        out.push({ dir: d, kind: 'pyinit' }); // A Python package takes precedence over a package.json in the same directory (hard against soft).
      else if (pkg) out.push({ dir: d, kind: 'pkg' });
      const parent = dirname(d);
      if (parent === d) return out;
      d = parent;
    }
  };
  const unitRoot = (dir: string): string | null => {
    const ancestors = manifestAncestors(dir);
    if (ancestors.length === 0) return null;
    // A crate owns its whole subtree, so a bundled python/ directory stays in the crate (uv
    // embeds one).
    //
    // The root crate (the '.' ancestor) is keyed by its package NAME and not by '.', so the
    // `key === '.'` drop below never sees it. The root crate is a real unit and not junk.
    for (const a of ancestors) {
      if (a.kind === 'cargo') return a.dir === '.' && rootCrateName ? rootCrateName : a.dir;
    }
    const deepest = ancestors[0];
    if (deepest.kind === 'pyinit') return deepest.dir; // A Python package is a hard boundary.
    // Package case: fold a nested package into its parent package. The root manifest is the workspace.
    const parent = ancestors[1];
    if (parent && parent.dir !== '.' && parent.kind === 'pkg') return parent.dir;
    return deepest.dir;
  };
  const roots = new Set<string>();
  for (const f of codeFiles) {
    const r = unitRoot(dirname(f.replaceAll('\\', '/')));
    if (r) roots.add(r);
  }
  const useUnits = roots.size >= 2 || (roots.size === 1 && !roots.has('.')); // lone root manifest = the repo itself; a lone non-root package is still a unit
  const groups = new Map<string, string[]>();
  for (const f of codeFiles) {
    const dir = dirname(f.replaceAll('\\', '/'));
    const unit = useUnits ? unitRoot(dir) : null;
    let key = unit ?? dir;
    // Fold the key until its escaped name is a valid cell name. Plan never proposes a cell that it cannot create.
    while (key !== '.' && !validCellName(cellNameOf(key))) {
      key = dirname(key);
    }
    // The function does not propose a file with no unit and no valid-name directory. The file
    // stays unowned, which is neutral. A catch-all `root` cell would collect junk into one
    // cell of several million tokens. `list` shows the unowned files as orphans, and
    // `plan --apply` does not touch them.
    if (key === '.') continue;
    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }
  return groups;
}

/**
 * Apply a plan in one batch (`cells plan --apply`). The function creates stub declarations
 * for new cells and adds the proposed files to ownership, and it does NOT take a file that
 * another cell already owns.
 *
 * The plan is for fresh partitioning, so curated cells keep their files. The function never
 * overwrites a cell that has a declaration (it skips the cell), because the requires and
 * provides values of that cell can be curated.
 *
 * Pure. The CLI writes the returned stubs and ownership map. A proposed cell whose files are
 * all kept gets nothing.
 */
export function planApply(ownership: Ownership, proposed: Map<string, string[]>, existingNames: ReadonlySet<string>): { stubs: Cell[]; ownership: Ownership; skipped: number; adopted: number; kept: number } {
  const ownedBy = new Map<string, string>();
  for (const [cell, files] of Object.entries(ownership)) for (const f of files) ownedBy.set(f, cell);
  const next: Ownership = { ...ownership };
  const stubs: Cell[] = [];
  let skipped = 0;
  let adopted = 0;
  let kept = 0;
  for (const [name, files] of [...proposed.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const adopt = files.filter((f) => !ownedBy.has(f));
    kept += files.length - adopt.length;
    adopted += adopt.length;
    if (adopt.length === 0) {
      if (existingNames.has(name)) skipped++; // The cell is already there, and there is nothing to add.
      continue;
    }
    for (const f of adopt) ownedBy.set(f, name); // Keep the non-overlap invariant for overlapping proposals.
    const cellFiles = next[name] ? [...next[name]] : [];
    next[name] = [...cellFiles, ...adopt]; // The sets adopt and cellFiles do not intersect by construction, because ownedBy contains the files of this cell.
    if (existingNames.has(name)) skipped++;
    else stubs.push({ name, purpose: STUB_PURPOSE, provides: [], requires: [] });
  }
  return { stubs, ownership: next, skipped, adopted, kept };
}

/**
 * The pure plan for `cells assign <cell> <file...>`. The function validates the name, decides
 * whether to create a stub declaration, and computes the next ownership map. It does NO
 * input or output: the caller passes `cellExists` in, and the CLI reads the file system.
 *
 * The CLI applies the result: it writes the stub first when there is one, and then the
 * ownership map, so a write failure leaves no inconsistent state. The function throws on an
 * invalid cell name, which is the mutation contract, and the top-level catch of the CLI
 * reports it as `cells: <message>`.
 */
export function planAssignment(ownership: Ownership, cell: string, files: string[], cellExists: boolean): { stub: Cell | null; ownership: Ownership } {
  if (!validCellName(cell)) {
    throw new Error(`invalid cell name "${cell}" — use only letters, numbers, dashes, underscores.`);
  }
  return {
    stub: cellExists ? null : { name: cell, purpose: STUB_PURPOSE, provides: [], requires: [] },
    ownership: assignFiles(ownership, cell, files),
  };
}
