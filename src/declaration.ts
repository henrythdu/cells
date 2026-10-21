import { parse as parseToml } from 'smol-toml';
import { tomlArray, tomlString } from './toml.js';

/** The purpose string of a stub cell, before an author writes the purpose. Tools can detect it. */
export const STUB_PURPOSE = '(TODO: describe this cell)';

/**
 * The declaration of a cell: its membrane (the contract) and its identity. The owned code
 * is NOT in this file. The ownership map holds that data.
 */
export interface Cell {
  name: string;
  purpose: string;
  provides: string[]; // The declared surface. The crossing check validates it later.
  requires: string[]; // The CELL names of the neighbors. These are not symbols.
  dataRequires?: string[]; // Neighbors that are coupled through channels that static analysis cannot see: data files, modules loaded at runtime, and shared schemas. The system checks integrity and includes the entry in payloads. The system never marks it stale, because there is no import to compare. It never satisfies an undeclared crossing, because a real import is a code dependency and belongs in requires.
  layer?: number; // The tier rank. 0 is core or foundation, and a higher value is more peripheral. An edge to a higher layer is a violation. Omit for no layer.
  ceiling?: number; // The payload ceiling for this cell in tokens. It overrides the global max-payload-tokens for THIS cell. Omit to use the global value. The ceiling is still a budget: when the payload is over it, size and health still report the condition (inform, never enforce).
  signatures?: string[]; // Type-annotated function signatures in a free form for each language. The system includes them in the neighbor membranes in a payload, so a model can call the exports without opening the code of the neighbor.
  tests?: string[]; // The test files that exercise this cell. The system includes them in the payload, so a model sees the test code with the source code.
}

/**
 * Parse a `.cell.toml` declaration into a Cell.
 *
 * The function validates the field types and throws a clear error for a malformed file. The
 * error cases are a missing or non-string name or purpose, a non-string-array provides or
 * requires value, and a non-number layer. The function never returns a half-parsed Cell.
 */
export function parseCell(content: string): Cell {
  const raw = parseToml(content) as {
    name: unknown;
    purpose: unknown;
    provides: unknown;
    requires: unknown;
    'data-requires'?: unknown;
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
  // The ceiling is a budget for the size bar and the percentage math. A value of 0 or less
  // would crash `cells size`, because `repeat()` gets a negative bar length. Therefore the
  // value must be a positive finite number.
  if (raw.ceiling !== undefined && (typeof raw.ceiling !== 'number' || !Number.isFinite(raw.ceiling) || raw.ceiling < 1)) {
    throw new Error(`invalid .cell.toml: 'ceiling' must be a positive number (got ${raw.ceiling})`);
  }

  return {
    name: str(raw.name, 'name'),
    purpose: str(raw.purpose, 'purpose'),
    provides: arr(raw.provides, 'provides'),
    requires: arr(raw.requires, 'requires'),
    dataRequires: raw['data-requires'] === undefined ? undefined : arr(raw['data-requires'], 'data-requires'),
    layer: typeof raw.layer === 'number' ? raw.layer : undefined,
    ceiling: typeof raw.ceiling === 'number' ? raw.ceiling : undefined,
    signatures: raw.signatures !== undefined ? arr(raw.signatures, 'signatures') : undefined,
    tests: raw.tests !== undefined ? arr(raw.tests, 'tests') : undefined,
  };
}

/**
 * Serialize a Cell to `.cell.toml`. This function is the inverse of `parseCell`:
 * `parseCell(serializeCell(cell))` equals `cell`.
 *
 * To rewrite an authored file, use the `edit*` helpers below. `serializeCell` writes from
 * the parsed AST and silently drops the comments of the author.
 */
export function serializeCell(cell: Cell): string {
  const lines = [`name = ${tomlString(cell.name)}`, `purpose = ${tomlString(cell.purpose)}`, `provides = ${tomlArray(cell.provides)}`, `requires = ${tomlArray(cell.requires)}`];
  // The field is omitted when it is empty or absent, so the round-trip keeps the absence.
  if (cell.dataRequires && cell.dataRequires.length > 0) lines.push(`data-requires = ${tomlArray(cell.dataRequires)}`);
  if (cell.signatures && cell.signatures.length > 0) lines.push(`signatures = ${tomlArray(cell.signatures)}`);
  if (cell.tests && cell.tests.length > 0) lines.push(`tests = ${tomlArray(cell.tests)}`);
  if (cell.layer !== undefined) lines.push(`layer = ${cell.layer}`);
  if (cell.ceiling !== undefined) lines.push(`ceiling = ${cell.ceiling}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Rewrite the `name` value in a `.cell.toml` and keep the comments. The function edits the
 * text of the one line and does not parse and serialise the file, because that would drop
 * the comments of the author. `rename` uses this function.
 *
 * The function throws when the file has no `name = ...` line. A file in the store always
 * has one. A silent no-op would make the file name and the declared name different, and
 * `loadDeclarations` would fail.
 */
export function editCellName(content: string, newName: string): string {
  const m = /^name[ \t]*=[ \t]*(?:"(?:[^"\\\n]|\\.)*"|'[^'\n]*')/m.exec(content);
  if (m === null) throw new Error(`cannot rewrite name: no \`name = ...\` line found`);
  return `${content.slice(0, m.index)}name = ${tomlString(newName)}${content.slice(m.index + m[0].length)}`;
}

/**
 * Rewrite the `requires` array in a `.cell.toml` and keep the comments. The function
 * removes entries, renames one entry, or does both.
 *
 * `rename` uses it to repair references. `remove --force` uses it to remove references,
 * and `prune-stale` uses it to drop stale entries. The function edits the text, so the
 * comments (including comments for one entry) and the formatting stay. A comment keeps its
 * text even when it quotes the removed or renamed name, because the entry is matched as a
 * TOML string and not as a substring.
 *
 * When the function removes every entry, the array becomes `requires = []`. A file with no
 * `requires` key is returned unchanged. A malformed array is left for `parseCell` to report.
 */
export function editCellRequires(content: string, opts: { remove?: string[]; rename?: [string, string] }): string {
  return editKeyedArray(content, 'requires', opts);
}

/**
 * Apply the same rewrite to `data-requires`. A rename and a force-remove must keep its
 * references consistent too, because it names cells in the same way as `requires`.
 */
export function editCellDataRequires(content: string, opts: { remove?: string[]; rename?: [string, string] }): string {
  return editKeyedArray(content, 'data-requires', opts);
}

/**
 * Walk the body of an array and remove or rename the entries that match. Comment text is
 * copied verbatim, because a comment can quote a cell name for its own reasons. An entry
 * that goes takes its separating comma with it, and the indentation of a line that the
 * removal empties, so a comment on that line keeps its place and its spacing.
 *
 * An entry is compared by its VALUE, so the quoted form, the literal form, and an escaped
 * spelling such as `"\u0062"` all name the same cell. A multi-line string is refused by the
 * caller, because a value that spans lines cannot be matched with a single-line scan.
 *
 * The function returns an empty string when no entry remains, which the caller turns into
 * an empty array. Pure.
 */
function editArrayBody(body: string, remove: string[], rename: [string, string] | undefined): string {
  // Decode one string literal to the cell name it spells. A literal with no backslash needs no
  // TOML parse, which is the common case, so the parse runs only when an escape can exist.
  const literalValue = (raw: string): string => {
    const inner = raw.slice(1, -1);
    if (!inner.includes('\\')) return inner;
    try {
      return String((parseToml(`v = ${raw}`) as { v: unknown }).v);
    } catch {
      return inner; // A malformed escape is left for parseCell to report.
    }
  };
  const drop = new Set(remove);
  const to = rename ? tomlString(rename[1]) : undefined;
  let out = '';
  let entries = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '#') {
      const nl = body.indexOf('\n', i);
      const stop = nl === -1 ? body.length : nl;
      out += body.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < body.length && body[j] !== c) {
        if (c === '"' && body[j] === '\\') j++;
        j++;
      }
      const stop = Math.min(j + 1, body.length);
      const raw = body.slice(i, stop);
      i = stop;
      const value = literalValue(raw);
      if (drop.has(value)) {
        let k = i;
        while (k < body.length && (body[k] === ' ' || body[k] === '\t')) k++;
        if (body[k] === ',') {
          k++;
          while (k < body.length && (body[k] === ' ' || body[k] === '\t')) k++;
          if (body[k] === '\n') {
            k++;
            // The line is gone, so the indent that began it goes too. Without this trim the
            // next line's indent stacks on top of it and the file drifts on every run.
            out = out.replace(/[ \t]*$/, '');
          }
          i = k;
        } else {
          out = out.replace(/[ \t]*,[ \t]*$/, '');
        }
        continue;
      }
      if (rename !== undefined && value === rename[0]) {
        out += to;
        entries++;
        continue;
      }
      entries++;
      out += raw;
      continue;
    }
    out += c;
    i++;
  }
  return entries === 0 ? '' : out;
}

/**
 * The shared body of the rewrite helpers: replace the `key = [...]` array in place. The key
 * pattern matches at the start of a line and is anchored, so `requires` never matches a
 * `data-requires` line, and the reverse is also true. A multi-line string is refused, because
 * a single-line scan cannot rewrite it safely.
 */
function editKeyedArray(content: string, key: string, opts: { remove?: string[]; rename?: [string, string] }): string {
  const m = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*\\[`, 'm').exec(content);
  if (m === null) return content;
  const start = m.index + m[0].length; // The index directly after '['.
  // Scan to the matching ']'. A string or a # comment can contain ']' or '[', so a lazy
  // pattern would stop at the first such character inside a comment.
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
  if (depth !== 0) return content; // The array is not closed. Return the content unchanged and let parseCell report it.
  const end = i; // The index of the matching ']'.
  if (!opts.remove?.length && opts.rename === undefined) return content;
  const rawBody = content.slice(start, end);
  // A multi-line string cannot be matched with a single-line scan, and a half-rewritten one
  // would leave invalid TOML. Refuse instead of writing it.
  if (rawBody.includes('"""') || rawBody.includes("'''")) throw new Error(`${key} uses a multi-line string — edit the ${key} entry by hand`);
  const body = editArrayBody(rawBody, opts.remove ?? [], opts.rename);
  if (body === '') {
    // Every entry is gone. Collapse the remaining text (comments and stray commas) to an
    // empty array.
    return `${content.slice(0, m.index)}${key} = []${content.slice(end + 1)}`;
  }
  const cleaned = body.replace(/,\s*,/g, ',').replace(/(^|\n)[ \t]*,[ \t]*/g, '$1'); // Remove doubled commas and commas at the start of a line. TOML permits a trailing comma.
  return content.slice(0, start) + cleaned + content.slice(end);
}
