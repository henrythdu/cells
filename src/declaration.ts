import { parse as parseToml } from 'smol-toml';

/**
 * A cell's declaration — its membrane (the contract) + identity.
 * Owned code is NOT listed here (ownership lives in the ownership map).
 */
export interface Cell {
  name: string;
  purpose: string;
  provides: string[]; // declared surface; validated later by crossing-capture
  requires: string[]; // neighbor CELL names (not symbols)
  layer?: string; // optional Clean-Arch layer name (for direction policy)
}

/**
 * Parse a `.cell.toml` declaration into a Cell.
 * Minimal: assumes well-formed input. Validation (missing/malformed fields)
 * arrives in a later slice.
 */
export function parseCell(content: string): Cell {
  const raw = parseToml(content) as {
    name: unknown;
    purpose: unknown;
    provides: unknown;
    requires: unknown;
    layer?: unknown;
  };

  return {
    name: raw.name as string,
    purpose: raw.purpose as string,
    provides: raw.provides as string[],
    requires: raw.requires as string[],
    layer: typeof raw.layer === 'string' ? raw.layer : undefined,
  };
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
 * Serialize a Cell back to `.cell.toml` — the write-inverse of parseCell.
 * Round-trips: parseCell(serializeCell(cell)) ≡ cell.
 */
export function serializeCell(cell: Cell): string {
  const lines = [
    `name = ${tomlString(cell.name)}`,
    `purpose = ${tomlString(cell.purpose)}`,
    `provides = ${tomlArray(cell.provides)}`,
    `requires = ${tomlArray(cell.requires)}`,
  ];
  if (cell.layer) lines.push(`layer = ${tomlString(cell.layer)}`);
  return lines.join('\n') + '\n';
}
