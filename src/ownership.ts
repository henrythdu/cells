import { parse as parseToml } from 'smol-toml';

/**
 * Ownership map: cell name → owned file paths.
 * File-atomic: a file belongs to exactly one cell (non-overlap).
 * Stored at `.cells/ownership.toml`.
 */
export type Ownership = Record<string, string[]>;

/**
 * Parse a `.cells/ownership.toml` map.
 * TOML shape: `[cellName]\nfiles = ["a.ts", "b.ts"]` — flattened to `cell → string[]`.
 * Minimal: assumes well-formed. Validation arrives in a later slice.
 */
export function parseOwnership(content: string): Ownership {
  const raw = parseToml(content) as Record<string, { files: unknown }>;
  const result: Ownership = {};
  for (const [cell, val] of Object.entries(raw)) {
    result[cell] = (val.files as string[]) ?? [];
  }
  return result;
}

/** Quote a string for TOML (escape backslash + double-quote). */
function tomlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Format a string array as a TOML inline array. */
function tomlArray(arr: string[]): string {
  return '[' + arr.map(tomlString).join(', ') + ']';
}

/**
 * Serialize an Ownership map back to `.cells/ownership.toml` — the
 * write-inverse of parseOwnership. Round-trips:
 * parseOwnership(serializeOwnership(o)) ≡ o. Empty map → ''.
 */
export function serializeOwnership(ownership: Ownership): string {
  return Object.entries(ownership)
    .map(([cell, files]) => `[${cell}]\nfiles = ${tomlArray(files)}\n`)
    .join('\n');
}

/**
 * Reverse lookup: which cell owns `file`? Returns the cell name, or undefined
 * if the file is unowned (an orphan). A query on the ownership map.
 */
export function owningCell(ownership: Ownership, file: string): string | undefined {
  for (const [cell, files] of Object.entries(ownership)) {
    if (files.includes(file)) return cell;
  }
  return undefined;
}
