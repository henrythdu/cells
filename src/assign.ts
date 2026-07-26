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
