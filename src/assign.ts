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
