import type { Cell } from './declaration.js';
import type { Ownership } from './ownership.js';

/** A raw import edge: file A imports file B via specifier `import`. */
export interface ImportEdge {
  fromFile: string;
  toFile: string;
  import: string;
}

/** A cross-cell crossing: cell A's code imports cell B's code. */
export interface Crossing {
  fromCell: string;
  toCell: string;
  fromFile: string;
  toFile: string;
  import: string;
}

/**
 * Map file→file import edges to cell→cell crossings.
 * Drops internal imports (same cell) and edges into unowned files
 * (no target cell to attribute). Pure — the IO layer supplies the edges.
 */
export function deriveCrossings(edges: ImportEdge[], ownership: Ownership): Crossing[] {
  // Invert ownership: file → cell.
  const fileToCell = new Map<string, string>();
  for (const [cell, files] of Object.entries(ownership)) {
    for (const file of files) fileToCell.set(file, cell);
  }

  const crossings: Crossing[] = [];
  for (const edge of edges) {
    const fromCell = fileToCell.get(edge.fromFile);
    const toCell = fileToCell.get(edge.toFile);
    if (!fromCell || !toCell) continue; // unowned endpoint — not a crossing
    if (fromCell === toCell) continue; // internal — not a crossing
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

export type LeakageKind = 'undeclared' | 'stale';

export interface Leakage {
  kind: LeakageKind;
  fromCell: string;
  toCell: string;
  detail: string;
}

/**
 * Diff real crossings against declared `requires`.
 * - undeclared: A imports B, but B ∉ A.requires (hidden dependency).
 * - stale: A requires B, but A never imports B (dead/declared-but-unused).
 * Pure.
 */
export function checkLeakage(
  crossings: Crossing[],
  declarations: Record<string, Cell>,
): Leakage[] {
  const out: Leakage[] = [];

  for (const c of crossings) {
    const requires = declarations[c.fromCell]?.requires ?? [];
    if (!requires.includes(c.toCell)) {
      out.push({
        kind: 'undeclared',
        fromCell: c.fromCell,
        toCell: c.toCell,
        detail: `${c.fromCell} imports ${c.toCell} (${c.fromFile} → ${c.toFile}) but doesn't require it`,
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
          detail: `${cell} requires ${req} but never imports it`,
        });
      }
    }
  }

  return out;
}

/** Dependency metrics for a cell — peers of `size`, computed from the crossing graph. */
export interface CellMetrics {
  fanIn: number; // # distinct cells that depend on this one (afferent)
  fanOut: number; // # distinct cells this one depends on (efferent)
  instability: number; // fanOut / (fanIn + fanOut): 0 stable, 1 unstable; 0 if isolated
}

/**
 * Compute fan-in / fan-out / instability per cell from the crossing graph.
 * Counts distinct cells (a cell-pair reached via many files counts once). Pure.
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
