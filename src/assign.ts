import type { Ownership } from './ownership.js';
import { STUB_PURPOSE, type Cell } from './declaration.js';

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
