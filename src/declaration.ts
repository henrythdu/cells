import { parse as parseToml } from 'smol-toml';
import { tomlArray, tomlString } from './toml.js';

/** Purpose string of a stub cell — not yet authored. Detectable by view/lifecycle tools. */
export const STUB_PURPOSE = '(TODO: describe this cell)';

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
  ceiling?: number; // per-cell payload ceiling (tokens), overriding the global max-payload-tokens for THIS cell. Omit = global. A declared ceiling is still a budget — over it, size/health still flag (inform, never enforce).
  signatures?: string[]; // type-annotated function signatures (free-form, per-language). Included in neighbor membranes in payload — the LLM sees how to call exports without opening the neighbor's code.
  tests?: string[]; // test files that exercise this cell. Included in payload — the LLM sees test code alongside source code.
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
    ceiling?: unknown;
    signatures?: unknown;
    tests?: unknown;
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
  // ceiling is a budget for the size bar + pct math — a value <= 0 would crash `cells size`
  // (repeat() of a negative bar length), so it must be a positive finite number.
  if (raw.ceiling !== undefined && (typeof raw.ceiling !== 'number' || !Number.isFinite(raw.ceiling) || raw.ceiling < 1)) {
    throw new Error(`invalid .cell.toml: 'ceiling' must be a positive number (got ${raw.ceiling})`);
  }

  return {
    name: str(raw.name, 'name'),
    purpose: str(raw.purpose, 'purpose'),
    provides: arr(raw.provides, 'provides'),
    requires: arr(raw.requires, 'requires'),
    layer: typeof raw.layer === 'number' ? raw.layer : undefined,
    ceiling: typeof raw.ceiling === 'number' ? raw.ceiling : undefined,
    signatures: raw.signatures !== undefined ? arr(raw.signatures, 'signatures') : undefined,
    tests: raw.tests !== undefined ? arr(raw.tests, 'tests') : undefined,
  };
}

/**
 * Serialize a Cell back to `.cell.toml` — the write-inverse of parseCell.
 * Round-trips: parseCell(serializeCell(cell)) ≡ cell.
 *
 * For REWRITING an authored file prefer the edit* helpers below: serializeCell re-emits
 * from the parsed AST and silently drops the author's comments.
 */
export function serializeCell(cell: Cell): string {
  const lines = [`name = ${tomlString(cell.name)}`, `purpose = ${tomlString(cell.purpose)}`, `provides = ${tomlArray(cell.provides)}`, `requires = ${tomlArray(cell.requires)}`];
  if (cell.signatures && cell.signatures.length > 0) lines.push(`signatures = ${tomlArray(cell.signatures)}`);
  if (cell.tests && cell.tests.length > 0) lines.push(`tests = ${tomlArray(cell.tests)}`);
  if (cell.layer !== undefined) lines.push(`layer = ${cell.layer}`);
  if (cell.ceiling !== undefined) lines.push(`ceiling = ${cell.ceiling}`);
  return lines.join('\n') + '\n';
}

/**
 * Comment-preserving rewrite of a .cell.toml's `name` value — text surgery on the one
 * line, never parse+serialize (which would drop the author's comments). Used by rename.
 * Throws when no `name = ...` line exists (the store's files always have one — a silent
 * no-op would leave file name and declared name mismatched and brick loadDeclarations).
 */
export function editCellName(content: string, newName: string): string {
  const m = /^name[ \t]*=[ \t]*(?:"[^"\n]*"|'[^'\n]*')/m.exec(content);
  if (m === null) throw new Error(`cannot rewrite name: no \`name = ...\` line found`);
  return content.slice(0, m.index) + `name = ${tomlString(newName)}` + content.slice(m.index + m[0].length);
}

/**
 * Comment-preserving rewrite of a .cell.toml's `requires` array: remove entries and/or
 * rename one — used by rename (fixing refs), remove --force (stripping refs), and
 * prune-stale. Text surgery: comments (even per-entry ones) and formatting survive.
 * Removing every entry collapses to `requires = []`. A no-`requires` file is returned
 * unchanged (nothing to edit); a malformed array is left for parseCell to report.
 */
export function editCellRequires(content: string, opts: { remove?: string[]; rename?: [string, string] }): string {
  const key = /^[ \t]*requires[ \t]*=[ \t]*\[/m.exec(content);
  if (key === null) return content;
  const start = key.index + key[0].length; // just past '['
  // Scan to the MATCHING ']' — strings and # comments can contain ']' / '[', so a lazy
  // regex would truncate on the first one inside a comment.
  let i = start;
  let depth = 1;
  while (i < content.length) {
    const c = content[i];
    if (c === '"') {
      i++;
      while (i < content.length && content[i] !== '"') {
        if (content[i] === '\\') i++;
        i++;
      }
    } else if (c === "'") {
      i++;
      while (i < content.length && content[i] !== "'") i++;
    } else if (c === '#') {
      while (i < content.length && content[i] !== '\n') i++;
    } else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  if (depth !== 0) return content; // unterminated array — let parseCell report it
  const end = i; // index of the matching ']'
  let body = content.slice(start, end);
  for (const r of opts.remove ?? []) body = body.split(tomlString(r)).join('');
  if (opts.rename) body = body.split(tomlString(opts.rename[0])).join(tomlString(opts.rename[1]));
  if (!body.includes('"')) {
    // every entry gone — collapse the husk (comments and stray commas) to an empty array
    return content.slice(0, key.index) + 'requires = []' + content.slice(end + 1);
  }
  body = body.replace(/,\s*,/g, ',').replace(/(^|\n)[ \t]*,[ \t]*/g, '$1'); // no doubled or head-less commas (TOML allows a trailing one)
  return content.slice(0, start) + body + content.slice(end);
}
