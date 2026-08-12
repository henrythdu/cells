import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Cell, STUB_PURPOSE } from './declaration.js';
import type { Ownership } from './ownership.js';

/**
 * Move `files` into `cell`, removing them from any other cell first
 * (non-overlap is preserved — move semantics). Pure: returns a new map.
 * Creates `cell` if it didn't exist.
 */
export function assignFiles(ownership: Ownership, cell: string, files: string[]): Ownership {
  const next: Ownership = {};
  for (const [c, owned] of Object.entries(ownership)) {
    // keep the target cell's existing files; strip the moved files from everyone else
    next[c] = c === cell ? [...owned] : owned.filter((f) => !files.includes(f));
  }
  const existing = next[cell] ?? [];
  next[cell] = [...new Set([...existing, ...files])];
  return next;
}

/**
 * Remove `files` from any cell that owns them → orphan (unowned). Pure: returns
 * a new map. A cell left with no files drops out of the map; its `.cell.toml`
 * declaration is untouched (ownership ≠ declaration).
 */
export function unassignFiles(ownership: Ownership, files: string[]): Ownership {
  const remove = new Set(files);
  const next: Ownership = {};
  for (const [cell, owned] of Object.entries(ownership)) {
    const kept = owned.filter((f) => !remove.has(f));
    if (kept.length > 0) next[cell] = kept; // drop cells left empty
  }
  return next;
}

/** A cell name must be a TOML-bare-key-safe + filename-safe identifier: letters,
 *  numbers, dashes, underscores. Rejects slashes/dots — guards assign against both
 *  invalid-TOML-key corruption (`[src/foo.ts]` is unparseable) and path traversal.
 *  Pure. */
export function validCellName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/** The cell name a plan key (relative dir) maps to: escape the path injectively —
 *  '-' → '--' (so 'src/api' and 'src-api' can't collide), separator → '-'. The result is
 *  valid iff the key chars are in [A-Za-z0-9_/-] — planGroups folds anything else. */
export function cellNameOf(key: string): string {
  return key.replaceAll('-', '--').replaceAll('/', '-');
}

/** Proposed cell keys for `cells plan`, from the code census. Groups by "unit root" — the
 *  deepest ancestor dir holding a package manifest or a Python `__init__.py` — so
 *  `crates/uv/src/…`, `packages/foo/src/…`, and `zerver/actions/*.py` collapse to their
 *  crate/package (uv's 72 crates stop exploding into ~180 dir-cells; zulip's 2016 files stop
 *  collapsing into one `root` cell). Rules:
 *  - Cargo.toml is a HARD boundary: any crate, however small, is its own unit (it's the
 *    namespace the importer keys crossings on) — and it owns its subtree, so a python package
 *    bundled inside a crate (uv's embedded interpreter) folds into the crate.
 *  - `__init__.py` is a HARD boundary too: a Python package is an importable namespace, so a
 *    nested package (zerver/actions) is its own unit, never folded into its parent (transformer
 *    per-model granularity).
 *  - package.json is SOFT: a package nested inside another package dir is scaffolding/template
 *    (vite's create-vite/template-*) and folds into its parent package; the repo root's own
 *    package.json is the workspace manifest, not a package, so it never swallows children.
 *  Manifest grouping applies only when the scan finds ≥2 distinct unit roots: a lone root
 *  package.json is the repo itself, and collapsing it into one cell would destroy today's
 *  directory granularity. Files with no manifest ancestor group by directory, as before.
 *  Name safety: dirs whose escaped cell name would be invalid (Next.js `[[…]]` route dirs)
 *  fold to their nearest valid ancestor — plan never proposes un-creatable cells.
 *  Pure-ish: manifest probes hit the FS (like the rust importer's crate-root walk). */
export function planGroups(codeFiles: string[], baseDir = '.'): Map<string, string[]> {
  // The repo-root Cargo.toml is usually a [workspace] manifest (headroom, uv), not a crate —
  // a crate owns its subtree, so a root workspace manifest would swallow every file outside
  // crates/ into '.', which plan drops (key === '.') — headroom's 1333 python files vanished
  // from the plan. Only a root Cargo.toml WITH a [package] section (ripgrep: root crate +
  // workspace; cxx: single crate) is a real unit root. It gets its OWN cell named after the
  // package (stress #17: the old behavior recognized the root crate and then dropped it —
  // 126 orphans, 1 edge, main crate invisible to crossings). Mirrors the root-package.json
  // rule below. `name.workspace = true` → unparseable name → null → root falls back to the
  // '.' drop (pre-fix behavior; rust.ts's crateNameOf has the same documented limitation).
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
  // all manifest dirs above a dir, deepest first (each with its manifest kind)
  const manifestAncestors = (dir: string): { dir: string; kind: 'cargo' | 'pkg' | 'pyinit' }[] => {
    const out: { dir: string; kind: 'cargo' | 'pkg' | 'pyinit' }[] = [];
    let d = dir;
    for (;;) {
      const cargo = existsSync(join(baseDir, d, 'Cargo.toml')) && (d !== '.' || rootCargoIsPackage);
      const pkg = existsSync(join(baseDir, d, 'package.json'));
      const pyinit = existsSync(join(baseDir, d, '__init__.py'));
      if (cargo) out.push({ dir: d, kind: 'cargo' });
      else if (pyinit)
        out.push({ dir: d, kind: 'pyinit' }); // a python package beats a co-located package.json (hard vs soft)
      else if (pkg) out.push({ dir: d, kind: 'pkg' });
      const parent = dirname(d);
      if (parent === d) return out;
      d = parent;
    }
  };
  const unitRoot = (dir: string): string | null => {
    const ancestors = manifestAncestors(dir);
    if (ancestors.length === 0) return null;
    // a crate owns its whole subtree — bundled python/ dirs stay in the crate (uv embeds one).
    // The root crate (' . ' ancestor) is keyed by its package NAME, not '.', so the
    // `key === '.'` drop below never sees it (stress #17: the root crate was recognized,
    // then orphaned).
    for (const a of ancestors) {
      if (a.kind === 'cargo') return a.dir === '.' && rootCrateName ? rootCrateName : a.dir;
    }
    const deepest = ancestors[0];
    if (deepest.kind === 'pyinit') return deepest.dir; // python package = hard boundary
    // package: fold a nested package into its parent package (root manifest is the workspace)
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
    // fold until the escaped name is a valid cell name — plan never proposes un-creatable cells
    while (key !== '.' && !validCellName(cellNameOf(key))) {
      key = dirname(key);
    }
    // Files with no unit (and no valid-name dir) are NOT proposed — they stay unowned,
    // which is neutral (wave-3 #8: the old catch-all `root` cell swept junk into a 5.9M-tok
    // cell; unowned files are listed as orphans instead, and plan --apply leaves them be).
    if (key === '.') continue;
    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }
  return groups;
}

/** Batch-apply a plan (`cells plan --apply`): create stub declarations for new cells and add
 *  the proposed files to ownership WITHOUT stealing files already owned elsewhere (the plan is
 *  for fresh partitioning — curated cells keep their files). Cells with an existing declaration
 *  are never overwritten (skipped) — their requires/provides may be curated. Pure: cli writes
 *  the returned stubs + ownership. A proposed cell whose files are all kept gets nothing. */
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
      if (existingNames.has(name)) skipped++; // already there, nothing to add
      continue;
    }
    for (const f of adopt) ownedBy.set(f, name); // keep the non-overlap invariant for overlapping proposals
    const cellFiles = next[name] ? [...next[name]] : [];
    next[name] = [...cellFiles, ...adopt]; // adopt ∩ cellFiles is empty by construction (ownedBy covers this cell's own files)
    if (existingNames.has(name)) skipped++;
    else stubs.push({ name, purpose: STUB_PURPOSE, provides: [], requires: [] });
  }
  return { stubs, ownership: next, skipped, adopted, kept };
}

/** Pure plan for `cells assign <cell> <file...>`: validate the name, decide whether
 *  a stub declaration is needed (cell is new), and compute the next ownership. Does
 *  NO I/O — `cellExists` is passed in (cli reads the filesystem). cli applies the
 *  result: write the stub first (if any), then ownership, so a write failure leaves
 *  no dirty state. Throws on an invalid cell name (the mutation contract) — cli's
 *  top-level catch surfaces it as `cells: <message>`. */
export function planAssignment(ownership: Ownership, cell: string, files: string[], cellExists: boolean): { stub: Cell | null; ownership: Ownership } {
  if (!validCellName(cell)) {
    throw new Error(`invalid cell name "${cell}" — use only letters, numbers, dashes, underscores.`);
  }
  return {
    stub: cellExists ? null : { name: cell, purpose: STUB_PURPOSE, provides: [], requires: [] },
    ownership: assignFiles(ownership, cell, files),
  };
}
