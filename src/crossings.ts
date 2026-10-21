import type { Cell } from './declaration.js';
import type { ImportEdge } from './imports.js';
import { type Ownership, owningCell } from './ownership.js';

/** A crossing between cells: the code of cell A imports the code of cell B. */
export interface Crossing {
  fromCell: string;
  toCell: string;
  fromFile: string;
  toFile: string;
  import: string;
}

/**
 * The result of the named-consumption check for one pair of cells. This warning never
 * fails the gate.
 *
 * `missing` holds the names that `fromCell` imports from `toCell`, and that `toCell` does
 * not offer in its membrane.
 *
 * `emptyProvides` is the stronger case. The importing cell uses names from the target
 * cell, but the target cell has an empty `provides` list.
 */
export interface OffMembraneImport {
  fromCell: string;
  toCell: string;
  importedCount: number;
  missing: string[];
  emptyProvides: boolean;
}

/**
 * The provides contract check. The function groups the symbol-bearing edges by cell pair
 * and compares the consumed names with the `provides` list of the target cell. The
 * `provides` list is the offer surface that justifies the `requires` entries of other
 * cells.
 *
 * Only symbol-bearing edges participate. Module dependencies, namespace imports, and
 * importers that do not keep symbols are exempt by construction, because their edges
 * carry no symbols. That gap is honest, and the README lists it for each language.
 *
 * This is a warning only. A `provides` list is authored prose that improves over time. A
 * gate failure on the first day would discourage authors from writing the list at all.
 * Pure.
 */
export function checkOffMembrane(edges: ImportEdge[], ownership: Ownership, declarations: Record<string, Cell>): OffMembraneImport[] {
  const agg = new Map<string, { fromCell: string; toCell: string; symbols: Set<string> }>();
  for (const e of edges) {
    if (!e.symbols || e.symbols.length === 0) continue;
    const fromCell = owningCell(ownership, e.fromFile);
    const toCell = owningCell(ownership, e.toFile);
    if (!fromCell || !toCell || fromCell === toCell) continue;
    const key = `${fromCell}->${toCell}`;
    const entry = agg.get(key) ?? { fromCell, toCell, symbols: new Set<string>() };
    for (const s of e.symbols) entry.symbols.add(s);
    agg.set(key, entry);
  }
  const out: OffMembraneImport[] = [];
  for (const { fromCell, toCell, symbols } of agg.values()) {
    const decl = declarations[toCell];
    if (!decl) continue;
    // A `provides` entry can be prose, for example "checkGrammars() - the grammar-bundle
    // check". The leading identifier is the offered symbol, and the text after it is
    // documentation.
    const offered = new Set(decl.provides.map((p) => p.match(/^[$\w]+/)?.[0] ?? p));
    const missing = [...symbols].filter((s) => !offered.has(s));
    if (missing.length > 0) out.push({ fromCell, toCell, importedCount: symbols.size, missing, emptyProvides: decl.provides.length === 0 });
  }
  return out;
}

/**
 * Map file-to-file import edges to cell-to-cell crossings. The function drops imports
 * inside one cell and edges into unowned files, because there is no target cell to
 * attribute. Pure. The IO layer supplies the edges.
 */
export function deriveCrossings(edges: ImportEdge[], ownership: Ownership): Crossing[] {
  // Invert the ownership map, file -> cell.
  const fileToCell = new Map<string, string>();
  for (const [cell, files] of Object.entries(ownership)) {
    for (const file of files) fileToCell.set(file, cell);
  }

  const crossings: Crossing[] = [];
  for (const edge of edges) {
    const fromCell = fileToCell.get(edge.fromFile);
    const toCell = fileToCell.get(edge.toFile);
    if (!fromCell || !toCell) continue; // An endpoint is unowned, so this is not a crossing.
    if (fromCell === toCell) continue; // The edge is internal to one cell, so it is not a crossing.
    crossings.push({
      fromCell,
      toCell,
      fromFile: edge.fromFile,
      toFile: edge.toFile,
      import: edge.import,
    });
  }
  return crossings;
}

type LeakageKind = 'undeclared' | 'stale';

export interface Leakage {
  kind: LeakageKind;
  fromCell: string;
  toCell: string;
  detail: string;
}

/**
 * Compare the real crossings with the declared `requires` entries.
 *
 * An undeclared leakage is a crossing where A imports B, but the `requires` list of A
 * does not contain B. This is a hidden dependency.
 *
 * A stale leakage is a `requires` entry where A requires B, but A never imports B. The
 * dependency is declared and not used.
 *
 * Pure.
 */
export function checkLeakage(crossings: Crossing[], declarations: Record<string, Cell>): Leakage[] {
  const out: Leakage[] = [];

  for (const c of crossings) {
    const requires = declarations[c.fromCell]?.requires ?? [];
    if (!requires.includes(c.toCell)) {
      out.push({
        kind: 'undeclared',
        fromCell: c.fromCell,
        toCell: c.toCell,
        detail: `${c.fromCell} imports ${c.toCell} (${c.fromFile} → ${c.toFile}) but doesn't require it — add "${c.toCell}" to ${c.fromCell}.cell.toml requires`,
      });
    }
  }

  const realPairs = new Set(crossings.map((c) => `${c.fromCell}->${c.toCell}`));
  for (const [cell, decl] of Object.entries(declarations)) {
    for (const req of decl.requires) {
      if (!realPairs.has(`${cell}->${req}`)) {
        out.push({
          kind: 'stale',
          fromCell: cell,
          toCell: req,
          detail: `${cell} requires ${req} but never imports it — remove "${req}" from ${cell}.cell.toml requires, or, if the coupling is real but invisible to static analysis (data files, runtime loading), move it to data-requires`,
        });
      }
    }
  }

  return out;
}

/** Dependency metrics for one cell. These are peers of the `size` value, and the crossing graph provides them. */
export interface CellMetrics {
  fanIn: number; // The number of distinct cells that depend on this cell (afferent).
  fanOut: number; // The number of distinct cells that this cell depends on (efferent).
  instability: number; // fanOut / (fanIn + fanOut). A value of 0 is stable and a value of 1 is unstable. An isolated cell has 0.
}

/**
 * Compute fan-in, fan-out, and instability for each cell from the crossing graph. The
 * function counts distinct cells, so a cell pair that many files reach counts once. Pure.
 */
export function computeMetrics(crossings: Crossing[], cells: string[]): Record<string, CellMetrics> {
  const fanIn = new Map<string, Set<string>>();
  const fanOut = new Map<string, Set<string>>();
  for (const c of cells) {
    fanIn.set(c, new Set());
    fanOut.set(c, new Set());
  }
  for (const { fromCell, toCell } of crossings) {
    fanOut.get(fromCell)?.add(toCell);
    fanIn.get(toCell)?.add(fromCell);
  }
  const out: Record<string, CellMetrics> = {};
  for (const c of cells) {
    const fi = fanIn.get(c)!.size;
    const fo = fanOut.get(c)!.size;
    out[c] = { fanIn: fi, fanOut: fo, instability: fi + fo === 0 ? 0 : fo / (fi + fo) };
  }
  return out;
}

/** A change in the crossings between two states: the working tree and HEAD. */
export interface CrossingsDelta {
  added: Crossing[];
  removed: Crossing[];
}

/** The identity of a crossing edge. Cells do not change while ownership is fixed. */
function crossingKey(c: Crossing): string {
  return `${c.fromFile}\0${c.toFile}\0${c.import}`;
}

/**
 * Compare two sets of crossings. `added` contains the crossings that are in `working` and
 * not in `head`. `removed` contains the reverse. The function uses the file edge as the
 * key, removes duplicates, and sorts the output for stability. Pure and unit-testable.
 */
export function diffCrossings(working: Crossing[], head: Crossing[]): CrossingsDelta {
  const workMap = new Map(working.map((c) => [crossingKey(c), c]));
  const headMap = new Map(head.map((c) => [crossingKey(c), c]));
  const sortFn = (a: Crossing, b: Crossing) => a.fromCell.localeCompare(b.fromCell) || a.toCell.localeCompare(b.toCell) || a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile) || a.import.localeCompare(b.import);
  const added = [...workMap.values()].filter((c) => !headMap.has(crossingKey(c))).sort(sortFn);
  const removed = [...headMap.values()].filter((c) => !workMap.has(crossingKey(c))).sort(sortFn);
  return { added, removed };
}
