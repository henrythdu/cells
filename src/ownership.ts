import { parse as parseToml } from 'smol-toml';
import { tomlString } from './toml.js';

/**
 * Ownership map: cell name → owned file paths.
 * File-atomic: a file belongs to exactly one cell (non-overlap).
 * Stored at `.cells/ownership.toml`.
 */
export type Ownership = Record<string, string[]>;

/**
 * Parse a `.cells/ownership.toml` map.
 * TOML shape: `[cellName]\nfiles = ["a.ts", "b.ts"]` — flattened to `cell → string[]`.
 * Validates each `files` is a string array — throws on a malformed entry. A `[cell]`
 * with no `files` key maps to [] (empty cell).
 */
export function parseOwnership(content: string): Ownership {
  const raw = parseToml(content) as Record<string, { files?: unknown }>;
  const result: Ownership = {};
  for (const [cell, val] of Object.entries(raw)) {
    const files = val?.files;
    if (files !== undefined && (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))) throw new Error(`invalid ownership.toml: 'files' for [${cell}] must be a string array`);
    result[cell] = (files as string[] | undefined) ?? [];
  }
  return result;
}

/**
 * Serialize an Ownership map back to `.cells/ownership.toml` — the
 * write-inverse of parseOwnership. Round-trips:
 * parseOwnership(serializeOwnership(o)) ≡ o. Empty map → ''.
 */
export function serializeOwnership(ownership: Ownership): string {
  // A non-bare cell name (dot, space…) MUST be quoted — `[a.b]` parses as a NESTED
  // table and the files silently vanish from the round-trip. CLI paths validate names
  // (validCellName); this guards hand-edited stores, the documented way to write the map.
  const key = (cell: string) => (/^[A-Za-z0-9_-]+$/.test(cell) ? cell : tomlString(cell));
  // Deterministic serialization: cells sorted, files sorted, one file per line. Default
  // .sort() = plain code-unit order — deliberately NOT localeCompare, which is
  // host-locale-dependent and would betray the determinism this format exists for.
  // The map is the one central write hotspot in a multi-author repo; with this format
  // two branches touching different cells produce disjoint line ranges and git
  // auto-merges them — the format must not amplify the hotspot into whole-file conflicts.
  // Deterministic serialization: cells sorted, files sorted, one file per line. Default
  // .sort() = plain code-unit order — deliberately NOT localeCompare, which is
  // host-locale-dependent and would betray the determinism this format exists for.
  // The map is the one central write hotspot in a multi-author repo; with this format
  // two branches touching different cells produce disjoint line ranges and git
  // auto-merges them — the format must not amplify the hotspot into whole-file conflicts.
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
 * Reverse lookup: which cell owns `file`? Returns the cell name, or undefined
 * if the file is unowned (an orphan). A query on the ownership map.
 */
export function owningCell(ownership: Ownership, file: string): string | undefined {
  for (const [cell, files] of Object.entries(ownership)) {
    if (files.includes(file)) return cell;
  }
  return undefined;
}
