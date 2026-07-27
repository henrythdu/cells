import { parse as parseToml } from 'smol-toml';
import { tomlString, tomlArray } from './toml.js';

/**
 * A cell's declaration — its membrane (the contract) + identity.
 * Owned code is NOT listed here (ownership lives in the ownership map).
 */
export interface Cell {
  name: string;
  purpose: string;
  provides: string[]; // declared surface; validated later by crossing-capture
  requires: string[]; // neighbor CELL names (not symbols)
  layer?: number; // tier rank (0 = core/foundation; higher = peripheral; an edge to a higher layer is the violation). Omit = layerless.
  signatures?: string[]; // type-annotated function signatures (free-form, per-language). Included in neighbor membranes in payload — the LLM sees how to call exports without opening the neighbor's code.
}

/**
 * Parse a `.cell.toml` declaration into a Cell. Validates field types — throws a
 * clear error on a malformed file (missing/non-string name or purpose, non-string-array
 * provides/requires, non-number layer) instead of returning a half-parsed Cell.
 */
export function parseCell(content: string): Cell {
  const raw = parseToml(content) as {
    name: unknown;
    purpose: unknown;
    provides: unknown;
    requires: unknown;
    layer?: unknown;
    signatures?: unknown;
  };

  const got = (v: unknown): string => (v === undefined ? 'missing' : Array.isArray(v) ? 'array' : typeof v);
  const str = (v: unknown, field: string): string => {
    if (typeof v !== 'string') throw new Error(`invalid .cell.toml: '${field}' must be a string (got ${got(v)})`);
    return v;
  };
  const arr = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`invalid .cell.toml: '${field}' must be a string array (got ${got(v)})`);
    return v;
  };
  if (raw.layer !== undefined && typeof raw.layer !== 'number') throw new Error(`invalid .cell.toml: 'layer' must be a number (got ${typeof raw.layer})`);

  return {
    name: str(raw.name, 'name'),
    purpose: str(raw.purpose, 'purpose'),
    provides: arr(raw.provides, 'provides'),
    requires: arr(raw.requires, 'requires'),
    layer: typeof raw.layer === 'number' ? raw.layer : undefined,
    signatures: raw.signatures !== undefined ? arr(raw.signatures, 'signatures') : undefined,
  };
}

/**
 * Serialize a Cell back to `.cell.toml` — the write-inverse of parseCell.
 * Round-trips: parseCell(serializeCell(cell)) ≡ cell.
 */
export function serializeCell(cell: Cell): string {
  const lines = [`name = ${tomlString(cell.name)}`, `purpose = ${tomlString(cell.purpose)}`, `provides = ${tomlArray(cell.provides)}`, `requires = ${tomlArray(cell.requires)}`];
  if (cell.signatures && cell.signatures.length > 0) lines.push(`signatures = ${tomlArray(cell.signatures)}`);
  if (cell.layer !== undefined) lines.push(`layer = ${cell.layer}`);
  return lines.join('\n') + '\n';
}
