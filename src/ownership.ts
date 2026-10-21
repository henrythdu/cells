import { parse as parseToml } from 'smol-toml';
import { tomlString } from './toml.js';

/**
 * The ownership map: cell name to owned file paths. A file belongs to exactly one cell, so
 * ownership never overlaps. The map is stored in `.cells/ownership.toml`.
 */
export type Ownership = Record<string, string[]>;

/**
 * Parse a `.cells/ownership.toml` map.
 *
 * The TOML shape is `[cellName]\nfiles = ["a.ts", "b.ts"]`. The function flattens it to
 * `cell -> string[]`.
 *
 * The function validates that each `files` value is a string array and throws on a
 * malformed entry. A `[cell]` table with no `files` key maps to an empty array.
 */
export function parseOwnership(content: string): Ownership {
  const raw = parseToml(content) as Record<string, { files?: unknown }>;
  const result: Ownership = {};
  for (const [cell, val] of Object.entries(raw)) {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) throw new Error(`invalid ownership.toml: [${cell}] must be a table with a 'files' string array`);
    const files = (val as { files?: unknown }).files;
    if (files !== undefined && (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))) throw new Error(`invalid ownership.toml: 'files' for [${cell}] must be a string array`);
    result[cell] = (files as string[] | undefined) ?? [];
  }
  return result;
}

/**
 * Serialize an ownership map to `.cells/ownership.toml`. This function is the inverse of
 * `parseOwnership`: `parseOwnership(serializeOwnership(o))` equals `o`. An empty map
 * produces an empty string.
 */
export function serializeOwnership(ownership: Ownership): string {
  // A cell name that is not bare (it contains a dot, a space, or another special
  // character) MUST be quoted. `[a.b]` parses as a nested table, and the files silently
  // disappear from the round-trip. The CLI paths validate names with `validCellName`.
  // This guard protects hand-edited stores, which are the documented way to write the map.
  const key = (cell: string) => (/^[A-Za-z0-9_-]+$/.test(cell) ? cell : tomlString(cell));
  // Deterministic serialization: cells sorted, files sorted, one file per line.
  // `.sort()` compares code units and is deliberately not `localeCompare`, which depends
  // on the host locale and would break the determinism this format exists for.
  //
  // The map is the one central write hotspot in a repository with several authors. With
  // this format, two branches that change different cells produce separate line ranges,
  // and git merges them automatically. The format must not turn the hotspot into
  // whole-file conflicts.
  return Object.keys(ownership)
    .sort()
    .map((cell) => {
      const files = [...ownership[cell]].sort();
      const body = files.length === 0 ? 'files = []' : `files = [\n${files.map((f) => `  ${tomlString(f)},`).join('\n')}\n]`;
      return `[${key(cell)}]\n${body}\n`;
    })
    .join('\n');
}

/**
 * Reverse lookup. The function returns the name of the cell that owns `file`, or
 * `undefined` when no cell owns the file (an orphan). It is a query on the ownership map.
 */
export function owningCell(ownership: Ownership, file: string): string | undefined {
  for (const [cell, files] of Object.entries(ownership)) {
    if (files.includes(file)) return cell;
  }
  return undefined;
}
